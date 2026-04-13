import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/ml/margin-cache
// Devuelve toda la cache. Los filtros se aplican client-side (para 734 filas
// el payload es chico y permite re-filtrar sin refetch).
export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data, error } = await sb
    .from("ml_margin_cache")
    .select("*")
    .order("margen_pct", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const lastSync = data && data.length > 0
    ? data.reduce((max, r) => (r.synced_at > max ? r.synced_at : max), "0")
    : null;

  return NextResponse.json({ items: data || [], last_sync: lastSync, total: data?.length || 0 });
}
