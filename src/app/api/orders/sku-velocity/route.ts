import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Debug: show velocity data for a specific SKU from orders_history.
 * GET ?sku=JSAFAB423P20S
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sku = req.nextUrl.searchParams.get("sku")?.toUpperCase().trim();
  if (!sku) return NextResponse.json({ error: "sku required" }, { status: 400 });

  // Search by sku_venta in orders_history
  const { data: orders } = await sb.from("orders_history")
    .select("order_id, sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, estado, fuente")
    .eq("sku_venta", sku)
    .eq("estado", "Pagada")
    .order("fecha", { ascending: false })
    .limit(200);

  // Also check composicion_venta for sku_origen mapping
  const { data: composicion } = await sb.from("composicion_venta")
    .select("sku_venta, sku_origen, unidades")
    .or(`sku_venta.eq.${sku},sku_origen.eq.${sku}`);

  // If this SKU is a sku_origen, find sales of its sku_venta
  const skuVentas = (composicion || []).filter(c => c.sku_origen === sku).map(c => c.sku_venta);
  let ventasBySkuVenta: Record<string, unknown>[] = [];
  if (skuVentas.length > 0) {
    const { data } = await sb.from("orders_history")
      .select("order_id, sku_venta, cantidad, canal, fecha, subtotal, estado, fuente")
      .in("sku_venta", skuVentas)
      .eq("estado", "Pagada")
      .order("fecha", { ascending: false })
      .limit(200);
    ventasBySkuVenta = data || [];
  }

  // Also check ventas_ml_cache
  const { data: mlCache } = await sb.from("ventas_ml_cache")
    .select("order_id, sku_venta, cantidad, canal, fecha, subtotal, estado")
    .eq("sku_venta", sku)
    .eq("estado", "Pagada")
    .eq("anulada", false)  // estado=Pagada NO basta: orden puede pagarse y anularse después
    .order("fecha", { ascending: false })
    .limit(200);

  // Calculate weekly velocity
  const allSales = [...(orders || []), ...ventasBySkuVenta];
  const now = new Date();
  const days7 = new Date(now.getTime() - 7 * 86400000);
  const days30 = new Date(now.getTime() - 30 * 86400000);
  const days60 = new Date(now.getTime() - 60 * 86400000);

  let qty7 = 0, qty30 = 0, qty60 = 0;
  for (const o of allSales) {
    const fecha = new Date(String(o.fecha));
    const qty = Number(o.cantidad) || 0;
    if (fecha >= days7) qty7 += qty;
    if (fecha >= days30) qty30 += qty;
    if (fecha >= days60) qty60 += qty;
  }

  return NextResponse.json({
    sku,
    composicion: composicion || [],
    sku_ventas_asociados: skuVentas,
    orders_history: {
      direct: (orders || []).length,
      via_composicion: ventasBySkuVenta.length,
      total: allSales.length,
    },
    ventas_ml_cache: (mlCache || []).length,
    velocity: {
      qty_7d: qty7,
      qty_30d: qty30,
      qty_60d: qty60,
      vel_semanal_7d: Math.round(qty7 * 10) / 10,
      vel_semanal_30d: Math.round((qty30 / 30 * 7) * 10) / 10,
      vel_semanal_60d: Math.round((qty60 / 60 * 7) * 10) / 10,
    },
    recent_orders: allSales.slice(0, 10).map(o => ({
      order_id: o.order_id,
      sku_venta: o.sku_venta,
      qty: o.cantidad,
      canal: o.canal,
      fecha: o.fecha,
      fuente: o.fuente,
    })),
  });
}
