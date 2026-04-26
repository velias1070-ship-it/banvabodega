-- v78: dimensión 'canal' en motor de pricing
-- Antes el motor era ML-céntrico (mezcla regla + aplicación). Agregamos
-- campo canal en auto_postulacion_log + recreamos vista con esa dimensión.
-- Hoy todo es 'ml'; cuando se agregue Falabella/D2C basta con nuevo valor.
--
-- Conceptual:
--   CAPA 1 (regla SKU)    — productos.* + pricing_cuadrante_config (sin canal)
--   CAPA 2 (canal venta)  — auto_postulacion_log.canal + pricing_canales (futuro)

ALTER TABLE auto_postulacion_log
  ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'ml';

CREATE INDEX IF NOT EXISTS ix_auto_post_log_canal_sku
  ON auto_postulacion_log(canal, sku, fecha DESC);

DROP VIEW IF EXISTS v_precio_piso_actual;

CREATE VIEW v_precio_piso_por_canal AS
SELECT DISTINCT ON (sku, canal)
  sku, canal, item_id,
  floor_calculado AS precio_piso_calculado,
  precio_actual,
  precio_objetivo AS precio_promo_evaluado,
  margen_proyectado_pct,
  decision, promo_name, contexto,
  fecha AS calculado_at
FROM auto_postulacion_log
WHERE floor_calculado IS NOT NULL AND floor_calculado > 0
ORDER BY sku, canal, fecha DESC;

CREATE VIEW v_precio_piso_actual AS
SELECT sku, item_id, precio_piso_calculado, precio_actual,
       precio_promo_evaluado, margen_proyectado_pct, decision, promo_name,
       contexto, calculado_at
FROM v_precio_piso_por_canal
WHERE canal = 'ml';
