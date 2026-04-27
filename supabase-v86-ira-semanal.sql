-- v86 — Vistas para tracking IRA semanal
-- Manual Inventarios Parte3 §5.6 línea 247: "Mide IRA semanalmente.
-- Target: 95% en 3 meses, 99% en 12 meses."
--
-- Dos vistas:
--   v_ira_semanal_global: agregado por semana usando los snapshots
--     ya persistidos en conteos.lineas_total / lineas_ok (rápido, idempotente).
--   v_ira_semanal_abc: desglose por clase ABC, abre lineas jsonb y aplica
--     la tolerancia documentada (A=0, B=1, C=2).

CREATE OR REPLACE VIEW v_ira_semanal_global AS
SELECT
  date_trunc('week', closed_at)::date AS semana,
  COUNT(*)                            AS conteos_cerrados,
  COALESCE(SUM(lineas_total), 0)      AS lineas_total,
  COALESCE(SUM(lineas_ok), 0)         AS lineas_ok,
  COALESCE(SUM(lineas_diff), 0)       AS lineas_diff,
  ROUND(
    COALESCE(SUM(lineas_ok), 0)::numeric
      / NULLIF(SUM(lineas_total), 0) * 100,
    2
  )                                   AS ira_pct
FROM conteos
WHERE estado = 'CERRADA'
  AND closed_at IS NOT NULL
  AND lineas_total IS NOT NULL
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_ira_semanal_abc AS
SELECT
  date_trunc('week', c.closed_at)::date           AS semana,
  COALESCE(l->>'abc_snapshot', 'sin_clase')        AS abc,
  COUNT(*)                                         AS lineas_total,
  COUNT(*) FILTER (
    WHERE ABS((l->>'stock_contado')::int - (l->>'stock_sistema')::int) <=
      CASE l->>'abc_snapshot'
        WHEN 'A' THEN 0
        WHEN 'B' THEN 1
        WHEN 'C' THEN 2
        ELSE 0
      END
  )                                                AS lineas_ok,
  ROUND(
    COUNT(*) FILTER (
      WHERE ABS((l->>'stock_contado')::int - (l->>'stock_sistema')::int) <=
        CASE l->>'abc_snapshot'
          WHEN 'A' THEN 0
          WHEN 'B' THEN 1
          WHEN 'C' THEN 2
          ELSE 0
        END
    )::numeric / NULLIF(COUNT(*), 0) * 100,
    2
  )                                                AS ira_pct
FROM conteos c, jsonb_array_elements(c.lineas) l
WHERE c.estado = 'CERRADA'
  AND c.closed_at IS NOT NULL
  AND l->>'estado' IN ('AJUSTADO', 'VERIFICADO')
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

COMMENT ON VIEW v_ira_semanal_global IS 'IRA agregado por semana ISO. Usa snapshots persistidos en conteos.lineas_*. Manual Inventarios Parte3 §5.6 línea 247.';
COMMENT ON VIEW v_ira_semanal_abc IS 'IRA desglosado por clase ABC y semana. Aplica tolerancia A=0/B=1/C=2 sobre abc_snapshot por línea. Manual Inventarios Parte2 §5.6.2.';
