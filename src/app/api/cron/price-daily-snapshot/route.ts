import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Cron nocturno: garantiza 1 fila por SKU activo por día en ml_price_history.
 *
 * Por qué: hoy ml_price_history solo guarda deltas (cambios detectados).
 * Para responder "¿qué precio/promo tenía SKU X el día Y?" sin extrapolar,
 * necesitamos al menos 1 fila por SKU por día. Si un SKU no tuvo cambio
 * en 5 días, hoy queda inferido del último delta. Con este snapshot,
 * queda registrado explícitamente.
 *
 * Comportamiento:
 *   - Para cada item activo en ml_items_map (con snapshot reciente en
 *     ml_margin_cache), chequear si ya hay >=1 fila en ml_price_history
 *     con detected_at::date = hoy.
 *   - Si NO hay → insertar 1 fila con fuente='daily_snapshot' tomando
 *     precio/promo actual de ml_margin_cache. precio_anterior = precio
 *     (no es un cambio), delta_pct = 0.
 *   - Si SÍ hay → skip (idempotente: no duplicar si el cron corre más
 *     de una vez en el día).
 *
 * Response observable (regla 4 inventory-policy):
 *   { items_activos, ya_con_fila_hoy, snapshots_insertados, errores }
 *
 * Schedule recomendado: 03:55 UTC (= 23:55 Chile UTC-4 May).
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  // 1. Items ML activos con cache de margen (= los que efectivamente
  //    están publicados y tenemos precio reciente)
  const { data: items, error: itemsErr } = await sb
    .from("ml_margin_cache")
    .select("item_id, sku, precio_venta, price_ml, promo_name, promo_pct, tiene_promo, promo_type, status_ml, synced_at");
  if (itemsErr) {
    console.error("[price-daily-snapshot] items query failed:", itemsErr.message);
    return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  }
  const itemsActivos = (items || []).filter(i => i.status_ml === "active" || i.status_ml === "paused");

  // 2. Mapeo item_id → sku_origen (para enriquecer la fila)
  const itemIds = itemsActivos.map(i => i.item_id);
  const { data: mapRows } = await sb
    .from("ml_items_map")
    .select("item_id, sku_origen")
    .in("item_id", itemIds);
  const skuOrigenByItem = new Map<string, string | null>();
  for (const m of (mapRows || []) as Array<{ item_id: string; sku_origen: string | null }>) {
    if (!skuOrigenByItem.has(m.item_id)) skuOrigenByItem.set(m.item_id, m.sku_origen);
  }

  // 3. SKUs (item_id) que ya tienen al menos 1 fila hoy en ml_price_history
  //    Comparamos por timezone Chile (UTC-4 / UTC-3 según DST). Para
  //    simplificar: ventana = [hoy 00:00 Chile, mañana 00:00 Chile].
  //    Aproximación robusta: usar UTC pero con ventana 24h hacia atrás.
  //    Más preciso: usar America/Santiago via SQL.
  const desdeIso = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  // 20h hacia atrás cubre el día Chile suficientemente sin overlap entre noches.
  const { data: hoyRows, error: hoyErr } = await sb
    .from("ml_price_history")
    .select("item_id")
    .gte("detected_at", desdeIso)
    .in("item_id", itemIds);
  if (hoyErr) {
    console.error("[price-daily-snapshot] check hoy failed:", hoyErr.message);
    return NextResponse.json({ error: hoyErr.message }, { status: 500 });
  }
  const yaConFilaHoy = new Set((hoyRows || []).map(r => r.item_id));

  // 4. Construir filas a insertar para los que NO tienen fila aún
  const aInsertar: Array<{
    item_id: string;
    sku: string | null;
    sku_origen: string | null;
    precio: number;
    precio_lista: number | null;
    precio_anterior: number;
    delta_pct: number;
    promo_pct: number | null;
    promo_name: string | null;
    fuente: string;
    motivo: string;
    actor: string;
    contexto: Record<string, unknown>;
  }> = [];

  for (const it of itemsActivos) {
    if (yaConFilaHoy.has(it.item_id)) continue;
    const precio = Number(it.precio_venta) || Number(it.price_ml) || 0;
    if (precio <= 0) continue;
    aInsertar.push({
      item_id: it.item_id,
      sku: it.sku || null,
      sku_origen: skuOrigenByItem.get(it.item_id) ?? null,
      precio,
      precio_lista: Number(it.price_ml) || null,
      precio_anterior: precio,
      delta_pct: 0,
      promo_pct: it.promo_pct ?? null,
      promo_name: it.promo_name ?? null,
      fuente: "snapshot_diario",
      motivo: "snapshot_diario",
      actor: "auto",
      contexto: {
        tiene_promo: it.tiene_promo === true,
        promo_type: it.promo_type ?? null,
        status_ml: it.status_ml ?? null,
        synced_at: it.synced_at ?? null,
      },
    });
  }

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      items_activos: itemsActivos.length,
      ya_con_fila_hoy: yaConFilaHoy.size,
      snapshots_a_insertar: aInsertar.length,
      sample: aInsertar.slice(0, 3),
    });
  }

  // 5. Insert en chunks de 500
  let insertados = 0;
  const errores: Array<{ item_id: string; error: string }> = [];
  const CHUNK = 500;
  for (let i = 0; i < aInsertar.length; i += CHUNK) {
    const slice = aInsertar.slice(i, i + CHUNK);
    const { error: insErr } = await sb.from("ml_price_history").insert(slice);
    if (insErr) {
      console.error(`[price-daily-snapshot] insert chunk ${i / CHUNK} failed:`, insErr.message);
      // Loggear individual para no perder TODO el chunk si una fila rompe
      for (const r of slice) {
        const { error: oneErr } = await sb.from("ml_price_history").insert(r);
        if (oneErr) errores.push({ item_id: r.item_id, error: oneErr.message });
        else insertados += 1;
      }
    } else {
      insertados += slice.length;
    }
  }

  return NextResponse.json({
    items_activos: itemsActivos.length,
    ya_con_fila_hoy: yaConFilaHoy.size,
    snapshots_insertados: insertados,
    errores,
  });
}
