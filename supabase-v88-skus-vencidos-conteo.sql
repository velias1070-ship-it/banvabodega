-- v88 — SKUs vencidos según cadencia ABC para conteo cíclico
-- Manual Inventarios Parte2 §5.6.1: A=12x/año (>30d), B=4x/año (>90d), C=1x/año (>365d).
-- Total esperado: ~885 conteos/año, ~3,4 SKUs/día hábil.
--
-- Reglas de selección:
--   - SKU vencido si dias_sin_conteo > umbral(abc) [contado hace tiempo]
--   - SKU vencido si dias_sin_conteo IS NULL y stock_total > 0 [nunca contado, hay qué contar]
--   - Excluye nunca-contados sin stock [no aporta]
--   - Excluye SKUs sin clase ABC asignada [no se sabe la cadencia]
--
-- Score de urgencia: nunca-contados con stock van primero (1000),
-- después por días vencidos (días - umbral). Mayor score = más urgente.

CREATE OR REPLACE VIEW v_skus_vencidos_conteo AS
SELECT
  si.sku_origen,
  si.nombre,
  si.abc,
  COALESCE(si.stock_total, 0)         AS stock_total,
  si.dias_sin_conteo,
  CASE si.abc
    WHEN 'A' THEN 30
    WHEN 'B' THEN 90
    WHEN 'C' THEN 365
    ELSE 365
  END                                  AS umbral_dias,
  CASE
    WHEN si.dias_sin_conteo IS NULL THEN NULL
    ELSE si.dias_sin_conteo - CASE si.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
  END                                  AS dias_vencido,
  CASE
    WHEN si.dias_sin_conteo IS NULL AND COALESCE(si.stock_total, 0) > 0 THEN 1000
    WHEN si.dias_sin_conteo IS NOT NULL THEN si.dias_sin_conteo - CASE si.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
    ELSE -1
  END                                  AS urgencia_score
FROM sku_intelligence si
WHERE si.abc IS NOT NULL
  AND (
    (si.dias_sin_conteo IS NULL AND COALESCE(si.stock_total, 0) > 0)
    OR si.dias_sin_conteo > CASE si.abc
      WHEN 'A' THEN 30
      WHEN 'B' THEN 90
      WHEN 'C' THEN 365
      ELSE 365
    END
  )
ORDER BY urgencia_score DESC, si.abc, si.dias_sin_conteo DESC NULLS FIRST;

COMMENT ON VIEW v_skus_vencidos_conteo IS
'SKUs vencidos según cadencia ABC del Manual Inventarios Parte2 §5.6.1 (A>30d, B>90d, C>365d).
Score de urgencia: nunca-contados con stock = 1000; resto = días - umbral.
Consumida por la UI Admin → Conteo Cíclico → Sugerir lista del día.';
