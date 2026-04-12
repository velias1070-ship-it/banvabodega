-- v45: Margen por venta individual en ventas_ml_cache
-- Principio: inmutabilidad contable. El costo se captura AL MOMENTO del sync
-- de la orden y no se recalcula después. Backfill histórico se marca explícitamente.

ALTER TABLE ventas_ml_cache
  ADD COLUMN IF NOT EXISTS costo_producto INTEGER,
  ADD COLUMN IF NOT EXISTS margen INTEGER,
  ADD COLUMN IF NOT EXISTS margen_pct NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS costo_fuente TEXT,
  ADD COLUMN IF NOT EXISTS costo_snapshot_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS anulada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS anulada_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ventas_costo_fuente ON ventas_ml_cache(costo_fuente);
CREATE INDEX IF NOT EXISTS idx_ventas_anulada ON ventas_ml_cache(anulada) WHERE anulada = FALSE;

COMMENT ON COLUMN ventas_ml_cache.costo_producto IS
  'COGS al momento del sync de la orden, con IVA. Inmutable una vez escrito.';
COMMENT ON COLUMN ventas_ml_cache.costo_fuente IS
  'promedio | catalogo | sin_costo | backfill_estimado';
COMMENT ON COLUMN ventas_ml_cache.margen IS
  'total_neto - costo_producto, congelado al momento del sync';
COMMENT ON COLUMN ventas_ml_cache.anulada IS
  'TRUE si ML cambió estado a cancelled despues del sync. El margen original queda intacto, pero las queries de totales deben filtrar por anulada=false.';
