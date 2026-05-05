-- Sprint 9 Prioridad 1 — sync cell_efectiva ↔ visibilidad
-- batch:20260505-sprint-9-cell-sync | sprint:9 | milestone:sprint-9-cell-sync-canon
--
-- PROBLEMA pre-Sprint 9:
-- - refresh_trend_in_sku_node_policy actualiza snp.cell_efectiva pero NO
--   reconcilia snp.action.
-- - v_safety_stock filtraba por snp.action (stale).
-- - Resultado: SKUs degradados (cell_efectiva peor que cell) seguían
--   comprables; SKUs promovidos (cell_efectiva mejor) quedaban invisibles.
--
-- FIX (opción d):
-- - v_safety_stock resuelve la action via JOIN a policy_templates por
--   COALESCE(cell_efectiva, cell). snp.action queda como cache informativo.
-- - v_compras_pendientes agrega CTE pol_efectiva_compras + filtro
--   `action_efectiva <> 'no_reorder'` para garantizar invariante T28
--   incluso cuando is_new_sku=true rescata el SKU en v_safety_stock.
-- - v_reposicion_explain y v_sku_explanation recreadas (DROP CASCADE).
--
-- INVARIANTES (tests/sql/regression_sprint9_cell_sync.sql):
-- - T28: degradados visibles en v_compras_pendientes = 0
-- - T29: promovidos invisibles en v_safety_stock = 0
--
-- Doctrina post-Sprint 9 P1 (declarada en docs/policies/motor-canonico.md):
-- policy_templates.action resuelto vía cell_efectiva es la SSoT de la acción
-- canónica. snp.action no es autoritativo.

DROP VIEW IF EXISTS v_safety_stock CASCADE;

CREATE VIEW v_safety_stock AS
 WITH demand_stats AS (
         SELECT si.sku_origen,
                CASE
                    WHEN si.dias_en_quiebre >= 14 AND si.vel_pre_quiebre IS NOT NULL AND si.vel_pre_quiebre > 0::numeric AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0::numeric) THEN si.vel_pre_quiebre
                    WHEN COALESCE(si.multiplicador_evento, 1.0) > 1::numeric THEN COALESCE(si.vel_ponderada, 0::numeric) * si.multiplicador_evento
                    ELSE COALESCE(si.vel_ponderada, 0::numeric)
                END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
            COALESCE(NULLIF(si.desviacion_std, 0::numeric), COALESCE(si.vel_ponderada, 0::numeric) * 0.3) AS sigma_sem,
            si.es_quiebre_proveedor,
            si.vel_pre_quiebre,
            si.vel_ponderada AS vel_actual,
            si.factor_rampup_aplicado,
            si.rampup_motivo,
            si.evento_activo,
            si.multiplicador_evento
           FROM sku_intelligence si
          WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric OR si.dias_en_quiebre >= 14 AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric OR (EXISTS ( SELECT 1
                   FROM sku_node_policy snp
                  WHERE snp.sku_origen = si.sku_origen AND snp.is_new_sku = true))
        ), supplier_lt AS (
         SELECT p.sku,
            p.proveedor_id,
            COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
            COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
           FROM productos p
             LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
          WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'::text
        ), politica_efectiva AS (
         -- Sprint 9 P1: action resuelto via cell_efectiva (no via snp.action stale).
         -- z_value y target_dias_full también vienen del template de cell_efectiva
         -- para coherencia: si el SKU degrada/promueve, sus metas (no solo su action)
         -- siguen la celda nueva.
         SELECT snp.sku_origen,
            snp.node_id,
            COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada,
            snp.cell AS cell_original,
            COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
            COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
            snp.target_dias_flex,
            COALESCE(pt_efectiva.action, snp.action) AS action,
            snp.xyz_confidence,
            snp.seasonal_match_source,
            snp.policy_status,
            snp.flex_priority,
            snp.tendencia,
            snp.promocion_activa,
            snp.promocion_motivo,
            snp.is_new_sku
           FROM sku_node_policy snp
             LEFT JOIN policy_templates pt_efectiva ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
        ), stock_por_sku AS (
         SELECT v.sku_origen,
            sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total
           FROM v_stock_por_nodo v
          GROUP BY v.sku_origen
        )
 SELECT pe.sku_origen,
    pe.node_id,
    pe.cell_aplicada AS cell,
    pe.cell_original,
    pe.tendencia,
    pe.promocion_activa,
    pe.promocion_motivo,
    pe.action AS policy_action,
    pe.z_value AS z,
    d.d_avg_sem,
    d.d_avg_sem / 7.0 AS d_avg_dia,
    d.sigma_sem,
    d.sigma_sem / sqrt(7.0) AS sigma_dia,
    COALESCE(slt.lt_dias_avg, 14::numeric) AS lt_dias,
    COALESCE(slt.sigma_lt, 2::numeric) AS sigma_lt,
    round(
        CASE
            WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric THEN COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
            ELSE COALESCE(pe.z_value, 0::numeric) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric) * power(d.sigma_sem / sqrt(7.0), 2::numeric) + power(d.d_avg_sem / 7.0, 2::numeric) * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric)) * 1.075
        END)::integer AS safety_stock,
    round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
    round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric) + COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
        CASE
            WHEN pe.node_id = 'full_ml'::text THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer
            ELSE 0
        END AS pre_full_target,
        CASE
            WHEN pe.node_id = 'bodega_central'::text THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer
            ELSE 0
        END AS reserva_flex_target,
    pe.xyz_confidence,
    pe.seasonal_match_source,
    pe.policy_status,
    d.es_quiebre_proveedor,
    d.vel_pre_quiebre,
    d.vel_actual,
    d.factor_rampup_aplicado,
    d.rampup_motivo,
    d.evento_activo,
    d.multiplicador_evento,
    pe.target_dias_flex,
    pe.flex_priority,
        CASE
            WHEN d.d_avg_sem > 0::numeric AND COALESCE(sps.stock_total, 0::numeric) >= 0::numeric THEN round(COALESCE(sps.stock_total, 0::numeric) / (d.d_avg_sem / 7.0), 2)
            ELSE 999::numeric
        END AS dio
   FROM politica_efectiva pe
     JOIN demand_stats d ON d.sku_origen = pe.sku_origen
     LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
     LEFT JOIN stock_por_sku sps ON sps.sku_origen = pe.sku_origen
  WHERE pe.policy_status = 'active'::text AND (pe.action <> 'no_reorder'::policy_action_enum OR pe.is_new_sku = true);

-- v_compras_pendientes: agrega filtro action_efectiva para invariante T28.
-- is_new_sku rescata visibilidad en v_safety_stock pero NO en compras
-- cuando cell_efectiva resuelve a no_reorder.
CREATE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT v.sku_origen,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bodega,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml'::text) AS stock_full,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bruto_bodega,
    sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS qty_reserved_bodega
  FROM v_stock_por_nodo v
  GROUP BY v.sku_origen
), en_transito AS (
  SELECT v.sku_origen,
    sum(v.qty_in_transit) AS in_transit_total,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
  FROM v_in_transit_por_nodo v
  GROUP BY v.sku_origen
), pre_full_por_sku AS (
  SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'::text
), reserva_flex_por_sku AS (
  SELECT s.sku_origen, s.reserva_flex_target FROM v_safety_stock s WHERE s.node_id = 'bodega_central'::text
), inner_packs AS (
  SELECT p_1.sku, COALESCE(pc.inner_pack, p_1.inner_pack, 1) AS inner_pack
  FROM productos p_1
  LEFT JOIN proveedor_catalogo pc ON pc.sku_origen = p_1.sku AND pc.proveedor_id = p_1.proveedor_id
), policy_bodega AS (
  SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad
  FROM sku_node_policy snp
  WHERE snp.node_id = 'bodega_central'::text
), pol_efectiva_compras AS (
  -- Sprint 9 P1: action efectiva resuelta vía cell_efectiva → policy_templates.
  -- Filtro WHERE final usa esto para ocultar degradados (cell_efectiva → no_reorder)
  -- aunque is_new_sku=true los rescate en v_safety_stock para visibilidad.
  SELECT snp.sku_origen,
    COALESCE(pt_eff.action, snp.action) AS action_efectiva
  FROM sku_node_policy snp
  LEFT JOIN policy_templates pt_eff ON pt_eff.cell = COALESCE(snp.cell_efectiva, snp.cell)
  WHERE snp.node_id = 'bodega_central'::text
), qty_calc AS (
  SELECT ss_1.sku_origen,
    GREATEST(0::numeric, (COALESCE(ss_1.safety_stock, 0) + COALESCE(pf_1.pre_full_target, 0) + COALESCE(rf_1.reserva_flex_target, 0))::numeric - COALESCE(st_1.stock_total, 0::numeric) - COALESCE(et_1.in_transit_total, 0::numeric)) AS qty_raw,
    ip_1.inner_pack
  FROM v_safety_stock ss_1
  LEFT JOIN stock_total_por_sku st_1 ON st_1.sku_origen = ss_1.sku_origen
  LEFT JOIN en_transito et_1 ON et_1.sku_origen = ss_1.sku_origen
  LEFT JOIN pre_full_por_sku pf_1 ON pf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN reserva_flex_por_sku rf_1 ON rf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN inner_packs ip_1 ON ip_1.sku = ss_1.sku_origen
  WHERE ss_1.node_id = 'bodega_central'::text
)
SELECT ss.sku_origen, p.nombre, ss.cell, ss.cell_original, ss.tendencia,
  ss.promocion_activa, ss.promocion_motivo, ss.policy_action, ss.xyz_confidence,
  ss.seasonal_match_source, ss.z, ss.lt_dias, ss.d_avg_dia, ss.cycle_stock,
  ss.safety_stock, ss.reorder_point,
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
  COALESCE(st.stock_total, 0::numeric) AS stock_total,
  COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
  COALESCE(st.stock_full, 0::numeric) AS stock_full,
  COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
  COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
  qc.qty_raw,
  COALESCE(ip.inner_pack, 1) AS inner_pack,
  CASE
    WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
    ELSE qc.qty_raw
  END AS qty_a_comprar,
  CASE
    WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
    ELSE qc.qty_raw
  END - qc.qty_raw AS delta_pack,
  CASE
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
    ELSE
    CASE
      WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
      ELSE qc.qty_raw
    END * p.costo_promedio
  END AS clp_estimado,
  CASE
    WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
    ELSE NULL::numeric
  END AS dias_cobertura_actual,
  CASE
    WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric)) < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric THEN true
    ELSE false
  END AS bajo_rop,
  p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre,
  ss.es_quiebre_proveedor, ss.vel_pre_quiebre, ss.vel_actual,
  ss.factor_rampup_aplicado, ss.rampup_motivo, ss.evento_activo, ss.multiplicador_evento,
  ss.target_dias_flex, ss.flex_priority,
  COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
  COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
  COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
  COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
  COALESCE(pb.is_new_sku, false) AS is_new_sku,
  pb.accion AS accion_nueva,
  pb.prioridad AS prioridad_nueva,
  GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric)) AS deficit_full,
  GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric) AS disponible_para_full,
  CASE
    WHEN COALESCE(pb.is_new_sku, false) = true AND COALESCE(st.stock_full, 0::numeric) = 0::numeric AND COALESCE(st.stock_bodega, 0::numeric) > 0::numeric THEN LEAST(GREATEST(COALESCE(ip.inner_pack, 1), 2)::numeric, COALESCE(st.stock_bodega, 0::numeric))
    WHEN COALESCE(ss.vel_actual, 0::numeric) > 0::numeric AND GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric)) > 0::numeric AND GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric) > 0::numeric THEN LEAST(ceil(GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric))), GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric))
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
LEFT JOIN pol_efectiva_compras pec ON pec.sku_origen = ss.sku_origen
LEFT JOIN qty_calc qc ON qc.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'::text
  AND pec.action_efectiva <> 'no_reorder'::policy_action_enum
  AND ((COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric)) < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
       OR COALESCE(pb.is_new_sku, false)
       OR (COALESCE(st.stock_full, 0::numeric) < COALESCE(pf.pre_full_target, 0)::numeric AND COALESCE(st.stock_bodega, 0::numeric) > COALESCE(rf.reserva_flex_target, 0)::numeric));

-- v_reposicion_explain: recreado verbatim post-CASCADE (sin cambios de lógica
-- propios de Sprint 9; consume v_safety_stock corregido).
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
   WHERE oc.estado = 'RECIBIDA_PARCIAL'::text AND oc.fecha_recepcion IS NOT NULL AND oc.lead_time_real IS NOT NULL
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
SELECT vsf.sku_origen, p.nombre, p.categoria, p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
       vsf.cell, vsf.cell_original, vsf.policy_action,
       pt.service_level AS sl_template, pt.z_value AS z_template,
       pt.target_dias_full AS target_dias_template, pt.target_dias_flex AS target_dias_flex_template,
       pt.source_ref AS template_fuente,
       si.vel_ponderada AS vel_decl_sem, si.vel_7d AS vel_7d_decl, si.vel_30d AS vel_30d_decl, si.vel_60d AS vel_60d_decl,
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
       uo.lt_real_ultimo_oc_dias, uo.ultimo_oc_fecha_emision, uo.ultimo_oc_fecha_recepcion, uo.ultimo_oc_numero,
       CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'::text
            WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'::text
            ELSE 'drift'::text
       END AS lt_drift_status,
       vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
       vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
       COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
       vsf.reserva_flex_target, vsf.xyz_confidence,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) AS stock_bodega,
       COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
       COALESCE(its.in_transit_total, 0::numeric) AS in_transit_bodega,
       vsf.dio,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) = 0::numeric THEN 0::numeric
            WHEN si.pct_full IS NULL OR si.pct_full = 0::numeric THEN 999::numeric
            WHEN COALESCE(si.multiplicador_evento, 1::numeric) > 1::numeric AND COALESCE(si.vel_ajustada_evento, 0::numeric) > 0::numeric THEN
              round((COALESCE(vsn_f.qty_on_hand, 0::numeric) / ((si.vel_ajustada_evento * si.pct_full) / 7.0))::numeric, 2)
            WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 999::numeric
            ELSE round((COALESCE(vsn_f.qty_on_hand, 0::numeric) / ((si.vel_ponderada * si.pct_full) / 7.0))::numeric, 2)
       END AS cob_full,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text ELSE 'OK'::text END AS quiebre_bodega_estado,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku
       END AS quiebre_bodega_fecha,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer
       END AS quiebre_bodega_dias,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text ELSE 'OK'::text END AS quiebre_full_estado,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku
       END AS quiebre_full_fecha,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer
       END AS quiebre_full_dias,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
              THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric
              THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
              THEN ('Full quebrado: armar envío Bodega->Full hoy. Tenes '::text || COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric)::text) || ' unidades disponibles'::text
            ELSE NULL::text
       END AS alerta_operativa,
       si.fecha_entrada_quiebre,
       CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
            ELSE EXTRACT(day FROM now() - si.fecha_entrada_quiebre::timestamp with time zone)::integer
       END AS dias_en_quiebre,
       p.costo_promedio, snp.manual_override, snp.policy_status, snp.seasonal_match_source,
       si.margen_neto_30d_imputed,
       vcp.qty_a_comprar, vcp.qty_raw, vcp.delta_pack, vcp.inner_pack, vcp.mandar_full_uds,
       vcp.is_new_sku, vcp.deficit_full, vcp.disponible_para_full,
       snp.dias_de_vida, snp.accion AS accion_nueva, snp.prioridad AS prioridad_nueva,
       snp.dias_extra, snp.liquidacion_accion, snp.liquidacion_descuento_sugerido, snp.liquidacion_override,
       COALESCE(va.alertas, ARRAY[]::text[]) AS alertas,
       COALESCE(va.alertas_count, 0)::integer AS alertas_count,
       vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
       si.accion, si.es_quiebre_proveedor, si.vel_pre_quiebre,
       si.factor_rampup_aplicado, si.rampup_motivo, si.evento_activo, si.multiplicador_evento,
       si.mandar_full, si.pedir_proveedor AS pedir_proveedor_motor_viejo, si.pedir_proveedor_sin_rampup,
       snp.target_dias_flex, snp.flex_priority,
       vsf.d_avg_sem AS d_avg_sem_efectivo, vsf.tendencia,
       COALESCE(snp.cell_efectiva, snp.cell) AS cell_efectiva,
       vsf.promocion_activa, vsf.promocion_motivo, snp.tendencia_updated_at,
       vtd.vel_recent_sem AS vel_28d_recent, vtd.vel_previous_sem AS vel_28d_previous,
       vtd.vel_baseline_sem AS vel_baseline_90d,
       vtd.ratio_recent_vs_previous, vtd.ratio_recent_vs_baseline, vtd.ratio_recent_vs_pre_quiebre,
       vtd.dias_stock_recent, vtd.dias_stock_previous,
       vtd.dias_quiebre_recent, vtd.dias_quiebre_previous,
       vtd.dias_total_recent, vtd.dias_total_previous,
       vtd.uds_28d AS uds_ultimas_4_semanas, vtd.uds_28d_previas AS uds_4_semanas_previas,
       si.updated_at AS sku_intelligence_updated_at, snp.updated_at AS policy_updated_at,
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
  LEFT JOIN v_sku_alertas va ON va.sku_origen = vsf.sku_origen
 WHERE vsf.node_id = 'bodega_central'::text;

CREATE VIEW v_sku_explanation AS
WITH oc_eta AS (
  SELECT DISTINCT ON (upper(ocl.sku_origen)) upper(ocl.sku_origen) AS sku_origen_u,
         oc.fecha_emision, oc.numero,
         ocl.cantidad_pedida - COALESCE(ocl.cantidad_recibida, 0) AS pendiente_uds
    FROM ordenes_compra_lineas ocl
    JOIN ordenes_compra oc ON oc.id = ocl.orden_id
   WHERE oc.estado <> 'ANULADA'::text AND COALESCE(ocl.cantidad_pedida, 0) > COALESCE(ocl.cantidad_recibida, 0) AND oc.fecha_emision IS NOT NULL
   ORDER BY upper(ocl.sku_origen), oc.fecha_emision DESC
), base AS (
  SELECT vre.*,
         COALESCE(vre.dias_en_quiebre, 0) >= 14 AND vre.vel_pre_quiebre IS NOT NULL AND vre.vel_pre_quiebre > COALESCE(vre.vel_decl_sem, 0::numeric) AS usa_pre_quiebre,
         CASE WHEN COALESCE(vre.in_transit_oc_bodega, 0::numeric) > 0::numeric AND oce.fecha_emision IS NOT NULL
              THEN oce.fecha_emision + COALESCE(vre.lt_decl, 7::numeric)::integer
              ELSE NULL::date
         END AS eta_oc,
         oce.numero AS eta_oc_numero
    FROM v_reposicion_explain vre
    LEFT JOIN oc_eta oce ON oce.sku_origen_u = upper(vre.sku_origen)
), exp AS (
  SELECT b.sku_origen,
         CASE WHEN b.evento_activo IS NOT NULL AND COALESCE(b.multiplicador_evento, 1::numeric) <> 1::numeric
                THEN format('vel=%s/d ajustada por evento ''%s'' (multiplicador %s)'::text, to_char(COALESCE(b.vel_decl_dia, 0::numeric), 'FM990.00'::text), b.evento_activo, to_char(b.multiplicador_evento, 'FM990.00'::text))
              WHEN b.usa_pre_quiebre
                THEN format('vel pre-quiebre %s/d > vel actual %s/d porque %s días en quiebre prolongado, motor usa el mayor para SS y ROP'::text, to_char(b.vel_pre_quiebre / 7.0, 'FM990.00'::text), to_char(COALESCE(b.vel_real_dia, 0::numeric), 'FM990.00'::text), b.dias_en_quiebre)
              ELSE format('vel=%s/d (declarada %s/d, drift %s)'::text, to_char(COALESCE(b.vel_real_dia, 0::numeric), 'FM990.00'::text), to_char(COALESCE(b.vel_decl_dia, 0::numeric), 'FM990.00'::text),
                CASE WHEN b.vel_drift_pct IS NULL THEN 'sin baseline'::text ELSE to_char(b.vel_drift_pct, 'FM990.0'::text) || '%'::text END)
         END AS explicacion_velocidad,
         CASE WHEN COALESCE(b.manual_override, false) THEN format('cell %s (override manual del owner)'::text, b.cell)
              WHEN COALESCE(b.cell_efectiva, b.cell) <> COALESCE(b.cell_original, b.cell) AND b.tendencia ~~ 'acelerando%'::text THEN format('cell %s ORIGINAL → %s EFECTIVA por trend %s (ratio %s vs baseline)'::text, b.cell_original, b.cell_efectiva, b.tendencia, to_char(COALESCE(b.ratio_recent_vs_baseline, 0::numeric), 'FM990.00'::text))
              WHEN COALESCE(b.cell_efectiva, b.cell) <> COALESCE(b.cell_original, b.cell) AND b.tendencia ~~ 'desacelerando%'::text THEN format('cell %s ORIGINAL → %s EFECTIVA por %s'::text, b.cell_original, b.cell_efectiva, b.tendencia)
              ELSE format('cell %s (target %sd Full, %sd Flex), z=%s'::text, b.cell, b.target_dias_template, COALESCE(b.target_dias_flex, b.target_dias_flex_template), to_char(COALESCE(b.z, 0::numeric), 'FM990.00'::text))
         END AS explicacion_celda,
         CASE WHEN COALESCE(b.dias_en_quiebre, 0) <= 0 THEN NULL::text
              ELSE format('%s días en quiebre. Causa: %s. Rampup factor: %s%s.'::text, b.dias_en_quiebre,
                  CASE WHEN COALESCE(b.es_quiebre_proveedor, false) THEN 'proveedor'::text ELSE 'propio'::text END,
                  to_char(COALESCE(b.factor_rampup_aplicado, 1::numeric), 'FM990.00'::text),
                  CASE WHEN b.rampup_motivo IS NOT NULL THEN (' ('::text || b.rampup_motivo) || ')'::text ELSE ''::text END)
         END AS explicacion_quiebre,
         format('stock_bodega %s = bruto %s - reservado %s%s. in_transit OC proveedor: %s uds%s.'::text,
              to_char(COALESCE(b.stock_bodega, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.stock_bruto_bodega, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.qty_reserved_bodega, 0::numeric), 'FM999990'::text),
              CASE WHEN COALESCE(b.in_transit_picking_full, 0::numeric) > 0::numeric THEN format(' (picking activo de %s uds hacia Full)'::text, to_char(b.in_transit_picking_full, 'FM999990'::text)) ELSE ''::text END,
              to_char(COALESCE(b.in_transit_oc_bodega, 0::numeric), 'FM999990'::text),
              CASE WHEN b.eta_oc IS NOT NULL THEN format(' (ETA %s, %s)'::text, b.eta_oc::text, COALESCE(b.eta_oc_numero, 'OC'::text)) ELSE ''::text END
         ) AS explicacion_compromisos,
         format('deficit Full = pre_full_target %s - stock_full %s - in_transit %s = %s. Disponible para Full = stock_bodega %s - reserva_flex %s = %s. mandar_full_uds = %s.\nqty_a_comprar = MAX(0, ROP %s - stock_total %s - in_transit_oc %s) = %s%s.'::text,
              to_char(COALESCE(b.pre_full_target, 0), 'FM999990'::text),
              to_char(COALESCE(b.stock_full, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.in_transit_picking_full, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.deficit_full, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.stock_bodega, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.reserva_flex_target, 0), 'FM999990'::text),
              to_char(COALESCE(b.disponible_para_full, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.mandar_full_uds, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.reorder_point, 0), 'FM999990'::text),
              to_char(COALESCE(b.stock_total, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.in_transit_oc_bodega, 0::numeric), 'FM999990'::text),
              to_char(COALESCE(b.qty_raw, 0::numeric), 'FM999990'::text),
              CASE WHEN COALESCE(b.delta_pack, 0::numeric) <> 0::numeric OR COALESCE(b.qty_a_comprar, 0::numeric) <> COALESCE(b.qty_raw, 0::numeric)
                   THEN format('. Redondeado a inner_pack %s: %s'::text, COALESCE(b.inner_pack, 1), to_char(COALESCE(b.qty_a_comprar, 0::numeric), 'FM999990'::text))
                   ELSE ''::text END
         ) AS explicacion_decision,
         CASE WHEN b.liquidacion_accion IS NULL THEN NULL::text
              ELSE format('dias_extra=%s (DIO %s - target_full %s). liquidacion_accion=''%s'', descuento sugerido %s%%%s.'::text,
                  COALESCE(b.dias_extra, 0),
                  to_char(COALESCE(b.dio, 0::numeric), 'FM999990.0'::text),
                  b.target_dias_template,
                  b.liquidacion_accion::text,
                  to_char(COALESCE(b.liquidacion_descuento_sugerido, 0::numeric) * 100::numeric, 'FM990'::text),
                  CASE WHEN b.liquidacion_override IS NOT NULL THEN ' (override owner)'::text ELSE ''::text END)
         END AS explicacion_liquidacion,
         CASE WHEN COALESCE(b.alertas_count, 0) = 0 THEN NULL::text
              ELSE ('Alertas activas: '::text || array_to_string(b.alertas, ', '::text)) || '.'::text
         END AS explicacion_alertas
    FROM base b
)
SELECT sku_origen,
       jsonb_strip_nulls(jsonb_build_object('velocidad', explicacion_velocidad, 'celda', explicacion_celda, 'quiebre', explicacion_quiebre, 'compromisos', explicacion_compromisos, 'decision', explicacion_decision, 'liquidacion', explicacion_liquidacion, 'alertas', explicacion_alertas)) AS explicacion,
       concat_ws(E'\n'::text, explicacion_velocidad, explicacion_celda, explicacion_quiebre, explicacion_compromisos, explicacion_decision, explicacion_liquidacion, explicacion_alertas) AS explicacion_texto
  FROM exp e;

COMMENT ON COLUMN v_reposicion_explain.cob_full IS
  'Sprint 8.5 v3: dias que dura stock_full a velocidad full. Formula mirror motor viejo: stock_full / (velFullCalc/7) donde velFullCalc = vel_ponderada * pct_full (o vel_ajustada_evento * pct_full si multiplicador_evento>1). 99.5% paridad con sku_intelligence.cob_full. GAP: quiebre Full prolongado + Flex vendiendo => vel_full=0 => cob_full=999. Sprint 9 candidato: vel_full_pre_quiebre. Para cobertura total Full+Bodega usar dias_cobertura_actual.';
