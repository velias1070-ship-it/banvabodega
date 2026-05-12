import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/ml/flex-orphans
 *
 * Devuelve SKUs activos sin slot Flex (`seller_warehouse`). Usado por el
 * agente Viki en el droplet para enviar alerta WhatsApp diaria si hay
 * huérfanos persistentes que el cron auto-fix no resolvió.
 *
 * Fase 2 (2026-05-12): separa en 2 categorías para diagnóstico:
 *   - `orphans_never_had`: SKUs con `ultimo_sync IS NULL` (nunca tuvieron
 *     slot Flex desde que se crearon en ml_items_map). Caso típico:
 *     publicación nueva en ML que aún no entró al cron de activación.
 *   - `orphans_lost_flex`: SKUs con `ultimo_sync IS NOT NULL` pero cuyo
 *     `last_location_types` cacheado NO incluye 'seller_warehouse'. Caso
 *     grave: tuvieron Flex y ML lo desactivó silenciosamente.
 *
 * El filtro `last_location_types <> '{}'` para `lost_flex` evita falsos
 * positivos por bootstrap (cache aún sin poblar tras la migración v112).
 *
 * Response:
 *   {
 *     count: total general,
 *     count_never_had, count_lost_flex,
 *     total_uds_bodega_huerfanas,
 *     orphans_never_had: [...], orphans_lost_flex: [...],
 *     items: [...] (todos, retrocompatibilidad con consumidores existentes)
 *   }
 */
export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: orphans, error } = await sb.from("ml_items_map")
    .select("sku, item_id, sku_origen, available_quantity, titulo, ultimo_sync, last_location_types")
    .eq("status_ml", "active")
    .eq("activo", true)
    .or(
      "ultimo_sync.is.null," +
      "and(ultimo_sync.not.is.null,last_location_types.neq.{},last_location_types.not.cs.{seller_warehouse})",
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    sku: string;
    item_id: string;
    sku_origen: string | null;
    available_quantity: number | null;
    titulo: string | null;
    ultimo_sync: string | null;
    last_location_types: string[] | null;
  };
  const list = (orphans || []) as Row[];

  if (list.length === 0) {
    return NextResponse.json({
      count: 0,
      count_never_had: 0,
      count_lost_flex: 0,
      total_uds_bodega_huerfanas: 0,
      orphans_never_had: [],
      orphans_lost_flex: [],
      items: [],
    });
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

  const categoryFor = (r: Row): "never_had" | "lost_flex" =>
    r.ultimo_sync === null ? "never_had" : "lost_flex";

  const items = list.map(o => ({
    sku: o.sku,
    item_id: o.item_id,
    titulo: o.titulo,
    qty_bodega: stockBySku[(o.sku_origen || o.sku).toUpperCase()] || 0,
    qty_ml_full: o.available_quantity || 0,
    category: categoryFor(o),
    last_location_types: o.last_location_types,
    ultimo_sync: o.ultimo_sync,
  }));

  items.sort((a, b) => b.qty_bodega - a.qty_bodega);

  const orphans_never_had = items.filter(i => i.category === "never_had");
  const orphans_lost_flex = items.filter(i => i.category === "lost_flex");

  // Solo contamos uds de bodega con stock > 0. La alerta operativa importa
  // cuando hay stock perdido, no cuando son slots vacíos sin urgencia.
  const totalUds = items.reduce((s, it) => s + it.qty_bodega, 0);

  return NextResponse.json({
    count: items.length,
    count_never_had: orphans_never_had.length,
    count_lost_flex: orphans_lost_flex.length,
    total_uds_bodega_huerfanas: totalUds,
    total_uds_lost_flex: orphans_lost_flex.reduce((s, it) => s + it.qty_bodega, 0),
    orphans_never_had,
    orphans_lost_flex,
    items, // retrocompatibilidad
    ts: new Date().toISOString(),
  });
}
