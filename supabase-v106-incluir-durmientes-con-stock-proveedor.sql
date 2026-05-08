-- ============================================================================
-- BANVA BODEGA — v106: motor incluye SKUs durmientes con stock_proveedor>0
--
-- BUG: el motor (v_safety_stock, v_compras_pendientes) excluía SKUs con
-- celda CZ no_reorder por completo. SKUs que vendieron en el pasado, se
-- agotaron, ML pausó la publicación, y el proveedor todavía los tiene
-- quedaban INVISIBLES en Inteligencia → Pedido a Proveedor.
--
-- CASO TESTIGO: JSECBQ002P20Z (Idetex), vel_pre_quiebre=1.88 uds/sem
-- (vendía bien), última venta hace 1d, stock=0 bodega+full, ML paused,
-- accion=AGOTADO_SIN_PROVEEDOR. Motor lo enterraba aunque la realidad
-- es que es una mina de oro pausada por out-of-stock.
--
-- CAUSA RAÍZ: dos filtros excluían CZ no_reorder:
--   v_safety_stock CTE demand_stats: WHERE vel_ponderada>0 OR ...
--   v_safety_stock final WHERE: action <> 'no_reorder' OR is_new_sku=true
--   v_compras_pendientes WHERE: pec.action_efectiva <> 'no_reorder'
--
-- FIX: agregar condición OR en cada filtro: si el SKU tiene
-- vel_pre_quiebre>0 (vendió histórico) Y proveedor_catalogo.stock_disponible>0
-- (proveedor lo tiene listo), considerarlo elegible para reposición.
--
-- ALCANCE: 1 SKU rescatado al 2026-05-08 (JSECBQ002P20Z URGENTE qty=4).
-- A medida que se cargue stock_disponible en proveedor_catalogo (manual o
-- via Excel proveedor), más SKUs durmientes entrarán automáticamente.
-- ============================================================================

CREATE OR REPLACE VIEW v_safety_stock AS
WITH demand_stats AS (
  SELECT si.sku_origen,
    CASE
      WHEN si.dias_en_quiebre >= 14 AND si.vel_pre_quiebre IS NOT NULL AND si.vel_pre_quiebre > 0::numeric AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0::numeric) THEN si.vel_pre_quiebre
      WHEN COALESCE(si.multiplicador_evento, 1.0) > 1::numeric THEN COALESCE(si.vel_ponderada, 0::numeric) * si.multiplicador_evento
      WHEN COALESCE(si.vel_ponderada, 0::numeric) = 0::numeric AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric AND (
        EXISTS (SELECT 1 FROM sku_node_policy snp WHERE snp.sku_origen = si.sku_origen AND snp.cell_efectiva LIKE '%\_alta\_vel' ESCAPE '\')
        -- v106: durmientes con stock proveedor usan vel_pre_quiebre como demanda
        OR EXISTS (SELECT 1 FROM proveedor_catalogo pc WHERE pc.sku_origen = si.sku_origen AND COALESCE(pc.stock_disponible, -1) > 0)
      ) THEN si.vel_pre_quiebre
      ELSE COALESCE(si.vel_ponderada, 0::numeric)
    END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
    COALESCE(NULLIF(si.desviacion_std, 0::numeric), COALESCE(si.vel_ponderada, 0::numeric) * 0.3) AS sigma_sem,
    si.es_quiebre_proveedor, si.vel_pre_quiebre, si.vel_ponderada AS vel_actual,
    si.factor_rampup_aplicado, si.rampup_motivo, si.evento_activo, si.multiplicador_evento
  FROM sku_intelligence si
  WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric
     OR (si.dias_en_quiebre >= 14 AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric)
     OR EXISTS (SELECT 1 FROM sku_node_policy snp WHERE snp.sku_origen = si.sku_origen AND snp.is_new_sku = true)
     OR (COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric
         AND EXISTS (SELECT 1 FROM sku_node_policy snp WHERE snp.sku_origen = si.sku_origen AND snp.cell_efectiva LIKE '%\_alta\_vel' ESCAPE '\'))
     -- v106: SKUs durmientes reactivables (vendieron histórico + proveedor con stock)
     OR (COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric
         AND EXISTS (SELECT 1 FROM proveedor_catalogo pc WHERE pc.sku_origen = si.sku_origen AND COALESCE(pc.stock_disponible, -1) > 0))
), supplier_lt AS (
  SELECT p.sku, p.proveedor_id,
    COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
    COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
  FROM productos p LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'::text
), politica_efectiva AS (
  SELECT snp.sku_origen, snp.node_id,
    COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada, snp.cell AS cell_original,
    COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
    COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
    snp.target_dias_flex,
    COALESCE(pt_efectiva.action, snp.action) AS action,
    snp.xyz_confidence, snp.seasonal_match_source, snp.policy_status,
    snp.flex_priority, snp.tendencia, snp.promocion_activa, snp.promocion_motivo, snp.is_new_sku
  FROM sku_node_policy snp
  LEFT JOIN policy_templates pt_efectiva ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
), stock_por_sku AS (
  SELECT v.sku_origen, sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total
  FROM v_stock_por_nodo v GROUP BY v.sku_origen
)
SELECT pe.sku_origen, pe.node_id, pe.cell_aplicada AS cell, pe.cell_original,
  pe.tendencia, pe.promocion_activa, pe.promocion_motivo, pe.action AS policy_action,
  pe.z_value AS z, d.d_avg_sem, d.d_avg_sem / 7.0 AS d_avg_dia,
  d.sigma_sem, d.sigma_sem / sqrt(7.0) AS sigma_dia,
  COALESCE(slt.lt_dias_avg, 14::numeric) AS lt_dias,
  COALESCE(slt.sigma_lt, 2::numeric) AS sigma_lt,
  round(CASE
    WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric THEN COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
    ELSE COALESCE(pe.z_value, 0::numeric) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric) * power(d.sigma_sem / sqrt(7.0), 2::numeric) + power(d.d_avg_sem / 7.0, 2::numeric) * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric)) * 1.075
  END)::integer AS safety_stock,
  round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
  round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric) + COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
  CASE WHEN pe.node_id = 'full_ml' THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer ELSE 0 END AS pre_full_target,
  CASE WHEN pe.node_id = 'bodega_central' THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer ELSE 0 END AS reserva_flex_target,
  pe.xyz_confidence, pe.seasonal_match_source, pe.policy_status,
  d.es_quiebre_proveedor, d.vel_pre_quiebre, d.vel_actual,
  d.factor_rampup_aplicado, d.rampup_motivo, d.evento_activo, d.multiplicador_evento,
  pe.target_dias_flex, pe.flex_priority,
  CASE WHEN d.d_avg_sem > 0::numeric AND COALESCE(sps.stock_total, 0::numeric) >= 0::numeric
       THEN round(COALESCE(sps.stock_total, 0::numeric) / (d.d_avg_sem / 7.0), 2)
       ELSE 999::numeric END AS dio
FROM politica_efectiva pe
JOIN demand_stats d ON d.sku_origen = pe.sku_origen
LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
LEFT JOIN stock_por_sku sps ON sps.sku_origen = pe.sku_origen
WHERE pe.policy_status = 'active'::text
  AND (
    pe.action <> 'no_reorder'::policy_action_enum
    OR pe.is_new_sku = true
    -- v106: SKUs no_reorder con vel histórica + stock proveedor entran al motor
    OR (d.vel_pre_quiebre > 0 AND EXISTS (
      SELECT 1 FROM proveedor_catalogo pc
      WHERE pc.sku_origen = pe.sku_origen AND COALESCE(pc.stock_disponible, -1) > 0
    ))
  );

-- v_compras_pendientes: relajar el filtro action_efectiva <> 'no_reorder'
-- también para incluir SKUs durmientes con stock proveedor disponible.
-- (cuerpo sin cambios respecto a v105, solo se modifica el WHERE final)

CREATE OR REPLACE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT v.sku_origen,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central') AS stock_bodega,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml') AS stock_full,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central') AS stock_bruto_bodega,
    sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central') AS qty_reserved_bodega
  FROM v_stock_por_nodo v GROUP BY v.sku_origen
), en_transito AS (
  SELECT v.sku_origen,
    sum(v.qty_in_transit) AS in_transit_total,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central') AS in_transit_oc_bodega,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml') AS in_transit_picking_full
  FROM v_in_transit_por_nodo v GROUP BY v.sku_origen
), pre_full_por_sku AS (
  SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'
), reserva_flex_por_sku AS (
  SELECT s.sku_origen, s.reserva_flex_target FROM v_safety_stock s WHERE s.node_id = 'bodega_central'
), prod_catalog_meta AS (
  SELECT p_1.sku,
    COALESCE(pc.inner_pack, p_1.inner_pack, 1) AS inner_pack,
    COALESCE(NULLIF(TRIM(BOTH FROM pc.nombre), ''), p_1.nombre) AS nombre
  FROM productos p_1 LEFT JOIN proveedor_catalogo pc ON pc.sku_origen = p_1.sku AND pc.proveedor_id = p_1.proveedor_id
), policy_bodega AS (
  SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad, snp.liquidacion_accion
  FROM sku_node_policy snp WHERE snp.node_id = 'bodega_central'
), pol_efectiva_compras AS (
  SELECT snp.sku_origen, COALESCE(pt_eff.action, snp.action) AS action_efectiva
  FROM sku_node_policy snp LEFT JOIN policy_templates pt_eff ON pt_eff.cell = COALESCE(snp.cell_efectiva, snp.cell)
  WHERE snp.node_id = 'bodega_central'
), picking_pendiente_full AS (
  SELECT upper(TRIM(BOTH FROM comp.value ->> 'skuOrigen')) AS sku_origen,
    sum((comp.value ->> 'unidades')::integer)::numeric AS qty_picking_pendiente_full
  FROM picking_sessions ps,
    LATERAL jsonb_array_elements(ps.lineas) linea(value),
    LATERAL jsonb_array_elements(linea.value -> 'componentes') comp(value)
  WHERE ps.tipo = 'envio_full' AND (ps.estado = ANY (ARRAY['ABIERTA','EN_PROCESO']))
    AND (comp.value ->> 'estado') = 'PENDIENTE' AND (comp.value ->> 'skuOrigen') IS NOT NULL
  GROUP BY (upper(TRIM(BOTH FROM comp.value ->> 'skuOrigen')))
), uds_30d_real_por_sku AS (
  SELECT cv.sku_origen, sum(vmc.cantidad)::numeric AS uds_30d_real
  FROM ventas_ml_cache vmc JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= (CURRENT_DATE - 30) AND vmc.anulada = false
  GROUP BY cv.sku_origen
), target_bodega_calc AS (
  SELECT ss_1.sku_origen,
    COALESCE(ss_1.reserva_flex_target, 0)::numeric + round(ss_1.d_avg_dia * ss_1.lt_dias) AS target_bodega_minimo
  FROM v_safety_stock ss_1 WHERE ss_1.node_id = 'bodega_central'
), tiene_stock_prov_por_sku AS (
  SELECT si.sku_origen, COALESCE(si.tiene_stock_prov, true) AS tiene_stock_prov FROM sku_intelligence si
), qty_calc AS (
  SELECT ss_1.sku_origen,
    GREATEST(
      (COALESCE(ss_1.safety_stock, 0) + COALESCE(pf_1.pre_full_target, 0) + COALESCE(rf_1.reserva_flex_target, 0))::numeric
        - COALESCE(st_1.stock_total, 0::numeric) - COALESCE(et_1.in_transit_total, 0::numeric),
      COALESCE(tbc_1.target_bodega_minimo, 0::numeric) - COALESCE(st_1.stock_bodega, 0::numeric) - COALESCE(et_1.in_transit_oc_bodega, 0::numeric),
      0::numeric
    ) AS qty_raw, pcm_1.inner_pack
  FROM v_safety_stock ss_1
    LEFT JOIN stock_total_por_sku st_1 ON st_1.sku_origen = ss_1.sku_origen
    LEFT JOIN en_transito et_1 ON et_1.sku_origen = ss_1.sku_origen
    LEFT JOIN pre_full_por_sku pf_1 ON pf_1.sku_origen = ss_1.sku_origen
    LEFT JOIN reserva_flex_por_sku rf_1 ON rf_1.sku_origen = ss_1.sku_origen
    LEFT JOIN prod_catalog_meta pcm_1 ON pcm_1.sku = ss_1.sku_origen
    LEFT JOIN target_bodega_calc tbc_1 ON tbc_1.sku_origen = ss_1.sku_origen
  WHERE ss_1.node_id = 'bodega_central'
)
SELECT ss.sku_origen, pcm.nombre, ss.cell, ss.cell_original, ss.tendencia, ss.promocion_activa, ss.promocion_motivo,
  ss.policy_action, ss.xyz_confidence, ss.seasonal_match_source, ss.z, ss.lt_dias, ss.d_avg_dia,
  ss.cycle_stock, ss.safety_stock, ss.reorder_point,
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
  COALESCE(st.stock_total, 0::numeric) AS stock_total,
  COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
  COALESCE(st.stock_full, 0::numeric) AS stock_full,
  COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
  COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
  qc.qty_raw, COALESCE(pcm.inner_pack, 1) AS inner_pack,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL AND (pb.liquidacion_accion::text <> ALL (ARRAY['monitorear','no_aplica'])) THEN 0::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric
    ELSE qc.qty_raw
  END AS qty_a_comprar,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL AND (pb.liquidacion_accion::text <> ALL (ARRAY['monitorear','no_aplica'])) THEN 0::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric - qc.qty_raw
    ELSE 0::numeric
  END AS delta_pack,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL AND (pb.liquidacion_accion::text <> ALL (ARRAY['monitorear','no_aplica'])) THEN 0::numeric
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric * p.costo_promedio
    ELSE qc.qty_raw * p.costo_promedio
  END AS clp_estimado,
  CASE WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia) ELSE NULL::numeric END AS dias_cobertura_actual,
  CASE WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric)) < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric THEN true ELSE false END AS bajo_rop,
  p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
  ss.es_quiebre_proveedor, ss.vel_pre_quiebre, ss.vel_actual, ss.factor_rampup_aplicado, ss.rampup_motivo,
  ss.evento_activo, ss.multiplicador_evento, ss.target_dias_flex, ss.flex_priority,
  COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
  COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
  COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
  COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
  COALESCE(pb.is_new_sku, false) AS is_new_sku,
  pb.accion AS accion_nueva, pb.prioridad AS prioridad_nueva,
  GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric) - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) AS deficit_full,
  GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) AS disponible_para_full,
  CASE
    WHEN COALESCE(pb.is_new_sku, false) = true AND COALESCE(st.stock_full, 0::numeric) = 0::numeric AND COALESCE(st.stock_bodega, 0::numeric) > 0::numeric THEN LEAST(GREATEST(COALESCE(pcm.inner_pack, 1), 2)::numeric, COALESCE(st.stock_bodega, 0::numeric))
    WHEN COALESCE(ss.vel_actual, 0::numeric) > 0::numeric AND GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric) - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) > 0::numeric AND GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) > 0::numeric THEN LEAST(ceil(GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric) - COALESCE(pp.qty_picking_pendiente_full, 0::numeric))), GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)))
    ELSE 0::numeric
  END AS mandar_full_uds,
  COALESCE(pp.qty_picking_pendiente_full, 0::numeric) AS qty_picking_pendiente_full,
  COALESCE(tbc.target_bodega_minimo, 0::numeric) AS target_bodega_minimo,
  COALESCE(udr.uds_30d_real, 0::numeric) AS uds_30d_real,
  COALESCE(tsp.tiene_stock_prov, true) AS tiene_stock_prov
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
LEFT JOIN prod_catalog_meta pcm ON pcm.sku = ss.sku_origen
LEFT JOIN policy_bodega pb ON pb.sku_origen = ss.sku_origen
LEFT JOIN pol_efectiva_compras pec ON pec.sku_origen = ss.sku_origen
LEFT JOIN qty_calc qc ON qc.sku_origen = ss.sku_origen
LEFT JOIN picking_pendiente_full pp ON pp.sku_origen = ss.sku_origen
LEFT JOIN target_bodega_calc tbc ON tbc.sku_origen = ss.sku_origen
LEFT JOIN uds_30d_real_por_sku udr ON udr.sku_origen = ss.sku_origen
LEFT JOIN tiene_stock_prov_por_sku tsp ON tsp.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'
  AND (
    pec.action_efectiva <> 'no_reorder'::policy_action_enum
    -- v106: SKUs no_reorder con stock proveedor disponible son elegibles
    OR EXISTS (SELECT 1 FROM proveedor_catalogo pc
               WHERE pc.sku_origen = ss.sku_origen AND COALESCE(pc.stock_disponible, -1) > 0)
  )
  AND (
    (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric)) < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
    OR COALESCE(pb.is_new_sku, false)
    OR (COALESCE(st.stock_full, 0::numeric) < COALESCE(pf.pre_full_target, 0)::numeric AND COALESCE(st.stock_bodega, 0::numeric) > COALESCE(rf.reserva_flex_target, 0)::numeric)
    OR (COALESCE(st.stock_bodega, 0::numeric) < COALESCE(tbc.target_bodega_minimo, 0::numeric) AND COALESCE(udr.uds_30d_real, 0::numeric) > 0::numeric)
    -- v106: SKUs durmientes con stock proveedor también son comprables
    OR EXISTS (SELECT 1 FROM proveedor_catalogo pc
               WHERE pc.sku_origen = ss.sku_origen AND COALESCE(pc.stock_disponible, -1) > 0)
  );
