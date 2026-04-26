import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/pricing/auto-postular-summary
 *
 * Resumen consumible por la UI sin queries SQL:
 *   - Última corrida del cron (timestamp + decisiones)
 *   - Top motivos de skip 24h
 *   - Histórico últimas 7 corridas por dia
 *   - Últimas 30 decisiones individuales
 *   - Stats globales 24h
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const since24h = new Date(Date.now() - 86400_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();

  // 1. Última corrida (timestamp del log más reciente)
  const { data: ultimo } = await sb
    .from("auto_postulacion_log")
    .select("fecha")
    .order("fecha", { ascending: false })
    .limit(1);
  const lastRunAt = ultimo && ultimo.length > 0 ? (ultimo[0] as { fecha: string }).fecha : null;

  // 2. Stats 24h por decision
  type LogRow = {
    id: string; fecha: string; sku: string; promo_name: string | null;
    promo_type: string | null; decision: string; motivo: string;
    precio_objetivo: number | null; precio_actual: number | null;
    floor_calculado: number | null; margen_proyectado_pct: number | null;
    modo: string;
  };
  const { data: rows24h } = await sb
    .from("auto_postulacion_log")
    .select("id, fecha, sku, promo_name, promo_type, decision, motivo, precio_objetivo, precio_actual, floor_calculado, margen_proyectado_pct, modo")
    .gte("fecha", since24h)
    .order("fecha", { ascending: false })
    .limit(2000);
  const filas24h = (rows24h || []) as LogRow[];

  const stats24h = { postular: 0, skipear: 0, error: 0, baseline_warming: 0, otras: 0 };
  for (const r of filas24h) {
    const d = r.decision.replace("dry_run_", "");
    if (d === "postular") stats24h.postular++;
    else if (d === "skipear") stats24h.skipear++;
    else if (d === "error") stats24h.error++;
    else if (d === "baseline_warming") stats24h.baseline_warming++;
    else stats24h.otras++;
  }

  // 3. Top motivos de skip 24h (parsear el primer término del motivo)
  const motivosMap = new Map<string, number>();
  for (const r of filas24h) {
    if (!r.decision.includes("skip")) continue;
    const partes = r.motivo.split("|").map(s => s.trim());
    for (const p of partes) {
      const tipo = p.split(":")[0]?.trim() || "otro";
      motivosMap.set(tipo, (motivosMap.get(tipo) || 0) + 1);
    }
  }
  const topMotivos = Array.from(motivosMap.entries())
    .map(([tipo, count]) => ({ tipo, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 4. Histórico 7 días por fecha::date + decision
  const { data: rows7d } = await sb
    .from("auto_postulacion_log")
    .select("fecha, decision")
    .gte("fecha", since7d);
  const histMap = new Map<string, { postular: number; skipear: number; error: number; baseline_warming: number }>();
  for (const r of (rows7d || []) as Array<{ fecha: string; decision: string }>) {
    const dia = r.fecha.slice(0, 10);
    const cur = histMap.get(dia) || { postular: 0, skipear: 0, error: 0, baseline_warming: 0 };
    const d = r.decision.replace("dry_run_", "");
    if (d === "postular") cur.postular++;
    else if (d === "skipear") cur.skipear++;
    else if (d === "error") cur.error++;
    else if (d === "baseline_warming") cur.baseline_warming++;
    histMap.set(dia, cur);
  }
  const historico = Array.from(histMap.entries())
    .map(([dia, v]) => ({ dia, ...v, total: v.postular + v.skipear + v.error + v.baseline_warming }))
    .sort((a, b) => b.dia.localeCompare(a.dia));

  // 5. Últimas 30 decisiones (postular/skipear, omitir baseline_warming)
  const recientes = filas24h
    .filter(r => !r.decision.includes("baseline_warming"))
    .slice(0, 30)
    .map(r => ({
      fecha: r.fecha,
      sku: r.sku,
      promo_name: r.promo_name,
      promo_type: r.promo_type,
      decision: r.decision,
      motivo: r.motivo,
      precio_objetivo: r.precio_objetivo,
      precio_actual: r.precio_actual,
      floor: r.floor_calculado,
      margen_pct: r.margen_proyectado_pct,
      modo: r.modo,
    }));

  // 6. Conteo de SKUs con auto_postular activado
  const { count: skusActivos } = await sb
    .from("productos")
    .select("sku", { count: "exact", head: true })
    .eq("auto_postular", true);

  return NextResponse.json({
    last_run: lastRunAt,
    stats_24h: stats24h,
    top_motivos: topMotivos,
    historico_7d: historico,
    recientes,
    skus_auto_postular: skusActivos ?? 0,
  });
}
