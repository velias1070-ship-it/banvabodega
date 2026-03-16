-- BANVA WMS — v19: Agregar sku_origen a ml_items_map
-- ============================================
-- ml_items_map es la tabla de canal MercadoLibre.
-- Se agrega sku_origen para facilitar el cruce directo:
--   productos.sku = composicion_venta.sku_origen = ml_items_map.sku_origen
--   composicion_venta.sku_venta = ml_items_map.sku_venta
-- ============================================

-- 1. Agregar columna sku_origen
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS sku_origen text;

-- 2. Llenar sku_origen desde composicion_venta (cruce por sku_venta)
UPDATE ml_items_map m
SET sku_origen = cv.sku_origen
FROM composicion_venta cv
WHERE UPPER(m.sku_venta) = UPPER(cv.sku_venta)
  AND m.sku_venta IS NOT NULL;

-- 3. Índice para búsquedas por sku_origen
CREATE INDEX IF NOT EXISTS idx_ml_items_sku_origen ON ml_items_map(sku_origen);
