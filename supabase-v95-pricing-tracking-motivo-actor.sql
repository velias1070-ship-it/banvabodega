-- v95: Tracking de cambios de precio — motivo + actor + correlation_id
--
-- Manuales:
--   - BANVA_Pricing_Engines_a_Escala:80 (DoorDash: persist all metadata)
--   - BANVA_Pricing_Engines_a_Escala:211 (Stripe Ledger: append-only inmutable)
--   - BANVA_Pricing_Engines_a_Escala:217-225 (schema canónico decision_log)
--   - BANVA_Pricing_Engines_a_Escala:432 (reason text NOT NULL en queue)
--   - BANVA_Pricing_Operacion_Limpieza:87-89 (aprobado_por + motivo_trigger)
--   - BANVA_Pricing_Operacion_Limpieza:509 (regla #15: cada operación logueada
--     con motivo, aprobado_por, append-only)
--
-- Hoy todos los cambios manuales caen como ejecutado_por='admin_ui' sin distinguir:
--   1) admin aplicó sugerencia de Pulsos de velocidad (hipótesis)
--   2) admin ajustó margen desde tab Márgenes (operativo)
--   3) admin postuló bulk a un DEAL (operativo masivo)
--   4) ML obligó precio (UNHEALTHY/SMART/LIGHTNING)
--
-- El sistema de seguimiento (lift / sell-through) sólo aplica al caso 1. Sin
-- distinguir motivo, mezclamos métricas que no comparan, y Pulsos vuelve a
-- sugerir lo que ya se tocó por otra vía.
--
-- Esta migración agrega columnas tipadas para el motivo y actor, y un
-- correlation_id que vincula ml_price_history con pricing_decision_log.

-- ─────────────────────────────────────────────────────────────
-- 1) ml_price_history: motivo + actor + correlation_id
-- ─────────────────────────────────────────────────────────────

ALTER TABLE ml_price_history
  ADD COLUMN IF NOT EXISTS motivo TEXT
    CHECK (motivo IS NULL OR motivo IN (
      'senal_pulsos_velocidad',  -- 1: admin aplicó sugerencia detector velocidad
      'ajuste_margen_manual',    -- 2: admin tocó precio desde tab Márgenes
      'postular_evento',         -- 3: postulación a DEAL/SELLER_CAMPAIGN/etc
      'markdown_aging',          -- 4: cron 90/120/180d
      'ml_obliga_precio',        -- 5: UNHEALTHY/SMART/LIGHTNING/PRE_NEGOTIATED
      'revertir',                -- 6: subir precio post-evento
      'correccion_operativa',    -- 7: typo, ajuste de catálogo
      'sync_externo'             -- 8: cambio detectado externo (no decisión nuestra)
    )),
  ADD COLUMN IF NOT EXISTS motivo_detalle JSONB,
  -- actor: 'vicente' | 'raimundo' | 'auto' | 'agent_<nombre>' | 'ml'.
  -- Op_Limpieza:87 ejemplifica 'vicente | auto'. Multi-operador permite
  -- distinguir si vos vs Raimundo vs un cron tocaron el mismo SKU.
  ADD COLUMN IF NOT EXISTS actor TEXT,
  -- correlation_id: une el evento físico (ml_price_history) con la decisión
  -- lógica del motor (pricing_decision_log). Engines:217 lo llama request_id.
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

CREATE INDEX IF NOT EXISTS idx_mlph_motivo
  ON ml_price_history (motivo, detected_at DESC)
  WHERE motivo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mlph_correlation
  ON ml_price_history (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 2) pricing_decision_log: motivo + actor + request_id
-- ─────────────────────────────────────────────────────────────

ALTER TABLE pricing_decision_log
  ADD COLUMN IF NOT EXISTS motivo TEXT
    CHECK (motivo IS NULL OR motivo IN (
      'senal_pulsos_velocidad',
      'ajuste_margen_manual',
      'postular_evento',
      'markdown_aging',
      'ml_obliga_precio',
      'revertir',
      'correccion_operativa',
      'sync_externo'
    )),
  ADD COLUMN IF NOT EXISTS actor TEXT,
  ADD COLUMN IF NOT EXISTS request_id UUID;

CREATE INDEX IF NOT EXISTS idx_pdl_motivo
  ON pricing_decision_log (motivo, ts DESC)
  WHERE motivo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pdl_request
  ON pricing_decision_log (request_id)
  WHERE request_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 3) Backfill heurístico de motivo histórico (best-effort)
-- ─────────────────────────────────────────────────────────────
--
-- No podemos reconstruir el motivo perfecto retroactivamente, pero podemos
-- inferirlo de fuente + contexto en muchos casos:
--   - fuente='markdown_auto_pilot' → markdown_aging (claro)
--   - fuente='promo_join' Y contexto.promotion_type IN ('UNHEALTHY_STOCK',
--     'SMART','LIGHTNING','PRE_NEGOTIATED','PRICE_MATCHING') → ml_obliga_precio
--   - fuente='promo_join' Y contexto.promotion_type IN ('DEAL','MARKETPLACE_
--     CAMPAIGN','SELLER_CAMPAIGN') → postular_evento (confiable: estos son
--     eventos comerciales que el admin opta-in)
--   - fuente='promo_delete' → revertir
--   - fuente='sync_diff' o 'cron_margin_cache' → sync_externo (no fue decisión
--     nuestra, fue detección)
--   - resto manuales sin contexto suficiente: queda NULL, se irá tipando hacia
--     adelante cuando el frontend pase motivo.

UPDATE ml_price_history
SET motivo = CASE
  WHEN fuente = 'markdown_auto_pilot' THEN 'markdown_aging'
  WHEN fuente = 'promo_delete' THEN 'revertir'
  WHEN fuente IN ('sync_diff', 'cron_margin_cache') THEN 'sync_externo'
  WHEN fuente = 'promo_join' AND contexto->>'promotion_type' IN (
    'UNHEALTHY_STOCK','SMART','LIGHTNING','PRE_NEGOTIATED','PRICE_MATCHING'
  ) THEN 'ml_obliga_precio'
  WHEN fuente = 'promo_join' AND contexto->>'promotion_type' IN (
    'DEAL','MARKETPLACE_CAMPAIGN','SELLER_CAMPAIGN','DOD','VOLUME','SELLER_COUPON_CAMPAIGN'
  ) THEN 'postular_evento'
  ELSE NULL
END,
actor = CASE
  WHEN ejecutado_por LIKE 'cron_%' THEN 'auto'
  WHEN ejecutado_por = 'pilot_apply' THEN 'auto'
  WHEN ejecutado_por = 'admin_ui' THEN 'admin'  -- legado: no distinguíamos vicente/raimundo
  WHEN ejecutado_por IS NULL THEN 'desconocido'
  ELSE ejecutado_por
END
WHERE motivo IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 4) Vista para auditoría: cambios con motivo + decision asociada
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW pricing_changes_audit AS
SELECT
  h.id AS history_id,
  h.detected_at,
  h.sku,
  h.sku_origen,
  h.precio_anterior,
  h.precio,
  h.delta_pct,
  h.fuente,
  h.motivo,
  h.actor,
  h.ejecutado_por AS legacy_ejecutado_por,
  h.correlation_id,
  d.id AS decision_id,
  d.motivo AS decision_motivo,
  d.actor AS decision_actor,
  d.applied AS decision_applied,
  d.rule_set_hash AS decision_rule_set_hash,
  d.inputs AS decision_inputs,
  d.decision AS decision_decision,
  h.contexto AS history_contexto,
  h.motivo_detalle
FROM ml_price_history h
LEFT JOIN pricing_decision_log d ON d.request_id = h.correlation_id
ORDER BY h.detected_at DESC;

COMMENT ON VIEW pricing_changes_audit IS
  'Auditoría unificada: cada cambio de precio (ml_price_history) con su decision asociada (pricing_decision_log) vía correlation_id. Manuales: Engines:80,211; Op_Limpieza:509.';

COMMENT ON COLUMN ml_price_history.motivo IS
  'Taxonomía cerrada del MOTIVO del cambio. NULL = pre-v95 sin clasificar. Manual: Op_Limpieza:89 (motivo_trigger) + Engines:432 (reason text NOT NULL).';

COMMENT ON COLUMN ml_price_history.actor IS
  'Quien tomó la decisión: vicente | raimundo | admin | auto | agent_X | ml | desconocido. Manual: Op_Limpieza:87 (aprobado_por).';

COMMENT ON COLUMN ml_price_history.correlation_id IS
  'UUID que une este evento físico con la decision_log que lo justifica. Manual: Engines:217 (request_id).';
