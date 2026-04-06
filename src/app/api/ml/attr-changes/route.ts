import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/ml/attr-changes?days=30&item_id=MLC123
 * Lista cambios de atributos detectados en items ML.
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const days = parseInt(url.searchParams.get("days") || "30");
  const itemId = url.searchParams.get("item_id");

  const since = new Date(Date.now() - days * 86400000).toISOString();

  let q = sb.from("ml_item_changes")
    .select("*")
    .gte("detected_at", since)
    .order("detected_at", { ascending: false })
    .limit(200);

  if (itemId) q = q.eq("item_id", itemId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ changes: data, count: data?.length || 0, since });
}
