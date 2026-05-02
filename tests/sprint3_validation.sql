-- =============================================================================
-- Sprint 3 — Validación post-deploy (10 tests)
-- =============================================================================
-- Correr después de aplicar 20260503150000_sprint3_traceability_guardrails.sql.
-- Resultado esperado: 10/10 PASS.
-- Idempotente: cada test es lectura o test-and-rollback.
-- =============================================================================

-- T01 — sku_intelligence.margen_neto_30d_imputed existe (NOT NULL DEFAULT false)
SELECT 'T01_si_imputed_col' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM information_schema.columns
WHERE table_name = 'sku_intelligence'
  AND column_name = 'margen_neto_30d_imputed'
  AND data_type = 'boolean'
  AND is_nullable = 'NO';

-- T02 — sku_intelligence_history.margen_neto_30d_imputed existe
SELECT 'T02_sih_imputed_col' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM information_schema.columns
WHERE table_name = 'sku_intelligence_history'
  AND column_name = 'margen_neto_30d_imputed'
  AND data_type = 'boolean'
  AND is_nullable = 'NO';

-- T03 — CHECK constraint sku_intelligence_vel_objetivo_sane existe
SELECT 'T03_check_constraint' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_constraint
WHERE conname = 'sku_intelligence_vel_objetivo_sane';

-- T04 — CHECK constraint rechaza valor negativo (SAVEPOINT/ROLLBACK)
DO $$
DECLARE v_caught boolean := false;
BEGIN
  BEGIN
    SAVEPOINT s_t04;
    UPDATE sku_intelligence SET vel_objetivo = -1
     WHERE sku_origen = (SELECT sku_origen FROM sku_intelligence LIMIT 1);
    ROLLBACK TO s_t04;
  EXCEPTION
    WHEN check_violation THEN
      v_caught := true;
      ROLLBACK TO s_t04;
  END;
  IF v_caught THEN
    RAISE NOTICE 'T04_check_rechaza_negativo: PASS';
  ELSE
    RAISE EXCEPTION 'T04_check_rechaza_negativo: FAIL — UPDATE -1 no fue bloqueado';
  END IF;
END $$;

-- T05 — RPC validate_vel_objetivo_input existe y devuelve estructura esperada
SELECT 'T05_rpc_exists' AS test,
  CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
FROM pg_proc WHERE proname = 'validate_vel_objetivo_input';

-- T06 — RPC rechaza valor negativo con razón clara
SELECT 'T06_rpc_negativo' AS test,
  CASE WHEN is_valid = false AND reason = 'negativo_no_permitido' THEN 'PASS'
       ELSE 'FAIL: is_valid=' || is_valid::text || ' reason=' || reason END AS result
FROM (
  SELECT * FROM validate_vel_objetivo_input(
    (SELECT sku_origen FROM sku_intelligence LIMIT 1), -1::numeric
  )
) v;

-- T07 — RPC acepta NULL como válido
SELECT 'T07_rpc_null_ok' AS test,
  CASE WHEN is_valid = true AND reason = 'null_aceptable' THEN 'PASS'
       ELSE 'FAIL: is_valid=' || is_valid::text || ' reason=' || reason END AS result
FROM (
  SELECT * FROM validate_vel_objetivo_input(
    (SELECT sku_origen FROM sku_intelligence LIMIT 1), NULL::numeric
  )
) v;

-- T08 — RPC retorna sku_no_existe para SKU inválido
SELECT 'T08_rpc_sku_inexistente' AS test,
  CASE WHEN is_valid = false AND reason = 'sku_no_existe' THEN 'PASS'
       ELSE 'FAIL: is_valid=' || is_valid::text || ' reason=' || reason END AS result
FROM (
  SELECT * FROM validate_vel_objetivo_input('___SKU_QUE_NO_EXISTE___'::text, 0::numeric)
) v;

-- T09 — Backfill margen_neto_30d_imputed: SKUs marcados true son los que
-- tuvieron >=15 días en quiebre en los últimos 30d.
WITH deberian_estar_marcados AS (
  SELECT si.sku_origen
    FROM sku_intelligence si
   WHERE EXISTS (
     SELECT 1 FROM stock_snapshots ss
      WHERE ss.sku_origen = si.sku_origen
        AND ss.created_at >= now() - INTERVAL '30 days'
      GROUP BY ss.sku_origen
     HAVING COUNT(*) FILTER (
       WHERE ss.en_quiebre_full = true OR ss.en_quiebre_bodega = true
     ) >= 15
   )
)
SELECT 'T09_backfill_consistente' AS test,
  CASE
    WHEN (SELECT COUNT(*) FROM deberian_estar_marcados) =
         (SELECT COUNT(*) FROM sku_intelligence WHERE margen_neto_30d_imputed = true)
    THEN 'PASS (' || (SELECT COUNT(*) FROM sku_intelligence WHERE margen_neto_30d_imputed = true) || ')'
    ELSE 'FAIL: esperados=' || (SELECT COUNT(*) FROM deberian_estar_marcados)
         || ' marcados=' || (SELECT COUNT(*) FROM sku_intelligence WHERE margen_neto_30d_imputed = true)
  END AS result;

-- T10 — lint_forbidden_patterns tiene los 2 patrones registrados
SELECT 'T10_lint_registry' AS test,
  CASE WHEN COUNT(*) = 2 THEN 'PASS (' || COUNT(*) || ')' ELSE 'FAIL: ' || COUNT(*) END AS result
FROM lint_forbidden_patterns
WHERE pattern IN ('.neq(''anulada'', true)', '.neq("anulada", true)');
