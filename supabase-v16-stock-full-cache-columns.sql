-- ============================================
-- BANVA WMS — v16: Columnas adicionales en stock_full_cache
-- ============================================
-- Agrega nombre y vel_promedio para enriquecer el cache de stock Full

ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS nombre text;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS vel_promedio numeric DEFAULT 0;
