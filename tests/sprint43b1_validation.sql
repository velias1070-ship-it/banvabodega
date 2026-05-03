-- =============================================================================
-- Sprint 4.3b.1 — Validación post-deploy (5 tests)
-- =============================================================================
-- Correr después de:
--   1) 20260504160000_sprint43b1_fix_trend_quiebre.sql
--   2) SELECT * FROM refresh_trend_in_sku_node_policy();
-- =============================================================================

-- T1 — TXSBAF144DL20 (caso falso positivo Sprint 4.3b) ahora es recuperacion_post_quiebre
SELECT 'T01_txsbaf144dl20_recuperacion' AS test,
  CASE WHEN tendencia = 'recuperacion_post_quiebre'
       THEN FORMAT('PASS: tendencia=%s (era acelerando_fuerte falso positivo)', tendencia)
       ELSE FORMAT('FAIL: tendencia=%s (esperado recuperacion_post_quiebre)', tendencia) END AS result
FROM v_trend_detection
WHERE sku_origen = 'TXSBAF144DL20';

-- T2 — TXSB144ISY15P (caso válido) sigue acelerando o estable (no recuperación)
SELECT 'T02_txsb144isy15p_aceleracion_real' AS test,
  CASE WHEN tendencia IN ('acelerando','acelerando_fuerte','estable')
       THEN FORMAT('PASS: tendencia=%s (caso válido preservado)', tendencia)
       ELSE FORMAT('FAIL: tendencia=%s', tendencia) END AS result
FROM v_trend_detection
WHERE sku_origen = 'TXSB144ISY15P';

-- T3 — Ningún SKU promovido tiene fecha_entrada_quiebre IS NOT NULL (GUARDA 1)
SELECT 'T03_promovidos_sin_quiebre_real' AS test,
  CASE WHEN COUNT(*) FILTER (
         WHERE snp.promocion_activa = true
           AND si.es_quiebre_proveedor = true
           AND si.fecha_entrada_quiebre IS NOT NULL
       ) = 0
       THEN FORMAT('PASS: 0 promovidos en quiebre real (de %s promovidos totales)',
                   COUNT(*) FILTER (WHERE snp.promocion_activa = true))
       ELSE FORMAT('FAIL: %s promovidos con quiebre real',
                   COUNT(*) FILTER (
                     WHERE snp.promocion_activa = true
                       AND si.es_quiebre_proveedor = true
                       AND si.fecha_entrada_quiebre IS NOT NULL
                   )) END AS result
FROM sku_node_policy snp
JOIN sku_intelligence si ON si.sku_origen = snp.sku_origen;

-- T4 — Distribución post-fix
SELECT 'T04_distribucion_post_fix' AS test,
  FORMAT('estable=%s acel=%s acel_fuerte=%s desacel=%s desacel_fuerte=%s recuperacion=%s insuf=%s',
    COUNT(*) FILTER (WHERE tendencia = 'estable'),
    COUNT(*) FILTER (WHERE tendencia = 'acelerando'),
    COUNT(*) FILTER (WHERE tendencia = 'acelerando_fuerte'),
    COUNT(*) FILTER (WHERE tendencia = 'desacelerando'),
    COUNT(*) FILTER (WHERE tendencia = 'desacelerando_fuerte'),
    COUNT(*) FILTER (WHERE tendencia = 'recuperacion_post_quiebre'),
    COUNT(*) FILTER (WHERE tendencia = 'insuficiente_data')
  ) AS result
FROM v_trend_detection;

-- T5 — calc_cell_efectiva con recuperacion_post_quiebre NO promueve
SELECT 'T05_calc_cell_efectiva_recuperacion_no_promueve' AS test,
  CASE WHEN cell_efectiva = 'CY' AND promocion_activa = false
       THEN FORMAT('PASS: cell_efectiva=%s, promocion_activa=%s', cell_efectiva, promocion_activa)
       ELSE FORMAT('FAIL: cell_efectiva=%s, promocion_activa=%s', cell_efectiva, promocion_activa) END AS result
FROM calc_cell_efectiva('CY', 'recuperacion_post_quiebre');
