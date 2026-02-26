-- ==============================================
-- BANVA WMS — Migración Diccionario de Ventas
-- Ejecutar en: Supabase → SQL Editor → New query
-- ==============================================

-- 1. Agregar campos nuevos a productos (si no existen)
ALTER TABLE productos ADD COLUMN IF NOT EXISTS tamano text DEFAULT '';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS color text DEFAULT '';

-- 2. Tabla de composición de ventas (packs/combos)
-- Mapea: SKU Venta (lo que vende ML) → componentes físicos (sku_origen + unidades)
CREATE TABLE IF NOT EXISTS composicion_venta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_venta text NOT NULL,
  codigo_ml text DEFAULT '',
  sku_origen text NOT NULL REFERENCES productos(sku) ON DELETE CASCADE,
  unidades integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(sku_venta, sku_origen)
);

CREATE INDEX IF NOT EXISTS idx_composicion_sku_venta ON composicion_venta(sku_venta);
CREATE INDEX IF NOT EXISTS idx_composicion_sku_origen ON composicion_venta(sku_origen);
CREATE INDEX IF NOT EXISTS idx_composicion_codigo_ml ON composicion_venta(codigo_ml);

-- 3. RLS policies
ALTER TABLE composicion_venta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "composicion_select" ON composicion_venta FOR SELECT USING (true);
CREATE POLICY "composicion_insert" ON composicion_venta FOR INSERT WITH CHECK (true);
CREATE POLICY "composicion_update" ON composicion_venta FOR UPDATE USING (true);
CREATE POLICY "composicion_delete" ON composicion_venta FOR DELETE USING (true);

-- 4. Vista útil: dado un codigo_ml, qué SKUs físicos necesito sacar
-- Ejemplo: SELECT * FROM vista_venta WHERE codigo_ml = 'MLC123456';
CREATE OR REPLACE VIEW vista_venta AS
SELECT
  cv.sku_venta,
  cv.codigo_ml,
  cv.sku_origen,
  cv.unidades,
  p.nombre,
  p.proveedor,
  p.tamano,
  p.color,
  p.categoria
FROM composicion_venta cv
JOIN productos p ON p.sku = cv.sku_origen;
