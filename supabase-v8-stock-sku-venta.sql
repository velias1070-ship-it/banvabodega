-- v8: Stock por SKU venta
-- Agrega sku_venta al stock para rastrear formato de etiquetado (individual, pack, sin etiquetar)

-- 1. Agregar columna sku_venta (nullable, NULL = sin etiquetar / legacy)
ALTER TABLE stock ADD COLUMN IF NOT EXISTS sku_venta text DEFAULT NULL;

-- 2. Crear columna generada para manejar NULL en unique constraint
-- PostgreSQL no trata NULL=NULL como duplicado en UNIQUE, así que usamos una columna generada
ALTER TABLE stock ADD COLUMN IF NOT EXISTS sku_venta_key text GENERATED ALWAYS AS (COALESCE(sku_venta, '')) STORED;

-- 3. Eliminar constraint anterior y crear nueva
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_sku_posicion_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS stock_sku_skuventa_posicion_idx ON stock(sku, sku_venta_key, posicion_id);

-- 4. Índice para búsquedas por sku_venta
CREATE INDEX IF NOT EXISTS idx_stock_sku_venta ON stock(sku_venta) WHERE sku_venta IS NOT NULL;

-- 5. Actualizar función update_stock para soportar sku_venta
CREATE OR REPLACE FUNCTION update_stock(p_sku text, p_posicion text, p_delta integer, p_sku_venta text DEFAULT NULL)
RETURNS void AS $$
BEGIN
  INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
  VALUES (p_sku, p_posicion, GREATEST(0, p_delta), p_sku_venta, now())
  ON CONFLICT (sku, sku_venta_key, posicion_id)
  DO UPDATE SET
    cantidad = GREATEST(0, stock.cantidad + p_delta),
    updated_at = now();

  -- Limpiar filas con cantidad 0
  DELETE FROM stock
  WHERE sku = p_sku
    AND posicion_id = p_posicion
    AND COALESCE(sku_venta, '') = COALESCE(p_sku_venta, '')
    AND cantidad = 0;
END;
$$ LANGUAGE plpgsql;

-- 6. Actualizar función stock_total (suma todo independiente de sku_venta)
CREATE OR REPLACE FUNCTION stock_total(p_sku text)
RETURNS integer AS $$
  SELECT COALESCE(SUM(cantidad), 0)::integer FROM stock WHERE sku = p_sku;
$$ LANGUAGE sql STABLE;
