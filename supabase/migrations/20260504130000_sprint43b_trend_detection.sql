-- Sprint 4.3b — Detección de aceleración/desaceleración + promoción temporal de política.
-- [batch:20260504-2]
-- [non-reversible:view-rebuild-add-columns-no-data-loss]
--
-- G1: vista v_trend_detection (ratios reciente vs previo y baseline 90d).
-- G2: columnas tendencia/cell_efectiva/promocion_* en sku_node_policy + RPC + función pura.
-- G3/G4: rebuild v_safety_stock (con cell_efectiva) + v_compras_pendientes + v_reposicion_explain.
--
-- Doctrina:
-- - SKU C/B acelerando usa política de la celda inmediatamente superior (C→B, B→A) — sólo ABC, no XYZ.
-- - Desacelerando NO degrada automáticamente. Solo flag (decisión humana).
-- - target_dias_flex sigue siendo override por SKU (no se promueve con la celda).
-- - Reclasificación oficial ABC×XYZ (motor viejo) NO se toca; esto es overlay temporal.

BEGIN;

-- =============================================================================
-- G1 — v_trend_detection
-- =============================================================================
-- Schema real: ventas_ml_cache.fecha_date (date), ventas_ml_cache.cantidad (int).
-- composicion_venta.unidades multiplica para obtener uds del sku_origen.

CREATE OR REPLACE VIEW v_trend_detection AS
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
velocidad_calculada AS (
  SELECT
    sku_origen,
    uds_7d,
    uds_28d,
    uds_28d_previas,
    uds_90d,
    ROUND(uds_28d / 4.0, 2) AS vel_recent_sem,
    ROUND(uds_28d_previas / 4.0, 2) AS vel_previous_sem,
    ROUND(uds_90d / (90.0 / 7.0), 2) AS vel_baseline_sem,
    CASE
      WHEN uds_28d_previas > 0
      THEN ROUND((uds_28d / 4.0) / (uds_28d_previas / 4.0), 2)
      ELSE NULL
    END AS ratio_recent_vs_previous,
    CASE
      WHEN uds_90d > 0
      THEN ROUND((uds_28d / 4.0) / (uds_90d / (90.0 / 7.0)), 2)
      ELSE NULL
    END AS ratio_recent_vs_baseline
  FROM ventas_por_ventana
)
SELECT
  vc.sku_origen,
  p.nombre,
  vc.uds_7d,
  vc.uds_28d,
  vc.uds_28d_previas,
  vc.uds_90d,
  vc.vel_recent_sem,
  vc.vel_previous_sem,
  vc.vel_baseline_sem,
  vc.ratio_recent_vs_previous,
  vc.ratio_recent_vs_baseline,
  CASE
    WHEN vc.uds_90d < 5 THEN 'insuficiente_data'
    -- Acelerando fuerte primero (regla más estricta gana)
    WHEN vc.ratio_recent_vs_previous IS NOT NULL
      AND vc.ratio_recent_vs_previous >= 2.0
      AND vc.uds_28d >= 5
    THEN 'acelerando_fuerte'
    -- Acelerando: requiere confirmación con baseline
    WHEN vc.ratio_recent_vs_previous IS NOT NULL
      AND vc.ratio_recent_vs_previous >= 1.5
      AND vc.ratio_recent_vs_baseline IS NOT NULL
      AND vc.ratio_recent_vs_baseline >= 1.3
      AND vc.uds_28d >= 3
    THEN 'acelerando'
    -- Desacelerando fuerte
    WHEN vc.ratio_recent_vs_previous IS NOT NULL
      AND vc.ratio_recent_vs_previous <= 0.3
      AND vc.uds_28d_previas >= 5
    THEN 'desacelerando_fuerte'
    -- Desacelerando
    WHEN vc.ratio_recent_vs_previous IS NOT NULL
      AND vc.ratio_recent_vs_previous <= 0.5
      AND vc.ratio_recent_vs_baseline IS NOT NULL
      AND vc.ratio_recent_vs_baseline <= 0.7
      AND vc.uds_28d_previas >= 3
    THEN 'desacelerando'
    ELSE 'estable'
  END AS tendencia,
  now() AS calculated_at,
  CASE WHEN vc.uds_90d > 0 THEN 90 ELSE 0 END AS dias_data_disponible
FROM velocidad_calculada vc
JOIN productos p ON p.sku = vc.sku_origen
WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL;

COMMENT ON VIEW v_trend_detection IS
  'Sprint 4.3b: detecta SKUs en aceleración o desaceleración comparando ' ||
  'velocidad últimas 4 semanas (28d) vs 4 semanas previas (29-56d) vs baseline 90d. ' ||
  'Tendencias: acelerando (recent/previous>=1.5 Y recent/baseline>=1.3), ' ||
  'acelerando_fuerte (recent/previous>=2.0), desacelerando, desacelerando_fuerte, ' ||
  'estable, insuficiente_data (<5 uds en 90d). Detecta cambios en 4-7 días, ' ||
  'vs 30+ días del cron mensual de reclasificación ABC×XYZ.';

-- =============================================================================
-- G2 — sku_node_policy: columnas + función pura + RPC
-- =============================================================================

ALTER TABLE sku_node_policy
  ADD COLUMN IF NOT EXISTS tendencia TEXT
    CHECK (tendencia IN ('acelerando', 'acelerando_fuerte', 'estable',
                         'desacelerando', 'desacelerando_fuerte',
                         'insuficiente_data')),
  ADD COLUMN IF NOT EXISTS cell_efectiva TEXT,
  ADD COLUMN IF NOT EXISTS promocion_activa BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS promocion_motivo TEXT,
  ADD COLUMN IF NOT EXISTS tendencia_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN sku_node_policy.tendencia IS
  'Sprint 4.3b: tendencia detectada de velocidad. Refrescada por cron diario (refresh_trend_in_sku_node_policy).';
COMMENT ON COLUMN sku_node_policy.cell_efectiva IS
  'Sprint 4.3b: celda efectiva para política. Cuando promocion_activa=true difiere de cell (C→B o B→A por aceleración).';
COMMENT ON COLUMN sku_node_policy.promocion_activa IS
  'Sprint 4.3b: TRUE cuando cell_efectiva != cell por aceleración detectada.';

-- Función pura: dada (cell, tendencia) → (cell_efectiva, promocion_activa, motivo).
-- Solo promueve ABC. XYZ no cambia (ej. CY → BY, no CY → BX).

CREATE OR REPLACE FUNCTION calc_cell_efectiva(
  p_cell TEXT,
  p_tendencia TEXT
)
RETURNS TABLE (
  cell_efectiva TEXT,
  promocion_activa BOOLEAN,
  motivo TEXT
)
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_cell IS NULL OR LENGTH(p_cell) <> 2 THEN
    RETURN QUERY SELECT p_cell, false, NULL::TEXT;
    RETURN;
  END IF;

  IF p_tendencia IN ('acelerando', 'acelerando_fuerte') THEN
    RETURN QUERY
    SELECT
      CASE
        WHEN p_cell IN ('CX', 'CY', 'CZ') THEN 'B' || SUBSTRING(p_cell FROM 2)
        WHEN p_cell IN ('BX', 'BY', 'BZ') THEN 'A' || SUBSTRING(p_cell FROM 2)
        ELSE p_cell
      END,
      CASE
        WHEN p_cell LIKE 'C%' OR p_cell LIKE 'B%' THEN true
        ELSE false
      END,
      FORMAT('Promovido por aceleración (%s)', p_tendencia)::TEXT;
    RETURN;
  END IF;

  -- desacelerando / estable / insuficiente_data: no degrada, sólo flag
  RETURN QUERY SELECT p_cell, false, NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION calc_cell_efectiva IS
  'Sprint 4.3b: dada celda original y tendencia, retorna celda efectiva para política. ' ||
  'Acelerando promueve C→B y B→A (mantiene XYZ). ' ||
  'Desacelerando NO degrada automáticamente — humano decide.';

-- RPC que sincroniza tendencia + cell_efectiva en sku_node_policy desde v_trend_detection.

CREATE OR REPLACE FUNCTION refresh_trend_in_sku_node_policy()
RETURNS TABLE (
  rows_affected INTEGER,
  summary JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matched INTEGER;
  v_orphans INTEGER;
  v_summary JSONB;
BEGIN
  -- 1) SKUs con datos en v_trend_detection: aplicar tendencia + cell_efectiva.
  -- Lógica de cell_efectiva inlined: Postgres no permite LATERAL referenciando
  -- la tabla UPDATE-target (snp). calc_cell_efectiva sigue disponible para tests
  -- y consumo manual.
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
        ELSE NULL
      END,
      tendencia_updated_at = now()
    FROM v_trend_detection vtd
    WHERE snp.sku_origen = vtd.sku_origen
      AND snp.policy_status = 'active'
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
      'promovidos', COUNT(*) FILTER (WHERE t_promovido = true)
    )
  INTO v_matched, v_summary
  FROM updates;

  -- 2) SKUs con policy activa pero sin venta en 90d → insuficiente_data
  WITH updates_orphans AS (
    UPDATE sku_node_policy snp
    SET
      tendencia = 'insuficiente_data',
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

COMMENT ON FUNCTION refresh_trend_in_sku_node_policy IS
  'Sprint 4.3b: refresca tendencia + cell_efectiva en sku_node_policy desde v_trend_detection. ' ||
  'Idempotente. Llamado por cron diario /api/policy/sync-trend-detection (12:00 UTC).';

-- =============================================================================
-- G3 — Rebuild v_safety_stock con cell_efectiva
-- =============================================================================
-- DROP CASCADE: v_compras_pendientes y v_reposicion_explain dependen.

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;
DROP VIEW IF EXISTS v_safety_stock CASCADE;

CREATE VIEW v_safety_stock AS
WITH demand_stats AS (
  SELECT
    si.sku_origen,
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
    COALESCE(NULLIF(si.desviacion_std, 0), COALESCE(si.vel_ponderada, 0) * 0.3) AS sigma_sem,
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
  SELECT
    p.sku,
    p.proveedor_id,
    COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14) AS lt_dias_avg,
    COALESCE(pr.lead_time_sigma_dias, 2) AS sigma_lt
  FROM productos p
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL
),
politica_efectiva AS (
  -- Sprint 4.3b: si cell_efectiva != cell, usar z y target_dias_full de la celda promovida.
  -- target_dias_flex queda como override per-SKU (snp.target_dias_flex).
  SELECT
    snp.sku_origen,
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
  LEFT JOIN policy_templates pt_efectiva
    ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
)
SELECT
  pe.sku_origen,
  pe.node_id,
  pe.cell_aplicada AS cell,            -- celda usada para la política (puede ser promovida)
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
  COALESCE(slt.lt_dias_avg, 14) AS lt_dias,
  COALESCE(slt.sigma_lt, 2) AS sigma_lt,
  ROUND(
    CASE
      WHEN COALESCE(slt.sigma_lt, 0) < 2
      THEN pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14)) * 1.075
      ELSE pe.z_value * sqrt(
        COALESCE(slt.lt_dias_avg, 14) * power(d.sigma_sem / sqrt(7.0), 2)
        + power(d.d_avg_sem / 7.0, 2) * power(COALESCE(slt.sigma_lt, 2), 2)
      ) * 1.075
    END
  )::INTEGER AS safety_stock,
  ROUND((d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14))::INTEGER AS cycle_stock,
  ROUND(
    (d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14)
    + pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14))
  )::INTEGER AS reorder_point,
  CASE
    WHEN pe.node_id = 'full_ml'
    THEN ROUND((d.d_avg_sem / 7.0) * COALESCE(pe.target_dias_full, 0))::INTEGER
    ELSE 0
  END AS pre_full_target,
  CASE
    WHEN pe.node_id = 'bodega_central'
    THEN ROUND((d.d_avg_sem / 7.0) * COALESCE(pe.target_dias_flex, 0))::INTEGER
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
  pe.flex_priority
FROM politica_efectiva pe
JOIN demand_stats d ON d.sku_origen = pe.sku_origen
LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
WHERE pe.policy_status = 'active'
  AND pe.action <> 'no_reorder'::policy_action_enum;

COMMENT ON VIEW v_safety_stock IS
  'Sprint 4.3b: usa cell_efectiva (snp.cell_efectiva) en lugar de snp.cell para z y target_dias_full. ' ||
  'Cuando un SKU acelera (tendencia in acelerando/acelerando_fuerte), cell_efectiva es la celda promovida ' ||
  '(C→B, B→A) y los parámetros vienen de policy_templates por esa celda. target_dias_flex queda como ' ||
  'override per-SKU (snp.target_dias_flex). Trazabilidad: cell_original + tendencia + promocion_activa.';

-- =============================================================================
-- v_compras_pendientes (rebuild — hereda automáticamente cell_efectiva via vsf.cell)
-- =============================================================================

CREATE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT
    sku_origen,
    SUM(qty_on_hand) AS stock_total,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'bodega_central') AS stock_bodega,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'full_ml') AS stock_full
  FROM v_stock_por_nodo
  GROUP BY sku_origen
),
en_transito AS (
  SELECT sku_origen, SUM(qty_in_transit) AS in_transit_bodega
  FROM v_in_transit_por_nodo
  WHERE to_node_id = 'bodega_central'
  GROUP BY sku_origen
),
pre_full_por_sku AS (
  SELECT sku_origen, pre_full_target FROM v_safety_stock WHERE node_id = 'full_ml'
),
reserva_flex_por_sku AS (
  SELECT sku_origen, reserva_flex_target FROM v_safety_stock WHERE node_id = 'bodega_central'
)
SELECT
  ss.sku_origen,
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
  COALESCE(et.in_transit_bodega, 0::numeric) AS in_transit_bodega,
  ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
  GREATEST(
    0::numeric,
    (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
      - COALESCE(st.stock_total, 0::numeric)
      - COALESCE(et.in_transit_bodega, 0::numeric)
  ) AS qty_a_comprar,
  CASE
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0 THEN NULL::numeric
    ELSE GREATEST(
      0::numeric,
      (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
        - COALESCE(st.stock_total, 0::numeric)
        - COALESCE(et.in_transit_bodega, 0::numeric)
    ) * p.costo_promedio
  END AS clp_estimado,
  CASE
    WHEN ss.d_avg_dia > 0
    THEN ROUND(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
    ELSE NULL::numeric
  END AS dias_cobertura_actual,
  CASE
    WHEN COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_bodega, 0::numeric)
         < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
    THEN true ELSE false
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
  ss.flex_priority
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'
  AND COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_bodega, 0::numeric)
      < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric;

COMMENT ON VIEW v_compras_pendientes IS
  'Sprint 4.3a (multi-canal) + 4.3b (cell_efectiva). Hereda promoción de v_safety_stock.';

-- =============================================================================
-- v_reposicion_explain (rebuild — agrega tendencia, ratios, velocidades por ventana)
-- =============================================================================

CREATE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
  SELECT
    cv.sku_origen,
    SUM(vmc.cantidad)::numeric AS uds_30d_real,
    COUNT(DISTINCT vmc.order_id) AS num_ordenes_30d,
    SUM(vmc.cantidad)::numeric / 30.0 AS vel_real_dia,
    SUM(vmc.cantidad)::numeric * 7.0 / 30.0 AS vel_real_sem
  FROM ventas_ml_cache vmc
  JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
  WHERE vmc.fecha_date >= CURRENT_DATE - 30
    AND vmc.anulada = false
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
  WHERE oc.estado = 'RECIBIDA_PARCIAL'
    AND oc.fecha_recepcion IS NOT NULL
    AND oc.lead_time_real IS NOT NULL
  ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
),
quiebre_por_nodo AS (
  SELECT
    sku_origen,
    MAX(fecha) FILTER (WHERE stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
    MAX(fecha) FILTER (WHERE stock_full > 0) AS ultimo_dia_full_con_stock,
    MIN(fecha) AS primer_snapshot_sku
  FROM stock_snapshots
  GROUP BY sku_origen
)
SELECT
  vsf.sku_origen,
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
  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN NULL::numeric
    ELSE ROUND(((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) * 100, 1)
  END AS vel_drift_pct,
  CASE
    WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0 THEN 'sin_baseline'
    WHEN abs((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'
    WHEN abs((COALESCE(v30.vel_real_sem, 0) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'
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
    WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2 THEN 'aligned'
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
  COALESCE(vsn_b.qty_on_hand, 0::numeric) AS stock_bodega,
  COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
  COALESCE(vsn_b.qty_on_hand, 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
  COALESCE(vit.qty_in_transit, 0::numeric) AS in_transit_bodega,
  CASE WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_bodega_estado,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL::date
    WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
    ELSE qpn.primer_snapshot_sku
  END AS quiebre_bodega_fecha,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 THEN NULL::integer
    WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
    WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
    ELSE NULL::integer
  END AS quiebre_bodega_dias,
  CASE WHEN COALESCE(vsn_f.qty_on_hand, 0) <= 0 THEN 'EN_QUIEBRE' ELSE 'OK' END AS quiebre_full_estado,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL::date
    WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
    ELSE qpn.primer_snapshot_sku
  END AS quiebre_full_fecha,
  CASE
    WHEN COALESCE(vsn_f.qty_on_hand, 0) > 0 THEN NULL::integer
    WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + INTERVAL '1 day')::date, CURRENT_DATE)
    WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
    ELSE NULL::integer
  END AS quiebre_full_dias,
  CASE
    WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
      THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'
    WHEN COALESCE(vsn_b.qty_on_hand, 0) <= 0 AND COALESCE(vsn_f.qty_on_hand, 0) > 0
      THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'
    WHEN COALESCE(vsn_b.qty_on_hand, 0) > 0 AND COALESCE(vsn_f.qty_on_hand, 0) <= 0
      THEN 'Full quebrado: armar envío Bodega→Full hoy. Tenés ' || COALESCE(vsn_b.qty_on_hand, 0)::text || ' unidades disponibles'
    ELSE NULL
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
  -- Sprint 4.3b: tendencia + ventanas
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
  vtd.uds_28d AS uds_ultimas_4_semanas,
  vtd.uds_28d_previas AS uds_4_semanas_previas,
  si.updated_at AS sku_intelligence_updated_at,
  snp.updated_at AS policy_updated_at
FROM v_safety_stock vsf
JOIN productos p ON p.sku = vsf.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen AND snp.node_id = vsf.node_id
LEFT JOIN policy_templates pt ON pt.cell = vsf.cell  -- nota: vsf.cell ya es la efectiva
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

COMMENT ON VIEW v_reposicion_explain IS
  'Sprint 4.3b: agrega tendencia (acelerando/estable/desacelerando), cell_efectiva, ' ||
  'velocidades por ventana (28d recent / 28d previas / baseline 90d) y ratios para ' ||
  'el panel ⓘ. cell_original/cell expone si hay promoción activa.';

COMMIT;
