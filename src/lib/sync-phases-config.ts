/**
 * Helpers para gestionar cadencias diferenciadas por fase del cron metrics-sync.
 *
 * Tabla: ml_sync_phases_config
 *   - cadencia_horas: cada cuánto debe correr la fase
 *   - last_run_at / next_run_at: tracking de última corrida y próxima programada
 *   - active: false = fase totalmente desactivada
 *   - cadencia_min/max_horas: validación a nivel app para evitar cambios accidentales
 *
 * Pattern: ejecutarSyncCompleto() pregunta `shouldRunPhase(fase)` antes de cada fase.
 * Si retorna false, salta. Tras correr, llama `markPhaseRun(fase, ok, errMsg?)`.
 */

import { getServerSupabase } from "./supabase-server";

export interface PhaseConfig {
  fase: string;
  cadencia_horas: number;
  last_run_at: string | null;
  next_run_at: string | null;
  active: boolean;
  cadencia_min_horas: number;
  cadencia_max_horas: number;
}

export async function getPhaseConfig(fase: string): Promise<PhaseConfig | null> {
  const sb = getServerSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from("ml_sync_phases_config")
    .select("*")
    .eq("fase", fase)
    .maybeSingle();
  if (error) {
    console.error(`[sync-phases-config] read failed for ${fase}: ${error.message}`);
    return null;
  }
  return (data as PhaseConfig) ?? null;
}

/**
 * ¿Debe correr esta fase ahora? Retorna true si:
 *   - active = true Y
 *   - next_run_at IS NULL (nunca corrió) O next_run_at <= now()
 *
 * Si la fase no existe en la config, retorna `null` → caller decide
 * (compatibilidad con código viejo: si null, asumir "sí, correr" para no romper).
 */
export async function shouldRunPhase(fase: string): Promise<boolean | null> {
  const cfg = await getPhaseConfig(fase);
  if (!cfg) return null;
  if (!cfg.active) return false;
  if (!cfg.next_run_at) return true;
  return new Date(cfg.next_run_at).getTime() <= Date.now();
}

/**
 * Tras correr una fase: actualizar last_run_at + next_run_at + escribir telemetría
 * a ml_sync_health.phase_status.
 *
 * @param ok - true si la fase corrió sin errores; false si falló
 * @param errMsg - mensaje de error si ok=false
 */
export async function markPhaseRun(
  fase: string,
  ok: boolean,
  errMsg?: string,
): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  const cfg = await getPhaseConfig(fase);
  if (!cfg) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const nextRun = new Date(now.getTime() + cfg.cadencia_horas * 3600_000).toISOString();

  // 1. Update last_run_at + next_run_at
  await sb
    .from("ml_sync_phases_config")
    .update({ last_run_at: nowIso, next_run_at: nextRun })
    .eq("fase", fase);

  // 2. Telemetría a ml_sync_health.phase_status (jsonb merge sin pisar otras fases)
  // Lee el JSON actual, mergea solo la key de esta fase.
  const { data: healthRow } = await sb
    .from("ml_sync_health")
    .select("phase_status")
    .eq("job_name", "metrics_monthly")
    .maybeSingle();

  const prev = (healthRow as { phase_status: Record<string, unknown> } | null)?.phase_status ?? {};
  const prevPhase = (prev[fase] as { last_success?: string } | undefined) ?? {};
  // En éxito: actualizar last_run + last_success + error=null
  // En fallo: actualizar last_run + error, preservar el último last_success (no resetear)
  const phaseEntry = ok
    ? { last_run: nowIso, last_success: nowIso, error: null }
    : { last_run: nowIso, error: errMsg ?? "unknown", last_success: prevPhase.last_success ?? null };
  const merged = { ...prev, [fase]: phaseEntry };

  await sb
    .from("ml_sync_health")
    .update({ phase_status: merged })
    .eq("job_name", "metrics_monthly");
}
