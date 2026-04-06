import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Debug: query any table. Only for admin use.
 * GET ?table=recepciones&filter=folio.eq.523971&limit=5
 * GET ?table=discrepancias_costo&filter=recepcion_id.eq.XXX
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const table = req.nextUrl.searchParams.get("table");
  const filter = req.nextUrl.searchParams.get("filter");
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "50");
  const select = req.nextUrl.searchParams.get("select") || "*";

  if (!table) return NextResponse.json({ error: "table required" }, { status: 400 });

  let q = sb.from(table).select(select).limit(limit);

  // Parse filter: field.op.value
  if (filter) {
    const parts = filter.split(".");
    if (parts.length >= 3) {
      const field = parts[0];
      const op = parts[1];
      const value = parts.slice(2).join(".");
      if (op === "eq") q = q.eq(field, value);
      else if (op === "like") q = q.like(field, `%${value}%`);
      else if (op === "ilike") q = q.ilike(field, `%${value}%`);
    }
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ table, count: (data || []).length, data });
}
