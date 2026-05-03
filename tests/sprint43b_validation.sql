-- =============================================================================
-- Sprint 4.3b — Validación post-deploy (6 tests)
-- =============================================================================
-- Correr después de:
--   1) 20260504130000_sprint43b_trend_detection.sql
--   2) SELECT * FROM refresh_trend_in_sku_node_policy();
-- Idempotente: solo lecturas. No escribe nada.
-- =============================================================================

-- T1 — Vista v_trend_detection devuelve filas razonables
SELECT 'T01_vista_v_trend_detection' AS test,
  CASE WHEN COUNT(*) > 100
       THEN FORMAT('PASS (%s SKUs en vista)', COUNT(*))
       ELSE FORMAT('FAIL: solo %s SKUs (esperado >100)', COUNT(*)) END AS result
FROM v_trend_detection;

-- T2 — Distribución de tendencias razonable (estable mayoritario, casos no extremos)
SELECT 'T02_distribucion_tendencias' AS test,
  FORMAT('estable=%s acelerando=%s acelerando_fuerte=%s desacelerando=%s desacelerando_fuerte=%s insuficiente=%s',
    COUNT(*) FILTER (WHERE tendencia = 'estable'),
    COUNT(*) FILTER (WHERE tendencia = 'acelerando'),
    COUNT(*) FILTER (WHERE tendencia = 'acelerando_fuerte'),
    COUNT(*) FILTER (WHERE tendencia = 'desacelerando'),
    COUNT(*) FILTER (WHERE tendencia = 'desacelerando_fuerte'),
    COUNT(*) FILTER (WHERE tendencia = 'insuficiente_data')
  ) AS result
FROM v_trend_detection;

-- T3 — Función calc_cell_efectiva: promociones C→B y B→A; A no cambia; estable preserva
SELECT 'T03_calc_cell_efectiva' AS test,
  CASE
    WHEN (SELECT cell_efectiva FROM calc_cell_efectiva('CY', 'acelerando')) = 'BY'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('CX', 'acelerando_fuerte')) = 'BX'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('BX', 'acelerando')) = 'AX'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('BZ', 'acelerando')) = 'AZ'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('AX', 'acelerando')) = 'AX'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('CY', 'estable')) = 'CY'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('CY', 'desacelerando')) = 'CY'
     AND (SELECT cell_efectiva FROM calc_cell_efectiva('CY', 'desacelerando_fuerte')) = 'CY'
     AND (SELECT promocion_activa FROM calc_cell_efectiva('CY', 'acelerando')) = true
     AND (SELECT promocion_activa FROM calc_cell_efectiva('AX', 'acelerando')) = false
    THEN 'PASS' ELSE 'FAIL' END AS result;

-- T4 — RPC refresh_trend_in_sku_node_policy ejecuta sin error y reporta filas
SELECT 'T04_rpc_refresh_ok' AS test,
  CASE WHEN rows_affected > 0
       THEN FORMAT('PASS rows=%s acelerando_fuerte=%s acelerando=%s promovidos=%s',
                   rows_affected,
                   summary->>'acelerando_fuerte',
                   summary->>'acelerando',
                   summary->>'promovidos')
       ELSE FORMAT('FAIL rows=%s', rows_affected) END AS result
FROM refresh_trend_in_sku_node_policy();

-- T5 — Promovidos en sku_node_policy y refleja celda promovida
SELECT 'T05_promovidos_persistidos' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE promocion_activa = true) > 0
       THEN FORMAT('PASS %s promovidos (de %s con tendencia≠NULL)',
                   COUNT(*) FILTER (WHERE promocion_activa = true),
                   COUNT(*) FILTER (WHERE tendencia IS NOT NULL))
       ELSE 'FAIL: 0 promovidos' END AS result
FROM sku_node_policy;

-- T6 — SKUs C-acelerando o B-acelerando reciben política de B/A en v_safety_stock
-- (cell debe empezar con B o A cuando cell_original empieza con C o B y promocion_activa)
SELECT 'T06_promocion_aplicada_safety_stock' AS test,
  CASE WHEN COUNT(*) FILTER (
         WHERE promocion_activa = true
           AND ((cell_original LIKE 'C%' AND cell LIKE 'B%')
             OR (cell_original LIKE 'B%' AND cell LIKE 'A%'))
       ) = COUNT(*) FILTER (WHERE promocion_activa = true)
       AND COUNT(*) FILTER (WHERE promocion_activa = true) > 0
       THEN FORMAT('PASS (%s/%s promovidos válidos C→B o B→A)',
                   COUNT(*) FILTER (
                     WHERE promocion_activa = true
                       AND ((cell_original LIKE 'C%' AND cell LIKE 'B%')
                         OR (cell_original LIKE 'B%' AND cell LIKE 'A%'))
                   ),
                   COUNT(*) FILTER (WHERE promocion_activa = true))
       ELSE 'FAIL: hay promovidos con celda inconsistente' END AS result
FROM v_safety_stock;
