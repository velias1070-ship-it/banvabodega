import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { count } = await sb.from("orders_history").select("*", { count: "exact", head: true });

  const { data: minMax } = await sb.from("orders_history")
    .select("fecha")
    .order("fecha", { ascending: true })
    .limit(1);

  const { data: maxRow } = await sb.from("orders_history")
    .select("fecha")
    .order("fecha", { ascending: false })
    .limit(1);

  const { data: estadoCount } = await sb.from("orders_history")
    .select("estado")
    .limit(5000);

  const estados = new Map<string, number>();
  for (const r of (estadoCount as { estado: string }[] || [])) {
    estados.set(r.estado, (estados.get(r.estado) || 0) + 1);
  }

  return NextResponse.json({
    total_rows: count,
    oldest: minMax?.[0]?.fecha || null,
    newest: maxRow?.[0]?.fecha || null,
    by_estado: Array.from(estados.entries()),
  });
}
