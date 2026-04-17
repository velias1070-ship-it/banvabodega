-- v53: TSB shadow mode (PR3 Fase A)
-- Shadow: el motor POPULA estos campos pero NO los consume. Fase C decide
-- si el modelo TSB reemplaza al SMA ponderado para Z maduro. Ver doc
-- banva-bodega-tsb-pr3-fase-a.md.

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS vel_ponderada_tsb      numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_alpha              numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_beta               numeric NULL,
  ADD COLUMN IF NOT EXISTS tsb_modelo_usado       text    NULL CHECK (tsb_modelo_usado IN ('sma_ponderado','tsb')),
  ADD COLUMN IF NOT EXISTS primera_venta          date    NULL,
  ADD COLUMN IF NOT EXISTS dias_desde_primera_venta int   NULL;

-- Índice para el benchmark ofensiva de Fase B (comparar SMA vs TSB sobre Z).
CREATE INDEX IF NOT EXISTS idx_sku_intel_tsb_modelo
  ON sku_intelligence(tsb_modelo_usado)
  WHERE tsb_modelo_usado IS NOT NULL;
