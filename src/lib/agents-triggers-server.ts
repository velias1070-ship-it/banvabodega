import { getServerSupabase } from "./supabase-server";
import { getBaseUrl } from "./base-url";

/**
 * Server-side version of dispararTrigger.
 * Looks up matching event triggers and calls /api/agents/run for each.
 * Fire and forget — does not block the caller.
 */
export async function dispararTriggerServer(evento: string, datos?: Record<string, unknown>) {
  try {
    const sb = getServerSupabase(); if (!sb) return;

    const { data: triggers } = await sb
      .from("agent_triggers")
      .select("*")
      .eq("tipo", "evento")
      .eq("activo", true);

    if (!triggers || triggers.length === 0) return;

    const matching = triggers.filter((t: { configuracion: { evento?: string } }) => {
      return t.configuracion?.evento === evento;
    });

    if (matching.length === 0) return;

    // Determine base URL for internal API calls
    const baseUrl = getBaseUrl();

    for (const trigger of matching) {
      // Fire and forget
      fetch(`${baseUrl}/api/agents/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agente: trigger.agente,
          trigger: "evento",
          evento,
          datos,
        }),
      }).catch(err => console.error(`[trigger-server] Error ejecutando ${trigger.agente}:`, err));

      // Update ultima_ejecucion
      sb.from("agent_triggers")
        .update({ ultima_ejecucion: new Date().toISOString() })
        .eq("id", trigger.id)
        .then(
          () => {},
          (err: unknown) => console.error(`[trigger-server] Error actualizando trigger ${trigger.id}:`, err),
        );
    }

    console.log(`[trigger-server] Evento '${evento}' disparó ${matching.length} agente(s): ${matching.map((t: { agente: string }) => t.agente).join(", ")}`);

    // Disparar recálculo de inteligencia para eventos relevantes
    const eventosIntelligence = ["ordenes_importadas", "picking_completado", "recepcion_cerrada", "proveedor_cargado"];
    if (eventosIntelligence.includes(evento)) {
      const skus = datos?.skus as string[] | undefined;
      const isFull = evento === "proveedor_cargado" || evento === "ordenes_importadas";
      fetch(`${baseUrl}/api/intelligence/recalcular`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isFull ? { full: true } : skus ? { skus } : { full: true }),
      }).catch(err => console.error(`[trigger-server] Error disparando intelligence:`, err));
    }
  } catch (err) {
    console.error(`[trigger-server] Error procesando evento '${evento}':`, err);
  }
}
