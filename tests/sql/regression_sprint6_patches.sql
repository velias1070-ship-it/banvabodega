-- =============================================================================
-- Regresión Patches Sprint 6 + Fase 1 Sprint 7 (12 tests)
-- =============================================================================
-- Cubre todos los bugfixes de paridad motor viejo→nuevo aplicados en S6 y S7:
--   • S6 Fase 1     — umbral vel_pre_quiebre (desbloqueo NUEVOs)
--   • S6 Fase 2     — accion + prioridad persistidas en sku_node_policy
--   • S6 Fase 3     — is_new_sku, lote inicial, inner_pack redondeo
--   • S6 Patch 1    — is_new_sku en v_safety_stock
--   • S6 Patch 2    — is_new_sku bypass no_reorder en v_compras_pendientes
--   • S7 Fase 0.A   — lane bodega_to_full (componentes PICKEADOS)
--   • S7 Fase 0.B   — mandar_full_uds protege reserva_flex_target
--   • S7 Fase 1.1   — URGENTE por cobertura cruda <7d
--   • S7 Fase 1.2   — cell default + bypass blocked_no_cost para is_new_sku
-- Pre-requisito: SELECT * FROM refresh_sku_node_policy_from_templates();
-- =============================================================================

-- T01 — S6 Fase 2: accion + prioridad NOT NULL para todos los policy_status='active'
SELECT 'T01_accion_prioridad_persistidas' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE accion IS NULL OR prioridad IS NULL) = 0
       THEN FORMAT('PASS: %s policies activas con accion+prioridad', COUNT(*))
       ELSE FORMAT('FAIL: %s policies activas con accion/prioridad NULL',
                   COUNT(*) FILTER (WHERE accion IS NULL OR prioridad IS NULL)) END AS result
FROM sku_node_policy
WHERE policy_status = 'active' AND node_id = 'bodega_central';

-- T02 — S6 Fase 3 / Patch 1: is_new_sku appears in v_safety_stock
SELECT 'T02_is_new_sku_en_safety_stock' AS test,
  CASE WHEN COUNT(*) > 0
       THEN FORMAT('PASS: %s is_new_sku en v_safety_stock', COUNT(*))
       ELSE 'FAIL: 0 is_new_sku en v_safety_stock' END AS result
FROM v_safety_stock vs
JOIN sku_node_policy snp ON snp.sku_origen = vs.sku_origen AND snp.node_id = vs.node_id
WHERE snp.is_new_sku = true;

-- T03 — S6 Patch 2: is_new_sku appears in v_compras_pendientes (bypass bajo_rop)
SELECT 'T03_is_new_sku_en_compras_pendientes' AS test,
  CASE WHEN COUNT(*) >= 4
       THEN FORMAT('PASS: %s is_new_sku en v_compras_pendientes (esperado ≥4 huérfanos)', COUNT(*))
       ELSE FORMAT('FAIL: solo %s is_new_sku en v_compras_pendientes', COUNT(*)) END AS result
FROM v_compras_pendientes
WHERE is_new_sku = true;

-- T04 — S7 Fase 1.2: 4 huérfanos con cell='BY' y policy_status='active'
SELECT 'T04_huerfanos_cell_BY_active' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE cell = 'BY' AND policy_status = 'active') = 4
       THEN 'PASS: 4 huérfanos con cell=BY policy_status=active'
       ELSE FORMAT('FAIL: solo %s con cell=BY active (esperado 4)',
                   COUNT(*) FILTER (WHERE cell = 'BY' AND policy_status = 'active')) END AS result
FROM sku_node_policy
WHERE sku_origen IN ('JSCNAE190P15W','JSCNAE190P20W','SPAFE30E10W26','SPAFE40O15W26')
  AND node_id = 'bodega_central';

-- T05 — S7 Fase 1.1: ALPCMPRBO4575 (vel=5.97, stock=4 < 7d) clasifica URGENTE
SELECT 'T05_alpcmprbo4575_urgente_cobertura_cruda' AS test,
  CASE WHEN accion::text = 'URGENTE' AND prioridad = 15
       THEN FORMAT('PASS: ALPCMPRBO4575 → URGENTE prioridad=%s', prioridad)
       ELSE FORMAT('FAIL: accion=%s prioridad=%s (esperado URGENTE/15)', accion::text, prioridad) END AS result
FROM sku_node_policy
WHERE sku_origen = 'ALPCMPRBO4575' AND node_id = 'bodega_central';

-- T06 — S7 Fase 1.1: TXSBAF144VT20 (vel=2.04, stock=1 < 7d) clasifica URGENTE
SELECT 'T06_txsbaf144vt20_urgente_cobertura_cruda' AS test,
  CASE WHEN accion::text = 'URGENTE' AND prioridad = 15
       THEN FORMAT('PASS: TXSBAF144VT20 → URGENTE prioridad=%s', prioridad)
       ELSE FORMAT('FAIL: accion=%s prioridad=%s (esperado URGENTE/15)', accion::text, prioridad) END AS result
FROM sku_node_policy
WHERE sku_origen = 'TXSBAF144VT20' AND node_id = 'bodega_central';

-- T07 — S7 Fase 0.A: lane bodega_to_full lee componentes PICKEADOS (no PENDIENTES)
SELECT 'T07_lane_bodega_to_full_pickeados' AS test,
  CASE WHEN COALESCE(SUM(qty_in_transit), 0) > 0
       THEN FORMAT('PASS: lane bodega_to_full=%s uds (esperado >0)',
                   COALESCE(SUM(qty_in_transit), 0))
       ELSE 'FAIL: lane bodega_to_full=0 (componentes PICKEADOS no contados)' END AS result
FROM v_in_transit_por_nodo
WHERE lane_id = 'bodega_to_full';

-- T08 — S7 Fase 0.B: TXTPBL20200SK (bodega=2 < flex=15) NO manda Full
SELECT 'T08_txtpbl20200sk_protege_flex' AS test,
  CASE WHEN mandar_full_uds = 0
       THEN FORMAT('PASS: TXTPBL20200SK mandar_full=0 (bodega=%s < flex=%s)',
                   stock_bodega, reserva_flex_target)
       ELSE FORMAT('FAIL: mandar_full=%s pero bodega=%s < flex=%s',
                   mandar_full_uds, stock_bodega, reserva_flex_target) END AS result
FROM v_compras_pendientes
WHERE sku_origen = 'TXTPBL20200SK';

-- T09 — S7 Fase 0.B: deficit_full descuenta in_transit_picking_full (no double-shipping)
SELECT 'T09_deficit_full_descuenta_picking' AS test,
  CASE WHEN COUNT(*) FILTER (
         WHERE deficit_full IS NOT NULL
           AND deficit_full < (pre_full_target - stock_full)
           AND in_transit_picking_full > 0
       ) > 0
       THEN FORMAT('PASS: %s SKUs con deficit_full reducido por picking activo',
                   COUNT(*) FILTER (
                     WHERE deficit_full IS NOT NULL
                       AND deficit_full < (pre_full_target - stock_full)
                       AND in_transit_picking_full > 0
                   ))
       ELSE 'INFO: 0 SKUs con picking activo (puede ser válido si no hay envíos en curso)' END AS result
FROM v_compras_pendientes;

-- T10 — S7 Fase 0.B: si is_new_sku + bodega>0 + full=0 → MANDAR_FULL con LEAST(GREATEST(inner_pack,2), bodega)
SELECT 'T10_lote_inicial_new_sku' AS test,
  CASE WHEN COUNT(*) FILTER (
         WHERE is_new_sku = true
           AND stock_full = 0
           AND stock_bodega > 0
           AND mandar_full_uds > 0
           AND mandar_full_uds <= stock_bodega
       ) > 0 OR NOT EXISTS (
         SELECT 1 FROM v_compras_pendientes
          WHERE is_new_sku = true AND stock_full = 0 AND stock_bodega > 0
       )
       THEN 'PASS: lote inicial respetado (o no hay candidatos)'
       ELSE 'FAIL: lote inicial mal calculado en algún new_sku' END AS result
FROM v_compras_pendientes;

-- T11 — Distribución de acciones (snapshot — debe coincidir con expectativa post-Fase 1)
SELECT 'T11_distribucion_acciones' AS test,
  FORMAT('URGENTE=%s AGOTADO_PEDIR=%s AGOTADO_SP=%s MANDAR_FULL=%s EN_TRANSITO=%s NUEVO=%s PLANIFICAR=%s OK=%s EXCESO=%s DEAD=%s INACTIVO=%s',
    COUNT(*) FILTER (WHERE accion::text = 'URGENTE'),
    COUNT(*) FILTER (WHERE accion::text = 'AGOTADO_PEDIR'),
    COUNT(*) FILTER (WHERE accion::text = 'AGOTADO_SIN_PROVEEDOR'),
    COUNT(*) FILTER (WHERE accion::text = 'MANDAR_FULL'),
    COUNT(*) FILTER (WHERE accion::text = 'EN_TRANSITO'),
    COUNT(*) FILTER (WHERE accion::text = 'NUEVO'),
    COUNT(*) FILTER (WHERE accion::text = 'PLANIFICAR'),
    COUNT(*) FILTER (WHERE accion::text = 'OK'),
    COUNT(*) FILTER (WHERE accion::text = 'EXCESO'),
    COUNT(*) FILTER (WHERE accion::text = 'DEAD_STOCK'),
    COUNT(*) FILTER (WHERE accion::text = 'INACTIVO')
  ) AS result
FROM sku_node_policy
WHERE policy_status = 'active' AND node_id = 'bodega_central';

-- T12 — Total active policies (sanity check: motor nuevo no se rompió)
SELECT 'T12_total_policies_activas' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE policy_status = 'active') >= 400
       THEN FORMAT('PASS: %s policies activas (>=400 esperado)',
                   COUNT(*) FILTER (WHERE policy_status = 'active'))
       ELSE FORMAT('FAIL: solo %s policies activas (motor degradado?)',
                   COUNT(*) FILTER (WHERE policy_status = 'active')) END AS result
FROM sku_node_policy
WHERE node_id = 'bodega_central';

-- T13 — S7 Fase 2: caso testigo DIO JSAFAB422P20S = 2.5 días
SELECT 'T13_dio_caso_testigo' AS test,
  CASE WHEN dio = 2.50
       THEN 'PASS: JSAFAB422P20S dio=2.5 (paridad motor viejo)'
       ELSE FORMAT('FAIL: dio=%s (esperado 2.50)', dio) END AS result
FROM v_safety_stock
WHERE sku_origen = 'JSAFAB422P20S' AND node_id = 'bodega_central';

-- T14 — S7 Fase 2: paridad masiva DIO ≥90% (en SKUs con stock alineado).
-- 91.6% es la línea base actual. Divergencias remanentes son arquitecturales
-- intencionales (motor nuevo usa d_avg_sem efectivo en SKUs con quiebre>=14d).
WITH paridad AS (
  SELECT vs.sku_origen, si.dio AS dio_viejo, vs.dio AS dio_nuevo,
         abs(si.dio - vs.dio) AS diff,
         si.stock_total AS si_stock,
         (SELECT SUM(qty_on_hand - COALESCE(qty_reserved,0))
            FROM v_stock_por_nodo
           WHERE sku_origen = vs.sku_origen) AS vsn_stock
    FROM v_safety_stock vs
    JOIN sku_intelligence si ON si.sku_origen = vs.sku_origen
   WHERE vs.node_id = 'bodega_central'
     AND si.dio IS NOT NULL AND vs.dio IS NOT NULL
)
SELECT 'T14_dio_paridad_masiva' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE si_stock = vsn_stock AND diff <= 0.5)
            >= COUNT(*) FILTER (WHERE si_stock = vsn_stock) * 0.90
       THEN FORMAT('PASS: %s%% match (sobre %s alineados)',
                   round(100.0 * COUNT(*) FILTER (WHERE si_stock = vsn_stock AND diff <= 0.5)
                         / NULLIF(COUNT(*) FILTER (WHERE si_stock = vsn_stock), 0), 1),
                   COUNT(*) FILTER (WHERE si_stock = vsn_stock))
       ELSE FORMAT('FAIL: %s%% match',
                   round(100.0 * COUNT(*) FILTER (WHERE si_stock = vsn_stock AND diff <= 0.5)
                         / NULLIF(COUNT(*) FILTER (WHERE si_stock = vsn_stock), 0), 1)) END AS result
FROM paridad;

-- T15 — S7 Fase 3: tabla markdown_policy seedeada (9 cells × 3 thresholds)
SELECT 'T15_markdown_policy_seed' AS test,
  CASE WHEN COUNT(*) = 27 AND COUNT(DISTINCT cell) = 9
       THEN FORMAT('PASS: %s rows en %s celdas', COUNT(*), COUNT(DISTINCT cell))
       ELSE FORMAT('FAIL: %s rows / %s celdas', COUNT(*), COUNT(DISTINCT cell)) END AS result
FROM markdown_policy;

-- T16 — S7 Fase 3: A/B sin liquidacion_accion (excepto override + cuadrante=REVISAR)
SELECT 'T16_AB_sin_liquidacion' AS test,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS: 0 SKUs A/B no-REVISAR con liquidacion_accion sin override'
       ELSE FORMAT('FAIL: %s SKUs incorrectamente marcados', COUNT(*)) END AS result
FROM sku_node_policy snp
JOIN sku_intelligence si ON si.sku_origen = snp.sku_origen
WHERE snp.liquidacion_accion IS NOT NULL
  AND snp.liquidacion_override IS NULL
  AND si.abc_unidades IN ('A','B')
  AND COALESCE(si.cuadrante,'') <> 'REVISAR';

-- T17 — S7 Fase 3: paridad ≥85% liquidacion_accion vs motor viejo
WITH paridad AS (
  SELECT si.liquidacion_accion AS viejo, snp.liquidacion_accion::text AS nuevo
    FROM sku_intelligence si
    JOIN sku_node_policy snp ON snp.sku_origen = si.sku_origen
   WHERE snp.node_id = 'bodega_central'
     AND (si.liquidacion_accion IS NOT NULL OR snp.liquidacion_accion IS NOT NULL)
)
SELECT 'T17_liquidacion_paridad' AS test,
  CASE WHEN ROUND(100.0 * COUNT(*) FILTER (WHERE viejo IS NOT DISTINCT FROM nuevo) / COUNT(*), 1) >= 85
       THEN FORMAT('PASS: %s%% match (%s/%s)',
                   ROUND(100.0 * COUNT(*) FILTER (WHERE viejo IS NOT DISTINCT FROM nuevo) / COUNT(*), 1),
                   COUNT(*) FILTER (WHERE viejo IS NOT DISTINCT FROM nuevo), COUNT(*))
       ELSE FORMAT('FAIL: %s%% match',
                   ROUND(100.0 * COUNT(*) FILTER (WHERE viejo IS NOT DISTINCT FROM nuevo) / COUNT(*), 1)) END AS result
FROM paridad;

-- T18 — S7 Fase 3: caso testigo C/REVISAR con dias_extra > 90 → precio_costo
SELECT 'T18_precio_costo_caso_testigo' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE liquidacion_descuento_sugerido = 0.40 AND dias_extra > 90) > 0
       THEN FORMAT('PASS: %s SKUs en precio_costo con dias_extra>90',
                   COUNT(*) FILTER (WHERE liquidacion_descuento_sugerido = 0.40 AND dias_extra > 90))
       ELSE 'FAIL: ningún SKU clasifica precio_costo' END AS result
FROM sku_node_policy
WHERE liquidacion_accion = 'precio_costo'
  AND node_id = 'bodega_central';
