-- v48: Cache de márgenes por ítem ML para la vista "Márgenes" del panel Comercial.
--
-- 1 fila por item_id. Se refresca vía /api/ml/margin-cache/refresh.
-- Usa la tabla ml_shipping_tariffs (v47) vía la función calcular_costo_envio_ml().

CREATE TABLE IF NOT EXISTS ml_margin_cache (
  item_id          TEXT        NOT NULL PRIMARY KEY,
  sku              TEXT        NOT NULL,
  titulo           TEXT        NOT NULL DEFAULT '',
  category_id      TEXT,
  listing_type     TEXT,
  logistic_type    TEXT,                                      -- fulfillment, self_service, drop_off, etc.

  -- Precios
  price_ml         INTEGER     NOT NULL DEFAULT 0,            -- precio lista
  precio_venta     INTEGER     NOT NULL DEFAULT 0,            -- efectivo con promo activa
  tiene_promo      BOOLEAN     NOT NULL DEFAULT false,
  promo_type       TEXT,
  promo_pct        INTEGER,                                    -- % de descuento

  -- Costos del producto
  costo_neto       INTEGER     NOT NULL DEFAULT 0,
  costo_bruto      INTEGER     NOT NULL DEFAULT 0,

  -- Envío
  peso_fisico_gr   INTEGER,
  peso_facturable  INTEGER     NOT NULL DEFAULT 0,
  tramo_label      TEXT,

  -- Comisión y envío en CLP
  comision_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,
  comision_clp     INTEGER     NOT NULL DEFAULT 0,
  envio_clp        INTEGER     NOT NULL DEFAULT 0,

  -- Margen resultante (sobre precio_venta)
  margen_clp       INTEGER     NOT NULL DEFAULT 0,
  margen_pct       NUMERIC(6,2) NOT NULL DEFAULT 0,

  -- Clasificación
  zona             TEXT,                                       -- 'barato' | 'medio' | 'caro'

  -- Auditoría
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sync_error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_margin_cache_sku        ON ml_margin_cache(sku);
CREATE INDEX IF NOT EXISTS idx_ml_margin_cache_margen_pct ON ml_margin_cache(margen_pct);
CREATE INDEX IF NOT EXISTS idx_ml_margin_cache_zona       ON ml_margin_cache(zona);
CREATE INDEX IF NOT EXISTS idx_ml_margin_cache_synced     ON ml_margin_cache(synced_at);

ALTER TABLE ml_margin_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ml_margin_cache_all ON ml_margin_cache;
CREATE POLICY ml_margin_cache_all ON ml_margin_cache FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE ml_margin_cache IS
  'Snapshot de margen por item ML. Se refresca vía /api/ml/margin-cache/refresh. Usa las tarifas oficiales ML de v47.';
COMMENT ON COLUMN ml_margin_cache.precio_venta IS 'Precio efectivo de venta (con promo activa aplicada). Igual a price_ml si no hay promo.';
COMMENT ON COLUMN ml_margin_cache.peso_facturable IS 'Peso facturable en gramos (mayor entre físico y volumétrico) reportado por ML en /shipping_options/free.';
COMMENT ON COLUMN ml_margin_cache.zona IS '"barato" (<$9.990), "medio" ($9.990-$19.989), "caro" (>=$19.990)';
