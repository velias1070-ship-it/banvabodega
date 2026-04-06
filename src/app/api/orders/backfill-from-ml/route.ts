import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 60;

/**
 * Copy orders from ventas_ml_cache to orders_history for a date range.
 * Marks them with fuente = "ml_backfill" to distinguish from ProfitGuard.
 *
 * GET ?from=2026-04-03&to=2026-04-05
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });

  try {
    // 1. Read from ventas_ml_cache (paginated)
    const allRows: Array<Record<string, unknown>> = [];
    const pageSize = 1000;
    for (let page = 0; page < 50; page++) {
      const { data } = await sb.from("ventas_ml_cache")
        .select("*")
        .gte("fecha_date", from)
        .lte("fecha_date", to)
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < pageSize) break;
    }

    if (allRows.length === 0) {
      return NextResponse.json({ status: "ok", copied: 0, message: "No orders in ventas_ml_cache for this range" });
    }

    // 2. Map to orders_history format
    const rows = allRows.map(r => ({
      order_id: String(r.order_id),
      order_number: String(r.order_number || r.order_id),
      fecha: new Date(String(r.fecha || "")).toISOString(),
      sku_venta: String(r.sku_venta || "").toUpperCase().trim(),
      nombre_producto: String(r.nombre_producto || ""),
      cantidad: Math.round(Number(r.cantidad) || 1),
      canal: String(r.canal || "Flex"),
      precio_unitario: Math.round(Number(r.precio_unitario) || 0),
      subtotal: Math.round(Number(r.subtotal) || 0),
      comision_unitaria: Math.round(Number(r.comision_unitaria) || 0),
      comision_total: Math.round(Number(r.comision_total) || 0),
      costo_envio: Math.round(Number(r.costo_envio) || 0),
      ingreso_envio: Math.round(Number(r.ingreso_envio) || 0),
      ingreso_adicional_tc: Math.round(Number(r.ingreso_adicional_tc) || 0),
      total: Math.round(Number(r.total) || 0),
      logistic_type: String(r.logistic_type || "self_service"),
      estado: String(r.estado || "Pagada"),
      fuente: "ml_backfill",
    }));

    // 3. Deduplicate
    const seen = new Set<string>();
    const unique = rows.filter(r => {
      const key = `${r.order_id}|${r.sku_venta}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 4. Upsert to orders_history
    let inserted = 0;
    const errors: string[] = [];
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500);
      const { error } = await sb.from("orders_history").upsert(chunk, { onConflict: "order_id,sku_venta" });
      if (error) errors.push(error.message);
      else inserted += chunk.length;
    }

    return NextResponse.json({
      status: "ok",
      copied: inserted,
      total_source: allRows.length,
      deduplicated: unique.length,
      range: `${from} → ${to}`,
      fuente: "ml_backfill",
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
