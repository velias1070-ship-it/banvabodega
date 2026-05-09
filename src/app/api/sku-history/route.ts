import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/sku-history?sku=X
 *
 * Timeline completa del SKU: cambios de precio (ml_price_history) +
 * estado actual (ml_margin_cache) + ventas (ventas_ml_cache filtradas).
 *
 * Si se pasa &fecha=YYYY-MM-DD, devuelve además el "estado al cierre
 * de ese día" reconstruido (último cambio en o antes de esa fecha).
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase();
  const fecha = req.nextUrl.searchParams.get("fecha")?.trim() || null;
  if (!sku) return NextResponse.json({ error: "sku requerido" }, { status: 400 });

  // 1. Estado actual en ml_margin_cache (puede tener varios item_id por sku
  //    si hay múltiples publicaciones; agarramos los activos primero).
  const { data: cacheRows } = await sb.from("ml_margin_cache")
    .select("item_id, sku, titulo, price_ml, precio_venta, tiene_promo, promo_name, promo_type, promo_pct, status_ml, comision_pct, envio_clp, margen_clp, margen_pct, synced_at")
    .or(`sku.eq.${sku},sku.eq.${sku.toLowerCase()}`)
    .order("synced_at", { ascending: false });

  // 2. Producto base
  const { data: prodRows } = await sb.from("productos")
    .select("sku, nombre, costo_promedio, precio_piso")
    .eq("sku", sku)
    .limit(1);
  const producto = prodRows?.[0] || null;

  // 3. Timeline de cambios con evento_tag (vista enriquecida con promos_eventos)
  const { data: history } = await sb.from("v_ml_price_history_con_evento")
    .select("detected_at, precio_anterior, precio, delta_pct, promo_name, promo_pct, fuente, motivo, actor, evento_tag, evento_subtag")
    .eq("sku", sku)
    .order("detected_at", { ascending: false })
    .limit(200);

  // 4. Ventas históricas del SKU (vía sku_venta directo + via composicion_venta).
  //    Primero buscamos los sku_venta que mapean a este sku_origen.
  const { data: comps } = await sb.from("composicion_venta")
    .select("sku_venta, unidades")
    .eq("sku_origen", sku);
  const skusVenta = Array.from(new Set([sku, ...((comps || []).map(c => c.sku_venta))]));

  const { data: ventas } = await sb.from("v_ventas_con_evento")
    .select("order_id, fecha_date, sku_venta, cantidad, precio_unitario, promo_name_aplicada, promo_pct_aplicada, evento_tag, evento_subtag")
    .in("sku_venta", skusVenta)
    .order("fecha_date", { ascending: false })
    .limit(100);

  // 5. Estado al cierre de fecha pedida (si aplica)
  let estadoAlDia: {
    fecha: string;
    precio: number | null;
    promo_name: string | null;
    promo_pct: number | null;
    fuente: string | null;
    desde: string | null;
    evento_tag?: string | null;
    evento_subtag?: string | null;
    costo?: number | null;
    fuente_costo?: string | null;
    margen_estimado?: number | null;
    margen_pct_estimado?: number | null;
    nota: string;
  } | null = null;
  if (fecha) {
    const fechaIso = `${fecha} 23:59:59`;
    // Usar la RPC estado_sku_at que combina precio + promo + evento + costo + margen
    const { data: estado } = await sb.rpc("estado_sku_at", { p_sku: sku, p_fecha: fechaIso });
    const r = (estado as Array<{
      precio: number | null; promo_name: string | null; promo_pct: number | null;
      evento_tag: string | null; fuente_precio: string | null; desde_precio: string | null;
      costo: number | null; fuente_costo: string | null; desde_costo: string | null;
      margen_estimado: number | null; margen_pct_estimado: number | null;
    }>)?.[0];
    if (r && r.precio !== null) {
      estadoAlDia = {
        fecha,
        precio: Number(r.precio),
        promo_name: r.promo_name,
        promo_pct: r.promo_pct,
        fuente: r.fuente_precio,
        desde: r.desde_precio,
        evento_tag: r.evento_tag,
        evento_subtag: null,
        costo: r.costo,
        fuente_costo: r.fuente_costo,
        margen_estimado: r.margen_estimado,
        margen_pct_estimado: r.margen_pct_estimado,
        nota: r.fuente_precio === "daily_snapshot"
          ? "Snapshot diario (estado registrado explícitamente)"
          : "Reconstruido del último cambio antes de la fecha",
      };
    } else {
      estadoAlDia = {
        fecha,
        precio: null, promo_name: null, promo_pct: null,
        fuente: null, desde: null,
        costo: null, fuente_costo: null,
        margen_estimado: null, margen_pct_estimado: null,
        nota: "Sin registros en ml_price_history en o antes de esa fecha. Anterior al inicio del cron de captura.",
      };
    }
  }

  // 6. Cambios de estado (status_ml, listing_type, etc) del SKU
  const { data: stateHistory } = await sb.from("ml_item_state_history")
    .select("detected_at, item_id, campo, valor_anterior, valor_nuevo, fuente")
    .eq("sku", sku)
    .order("detected_at", { ascending: false })
    .limit(100);

  return NextResponse.json({
    sku,
    producto,
    estado_actual_cache: cacheRows || [],
    timeline: history || [],
    ventas: ventas || [],
    estado_al_dia: estadoAlDia,
    skus_venta_relacionados: skusVenta,
    state_history: stateHistory || [],
  });
}
