import { getServerSupabase } from "./supabase-server";

// ============================================
// Interfaces
// ============================================

export interface DBAgentConfig {
  id: string;
  nombre_display: string;
  descripcion: string | null;
  model: string;
  system_prompt_base: string | null;
  activo: boolean;
  max_tokens_input: number;
  max_tokens_output: number;
  schedule: string | null;
  last_run_at: string | null;
  last_run_tokens: number | null;
  last_run_cost_usd: number | null;
  config_extra: Record<string, unknown>;
  updated_at: string;
}

export interface DBAgentInsight {
  id: string;
  agente: string;
  run_id: string;
  tipo: "alerta" | "sugerencia" | "analisis" | "resumen";
  severidad: "critica" | "alta" | "media" | "info";
  categoria: string;
  titulo: string;
  contenido: string | null;
  datos: Record<string, unknown> | null;
  skus_relacionados: string[] | null;
  estado: "nuevo" | "visto" | "aceptado" | "rechazado" | "corregido";
  feedback_texto: string | null;
  feedback_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface DBAgentRule {
  id: string;
  agente: string;
  regla: string;
  contexto: string | null;
  origen: "feedback_admin" | "manual" | "sistema";
  origen_insight_id: string | null;
  prioridad: number;
  veces_aplicada: number;
  activa: boolean;
  created_at: string;
  updated_at: string;
}

export interface DBAgentRun {
  id: string;
  agente: string;
  trigger: "cron" | "manual" | "evento" | "chat";
  estado: "corriendo" | "completado" | "error";
  tokens_input: number | null;
  tokens_output: number | null;
  costo_usd: number | null;
  duracion_ms: number | null;
  insights_generados: number | null;
  error_mensaje: string | null;
  datos_snapshot_hash: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DBAgentConversation {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  contenido: string;
  agentes_invocados: string[] | null;
  tokens_usados: number | null;
  created_at: string;
}

// ============================================
// Agent Config
// ============================================

export async function fetchAgentConfigs(): Promise<DBAgentConfig[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  const { data } = await sb.from("agent_config").select("*").order("id");
  return data || [];
}

export async function fetchAgentConfig(id: string): Promise<DBAgentConfig | null> {
  const sb = getServerSupabase(); if (!sb) return null;
  const { data } = await sb.from("agent_config").select("*").eq("id", id).single();
  return data || null;
}

export async function updateAgentConfig(id: string, fields: Partial<DBAgentConfig>) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_config").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
}

// ============================================
// Agent Insights
// ============================================

export async function fetchAgentInsights(filters?: {
  agente?: string;
  estado?: string;
  severidad?: string;
  limit?: number;
}): Promise<DBAgentInsight[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  let q = sb.from("agent_insights").select("*").order("created_at", { ascending: false });
  if (filters?.agente) q = q.eq("agente", filters.agente);
  if (filters?.estado) q = q.eq("estado", filters.estado);
  if (filters?.severidad) q = q.eq("severidad", filters.severidad);
  if (filters?.limit) q = q.limit(filters.limit);
  const { data } = await q;
  return data || [];
}

export async function insertAgentInsights(insights: Omit<DBAgentInsight, "id" | "created_at" | "estado" | "feedback_texto" | "feedback_at">[]): Promise<{ ok: boolean; error?: string; inserted?: DBAgentInsight[] }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, error: "DB no disponible" };
  const { data, error } = await sb.from("agent_insights").insert(insights).select("*");
  if (error) {
    console.error("[insertAgentInsights] Error:", error.message, error.details);
    return { ok: false, error: error.message };
  }
  return { ok: true, inserted: data || [] };
}

export async function updateAgentInsight(id: string, fields: Partial<DBAgentInsight>): Promise<{ ok: boolean; error?: string }> {
  const sb = getServerSupabase(); if (!sb) return { ok: false, error: "DB no disponible" };
  const { data, error } = await sb.from("agent_insights").update(fields).eq("id", id).select("id, estado");
  if (error) {
    console.error("[updateAgentInsight] Error:", error.message);
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    console.error("[updateAgentInsight] No se actualizó ninguna fila para id:", id);
    return { ok: false, error: "No se encontró el insight o no se pudo actualizar (RLS)" };
  }
  return { ok: true };
}

// ============================================
// Agent Rules
// ============================================

export async function fetchAgentRules(agente?: string): Promise<DBAgentRule[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  let q = sb.from("agent_rules").select("*").order("prioridad");
  if (agente) q = q.eq("agente", agente).eq("activa", true);
  const { data } = await q;
  return data || [];
}

export async function insertAgentRule(rule: Omit<DBAgentRule, "id" | "created_at" | "updated_at" | "veces_aplicada">) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_rules").insert(rule);
}

export async function updateAgentRule(id: string, fields: Partial<DBAgentRule>) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_rules").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteAgentRule(id: string) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_rules").delete().eq("id", id);
}

export async function incrementRuleUsage(ruleIds: string[]) {
  const sb = getServerSupabase(); if (!sb) return;
  for (const id of ruleIds) {
    const { error } = await sb.rpc("increment_rule_usage", { rule_id: id });
    if (error) {
      // Fallback if RPC doesn't exist
      await sb.from("agent_rules").update({ veces_aplicada: 1 }).eq("id", id);
    }
  }
}

// ============================================
// Agent Runs
// ============================================

export async function insertAgentRun(run: Omit<DBAgentRun, "id" | "created_at">): Promise<string | null> {
  const sb = getServerSupabase(); if (!sb) return null;
  const { data } = await sb.from("agent_runs").insert(run).select("id").single();
  return data?.id || null;
}

export async function updateAgentRun(id: string, fields: Partial<DBAgentRun>) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_runs").update(fields).eq("id", id);
}

export async function fetchAgentRuns(filters?: { agente?: string; limit?: number }): Promise<DBAgentRun[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  let q = sb.from("agent_runs").select("*").order("created_at", { ascending: false });
  if (filters?.agente) q = q.eq("agente", filters.agente);
  if (filters?.limit) q = q.limit(filters.limit);
  const { data } = await q;
  return data || [];
}

export async function fetchLastSuccessfulRun(agente: string): Promise<DBAgentRun | null> {
  const sb = getServerSupabase(); if (!sb) return null;
  const { data } = await sb.from("agent_runs").select("*")
    .eq("agente", agente).eq("estado", "completado")
    .order("created_at", { ascending: false }).limit(1).single();
  return data || null;
}

// ============================================
// Agent Conversations
// ============================================

export async function fetchConversation(sessionId: string, limit = 10): Promise<DBAgentConversation[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  const { data } = await sb.from("agent_conversations").select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);
  return data || [];
}

export async function insertConversationMessage(msg: Omit<DBAgentConversation, "id" | "created_at">) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_conversations").insert(msg);
}

// ============================================
// Data Snapshots
// ============================================

export async function fetchSnapshot(hash: string): Promise<Record<string, unknown> | null> {
  const sb = getServerSupabase(); if (!sb) return null;
  const { data } = await sb.from("agent_data_snapshots").select("datos")
    .eq("hash", hash).single();
  return data?.datos || null;
}

export async function upsertSnapshot(tipo: string, hash: string, datos: Record<string, unknown>) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_data_snapshots").upsert({ tipo, hash, datos }, { onConflict: "hash" });
}

// ============================================
// Agent Triggers (server-side)
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

export async function fetchAgentTriggersServer(filters?: { tipo?: string; activo?: boolean }): Promise<DBAgentTrigger[]> {
  const sb = getServerSupabase(); if (!sb) return [];
  let q = sb.from("agent_triggers").select("*").order("agente").order("nombre");
  if (filters?.tipo) q = q.eq("tipo", filters.tipo);
  if (filters?.activo !== undefined) q = q.eq("activo", filters.activo);
  const { data } = await q;
  return data || [];
}

export async function updateAgentTriggerServer(id: string, fields: Partial<DBAgentTrigger>) {
  const sb = getServerSupabase(); if (!sb) return;
  await sb.from("agent_triggers").update(fields).eq("id", id);
}

// ============================================
// Helpers
// ============================================

export function calcCostoUsd(tokensInput: number, tokensOutput: number, model: string): number {
  // Precios Sonnet 4.6: $3/M input, $15/M output
  // Precios Opus 4.6: $15/M input, $75/M output
  // Precios Haiku 4.5: $0.80/M input, $4/M output
  const isOpus = model.includes("opus");
  const isHaiku = model.includes("haiku");
  const inputRate = isOpus ? 15 : isHaiku ? 0.8 : 3;
  const outputRate = isOpus ? 75 : isHaiku ? 4 : 15;
  return (tokensInput * inputRate + tokensOutput * outputRate) / 1_000_000;
}
