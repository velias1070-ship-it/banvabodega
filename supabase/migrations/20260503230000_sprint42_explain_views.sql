-- =============================================================================
-- Sprint 4.2 — Vistas de transparencia "¿De dónde sale este número?"
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-6]
--
-- Objetivo: panel de explicación operacional en /admin/reposicion-suggestions
-- (botón ⓘ) + /admin/data-quality. Read-only — expone cálculos existentes,
-- NO modifica fórmulas (Sprint 4.1 dejó v_compras_pendientes correcta).
--
-- Vistas:
--   1) v_reposicion_explain — todo el detalle por SKU. Una fila por SKU activo
--      en bodega_central. Incluye velocidad declarada vs real (medición 30d
--      directa de ventas_ml_cache), lead time declarado vs último OC recibido,
--      drift flags, política, cálculos paso a paso, sugerencia de compra.
--
--   2) v_data_quality_drift — resumen de calidad por SKU para reporte global.
--      Combina drift de velocidad + LT + status política en un único
--      data_quality_status.
--
-- Notas de implementación:
--   * Drift_pct se calcula sobre velocidad SEMANAL (vel_ponderada vs vel_real_sem)
--     porque vel_ponderada vive en sku_intelligence en uds/sem, no /día.
--   * vel_real_dia = uds_30d_real / 30. vel_real_sem = uds_30d_real * 7/30.
--   * lt_real proviene de ordenes_compra.lead_time_real (ya computado en OC,
--     no recalculado aquí — única fuente de verdad por v93/inventory-policy R5).
--   * Cobertura LT: hoy solo 2 OCs RECIBIDA_PARCIAL en producción → la
--     mayoría de SKUs tendrán lt_real_ultimo_oc_dias=NULL → status='sin_data'.
--     Esto es esperado y se refleja en /admin/data-quality como BLOCKED.
--   * Sin centinelas: NULL es NULL (Regla 1 inventory-policy.md).
--
-- Idempotente: CREATE OR REPLACE VIEW.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- VIEW: v_reposicion_explain
-- Una fila por SKU activo (node_id='bodega_central'). Master del panel.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  -- Velocidad observada real últimos 30 días (sin ponderación, sin TSB).
  -- Filtra anuladas (feedback_ventas_anuladas_filter).
  SELECT
    cv.sku_origen,
    SUM(vmc.cantidad)::numeric                    AS uds_30d_real,
    COUNT(DISTINCT vmc.order_id)                  AS num_ordenes_30d,
    SUM(vmc.cantidad)::numeric / 30.0             AS vel_real_dia,
    (SUM(vmc.cantidad)::numeric * 7.0) / 30.0     AS vel_real_sem
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= CURRENT_DATE - 30
    AND vmc.anulada = false
  GROUP BY cv.sku_origen
),
ultimo_oc_real AS (
  -- LT real del último OC con recepción para cada SKU.
  -- Usa ordenes_compra.lead_time_real (campo canónico, ya computado).
  -- Hoy solo 2 OCs RECIBIDA_PARCIAL en prod → cobertura mínima esperada.
  SELECT DISTINCT ON (ocl.sku_origen)
    ocl.sku_origen,
    oc.fecha_emision                              AS ultimo_oc_fecha_emision,
    oc.fecha_recepcion                            AS ultimo_oc_fecha_recepcion,
    oc.lead_time_real                             AS lt_real_ultimo_oc_dias,
    oc.numero                                     AS ultimo_oc_numero
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
  WHERE oc.estado = 'RECIBIDA_PARCIAL'
    AND oc.fecha_recepcion IS NOT NULL
    AND oc.lead_time_real IS NOT NULL
  ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
)
SELECT
  -- Identidad ----------------------------------------------------------------
  vsf.sku_origen,
  p.nombre,
  p.categoria,
  p.proveedor_id,
  pr.nombre_canonico                              AS proveedor_nombre,

  -- Clasificación ABC×XYZ ----------------------------------------------------
  vsf.cell,
  vsf.policy_action,
  pt.service_level                                AS sl_template,
  pt.z_value                                      AS z_template,
  pt.target_dias_full                             AS target_dias_template,
  pt.source_ref                                   AS template_fuente,

  -- Velocidad declarada (motor) ---------------------------------------------
  si.vel_ponderada                                AS vel_decl_sem,
  si.vel_7d                                       AS vel_7d_decl,
  si.vel_30d                                      AS vel_30d_decl,
  si.vel_60d                                      AS vel_60d_decl,
  vsf.d_avg_dia                                   AS vel_decl_dia,

  -- Velocidad real (medición 30d directa) ------------------------------------
  COALESCE(v30.vel_real_dia, 0)                   AS vel_real_dia,
  COALESCE(v30.vel_real_sem, 0)                   AS vel_real_sem,
  COALESCE(v30.uds_30d_real, 0)                   AS uds_30d_real,
  COALESCE(v30.num_ordenes_30d, 0)                AS num_ordenes_30d,

  -- Drift de velocidad -------------------------------------------------------
  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN NULL
    ELSE ROUND(
      ((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada * 100)::numeric,
      1
    )
  END AS vel_drift_pct,

  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN 'sin_baseline'
    WHEN ABS((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.10
      THEN 'aligned'
    WHEN ABS((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.30
      THEN 'drift_moderate'
    ELSE 'drift_high'
  END AS vel_drift_status,

  -- Lead time declarado vs real ----------------------------------------------
  vsf.lt_dias                                     AS lt_decl,
  vsf.sigma_lt                                    AS sigma_lt_decl,
  uo.lt_real_ultimo_oc_dias,
  uo.ultimo_oc_fecha_emision,
  uo.ultimo_oc_fecha_recepcion,
  uo.ultimo_oc_numero,
  CASE
    WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'
    WHEN ABS(uo.lt_real_ultimo_oc_dias - vsf.lt_dias) <= 2 THEN 'aligned'
    ELSE 'drift'
  END AS lt_drift_status,

  -- Cálculos del motor (replicados desde v_safety_stock) --------------------
  vsf.z,
  vsf.d_avg_sem,
  vsf.sigma_sem,
  vsf.sigma_dia,
  vsf.cycle_stock,
  vsf.safety_stock,
  vsf.reorder_point,
  -- pre_full_target del nodo full_ml (Sprint 4.1 fix) — propagado correctamente
  COALESCE(pre_full.pre_full_target, 0)           AS pre_full_target,
  vsf.xyz_confidence,

  -- Estado actual ------------------------------------------------------------
  COALESCE(vsn_b.qty_on_hand, 0)                  AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0)                  AS stock_full,
  COALESCE(vsn_b.qty_on_hand, 0) + COALESCE(vsn_f.qty_on_hand, 0) AS stock_total,
  COALESCE(vit.qty_in_transit, 0)                 AS in_transit_bodega,

  -- Quiebre (de sku_intelligence, no stock_snapshots) -----------------------
  si.fecha_entrada_quiebre,
  CASE
    WHEN si.fecha_entrada_quiebre IS NULL THEN NULL
    ELSE EXTRACT(DAY FROM now() - si.fecha_entrada_quiebre)::int
  END AS dias_en_quiebre,

  -- Costos -------------------------------------------------------------------
  p.costo_promedio,

  -- Política metadata --------------------------------------------------------
  snp.manual_override,
  snp.policy_status,
  snp.seasonal_match_source,
  si.margen_neto_30d_imputed,

  -- Sugerencia de compra (de v_compras_pendientes — solo si bajo ROP) -------
  vcp.qty_a_comprar,
  vcp.clp_estimado,
  vcp.dias_cobertura_actual,
  vcp.bajo_rop,

  -- Última actualización -----------------------------------------------------
  si.updated_at                                   AS sku_intelligence_updated_at,
  snp.updated_at                                  AS policy_updated_at
FROM v_safety_stock vsf
JOIN productos p ON p.sku = vsf.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen
                         AND snp.node_id = vsf.node_id
LEFT JOIN policy_templates pt ON pt.cell = vsf.cell
LEFT JOIN ventas_30d_real v30 ON v30.sku_origen = vsf.sku_origen
LEFT JOIN ultimo_oc_real uo ON uo.sku_origen = vsf.sku_origen
LEFT JOIN v_stock_por_nodo vsn_b ON vsn_b.sku_origen = vsf.sku_origen
                                AND vsn_b.node_id = 'bodega_central'
LEFT JOIN v_stock_por_nodo vsn_f ON vsn_f.sku_origen = vsf.sku_origen
                                AND vsn_f.node_id = 'full_ml'
LEFT JOIN v_in_transit_por_nodo vit ON vit.sku_origen = vsf.sku_origen
                                   AND vit.to_node_id = 'bodega_central'
LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vsf.sku_origen
LEFT JOIN (
  SELECT sku_origen, pre_full_target
  FROM v_safety_stock
  WHERE node_id = 'full_ml'
) pre_full ON pre_full.sku_origen = vsf.sku_origen
WHERE vsf.node_id = 'bodega_central';

COMMENT ON VIEW v_reposicion_explain IS
  'Sprint 4.2: vista master para panel "¿De dónde sale este número?". '
  'Una fila por SKU activo (node_id=bodega_central). Expone velocidad declarada '
  'vs real, lead time declarado vs último OC recibido, drift flags, política, '
  'cálculos paso a paso, sugerencia de compra. Read-only — Sprint 4.1 dejó '
  'v_compras_pendientes correcta. drift_pct sobre velocidad SEMANAL.';


-- -----------------------------------------------------------------------------
-- VIEW: v_data_quality_drift
-- Reporte global por SKU para /admin/data-quality.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_data_quality_drift AS
SELECT
  vre.sku_origen,
  vre.nombre,
  vre.cell,
  vre.proveedor_nombre,
  vre.vel_decl_sem,
  vre.vel_real_sem,
  vre.vel_drift_pct,
  vre.vel_drift_status,
  vre.lt_decl,
  vre.lt_real_ultimo_oc_dias,
  vre.lt_drift_status,
  -- Score combinado de calidad de datos
  CASE
    WHEN vre.policy_status = 'blocked_no_cost' THEN 'BLOCKED_COST'
    WHEN vre.policy_status = 'blocked_no_history' THEN 'BLOCKED_HISTORY'
    WHEN vre.vel_drift_status = 'drift_high' AND vre.lt_drift_status = 'drift'
      THEN 'DRIFT_BOTH'
    WHEN vre.vel_drift_status = 'drift_high' THEN 'DRIFT_VEL'
    WHEN vre.lt_drift_status = 'drift' THEN 'DRIFT_LT'
    WHEN vre.vel_drift_status = 'drift_moderate' THEN 'DRIFT_MODERATE'
    WHEN vre.vel_drift_status = 'sin_baseline' THEN 'SIN_BASELINE'
    ELSE 'OK'
  END AS data_quality_status,
  vre.policy_status,
  vre.xyz_confidence,
  vre.qty_a_comprar,
  vre.clp_estimado
FROM v_reposicion_explain vre;

COMMENT ON VIEW v_data_quality_drift IS
  'Sprint 4.2: reporte de calidad de datos por SKU. Combina drift de velocidad '
  'y lead time + status de política en data_quality_status. Usado en '
  '/admin/data-quality para auditar inputs antes de decidir compras.';
