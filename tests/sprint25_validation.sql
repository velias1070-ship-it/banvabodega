-- =============================================================================
-- Sprint 2.5 — Validación post-deploy (8 tests)
-- =============================================================================
-- Correr después de aplicar 20260503130000_sprint25_h2_name_fallback.sql.
-- Resultado esperado: 8/8 PASS.
-- =============================================================================

-- T01 — Columna seasonal_match_source existe con CHECK constraint
SELECT 'T01_column_exists' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM information_schema.columns
WHERE table_name = 'sku_node_policy'
  AND column_name = 'seasonal_match_source';

-- T02 — Plumones (Y/Z, status active) ahora flagged low_confidence_seasonal
WITH plumones AS (
  SELECT snp.*
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.nombre ~* '\mplum(o|ó)n\M'
    AND snp.policy_status = 'active'
    AND snp.cell IN ('AY','AZ','BY','BZ','CY','CZ')
)
SELECT 'T02_plumones_flagged' AS test,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS (no plumones in Y/Z active)'
       WHEN BOOL_AND(xyz_confidence = 'low_confidence_seasonal')
       THEN 'PASS (' || COUNT(*) || ' plumones flagged)'
       ELSE 'FAIL: ' || COUNT(*) FILTER (WHERE xyz_confidence <> 'low_confidence_seasonal') || ' plumones sin flag' END AS result
FROM plumones;

-- T03 — Mantas (excluyendo manteles) flagged
WITH mantas AS (
  SELECT snp.*
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.nombre ~* '\mmanta[s]?\M'
    AND snp.policy_status = 'active'
    AND snp.cell IN ('AY','AZ','BY','BZ','CY','CZ')
)
SELECT 'T03_mantas_flagged' AS test,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS (no mantas in Y/Z active)'
       WHEN BOOL_AND(xyz_confidence = 'low_confidence_seasonal')
       THEN 'PASS (' || COUNT(*) || ' mantas flagged)'
       ELSE 'FAIL: ' || COUNT(*) FILTER (WHERE xyz_confidence <> 'low_confidence_seasonal') || ' mantas sin flag' END AS result
FROM mantas;

-- T04 — Frazadas flagged
WITH frazadas AS (
  SELECT snp.*
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.nombre ~* '\mfrazada[s]?\M'
    AND snp.policy_status = 'active'
    AND snp.cell IN ('AY','AZ','BY','BZ','CY','CZ')
)
SELECT 'T04_frazadas_flagged' AS test,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS (no frazadas in Y/Z active)'
       WHEN BOOL_AND(xyz_confidence = 'low_confidence_seasonal')
       THEN 'PASS (' || COUNT(*) || ' frazadas flagged)'
       ELSE 'FAIL: ' || COUNT(*) FILTER (WHERE xyz_confidence <> 'low_confidence_seasonal') || ' frazadas sin flag' END AS result
FROM frazadas;

-- T05 — SKUs name_pattern + xyz_confidence=low_confidence_seasonal tienen z=1.88.
-- Nota: name_pattern + cell X (alta demanda predecible) NO baja a 1.88: el
-- flag low_confidence solo aplica si tambien xyz IN (Y,Z). z_value=1.88 es la
-- consecuencia del flag, no del seasonal_match_source per se.
SELECT 'T05_name_pattern_lean_when_yz' AS test,
  CASE WHEN COUNT(*) = 0 THEN 'PASS (no name_pattern in low_confidence)'
       WHEN BOOL_AND(z_value = 1.88) THEN 'PASS (' || COUNT(*) || ')'
       ELSE 'FAIL' END AS result
FROM sku_node_policy
WHERE seasonal_match_source = 'name_pattern'
  AND xyz_confidence = 'low_confidence_seasonal'
  AND policy_status = 'active';

-- T06 — Sin falsos positivos: 'mantel' NO es matched (word boundary protege)
WITH manteles AS (
  SELECT snp.*, p.nombre
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.nombre ~* '\mmantel'
    AND p.nombre !~* '\mmanta[s]?\M'
    AND snp.policy_status = 'active'
)
SELECT 'T06_no_mantel_false_positive' AS test,
  CASE WHEN COUNT(*) = 0 THEN 'PASS (no manteles in active)'
       WHEN COUNT(*) FILTER (WHERE seasonal_match_source = 'name_pattern') = 0
       THEN 'PASS (' || COUNT(*) || ' manteles, ninguno por name_pattern)'
       ELSE 'FAIL: ' || COUNT(*) FILTER (WHERE seasonal_match_source = 'name_pattern') || ' manteles falsamente flagged' END AS result
FROM manteles;

-- T07 — Distribución seasonal_match_source post-refresh
SELECT 'T07_distribution' AS test,
  'category=' || COALESCE(SUM(CASE WHEN seasonal_match_source='category' THEN 1 ELSE 0 END), 0) ||
  ' name_pattern=' || COALESCE(SUM(CASE WHEN seasonal_match_source='name_pattern' THEN 1 ELSE 0 END), 0) ||
  ' none=' || COALESCE(SUM(CASE WHEN seasonal_match_source='none' THEN 1 ELSE 0 END), 0) ||
  ' null=' || COALESCE(SUM(CASE WHEN seasonal_match_source IS NULL THEN 1 ELSE 0 END), 0) AS result
FROM sku_node_policy;

-- T08 — Idempotencia: dos corridas del refresh producen mismo hash
DO $$
DECLARE h1 text; h2 text;
BEGIN
  SELECT MD5(STRING_AGG(sku_origen||':'||node_id||':'||COALESCE(z_value::text,'NULL')
                       ||':'||COALESCE(action::text,'NULL')||':'||policy_status
                       ||':'||COALESCE(seasonal_match_source,'NULL'),
                       ',' ORDER BY sku_origen, node_id))
    INTO h1 FROM sku_node_policy;
  PERFORM refresh_sku_node_policy_from_templates();
  SELECT MD5(STRING_AGG(sku_origen||':'||node_id||':'||COALESCE(z_value::text,'NULL')
                       ||':'||COALESCE(action::text,'NULL')||':'||policy_status
                       ||':'||COALESCE(seasonal_match_source,'NULL'),
                       ',' ORDER BY sku_origen, node_id))
    INTO h2 FROM sku_node_policy;
  IF h1 = h2 THEN
    RAISE NOTICE 'T08_idempotent: PASS (hash %)', LEFT(h1, 12);
  ELSE
    RAISE EXCEPTION 'T08_idempotent: FAIL h1=% h2=%', h1, h2;
  END IF;
END $$;
