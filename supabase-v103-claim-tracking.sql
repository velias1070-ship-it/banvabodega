-- v103 — Tracking de claims contra proveedor (Chunk 7 LITE, 2026-05-06)
--
-- Cuando aprobás una disc con costo_aprobado < costo_factura, queda un
-- claim implícito (proveedor te debe NC por la diferencia). Hoy ese
-- claim se pierde si la disc queda APROBADA antes de que llegue la NC
-- del SII.
--
-- Datos del análisis 2026-05-06: <5 casos/año en producción, ROI bajo
-- justifica solución LITE (no tabla nueva, solo columnas en disc).
--
-- IDEMPOTENTE: usa IF NOT EXISTS / DO blocks.

-- ============================================================================
-- 1. Columnas en discrepancias_costo
-- ============================================================================

ALTER TABLE discrepancias_costo
  ADD COLUMN IF NOT EXISTS claim_monto_pendiente numeric,
  ADD COLUMN IF NOT EXISTS claim_estado text,
  ADD COLUMN IF NOT EXISTS claim_resuelto_por_nc_id uuid;

-- Constraint del estado (drop + add para idempotencia)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'discrepancias_costo'
      AND constraint_name = 'discrepancias_costo_claim_estado_check'
  ) THEN
    ALTER TABLE discrepancias_costo
      ADD CONSTRAINT discrepancias_costo_claim_estado_check
      CHECK (claim_estado IS NULL OR claim_estado IN ('ESPERANDO_NC','RESUELTO_CON_NC','DESCARTADO'));
  END IF;
END$$;

-- FK opcional a rcv_compras (la NC que resolvió el claim)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'discrepancias_costo'
      AND constraint_name = 'discrepancias_costo_claim_nc_fkey'
  ) THEN
    ALTER TABLE discrepancias_costo
      ADD CONSTRAINT discrepancias_costo_claim_nc_fkey
      FOREIGN KEY (claim_resuelto_por_nc_id) REFERENCES rcv_compras(id)
      ON DELETE SET NULL;
  END IF;
END$$;

-- ============================================================================
-- 2. Index para query "claims abiertos"
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_disc_claim_esperando
  ON discrepancias_costo (claim_estado, created_at DESC)
  WHERE claim_estado = 'ESPERANDO_NC';

-- ============================================================================
-- 3. Comentarios
-- ============================================================================

COMMENT ON COLUMN discrepancias_costo.claim_monto_pendiente IS
  'Monto en CLP que el proveedor debe vía NC. Se popula al aprobar una disc con nuevoCosto < costo_factura. Calculado como (costo_factura - nuevoCosto) * qty_recibida. Chunk 7 LITE.';

COMMENT ON COLUMN discrepancias_costo.claim_estado IS
  'Lifecycle del claim: ESPERANDO_NC | RESUELTO_CON_NC | DESCARTADO. Default NULL (no hay claim).';

COMMENT ON COLUMN discrepancias_costo.claim_resuelto_por_nc_id IS
  'FK a rcv_compras.id de la NC que cerró este claim. Populado por cross-match en AdminDiscrepancias.';
