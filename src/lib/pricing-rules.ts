/**
 * pricing-rules.ts — Cliente del sistema de rule sets versionados.
 *
 * Lectura: loadActiveRuleSet(channel, domain, scope) con cache in-memory
 * por proceso (60s). El rule set cambia raramente.
 *
 * Escritura: publishRuleSet -> approveRuleSet (two-person rule) -> promoteRuleSet.
 *
 * Decision log: logDecision para reconstruir cualquier decision pasada.
 *
 * Manual: BANVA_Pricing_Engines_a_Escala §3.4 (lineas 182-205) y §3.5 (209-223).
 *
 * Uso tipico desde un endpoint:
 *
 *   const rs = await loadActiveRuleSet();
 *   const ladder = readRule<MarkdownLadder>(rs.rules, "markdown_ladder");
 *   // ... computar decision ...
 *   await logDecision({
 *     sku_origen, domain: "global", rule_set_hash: rs.content_hash,
 *     channel: "production", inputs: snapshot, decision: { precio, accion }, applied: false,
 *   });
 */
import { getServerSupabase } from "@/lib/supabase-server";

export type Channel = "production" | "canary" | "shadow" | "draft";
export type Domain  = "global" | "markdown" | "triggers" | "cuadrante" | "governance" | "elasticidad" | "bandits";

export type RuleSet = {
  rule_set_id:    string;
  version_label:  string;
  content_hash:   string;
  rules:          Record<string, unknown>;
  schema_version: number;
};

type CacheEntry = { ruleSet: RuleSet; expiresAt: number };
const CACHE_TTL_MS = 60_000;
const _cache = new Map<string, CacheEntry>();
const cacheKey = (channel: Channel, domain: Domain, scope: Record<string, unknown>) =>
  `${channel}|${domain}|${JSON.stringify(scope)}`;

/**
 * Devuelve el rule set activo del canal+dominio+scope, con cache 60s.
 * channel default "production", domain default "global", scope default {} (global).
 */
export async function loadActiveRuleSet(
  channel: Channel = "production",
  domain:  Domain  = "global",
  scope:   Record<string, unknown> = {},
): Promise<RuleSet | null> {
  const key = cacheKey(channel, domain, scope);
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > now) return cached.ruleSet;

  const sb = getServerSupabase();
  if (!sb) return null;

  const { data, error } = await sb.rpc("get_active_rule_set", {
    p_channel: channel,
    p_domain:  domain,
    p_scope:   scope,
  });
  if (error) {
    console.error(`[pricing-rules] get_active_rule_set failed: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;

  const row = data[0] as RuleSet;
  _cache.set(key, { ruleSet: row, expiresAt: now + CACHE_TTL_MS });
  return row;
}

/** Invalida el cache (util tras un promote para que el siguiente request vea el cambio). */
export function invalidateRuleSetCache(channel?: Channel, domain?: Domain, scope?: Record<string, unknown>) {
  if (!channel) { _cache.clear(); return; }
  const key = cacheKey(channel, domain ?? "global", scope ?? {});
  _cache.delete(key);
}

/**
 * Lee una sub-regla por path con default fallback.
 * Ej: readRule(rs.rules, "markdown_ladder.niveles", []).
 */
export function readRule<T>(rules: Record<string, unknown> | undefined, path: string, fallback: T): T {
  if (!rules) return fallback;
  const parts = path.split(".");
  let cur: unknown = rules;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return fallback;
    }
  }
  return (cur as T) ?? fallback;
}

/**
 * Publica un nuevo rule set como draft. Idempotente por content_hash:
 * mismo contenido devuelve el id existente con was_new=false.
 */
export async function publishRuleSet(args: {
  domain:        Domain;
  version_label: string;
  rules:         Record<string, unknown>;
  parent_id?:    string;
  created_by:    string;
  notes?:        string;
  schema_version?: number;
}): Promise<{ id: string; content_hash: string; was_new: boolean } | null> {
  const sb = getServerSupabase();
  if (!sb) return null;

  const { data, error } = await sb.rpc("publish_rule_set", {
    p_domain:         args.domain,
    p_version_label:  args.version_label,
    p_rules:          args.rules,
    p_parent_id:      args.parent_id ?? null,
    p_created_by:     args.created_by,
    p_notes:          args.notes ?? null,
    p_schema_version: args.schema_version ?? 1,
  });
  if (error) {
    console.error(`[pricing-rules] publish_rule_set failed: ${error.message}`);
    return null;
  }
  const row = (data as Array<{ id: string; content_hash: string; was_new: boolean }>)[0];
  return row ?? null;
}

/**
 * Aprueba un rule set draft. Two-person rule: approved_by != created_by.
 */
export async function approveRuleSet(rule_set_id: string, approved_by: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data, error } = await sb.rpc("approve_rule_set", {
    p_rule_set_id: rule_set_id,
    p_approved_by: approved_by,
  });
  if (error) {
    console.error(`[pricing-rules] approve_rule_set failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
  return { ok: true, ...(data as object) };
}

/**
 * Apunta un canal+dominio+scope al rule set indicado. Solo si está approved
 * y los dominios coinciden. Invalida cache automáticamente.
 */
export async function promoteRuleSet(args: {
  rule_set_id:    string;
  channel:        Channel;
  domain:         Domain;
  scope?:         Record<string, unknown>;
  rollout_pct?:   number;
  activated_by:   string;
  notes?:         string;
}): Promise<{ ok: boolean; error?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { error } = await sb.rpc("promote_rule_set", {
    p_rule_set_id:  args.rule_set_id,
    p_channel:      args.channel,
    p_domain:       args.domain,
    p_scope:        args.scope ?? {},
    p_rollout_pct:  args.rollout_pct ?? 100,
    p_activated_by: args.activated_by,
    p_notes:        args.notes ?? null,
  });
  if (error) {
    console.error(`[pricing-rules] promote_rule_set failed: ${error.message}`);
    return { ok: false, error: error.message };
  }

  invalidateRuleSetCache(args.channel, args.domain, args.scope);
  return { ok: true };
}

/**
 * Append-only log de una decision de pricing. Para "por que este SKU bajo ayer"
 * y para entrenamiento futuro de elasticidad.
 */
export async function logDecision(args: {
  sku_origen:    string;
  domain:        Domain;
  rule_set_hash: string;
  channel:       Channel;
  inputs:        Record<string, unknown>;
  decision:      Record<string, unknown>;
  applied?:      boolean;
}): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;

  const { error } = await sb.rpc("log_pricing_decision", {
    p_sku_origen:    args.sku_origen,
    p_domain:        args.domain,
    p_rule_set_hash: args.rule_set_hash,
    p_channel:       args.channel,
    p_inputs:        args.inputs,
    p_decision:      args.decision,
    p_applied:       args.applied ?? false,
  });
  if (error) {
    console.error(`[pricing-rules] log_pricing_decision failed: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Stable hashing para canary rollout: dado un sku y un rollout_pct (0-100),
 * decide si este SKU cae dentro del bucket canary. Determinista.
 * Manual: Engines_a_Escala:205 ("hash(customer_id || rule_set_id) % 100 < rollout_pct").
 */
export function isInCanaryBucket(sku: string, rule_set_id: string, rollout_pct: number): boolean {
  if (rollout_pct >= 100) return true;
  if (rollout_pct <= 0) return false;
  let h = 5381;
  const s = `${sku}|${rule_set_id}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const bucket = Math.abs(h) % 100;
  return bucket < rollout_pct;
}

// ============================================================================
// Tipos del rule set v1 (schema interno del JSONB rules).
// Bump schema_version en migracion cuando cambies estos.
// ============================================================================

export type MarkdownLadderNivel = { dias_min: number; descuento_pct: number };
export type MarkdownLadder = { min_dias_para_postular: number; niveles: MarkdownLadderNivel[]; fuente?: string };

export type ValleMuerte = { min_clp: number; max_clp: number; fuente?: string };

export type SubtipoRevisarOverride = { margen_min_pct: number; descuento_max_pct: number; no_postular: boolean };
export type SubtipoRevisar = {
  criterios: { liquidar_dias_sin_mov_min: number; nuevo_dias_desde_primera_max: number };
  overrides: { revisar_sano: SubtipoRevisarOverride; revisar_sin_stock: SubtipoRevisarOverride; revisar_nuevo: SubtipoRevisarOverride };
  fuente?: string;
};

export type TriggersReclasificacion = {
  aging:       { dias_sin_movimiento_min: number };
  crecimiento: { mom_pct_min: number; meses_consecutivos: number };
  margen_bajo: { margen_pct_max: number; meses_consecutivos: number };
  fuente?: string;
};

export type Cooldown = { ventana_horas: number; max_bajadas_en_ventana: number };

export type CmaaAlerta = { umbral_pct: number; ventana_dias: number; fuente?: string };

export type Cobertura = {
  min_postular_dias: number; sobrestock_warning_dias: number;
  objetivo_dias: number; maxima_dias: number;
  target_dias_a: number; target_dias_b: number; target_dias_c: number;
};

export type CuadranteConfig = {
  margen_min_pct: number; politica_default: string; acos_objetivo_pct: number;
  descuento_max_pct: number; descuento_max_kvi_pct: number; canal_preferido: string;
};
export type Cuadrantes = {
  ESTRELLA: CuadranteConfig; VOLUMEN: CuadranteConfig;
  CASHCOW: CuadranteConfig; REVISAR: CuadranteConfig; _DEFAULT: CuadranteConfig;
  fuente?: string;
};

export type RampupBucket = {
  dias_min: number; dias_max: number;
  factor_propio: number; factor_proveedor: number; etiqueta: string;
};
export type RampupPostQuiebre = { buckets: RampupBucket[] };

export type Gates = {
  kvi_descuento_max_pct: number; defender_descuento_max_pct: number;
  margen_colchon_warning_pp: number; tendencia_velocidad_pp: number;
};

export type Governance = {
  status: "PLACEHOLDER_NOT_ENFORCED" | "ENFORCED";
  max_change_pct_diario: number; max_change_pct_semanal: number; max_change_pct_mensual: number;
  fuente?: string; notas?: string;
};
