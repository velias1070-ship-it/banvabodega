import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/ml/ticket-promedio
 *
 * Devuelve, por sku_venta, el ticket promedio real en ventanas de 7 y 30
 * dias (solo ventas no anuladas en ventas_ml_cache). "Ticket" = revenue
 * neto / unidades vendidas. Util para contrastar contra el precio_venta
 * actual en ml_margin_cache: si diverge mucho, el precio actual no es
 * representativo de lo que realmente se cobra (promos, campañas, etc).
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // Agregado en SQL puro (mucho mas eficiente que iterar en JS sobre 3k filas)
  const { data, error } = await sb.rpc("ticket_promedio_por_sku");
  if (error) {
    // Fallback: query manual por si la RPC no existe todavía
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const { data: rows, error: eq } = await sb
      .from("ventas_ml_cache")
      .select("sku_venta, cantidad, subtotal, fecha_date, anulada")
      .gte("fecha_date", since30);
    if (eq) return NextResponse.json({ error: eq.message }, { status: 500 });

    const agg = new Map<string, { u30: number; r30: number; u7: number; r7: number }>();
    for (const r of (rows as Array<{ sku_venta: string; cantidad: number; subtotal: number; fecha_date: string; anulada: boolean | null }> | null) || []) {
      if (r.anulada) continue;
      const sku = r.sku_venta;
      if (!sku) continue;
      const u = r.cantidad || 0;
      const rev = Number(r.subtotal) || 0;
      let cur = agg.get(sku);
      if (!cur) { cur = { u30: 0, r30: 0, u7: 0, r7: 0 }; agg.set(sku, cur); }
      cur.u30 += u;
      cur.r30 += rev;
      if (r.fecha_date >= since7) {
        cur.u7 += u;
        cur.r7 += rev;
      }
    }
    const items = Array.from(agg.entries()).map(([sku, v]) => ({
      sku_venta: sku,
      unidades_30d: v.u30,
      ticket_30d: v.u30 > 0 ? Math.round(v.r30 / v.u30) : 0,
      unidades_7d: v.u7,
      ticket_7d: v.u7 > 0 ? Math.round(v.r7 / v.u7) : 0,
    }));
    return NextResponse.json({ items });
  }

  return NextResponse.json({ items: data || [] });
}
