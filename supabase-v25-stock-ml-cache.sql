-- v25: Cache de stock ML en ml_items_map para carga instantánea
-- Agrega columnas para guardar último stock leído de ML (Flex + Full)
-- Se actualiza cada vez que se consulta ML o se sincroniza stock.

ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS stock_flex_cache integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS stock_full_cache integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS cache_updated_at timestamptz;
