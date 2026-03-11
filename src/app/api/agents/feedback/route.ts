import { NextRequest, NextResponse } from "next/server";
import {
  updateAgentInsight, insertAgentRule, fetchAgentConfig,
} from "@/lib/agents-db";
import type { DBAgentInsight } from "@/lib/agents-db";
import { getServerSupabase } from "@/lib/supabase-server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { insight_id, estado, feedback_texto } = body as {
      insight_id: string;
      estado: "aceptado" | "rechazado" | "corregido";
      feedback_texto?: string;
    };

    if (!insight_id || !estado) {
      return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
    }

    // 1. Obtener insight original
    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "DB no disponible" }, { status: 500 });

    const { data: insight } = await sb.from("agent_insights").select("*").eq("id", insight_id).single();
    if (!insight) {
      return NextResponse.json({ error: "Insight no encontrado" }, { status: 404 });
    }

    // 2. Actualizar insight
    const updateResult = await updateAgentInsight(insight_id, {
      estado,
      feedback_texto: feedback_texto || null,
      feedback_at: new Date().toISOString(),
    });

    if (!updateResult?.ok) {
      return NextResponse.json({ error: updateResult?.error || "Error actualizando insight" }, { status: 500 });
    }

    // 3. Verificar que el cambio persistió
    const { data: verificado } = await sb.from("agent_insights").select("estado").eq("id", insight_id).single();
    if (verificado && verificado.estado !== estado) {
      console.error("[agents/feedback] Estado no persistió. Esperado:", estado, "Actual:", verificado.estado);
      return NextResponse.json({ error: `El cambio no persistió en la DB. Estado actual: ${verificado.estado}` }, { status: 500 });
    }

    // 4. Si es corrección con texto, generar regla aprendida
    let regla_generada: string | null = null;
    if (estado === "corregido" && feedback_texto && ANTHROPIC_API_KEY) {
      try {
        const typedInsight = insight as DBAgentInsight;
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 500,
            system: "Genera una regla concisa (1-2 oraciones) que un agente de IA debe seguir en el futuro. La regla debe ser genérica y aplicable a situaciones similares, no específica a un SKU. Responde SOLO con la regla, sin explicación adicional.",
            messages: [{
              role: "user",
              content: `El admin corrigió esta sugerencia del agente de ${typedInsight.agente}.\n\nSugerencia original: ${typedInsight.titulo} — ${typedInsight.contenido}\n\nCorrección del admin: ${feedback_texto}\n\nGenera una regla para evitar este error en el futuro.`,
            }],
          }),
        });

        if (response.ok) {
          const result = await response.json();
          regla_generada = result.content?.[0]?.text || null;

          if (regla_generada) {
            // Obtener config del agente para el nombre
            const agentConfig = await fetchAgentConfig(typedInsight.agente);

            await insertAgentRule({
              agente: typedInsight.agente,
              regla: regla_generada,
              contexto: `Generada desde corrección de insight: "${typedInsight.titulo}"`,
              origen: "feedback_admin",
              origen_insight_id: insight_id,
              prioridad: 3,
              activa: true,
            });
          }
        }
      } catch (err) {
        console.error("[agents/feedback] Error generando regla:", err);
        // No fallar el feedback por error en generación de regla
      }
    }

    return NextResponse.json({
      ok: true,
      insight_id,
      estado,
      regla_generada,
    });

  } catch (err) {
    console.error("[agents/feedback] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
