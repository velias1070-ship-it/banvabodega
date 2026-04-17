-- v52: forecast alerts (PR2/3)
-- 6 columnas nuevas en sku_intelligence para que la UI filtre/ordene sin joins.
-- Redundantes con forecast_accuracy, pero cacheadas en el upsert del motor.
-- NULL por default; se pueblan cuando hay fila en forecast_accuracy con
-- es_confiable=true (ventana 8s).

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS forecast_wmape_8s             numeric     NULL,
  ADD COLUMN IF NOT EXISTS forecast_bias_8s              numeric     NULL,
  ADD COLUMN IF NOT EXISTS forecast_tracking_signal_8s   numeric     NULL,
  ADD COLUMN IF NOT EXISTS forecast_semanas_evaluadas_8s int         NULL,
  ADD COLUMN IF NOT EXISTS forecast_es_confiable_8s      boolean     NULL,
  ADD COLUMN IF NOT EXISTS forecast_calculado_at         timestamptz NULL;

-- Índice parcial para el tab "Accuracy" de AdminInteligencia, que filtra
-- SKUs con |TS| > 4 sobre la última corrida confiable.
CREATE INDEX IF NOT EXISTS idx_sku_intel_forecast_ts
  ON sku_intelligence(forecast_tracking_signal_8s)
  WHERE forecast_es_confiable_8s = true;
