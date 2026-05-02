-- =============================================================================
-- Sprint 2 — Validación post-deploy (13 tests)
-- =============================================================================
-- Correr después de aplicar 20260503090000_sprint2_populate_sku_node_policy.sql.
-- Resultado esperado: 13/13 PASS. Última corrida: 2026-05-02 (13/13 PASS).
-- =============================================================================

-- T01 — seasonal_categories seedeada (>=5 entries)
SELECT 'T01_seasonal_seeded' AS test,
  CASE WHEN COUNT(*) >= 5 THEN 'PASS' ELSE 'FAIL: ' || COUNT(*) END AS result
FROM seasonal_categories;

-- T02 — Función calc_sku_node_policy_row existe
SELECT 'T02_function_exists' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_proc WHERE proname='calc_sku_node_policy_row';

-- T03 — sku_node_policy poblada
SELECT 'T03_policy_populated' AS test,
  CASE WHEN COUNT(*) > 0 THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM sku_node_policy;

-- T04 — Cobertura: cada SKU activo × 2 nodos
WITH skus_activos AS (SELECT sku FROM productos WHERE estado_sku='activo' OR estado_sku IS NULL),
expected AS (SELECT COUNT(*)*2 AS expected FROM skus_activos),
actual AS (SELECT COUNT(*) AS actual FROM sku_node_policy)
SELECT 'T04_full_coverage' AS test,
  CASE WHEN actual.actual = expected.expected
       THEN 'PASS (' || actual.actual || ')'
       ELSE 'FAIL: expected=' || expected.expected || ' actual=' || actual.actual END AS result
FROM expected, actual;

-- T05 — AX SKUs (alta confianza) tienen z=2.05 exacto (golden test SPM:713)
SELECT 'T05_ax_z_exact' AS test,
  CASE WHEN COUNT(*) > 0 AND BOOL_AND(z_value=2.05)
       THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM sku_node_policy WHERE cell='AX' AND xyz_confidence='high';

-- T06 — AZ SKUs (alta confianza) tienen z=1.28 (decisión H3 lean)
SELECT 'T06_az_z_lean' AS test,
  CASE WHEN COUNT(*) > 0 AND BOOL_AND(z_value=1.28)
       THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM sku_node_policy WHERE cell='AZ' AND xyz_confidence='high';

-- T07 — CZ SKUs tienen action=no_reorder (H3 + SPM:683)
SELECT 'T07_cz_no_reorder' AS test,
  CASE WHEN COUNT(*) > 0 AND BOOL_AND(action='no_reorder')
       THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM sku_node_policy WHERE cell='CZ';

-- T08 — SKUs sin costo están blocked_no_cost
SELECT 'T08_no_cost_blocked' AS test,
  CASE WHEN COUNT(*)=0 OR BOOL_AND(snp.policy_status='blocked_no_cost')
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM sku_node_policy snp
JOIN productos p ON p.sku=snp.sku_origen
WHERE (p.costo_promedio IS NULL OR p.costo_promedio=0);

-- T09 — Categorías estacionales (is_active=true) con XYZ Y/Z y status active
--       tienen low_confidence_seasonal flag.
SELECT 'T09_seasonal_flagged' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE snp.xyz_confidence <> 'low_confidence_seasonal'
                               AND snp.policy_status='active') = 0
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM sku_node_policy snp
JOIN productos p ON p.sku=snp.sku_origen
JOIN seasonal_categories sc ON LOWER(sc.category)=LOWER(p.categoria) AND sc.is_active=true
WHERE snp.cell IN ('AY','AZ','BY','BZ','CY','CZ');

-- T10 — SKUs con flag low_confidence_seasonal tienen z=1.88 (fallback conservador)
SELECT 'T10_seasonal_fallback_z' AS test,
  CASE WHEN COUNT(*)=0 OR BOOL_AND(z_value=1.88)
       THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM sku_node_policy
WHERE xyz_confidence='low_confidence_seasonal' AND policy_status='active';

-- T11 — v_sku_policy_diff existe y devuelve filas
SELECT 'T11_diff_view' AS test,
  CASE WHEN COUNT(*) > 0 THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL' END AS result
FROM v_sku_policy_diff;

-- T12 — Cero filas con diff_status='drift_unexpected' post-backfill
SELECT 'T12_no_unexpected_drift' AS test,
  CASE WHEN COUNT(*)=0 THEN 'PASS'
       ELSE 'FAIL: ' || COUNT(*) || ' SKUs con drift inesperado' END AS result
FROM v_sku_policy_diff WHERE diff_status='drift_unexpected';

-- T13 — Idempotencia: dos corridas del refresh producen mismo hash de estado.
DO $$
DECLARE h1 text; h2 text;
BEGIN
  SELECT MD5(STRING_AGG(sku_origen||':'||node_id||':'||COALESCE(z_value::text,'NULL')
                       ||':'||COALESCE(action::text,'NULL')||':'||policy_status,
                       ',' ORDER BY sku_origen, node_id))
    INTO h1 FROM sku_node_policy;
  PERFORM refresh_sku_node_policy_from_templates();
  SELECT MD5(STRING_AGG(sku_origen||':'||node_id||':'||COALESCE(z_value::text,'NULL')
                       ||':'||COALESCE(action::text,'NULL')||':'||policy_status,
                       ',' ORDER BY sku_origen, node_id))
    INTO h2 FROM sku_node_policy;
  IF h1 = h2 THEN
    RAISE NOTICE 'T13_idempotent: PASS (hash %)', LEFT(h1, 12);
  ELSE
    RAISE EXCEPTION 'T13_idempotent: FAIL h1=% h2=%', h1, h2;
  END IF;
END $$;
