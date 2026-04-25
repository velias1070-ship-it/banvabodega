-- v76: vista v_precio_piso_actual sobre auto_postulacion_log
-- Reemplaza el plan v75 (3 columnas en productos) que tenía 3 problemas:
--   - sin histórico (sobrescribía cada día)
--   - sin granularidad por canal
--   - mezclaba atributos del SKU con cálculos derivados
--
-- Reuse-first (CLAUDE.md regla): auto_postulacion_log ya guarda floor_calculado
-- + contexto JSONB con desglose en cada evaluación del motor. 174 SKUs ya
-- tienen el dato (40% del catálogo) sin haber escrito una línea más.
--
-- Manual: inventory-policy.md Regla 5 (no duplicar fuente). El cron diario
-- /api/pricing/recalcular-floors cubre los SKUs sin promos a evaluar
-- (insertando filas con decision='baseline_warming').

ALTER TABLE productos
  DROP COLUMN IF EXISTS precio_piso_calculado,
  DROP COLUMN IF EXISTS precio_piso_calculado_at,
  DROP COLUMN IF EXISTS precio_piso_calculado_inputs;

CREATE OR REPLACE VIEW v_precio_piso_actual AS
SELECT DISTINCT ON (sku)
  sku,
  item_id,
  floor_calculado AS precio_piso_calculado,
  precio_actual,
  precio_objetivo AS precio_promo_evaluado,
  margen_proyectado_pct,
  decision,
  promo_name,
  contexto,
  fecha AS calculado_at
FROM auto_postulacion_log
WHERE floor_calculado IS NOT NULL AND floor_calculado > 0
ORDER BY sku, fecha DESC;

COMMENT ON VIEW v_precio_piso_actual IS
  'Último floor calculado por SKU. Fuente: auto_postulacion_log (cada evaluación del motor lo registra). Si decision = baseline_warming es del cron de pricing-floors. Si no, es de evaluación real de una promo.';
