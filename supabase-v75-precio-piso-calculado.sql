-- v75: persistir precio_piso_calculado en productos
-- Repricer interno (banvabodega no usa Ajuste Auto ML — 0 SKUs con
-- catalog_listing=true) requiere un piso concreto por SKU, no una formula
-- on-demand. Cron diario lee inputs reales (ml_margin_cache, costos,
-- pricing_cuadrante_config) y persiste el resultado de calcularFloor().
--
-- Manual: BANVA_Pricing_Investigacion_Comparada §6.2 ("reglas deterministicas
-- en el WMS") + Inv_P3 §10. Caso Anker §5.3 (productos diferenciados sin
-- catalogo competitivo, repricer basado en costo + margen interno).

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS precio_piso_calculado        numeric,
  ADD COLUMN IF NOT EXISTS precio_piso_calculado_at     timestamptz,
  ADD COLUMN IF NOT EXISTS precio_piso_calculado_inputs jsonb;

COMMENT ON COLUMN productos.precio_piso_calculado IS
  'Piso matematico calculado por pricing.ts/calcularFloor() para el listing principal del SKU. Repoblado diario por /api/pricing/recalcular-floors.';
COMMENT ON COLUMN productos.precio_piso_calculado_at IS
  'Timestamp del ultimo recalculo. Si > 48h sin actualizar, considerar stale.';
COMMENT ON COLUMN productos.precio_piso_calculado_inputs IS
  'JSONB con inputs usados (costo, comision, envio, ads_obj, margen_min, fuente cuadrante) y desglose. Auditoria + UI tooltip.';
