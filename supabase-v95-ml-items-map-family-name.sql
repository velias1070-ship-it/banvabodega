-- v95: family_name canónico de ML en ml_items_map
-- Permite agrupar publicaciones por la ficha catálogo de ML en vez del
-- heurístico "quitar última palabra del título" que separa en grupos
-- distintos a variantes con sufijos de 1 vs 2 palabras (ej: "Papua" vs
-- "Adel Gris"). Poblado por /api/ml/items-sync.

ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS family_name text;
CREATE INDEX IF NOT EXISTS ml_items_map_family_name_idx ON ml_items_map (family_name) WHERE family_name IS NOT NULL;
COMMENT ON COLUMN ml_items_map.family_name IS 'Family name canónico de ML (cuando el item esta vinculado a ficha catálogo). Poblado por /api/ml/items-sync.';
