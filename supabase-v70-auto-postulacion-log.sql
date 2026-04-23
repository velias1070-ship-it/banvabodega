-- ============================================
-- BANVA BODEGA — v70: tabla auto_postulacion_log
--
-- Auditoría de cada decisión del motor de postulación automática.
-- Se loguea TODO (postular, skipear, error) para debug y aprendizaje.
-- Empieza en modo dry_run; pasa a apply cuando el usuario confirma.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

CREATE TABLE IF NOT EXISTS auto_postulacion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
  sku TEXT NOT NULL,
  item_id TEXT,
  promo_id TEXT,
  promo_type TEXT,
  promo_name TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('postular', 'skipear', 'error', 'dry_run_postular', 'dry_run_skipear')),
  motivo TEXT NOT NULL,
  precio_objetivo INTEGER,
  precio_actual INTEGER,
  floor_calculado INTEGER,
  margen_proyectado_pct NUMERIC,
  modo TEXT NOT NULL DEFAULT 'dry_run' CHECK (modo IN ('dry_run', 'apply')),
  contexto JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_auto_postulacion_log_fecha ON auto_postulacion_log(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_auto_postulacion_log_sku ON auto_postulacion_log(sku);
CREATE INDEX IF NOT EXISTS idx_auto_postulacion_log_decision ON auto_postulacion_log(decision);

ALTER TABLE auto_postulacion_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auto_postulacion_log_all ON auto_postulacion_log;
CREATE POLICY auto_postulacion_log_all ON auto_postulacion_log FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- FIN v70
-- ============================================
