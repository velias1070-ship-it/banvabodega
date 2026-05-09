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

  // 3. Timeline de cambios (incluye snapshots diarios para que el usuario
  //    vea explícitamente "ese día estaba a $X" sin asumir extrapolación).
  const { data: history } = await sb.from("ml_price_history")
    .select("detected_at, precio_anterior, precio, delta_pct, promo_name, promo_pct, fuente, motivo, actor")
    .eq("sku", sku)
    .order("detected_at", { ascending: false })
    .limit(200);

  // 4. Ventas históricas del SKU (vía sku_venta directo + via composicion_venta).
  //    Primero buscamos los sku_venta que mapean a este sku_origen.
  const { data: comps } = await sb.from("composicion_venta")
    .select("sku_venta, unidades")
    .eq("sku_origen", sku);
  const skusVenta = Array.from(new Set([sku, ...((comps || []).map(c => c.sku_venta))]));

  const { data: ventas } = await sb.from("ventas_ml_cache")
    .select("order_id, fecha_date, sku_venta, cantidad, precio_unitario, promo_name_aplicada, promo_pct_aplicada, anulada")
    .in("sku_venta", skusVenta)
    .eq("anulada", false)
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
    nota: string;
  } | null = null;
  if (fecha) {
    const fechaIso = `${fecha} 23:59:59`;
    const { data: rowAlDia } = await sb.from("ml_price_history")
      .select("precio, promo_name, promo_pct, fuente, detected_at")
      .eq("sku", sku)
      .lte("detected_at", fechaIso)
      .order("detected_at", { ascending: false })
      .limit(1);
    if (rowAlDia && rowAlDia.length > 0) {
      const r = rowAlDia[0];
      estadoAlDia = {
        fecha,
        precio: Number(r.precio),
        promo_name: r.promo_name,
        promo_pct: r.promo_pct,
        fuente: r.fuente,
        desde: r.detected_at,
        nota: r.fuente === "daily_snapshot" ? "Snapshot diario (estado registrado explícitamente)" : "Reconstruido del último cambio antes de la fecha",
      };
    } else {
      estadoAlDia = {
        fecha,
        precio: null, promo_name: null, promo_pct: null,
        fuente: null, desde: null,
        nota: "Sin registros en ml_price_history en o antes de esa fecha. Anterior al inicio del cron de captura.",
      };
    }
  }

  return NextResponse.json({
    sku,
    producto,
    estado_actual_cache: cacheRows || [],
    timeline: history || [],
    ventas: ventas || [],
    estado_al_dia: estadoAlDia,
    skus_venta_relacionados: skusVenta,
  });
}
