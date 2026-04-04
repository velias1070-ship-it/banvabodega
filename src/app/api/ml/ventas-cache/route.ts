import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Read ventas from DB cache (instant).
 * GET ?from=2026-04-01&to=2026-04-04
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }

  try {
    const { data, error } = await sb.from("ventas_ml_cache")
      .select("*")
      .gte("fecha_date", from)
      .lte("fecha_date", to)
      .order("fecha", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Get last sync time
    const { data: lastRow } = await sb.from("ventas_ml_cache")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    const lastSync = lastRow?.[0]?.updated_at || null;

    return NextResponse.json({
      ordenes: data || [],
      total: (data || []).length,
      last_sync: lastSync,
      source: "cache",
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
