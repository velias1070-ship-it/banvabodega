import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ nombre: string }> }) {
  const { nombre } = await params;
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  const incluirRevisados = req.nextUrl.searchParams.get("incluir_revisados") === "true";

  // Get latest semana
  const { data: latest } = await sb
    .from("semaforo_semanal")
    .select("semana_calculo")
    .order("semana_calculo", { ascending: false })
    .limit(1);

  if (!latest?.[0]) return NextResponse.json({ error: "no data" }, { status: 404 });
  const semana = latest[0].semana_calculo;

  // Get rows for this cubeta
  const { data: rows } = await sb
    .from("semaforo_semanal")
    .select("*")
    .eq("semana_calculo", semana)
    .eq("cubeta", nombre)
    .order("impacto_clp", { ascending: false });

  if (!rows) return NextResponse.json({ error: "query failed" }, { status: 500 });

  // Get reviews for this week
  const { data: reviews } = await sb
    .from("sku_revision_log")
    .select("sku_origen, cubeta, causa_identificada, accion_tomada, revisado_at")
    .eq("semana", semana);

  const reviewMap = new Map<string, { cubeta: string; causa: string; accion: string; revisado_at: string }>();
  for (const r of reviews || []) {
    reviewMap.set(r.sku_origen, {
      cubeta: r.cubeta,
      causa: r.causa_identificada,
      accion: r.accion_tomada,
      revisado_at: r.revisado_at,
    });
  }

  // Check for "persistente" (was reviewed last week in SAME cubeta)
  const prevSemana = new Date(semana);
  prevSemana.setDate(prevSemana.getDate() - 7);
  const { data: prevReviews } = await sb
    .from("sku_revision_log")
    .select("sku_origen, cubeta")
    .eq("semana", prevSemana.toISOString().slice(0, 10));

  const prevReviewedInSameCubeta = new Set<string>();
  for (const r of prevReviews || []) {
    if (r.cubeta === nombre) prevReviewedInSameCubeta.add(r.sku_origen);
  }

  const result = rows.map(r => {
    const rev = reviewMap.get(r.sku_origen);
    const yaRevisado = !!rev;
    const persistente = prevReviewedInSameCubeta.has(r.sku_origen);
    return { ...r, ya_revisado: yaRevisado, revision: rev || null, persistente };
  });

  const filtered = incluirRevisados ? result : result.filter(r => !r.ya_revisado);

  return NextResponse.json({
    semana,
    cubeta: nombre,
    total: rows.length,
    pendientes: result.filter(r => !r.ya_revisado).length,
    revisados: result.filter(r => r.ya_revisado).length,
    items: filtered,
  });
}
