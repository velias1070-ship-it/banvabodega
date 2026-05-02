-- =============================================================================
-- Sprint 4 — Validación post-deploy (10 tests)
-- =============================================================================
-- Correr después de aplicar:
--  20260503180000_sprint4_archive_agent_errors.sql
--  20260503180100_sprint4_reposicion_views.sql
-- Idempotente: solo lecturas o conteos.
-- =============================================================================

-- T01 — Archive populated (>=40k rows)
SELECT 'T01_archive_populated' AS test,
  CASE WHEN COUNT(*) >= 40000 THEN 'PASS (' || COUNT(*) || ')'
       ELSE 'FAIL (' || COUNT(*) || ')' END AS result
FROM _sprint4_archive_agent_runs_pre_2026_05;

-- T02 — agent_runs activa < 5000 (margen para últimas 24h pre-deploy).
-- Tras merge + remoción del cron, el próximo backfill bajará a 0.
SELECT 'T02_active_table_clean' AS test,
  CASE WHEN COUNT(*) < 5000 THEN 'PASS (' || COUNT(*) || ' rows)'
       ELSE 'FAIL (' || COUNT(*) || ' rows still in agent_runs)' END AS result
FROM agent_runs;

-- T03 — 4 vistas creadas
SELECT 'T03_views_created' AS test,
  CASE WHEN COUNT(*) = 4 THEN 'PASS'
       ELSE 'FAIL (' || COUNT(*) || '/4)' END AS result
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name IN ('v_safety_stock', 'v_compras_pendientes',
                     'v_alertas_quiebre', 'v_reposicion_dashboard');

-- T04 — v_safety_stock devuelve filas (>=50)
SELECT 'T04_safety_stock_data' AS test,
  CASE WHEN COUNT(*) > 50 THEN 'PASS (' || COUNT(*) || ' rows)' ELSE 'FAIL' END AS result
FROM v_safety_stock;

-- T05 — v_compras_pendientes en rango razonable (1-300 con datos actuales)
SELECT 'T05_compras_pendientes_data' AS test,
  CASE WHEN COUNT(*) BETWEEN 1 AND 300
       THEN 'PASS (' || COUNT(*) || ' rows)'
       ELSE 'WARN (' || COUNT(*) || ', esperado 1-300)' END AS result
FROM v_compras_pendientes;

-- T06 — v_alertas_quiebre con prioridades válidas
SELECT 'T06_alertas_priorities_valid' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE prioridad NOT BETWEEN 1 AND 9) = 0
       THEN 'PASS' ELSE 'FAIL: prioridades fuera de rango' END AS result
FROM v_alertas_quiebre;

-- T07 — Reconciliación: cero CZ / no_reorder en v_compras_pendientes
SELECT 'T07_no_cz_in_compras' AS test,
  CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL: ' || COUNT(*) || ' CZ' END AS result
FROM v_compras_pendientes vcp
JOIN sku_node_policy snp
  ON snp.sku_origen = vcp.sku_origen
 AND snp.node_id = 'bodega_central'
WHERE snp.action = 'no_reorder';

-- T08 — v_reposicion_dashboard rowcount = v_compras_pendientes (1:1)
SELECT 'T08_dashboard_matches_compras' AS test,
  CASE WHEN (SELECT COUNT(*) FROM v_reposicion_dashboard)
            = (SELECT COUNT(*) FROM v_compras_pendientes)
       THEN 'PASS' ELSE 'FAIL' END AS result;

-- T09 — Niveles de alerta válidos (whitelist de 5)
SELECT 'T09_nivel_alerta_valid' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE nivel_alerta NOT IN
                              ('QUIEBRE_TOTAL','CRITICO','URGENTE','ATENCION','OK')) = 0
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM v_reposicion_dashboard;

-- T10 — pre_full_target=0 cuando node_id != 'full_ml'
SELECT 'T10_pre_full_only_full_node' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE node_id <> 'full_ml' AND pre_full_target <> 0) = 0
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM v_safety_stock;
