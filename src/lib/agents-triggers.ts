import { getSupabase } from "./supabase";

// ============================================
// Interfaces
// ============================================

export interface DBAgentTrigger {
  id: string;
  agente: string;
  nombre: string;
  tipo: "tiempo" | "evento" | "manual";
  configuracion: Record<string, unknown>;
  activo: boolean;
  ultima_ejecucion: string | null;
  created_at: string;
}

// ============================================
// CRUD (client-side)
// ============================================

export async function fetchAgentTriggers(): Promise<DBAgentTrigger[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("agent_triggers").select("*").order("agente").order("nombre");
  return data || [];
}

export async function updateAgentTrigger(id: string, fields: Partial<DBAgentTrigger>) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("agent_triggers").update(fields).eq("id", id);
}

// ============================================
// Disparar trigger por evento (fire and forget)
// ============================================

export async function dispararTrigger(evento: string, datos?: Record<string, unknown>) {
  try {
    const sb = getSupabase(); if (!sb) return;

    // 1. Buscar triggers activos de tipo 'evento' que matchean este evento
    const { data: triggers } = await sb
      .from("agent_triggers")
      .select("*")
      .eq("tipo", "evento")
      .eq("activo", true);

    if (!triggers || triggers.length === 0) return;

    const matching = triggers.filter((t: DBAgentTrigger) => {
      const config = t.configuracion as { evento?: string };
      return config.evento === evento;
    });

    if (matching.length === 0) return;

    // 2. Para cada trigger encontrado, ejecutar el agente via POST /api/agents/run
    for (const trigger of matching) {
      // Fire and forget — no esperamos la respuesta
      fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agente: trigger.agente,
          trigger: "evento",
          evento,
          datos,
        }),
      }).catch(err => console.error(`[trigger] Error ejecutando ${trigger.agente}:`, err));

      // 3. Actualizar ultima_ejecucion del trigger
      sb.from("agent_triggers")
        .update({ ultima_ejecucion: new Date().toISOString() })
        .eq("id", trigger.id)
        .then(
          () => {},
          (err: unknown) => console.error(`[trigger] Error actualizando trigger ${trigger.id}:`, err),
        );
    }

    console.log(`[trigger] Evento '${evento}' disparó ${matching.length} agente(s): ${matching.map((t: DBAgentTrigger) => t.agente).join(", ")}`);
  } catch (err) {
    console.error(`[trigger] Error procesando evento '${evento}':`, err);
  }
}
