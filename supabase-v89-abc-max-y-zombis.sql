-- v89 — ABC efectivo = MAX(margen, ingreso, unidades) + limpieza de zombis
--
-- 1) Manual Inventarios Parte1 §2.2 línea 179: "críticamente, debes hacer el
--    ABC tres veces, no una". Para cycle counting tomamos el MAX de los 3:
--    un SKU es A si es A en cualquiera de margen/ingreso/unidades. Eso captura
--    los 3 riesgos (financiero, ingreso, operativo). Sin esto, ~24 SKUs con
--    alta velocidad pero bajo margen recibían tolerancia C (±2) sin razón.
--
-- 2) DELETE de filas huérfanas en sku_intelligence — SKUs que ya no existen
--    en `productos`. Detectados al revisar últimos updated_at: 15 filas con
--    nombre=NULL, stock=0, congeladas en 2026-03-13. Son catálogo descontinuado
--    no limpiado a tiempo.

-- 1) Actualizar vista de SKUs vencidos para usar ABC efectivo (MAX 3 ejes).
CREATE OR REPLACE VIEW v_skus_vencidos_conteo AS
WITH abc_efectivo AS (
  SELECT
    si.sku_origen,
    si.nombre,
    -- ABC efectivo = MAX(margen, ingreso, unidades). A si es A en cualquiera.
    CASE
      WHEN 'A' IN (si.abc_margen, si.abc_ingreso, si.abc_unidades) THEN 'A'
      WHEN 'B' IN (si.abc_margen, si.abc_ingreso, si.abc_unidades) THEN 'B'
      WHEN 'C' IN (si.abc_margen, si.abc_ingreso, si.abc_unidades) THEN 'C'
      ELSE NULL
    END AS abc,
    COALESCE(si.stock_total, 0) AS stock_total,
    si.dias_sin_conteo
  FROM sku_intelligence si
)
SELECT
  ae.sku_origen,
  ae.nombre,
  ae.abc,
  ae.stock_total,
  ae.dias_sin_conteo,
  CASE ae.abc
    WHEN 'A' THEN 30
    WHEN 'B' THEN 90
    WHEN 'C' THEN 365
    ELSE 365
  END AS umbral_dias,
  CASE
    WHEN ae.dias_sin_conteo IS NULL THEN NULL
    ELSE ae.dias_sin_conteo - CASE ae.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
  END AS dias_vencido,
  CASE
    WHEN ae.dias_sin_conteo IS NULL AND ae.stock_total > 0 THEN 1000
    WHEN ae.dias_sin_conteo IS NOT NULL THEN ae.dias_sin_conteo - CASE ae.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
    ELSE -1
  END AS urgencia_score
FROM abc_efectivo ae
WHERE ae.abc IS NOT NULL
  AND (
    (ae.dias_sin_conteo IS NULL AND ae.stock_total > 0)
    OR ae.dias_sin_conteo > CASE ae.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
  )
ORDER BY urgencia_score DESC, ae.abc, ae.dias_sin_conteo DESC NULLS FIRST;

COMMENT ON VIEW v_skus_vencidos_conteo IS
'SKUs vencidos según cadencia ABC. ABC efectivo = MAX(margen, ingreso, unidades)
del Manual Inventarios Parte1 §2.2. Tolerancia: A>30d, B>90d, C>365d.';

-- 2) Limpieza de zombis: filas en sku_intelligence sin row correspondiente en productos.
DELETE FROM sku_intelligence
WHERE sku_origen NOT IN (SELECT sku FROM productos);
