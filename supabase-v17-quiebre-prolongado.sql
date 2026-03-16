-- ============================================
-- BANVA WMS — v17: Protección de productos estrella en quiebre prolongado
-- ============================================
-- Nuevas columnas en sku_intelligence para tracking de quiebres prolongados

ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS vel_pre_quiebre numeric DEFAULT 0;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS dias_en_quiebre integer DEFAULT 0;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS es_quiebre_proveedor boolean DEFAULT false;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS abc_pre_quiebre text;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS gmroi_potencial numeric DEFAULT 0;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS es_catch_up boolean DEFAULT false;
