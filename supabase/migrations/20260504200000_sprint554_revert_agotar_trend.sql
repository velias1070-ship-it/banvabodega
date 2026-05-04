-- Sprint 5.5.4 — Completar revert agotar en v_trend_detection
-- Owner: Vicente Elías | 2026-05-04 PM | Tag: [batch:20260504-revert-trend-agotar]
-- Discovery: docs/discovery/cell-efectiva-tendencia-null-2026-05-04.md
-- Doctrina vigente: docs/policies/estados-sku.md (revisión 2026-05-04 PM)
-- Aplica Regla 2 inventory-policy: sub-bug del revert sprint 5.5.2 mismo día.
--
-- PROBLEMA:
-- Discovery 2026-05-04 PM detectó que los 22 SKUs `agotar` reincorporados a
-- sku_node_policy esta mañana (sprint 5.5.2) tienen tendencia=NULL y
-- cell_efectiva=NULL en bodega_central y full_ml. Causa raíz: la vista
-- v_trend_detection mantenía el filtro
--
--     WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL
--
-- que es la copia espejo del filtro AM en `refresh_sku_node_policy_from_templates`.
-- El revert AM corrigió el cron pero olvidó la vista. Sin fix:
--   1. Mañana 12:00 UTC el cron sync-trend-detection los marca como
--      'insuficiente_data' (mentira: vel_ponderada > 0).
--   2. Pierden promoción BZ→AZ doctrina Sprint 4.3b.
--   3. Aceleradores entre `agotar` (LITAF400G4PMT drift -53%, etc.) quedan
--      invisibles a trend detection.
--
-- CAMBIO:
-- Reescribir v_trend_detection con filtro idéntico al cron post-revert:
--
--     WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'
--
-- y recrear v_reposicion_explain (cae por CASCADE) con su definición exacta
-- del Sprint 5.5 v3 (sin cambios funcionales).
--
-- Corrida inmediata del refresh RPC para popular tendencia/cell_efectiva en
-- las 22 filas agotar antes de que el cron diario las pise como huérfanas.
--
-- Nota: 100% redefinición de vistas + RPC call. Cero schema change. Cero
-- cambio a la lógica del cron sync-trend-detection ni al bloque "orphans".

BEGIN;

-- =============================================================================
-- DROP en cascada (v_reposicion_explain depende de v_trend_detection)
-- =============================================================================

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_trend_detection CASCADE;

-- =============================================================================
-- v_trend_detection — filtro nuevo (incluye agotar, excluye solo descontinuado)
-- =============================================================================

CREATE VIEW v_trend_detection AS
WITH ventas_por_ventana AS (
  SELECT
    cv.sku_origen,
    SUM(CASE WHEN vmc.fecha_date >= CURRENT_DATE - INTERVAL '7 days'
             THEN vmc.cantidad * COALESCE(cv.unidades, 1) ELSE 0 END)::numeric AS uds_7d,
    SUM(CASE WHEN vmc.fecha_date >= CURRENT_DATE - INTERVAL '28 days'
             THEN vmc.cantidad * COALESCE(cv.unidades, 1) ELSE 0 END)::numeric AS uds_28d,
    SUM(CASE WHEN vmc.fecha_date >= CURRENT_DATE - INTERVAL '56 days'
              AND vmc.fecha_date <  CURRENT_DATE - INTERVAL '28 days'
             THEN vmc.cantidad * COALESCE(cv.unidades, 1) ELSE 0 END)::numeric AS uds_28d_previas,
    SUM(CASE WHEN vmc.fecha_date >= CURRENT_DATE - INTERVAL '90 days'
             THEN vmc.cantidad * COALESCE(cv.unidades, 1) ELSE 0 END)::numeric AS uds_90d
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.anulada = false
    AND vmc.fecha_date >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY cv.sku_origen
),
quiebre_por_ventana AS (
  -- Quiebre TOTAL (full AND bodega): condición real de "no se podía vender".
  SELECT
    sku_origen,
    COUNT(*) FILTER (
      WHERE fecha >= CURRENT_DATE - 28
        AND en_quiebre_full = true AND en_quiebre_bodega = true
    ) AS dias_quiebre_recent,
    COUNT(*) FILTER (WHERE fecha >= CURRENT_DATE - 28) AS dias_total_recent,
    COUNT(*) FILTER (
      WHERE fecha >= CURRENT_DATE - 56 AND fecha < CURRENT_DATE - 28
        AND en_quiebre_full = true AND en_quiebre_bodega = true
    ) AS dias_quiebre_previous,
    COUNT(*) FILTER (WHERE fecha >= CURRENT_DATE - 56 AND fecha < CURRENT_DATE - 28) AS dias_total_previous
  FROM stock_snapshots
  WHERE fecha >= CURRENT_DATE - 56
  GROUP BY sku_origen
),
quiebre_actual AS (
  SELECT sku_origen, es_quiebre_proveedor, vel_pre_quiebre,
         fecha_entrada_quiebre, dias_en_quiebre
  FROM sku_intelligence
),
velocidad_calculada AS (
  SELECT
    vpv.sku_origen,
    vpv.uds_7d, vpv.uds_28d, vpv.uds_28d_previas, vpv.uds_90d,
    COALESCE(qpv.dias_quiebre_recent, 0) AS dias_quiebre_recent,
    COALESCE(qpv.dias_total_recent, 0) AS dias_total_recent,
    COALESCE(qpv.dias_quiebre_previous, 0) AS dias_quiebre_previous,
    COALESCE(qpv.dias_total_previous, 0) AS dias_total_previous,
    GREATEST(7, 28 - COALESCE(qpv.dias_quiebre_recent, 0)) AS dias_stock_recent,
    GREATEST(7, 28 - COALESCE(qpv.dias_quiebre_previous, 0)) AS dias_stock_previous,
    vpv.uds_28d / 4.0 AS vel_recent_sem_cruda,
    vpv.uds_28d_previas / 4.0 AS vel_previous_sem_cruda,
    vpv.uds_28d * 7.0 / GREATEST(7, 28 - COALESCE(qpv.dias_quiebre_recent, 0)) AS vel_recent_sem,
    vpv.uds_28d_previas * 7.0 / GREATEST(7, 28 - COALESCE(qpv.dias_quiebre_previous, 0)) AS vel_previous_sem,
    vpv.uds_90d / (90.0 / 7.0) AS vel_baseline_sem,
    qa.es_quiebre_proveedor, qa.vel_pre_quiebre,
    qa.fecha_entrada_quiebre, qa.dias_en_quiebre
  FROM ventas_por_ventana vpv
  LEFT JOIN quiebre_por_ventana qpv ON qpv.sku_origen = vpv.sku_origen
  LEFT JOIN quiebre_actual qa ON qa.sku_origen = vpv.sku_origen
)
SELECT
  vc.sku_origen, p.nombre,
  vc.uds_7d, vc.uds_28d, vc.uds_28d_previas, vc.uds_90d,
  ROUND(vc.vel_recent_sem, 2) AS vel_recent_sem,
  ROUND(vc.vel_previous_sem, 2) AS vel_previous_sem,
  ROUND(vc.vel_baseline_sem, 2) AS vel_baseline_sem,
  vc.vel_pre_quiebre,
  vc.dias_stock_recent, vc.dias_stock_previous,
  vc.dias_quiebre_recent, vc.dias_quiebre_previous,
  vc.dias_total_recent, vc.dias_total_previous,
  vc.es_quiebre_proveedor, vc.fecha_entrada_quiebre, vc.dias_en_quiebre,
  CASE WHEN vc.vel_previous_sem > 0
       THEN ROUND((vc.vel_recent_sem / vc.vel_previous_sem)::numeric, 2)
       ELSE NULL END AS ratio_recent_vs_previous,
  CASE WHEN vc.vel_baseline_sem > 0
       THEN ROUND((vc.vel_recent_sem / vc.vel_baseline_sem)::numeric, 2)
       ELSE NULL END AS ratio_recent_vs_baseline,
  CASE WHEN vc.vel_pre_quiebre IS NOT NULL AND vc.vel_pre_quiebre > 0
       THEN ROUND((vc.vel_recent_sem / vc.vel_pre_quiebre)::numeric, 2)
       ELSE NULL END AS ratio_recent_vs_pre_quiebre,
  CASE
    WHEN vc.es_quiebre_proveedor = true AND vc.fecha_entrada_quiebre IS NOT NULL
      THEN 'recuperacion_post_quiebre'
    WHEN vc.dias_total_previous >= 14
      AND (vc.dias_quiebre_previous::numeric / vc.dias_total_previous) > 0.5
      THEN 'recuperacion_post_quiebre'
    WHEN vc.dias_total_recent >= 14
      AND (vc.dias_quiebre_recent::numeric / vc.dias_total_recent) > 0.5
      THEN 'recuperacion_post_quiebre'
    WHEN vc.uds_90d < 5 THEN 'insuficiente_data'
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem >= 2.0 * vc.vel_previous_sem
      AND vc.uds_28d >= 5
      AND vc.dias_stock_recent >= 14
      THEN 'acelerando_fuerte'
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem >= 1.5 * vc.vel_previous_sem
      AND vc.vel_baseline_sem > 0
      AND vc.vel_recent_sem >= 1.3 * vc.vel_baseline_sem
      AND vc.uds_28d >= 3
      AND vc.dias_stock_recent >= 14
      THEN 'acelerando'
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem <= 0.3 * vc.vel_previous_sem
      AND vc.uds_28d_previas >= 5
      THEN 'desacelerando_fuerte'
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem <= 0.5 * vc.vel_previous_sem
      AND vc.vel_baseline_sem > 0
      AND vc.vel_recent_sem <= 0.7 * vc.vel_baseline_sem
      AND vc.uds_28d_previas >= 3
      THEN 'desacelerando'
    ELSE 'estable'
  END AS tendencia,
  now() AS calculated_at,
  CASE WHEN vc.uds_90d > 0 THEN 90 ELSE 0 END AS dias_data_disponible
FROM velocidad_calculada vc
JOIN productos p ON p.sku = vc.sku_origen
-- Sprint 5.5.4 (revert agotar trend, 2026-05-04 PM): incluir 'agotar'.
-- Solo 'descontinuado' queda excluido (alineado con sprint 5.5.2 cron).
WHERE p.estado_sku IS DISTINCT FROM 'descontinuado';

COMMENT ON VIEW v_trend_detection IS
  'Sprint 5.5.4 (revert agotar trend, 2026-05-04 PM): filtro alineado a doctrina
   estado_sku revisada. Incluye agotar (eran 22 SKUs huérfanos post-revert AM).
   Solo descontinuado excluido. Censura quiebre + recuperacion_post_quiebre del
   Sprint 4.3b.1 intactos.';

-- =============================================================================
-- v_reposicion_explain (rebuild por CASCADE — definición exacta Sprint 5.5 v3)
-- =============================================================================

CREATE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  SELECT cv.sku_origen,
    SUM(vmc.cantidad)::numeric AS uds_30d_real,
    COUNT(DISTINCT vmc.order_id) AS num_ordenes_30d,
    SUM(vmc.cantidad)::numeric / 30.0 AS vel_real_dia,
    SUM(vmc.cantidad)::numeric * 7.0 / 30.0 AS vel_real_sem
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
    MAX(s.fecha) FILTER (WHERE s.stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
    MAX(s.fecha) FILTER (WHERE s.stock_full > 0) AS ultimo_dia_full_con_stock,
    MIN(s.fecha) AS primer_snapshot_sku
  FROM stock_snapshots s
  GROUP BY s.sku_origen
), in_transit_split AS (
  SELECT v.sku_origen,
    SUM(v.qty_in_transit) AS in_transit_total,
    SUM(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
    SUM(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
  FROM v_in_transit_por_nodo v
  GROUP BY v.sku_origen
)
SELECT vsf.sku_origen,
  p.nombre, p.categoria, p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre,
  vsf.cell, vsf.cell_original, vsf.policy_action,
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
       ELSE ROUND((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada * 100::numeric, 1) END AS vel_drift_pct,
  CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 'sin_baseline'::text
       WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'::text
       WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'::text
       ELSE 'drift_high'::text END AS vel_drift_status,
  vsf.lt_dias AS lt_decl,
  vsf.sigma_lt AS sigma_lt_decl,
  uo.lt_real_ultimo_oc_dias,
  uo.ultimo_oc_fecha_emision,
  uo.ultimo_oc_fecha_recepcion,
  uo.ultimo_oc_numero,
  CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'::text
       WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'::text
       ELSE 'drift'::text END AS lt_drift_status,
  vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
  vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
  COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
  vsf.reserva_flex_target,
  vsf.xyz_confidence,
  COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
  COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric)
    + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
  COALESCE(its.in_transit_total, 0::numeric) AS in_transit_bodega,
  CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) <= 0::numeric
       THEN 'EN_QUIEBRE'::text ELSE 'OK'::text END AS quiebre_bodega_estado,
  CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) > 0::numeric THEN NULL::date
       WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
       ELSE qpn.primer_snapshot_sku END AS quiebre_bodega_fecha,
  CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) > 0::numeric THEN NULL::integer
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
  CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
       THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'::text
       WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric
       THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'::text
       WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric) > 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
       THEN ('Full quebrado: armar envío Bodega->Full hoy. Tenes '::text
             || COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0), 0::numeric)::text)
             || ' unidades disponibles'::text
       ELSE NULL::text END AS alerta_operativa,
  si.fecha_entrada_quiebre,
  CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
       ELSE EXTRACT(day FROM now() - si.fecha_entrada_quiebre::timestamp with time zone)::integer END AS dias_en_quiebre,
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
LEFT JOIN (SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'::text) pre_full
       ON pre_full.sku_origen = vsf.sku_origen
LEFT JOIN quiebre_por_nodo qpn ON qpn.sku_origen = vsf.sku_origen
LEFT JOIN v_trend_detection vtd ON vtd.sku_origen = vsf.sku_origen
WHERE vsf.node_id = 'bodega_central'::text;

COMMENT ON VIEW v_reposicion_explain IS
  'Sprint 5.5 v3 (2026-05-04): stock_bodega y stock_total son DISPONIBLE.
   in_transit_bodega = total (OC bodega + picking_full). Trazabilidad al final:
   stock_bruto_bodega, qty_reserved_bodega, in_transit_oc_bodega, in_transit_picking_full.
   Recreada en Sprint 5.5.4 sin cambios funcionales (CASCADE de v_trend_detection).';

COMMIT;

-- =============================================================================
-- Backfill inmediato: corre el cron para popular los 22 agotar antes del
-- próximo cron diario (12:00 UTC mañana). Idempotente.
-- =============================================================================

SELECT * FROM refresh_trend_in_sku_node_policy();

-- =============================================================================
-- Validación post-deploy
-- =============================================================================

DO $$
DECLARE
  v_agotar_en_vista integer;
  v_descontinuados_en_vista integer;
  v_agotar_total integer;
  v_agotar_sin_tendencia_post integer;
  v_agotar_insuficiente_data integer;
BEGIN
  -- Test 1: vista incluye agotar
  SELECT COUNT(*) INTO v_agotar_en_vista
  FROM v_trend_detection vtd
  JOIN productos p ON p.sku = vtd.sku_origen
  WHERE p.estado_sku = 'agotar';

  -- Test 2: descontinuados siguen excluidos
  SELECT COUNT(*) INTO v_descontinuados_en_vista
  FROM v_trend_detection vtd
  JOIN productos p ON p.sku = vtd.sku_origen
  WHERE p.estado_sku = 'descontinuado';

  IF v_descontinuados_en_vista > 0 THEN
    RAISE EXCEPTION 'Sprint 5.5.4 invariant broken: % descontinuados aparecen en v_trend_detection', v_descontinuados_en_vista;
  END IF;

  -- Test 3: post backfill, los agotar tienen tendencia (no NULL ni mayoritariamente insuficiente_data)
  SELECT COUNT(*) INTO v_agotar_total FROM productos WHERE estado_sku = 'agotar';

  SELECT COUNT(*) INTO v_agotar_sin_tendencia_post
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.estado_sku = 'agotar' AND snp.node_id = 'bodega_central' AND snp.tendencia IS NULL;

  SELECT COUNT(*) INTO v_agotar_insuficiente_data
  FROM sku_node_policy snp
  JOIN productos p ON p.sku = snp.sku_origen
  WHERE p.estado_sku = 'agotar' AND snp.node_id = 'bodega_central'
    AND snp.tendencia = 'insuficiente_data';

  IF v_agotar_sin_tendencia_post > 0 THEN
    RAISE EXCEPTION 'Sprint 5.5.4 fail: % SKUs agotar siguen con tendencia=NULL en bodega_central', v_agotar_sin_tendencia_post;
  END IF;

  RAISE NOTICE 'Sprint 5.5.4 OK: agotar_total=%, en_vista=%, sin_tendencia=%, insuficiente_data=%',
    v_agotar_total, v_agotar_en_vista, v_agotar_sin_tendencia_post, v_agotar_insuficiente_data;
END $$;
