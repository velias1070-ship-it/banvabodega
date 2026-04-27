-- v85: pricing_rule_sets — Sistema de reglas versionadas para pricing
--
-- Fuente: BANVA_Pricing_Engines_a_Escala §3.4 (versioning content-addressable,
-- linea 5 tesis principal, lineas 182-205 schema, lineas 209-223 audit).
--
-- Patron canonico: rule set = JSONB validado por pg_jsonschema, identificado
-- por content_hash (sha256). Rollback = update pointer al hash previo.
-- Append-only decision log para reconstruir cualquier decision pasada.
--
-- Dominios soportados v1: 'global' (rule set monolitico inicial). Roadmap:
-- splittear en 'markdown', 'triggers', 'cuadrante', 'governance' cuando
-- duela coordinar cambios cross-dominio.
--
-- COEXISTE con pricing_cuadrante_config (v74). El cutover (UI + lectura
-- de codigo) se hace en migracion siguiente para permitir rollback.

-- ========================================================================
-- 1. RULE SETS (versionados, content-addressable, con linaje)
-- ========================================================================
CREATE TABLE IF NOT EXISTS pricing_rule_sets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          text NOT NULL CHECK (domain IN ('global','markdown','triggers','cuadrante','governance','elasticidad','bandits')),
  version_label   text NOT NULL,
  content_hash    text UNIQUE NOT NULL,
  parent_id       uuid REFERENCES pricing_rule_sets(id) ON DELETE SET NULL,
  rules           jsonb NOT NULL,
  schema_version  int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  created_by      text NOT NULL,
  approved_by     text,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  notes           text,
  CONSTRAINT approval_consistency CHECK (
    (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status <> 'approved')
  )
);

CREATE INDEX IF NOT EXISTS idx_pricing_rule_sets_domain ON pricing_rule_sets(domain);
CREATE INDEX IF NOT EXISTS idx_pricing_rule_sets_status ON pricing_rule_sets(status) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_pricing_rule_sets_parent ON pricing_rule_sets(parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE pricing_rule_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prs_select" ON pricing_rule_sets FOR SELECT USING (true);
CREATE POLICY "prs_insert" ON pricing_rule_sets FOR INSERT WITH CHECK (true);
CREATE POLICY "prs_update" ON pricing_rule_sets FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "prs_delete" ON pricing_rule_sets FOR DELETE USING (true);

COMMENT ON TABLE pricing_rule_sets IS 'Versiones inmutables de rule sets. content_hash sha256 identifica contenido unico. Manual: Engines_a_Escala:182-205.';
COMMENT ON COLUMN pricing_rule_sets.content_hash IS 'sha256(canonicalize(rules)) — mismo contenido = mismo hash, garantiza idempotencia.';
COMMENT ON COLUMN pricing_rule_sets.parent_id IS 'Linaje: de que version se derivo esta. Null = raiz.';
COMMENT ON COLUMN pricing_rule_sets.schema_version IS 'Bump cuando evolucione el schema interno del JSONB rules. Permite leer versiones viejas con compat shim.';
COMMENT ON COLUMN pricing_rule_sets.domain IS 'global = rule set monolitico inicial. Splitear cuando duela coordinar cambios cross-dominio.';

-- ========================================================================
-- 2. POINTERS (canal × dominio × scope → rule set activo)
-- ========================================================================
-- channel: production | canary | shadow | draft
--   - production = el que aplica en serio
--   - canary = nueva version corriendo en X% del trafico (rollout_pct)
--   - shadow = computa output sin aplicar, log para comparar
--   - draft = en desarrollo, no expuesto
-- scope: jsonb {} = global. Futuro: {country:'CL'}, {cuadrante:'ESTRELLA'}, etc.
CREATE TABLE IF NOT EXISTS pricing_rule_set_pointers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('production','canary','shadow','draft')),
  domain          text NOT NULL,
  scope           jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_set_id     uuid NOT NULL REFERENCES pricing_rule_sets(id) ON DELETE RESTRICT,
  rollout_pct     int NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  activated_at    timestamptz NOT NULL DEFAULT now(),
  activated_by    text NOT NULL,
  notes           text
);

-- Un pointer por combinacion (channel, domain, scope). Re-activar = INSERT nuevo
-- + DELETE del previo (asi queda log historico via timestamps si quisieramos).
-- Para simplicidad inicial usamos UNIQUE + UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_pointers_unique ON pricing_rule_set_pointers(channel, domain, (scope::text));

ALTER TABLE pricing_rule_set_pointers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prsp_select" ON pricing_rule_set_pointers FOR SELECT USING (true);
CREATE POLICY "prsp_insert" ON pricing_rule_set_pointers FOR INSERT WITH CHECK (true);
CREATE POLICY "prsp_update" ON pricing_rule_set_pointers FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "prsp_delete" ON pricing_rule_set_pointers FOR DELETE USING (true);

COMMENT ON TABLE pricing_rule_set_pointers IS 'Apuntan al rule set activo por canal+dominio+scope. Promote = update 1 row. Rollback = update al hash previo.';
COMMENT ON COLUMN pricing_rule_set_pointers.scope IS '{} = global. Futuro multi-pais o per-cuadrante.';
COMMENT ON COLUMN pricing_rule_set_pointers.rollout_pct IS 'Para canary stable hashing. 100 = aplica a todo el universo del scope.';

-- ========================================================================
-- 3. DECISION LOG (append-only, particionado por mes)
-- ========================================================================
-- Razon de particionar: ~425 SKUs * varios algoritmos * 365 dias = millones
-- de filas/ano. Particion mensual permite drop de particiones viejas para
-- retencion sin DELETE masivo.
CREATE TABLE IF NOT EXISTS pricing_decision_log (
  id              bigserial,
  ts              timestamptz NOT NULL DEFAULT now(),
  sku_origen      text NOT NULL,
  domain          text NOT NULL,
  rule_set_hash   text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('production','canary','shadow','draft')),
  inputs          jsonb NOT NULL,
  decision        jsonb NOT NULL,
  applied         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

-- Particiones iniciales: mes actual y los proximos 3.
-- Cron mensual creara la siguiente automaticamente (TODO: helper).
CREATE TABLE IF NOT EXISTS pricing_decision_log_2026_04 PARTITION OF pricing_decision_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS pricing_decision_log_2026_05 PARTITION OF pricing_decision_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS pricing_decision_log_2026_06 PARTITION OF pricing_decision_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS pricing_decision_log_2026_07 PARTITION OF pricing_decision_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX IF NOT EXISTS idx_pdl_sku_ts ON pricing_decision_log(sku_origen, ts DESC);
CREATE INDEX IF NOT EXISTS idx_pdl_ts ON pricing_decision_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_pdl_hash ON pricing_decision_log(rule_set_hash);
CREATE INDEX IF NOT EXISTS idx_pdl_domain_ts ON pricing_decision_log(domain, ts DESC);

ALTER TABLE pricing_decision_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pdl_select" ON pricing_decision_log FOR SELECT USING (true);
CREATE POLICY "pdl_insert" ON pricing_decision_log FOR INSERT WITH CHECK (true);
-- Sin UPDATE/DELETE policies: append-only por diseno.

COMMENT ON TABLE pricing_decision_log IS 'Append-only ledger de decisiones de pricing. Para reconstruir "por que este SKU bajo/subio" + entrenamiento elasticidad. Manual: Engines_a_Escala:209-223.';
COMMENT ON COLUMN pricing_decision_log.inputs IS 'Snapshot del estado del SKU al momento (cuadrante, vel, dias_sin_mov, etc.) para counterfactuals.';
COMMENT ON COLUMN pricing_decision_log.decision IS 'Output del rule set: precio_sugerido, accion, motivos, gates_disparados.';
COMMENT ON COLUMN pricing_decision_log.applied IS 'true = se aplico (postulacion ML real). false = dry-run o shadow.';

-- ========================================================================
-- 4. SEED: rule set v1.0.0 inicial
-- ========================================================================
-- Captura los ~98 valores movibles del inventario _inventario_thresholds.md.
-- Domain = 'global' inicial. Despues splitearemos por dominio.
--
-- Fuentes citadas en cada bloque:
--   markdown_ladder         -> Investigacion_Comparada:197
--   valle_muerte            -> Engines_a_Escala (politica ML CL)
--   subtipo_revisar         -> Investigacion_Comparada:197 + Deep_Research §3
--   triggers_reclasificacion -> Investigacion_Comparada:235
--   pareto                  -> clasico ABC
--   cuadrantes              -> Investigacion_Comparada:148, pricing_cuadrante_config v74
--   cmaa_alerta             -> Investigacion_Comparada:329
--   governance              -> Investigacion_Comparada:630 (NOT IMPLEMENTED, placeholder)

DO $$
DECLARE
  v_rules    jsonb;
  v_hash     text;
  v_id       uuid;
BEGIN
  v_rules := '{
    "version": "v1.0.0",
    "domain": "global",
    "fuente": "BANVA Pricing manuales — extraccion automatica del inventario v1.0.0 (2026-04-27)",
    "markdown_ladder": {
      "fuente": "Investigacion_Comparada:197",
      "min_dias_para_postular": 90,
      "niveles": [
        {"dias_min": 90,  "descuento_pct": 20},
        {"dias_min": 120, "descuento_pct": 40},
        {"dias_min": 180, "descuento_pct": 60}
      ]
    },
    "valle_muerte": {
      "fuente": "Engines_a_Escala — politica ML CL",
      "min_clp": 19990,
      "max_clp": 23000
    },
    "subtipo_revisar": {
      "fuente": "Investigacion_Comparada:197 + Deep_Research §3",
      "criterios": {
        "liquidar_dias_sin_mov_min": 180,
        "nuevo_dias_desde_primera_max": 60
      },
      "overrides": {
        "revisar_sano":      {"margen_min_pct": 15, "descuento_max_pct": 20, "no_postular": false},
        "revisar_sin_stock": {"margen_min_pct": 20, "descuento_max_pct": 10, "no_postular": true},
        "revisar_nuevo":     {"margen_min_pct": 15, "descuento_max_pct": 15, "no_postular": true}
      }
    },
    "triggers_reclasificacion": {
      "fuente": "Investigacion_Comparada:235",
      "aging":       {"dias_sin_movimiento_min": 120},
      "crecimiento": {"mom_pct_min": 20, "meses_consecutivos": 3},
      "margen_bajo": {"margen_pct_max": 15, "meses_consecutivos": 2}
    },
    "pareto": {
      "umbral_clase_a": 80,
      "umbral_clase_b": 95
    },
    "recovery_rampup": {
      "vel_30d_min_pct_de_pre_quiebre": 80
    },
    "distribucion_default": {
      "full_pct": 80,
      "flex_pct": 20
    },
    "rampup_post_quiebre": {
      "buckets": [
        {"dias_min": 0,   "dias_max": 0,   "factor_propio": 1.00, "factor_proveedor": 1.00, "etiqueta": "no_aplica"},
        {"dias_min": 1,   "dias_max": 14,  "factor_propio": 1.00, "factor_proveedor": 1.00, "etiqueta": "fresco"},
        {"dias_min": 15,  "dias_max": 30,  "factor_propio": 0.50, "factor_proveedor": 1.00, "etiqueta": "medio_propio"},
        {"dias_min": 31,  "dias_max": 60,  "factor_propio": 0.50, "factor_proveedor": 0.75, "etiqueta": "medio_mixto"},
        {"dias_min": 61,  "dias_max": 120, "factor_propio": 0.30, "factor_proveedor": 0.75, "etiqueta": "largo"},
        {"dias_min": 121, "dias_max": 365, "factor_propio": 0.00, "factor_proveedor": 0.50, "etiqueta": "discontinuar_candidato"}
      ]
    },
    "cooldown": {
      "ventana_horas": 24,
      "max_bajadas_en_ventana": 2
    },
    "cmaa_alerta": {
      "fuente": "Investigacion_Comparada:329",
      "umbral_pct": 8,
      "ventana_dias": 60
    },
    "cobertura": {
      "min_postular_dias": 28,
      "sobrestock_warning_dias": 90,
      "objetivo_dias": 40,
      "maxima_dias": 60,
      "target_dias_a": 42,
      "target_dias_b": 28,
      "target_dias_c": 14
    },
    "service_level_z": {
      "z_97": 1.88,
      "z_95": 1.65,
      "z_80": 1.28
    },
    "forecast_quality_alerts": {
      "tracking_signal_umbral": 4,
      "bias_pct_de_vel_umbral": 30,
      "min_semanas_evaluadas_ts": 4,
      "min_semanas_evaluadas_bias": 8
    },
    "gates": {
      "kvi_descuento_max_pct": 20,
      "defender_descuento_max_pct": 10,
      "margen_colchon_warning_pp": 3,
      "tendencia_velocidad_pp": 15
    },
    "quiebre_prolongado": {
      "rama_1_dias_min": 14,
      "rama_1_vel_pre_min": 2,
      "rama_2_dias_min": 7,
      "vel_pre_factor_vs_act": 2
    },
    "tsb": {
      "edad_minima_dias": 60
    },
    "imputacion": {
      "semanas_en_30d": 4.3
    },
    "cuadrantes": {
      "fuente": "Investigacion_Comparada:148 + pricing_cuadrante_config v74",
      "ESTRELLA": {"margen_min_pct": 8,  "politica_default": "exprimir", "acos_objetivo_pct": 13, "descuento_max_pct": 10, "descuento_max_kvi_pct": 8,  "canal_preferido": "full"},
      "VOLUMEN":  {"margen_min_pct": 5,  "politica_default": "seguir",   "acos_objetivo_pct": 18, "descuento_max_pct": 25, "descuento_max_kvi_pct": 15, "canal_preferido": "mixto"},
      "CASHCOW":  {"margen_min_pct": 20, "politica_default": "defender", "acos_objetivo_pct": 7,  "descuento_max_pct": 10, "descuento_max_kvi_pct": 8,  "canal_preferido": "flex"},
      "REVISAR":  {"margen_min_pct": 0,  "politica_default": "liquidar", "acos_objetivo_pct": 5,  "descuento_max_pct": 60, "descuento_max_kvi_pct": 30, "canal_preferido": "flex"},
      "_DEFAULT": {"margen_min_pct": 15, "politica_default": "seguir",   "acos_objetivo_pct": 12, "descuento_max_pct": 20, "descuento_max_kvi_pct": 10, "canal_preferido": "mixto"}
    },
    "governance": {
      "fuente": "Investigacion_Comparada:630",
      "status": "PLACEHOLDER_NOT_ENFORCED",
      "max_change_pct_diario": 10,
      "max_change_pct_semanal": 25,
      "max_change_pct_mensual": 25,
      "notas": "Limites no aplicados en codigo todavia. Solo defender <=10pp por postulacion existe."
    }
  }'::jsonb;

  -- Hash canonico: usamos el texto JSONB directo. Para idempotencia futura
  -- el helper TS canonicalizara con keys ordenadas; aca para el seed alcanza.
  v_hash := encode(sha256(v_rules::text::bytea), 'hex');

  -- Insertar rule set inicial como approved (es el bootstrap, no hay parent).
  INSERT INTO pricing_rule_sets (
    domain, version_label, content_hash, rules, schema_version,
    status, created_by, approved_by, approved_at, notes
  ) VALUES (
    'global', 'v1.0.0', v_hash, v_rules, 1,
    'approved', 'migration_v85', 'migration_v85', now(),
    'Bootstrap inicial: extraido del inventario _inventario_thresholds.md (2026-04-27). Refleja constantes hardcoded actuales en src/lib/pricing.ts, intelligence.ts, rampup.ts y endpoints markdown-auto/triggers-reclasificacion.'
  )
  ON CONFLICT (content_hash) DO UPDATE SET notes = EXCLUDED.notes
  RETURNING id INTO v_id;

  -- Apuntar production al rule set v1.0.0.
  INSERT INTO pricing_rule_set_pointers (
    channel, domain, scope, rule_set_id, rollout_pct, activated_by, notes
  ) VALUES (
    'production', 'global', '{}'::jsonb, v_id, 100, 'migration_v85',
    'Bootstrap: production apunta al rule set v1.0.0 al 100%. Codigo todavia lee de constantes hardcoded; cutover en migracion siguiente.'
  )
  ON CONFLICT (channel, domain, (scope::text)) DO UPDATE SET
    rule_set_id = EXCLUDED.rule_set_id,
    activated_at = now(),
    notes = EXCLUDED.notes;

END $$;

-- ========================================================================
-- 5. RPC helpers
-- ========================================================================

-- Carga el rule set activo para un canal+dominio+scope.
-- Retorna NULL si no hay pointer.
CREATE OR REPLACE FUNCTION get_active_rule_set(
  p_channel text DEFAULT 'production',
  p_domain  text DEFAULT 'global',
  p_scope   jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  rule_set_id     uuid,
  version_label   text,
  content_hash    text,
  rules           jsonb,
  schema_version  int
)
LANGUAGE sql STABLE
AS $$
  SELECT rs.id, rs.version_label, rs.content_hash, rs.rules, rs.schema_version
  FROM pricing_rule_set_pointers p
  JOIN pricing_rule_sets rs ON rs.id = p.rule_set_id
  WHERE p.channel = p_channel
    AND p.domain  = p_domain
    AND p.scope::text = p_scope::text
    AND rs.status = 'approved'
  LIMIT 1;
$$;

COMMENT ON FUNCTION get_active_rule_set IS 'Devuelve el rule set activo para channel+domain+scope. Default: production global. Manual: Engines_a_Escala:182-205.';

-- Helper para crear particion del decision log (usar en cron mensual).
CREATE OR REPLACE FUNCTION ensure_decision_log_partition(p_year int, p_month int)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_name      text;
  v_from      date;
  v_to        date;
BEGIN
  v_name := format('pricing_decision_log_%s_%s', p_year, lpad(p_month::text, 2, '0'));
  v_from := make_date(p_year, p_month, 1);
  v_to   := v_from + interval '1 month';

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF pricing_decision_log FOR VALUES FROM (%L) TO (%L)',
    v_name, v_from, v_to
  );
  RETURN v_name;
END $$;

COMMENT ON FUNCTION ensure_decision_log_partition IS 'Idempotente: crea particion mensual si no existe. Llamar desde cron mensual (1ro del mes).';

-- ========================================================================
-- 6. RPC: publicar / aprobar / promover / loguear
-- ========================================================================

-- Publicar rule set como draft. Idempotente por content_hash.
CREATE OR REPLACE FUNCTION publish_rule_set(
  p_domain        text,
  p_version_label text,
  p_rules         jsonb,
  p_parent_id     uuid    DEFAULT NULL,
  p_created_by    text    DEFAULT 'admin',
  p_notes         text    DEFAULT NULL,
  p_schema_version int    DEFAULT 1
)
RETURNS TABLE (id uuid, content_hash text, was_new boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash text;
  v_id   uuid;
  v_existing_id uuid;
BEGIN
  v_hash := encode(sha256(p_rules::text::bytea), 'hex');

  SELECT pricing_rule_sets.id INTO v_existing_id
  FROM pricing_rule_sets WHERE pricing_rule_sets.content_hash = v_hash;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing_id, v_hash, false;
    RETURN;
  END IF;

  INSERT INTO pricing_rule_sets (
    domain, version_label, content_hash, parent_id, rules, schema_version,
    status, created_by, notes
  ) VALUES (
    p_domain, p_version_label, v_hash, p_parent_id, p_rules, p_schema_version,
    'draft', p_created_by, p_notes
  )
  RETURNING pricing_rule_sets.id INTO v_id;

  RETURN QUERY SELECT v_id, v_hash, true;
END $$;

COMMENT ON FUNCTION publish_rule_set IS 'Crea rule set draft. Idempotente: mismo content_hash retorna existente. Manual: Engines_a_Escala:182-205.';

-- Aprobar rule set draft. Two-person rule (manual:596): aprobador != creador.
CREATE OR REPLACE FUNCTION approve_rule_set(
  p_rule_set_id uuid,
  p_approved_by text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_created_by text;
  v_status     text;
BEGIN
  SELECT created_by, status INTO v_created_by, v_status
  FROM pricing_rule_sets WHERE id = p_rule_set_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'rule_set_not_found: %', p_rule_set_id;
  END IF;

  IF v_status = 'approved' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'reason', 'already_approved');
  END IF;

  IF v_status = 'retired' THEN
    RAISE EXCEPTION 'cannot_approve_retired: %', p_rule_set_id;
  END IF;

  IF v_created_by = p_approved_by THEN
    RAISE EXCEPTION 'two_person_rule_violated: created_by % cannot also approve', p_approved_by;
  END IF;

  UPDATE pricing_rule_sets
  SET status = 'approved', approved_by = p_approved_by, approved_at = now()
  WHERE id = p_rule_set_id;

  RETURN jsonb_build_object('ok', true, 'rule_set_id', p_rule_set_id, 'approved_by', p_approved_by);
END $$;

COMMENT ON FUNCTION approve_rule_set IS 'Aprueba un draft rule set. Two-person rule: aprobador != creador. Manual: Engines_a_Escala:596.';

-- Promote: apunta canal+dominio+scope al rule set indicado (debe estar approved).
CREATE OR REPLACE FUNCTION promote_rule_set(
  p_rule_set_id  uuid,
  p_channel      text,
  p_domain       text,
  p_scope        jsonb DEFAULT '{}'::jsonb,
  p_rollout_pct  int   DEFAULT 100,
  p_activated_by text  DEFAULT 'admin',
  p_notes        text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_domain text;
BEGIN
  SELECT status, domain INTO v_status, v_domain
  FROM pricing_rule_sets WHERE id = p_rule_set_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'rule_set_not_found: %', p_rule_set_id;
  END IF;

  IF v_status <> 'approved' THEN
    RAISE EXCEPTION 'cannot_promote_unapproved: status=%', v_status;
  END IF;

  IF v_domain <> p_domain THEN
    RAISE EXCEPTION 'domain_mismatch: rule_set domain=% but pointer domain=%', v_domain, p_domain;
  END IF;

  INSERT INTO pricing_rule_set_pointers (
    channel, domain, scope, rule_set_id, rollout_pct, activated_by, notes
  ) VALUES (
    p_channel, p_domain, p_scope, p_rule_set_id, p_rollout_pct, p_activated_by, p_notes
  )
  ON CONFLICT (channel, domain, (scope::text)) DO UPDATE SET
    rule_set_id  = EXCLUDED.rule_set_id,
    rollout_pct  = EXCLUDED.rollout_pct,
    activated_at = now(),
    activated_by = EXCLUDED.activated_by,
    notes        = EXCLUDED.notes;

  RETURN jsonb_build_object('ok', true, 'channel', p_channel, 'domain', p_domain, 'rule_set_id', p_rule_set_id);
END $$;

COMMENT ON FUNCTION promote_rule_set IS 'Apunta un canal a un rule set aprobado. Solo aprueba si rule_set.status=approved y dominios coinciden.';

-- Append-only log de decisiones de pricing.
CREATE OR REPLACE FUNCTION log_pricing_decision(
  p_sku_origen    text,
  p_domain        text,
  p_rule_set_hash text,
  p_channel       text,
  p_inputs        jsonb,
  p_decision      jsonb,
  p_applied       boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO pricing_decision_log (
    sku_origen, domain, rule_set_hash, channel, inputs, decision, applied
  ) VALUES (
    p_sku_origen, p_domain, p_rule_set_hash, p_channel, p_inputs, p_decision, p_applied
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

COMMENT ON FUNCTION log_pricing_decision IS 'Append-only log de cada decision de pricing. Manual: Engines_a_Escala:209-223.';
