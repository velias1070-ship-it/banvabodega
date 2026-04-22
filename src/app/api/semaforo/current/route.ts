import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  // Get latest semana
  const { data: latest } = await sb
    .from("semaforo_semanal")
    .select("semana_calculo")
    .order("semana_calculo", { ascending: false })
    .limit(1);

  if (!latest?.[0]) {
    return NextResponse.json({ error: "no data", message: "Semaforo no ha sido ejecutado aun" }, { status: 404 });
  }

  const semana = latest[0].semana_calculo;

  // Get all rows for current week — use count to verify
  const { data: rows, count } = await sb
    .from("semaforo_semanal")
    .select("item_id, sku_origen, cubeta, impacto_clp", { count: "exact" })
    .eq("semana_calculo", semana);

  // Get snapshot (current + previous)
  const { data: snapshots } = await sb
    .from("semaforo_snapshot_semanal")
    .select("*")
    .order("semana", { ascending: false })
    .limit(2);

  const currentSnap = snapshots?.find(s => s.semana === semana);
  const prevSnap = snapshots?.find(s => s.semana !== semana);

  // Get reviews for this week — review se trackea por sku_origen (decision operativa
  // puede aplicar a ambas pubs del mismo sku fisico)
  const { data: reviews } = await sb
    .from("sku_revision_log")
    .select("sku_origen")
    .eq("semana", semana);

  const reviewedSkus = new Set((reviews || []).map(r => r.sku_origen));

  // Build cubeta summaries (count por publicacion, revisado si sku_origen esta revisado)
  const cubetas: Record<string, { count: number; impacto_total: number; revisados: number; pendientes: number }> = {};
  for (const r of rows || []) {
    const c = r.cubeta;
    if (!cubetas[c]) cubetas[c] = { count: 0, impacto_total: 0, revisados: 0, pendientes: 0 };
    cubetas[c].count++;
    cubetas[c].impacto_total += r.impacto_clp || 0;
    if (reviewedSkus.has(r.sku_origen)) cubetas[c].revisados++;
    else cubetas[c].pendientes++;
  }

  return NextResponse.json({
    semana,
    total_skus: (rows || []).length,
    cubetas,
    kpis: {
      unidades_semana: currentSnap?.unidades_semana ?? null,
      revenue_semana: currentSnap?.revenue_semana ?? null,
      delta_unidades_pct: currentSnap?.delta_unidades_pct ?? null,
      delta_revenue_pct: currentSnap?.delta_revenue_pct ?? null,
    },
    prev_semana: prevSnap ? {
      semana: prevSnap.semana,
      count_cayo: prevSnap.count_cayo,
      count_quiebre_inminente: prevSnap.count_quiebre_inminente,
      count_ya_quebrado: prevSnap.count_ya_quebrado,
      count_despegando: prevSnap.count_despegando,
      count_estancado: prevSnap.count_estancado,
      count_muerto: prevSnap.count_muerto,
    } : null,
    _ts: Date.now(),
    _db_count: count,
    _rows_length: (rows || []).length,
  }, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    },
  });
}
