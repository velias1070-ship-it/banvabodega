-- Sprint 9 Camino A — Tests invariantes combinados P1.8 + P5 + P1.10
-- batch:20260506-sprint-9-camino-a | sprint:9 | milestone:sprint-9-cell-sync-canon
--
-- TDD-style: estos 3 tests deben FALLAR antes del fix y PASAR a 0 post-fix.
-- Si fallan post-fix, no se promueve la migración.
--
-- T30: P1.8 — Pickings PENDIENTES descontados de mandar_full_uds.
--      Invariante: con picking PENDIENTE activo, mandar_full + ya_comprometido
--      no debe exceder deficit pre-pickeo (sin overshoot).
--      Caso testigo pre-fix: LITAF400G4PNG (16+19=35 > deficit 19) FAIL.
--      Post-fix: mandar_full pasa de 19 a 3, total 16+3=19 = deficit. PASS.
--
-- T31: P1.10 — Pickings COMPLETADA recientes cuentan en in_transit_picking_full
--      Invariante: SKUs en pickings COMPLETADA <5d deben estar en
--      in_transit_picking_full O ya reflejados en stock_full (lag ML).
--      Caso testigo pre-fix: ae0547bc (49 SKUs, 426 uds invisibles) FAIL.
--      Post-fix: TTL=5d en filtro v_in_transit_por_nodo. PASS.
--
-- T32: P5 — SKUs activos con bodega vacía aparecen en compras
--      Invariante: SKUs con uds_30d_real > 0 + stock_bodega < target_bodega_minimo
--      deben aparecer en v_compras_pendientes con qty > 0.
--      Caso testigo pre-fix: XYCMN405 (qty NULL) FAIL.
--      Post-fix: 4ta rama OR + qty_raw extendido con deficit_bodega. PASS.

-- ─────────────────────────────────────────────────────────────────────
-- T30: P1.8 — pickings PENDIENTES no causan overshoot Full
-- ─────────────────────────────────────────────────────────────────────

-- El invariante real: el motor NO debe agregar mandar_full por encima del
-- déficit no cubierto por el picking pendiente.  Si el picking pendiente
-- ya excede el déficit pre-pickeo, eso es overshoot del picking
-- pre-existente (no del motor) y mandar_full debe ser 0.
WITH t30 AS (
  SELECT COUNT(*) AS skus_overshoot_picking_pendiente
  FROM v_compras_pendientes vcp
  WHERE COALESCE(vcp.qty_picking_pendiente_full, 0) > 0
    AND vcp.mandar_full_uds
        > GREATEST(0,
            (vcp.pre_full_target - vcp.stock_full)
            - COALESCE(vcp.qty_picking_pendiente_full, 0)
          )
)
SELECT
  'T30_picking_pendiente_no_overshoot'::text AS test_name,
  skus_overshoot_picking_pendiente AS valor,
  0 AS esperado,
  CASE WHEN skus_overshoot_picking_pendiente = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t30;

-- ─────────────────────────────────────────────────────────────────────
-- T31: P1.10 — pickings COMPLETADA recientes (<5d) cuentan in_transit
-- ─────────────────────────────────────────────────────────────────────

WITH completada_reciente AS (
  SELECT
    UPPER(TRIM(comp.value->>'skuOrigen')) AS sku_origen,
    SUM((comp.value->>'unidades')::int) AS uds_completadas
  FROM picking_sessions ps,
       jsonb_array_elements(ps.lineas) linea(value),
       jsonb_array_elements(linea.value->'componentes') comp(value)
  WHERE ps.tipo = 'envio_full'
    AND ps.estado = 'COMPLETADA'
    AND ps.completed_at >= NOW() - INTERVAL '5 days'
    AND comp.value->>'estado' = 'PICKEADO'
    AND comp.value->>'skuOrigen' IS NOT NULL
  GROUP BY UPPER(TRIM(comp.value->>'skuOrigen'))
), t31 AS (
  SELECT COUNT(*) AS skus_completada_invisible
  FROM completada_reciente cr
  LEFT JOIN v_in_transit_por_nodo v ON v.sku_origen = cr.sku_origen
                                    AND v.to_node_id = 'full_ml'
  WHERE COALESCE(v.qty_in_transit, 0) < cr.uds_completadas
)
SELECT
  'T31_picking_completada_visible_TTL5d'::text AS test_name,
  skus_completada_invisible AS valor,
  0 AS esperado,
  CASE WHEN skus_completada_invisible = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t31;

-- ─────────────────────────────────────────────────────────────────────
-- T32: P5 — SKUs con bodega vacía + ventas activas en v_compras_pendientes
-- ─────────────────────────────────────────────────────────────────────

WITH t32 AS (
  SELECT COUNT(*) AS skus_bodega_vacia_invisible
  FROM v_safety_stock vss
  JOIN sku_intelligence si ON si.sku_origen = vss.sku_origen
  LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vss.sku_origen
  LEFT JOIN v_stock_por_nodo vsn ON vsn.sku_origen = vss.sku_origen
                                  AND vsn.node_id = 'bodega_central'
  WHERE vss.node_id = 'bodega_central'
    AND vss.policy_status = 'active'
    AND COALESCE(si.uds_30d, 0) > 0
    -- Bodega bajo target_bodega_minimo (cycle_stock + reserva_flex):
    -- Bodega + OC en tránsito bajo target_bodega_minimo (cycle_stock + reserva_flex):
    AND (COALESCE(vsn.qty_on_hand, 0) - COALESCE(vsn.qty_reserved, 0)
         + COALESCE(vcp.in_transit_oc_bodega, 0))
        < (vss.reserva_flex_target + ROUND(vss.d_avg_dia * vss.lt_dias))
    -- Pero invisible o sin compra propuesta:
    AND (vcp.sku_origen IS NULL
         OR COALESCE(vcp.qty_a_comprar, 0) = 0)
)
SELECT
  'T32_bodega_vacia_visible_compras'::text AS test_name,
  skus_bodega_vacia_invisible AS valor,
  0 AS esperado,
  CASE WHEN skus_bodega_vacia_invisible = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t32;
