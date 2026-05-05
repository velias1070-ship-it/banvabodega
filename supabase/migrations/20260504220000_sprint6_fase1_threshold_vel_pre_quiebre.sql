-- =============================================================================
-- Sprint 6 — Fase 1: Bajar umbral vel_pre_quiebre en v_safety_stock.demand_stats
-- =============================================================================
-- batch:20260504-sprint-6-cerrar-gap | sprint:6 | fase:1
--
-- Cambio en CTE demand_stats de v_safety_stock:
--   ANTES: WHEN si.es_quiebre_proveedor = true AND si.vel_pre_quiebre > 0
--             AND si.vel_pre_quiebre > (COALESCE(vel_ponderada,0) * 2)
--   DESPUES: WHEN si.dias_en_quiebre >= 14 AND si.vel_pre_quiebre > 0
--             AND si.vel_pre_quiebre > si.vel_ponderada
--
-- Justificacion (discovery 2026-05-04 PM):
--  - threshold 2× era demasiado estricto: TXV23QLAT20AQ (vel_pre 3.86 vs
--    vel_pond 2.14, ratio 1.8×) caia bajo el umbral y motor nuevo usaba 2.14
--    cuando deberia 3.86. Se alinea con motor viejo (intelligence.ts:1746-1752,
--    `dias_en_quiebre >= 14 AND vel_pre_quiebre > 2`).
--  - usar dias_en_quiebre >= 14 (objetivo) en lugar de es_quiebre_proveedor
--    (subjetivo) cuadra con la imputacion uds_30d del motor viejo.
--
-- CASCADE order: v_reposicion_explain → v_compras_pendientes → v_safety_stock.
-- Recreate order inverso. Definiciones de v_compras_pendientes y
-- v_reposicion_explain se preservan IDENTICAS (Sprint 5.5.5 / 5.5.4).
-- =============================================================================

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;
DROP VIEW IF EXISTS v_safety_stock CASCADE;

-- ----------------------------------------------------------------------------
-- v_safety_stock — recreada con CTE demand_stats Sprint 6 Fase 1
-- ----------------------------------------------------------------------------
CREATE VIEW v_safety_stock AS
WITH demand_stats AS (
    SELECT si.sku_origen,
           CASE
               -- Sprint 6 Fase 1: dias_en_quiebre>=14 + threshold 1× (alinea motor viejo)
               WHEN si.dias_en_quiebre >= 14
                    AND si.vel_pre_quiebre IS NOT NULL
                    AND si.vel_pre_quiebre > 0::numeric
                    AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0::numeric)
               THEN si.vel_pre_quiebre
               WHEN COALESCE(si.multiplicador_evento, 1.0) > 1::numeric
               THEN COALESCE(si.vel_ponderada, 0::numeric) * si.multiplicador_evento
               ELSE COALESCE(si.vel_ponderada, 0::numeric)
           END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
           COALESCE(NULLIF(si.desviacion_std, 0::numeric),
                    COALESCE(si.vel_ponderada, 0::numeric) * 0.3) AS sigma_sem,
           si.es_quiebre_proveedor,
           si.vel_pre_quiebre,
           si.vel_ponderada AS vel_actual,
           si.factor_rampup_aplicado,
           si.rampup_motivo,
           si.evento_activo,
           si.multiplicador_evento
      FROM sku_intelligence si
     -- Sprint 6 Fase 1: ampliar pre-filtro para no dejar fuera SKUs con
     -- dias_en_quiebre>=14 que sean elegibles por la rama nueva.
     WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric
        OR (si.dias_en_quiebre >= 14
            AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric)
), supplier_lt AS (
    SELECT p.sku, p.proveedor_id,
           COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
           COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
      FROM productos p
      LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'::text
), politica_efectiva AS (
    SELECT snp.sku_origen,
           snp.node_id,
           COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada,
           snp.cell AS cell_original,
           COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
           COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
           snp.target_dias_flex,
           snp.action,
           snp.xyz_confidence,
           snp.seasonal_match_source,
           snp.policy_status,
           snp.flex_priority,
           snp.tendencia,
           snp.promocion_activa,
           snp.promocion_motivo
      FROM sku_node_policy snp
      LEFT JOIN policy_templates pt_efectiva ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
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
               WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric
               THEN pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
               ELSE pe.z_value * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric) * power(d.sigma_sem / sqrt(7.0), 2::numeric)
                                      + power(d.d_avg_sem / 7.0, 2::numeric) * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric)) * 1.075
           END)::integer AS safety_stock,
       round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
       round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric)
             + pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
       CASE WHEN pe.node_id = 'full_ml'::text
            THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer
            ELSE 0 END AS pre_full_target,
       CASE WHEN pe.node_id = 'bodega_central'::text
            THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer
            ELSE 0 END AS reserva_flex_target,
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
       pe.flex_priority
  FROM politica_efectiva pe
  JOIN demand_stats d ON d.sku_origen = pe.sku_origen
  LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
 WHERE pe.policy_status = 'active'::text
   AND pe.action <> 'no_reorder'::policy_action_enum;

COMMENT ON VIEW v_safety_stock IS
'Sprint 6 Fase 1 (2026-05-04 PM): CTE demand_stats con threshold vel_pre_quiebre
 corregido. Cambio: dias_en_quiebre>=14 + vel_pre_quiebre>vel_ponderada (en
 lugar de es_quiebre_proveedor + threshold 2×). Discovery testigo
 TXV23QLAT20AQ. Doctrina alineada con motor viejo intelligence.ts:1746-1752.';

-- ----------------------------------------------------------------------------
-- v_compras_pendientes — recreada IDENTICA (Sprint 5.5.5)
-- ----------------------------------------------------------------------------
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
    SELECT s.sku_origen, s.pre_full_target
      FROM v_safety_stock s
     WHERE s.node_id = 'full_ml'::text
), reserva_flex_por_sku AS (
    SELECT s.sku_origen, s.reserva_flex_target
      FROM v_safety_stock s
     WHERE s.node_id = 'bodega_central'::text
)
SELECT ss.sku_origen,
       p.nombre,
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
       ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
       GREATEST(0::numeric,
                (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
                - COALESCE(st.stock_total, 0::numeric) - COALESCE(et.in_transit_total, 0::numeric)) AS qty_a_comprar,
       CASE WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
            ELSE GREATEST(0::numeric,
                (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
                - COALESCE(st.stock_total, 0::numeric) - COALESCE(et.in_transit_total, 0::numeric)) * p.costo_promedio
       END AS clp_estimado,
       CASE WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
            ELSE NULL::numeric END AS dias_cobertura_actual,
       CASE WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
                 < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
            THEN true ELSE false END AS bajo_rop,
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
       COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full
  FROM v_safety_stock ss
  JOIN productos p ON p.sku = ss.sku_origen
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
  LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
  LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
  LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
 WHERE ss.node_id = 'bodega_central'::text
   AND (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
       < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric;

COMMENT ON VIEW v_compras_pendientes IS
'Sprint 6 Fase 1 (2026-05-04 PM): recreada por CASCADE de v_safety_stock.
 Definicion identica a Sprint 5.5.5 v3.';

-- ----------------------------------------------------------------------------
-- v_reposicion_explain — recreada IDENTICA (Sprint 5.5.4)
-- ----------------------------------------------------------------------------
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
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
      FROM v_in_transit_por_nodo v
     GROUP BY v.sku_origen
)
SELECT vsf.sku_origen,
       p.nombre,
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
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN NULL::numeric
            ELSE round((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada * 100::numeric, 1)
       END AS vel_drift_pct,
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 'sin_baseline'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'::text
            ELSE 'drift_high'::text
       END AS vel_drift_status,
       vsf.lt_dias AS lt_decl,
       vsf.sigma_lt AS sigma_lt_decl,
       uo.lt_real_ultimo_oc_dias,
       uo.ultimo_oc_fecha_emision,
       uo.ultimo_oc_fecha_recepcion,
       uo.ultimo_oc_numero,
       CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'::text
            WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'::text
            ELSE 'drift'::text
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
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text
            ELSE 'OK'::text
       END AS quiebre_bodega_estado,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku
       END AS quiebre_bodega_fecha,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer
       END AS quiebre_bodega_dias,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text
            ELSE 'OK'::text
       END AS quiebre_full_estado,
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
       p.costo_promedio,
       snp.manual_override,
       snp.policy_status,
       snp.seasonal_match_source,
       si.margen_neto_30d_imputed,
       vcp.qty_a_comprar,
       vcp.clp_estimado,
       vcp.dias_cobertura_actual,
       vcp.bajo_rop,
       si.accion,
       si.es_quiebre_proveedor,
       si.vel_pre_quiebre,
       si.factor_rampup_aplicado,
       si.rampup_motivo,
       si.evento_activo,
       si.multiplicador_evento,
       si.mandar_full,
       si.pedir_proveedor AS pedir_proveedor_motor_viejo,
       si.pedir_proveedor_sin_rampup,
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

COMMENT ON VIEW v_reposicion_explain IS
'Sprint 6 Fase 1 (2026-05-04 PM): recreada por CASCADE. Definicion identica
 a Sprint 5.5.4.';
