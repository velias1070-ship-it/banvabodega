-- v73: ml_price_history
-- Registro append-only de cambios de precio publicado en ML por item.
-- Precondicion del repricer competitivo (BANVA_Pricing_Investigacion_Comparada §6.4 +
-- BANVA_Pricing_Ajuste_Plan §3 "Automatizacion Acotada"): sin historico bidireccional
-- WMS<->ML el repricer es una receta para race-to-the-bottom (caso Thrasio).
--
-- Writers (en codigo):
--   sync_diff       -> /api/ml/margin-cache/refresh detecta cambio externo (ML aplico
--                      promo, cerro promo, dynamic pricing, edicion manual desde web ML)
--   item_update_api -> /api/ml/item-update (cambio de precio explicito desde el WMS)
--   promo_join      -> /api/ml/promotions joinea promo con deal_price
--   promo_delete    -> /api/ml/promotions saca promo, vuelve a precio lista
--   manual_admin    -> reservado para edicion directa de productos.precio (si se
--                      activa el flujo, hoy esta huerfano)
--   snapshot_diario -> cron de fallback para mantener serie continua si nadie loguea
--
-- Inmunidad a errores silenciosos (inventory-policy.md regla 3):
--   - error log explicito en cada writer
--   - delta_pct = NULL cuando no hay precio_anterior (no centinela 0)

CREATE TABLE IF NOT EXISTS ml_price_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         text NOT NULL,
  sku             text,
  sku_origen      text,
  precio          numeric NOT NULL,
  precio_lista    numeric,
  promo_pct       numeric,
  promo_name      text,
  precio_anterior numeric,
  delta_pct       numeric,
  fuente          text NOT NULL CHECK (fuente IN (
    'sync_diff','item_update_api','promo_join','promo_delete','snapshot_diario','manual_admin'
  )),
  ejecutado_por   text,
  contexto        jsonb,
  detected_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ml_price_history_item_ts
  ON ml_price_history(item_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS ix_ml_price_history_sku_origen_ts
  ON ml_price_history(sku_origen, detected_at DESC);

CREATE INDEX IF NOT EXISTS ix_ml_price_history_fuente_ts
  ON ml_price_history(fuente, detected_at DESC);

ALTER TABLE ml_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ml_price_history_select_all" ON ml_price_history
  FOR SELECT USING (true);

CREATE POLICY "ml_price_history_insert_all" ON ml_price_history
  FOR INSERT WITH CHECK (true);

-- Vista derivada: precio minimo 30d por item (regla 30-day-lowest SERNAC).
CREATE OR REPLACE VIEW v_precio_lowest_30d AS
SELECT
  item_id,
  MIN(precio)             AS precio_min_30d,
  MAX(precio)             AS precio_max_30d,
  COUNT(*)                AS cambios_30d,
  MAX(detected_at)        AS ultimo_cambio
FROM ml_price_history
WHERE detected_at >= now() - interval '30 days'
GROUP BY item_id;

COMMENT ON TABLE  ml_price_history IS 'Append-only: cambios de precio publicado en ML por item. Precondicion del repricer competitivo (manuales pricing).';
COMMENT ON COLUMN ml_price_history.fuente IS 'Origen del registro: sync_diff (cron detecta cambio externo), item_update_api (PUT manual), promo_join, promo_delete, snapshot_diario, manual_admin';
COMMENT ON COLUMN ml_price_history.delta_pct IS 'Variacion % vs precio_anterior. NULL si es primer registro del item (no centinela 0).';
COMMENT ON VIEW   v_precio_lowest_30d IS 'Habilita regla 30-day-lowest SERNAC y gate de cooldown del repricer.';
