-- ============================================================
-- v5: Add line-level locking for operator concurrency control
-- ============================================================

-- New columns for optimistic locking on recepcion_lineas
ALTER TABLE recepcion_lineas
  ADD COLUMN IF NOT EXISTS bloqueado_por text,
  ADD COLUMN IF NOT EXISTS bloqueado_hasta timestamptz;

-- Index for quick lookups of locked lines
CREATE INDEX IF NOT EXISTS idx_lineas_bloqueado ON recepcion_lineas(bloqueado_por) WHERE bloqueado_por IS NOT NULL;
