-- ============================================
-- BANVA BODEGA — v68: columnas de política de pricing en productos
--
-- Inputs necesarios para el motor de postulación automática:
-- - es_kvi: Key Value Item, defiende precio
-- - margen_minimo_pct: floor de margen neto post-ads
-- - politica_pricing: postura comercial del SKU
-- - precio_piso: override manual del floor calculado
-- - auto_postular: flag on/off, default false (opt-in explícito)
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS es_kvi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS margen_minimo_pct NUMERIC NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS politica_pricing TEXT NOT NULL DEFAULT 'seguir',
  ADD COLUMN IF NOT EXISTS precio_piso NUMERIC,
  ADD COLUMN IF NOT EXISTS auto_postular BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE productos
  DROP CONSTRAINT IF EXISTS productos_politica_pricing_check;
ALTER TABLE productos
  ADD CONSTRAINT productos_politica_pricing_check
  CHECK (politica_pricing IN ('defender', 'seguir', 'exprimir', 'liquidar'));

COMMENT ON COLUMN productos.es_kvi IS 'Key Value Item: SKU cuyo precio el cliente conoce y compara.';
COMMENT ON COLUMN productos.margen_minimo_pct IS 'Margen neto mínimo post-ads para postular a campañas. Default 15%.';
COMMENT ON COLUMN productos.politica_pricing IS 'Postura comercial: defender/seguir/exprimir/liquidar.';
COMMENT ON COLUMN productos.precio_piso IS 'Precio mínimo absoluto CLP. NULL = usar floor matemático.';
COMMENT ON COLUMN productos.auto_postular IS 'Flag on/off para autorizar postulación automática. Opt-in explícito.';

-- ============================================
-- FIN v68
-- ============================================
