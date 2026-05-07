-- Cascada de nombre: proveedor_catalogo.nombre → productos.nombre
-- batch:20260507-nombre-cascade | sprint:9 | milestone:nombre-from-catalogo
--
-- Hoy v_compras_pendientes y v_reposicion_explain leen p.nombre directo de
-- productos.nombre. Si el operador edita el nombre desde "Catálogo de precios
-- acordados" (proveedor_catalogo.nombre), ese cambio NO se reflejaba en la
-- UI Pedido a Proveedor.
--
-- Cascada nueva (consistente con la del inner_pack ya existente):
--   1. proveedor_catalogo.nombre (donde el operador edita)
--   2. productos.nombre          (legacy / canónico de catálogo maestro)
--
-- Match: pc.sku_origen = p.sku AND pc.proveedor_id = p.proveedor_id
-- (catálogo del proveedor habitual del SKU). NULLIF para tratar string vacío
-- como ausente.
--
-- Regla 5 inventory-policy: fuente duplicada → cascada explícita documentada.

-- ─────────────────────────────────────────────────────────────────────
-- 1) v_compras_pendientes: agregar nombre a la CTE inner_packs (renombrar
--    a prod_catalog_meta), y reemplazar p.nombre en el SELECT.
-- ─────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;

CREATE OR REPLACE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT v.sku_origen,
    sum((v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric))) AS stock_total,
    sum((v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric))) FILTER (WHERE v.node_id = 'bodega_central') AS stock_bodega,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml') AS stock_full,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central') AS stock_bruto_bodega,
    sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central') AS qty_reserved_bodega
  FROM v_stock_por_nodo v
  GROUP BY v.sku_origen
), en_transito AS (
  SELECT v.sku_origen,
    sum(v.qty_in_transit) AS in_transit_total,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central') AS in_transit_oc_bodega,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml') AS in_transit_picking_full
  FROM v_in_transit_por_nodo v
  GROUP BY v.sku_origen
), pre_full_por_sku AS (
  SELECT s.sku_origen, s.pre_full_target
  FROM v_safety_stock s
  WHERE s.node_id = 'full_ml'
), reserva_flex_por_sku AS (
  SELECT s.sku_origen, s.reserva_flex_target
  FROM v_safety_stock s
  WHERE s.node_id = 'bodega_central'
),
-- Cascada catálogo → productos para inner_pack y nombre
prod_catalog_meta AS (
  SELECT p.sku,
    COALESCE(pc.inner_pack, p.inner_pack, 1) AS inner_pack,
    COALESCE(NULLIF(TRIM(pc.nombre), ''), p.nombre) AS nombre
  FROM productos p
  LEFT JOIN proveedor_catalogo pc
    ON pc.sku_origen = p.sku
   AND pc.proveedor_id = p.proveedor_id
), policy_bodega AS (
  SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad, snp.liquidacion_accion
  FROM sku_node_policy snp
  WHERE snp.node_id = 'bodega_central'
), pol_efectiva_compras AS (
  SELECT snp.sku_origen,
    COALESCE(pt_eff.action, snp.action) AS action_efectiva
  FROM sku_node_policy snp
  LEFT JOIN policy_templates pt_eff ON pt_eff.cell = COALESCE(snp.cell_efectiva, snp.cell)
  WHERE snp.node_id = 'bodega_central'
), picking_pendiente_full AS (
  SELECT upper(TRIM(BOTH FROM (comp.value ->> 'skuOrigen'))) AS sku_origen,
    sum(((comp.value ->> 'unidades'))::integer)::numeric AS qty_picking_pendiente_full
  FROM picking_sessions ps,
    LATERAL jsonb_array_elements(ps.lineas) linea(value),
    LATERAL jsonb_array_elements((linea.value -> 'componentes')) comp(value)
  WHERE ps.tipo = 'envio_full'
    AND ps.estado = ANY (ARRAY['ABIERTA','EN_PROCESO'])
    AND (comp.value ->> 'estado') = 'PENDIENTE'
    AND (comp.value ->> 'skuOrigen') IS NOT NULL
  GROUP BY upper(TRIM(BOTH FROM (comp.value ->> 'skuOrigen')))
), uds_30d_real_por_sku AS (
  SELECT cv.sku_origen,
    sum(vmc.cantidad)::numeric AS uds_30d_real
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= (CURRENT_DATE - 30) AND vmc.anulada = false
  GROUP BY cv.sku_origen
), target_bodega_calc AS (
  SELECT ss_1.sku_origen,
    (COALESCE(ss_1.reserva_flex_target, 0)::numeric + round((ss_1.d_avg_dia * ss_1.lt_dias))) AS target_bodega_minimo
  FROM v_safety_stock ss_1
  WHERE ss_1.node_id = 'bodega_central'
), tiene_stock_prov_por_sku AS (
  SELECT si.sku_origen, COALESCE(si.tiene_stock_prov, true) AS tiene_stock_prov
  FROM sku_intelligence si
), qty_calc AS (
  SELECT ss_1.sku_origen,
    GREATEST(
      ((COALESCE(ss_1.safety_stock,0) + COALESCE(pf_1.pre_full_target,0) + COALESCE(rf_1.reserva_flex_target,0))::numeric
        - COALESCE(st_1.stock_total, 0::numeric))
        - COALESCE(et_1.in_transit_total, 0::numeric),
      (COALESCE(tbc_1.target_bodega_minimo, 0::numeric) - COALESCE(st_1.stock_bodega, 0::numeric))
        - COALESCE(et_1.in_transit_oc_bodega, 0::numeric),
      0::numeric
    ) AS qty_raw,
    pcm_1.inner_pack
  FROM v_safety_stock ss_1
  LEFT JOIN stock_total_por_sku st_1 ON st_1.sku_origen = ss_1.sku_origen
  LEFT JOIN en_transito et_1 ON et_1.sku_origen = ss_1.sku_origen
  LEFT JOIN pre_full_por_sku pf_1 ON pf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN reserva_flex_por_sku rf_1 ON rf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN prod_catalog_meta pcm_1 ON pcm_1.sku = ss_1.sku_origen
  LEFT JOIN target_bodega_calc tbc_1 ON tbc_1.sku_origen = ss_1.sku_origen
  WHERE ss_1.node_id = 'bodega_central'
)
SELECT ss.sku_origen,
  pcm.nombre,
  ss.cell,
  ss.cell_original,
  ss.tendencia,
  ss.promocion_activa,
  ss.promocion_motivo,
  ss.policy_action,
  ss.xyz_confidence,
  ss.seasonal_match_source,
  ss.z,
  ss.lt_dias,
  ss.d_avg_dia,
  ss.cycle_stock,
  ss.safety_stock,
  ss.reorder_point,
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
  COALESCE(st.stock_total, 0::numeric) AS stock_total,
  COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
  COALESCE(st.stock_full, 0::numeric) AS stock_full,
  COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
  (COALESCE(ss.safety_stock,0) + COALESCE(pf.pre_full_target,0) + COALESCE(rf.reserva_flex_target,0)) AS stock_objetivo,
  qc.qty_raw,
  COALESCE(pcm.inner_pack, 1) AS inner_pack,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL
      AND pb.liquidacion_accion::text NOT IN ('monitorear','no_aplica') THEN 0::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric
      THEN ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric
    ELSE qc.qty_raw
  END AS qty_a_comprar,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL
      AND pb.liquidacion_accion::text NOT IN ('monitorear','no_aplica') THEN 0::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric
      THEN (ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric) - qc.qty_raw
    ELSE 0::numeric
  END AS delta_pack,
  CASE
    WHEN COALESCE(tsp.tiene_stock_prov, true) = false THEN 0::numeric
    WHEN pb.liquidacion_accion IS NOT NULL
      AND pb.liquidacion_accion::text NOT IN ('monitorear','no_aplica') THEN 0::numeric
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
    WHEN COALESCE(pcm.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric
      THEN (ceil(qc.qty_raw / pcm.inner_pack::numeric) * pcm.inner_pack::numeric) * p.costo_promedio
    ELSE qc.qty_raw * p.costo_promedio
  END AS clp_estimado,
  CASE
    WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
    ELSE NULL::numeric
  END AS dias_cobertura_actual,
  CASE
    WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
       < (COALESCE(ss.safety_stock,0) + COALESCE(pf.pre_full_target,0) + COALESCE(rf.reserva_flex_target,0))::numeric
      THEN true
    ELSE false
  END AS bajo_rop,
  p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre,
  ss.es_quiebre_proveedor,
  ss.vel_pre_quiebre,
  ss.vel_actual,
  ss.factor_rampup_aplicado,
  ss.rampup_motivo,
  ss.evento_activo,
  ss.multiplicador_evento,
  ss.target_dias_flex,
  ss.flex_priority,
  COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
  COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
  COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
  COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
  COALESCE(pb.is_new_sku, false) AS is_new_sku,
  pb.accion AS accion_nueva,
  pb.prioridad AS prioridad_nueva,
  GREATEST(0::numeric,
    ((COALESCE(pf.pre_full_target,0))::numeric - COALESCE(st.stock_full, 0::numeric)
     - COALESCE(et.in_transit_picking_full, 0::numeric))
     - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)
  ) AS deficit_full,
  GREATEST(0::numeric,
    (COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target,0)::numeric)
     - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)
  ) AS disponible_para_full,
  CASE
    WHEN COALESCE(pb.is_new_sku, false) = true
     AND COALESCE(st.stock_full, 0::numeric) = 0
     AND COALESCE(st.stock_bodega, 0::numeric) > 0
      THEN LEAST(GREATEST(COALESCE(pcm.inner_pack, 1), 2)::numeric, COALESCE(st.stock_bodega, 0::numeric))
    WHEN COALESCE(ss.vel_actual, 0::numeric) > 0
     AND GREATEST(0::numeric,
           ((COALESCE(pf.pre_full_target,0))::numeric - COALESCE(st.stock_full, 0::numeric)
            - COALESCE(et.in_transit_picking_full, 0::numeric))
            - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) > 0
     AND GREATEST(0::numeric,
           (COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target,0)::numeric)
            - COALESCE(pp.qty_picking_pendiente_full, 0::numeric)) > 0
      THEN LEAST(
        ceil(GREATEST(0::numeric,
          ((COALESCE(pf.pre_full_target,0))::numeric - COALESCE(st.stock_full, 0::numeric)
           - COALESCE(et.in_transit_picking_full, 0::numeric))
           - COALESCE(pp.qty_picking_pendiente_full, 0::numeric))),
        GREATEST(0::numeric,
          (COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target,0)::numeric)
           - COALESCE(pp.qty_picking_pendiente_full, 0::numeric))
      )
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
  AND pec.action_efectiva <> 'no_reorder'::policy_action_enum
  AND (
       (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
         < (COALESCE(ss.safety_stock,0) + COALESCE(pf.pre_full_target,0) + COALESCE(rf.reserva_flex_target,0))::numeric
    OR COALESCE(pb.is_new_sku, false)
    OR (
        COALESCE(st.stock_full, 0::numeric) < COALESCE(pf.pre_full_target,0)::numeric
        AND COALESCE(st.stock_bodega, 0::numeric) > COALESCE(rf.reserva_flex_target,0)::numeric
       )
    OR (
        COALESCE(st.stock_bodega, 0::numeric) < COALESCE(tbc.target_bodega_minimo, 0::numeric)
        AND COALESCE(udr.uds_30d_real, 0::numeric) > 0
       )
  );

-- ─────────────────────────────────────────────────────────────────────
-- 2) v_reposicion_explain: cascada también para nombre. JOIN nuevo a
--    proveedor_catalogo por (sku_origen, proveedor_id) y COALESCE.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  SELECT cv.sku_origen,
    sum(vmc.cantidad)::numeric AS uds_30d_real,
    count(DISTINCT vmc.order_id) AS num_ordenes_30d,
    sum(vmc.cantidad)::numeric / 30.0 AS vel_real_dia,
    sum(vmc.cantidad)::numeric * 7.0 / 30.0 AS vel_real_sem
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= (CURRENT_DATE - 30) AND vmc.anulada = false
  GROUP BY cv.sku_origen
), ultimo_oc_real AS (
  SELECT DISTINCT ON (ocl.sku_origen) ocl.sku_origen,
    oc.fecha_emision AS ultimo_oc_fecha_emision,
    oc.fecha_recepcion AS ultimo_oc_fecha_recepcion,
    oc.lead_time_real AS lt_real_ultimo_oc_dias,
    oc.numero AS ultimo_oc_numero
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
  WHERE oc.estado = 'RECIBIDA_PARCIAL'
    AND oc.fecha_recepcion IS NOT NULL
    AND oc.lead_time_real IS NOT NULL
  ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
), quiebre_por_nodo AS (
  SELECT s.sku_origen,
    max(s.fecha) FILTER (WHERE s.stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
    max(s.fecha) FILTER (WHERE s.stock_full > 0) AS ultimo_dia_full_con_stock,
    min(s.fecha) AS primer_snapshot_sku
  FROM stock_snapshots s
  GROUP BY s.sku_origen
), in_transit_split AS (
  SELECT v.sku_origen,
    sum(v.qty_in_transit) AS in_transit_total,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central') AS in_transit_oc_bodega,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml') AS in_transit_picking_full
  FROM v_in_transit_por_nodo v
  GROUP BY v.sku_origen
)
SELECT vsf.sku_origen,
  COALESCE(NULLIF(TRIM(pc.nombre), ''), p.nombre) AS nombre,
  p.categoria,
  p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre,
  vsf.cell,
  vsf.cell_original,
  vsf.policy_action,
  pt.service_level AS sl_template,
  pt.z_value AS z_template,
  pt.target_dias_full AS target_dias_template,
  pt.target_dias_flex AS target_dias_flex_template,
  pt.source_ref AS template_fuente,
  si.vel_ponderada AS vel_decl_sem,
  si.vel_7d AS vel_7d_decl,
  si.vel_30d AS vel_30d_decl,
  si.vel_60d AS vel_60d_decl,
  vsf.d_avg_dia AS vel_decl_dia,
  COALESCE(v30.vel_real_dia, 0::numeric) AS vel_real_dia,
  COALESCE(v30.vel_real_sem, 0::numeric) AS vel_real_sem,
  COALESCE(v30.uds_30d_real, 0::numeric) AS uds_30d_real,
  COALESCE(v30.num_ordenes_30d, 0::bigint) AS num_ordenes_30d,
  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN NULL::numeric
    ELSE round(((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) * 100::numeric, 1)
  END AS vel_drift_pct,
  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 'sin_baseline'
    WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'
    WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'
    ELSE 'drift_high'
  END AS vel_drift_status,
  vsf.lt_dias AS lt_decl,
  vsf.sigma_lt AS sigma_lt_decl,
  uo.lt_real_ultimo_oc_dias,
  uo.ultimo_oc_fecha_emision,
  uo.ultimo_oc_fecha_recepcion,
  uo.ultimo_oc_numero,
  CASE
    WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'
    WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'
    ELSE 'drift'
  END AS lt_drift_status,
  vsf.z,
  vsf.d_avg_sem,
  vsf.sigma_sem,
  vsf.sigma_dia,
  vsf.cycle_stock,
  vsf.safety_stock,
  vsf.reorder_point,
  COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
  vsf.reserva_flex_target,
  vsf.xyz_confidence,
  COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
  COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
  COALESCE(its.in_transit_total, 0::numeric) AS in_transit_bodega,
  vsf.dio,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) = 0 THEN 0::numeric
    WHEN si.pct_full IS NULL OR si.pct_full = 0::numeric THEN 999::numeric
    WHEN COALESCE(si.multiplicador_evento, 1::numeric) > 1::numeric AND COALESCE(si.vel_ajustada_evento, 0::numeric) > 0::numeric
      THEN round(COALESCE(vsn_f.qty_on_hand, 0::numeric) / (si.vel_ajustada_evento * si.pct_full / 7.0), 2)
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 999::numeric
    ELSE round(COALESCE(vsn_f.qty_on_hand, 0::numeric) / (si.vel_ponderada * si.pct_full / 7.0), 2)
  END AS cob_full,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0 THEN 'EN_QUIEBRE'
    ELSE 'OK'
  END AS quiebre_bodega_estado,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0 THEN NULL::date
    WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL
      THEN LEAST((qpn.ultimo_dia_bodega_con_stock + interval '1 day')::date, CURRENT_DATE)
    ELSE qpn.primer_snapshot_sku
  END AS quiebre_bodega_fecha,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0 THEN NULL::integer
    WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL
      THEN (CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + interval '1 day')::date, CURRENT_DATE))
    WHEN qpn.primer_snapshot_sku IS NOT NULL THEN (CURRENT_DATE - qpn.primer_snapshot_sku)
    ELSE NULL::integer
  END AS quiebre_bodega_dias,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0 THEN 'EN_QUIEBRE'
    ELSE 'OK'
  END AS quiebre_full_estado,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0 THEN NULL::date
    WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL
      THEN LEAST((qpn.ultimo_dia_full_con_stock + interval '1 day')::date, CURRENT_DATE)
    ELSE qpn.primer_snapshot_sku
  END AS quiebre_full_fecha,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0 THEN NULL::integer
    WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL
      THEN (CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + interval '1 day')::date, CURRENT_DATE))
    WHEN qpn.primer_snapshot_sku IS NOT NULL THEN (CURRENT_DATE - qpn.primer_snapshot_sku)
    ELSE NULL::integer
  END AS quiebre_full_dias,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0
     AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0
      THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0
     AND COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0
      THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'
    WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0
     AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0
      THEN 'Full quebrado: armar envío Bodega->Full hoy. Tenes ' || COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric)::text || ' unidades disponibles'
    ELSE NULL::text
  END AS alerta_operativa,
  si.fecha_entrada_quiebre,
  CASE
    WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
    ELSE EXTRACT(day FROM (now() - si.fecha_entrada_quiebre::timestamptz))::integer
  END AS dias_en_quiebre,
  p.costo_promedio,
  snp.manual_override,
  snp.policy_status,
  snp.seasonal_match_source,
  si.margen_neto_30d_imputed,
  vcp.qty_a_comprar,
  vcp.qty_raw,
  vcp.delta_pack,
  vcp.inner_pack,
  vcp.mandar_full_uds,
  vcp.is_new_sku,
  vcp.deficit_full,
  vcp.disponible_para_full,
  snp.dias_de_vida,
  snp.accion AS accion_nueva,
  snp.prioridad AS prioridad_nueva,
  snp.dias_extra,
  snp.liquidacion_accion,
  snp.liquidacion_descuento_sugerido,
  snp.liquidacion_override,
  COALESCE(va.alertas, ARRAY[]::text[]) AS alertas,
  COALESCE(va.alertas_count, 0::bigint)::integer AS alertas_count,
  vcp.clp_estimado,
  vcp.dias_cobertura_actual,
  vcp.bajo_rop,
  CASE
    WHEN vsf.d_avg_dia > 0::numeric
     AND ((COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric)
           + COALESCE(vsn_f.qty_on_hand, 0::numeric)) / vsf.d_avg_dia < 7::numeric
       OR COALESCE(vsf.dio, 999::numeric) < 14::numeric)
      THEN 'URGENTE'
    WHEN COALESCE(si.tiene_stock_prov, true) = false
     AND COALESCE(vcp.bajo_rop, false) = true
      THEN 'AGOTADO_SIN_PROVEEDOR'
    WHEN snp.liquidacion_accion IS NOT NULL
     AND snp.liquidacion_accion::text NOT IN ('monitorear','no_aplica')
      THEN 'LIQUIDACION'
    WHEN COALESCE(vcp.mandar_full_uds, 0::numeric) > 0::numeric THEN 'MANDAR_FULL'
    WHEN COALESCE(vcp.qty_a_comprar, 0::numeric) > 0::numeric
     AND COALESCE(si.tiene_stock_prov, true) = true
      THEN 'PEDIR_PROVEEDOR'
    WHEN COALESCE(its.in_transit_total, 0::numeric) > 0::numeric THEN 'EN_TRANSITO'
    WHEN COALESCE(vcp.bajo_rop, false) = true THEN 'PLANIFICAR'
    WHEN COALESCE(vcp.is_new_sku, false) = true THEN 'NUEVO'
    WHEN COALESCE(vsf.dio, 0::numeric) > 60::numeric THEN 'EXCESO'
    ELSE 'OK'
  END AS accion,
  si.accion AS accion_motor_viejo,
  si.es_quiebre_proveedor,
  si.vel_pre_quiebre,
  si.factor_rampup_aplicado,
  si.rampup_motivo,
  si.evento_activo,
  si.multiplicador_evento,
  si.mandar_full,
  si.pedir_proveedor AS pedir_proveedor_motor_viejo,
  si.pedir_proveedor_sin_rampup,
  si.tiene_stock_prov,
  snp.target_dias_flex,
  snp.flex_priority,
  vsf.d_avg_sem AS d_avg_sem_efectivo,
  vsf.tendencia,
  COALESCE(snp.cell_efectiva, snp.cell) AS cell_efectiva,
  vsf.promocion_activa,
  vsf.promocion_motivo,
  snp.tendencia_updated_at,
  vtd.vel_recent_sem AS vel_28d_recent,
  vtd.vel_previous_sem AS vel_28d_previous,
  vtd.vel_baseline_sem AS vel_baseline_90d,
  vtd.ratio_recent_vs_previous,
  vtd.ratio_recent_vs_baseline,
  vtd.ratio_recent_vs_pre_quiebre,
  vtd.dias_stock_recent,
  vtd.dias_stock_previous,
  vtd.dias_quiebre_recent,
  vtd.dias_quiebre_previous,
  vtd.dias_total_recent,
  vtd.dias_total_previous,
  vtd.uds_28d AS uds_ultimas_4_semanas,
  vtd.uds_28d_previas AS uds_4_semanas_previas,
  si.updated_at AS sku_intelligence_updated_at,
  snp.updated_at AS policy_updated_at,
  COALESCE(vsn_b.qty_on_hand, 0::numeric) AS stock_bruto_bodega,
  COALESCE(vsn_b.qty_reserved, 0::numeric) AS qty_reserved_bodega,
  COALESCE(its.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
  COALESCE(its.in_transit_picking_full, 0::numeric) AS in_transit_picking_full
FROM v_safety_stock vsf
JOIN productos p ON p.sku = vsf.sku_origen
LEFT JOIN proveedor_catalogo pc
  ON pc.sku_origen = p.sku
 AND pc.proveedor_id = p.proveedor_id
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen AND snp.node_id = vsf.node_id
LEFT JOIN policy_templates pt ON pt.cell = vsf.cell
LEFT JOIN ventas_30d_real v30 ON v30.sku_origen = vsf.sku_origen
LEFT JOIN ultimo_oc_real uo ON uo.sku_origen = vsf.sku_origen
LEFT JOIN v_stock_por_nodo vsn_b ON vsn_b.sku_origen = vsf.sku_origen AND vsn_b.node_id = 'bodega_central'
LEFT JOIN v_stock_por_nodo vsn_f ON vsn_f.sku_origen = vsf.sku_origen AND vsn_f.node_id = 'full_ml'
LEFT JOIN in_transit_split its ON its.sku_origen = vsf.sku_origen
LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vsf.sku_origen
LEFT JOIN (
  SELECT s.sku_origen, s.pre_full_target
  FROM v_safety_stock s
  WHERE s.node_id = 'full_ml'
) pre_full ON pre_full.sku_origen = vsf.sku_origen
LEFT JOIN quiebre_por_nodo qpn ON qpn.sku_origen = vsf.sku_origen
LEFT JOIN v_trend_detection vtd ON vtd.sku_origen = vsf.sku_origen
LEFT JOIN v_sku_alertas va ON va.sku_origen = vsf.sku_origen
WHERE vsf.node_id = 'bodega_central';

COMMENT ON VIEW v_compras_pendientes IS
  'Necesidades de compra. nombre+inner_pack con cascada proveedor_catalogo→productos.';
COMMENT ON VIEW v_reposicion_explain IS
  'Explicabilidad reposición. nombre con cascada proveedor_catalogo→productos (mismo patrón que v_compras_pendientes).';
