-- Sprint 7 Fase 0.B — extender mandar_full_uds para SKUs operativos
-- batch:20260505-sprint-7-fase0 | sprint:7 | fase:0b
--
-- Reemplaza la rama única de is_new_sku por un decision tree:
--   1. Lote inicial nuevos: LEAST(GREATEST(inner_pack,2), stock_bodega).
--   2. Operativos vel>0: LEAST(deficit_full, stock_bodega - reserva_flex).
--      donde deficit_full = pre_full_target - stock_full - in_transit_picking_full
--      (descuenta envíos en camino para no double-shipear).
--   3. ELSE 0.
--
-- Doctrina: nunca dejar bodega < reserva_flex_target (excepto lote inicial).

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;

CREATE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
    SELECT v.sku_origen,
           sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total,
           sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bodega,
           sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml'::text) AS stock_full,
           sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bruto_bodega,
           sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS qty_reserved_bodega
      FROM v_stock_por_nodo v GROUP BY v.sku_origen
), en_transito AS (
    SELECT v.sku_origen,
           sum(v.qty_in_transit) AS in_transit_total,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
      FROM v_in_transit_por_nodo v GROUP BY v.sku_origen
), pre_full_por_sku AS (
    SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'::text
), reserva_flex_por_sku AS (
    SELECT s.sku_origen, s.reserva_flex_target FROM v_safety_stock s WHERE s.node_id = 'bodega_central'::text
), inner_packs AS (
    SELECT p.sku, COALESCE(pc.inner_pack, p.inner_pack, 1) AS inner_pack
      FROM productos p
      LEFT JOIN proveedor_catalogo pc ON pc.sku_origen = p.sku AND pc.proveedor_id = p.proveedor_id
), policy_bodega AS (
    SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad
      FROM sku_node_policy snp WHERE snp.node_id = 'bodega_central'::text
), qty_calc AS (
    SELECT ss.sku_origen,
           GREATEST(0::numeric,
                    (COALESCE(ss.safety_stock,0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
                    - COALESCE(st.stock_total, 0::numeric) - COALESCE(et.in_transit_total, 0::numeric)) AS qty_raw,
           ip.inner_pack
      FROM v_safety_stock ss
      LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
      LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
      LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
      LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
      LEFT JOIN inner_packs ip ON ip.sku = ss.sku_origen
     WHERE ss.node_id = 'bodega_central'::text
)
SELECT ss.sku_origen, p.nombre,
       ss.cell, ss.cell_original,
       ss.tendencia, ss.promocion_activa, ss.promocion_motivo,
       ss.policy_action, ss.xyz_confidence, ss.seasonal_match_source,
       ss.z, ss.lt_dias, ss.d_avg_dia,
       ss.cycle_stock, ss.safety_stock, ss.reorder_point,
       COALESCE(pf.pre_full_target, 0) AS pre_full_target,
       COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
       COALESCE(st.stock_total, 0::numeric) AS stock_total,
       COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
       COALESCE(st.stock_full, 0::numeric) AS stock_full,
       COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
       COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
       qc.qty_raw,
       COALESCE(ip.inner_pack, 1) AS inner_pack,
       CASE WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
            THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
            ELSE qc.qty_raw END AS qty_a_comprar,
       (CASE WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
             THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
             ELSE qc.qty_raw END - qc.qty_raw) AS delta_pack,
       CASE WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
            ELSE (CASE WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
                       THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
                       ELSE qc.qty_raw END) * p.costo_promedio
       END AS clp_estimado,
       CASE WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
            ELSE NULL::numeric END AS dias_cobertura_actual,
       CASE WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
                 < (COALESCE(ss.safety_stock,0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
            THEN true ELSE false END AS bajo_rop,
       p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
       ss.es_quiebre_proveedor, ss.vel_pre_quiebre, ss.vel_actual,
       ss.factor_rampup_aplicado, ss.rampup_motivo,
       ss.evento_activo, ss.multiplicador_evento,
       ss.target_dias_flex, ss.flex_priority,
       COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
       COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
       COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
       COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
       COALESCE(pb.is_new_sku, false) AS is_new_sku,
       pb.accion AS accion_nueva,
       pb.prioridad AS prioridad_nueva,
       -- deficit_full = pre_full_target - stock_full - in_transit_picking_full
       GREATEST(
         0::numeric,
         COALESCE(pf.pre_full_target, 0)::numeric
           - COALESCE(st.stock_full, 0::numeric)
           - COALESCE(et.in_transit_picking_full, 0::numeric)
       ) AS deficit_full,
       -- disponible_para_full = stock_bodega - reserva_flex_target
       GREATEST(
         0::numeric,
         COALESCE(st.stock_bodega, 0::numeric)
           - COALESCE(rf.reserva_flex_target, 0)::numeric
       ) AS disponible_para_full,
       CASE
         -- 1. Lote inicial nuevos: LEAST(GREATEST(inner_pack,2), stock_bodega)
         WHEN COALESCE(pb.is_new_sku, false) = true
              AND COALESCE(st.stock_full, 0::numeric) = 0
              AND COALESCE(st.stock_bodega, 0::numeric) > 0
         THEN LEAST(GREATEST(COALESCE(ip.inner_pack, 1), 2)::numeric,
                    COALESCE(st.stock_bodega, 0::numeric))
         -- 2. Operativos vel>0: cubrir deficit_full sin agotar Flex
         WHEN COALESCE(ss.vel_actual, 0::numeric) > 0::numeric
              AND GREATEST(0::numeric,
                    COALESCE(pf.pre_full_target, 0)::numeric
                      - COALESCE(st.stock_full, 0::numeric)
                      - COALESCE(et.in_transit_picking_full, 0::numeric)
                  ) > 0::numeric
              AND GREATEST(0::numeric,
                    COALESCE(st.stock_bodega, 0::numeric)
                      - COALESCE(rf.reserva_flex_target, 0)::numeric
                  ) > 0::numeric
         THEN LEAST(
                CEIL(GREATEST(0::numeric,
                       COALESCE(pf.pre_full_target, 0)::numeric
                         - COALESCE(st.stock_full, 0::numeric)
                         - COALESCE(et.in_transit_picking_full, 0::numeric)
                     ))::numeric,
                GREATEST(0::numeric,
                       COALESCE(st.stock_bodega, 0::numeric)
                         - COALESCE(rf.reserva_flex_target, 0)::numeric)
              )
         ELSE 0::numeric
       END AS mandar_full_uds
  FROM v_safety_stock ss
  JOIN productos p ON p.sku = ss.sku_origen
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
  LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
  LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
  LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
  LEFT JOIN inner_packs ip ON ip.sku = ss.sku_origen
  LEFT JOIN policy_bodega pb ON pb.sku_origen = ss.sku_origen
  LEFT JOIN qty_calc qc ON qc.sku_origen = ss.sku_origen
 WHERE ss.node_id = 'bodega_central'::text
   AND (
     (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
       < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
     OR COALESCE(pb.is_new_sku, false)
   );

CREATE VIEW v_reposicion_explain AS
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
     WHERE oc.estado = 'RECIBIDA_PARCIAL'::text
       AND oc.fecha_recepcion IS NOT NULL AND oc.lead_time_real IS NOT NULL
     ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
), quiebre_por_nodo AS (
    SELECT s.sku_origen,
           max(s.fecha) FILTER (WHERE s.stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
           max(s.fecha) FILTER (WHERE s.stock_full > 0) AS ultimo_dia_full_con_stock,
           min(s.fecha) AS primer_snapshot_sku
      FROM stock_snapshots s GROUP BY s.sku_origen
), in_transit_split AS (
    SELECT v.sku_origen,
           sum(v.qty_in_transit) AS in_transit_total,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
      FROM v_in_transit_por_nodo v GROUP BY v.sku_origen
)
SELECT vsf.sku_origen, p.nombre, p.categoria, p.proveedor_id,
       pr.nombre_canonico AS proveedor_nombre,
       vsf.cell, vsf.cell_original, vsf.policy_action,
       pt.service_level AS sl_template, pt.z_value AS z_template,
       pt.target_dias_full AS target_dias_template,
       pt.target_dias_flex AS target_dias_flex_template,
       pt.source_ref AS template_fuente,
       si.vel_ponderada AS vel_decl_sem,
       si.vel_7d AS vel_7d_decl, si.vel_30d AS vel_30d_decl, si.vel_60d AS vel_60d_decl,
       vsf.d_avg_dia AS vel_decl_dia,
       COALESCE(v30.vel_real_dia, 0::numeric) AS vel_real_dia,
       COALESCE(v30.vel_real_sem, 0::numeric) AS vel_real_sem,
       COALESCE(v30.uds_30d_real, 0::numeric) AS uds_30d_real,
       COALESCE(v30.num_ordenes_30d, 0::bigint) AS num_ordenes_30d,
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN NULL::numeric
            ELSE round((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada * 100::numeric, 1)
       END AS vel_drift_pct,
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 'sin_baseline'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'::text
            ELSE 'drift_high'::text
       END AS vel_drift_status,
       vsf.lt_dias AS lt_decl, vsf.sigma_lt AS sigma_lt_decl,
       uo.lt_real_ultimo_oc_dias, uo.ultimo_oc_fecha_emision,
       uo.ultimo_oc_fecha_recepcion, uo.ultimo_oc_numero,
       CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'::text
            WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'::text
            ELSE 'drift'::text
       END AS lt_drift_status,
       vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
       vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
       COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
       vsf.reserva_flex_target,
       vsf.xyz_confidence,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) AS stock_bodega,
       COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
       COALESCE(its.in_transit_total, 0::numeric) AS in_transit_bodega,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text ELSE 'OK'::text END AS quiebre_bodega_estado,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku END AS quiebre_bodega_fecha,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer END AS quiebre_bodega_dias,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text ELSE 'OK'::text END AS quiebre_full_estado,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku END AS quiebre_full_fecha,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer END AS quiebre_full_dias,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
            THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric
            THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
            THEN ('Full quebrado: armar envío Bodega->Full hoy. Tenes '::text || COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric)::text) || ' unidades disponibles'::text
            ELSE NULL::text END AS alerta_operativa,
       si.fecha_entrada_quiebre,
       CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
            ELSE EXTRACT(day FROM now() - si.fecha_entrada_quiebre::timestamp with time zone)::integer END AS dias_en_quiebre,
       p.costo_promedio, snp.manual_override, snp.policy_status, snp.seasonal_match_source,
       si.margen_neto_30d_imputed,
       vcp.qty_a_comprar, vcp.qty_raw, vcp.delta_pack, vcp.inner_pack,
       vcp.mandar_full_uds, vcp.is_new_sku,
       vcp.deficit_full, vcp.disponible_para_full,
       snp.dias_de_vida, snp.accion AS accion_nueva, snp.prioridad AS prioridad_nueva,
       vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
       si.accion, si.es_quiebre_proveedor, si.vel_pre_quiebre,
       si.factor_rampup_aplicado, si.rampup_motivo,
       si.evento_activo, si.multiplicador_evento, si.mandar_full,
       si.pedir_proveedor AS pedir_proveedor_motor_viejo,
       si.pedir_proveedor_sin_rampup,
       snp.target_dias_flex, snp.flex_priority,
       vsf.d_avg_sem AS d_avg_sem_efectivo,
       vsf.tendencia, COALESCE(snp.cell_efectiva, snp.cell) AS cell_efectiva,
       vsf.promocion_activa, vsf.promocion_motivo,
       snp.tendencia_updated_at,
       vtd.vel_recent_sem AS vel_28d_recent,
       vtd.vel_previous_sem AS vel_28d_previous,
       vtd.vel_baseline_sem AS vel_baseline_90d,
       vtd.ratio_recent_vs_previous, vtd.ratio_recent_vs_baseline,
       vtd.ratio_recent_vs_pre_quiebre,
       vtd.dias_stock_recent, vtd.dias_stock_previous,
       vtd.dias_quiebre_recent, vtd.dias_quiebre_previous,
       vtd.dias_total_recent, vtd.dias_total_previous,
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
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
  JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen AND snp.node_id = vsf.node_id
  LEFT JOIN policy_templates pt ON pt.cell = vsf.cell
  LEFT JOIN ventas_30d_real v30 ON v30.sku_origen = vsf.sku_origen
  LEFT JOIN ultimo_oc_real uo ON uo.sku_origen = vsf.sku_origen
  LEFT JOIN v_stock_por_nodo vsn_b ON vsn_b.sku_origen = vsf.sku_origen AND vsn_b.node_id = 'bodega_central'::text
  LEFT JOIN v_stock_por_nodo vsn_f ON vsn_f.sku_origen = vsf.sku_origen AND vsn_f.node_id = 'full_ml'::text
  LEFT JOIN in_transit_split its ON its.sku_origen = vsf.sku_origen
  LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vsf.sku_origen
  LEFT JOIN (SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'::text) pre_full ON pre_full.sku_origen = vsf.sku_origen
  LEFT JOIN quiebre_por_nodo qpn ON qpn.sku_origen = vsf.sku_origen
  LEFT JOIN v_trend_detection vtd ON vtd.sku_origen = vsf.sku_origen
 WHERE vsf.node_id = 'bodega_central'::text;
