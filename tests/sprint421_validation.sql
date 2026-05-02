-- =============================================================================
-- Sprint 4.2.1 — Validación post-deploy (4 tests)
-- =============================================================================
-- Correr después de:
--   1) UPDATE de fix puntual (3 SKUs fósiles → NULL)
--   2) apply_migration 20260503240000_sprint421_quiebre_por_nodo.sql
-- Idempotente: solo lecturas.
-- =============================================================================

-- T01 — Los 3 SKUs fósiles tienen fecha_entrada_quiebre = NULL post-fix
SELECT 'T01_fosiles_limpiados' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE fecha_entrada_quiebre IS NULL) = 3
       THEN FORMAT('PASS (%s/%s con NULL)',
                   COUNT(*) FILTER (WHERE fecha_entrada_quiebre IS NULL), COUNT(*))
       ELSE FORMAT('FAIL: %s SKUs aún con fecha vieja',
                   3 - COUNT(*) FILTER (WHERE fecha_entrada_quiebre IS NULL)) END AS result
FROM sku_intelligence
WHERE sku_origen IN ('JSECBQ008P20A','TXTPBL20200SK','JSAFAB381P20X');

-- T02 — Cero SKUs con prevFecha pre-snapshots y sin evidencia (post próxima
-- corrida del cron). Hoy puede haber algunos hasta que se recalcule, pero
-- después del próximo recalcularTodo() debería ser 0.
SELECT 'T02_no_fosiles_pre_snapshot' AS test,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS (cero fósiles pre-snapshots sin evidencia)'
       ELSE FORMAT('WARN: %s SKUs aún fósiles. Esperar próximo cron de recalcularTodo.', COUNT(*)) END AS result
FROM sku_intelligence si
WHERE si.fecha_entrada_quiebre IS NOT NULL
  AND si.fecha_entrada_quiebre < (SELECT MIN(fecha) FROM stock_snapshots)
  AND NOT EXISTS (
    SELECT 1 FROM stock_snapshots ss
    WHERE ss.sku_origen = si.sku_origen AND ss.en_quiebre_full = true
  );

-- T03 — TXTPBL20200SK: bodega OK, full EN_QUIEBRE, alerta correcta
SELECT 'T03_txtpbl_quiebre_por_nodo' AS test,
  CASE WHEN quiebre_bodega_estado = 'OK'
        AND quiebre_full_estado = 'EN_QUIEBRE'
        AND alerta_operativa LIKE 'Full quebrado%'
       THEN FORMAT('PASS (bodega=%s, full=%s, dias_full=%s)',
                   quiebre_bodega_estado, quiebre_full_estado, quiebre_full_dias)
       ELSE FORMAT('FAIL (bodega=%s, full=%s, alerta=%s)',
                   quiebre_bodega_estado, quiebre_full_estado, COALESCE(alerta_operativa, 'NULL')) END AS result
FROM v_reposicion_explain
WHERE sku_origen = 'TXTPBL20200SK';

-- T04 — Sanity: SKUs con stock_total > 0 NUNCA tienen QUIEBRE TOTAL en alerta
SELECT 'T04_sanity_quiebre_total' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE stock_total > 0 AND alerta_operativa LIKE 'QUIEBRE TOTAL%') = 0
       THEN 'PASS (cero SKUs con stock_total>0 marcados como QUIEBRE TOTAL)'
       ELSE FORMAT('FAIL: %s SKUs con stock_total>0 marcados QUIEBRE TOTAL',
                   COUNT(*) FILTER (WHERE stock_total > 0 AND alerta_operativa LIKE 'QUIEBRE TOTAL%')) END AS result
FROM v_reposicion_explain;
