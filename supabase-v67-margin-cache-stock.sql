-- ============================================
-- BANVA BODEGA — v67: stock_total en ml_margin_cache
--
-- Se agrega el stock total (bodega + ML Full) al cache de Márgenes para
-- pre-validar restricciones de stock de ciertas promos (ej. LIGHTNING
-- exige 5-15 unidades) antes de mandar el request a ML.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

ALTER TABLE ml_margin_cache
ADD COLUMN IF NOT EXISTS stock_total INTEGER;

-- Backfill
WITH stock_bodega AS (
  SELECT s.sku, SUM(s.cantidad)::int AS qty
  FROM stock s
  GROUP BY s.sku
),
stock_full AS (
  SELECT
    COALESCE(cv.sku_origen, sfc.sku_venta) AS sku,
    SUM(sfc.cantidad)::int AS qty
  FROM stock_full_cache sfc
  LEFT JOIN composicion_venta cv ON cv.sku_venta = sfc.sku_venta
  GROUP BY 1
),
combined AS (
  SELECT
    COALESCE(sb.sku, sf.sku) AS sku,
    COALESCE(sb.qty, 0) + COALESCE(sf.qty, 0) AS total
  FROM stock_bodega sb
  FULL OUTER JOIN stock_full sf ON sf.sku = sb.sku
)
UPDATE ml_margin_cache mc
SET stock_total = c.total
FROM combined c
WHERE mc.sku = c.sku;

-- ============================================
-- FIN v67
-- ============================================
