-- Sprint 9 P2 — Tests CZ_alta_vel rescate
-- batch:20260506-sprint-9-p2-cz-rescate | sprint:9 | milestone:sprint-9-cz-rescate
--
-- T35 (pin >=1): SKUs con cell_efectiva='CZ_alta_vel' debe ser >= 1
--                (los casos testigo del owner deben rescatarse).
-- T36 (pin =0):  JSAFAB408P20Z (5 ventas, última 100+ días) NO debe estar
--                en CZ_alta_vel (es abandono real, no rescate).
-- T37 (pin >=3): JSCNAE141P20Z, JSAFAB397P20X, JSCNAE138P25B deben estar
--                en v_safety_stock (visibilidad downstream restaurada).
-- T38 (pin =1):  JSCNAE138P25B (vendió HOY) debe estar en v_reposicion_explain.

-- ─────────────────────────────────────────────────────────────────────
-- T35: cell_efectiva CZ_alta_vel poblado
-- ─────────────────────────────────────────────────────────────────────
WITH t35 AS (
  SELECT COUNT(DISTINCT sku_origen) AS skus_cz_alta_vel
  FROM sku_node_policy
  WHERE cell_efectiva = 'CZ_alta_vel' AND policy_status = 'active'
)
SELECT 'T35_cz_alta_vel_count'::text AS test_name,
       skus_cz_alta_vel AS valor,
       1 AS esperado_min,
       CASE WHEN skus_cz_alta_vel >= 1 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t35;

-- ─────────────────────────────────────────────────────────────────────
-- T36: JSAFAB408P20Z NO debe estar en CZ_alta_vel (abandono real)
-- ─────────────────────────────────────────────────────────────────────
WITH t36 AS (
  SELECT COUNT(*) AS skus_abandono_rescatado
  FROM sku_node_policy
  WHERE sku_origen = 'JSAFAB408P20Z' AND cell_efectiva = 'CZ_alta_vel'
)
SELECT 'T36_408P20Z_no_rescata'::text AS test_name,
       skus_abandono_rescatado AS valor,
       0 AS esperado,
       CASE WHEN skus_abandono_rescatado = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t36;

-- ─────────────────────────────────────────────────────────────────────
-- T37: 3 testigos deben estar en v_safety_stock (visibilidad downstream)
-- ─────────────────────────────────────────────────────────────────────
WITH t37 AS (
  SELECT COUNT(DISTINCT sku_origen) AS testigos_visibles
  FROM v_safety_stock
  WHERE sku_origen IN ('JSCNAE141P20Z','JSAFAB397P20X','JSCNAE138P25B')
    AND node_id = 'bodega_central'
)
SELECT 'T37_3_testigos_visibles_safety_stock'::text AS test_name,
       testigos_visibles AS valor,
       3 AS esperado,
       CASE WHEN testigos_visibles >= 3 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t37;

-- ─────────────────────────────────────────────────────────────────────
-- T38: JSCNAE138P25B (vendió HOY) en v_reposicion_explain
-- ─────────────────────────────────────────────────────────────────────
WITH t38 AS (
  SELECT COUNT(*) AS visible
  FROM v_reposicion_explain
  WHERE sku_origen = 'JSCNAE138P25B'
)
SELECT 'T38_138B_visible_explain'::text AS test_name,
       visible AS valor,
       1 AS esperado,
       CASE WHEN visible = 1 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t38;
