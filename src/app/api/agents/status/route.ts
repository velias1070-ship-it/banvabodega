import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export async function GET(_req: NextRequest) {
  try {
    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "DB no disponible" }, { status: 500 });

    // Configs de agentes
    const { data: configs } = await sb.from("agent_config").select("*").order("id");

    // Insights recientes (últimos 7 días)
    const hace7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: insights } = await sb.from("agent_insights").select("id, agente, estado, severidad, tipo, titulo, contenido, datos, skus_relacionados, feedback_texto, feedback_at, created_at")
      .gte("created_at", hace7d)
      .order("created_at", { ascending: false })
      .limit(100);

    // Runs recientes
    const { data: runs } = await sb.from("agent_runs").select("*")
      .gte("created_at", hace7d)
      .order("created_at", { ascending: false })
      .limit(50);

    // Rules
    const { data: rules } = await sb.from("agent_rules").select("*").order("agente").order("prioridad");

    // Triggers
    const { data: triggers, error: triggersErr } = await sb.from("agent_triggers").select("*").order("agente").order("nombre");
    if (triggersErr) console.error("[agents/status] triggers error:", triggersErr.message);

    return NextResponse.json({
      configs: configs || [],
      insights: insights || [],
      runs: runs || [],
      rules: rules || [],
      triggers: triggers || [],
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
