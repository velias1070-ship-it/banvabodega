-- Sprint 8.5 v3 — cob_full restaurado en v_reposicion_explain (paridad 99.5%)
-- batch:20260505-sprint-85-cob-full | sprint:8.5 | hotfix:cob-full-restored
--
-- Hallazgo Sprint 8.5: dias_cobertura_actual (stock_total/d_avg_dia)
-- NO es 1:1 con cob_full legacy. Vicente usa cob_full operativamente
-- para decidir despacho urgente Bodega→Full.
--
-- Decisión owner: replicar fórmula motor viejo en v_reposicion_explain.
--
--   cob_full              = stock_full / (velFullCalc/7)  (días en nodo Full)
--   dias_cobertura_actual = stock_total / d_avg_dia       (días totales)
--
-- Iteraciones del fix:
--
--   v1 (descartado): stock_full / (d_avg_dia * 7) — d_avg_dia mide
--      demanda total, no full-only. 12.9% paridad.
--
--   v2 (descartado): stock_full / (vel_full/7) usando vel_full almacenado
--      en sku_intelligence. 18.1% paridad. Causa: vel_full está round2
--      (2 decimales) y para vel bajas (<1 uds/sem) round perdía precisión
--      vs el cálculo full-precision original.
--
--   v3 (vigente): stock_full / (velFullCalc/7) donde velFullCalc =
--      vel_ponderada * pct_full (o vel_ajustada_evento * pct_full si
--      multiplicador_evento>1). Mirror exacto motor viejo
--      intelligence.ts:1218,1221. 99.5% paridad (220/221) en pruebas
--      pre-deploy. El 1 outlier es drift real-time stock_full vs snapshot
--      (vsn_f.qty_on_hand ≠ sku_intelligence.stock_full por timing).
--
-- DROP CASCADE necesario porque v_sku_explanation depende de
-- v_reposicion_explain. Recreamos ambas (v_sku_explanation idéntica).
--
-- GAP DOCUMENTADO: quiebre Full prolongado + Flex vendiendo →
-- vel_ponderada*pct_full → 0 → cob_full=999 (centinela). Ningún motor
-- (viejo ni nuevo) cubre este caso. Sprint 9 candidato: vel_full_pre_quiebre.

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;

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
       -- Sprint 8.5 v3: cob_full = stock_full / (velFullCalc/7) donde
       -- velFullCalc = vel_ponderada * pct_full (o vel_ajustada_evento * pct_full
       -- si multiplicador_evento>1). Mirror motor viejo intelligence.ts:1218,1221
       -- (full precision antes del round). 99.5% paridad con sku_intelligence.cob_full.
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
