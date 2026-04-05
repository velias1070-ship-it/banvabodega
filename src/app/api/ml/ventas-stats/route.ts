import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") || "2026-01-01";
  const to = searchParams.get("to") || "2026-12-31";

  // Total rows in cache
  const { count: totalRows } = await sb.from("ventas_ml_cache")
    .select("*", { count: "exact", head: true });

  // Count by date
  const { data: byDate } = await sb.from("ventas_ml_cache")
    .select("fecha_date")
    .gte("fecha_date", from)
    .lte("fecha_date", to)
    .limit(50000);

  const dateCount = new Map<string, number>();
  for (const row of (byDate as { fecha_date: string }[] | null) || []) {
    dateCount.set(row.fecha_date, (dateCount.get(row.fecha_date) || 0) + 1);
  }
  const dates = Array.from(dateCount.entries()).sort((a, b) => b[0].localeCompare(a[0]));

  return NextResponse.json({
    total_rows_in_cache: totalRows,
    range: `${from} → ${to}`,
    range_rows: byDate?.length || 0,
    by_date: dates,
  });
}
