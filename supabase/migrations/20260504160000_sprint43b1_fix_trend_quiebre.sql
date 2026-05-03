-- Sprint 4.3b.1 — Fix blind spot: censura quiebre + bloqueo recuperacion_post_quiebre.
-- [batch:20260504-3]
-- [non-reversible:view-rebuild-add-columns-no-data-loss]
--
-- Problema: v_trend_detection contaba unidades crudas. Caso TXSBAF144DL20
-- (94% bodega quebrada, fecha_entrada_quiebre=2026-05-03): zero-zone marzo
-- NO era caída de demanda sino quiebre. Recuperación → ratio 7× → falso
-- positivo "acelerando_fuerte" en Sprint 4.3b.
--
-- Fix en 3 capas:
--   GUARDA 1: si el motor viejo registró quiebre real (es_quiebre_proveedor=true
--             AND fecha_entrada_quiebre IS NOT NULL) → recuperacion_post_quiebre.
--   GUARDA 2: si la ventana previa tuvo >50% de quiebre TOTAL (en_quiebre_full
--             AND en_quiebre_bodega) y hay >=14 snapshots disponibles → idem.
--   GUARDA 3: misma regla en ventana recent.
--
-- Censura del divisor: vel = uds * 7 / GREATEST(7, 28 - dias_quiebre).
-- Asume días sin snapshot tuvieron stock (asunción optimista). Sin quiebre,
-- divisor = 28 → vel = uds/4 (igual al crudo, NO infla). Con quiebre, divisor
-- baja → velocidad sube proporcionalmente (corrige por días no-vendibles).
--
-- Doctrina:
-- - Quiebre total = en_quiebre_full=true AND en_quiebre_bodega=true.
--   Cuando solo Full está quebrado, ML sigue vendiendo via Flex.
-- - Aceleración requiere dias_stock_recent >= 14 (≤14 días en quiebre).
-- - Desacelerando NO se censura (caída con stock disponible es señal real).
-- - GUARDA 1 endurecida: solo cuando fecha_entrada_quiebre IS NOT NULL
--   (es_quiebre_proveedor=true sin quiebre real significa "proveedor sin stock"
--   pero el SKU pudo seguir vendiendo de bodega).

BEGIN;

-- =============================================================================
-- CHECK constraint con tendencia nueva
-- =============================================================================

ALTER TABLE sku_node_policy DROP CONSTRAINT IF EXISTS sku_node_policy_tendencia_check;

ALTER TABLE sku_node_policy
  ADD CONSTRAINT sku_node_policy_tendencia_check
  CHECK (tendencia IN (
    'acelerando','acelerando_fuerte','estable','desacelerando',
    'desacelerando_fuerte','insuficiente_data','recuperacion_post_quiebre'
  ));

-- =============================================================================
-- calc_cell_efectiva: recuperacion_post_quiebre NO promueve
-- =============================================================================

CREATE OR REPLACE FUNCTION calc_cell_efectiva(p_cell TEXT, p_tendencia TEXT)
RETURNS TABLE (cell_efectiva TEXT, promocion_activa BOOLEAN, motivo TEXT)
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_cell IS NULL OR LENGTH(p_cell) <> 2 THEN
    RETURN QUERY SELECT p_cell, false, NULL::TEXT;
    RETURN;
  END IF;
  IF p_tendencia = 'recuperacion_post_quiebre' THEN
    RETURN QUERY SELECT p_cell, false,
      'En recuperación post-quiebre (no promueve hasta sostener 4 sem con stock)'::TEXT;
    RETURN;
  END IF;
  IF p_tendencia IN ('acelerando','acelerando_fuerte') THEN
    RETURN QUERY
    SELECT
      CASE WHEN p_cell IN ('CX','CY','CZ') THEN 'B' || SUBSTRING(p_cell FROM 2)
           WHEN p_cell IN ('BX','BY','BZ') THEN 'A' || SUBSTRING(p_cell FROM 2)
           ELSE p_cell END,
      CASE WHEN p_cell LIKE 'C%' OR p_cell LIKE 'B%' THEN true ELSE false END,
      FORMAT('Promovido por aceleración con stock continuo (%s)', p_tendencia)::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT p_cell, false, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION calc_cell_efectiva IS 'Sprint 4.3b.1: recuperacion_post_quiebre NO promueve.';

-- =============================================================================
-- Refresh RPC: agrega motivo para recuperacion + count en summary
-- =============================================================================

CREATE OR REPLACE FUNCTION refresh_trend_in_sku_node_policy()
RETURNS TABLE (rows_affected INTEGER, summary JSONB)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matched INTEGER;
  v_orphans INTEGER;
  v_summary JSONB;
BEGIN
  WITH updates AS (
    UPDATE sku_node_policy snp
    SET
      tendencia = vtd.tendencia,
      cell_efectiva = CASE
        WHEN vtd.tendencia IN ('acelerando','acelerando_fuerte') THEN
          CASE WHEN snp.cell IN ('CX','CY','CZ') THEN 'B' || SUBSTRING(snp.cell FROM 2)
               WHEN snp.cell IN ('BX','BY','BZ') THEN 'A' || SUBSTRING(snp.cell FROM 2)
               ELSE snp.cell END
        ELSE snp.cell
      END,
      promocion_activa = (vtd.tendencia IN ('acelerando','acelerando_fuerte')
                          AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')),
      promocion_motivo = CASE
        WHEN vtd.tendencia IN ('acelerando','acelerando_fuerte')
             AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')
        THEN FORMAT('Promovido por aceleración (%s)', vtd.tendencia)
        WHEN vtd.tendencia = 'recuperacion_post_quiebre'
        THEN 'En recuperación post-quiebre (no promueve hasta sostener 4 sem con stock)'
        ELSE NULL
      END,
      tendencia_updated_at = now()
    FROM v_trend_detection vtd
    WHERE snp.sku_origen = vtd.sku_origen AND snp.policy_status = 'active'
    RETURNING
      vtd.tendencia AS t_tendencia,
      (vtd.tendencia IN ('acelerando','acelerando_fuerte')
       AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')) AS t_promovido
  )
  SELECT
    COUNT(*)::INTEGER,
    jsonb_build_object(
      'acelerando', COUNT(*) FILTER (WHERE t_tendencia = 'acelerando'),
      'acelerando_fuerte', COUNT(*) FILTER (WHERE t_tendencia = 'acelerando_fuerte'),
      'estable', COUNT(*) FILTER (WHERE t_tendencia = 'estable'),
      'desacelerando', COUNT(*) FILTER (WHERE t_tendencia = 'desacelerando'),
      'desacelerando_fuerte', COUNT(*) FILTER (WHERE t_tendencia = 'desacelerando_fuerte'),
      'insuficiente_data_matched', COUNT(*) FILTER (WHERE t_tendencia = 'insuficiente_data'),
      'recuperacion_post_quiebre', COUNT(*) FILTER (WHERE t_tendencia = 'recuperacion_post_quiebre'),
      'promovidos', COUNT(*) FILTER (WHERE t_promovido = true)
    )
  INTO v_matched, v_summary
  FROM updates;

  WITH updates_orphans AS (
    UPDATE sku_node_policy snp
    SET tendencia = 'insuficiente_data',
        cell_efectiva = snp.cell,
        promocion_activa = false,
        promocion_motivo = NULL,
        tendencia_updated_at = now()
    WHERE snp.policy_status = 'active'
      AND NOT EXISTS (SELECT 1 FROM v_trend_detection vtd WHERE vtd.sku_origen = snp.sku_origen)
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM updates_orphans INTO v_orphans;

  v_summary := v_summary || jsonb_build_object('orphans_no_sales_90d', v_orphans);
  RETURN QUERY SELECT (v_matched + v_orphans), v_summary;
END;
$$;

-- =============================================================================
-- Rebuild v_trend_detection con censura corregida (28 - dias_quiebre)
-- =============================================================================

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_trend_detection CASCADE;

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
  -- Si solo Full quebrado, ML vende via Flex/bodega.
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
    -- Divisor efectivo: 28 - dias_quiebre. Asume días sin snapshot tuvieron
    -- stock (optimista, no penaliza por falta de data histórica). Sin quiebre,
    -- divisor = 28 → vel = uds/4 (idéntico a crudo, NO infla).
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
    -- GUARDA 1: motor viejo registró quiebre real (no sólo proveedor sin stock)
    WHEN vc.es_quiebre_proveedor = true AND vc.fecha_entrada_quiebre IS NOT NULL
      THEN 'recuperacion_post_quiebre'
    -- GUARDA 2: ventana previa con >50% quiebre y suficientes snapshots
    WHEN vc.dias_total_previous >= 14
      AND (vc.dias_quiebre_previous::numeric / vc.dias_total_previous) > 0.5
      THEN 'recuperacion_post_quiebre'
    -- GUARDA 3: ventana recent con >50% quiebre y suficientes snapshots
    WHEN vc.dias_total_recent >= 14
      AND (vc.dias_quiebre_recent::numeric / vc.dias_total_recent) > 0.5
      THEN 'recuperacion_post_quiebre'
    WHEN vc.uds_90d < 5 THEN 'insuficiente_data'
    -- Aceleración fuerte (más estricta gana primero)
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem >= 2.0 * vc.vel_previous_sem
      AND vc.uds_28d >= 5
      AND vc.dias_stock_recent >= 14
      THEN 'acelerando_fuerte'
    -- Aceleración: requiere ratios alineados
    WHEN vc.vel_previous_sem > 0
      AND vc.vel_recent_sem >= 1.5 * vc.vel_previous_sem
      AND vc.vel_baseline_sem > 0
      AND vc.vel_recent_sem >= 1.3 * vc.vel_baseline_sem
      AND vc.uds_28d >= 3
      AND vc.dias_stock_recent >= 14
      THEN 'acelerando'
    -- Desaceleración (sin filtro de quiebre — caída con stock = señal real)
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
WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL;

COMMENT ON VIEW v_trend_detection IS 'Sprint 4.3b.1: censura quiebre + recuperacion_post_quiebre. Divisor=28-dias_quiebre.';

-- =============================================================================
-- Rebuild v_reposicion_explain con trazabilidad de censura
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
  WHERE vmc.fecha_date >= CURRENT_DATE - 30 AND vmc.anulada = false
  GROUP BY cv.sku_origen
),
ultimo_oc_real AS (
  SELECT DISTINCT ON (ocl.sku_origen)
    ocl.sku_origen,
    oc.fecha_emision AS ultimo_oc_fecha_emision,
    oc.fecha_recepcion AS ultimo_oc_fecha_recepcion,
    oc.lead_time_real AS lt_real_ultimo_oc_dias,
    oc.numero AS ultimo_oc_numero
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
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
  vsf.sku_origen, p.nombre, p.categoria, p.proveedor_id,
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
  CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN NULL::numeric
       ELSE ROUND(((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) * 100, 1) END AS vel_drift_pct,
  CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN 'sin_baseline'
       WHEN abs((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'
       WHEN abs((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'
       ELSE 'drift_high' END AS vel_drift_status,
  vsf.lt_dias AS lt_decl, vsf.sigma_lt AS sigma_lt_decl,
  uo.lt_real_ultimo_oc_dias, uo.ultimo_oc_fecha_emision, uo.ultimo_oc_fecha_recepcion, uo.ultimo_oc_numero,
  CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'
       WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2 THEN 'aligned'
       ELSE 'drift' END AS lt_drift_status,
  vsf.z, vsf.d_avg_sem, vsf.sigma_sem, vsf.sigma_dia,
  vsf.cycle_stock, vsf.safety_stock, vsf.reorder_point,
  COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
  vsf.reserva_flex_target, vsf.xyz_confidence,
  COALESCE(vsn_b.qty_on_hand, 0::numeric) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
  COALESCE(vsn_b.qty_on_hand, 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
  COALESCE(vit.qty_in_transit, 0::numeric) AS in_transit_bodega,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_bodega_estado,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL::date
       WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       ELSE qpn.primer_snapshot_sku END AS quiebre_bodega_fecha,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL::integer
       WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
       ELSE NULL::integer END AS quiebre_bodega_dias,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_full_estado,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL::date
       WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       ELSE qpn.primer_snapshot_sku END AS quiebre_full_fecha,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL::integer
       WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
       WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
       ELSE NULL::integer END AS quiebre_full_dias,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
      THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'
    WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) > 0
      THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'
    WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
      THEN 'Full quebrado: armar envío Bodega->Full hoy. Tenes ' || COALESCE(vsn_b.qty_on_hand, 0)::text || ' unidades disponibles'
    ELSE NULL END AS alerta_operativa,
  si.fecha_entrada_quiebre,
  CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
       ELSE EXTRACT(day FROM (now() - si.fecha_entrada_quiebre::timestamptz))::integer END AS dias_en_quiebre,
  p.costo_promedio, snp.manual_override, snp.policy_status, snp.seasonal_match_source,
  si.margen_neto_30d_imputed,
  vcp.qty_a_comprar, vcp.clp_estimado, vcp.dias_cobertura_actual, vcp.bajo_rop,
  si.accion, si.es_quiebre_proveedor, si.vel_pre_quiebre,
  si.factor_rampup_aplicado, si.rampup_motivo,
  si.evento_activo, si.multiplicador_evento, si.mandar_full,
  si.pedir_proveedor AS pedir_proveedor_motor_viejo,
  si.pedir_proveedor_sin_rampup,
  snp.target_dias_flex, snp.flex_priority,
  vsf.d_avg_sem AS d_avg_sem_efectivo,
  vsf.tendencia,
  COALESCE(snp.cell_efectiva, snp.cell) AS cell_efectiva,
  vsf.promocion_activa, vsf.promocion_motivo, snp.tendencia_updated_at,
  vtd.vel_recent_sem AS vel_28d_recent,
  vtd.vel_previous_sem AS vel_28d_previous,
  vtd.vel_baseline_sem AS vel_baseline_90d,
  vtd.ratio_recent_vs_previous, vtd.ratio_recent_vs_baseline,
  -- Sprint 4.3b.1
  vtd.ratio_recent_vs_pre_quiebre,
  vtd.dias_stock_recent, vtd.dias_stock_previous,
  vtd.dias_quiebre_recent, vtd.dias_quiebre_previous,
  vtd.dias_total_recent, vtd.dias_total_previous,
  vtd.uds_28d AS uds_ultimas_4_semanas,
  vtd.uds_28d_previas AS uds_4_semanas_previas,
  si.updated_at AS sku_intelligence_updated_at,
  snp.updated_at AS policy_updated_at
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
LEFT JOIN v_trend_detection vtd ON vtd.sku_origen = vsf.sku_origen
WHERE vsf.node_id = 'bodega_central';

COMMENT ON VIEW v_reposicion_explain IS 'Sprint 4.3b.1: trazabilidad censura completa.';

COMMIT;
