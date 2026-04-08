import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ sku: string }> }) {
  const { sku } = await params;
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  const { data: reviews } = await sb
    .from("sku_revision_log")
    .select("*")
    .eq("sku_origen", sku)
    .order("semana", { ascending: false })
    .limit(50);

  // Also get the semaforo history for this SKU
  const { data: semaforoHistory } = await sb
    .from("semaforo_semanal")
    .select("semana_calculo, cubeta, impacto_clp, vel_7d, vel_30d, stock_total, precio_actual")
    .eq("sku_origen", sku)
    .order("semana_calculo", { ascending: false })
    .limit(12);

  return NextResponse.json({
    sku_origen: sku,
    revisiones: reviews || [],
    semaforo_history: semaforoHistory || [],
    total_revisiones: (reviews || []).length,
    cubetas_distintas: Array.from(new Set((reviews || []).map(r => r.cubeta))),
  });
}
