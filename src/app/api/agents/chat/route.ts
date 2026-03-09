import { NextRequest, NextResponse } from "next/server";
import {
  fetchConversation, insertConversationMessage,
  fetchAgentInsights, fetchAgentRules, fetchAgentConfig,
  calcCostoUsd,
} from "@/lib/agents-db";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { session_id, mensaje } = body as { session_id: string; mensaje: string };

    if (!session_id || !mensaje) {
      return NextResponse.json({ error: "Faltan campos requeridos" }, { status: 400 });
    }

    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY no configurada" }, { status: 500 });
    }

    // 1. Guardar mensaje del usuario
    await insertConversationMessage({
      session_id,
      role: "user",
      contenido: mensaje,
      agentes_invocados: null,
      tokens_usados: null,
    });

    // 2. Cargar historial de la sesión (últimos 10)
    const historial = await fetchConversation(session_id, 10);

    // 3. Cargar config del orquestador
    const config = await fetchAgentConfig("orquestador");
    const systemPrompt = config?.system_prompt_base || "Eres un asistente de gestión de bodega.";

    // 4. Cargar reglas del orquestador
    const rules = await fetchAgentRules("orquestador");
    const reglasTexto = rules.length > 0
      ? "\n\nREGLAS:\n" + rules.map((r, i) => `${i + 1}. ${r.regla}`).join("\n")
      : "";

    // 5. Cargar insights recientes de TODOS los agentes (últimos 7 días, nuevos o vistos)
    const hace7d = new Date(Date.now() - 7 * 86400000).toISOString();
    const allInsights = await fetchAgentInsights({ limit: 50 });
    const insightsRecientes = allInsights.filter(
      i => i.created_at >= hace7d && (i.estado === "nuevo" || i.estado === "visto")
    );

    const insightsResumen = insightsRecientes.length > 0
      ? "\n\nINSIGHTS RECIENTES DE LOS AGENTES:\n" +
        insightsRecientes.map(i =>
          `[${i.agente.toUpperCase()}] [${i.severidad}] ${i.titulo}: ${i.contenido?.slice(0, 200) || ""}`
        ).join("\n\n")
      : "\n\nNo hay insights recientes de los agentes.";

    // 6. Construir mensajes
    const fullSystem = systemPrompt + reglasTexto + insightsResumen +
      "\n\nResponde en español, de forma concisa y accionable. Fecha actual: " + new Date().toLocaleDateString("es-CL");

    const messages = historial.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.contenido,
    }));

    // 7. Llamar a Claude API
    const model = config?.model || "claude-sonnet-4-20250514";
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: config?.max_tokens_output || 4000,
        system: fullSystem,
        messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    const respuestaTexto = result.content?.[0]?.text || "Sin respuesta";
    const tokensInput = result.usage?.input_tokens || 0;
    const tokensOutput = result.usage?.output_tokens || 0;

    // 8. Guardar respuesta
    await insertConversationMessage({
      session_id,
      role: "assistant",
      contenido: respuestaTexto,
      agentes_invocados: insightsRecientes.length > 0
        ? Array.from(new Set(insightsRecientes.map(i => i.agente)))
        : null,
      tokens_usados: tokensInput + tokensOutput,
    });

    return NextResponse.json({
      respuesta: respuestaTexto,
      tokens: { input: tokensInput, output: tokensOutput },
      costo_usd: calcCostoUsd(tokensInput, tokensOutput, model),
    });

  } catch (err) {
    console.error("[agents/chat] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
