-- v112: cache last_location_types para detección proactiva de SKUs sin Flex
--
-- Contexto: hoy descubrimos 22 SKUs activos con stock físico cuyo slot
-- seller_warehouse (Flex) fue desactivado por ML silenciosamente. El cron
-- activate-warehouse-all solo buscaba SKUs nuevos (ultimo_sync IS NULL),
-- ignorando los que tuvieron Flex y lo perdieron.
--
-- Diseño:
--   1. Columna ml_items_map.last_location_types text[] — cachea los tipos
--      de location (seller_warehouse, meli_facility, ...) que devolvió el
--      último GET /user-products/{up}/stock.
--   2. Poblada automáticamente por syncStockToML (corre por SKU en push
--      de stock Flex). Cada vez que se hace GET para obtener x-version,
--      aprovechamos para guardar los tipos visibles.
--   3. Index GIN para permitir filtros eficientes con ARRAY operators
--      (cs/contains, NOT cs).
--   4. Usado por activate-warehouse-all para detectar la categoría
--      "perdió Flex": last_location_types NO contiene 'seller_warehouse'.

ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS last_location_types text[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS ml_items_last_loc_types_idx
  ON ml_items_map USING GIN(last_location_types);

COMMENT ON COLUMN ml_items_map.last_location_types IS
  'Cache de location types (seller_warehouse, meli_facility, ...) retornados por GET /user-products/{up}/stock. Poblado por syncStockFull cada 30 min. Usado por activate-warehouse-all para detectar SKUs que perdieron Flex.';
