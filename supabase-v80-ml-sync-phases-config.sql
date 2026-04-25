-- v80: ml_sync_phases_config + ml_sync_config_history + phase_status JSONB
--
-- Cadencias diferenciadas por fase del cron metrics-sync (en lugar de gating
-- "días 1-3 del mes" que generaba staleness 19d). Permite cambiar cadencia
-- en runtime sin redeploy + auditoría de cambios.
--
-- Origen: docs/auditorias/banva-bodega-pr-ads-pipeline-preauditoria.md (Fase 4 implícita)
-- + análisis #19a (volumen ~44K calls/mes vs ~579K si se sacara gating en seco)

-- ───────────── 1. Config principal ─────────────
CREATE TABLE IF NOT EXISTS ml_sync_phases_config (
  fase TEXT PRIMARY KEY,
  cadencia_horas INT NOT NULL,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Validación a nivel app: mínimos por fase para evitar saturar rate limit ML
  -- visits/questions/aggregate: 6h mín (fases pesadas, ~622 items × 1 req)
  -- reviews/quality/reputation: 24h mín (cambian lento o son irrelevantes)
  -- ads: ya migrada a campaigns-daily-sync, no se gestiona acá
  cadencia_min_horas INT NOT NULL DEFAULT 24,
  cadencia_max_horas INT NOT NULL DEFAULT 720,
  notes TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ml_sync_phases_config (fase, cadencia_horas, cadencia_min_horas, cadencia_max_horas, notes) VALUES
  ('visits',     24,  6, 720, 'diaria — alimenta semáforo y motor reposición'),
  ('questions',  24,  6, 720, 'diaria — preguntas ML rotan rápido'),
  ('aggregate',  24,  6, 720, 'diaria — paginado de orders, ~30 calls/corrida'),
  ('reviews',   120, 24, 720, 'cada 5 días — cambian lento'),
  ('quality',   168, 24, 720, 'semanal — endpoint /health da 404 para MLC, irrelevante hoy'),
  ('reputation',168, 24, 720, 'semanal — vendedor-level, 1 call por corrida')
ON CONFLICT (fase) DO NOTHING;

ALTER TABLE ml_sync_phases_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_sync_phases_config;
CREATE POLICY "permissive" ON ml_sync_phases_config USING (true) WITH CHECK (true);

-- ───────────── 2. Audit log de cambios ─────────────
CREATE TABLE IF NOT EXISTS ml_sync_config_history (
  id BIGSERIAL PRIMARY KEY,
  fase TEXT NOT NULL,
  field TEXT NOT NULL,           -- 'cadencia_horas' | 'active' | 'notes' | etc.
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  reason TEXT,                   -- requerido en payload del endpoint
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_config_history_fase
  ON ml_sync_config_history(fase, changed_at DESC);

ALTER TABLE ml_sync_config_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_sync_config_history;
CREATE POLICY "permissive" ON ml_sync_config_history USING (true) WITH CHECK (true);

-- ───────────── 3. Telemetría per-fase en ml_sync_health ─────────────
-- JSONB con shape: {visits:{last_run,last_success,error}, questions:{...}, ...}
ALTER TABLE ml_sync_health
  ADD COLUMN IF NOT EXISTS phase_status JSONB NOT NULL DEFAULT '{}'::jsonb;
