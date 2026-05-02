-- =============================================================================
-- Sprint 4.3a — Vistas: importar lógica del motor viejo al dashboard nuevo
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-04
-- Tag PR: [batch:20260504-1]
--
-- Decisión owner Opción B: el dashboard nuevo CONSUME del motor viejo, no
-- reinventa. Lectura directa de sku_intelligence para los campos críticos.
--
-- Bug detectado por owner: el dashboard nuevo sub-pide vs motor viejo en SKUs
-- en quiebre proveedor. Caso testigo TXV23QLAT20NG (Quilt Atenas 20P Negro AY):
--   Motor viejo: pedir_proveedor=78 (usa vel_pre_quiebre=10.57/sem)
--   Dashboard nuevo (Sprint 4.1): qty_a_comprar=27 (usa vel_ponderada=1.9/sem)
--   Dashboard nuevo (Sprint 4.3a): qty_a_comprar=86 (usa vel_pre + reserva_flex)
--
-- ── Velocidad efectiva (replica intelligence.ts:1943-1957) ───────────────────
-- v_safety_stock calcula d_avg_sem siguiendo la lógica del motor viejo:
--   1. base = vel_pre_quiebre cuando es_quiebre_proveedor=true Y vel_pre>0
--      Y vel_pre > vel_actual × 2 (replica rama 3 de
--      esQuiebreProlongadoProtegido).
--   2. ELSE base = vel_ponderada × multiplicador_evento  cuando mult > 1.
--   3. ELSE base = vel_ponderada.
--   4. × factor_rampup_aplicado (default 1.0).
-- NO se hace double-multiplicación vel_pre × evento_multiplicador (motor viejo
-- elige UNA: o vel_pre o vel_ajustada_evento, nunca multiplica las dos).
--
-- ── stock_objetivo en v_compras_pendientes ───────────────────────────────────
-- stock_objetivo = safety + pre_full + reserva_flex.
-- NO se suma cycle_stock porque pre_full_target (target_dias_full × vel/7,
-- típicamente 42d) ya cubre el período LT del proveedor (5d) — sumar
-- cycle_stock sería double-counting vs el motor viejo. cycle_stock se mantiene
-- como columna informativa (vel × LT_supplier) para transparencia. Esto sí
-- difiere del motor viejo en +reserva_flex (intencional: arquitectura nueva
-- exige Flex buffer explícito).
--
-- ── Reserva Flex separada ────────────────────────────────────────────────────
-- target_dias_flex × velocidad efectiva, suma al stock_objetivo de la fila
-- bodega_central (similar al fix Sprint 4.1 para pre_full_target).
--
-- DROP CASCADE necesario porque v_reposicion_explain + v_data_quality_drift
-- + v_alertas_quiebre + v_reposicion_dashboard dependen de v_safety_stock /
-- v_compras_pendientes y se les agregan columnas nuevas. Re-creamos las 5
-- vistas en orden inverso. Sin pérdida de datos (las vistas son derivadas).
--
-- [non-reversible:view-rebuild-add-columns-no-data-loss]
--
-- Validación: tests/sprint43a_validation.sql (7 tests).
-- =============================================================================

DROP VIEW IF EXISTS v_data_quality_drift;
DROP VIEW IF EXISTS v_reposicion_dashboard;
DROP VIEW IF EXISTS v_alertas_quiebre;
DROP VIEW IF EXISTS v_reposicion_explain;
DROP VIEW IF EXISTS v_compras_pendientes;
DROP VIEW IF EXISTS v_safety_stock;


-- =============================================================================
-- v_safety_stock — velocidad efectiva (replica motor viejo) + reserva_flex_target
-- =============================================================================
CREATE VIEW v_safety_stock AS
WITH demand_stats AS (
  -- Replica intelligence.ts:1943-1957 (motor viejo):
  --   velCalcR    = mult_evento>1 ? vel_ajustada_evento : vel_ponderada
  --   enQP_prov   = es_quiebre_proveedor AND vel_pre > vel_act × 2 AND vel_pre > 0
  --   velParaPedir = enQP_prov ? vel_pre : velCalcR
  -- × factor_rampup_aplicado (rampup.ts).
  -- NO se hace vel_pre × multiplicador_evento (one-of, no ambos).
  SELECT si.sku_origen,
    (CASE
      WHEN si.es_quiebre_proveedor = true
        AND si.vel_pre_quiebre IS NOT NULL
        AND si.vel_pre_quiebre > 0
        AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0) * 2
      THEN si.vel_pre_quiebre
      WHEN COALESCE(si.multiplicador_evento, 1.0) > 1
      THEN COALESCE(si.vel_ponderada, 0) * si.multiplicador_evento
      ELSE COALESCE(si.vel_ponderada, 0)
    END) * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
    COALESCE(NULLIF(si.desviacion_std, 0),
             COALESCE(si.vel_ponderada, 0) * 0.3) AS sigma_sem,
    si.es_quiebre_proveedor,
    si.vel_pre_quiebre,
    si.vel_ponderada AS vel_actual,
    si.factor_rampup_aplicado,
    si.rampup_motivo,
    si.evento_activo,
    si.multiplicador_evento
  FROM sku_intelligence si
  WHERE COALESCE(si.vel_ponderada, 0) > 0
     OR (si.es_quiebre_proveedor = true AND COALESCE(si.vel_pre_quiebre, 0) > 0)
),
supplier_lt AS (
  SELECT p.sku, p.proveedor_id,
    COALESCE(pr.lead_time_dias, p.lead_time_dias, 14) AS lt_dias_avg,
    COALESCE(pr.lead_time_sigma_dias, 2) AS sigma_lt
  FROM productos p
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL
)
SELECT
  snp.sku_origen, snp.node_id, snp.cell,
  snp.action AS policy_action, snp.z_value AS z,
  d.d_avg_sem, d.d_avg_sem / 7.0 AS d_avg_dia,
  d.sigma_sem, d.sigma_sem / sqrt(7.0) AS sigma_dia,
  COALESCE(slt.lt_dias_avg, 14) AS lt_dias,
  COALESCE(slt.sigma_lt, 2) AS sigma_lt,
  ROUND(CASE WHEN COALESCE(slt.sigma_lt, 0) < 2 THEN
    snp.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14)) * 1.075
  ELSE
    snp.z_value * sqrt(COALESCE(slt.lt_dias_avg, 14) * power(d.sigma_sem / sqrt(7.0), 2)
      + power(d.d_avg_sem / 7.0, 2) * power(COALESCE(slt.sigma_lt, 2), 2)) * 1.075
  END)::int AS safety_stock,
  ROUND((d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14))::int AS cycle_stock,
  ROUND((d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14)
    + snp.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14)))::int AS reorder_point,
  -- pre_full_target sólo en fila full_ml (Sprint 4.1 fix pattern).
  CASE WHEN snp.node_id = 'full_ml' THEN
    ROUND((d.d_avg_sem / 7.0) * COALESCE(snp.target_dias_full, 0))::int ELSE 0 END AS pre_full_target,
  -- Sprint 4.3a NUEVO: reserva Flex sólo en fila bodega_central.
  CASE WHEN snp.node_id = 'bodega_central' THEN
    ROUND((d.d_avg_sem / 7.0) * COALESCE(snp.target_dias_flex, 0))::int ELSE 0 END AS reserva_flex_target,
  snp.xyz_confidence, snp.seasonal_match_source, snp.policy_status,
  -- Sprint 4.3a: trazabilidad motor viejo expuesta para panel ⓘ.
  d.es_quiebre_proveedor, d.vel_pre_quiebre, d.vel_actual,
  d.factor_rampup_aplicado, d.rampup_motivo,
  d.evento_activo, d.multiplicador_evento,
  snp.target_dias_flex, snp.flex_priority
FROM sku_node_policy snp
JOIN demand_stats d ON d.sku_origen = snp.sku_origen
LEFT JOIN supplier_lt slt ON slt.sku = snp.sku_origen
WHERE snp.policy_status = 'active' AND snp.action <> 'no_reorder';

COMMENT ON VIEW v_safety_stock IS
  'Sprint 4.3a (2026-05-04): velocidad efectiva con motor-viejo selection
   (vel_pre cuando enQP_proveedor; vel × evento cuando mult>1; vel_ponderada
   default; × factor_rampup). NO double-multiplica vel_pre × evento. Agrega
   reserva_flex_target en bodega_central. Expone trazabilidad: es_quiebre_proveedor,
   vel_pre_quiebre, vel_actual, factor_rampup_aplicado, rampup_motivo,
   evento_activo, multiplicador_evento, target_dias_flex, flex_priority.';


-- =============================================================================
-- v_compras_pendientes — stock_objetivo = safety + pre_full + reserva_flex.
-- cycle_stock NO se suma (double-count vs pre_full_target ya cubre LT_supplier).
-- =============================================================================
CREATE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT sku_origen, SUM(qty_on_hand) AS stock_total,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'bodega_central') AS stock_bodega,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'full_ml') AS stock_full
  FROM v_stock_por_nodo GROUP BY sku_origen
),
en_transito AS (
  SELECT sku_origen, SUM(qty_in_transit) AS in_transit_bodega
  FROM v_in_transit_por_nodo WHERE to_node_id = 'bodega_central' GROUP BY sku_origen
),
pre_full_por_sku AS (SELECT sku_origen, pre_full_target FROM v_safety_stock WHERE node_id = 'full_ml'),
reserva_flex_por_sku AS (SELECT sku_origen, reserva_flex_target FROM v_safety_stock WHERE node_id = 'bodega_central')
SELECT
  ss.sku_origen, p.nombre, ss.cell, ss.policy_action, ss.xyz_confidence, ss.seasonal_match_source,
  ss.z, ss.lt_dias, ss.d_avg_dia, ss.cycle_stock, ss.safety_stock, ss.reorder_point,
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
  COALESCE(st.stock_total, 0) AS stock_total,
  COALESCE(st.stock_bodega, 0) AS stock_bodega,
  COALESCE(st.stock_full, 0) AS stock_full,
  COALESCE(et.in_transit_bodega, 0) AS in_transit_bodega,
  -- Sprint 4.3a: stock_objetivo = safety + pre_full + reserva_flex.
  -- cycle_stock se mantiene informativo (vel × LT_supplier) pero NO se suma
  -- al objetivo: pre_full_target ya cubre LT al estar dimensionado para
  -- target_dias_full (~42d >> LT_supplier 5d). Ver comentario de migración.
  ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
  GREATEST(0, (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))
    - COALESCE(st.stock_total, 0) - COALESCE(et.in_transit_bodega, 0)) AS qty_a_comprar,
  CASE WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0 THEN NULL
       ELSE GREATEST(0, (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))
         - COALESCE(st.stock_total, 0) - COALESCE(et.in_transit_bodega, 0)) * p.costo_promedio END AS clp_estimado,
  CASE WHEN ss.d_avg_dia > 0 THEN ROUND(COALESCE(st.stock_total, 0) / ss.d_avg_dia) ELSE NULL END AS dias_cobertura_actual,
  CASE WHEN COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0)
            < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))
       THEN true ELSE false END AS bajo_rop,
  p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
  ss.es_quiebre_proveedor, ss.vel_pre_quiebre, ss.vel_actual,
  ss.factor_rampup_aplicado, ss.rampup_motivo, ss.evento_activo, ss.multiplicador_evento,
  ss.target_dias_flex, ss.flex_priority
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'
  AND COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0)
       < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0));

COMMENT ON VIEW v_compras_pendientes IS
  'Sprint 4.3a: stock_objetivo = safety + pre_full + reserva_flex. cycle_stock
   informativo (no se suma; pre_full ya cubre LT_supplier). Velocidad efectiva
   con motor-viejo selection. Trazabilidad motor viejo expuesta.';


-- =============================================================================
-- v_alertas_quiebre — sin cambios estructurales.
-- =============================================================================
CREATE VIEW v_alertas_quiebre AS
SELECT vcp.sku_origen, vcp.nombre, vcp.cell, vcp.stock_total, vcp.stock_bodega, vcp.stock_full,
  vcp.dias_cobertura_actual, vcp.qty_a_comprar, vcp.clp_estimado, vcp.proveedor_nombre,
  CASE WHEN vcp.stock_total = 0 THEN 'QUIEBRE_TOTAL'
       WHEN vcp.dias_cobertura_actual <= 3 THEN 'CRITICO'
       WHEN vcp.dias_cobertura_actual <= 7 THEN 'URGENTE'
       WHEN vcp.dias_cobertura_actual <= 14 THEN 'ATENCION'
       ELSE 'OK' END AS nivel_alerta,
  CASE WHEN vcp.stock_total = 0 AND vcp.cell IN ('AX','AY','AZ') THEN 1
       WHEN vcp.stock_total = 0 THEN 2
       WHEN vcp.dias_cobertura_actual <= 3 AND vcp.cell IN ('AX','AY','AZ') THEN 3
       WHEN vcp.dias_cobertura_actual <= 3 THEN 4
       WHEN vcp.dias_cobertura_actual <= 7 THEN 5
       ELSE 9 END AS prioridad
FROM v_compras_pendientes vcp WHERE vcp.bajo_rop = true;

COMMENT ON VIEW v_alertas_quiebre IS 'Sprint 4 + 4.3a: alertas priorizadas. Hereda velocidad efectiva.';


-- =============================================================================
-- v_reposicion_dashboard — incluye reserva_flex_target + campos motor viejo.
-- =============================================================================
CREATE VIEW v_reposicion_dashboard AS
SELECT vcp.sku_origen, vcp.nombre, vcp.cell, vcp.policy_action, vcp.xyz_confidence, vcp.seasonal_match_source,
  vcp.proveedor_nombre, vcp.proveedor_id, vcp.stock_bodega, vcp.stock_full, vcp.stock_total, vcp.in_transit_bodega,
  vcp.cycle_stock, vcp.safety_stock, vcp.reorder_point, vcp.pre_full_target, vcp.reserva_flex_target,
  vcp.stock_objetivo, vcp.qty_a_comprar, vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
  COALESCE(vaq.nivel_alerta, 'OK') AS nivel_alerta, COALESCE(vaq.prioridad, 9) AS prioridad,
  vcp.lt_dias, vcp.z, vcp.d_avg_dia,
  vcp.es_quiebre_proveedor, vcp.vel_pre_quiebre, vcp.vel_actual,
  vcp.factor_rampup_aplicado, vcp.rampup_motivo, vcp.evento_activo, vcp.multiplicador_evento,
  vcp.target_dias_flex, vcp.flex_priority
FROM v_compras_pendientes vcp LEFT JOIN v_alertas_quiebre vaq USING (sku_origen);

COMMENT ON VIEW v_reposicion_dashboard IS 'Sprint 4 + 4.3a: master view consumida por /admin/reposicion-suggestions.';


-- =============================================================================
-- v_reposicion_explain — agrega Inteligencia operativa motor viejo.
-- =============================================================================
CREATE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  SELECT cv.sku_origen, SUM(vmc.cantidad)::numeric AS uds_30d_real,
    COUNT(DISTINCT vmc.order_id) AS num_ordenes_30d,
    SUM(vmc.cantidad)::numeric / 30.0 AS vel_real_dia,
    (SUM(vmc.cantidad)::numeric * 7.0) / 30.0 AS vel_real_sem
  FROM ventas_ml_cache vmc JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= CURRENT_DATE - 30 AND vmc.anulada = false GROUP BY cv.sku_origen
),
ultimo_oc_real AS (
  SELECT DISTINCT ON (ocl.sku_origen) ocl.sku_origen,
    oc.fecha_emision AS ultimo_oc_fecha_emision, oc.fecha_recepcion AS ultimo_oc_fecha_recepcion,
    oc.lead_time_real AS lt_real_ultimo_oc_dias, oc.numero AS ultimo_oc_numero
  FROM ordenes_compra_lineas ocl JOIN ordenes_compra oc ON oc.id = ocl.orden_id
  WHERE oc.estado = 'RECIBIDA_PARCIAL' AND oc.fecha_recepcion IS NOT NULL AND oc.lead_time_real IS NOT NULL
  ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
),
quiebre_por_nodo AS (
  SELECT sku_origen,
    MAX(fecha) FILTER (WHERE stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
    MAX(fecha) FILTER (WHERE stock_full > 0) AS ultimo_dia_full_con_stock,
    MIN(fecha) AS primer_snapshot_sku
  FROM stock_snapshots GROUP BY sku_origen
)
SELECT
  vsf.sku_origen, p.nombre, p.categoria, p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
  vsf.cell, vsf.policy_action,
  pt.service_level AS sl_template, pt.z_value AS z_template,
  pt.target_dias_full AS target_dias_template,
  pt.target_dias_flex AS target_dias_flex_template, pt.source_ref AS template_fuente,
  si.vel_ponderada AS vel_decl_sem, si.vel_7d AS vel_7d_decl, si.vel_30d AS vel_30d_decl, si.vel_60d AS vel_60d_decl,
  vsf.d_avg_dia AS vel_decl_dia,
  COALESCE(v30.vel_real_dia, 0) AS vel_real_dia,
  COALESCE(v30.vel_real_sem, 0) AS vel_real_sem,
  COALESCE(v30.uds_30d_real, 0) AS uds_30d_real,
  COALESCE(v30.num_ordenes_30d, 0) AS num_ordenes_30d,
  CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN NULL
       ELSE ROUND(((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada * 100)::numeric, 1) END AS vel_drift_pct,
  CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN 'sin_baseline'
       WHEN ABS((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'
       WHEN ABS((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'
       ELSE 'drift_high' END AS vel_drift_status,
  vsf.lt_dias AS lt_decl, vsf.sigma_lt AS sigma_lt_decl,
  uo.lt_real_ultimo_oc_dias, uo.ultimo_oc_fecha_emision, uo.ultimo_oc_fecha_recepcion, uo.ultimo_oc_numero,
  CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'
       WHEN ABS(uo.lt_real_ultimo_oc_dias - vsf.lt_dias) <= 2 THEN 'aligned' ELSE 'drift' END AS lt_drift_status,
  vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
  vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
  COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
  vsf.reserva_flex_target,
  vsf.xyz_confidence,
  COALESCE(vsn_b.qty_on_hand, 0) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0) AS stock_full,
  COALESCE(vsn_b.qty_on_hand, 0) + COALESCE(vsn_f.qty_on_hand, 0) AS stock_total,
  COALESCE(vit.qty_in_transit, 0) AS in_transit_bodega,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_bodega_estado,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL
       WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN
         LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       ELSE qpn.primer_snapshot_sku END AS quiebre_bodega_fecha,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL
       WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN
         (CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE))::int
       WHEN qpn.primer_snapshot_sku IS NOT NULL THEN (CURRENT_DATE - qpn.primer_snapshot_sku)::int
       ELSE NULL END AS quiebre_bodega_dias,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_full_estado,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL
       WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN
         LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       ELSE qpn.primer_snapshot_sku END AS quiebre_full_fecha,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL
       WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN
         (CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE))::int
       WHEN qpn.primer_snapshot_sku IS NOT NULL THEN (CURRENT_DATE - qpn.primer_snapshot_sku)::int
       ELSE NULL END AS quiebre_full_dias,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
         THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'
       WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) > 0
         THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'
       WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
         THEN 'Full quebrado: armar envío Bodega→Full hoy. Tenés ' || COALESCE(vsn_b.qty_on_hand, 0)::text || ' unidades disponibles'
       ELSE NULL END AS alerta_operativa,
  si.fecha_entrada_quiebre,
  CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM now() - si.fecha_entrada_quiebre)::int END AS dias_en_quiebre,
  p.costo_promedio,
  snp.manual_override, snp.policy_status, snp.seasonal_match_source, si.margen_neto_30d_imputed,
  vcp.qty_a_comprar, vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
  -- Sprint 4.3a — Inteligencia operativa motor viejo expuesta.
  si.accion,
  si.es_quiebre_proveedor,
  si.vel_pre_quiebre,
  si.factor_rampup_aplicado,
  si.rampup_motivo,
  si.evento_activo,
  si.multiplicador_evento,
  si.mandar_full,
  si.pedir_proveedor       AS pedir_proveedor_motor_viejo,
  si.pedir_proveedor_sin_rampup,
  -- Política multi-canal.
  snp.target_dias_flex,
  snp.flex_priority,
  vsf.d_avg_sem            AS d_avg_sem_efectivo,
  si.updated_at            AS sku_intelligence_updated_at,
  snp.updated_at           AS policy_updated_at
FROM v_safety_stock vsf
JOIN productos p ON p.sku = vsf.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen AND snp.node_id = vsf.node_id
LEFT JOIN policy_templates pt ON pt.cell = vsf.cell
LEFT JOIN ventas_30d_real v30 ON v30.sku_origen = vsf.sku_origen
LEFT JOIN ultimo_oc_real uo ON uo.sku_origen = vsf.sku_origen
LEFT JOIN v_stock_por_nodo vsn_b ON vsn_b.sku_origen = vsf.sku_origen AND vsn_b.node_id = 'bodega_central'
LEFT JOIN v_stock_por_nodo vsn_f ON vsn_f.sku_origen = vsf.sku_origen AND vsn_f.node_id = 'full_ml'
LEFT JOIN v_in_transit_por_nodo vit ON vit.sku_origen = vsf.sku_origen AND vit.to_node_id = 'bodega_central'
LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vsf.sku_origen
LEFT JOIN (SELECT sku_origen, pre_full_target FROM v_safety_stock WHERE node_id = 'full_ml') pre_full
  ON pre_full.sku_origen = vsf.sku_origen
LEFT JOIN quiebre_por_nodo qpn ON qpn.sku_origen = vsf.sku_origen
WHERE vsf.node_id = 'bodega_central';

COMMENT ON VIEW v_reposicion_explain IS
  'Sprint 4.3a (2026-05-04): expone Inteligencia operativa del motor viejo
   (accion, vel_pre_quiebre, factor_rampup_aplicado, rampup_motivo, evento_activo,
   multiplicador_evento, mandar_full, pedir_proveedor) + target_dias_flex /
   reserva_flex_target / flex_priority. Hereda quiebre por nodo Sprint 4.2.1.';


-- =============================================================================
-- v_data_quality_drift — sin cambios estructurales.
-- =============================================================================
CREATE VIEW v_data_quality_drift AS
SELECT vre.sku_origen, vre.nombre, vre.cell, vre.proveedor_nombre,
  vre.vel_decl_sem, vre.vel_real_sem, vre.vel_drift_pct, vre.vel_drift_status,
  vre.lt_decl, vre.lt_real_ultimo_oc_dias, vre.lt_drift_status,
  CASE WHEN vre.policy_status = 'blocked_no_cost' THEN 'BLOCKED_COST'
       WHEN vre.policy_status = 'blocked_no_history' THEN 'BLOCKED_HISTORY'
       WHEN vre.vel_drift_status = 'drift_high' AND vre.lt_drift_status = 'drift' THEN 'DRIFT_BOTH'
       WHEN vre.vel_drift_status = 'drift_high' THEN 'DRIFT_VEL'
       WHEN vre.lt_drift_status = 'drift' THEN 'DRIFT_LT'
       WHEN vre.vel_drift_status = 'drift_moderate' THEN 'DRIFT_MODERATE'
       WHEN vre.vel_drift_status = 'sin_baseline' THEN 'SIN_BASELINE'
       ELSE 'OK' END AS data_quality_status,
  vre.policy_status, vre.xyz_confidence, vre.qty_a_comprar, vre.clp_estimado
FROM v_reposicion_explain vre;

COMMENT ON VIEW v_data_quality_drift IS 'Sprint 4.2 + 4.3a: reporte de calidad de datos por SKU. Sin cambios estructurales.';
