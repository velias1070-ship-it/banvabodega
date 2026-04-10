import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/picking/scan-errors?days=7&operario=Vicente
 * Lista errores de escaneo del picking para análisis.
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") || "7");
  const operario = url.searchParams.get("operario");
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let q = sb.from("audit_log")
    .select("*")
    .eq("accion", "picking_scan_error")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  if (operario) q = q.eq("operario", operario);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Estadísticas: errores por operario y por SKU
  const byOperario = new Map<string, number>();
  const bySku = new Map<string, { count: number; titulo: string; codigos: string[] }>();
  for (const row of (data || [])) {
    const op = row.operario || "?";
    byOperario.set(op, (byOperario.get(op) || 0) + 1);
    const params = row.params as Record<string, unknown> || {};
    const sku = String(params.skuVenta || params.skuOrigen || "?");
    const code = String(params.codigoEscaneado || "");
    const existing = bySku.get(sku);
    if (existing) {
      existing.count++;
      if (code && !existing.codigos.includes(code)) existing.codigos.push(code);
    } else {
      bySku.set(sku, { count: 1, titulo: String(params.skuVenta || ""), codigos: code ? [code] : [] });
    }
  }

  return NextResponse.json({
    total: data?.length || 0,
    days,
    errors: data,
    stats: {
      by_operario: Array.from(byOperario.entries()).map(([op, count]) => ({ operario: op, count })).sort((a, b) => b.count - a.count),
      by_sku: Array.from(bySku.entries()).map(([sku, info]) => ({ sku, count: info.count, codigos_erroneos: info.codigos })).sort((a, b) => b.count - a.count).slice(0, 30),
    },
  });
}
