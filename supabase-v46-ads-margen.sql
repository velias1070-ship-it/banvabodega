-- v46: Margen neto con costo de publicidad atribuido por venta individual.
--
-- Estrategia:
-- 1) Tabla cache ml_ads_daily_cache con data cruda del endpoint
--    /advertising/MLC/product_ads/ads/$ITEM_ID?aggregation_type=DAILY
--    Un registro por (item_id, date). cost_neto está SIN IVA (lo que ML entrega).
-- 2) Nuevas columnas en ventas_ml_cache para el costo atribuido y margen neto.
--    Se calculan al sync de la venta y quedan inmutables (snapshot contable).

-- ── 1. Cache diario de ads ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_ads_daily_cache (
  item_id         TEXT         NOT NULL,
  date            DATE         NOT NULL,
  cost_neto       INTEGER      NOT NULL DEFAULT 0,
  clicks          INTEGER      NOT NULL DEFAULT 0,
  prints          INTEGER      NOT NULL DEFAULT 0,
  direct_amount   INTEGER      NOT NULL DEFAULT 0,
  direct_units    INTEGER      NOT NULL DEFAULT 0,
  indirect_amount INTEGER      NOT NULL DEFAULT 0,
  indirect_units  INTEGER      NOT NULL DEFAULT 0,
  organic_amount  INTEGER      NOT NULL DEFAULT 0,
  organic_units   INTEGER      NOT NULL DEFAULT 0,
  total_amount    INTEGER      NOT NULL DEFAULT 0,
  acos            NUMERIC(6,2) NOT NULL DEFAULT 0,
  synced_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ml_ads_daily_date ON ml_ads_daily_cache(date);

ALTER TABLE ml_ads_daily_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ml_ads_daily_cache_all ON ml_ads_daily_cache;
CREATE POLICY ml_ads_daily_cache_all ON ml_ads_daily_cache FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE ml_ads_daily_cache IS
  'Cache del endpoint /advertising/MLC/product_ads/ads/{item}?aggregation_type=DAILY. cost_neto es SIN IVA.';
COMMENT ON COLUMN ml_ads_daily_cache.cost_neto IS 'Costo de publicidad del día, NETO (sin IVA). Multiplicar ×1.19 para comparar con ingresos.';

-- ── 2. Columnas nuevas en ventas_ml_cache ──────────────────────────────
ALTER TABLE ventas_ml_cache
  ADD COLUMN IF NOT EXISTS ads_cost_asignado INTEGER,
  ADD COLUMN IF NOT EXISTS ads_atribucion    TEXT,
  ADD COLUMN IF NOT EXISTS margen_neto       INTEGER,
  ADD COLUMN IF NOT EXISTS margen_neto_pct   NUMERIC(6,2);

CREATE INDEX IF NOT EXISTS idx_ventas_ads_atribucion ON ventas_ml_cache(ads_atribucion);

COMMENT ON COLUMN ventas_ml_cache.ads_cost_asignado IS
  'Costo de publicidad atribuido a esta venta (con IVA). Snapshot inmutable.';
COMMENT ON COLUMN ventas_ml_cache.ads_atribucion IS
  'direct | organic | sin_datos — según ML en ml_ads_daily_cache';
COMMENT ON COLUMN ventas_ml_cache.margen_neto IS
  'margen − ads_cost_asignado. Margen después de publicidad.';
