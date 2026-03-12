import { NextRequest, NextResponse } from "next/server";
import {
  fetchAgentConfig, updateAgentConfig,
  fetchAgentRules, insertAgentInsights, insertAgentRun, updateAgentRun,
  fetchLastSuccessfulRun, calcCostoUsd,
} from "@/lib/agents-db";
import { prepararDatos } from "@/lib/agents-data";
import { upsertSnapshot } from "@/lib/agents-db";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

interface InsightRaw {
  tipo: string;
  severidad: string;
  categoria: string;
  titulo: string;
  contenido: string;
  skus?: string[];
  accion_sugerida?: string;
  datos?: Record<string, unknown>;
}

interface AgentResponse {
  insights: InsightRaw[];
  resumen?: string;
}

// Valores permitidos por los CHECK constraints de la DB
const TIPOS_VALIDOS = ["alerta", "sugerencia", "analisis", "resumen"] as const;
const SEVERIDADES_VALIDAS = ["critica", "alta", "media", "info"] as const;

function sanitizeTipo(v: string | undefined): typeof TIPOS_VALIDOS[number] {
  if (v && TIPOS_VALIDOS.includes(v as typeof TIPOS_VALIDOS[number])) return v as typeof TIPOS_VALIDOS[number];
  // Mapear valores comunes que Claude podría devolver
  if (v === "recomendacion" || v === "recomendación") return "sugerencia";
  if (v === "warning" || v === "advertencia") return "alerta";
  if (v === "análisis" || v === "analysis") return "analisis";
  return "analisis";
}

function sanitizeSeveridad(v: string | undefined): typeof SEVERIDADES_VALIDAS[number] {
  if (v && SEVERIDADES_VALIDAS.includes(v as typeof SEVERIDADES_VALIDAS[number])) return v as typeof SEVERIDADES_VALIDAS[number];
  // Mapear valores comunes
  if (v === "crítica" || v === "critical") return "critica";
  if (v === "high" || v === "importante") return "alta";
  if (v === "medium" || v === "moderada" || v === "baja" || v === "low") return "media";
  if (v === "informativa" || v === "informacion" || v === "información") return "info";
  return "info";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agente, trigger = "manual" } = body as { agente: string; trigger?: string };

    if (!agente) {
      return NextResponse.json({ error: "Falta campo 'agente'" }, { status: 400 });
    }

    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY no configurada" }, { status: 500 });
    }

    // 1. Leer configuración del agente
    const config = await fetchAgentConfig(agente);
    if (!config) {
      return NextResponse.json({ error: `Agente '${agente}' no encontrado` }, { status: 404 });
    }
    if (!config.activo) {
      return NextResponse.json({ error: `Agente '${agente}' está desactivado` }, { status: 400 });
    }

    // 2. Preparar datos
    const { datos, hash } = await prepararDatos(agente);

    // 3. Verificar si el hash es igual al último run exitoso (<1 hora)
    const lastRun = await fetchLastSuccessfulRun(agente);
    if (lastRun && lastRun.datos_snapshot_hash === hash) {
      const lastRunTime = new Date(lastRun.completed_at || lastRun.created_at).getTime();
      if (Date.now() - lastRunTime < 3600000) {
        return NextResponse.json({
          cached: true,
          message: "Datos sin cambios desde la última ejecución (< 1 hora)",
          last_run_id: lastRun.id,
        });
      }
    }

    // 4. Registrar inicio de ejecución
    const startTime = Date.now();
    const runId = await insertAgentRun({
      agente,
      trigger: trigger as "cron" | "manual" | "evento" | "chat",
      estado: "corriendo",
      tokens_input: null,
      tokens_output: null,
      costo_usd: null,
      duracion_ms: null,
      insights_generados: null,
      error_mensaje: null,
      datos_snapshot_hash: hash,
      completed_at: null,
    });

    if (!runId) {
      return NextResponse.json({ error: "Error al registrar ejecución" }, { status: 500 });
    }

    try {
      // 5. Cargar reglas aprendidas
      const rules = await fetchAgentRules(agente);
      const reglasTexto = rules.length > 0
        ? "\n\nREGLAS APRENDIDAS (aplícalas cuando sea relevante):\n" +
          rules.map((r, i) => `${i + 1}. [P${r.prioridad}] ${r.regla}${r.contexto ? ` (Contexto: ${r.contexto})` : ""}`).join("\n")
        : "";

      // 6. Construir prompt
      const systemPrompt = (config.system_prompt_base || "") + reglasTexto +
        '\n\nResponde EXCLUSIVAMENTE en JSON con este formato, sin markdown ni texto adicional:\n{\n  "insights": [\n    {\n      "tipo": "alerta|sugerencia|analisis",\n      "severidad": "critica|alta|media|info",\n      "categoria": "stockout|sobrestock|margen|costo|conteo|distribucion|tendencia|anomalia",\n      "titulo": "Título corto y claro",\n      "contenido": "Descripción detallada con números específicos",\n      "skus": ["SKU1", "SKU2"],\n      "accion_sugerida": "Lo que debería hacer el admin",\n      "datos": {}\n    }\n  ],\n  "resumen": "Resumen de 2-3 líneas del estado general"\n}';

      const userMessage = `Datos actuales del sistema (${new Date().toLocaleDateString("es-CL")}):\n\n${JSON.stringify(datos, null, 2)}`;

      // 7. Llamar a Claude API
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.max_tokens_output,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errText}`);
      }

      const result = await response.json();
      const tokensInput = result.usage?.input_tokens || 0;
      const tokensOutput = result.usage?.output_tokens || 0;
      const costoUsd = calcCostoUsd(tokensInput, tokensOutput, config.model);

      // 8. Parsear respuesta
      const rawText = result.content?.[0]?.text || "{}";
      let parsed: AgentResponse;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Intentar extraer JSON y limpiar errores comunes de LLMs
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          // Limpiar trailing commas antes de ] o } (error común de LLMs)
          const cleaned = jsonMatch[0]
            .replace(/,\s*([}\]])/g, "$1")
            .replace(/([{,]\s*)"?(\w+)"?\s*:/g, '$1"$2":');
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            throw new Error("No se pudo parsear la respuesta del agente como JSON");
          }
        } else {
          throw new Error("No se pudo parsear la respuesta del agente como JSON");
        }
      }

      const insights = parsed.insights || [];

      // 9. Guardar insights
      let savedInsights: unknown[] = [];
      let insertError: string | null = null;
      if (insights.length > 0) {
        const expiresAt = agente === "inventario"
          ? new Date(Date.now() + 86400000).toISOString()
          : agente === "reposicion"
          ? new Date(Date.now() + 7 * 86400000).toISOString()
          : null;

        const insightsToInsert = insights.map((ins: InsightRaw) => ({
          agente,
          run_id: runId,
          tipo: sanitizeTipo(ins.tipo),
          severidad: sanitizeSeveridad(ins.severidad),
          categoria: ins.categoria || "general",
          titulo: ins.titulo || "Sin título",
          contenido: (ins.contenido || "") + (ins.accion_sugerida ? `\n\nAcción sugerida: ${ins.accion_sugerida}` : ""),
          datos: ins.datos || null,
          skus_relacionados: ins.skus || null,
          expires_at: expiresAt,
        }));

        const insertResult = await insertAgentInsights(insightsToInsert);

        if (!insertResult.ok) {
          console.error("[agents/run] Error guardando insights:", insertResult.error);
          insertError = insertResult.error || "Error desconocido al guardar insights";
        } else {
          savedInsights = insertResult.inserted || [];
        }
      }

      // 10. Guardar snapshot
      await upsertSnapshot(agente, hash, datos);

      // 11. Actualizar run como completado
      const duracion = Date.now() - startTime;
      await updateAgentRun(runId, {
        estado: "completado",
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        costo_usd: costoUsd,
        duracion_ms: duracion,
        insights_generados: insights.length,
        completed_at: new Date().toISOString(),
      });

      // 12. Actualizar agent_config con último run
      await updateAgentConfig(agente, {
        last_run_at: new Date().toISOString(),
        last_run_tokens: tokensInput + tokensOutput,
        last_run_cost_usd: costoUsd,
      });

      return NextResponse.json({
        run_id: runId,
        insights_generados: insights.length,
        insights_guardados: savedInsights.length,
        insights: savedInsights,
        resumen: parsed.resumen || null,
        tokens: { input: tokensInput, output: tokensOutput },
        costo_usd: costoUsd,
        duracion_ms: duracion,
        ...(insertError ? { insert_error: insertError } : {}),
      });

    } catch (err) {
      // Error durante ejecución — registrar en run
      const duracion = Date.now() - startTime;
      await updateAgentRun(runId, {
        estado: "error",
        duracion_ms: duracion,
        error_mensaje: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      });
      throw err;
    }

  } catch (err) {
    console.error("[agents/run] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error interno" },
      { status: 500 }
    );
  }
}
