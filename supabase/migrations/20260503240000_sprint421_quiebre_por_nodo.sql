-- =============================================================================
-- Sprint 4.2.1 — Fix quiebre fósil + quiebre por nodo en panel
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-7]
--
-- Bug 1 (datos): sku_intelligence.fecha_entrada_quiebre persiste valores
-- pre-2026-04-16 sin respaldo en stock_snapshots. Confirmados 3 SKUs
-- (JSECBQ008P20A, TXTPBL20200SK, JSAFAB381P20X). Fix puntual aplicado vía
-- UPDATE+audit_log fuera de migración.
--
-- Bug 2 (UX): v_reposicion_explain expone fecha_entrada_quiebre única
-- (heredada de sku_intelligence) sin distinguir bodega vs full ML. Caso
-- testigo TXTPBL20200SK: stock_bodega=39, stock_full=0 → panel decía
-- "en quiebre" sin contexto operativo.
--
-- Fix estructural: recrear v_reposicion_explain agregando 7 columnas:
--   - quiebre_bodega_estado, quiebre_bodega_fecha, quiebre_bodega_dias
--   - quiebre_full_estado, quiebre_full_fecha, quiebre_full_dias
--   - alerta_operativa (TEXT con sugerencia según combinación)
--
-- DROP+CREATE necesario porque CREATE OR REPLACE VIEW no permite reordenar
-- columnas. v_data_quality_drift se recrea idéntica (consume v_reposicion_explain
-- y hereda los nuevos campos transparently si los necesita).
--
-- Lógica de fechas por nodo: derivada de stock_snapshots (no de
-- sku_intelligence.fecha_entrada_quiebre que tenía bug fósil). El último
-- día con stock_X > 0 + 1 día = fecha entrada quiebre. Sin snapshot con
-- stock → primer snapshot disponible (no podemos retroceder más).
-- =============================================================================

DROP VIEW IF EXISTS v_data_quality_drift;
DROP VIEW IF EXISTS v_reposicion_explain;

CREATE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  SELECT cv.sku_origen,
    SUM(vmc.cantidad)::numeric                AS uds_30d_real,
    COUNT(DISTINCT vmc.order_id)              AS num_ordenes_30d,
    SUM(vmc.cantidad)::numeric / 30.0         AS vel_real_dia,
    (SUM(vmc.cantidad)::numeric * 7.0) / 30.0 AS vel_real_sem
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= CURRENT_DATE - 30 AND vmc.anulada = false
  GROUP BY cv.sku_origen
),
ultimo_oc_real AS (
  SELECT DISTINCT ON (ocl.sku_origen)
    ocl.sku_origen,
    oc.fecha_emision   AS ultimo_oc_fecha_emision,
    oc.fecha_recepcion AS ultimo_oc_fecha_recepcion,
    oc.lead_time_real  AS lt_real_ultimo_oc_dias,
    oc.numero          AS ultimo_oc_numero
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
  WHERE oc.estado = 'RECIBIDA_PARCIAL' AND oc.fecha_recepcion IS NOT NULL AND oc.lead_time_real IS NOT NULL
  ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
),
quiebre_por_nodo AS (
  -- Sprint 4.2.1: deriva fecha de entrada en quiebre por nodo desde
  -- stock_snapshots. último día con stock_X > 0 → fecha_entrada = ese día + 1.
  SELECT
    sku_origen,
    MAX(fecha) FILTER (WHERE stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
    MAX(fecha) FILTER (WHERE stock_full > 0)   AS ultimo_dia_full_con_stock,
    MIN(fecha)                                  AS primer_snapshot_sku
  FROM stock_snapshots
  GROUP BY sku_origen
)
SELECT
  vsf.sku_origen, p.nombre, p.categoria, p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
  vsf.cell, vsf.policy_action,
  pt.service_level AS sl_template, pt.z_value AS z_template, pt.target_dias_full AS target_dias_template, pt.source_ref AS template_fuente,
  si.vel_ponderada AS vel_decl_sem, si.vel_7d AS vel_7d_decl, si.vel_30d AS vel_30d_decl, si.vel_60d AS vel_60d_decl, vsf.d_avg_dia AS vel_decl_dia,
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
       WHEN ABS(uo.lt_real_ultimo_oc_dias - vsf.lt_dias) <= 2 THEN 'aligned'
       ELSE 'drift' END AS lt_drift_status,
  vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
  vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
  COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
  vsf.xyz_confidence,
  COALESCE(vsn_b.qty_on_hand, 0) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0) AS stock_full,
  COALESCE(vsn_b.qty_on_hand, 0) + COALESCE(vsn_f.qty_on_hand, 0) AS stock_total,
  COALESCE(vit.qty_in_transit, 0) AS in_transit_bodega,
  -- Sprint 4.2.1: quiebre por nodo
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
  -- Quiebre legacy (compat — fix estructural en intelligence.ts)
  si.fecha_entrada_quiebre,
  CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM now() - si.fecha_entrada_quiebre)::int END AS dias_en_quiebre,
  p.costo_promedio,
  snp.manual_override, snp.policy_status, snp.seasonal_match_source, si.margen_neto_30d_imputed,
  vcp.qty_a_comprar, vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
  si.updated_at AS sku_intelligence_updated_at, snp.updated_at AS policy_updated_at
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
  'Sprint 4.2.1 (2026-05-03): vista master para panel transparencia. '
  'Agrega quiebre_{bodega,full}_{estado,fecha,dias} derivado de stock_snapshots '
  '(no de sku_intelligence.fecha_entrada_quiebre que tenía bug fósil). '
  'alerta_operativa con sugerencia textual según combinación bodega×full. '
  'fecha_entrada_quiebre legacy preservada por compat.';

CREATE VIEW v_data_quality_drift AS
SELECT
  vre.sku_origen, vre.nombre, vre.cell, vre.proveedor_nombre,
  vre.vel_decl_sem, vre.vel_real_sem, vre.vel_drift_pct, vre.vel_drift_status,
  vre.lt_decl, vre.lt_real_ultimo_oc_dias, vre.lt_drift_status,
  CASE
    WHEN vre.policy_status = 'blocked_no_cost' THEN 'BLOCKED_COST'
    WHEN vre.policy_status = 'blocked_no_history' THEN 'BLOCKED_HISTORY'
    WHEN vre.vel_drift_status = 'drift_high' AND vre.lt_drift_status = 'drift' THEN 'DRIFT_BOTH'
    WHEN vre.vel_drift_status = 'drift_high' THEN 'DRIFT_VEL'
    WHEN vre.lt_drift_status = 'drift' THEN 'DRIFT_LT'
    WHEN vre.vel_drift_status = 'drift_moderate' THEN 'DRIFT_MODERATE'
    WHEN vre.vel_drift_status = 'sin_baseline' THEN 'SIN_BASELINE'
    ELSE 'OK'
  END AS data_quality_status,
  vre.policy_status, vre.xyz_confidence, vre.qty_a_comprar, vre.clp_estimado
FROM v_reposicion_explain vre;

COMMENT ON VIEW v_data_quality_drift IS 'Sprint 4.2: reporte de calidad de datos por SKU.';
