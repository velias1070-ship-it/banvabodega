import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/ml/flex-orphans
 *
 * Devuelve SKUs activos sin slot Flex (sin ultimo_sync). Usado por el agente
 * Viki en el droplet para enviar alerta WhatsApp diaria si hay huérfanos
 * persistentes que el cron auto-fix no resolvió.
 *
 * Response:
 *   { count, total_uds_bodega_huerfanas, items: [{sku, item_id, qty_bodega}, ...] }
 */
export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: orphans, error } = await sb.from("ml_items_map")
    .select("sku, item_id, sku_origen, available_quantity, titulo")
    .eq("status_ml", "active")
    .eq("activo", true)
    .is("ultimo_sync", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = (orphans || []) as Array<{ sku: string; item_id: string; sku_origen: string | null; available_quantity: number | null; titulo: string | null }>;

  if (list.length === 0) {
    return NextResponse.json({ count: 0, total_uds_bodega_huerfanas: 0, items: [] });
  }

  const skuOrigenes = Array.from(new Set(list.map(o => (o.sku_origen || o.sku).toUpperCase())));
  const { data: stockRows } = await sb.from("stock")
    .select("sku, cantidad")
    .in("sku", skuOrigenes);

  const stockBySku: Record<string, number> = {};
  for (const r of (stockRows || []) as Array<{ sku: string; cantidad: number }>) {
    const key = r.sku.toUpperCase();
    stockBySku[key] = (stockBySku[key] || 0) + r.cantidad;
  }

  const items = list.map(o => ({
    sku: o.sku,
    item_id: o.item_id,
    titulo: o.titulo,
    qty_bodega: stockBySku[(o.sku_origen || o.sku).toUpperCase()] || 0,
    qty_ml_full: o.available_quantity || 0,
  }));

  const totalUds = items.reduce((s, it) => s + it.qty_bodega, 0);

  items.sort((a, b) => b.qty_bodega - a.qty_bodega);

  return NextResponse.json({
    count: items.length,
    total_uds_bodega_huerfanas: totalUds,
    items,
    ts: new Date().toISOString(),
  });
}
