-- v22: Soporte para SKU Origen alternativos en composicion_venta
-- Ejecutar en Supabase SQL Editor
--
-- Un SKU Venta puede tener múltiples SKU Origen que son el mismo producto
-- de distintas fuentes (proveedores, formatos). No es un combo — es uno u otro.
--
-- tipo_relacion:
--   'componente'  (default) — Es parte del producto. Se necesitan TODOS los componentes.
--   'alternativo' — Es un origen sustituto. Se usa UNO de los alternativos si el principal no alcanza.

ALTER TABLE composicion_venta
  ADD COLUMN IF NOT EXISTS tipo_relacion text DEFAULT 'componente';

-- Constraint para valores válidos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'composicion_venta_tipo_relacion_check'
  ) THEN
    ALTER TABLE composicion_venta
      ADD CONSTRAINT composicion_venta_tipo_relacion_check
      CHECK (tipo_relacion IN ('componente', 'alternativo'));
  END IF;
END $$;

-- Índice para queries filtradas por tipo_relacion
CREATE INDEX IF NOT EXISTS idx_composicion_tipo_relacion
  ON composicion_venta(sku_venta, tipo_relacion);
