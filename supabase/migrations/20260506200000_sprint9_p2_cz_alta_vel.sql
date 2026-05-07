-- Sprint 9 P2 — Template CZ_alta_vel rescata SKUs CZ con venta histórica
-- batch:20260506-sprint-9-p2-cz-rescate | sprint:9 | milestone:sprint-9-cz-rescate
-- tag: hotfix:cz-rescate-no-reorder
--
-- Doctrina: Sprint 9 P1 hizo que v_safety_stock filtre por
-- policy_templates.action ∈ {buy,...} excluyendo no_reorder.  CZ tiene
-- action='no_reorder' → 9/13 SKUs propuestos por owner quedaron silenciados
-- pese a tener venta histórica relevante (ver casos testigo en
-- sprint-9-backlog.md).
--
-- 3 cambios:
--
-- (1) Ampliar check de policy_templates.cell para aceptar sub-cuadrantes
--     con sufijo (CZ_alta_vel, futuros _liquidar, _seasonal, etc.).
--
-- (2) INSERT template CZ_alta_vel con action=reorder_normal pero
--     target chico (CY-like) y safety conservador (sl/z=NULL → SS=0,
--     cycle_stock cubre LT) — son SKUs erráticos, no inflar buffer.
--
-- (3) Extender refresh_trend_in_sku_node_policy con tercer UPDATE que
--     promueve SKUs CZ a CZ_alta_vel cuando cumplen reglas de venta:
--       - uds_180d >= 10 OR uds_365d >= 20, y ult_venta <= 120d
--       - O uds_30d >= 1, y ult_venta <= 7d (rescate "vendió esta semana")
--
-- (4) CREATE OR REPLACE v_safety_stock para incluir SKUs rescatados con
--     vel_actual=0 + vel_pre_quiebre>0 (caso JSAFAB397P20X: 25 uds en
--     180d, vendió hace 80d, vel_30d=0).  Sin esta rama, el rescate
--     cell_efectiva no surte efecto downstream para SKUs sin
--     velocidad reciente.

-- ───────────────────────────────────────────────────────────────────────
-- (1) Ampliar check policy_templates.cell
-- ───────────────────────────────────────────────────────────────────────
ALTER TABLE policy_templates DROP CONSTRAINT IF EXISTS policy_templates_cell_check;
ALTER TABLE policy_templates ADD CONSTRAINT policy_templates_cell_check
  CHECK (cell ~ '^[ABC][XYZ](_[a-z_]+)?$');

-- ───────────────────────────────────────────────────────────────────────
-- (2) INSERT template CZ_alta_vel
-- ───────────────────────────────────────────────────────────────────────
INSERT INTO policy_templates (cell, action, target_dias_full, target_dias_flex, service_level, z_value, source_ref)
VALUES (
  'CZ_alta_vel',
  'reorder_normal'::policy_action_enum,
  7,
  2,
  NULL,
  NULL,
  'Sprint 9 P2: rescate SKUs CZ con uds_180d>=10 OR uds_365d>=20 (ult_venta<=120d) OR uds_30d>=1 + ult_venta<=7d. Action=reorder_normal devuelve a vista downstream con safety mínimo (cycle_stock cubre LT). Sin z_value para no inflar SS en SKUs erráticos.'
)
ON CONFLICT (cell) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────
-- (3) Extender refresh_trend_in_sku_node_policy con rescate CZ_alta_vel
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION refresh_trend_in_sku_node_policy()
RETURNS TABLE(rows_affected INTEGER, summary JSONB)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matched INTEGER;
  v_orphans INTEGER;
  v_cz_rescate INTEGER;
  v_summary JSONB;
BEGIN
  -- (A) Update existente: aplicar trend → cell_efectiva (acelerando promueve)
  WITH updates AS (
    UPDATE sku_node_policy snp
    SET tendencia = vtd.tendencia,
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
    RETURNING vtd.tendencia AS t_tendencia,
              (vtd.tendencia IN ('acelerando','acelerando_fuerte')
               AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')) AS t_promovido
  )
  SELECT COUNT(*)::INTEGER,
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

  -- (B) Orphans (sin v_trend_detection): cell_efectiva = cell
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

  -- (C) Sprint 9 P2: rescate CZ_alta_vel
  -- Solo SKUs cell='CZ' que NO fueron promovidos por trend (cell_efectiva='CZ').
  WITH ventas_agg AS (
    SELECT cv.sku_origen,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 30) AS uds_30d,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 180) AS uds_180d,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 365) AS uds_365d,
      MAX(vmc.fecha_date) AS ultima_venta
    FROM ventas_ml_cache vmc
    JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
    WHERE vmc.anulada = false
    GROUP BY cv.sku_origen
  ),
  rescate AS (
    UPDATE sku_node_policy snp
    SET cell_efectiva = 'CZ_alta_vel',
        promocion_activa = true,
        promocion_motivo = FORMAT(
          'Rescate CZ_alta_vel: uds_30d=%s, uds_180d=%s, uds_365d=%s, ult_venta=%s',
          COALESCE(va.uds_30d, 0), COALESCE(va.uds_180d, 0),
          COALESCE(va.uds_365d, 0), va.ultima_venta::text
        ),
        tendencia_updated_at = now()
    FROM ventas_agg va
    WHERE snp.sku_origen = va.sku_origen
      AND snp.policy_status = 'active'
      AND snp.cell = 'CZ'
      AND snp.cell_efectiva = 'CZ'
      AND (
        ((COALESCE(va.uds_180d, 0) >= 10 OR COALESCE(va.uds_365d, 0) >= 20)
         AND va.ultima_venta >= CURRENT_DATE - 120)
        OR (COALESCE(va.uds_30d, 0) >= 1
            AND va.ultima_venta >= CURRENT_DATE - 7)
      )
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM rescate INTO v_cz_rescate;

  v_summary := v_summary || jsonb_build_object(
    'orphans_no_sales_90d', v_orphans,
    'cz_alta_vel_rescates', v_cz_rescate
  );
  RETURN QUERY SELECT (v_matched + v_orphans + v_cz_rescate), v_summary;
END;
$$;

COMMENT ON FUNCTION refresh_trend_in_sku_node_policy() IS
  'Sprint 9 P2: triple update — (A) trend → cell_efectiva, (B) orphans → cell_efectiva=cell, (C) CZ_alta_vel rescate (uds_180d>=10 OR uds_365d>=20 [ult_venta<=120d] OR uds_30d>=1 [ult_venta<=7d]).';

-- ───────────────────────────────────────────────────────────────────────
-- (4) Ampliar v_safety_stock para incluir SKUs CZ_alta_vel sin vel actual
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_safety_stock AS
 WITH demand_stats AS (
         SELECT si.sku_origen,
                CASE
                    WHEN si.dias_en_quiebre >= 14 AND si.vel_pre_quiebre IS NOT NULL AND si.vel_pre_quiebre > 0::numeric AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0::numeric) THEN si.vel_pre_quiebre
                    WHEN COALESCE(si.multiplicador_evento, 1.0) > 1::numeric THEN COALESCE(si.vel_ponderada, 0::numeric) * si.multiplicador_evento
                    -- Sprint 9 P2: SKUs rescatados a CZ_alta_vel sin vel actual usan vel_pre_quiebre
                    WHEN COALESCE(si.vel_ponderada, 0::numeric) = 0::numeric
                         AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric
                         AND EXISTS (SELECT 1 FROM sku_node_policy snp
                                     WHERE snp.sku_origen = si.sku_origen
                                       AND snp.cell_efectiva LIKE '%\_alta\_vel' ESCAPE '\')
                    THEN si.vel_pre_quiebre
                    ELSE COALESCE(si.vel_ponderada, 0::numeric)
                END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
            COALESCE(NULLIF(si.desviacion_std, 0::numeric), COALESCE(si.vel_ponderada, 0::numeric) * 0.3) AS sigma_sem,
            si.es_quiebre_proveedor, si.vel_pre_quiebre,
            si.vel_ponderada AS vel_actual,
            si.factor_rampup_aplicado, si.rampup_motivo,
            si.evento_activo, si.multiplicador_evento
           FROM sku_intelligence si
          WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric
             OR (si.dias_en_quiebre >= 14 AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric)
             OR EXISTS (SELECT 1 FROM sku_node_policy snp
                        WHERE snp.sku_origen = si.sku_origen AND snp.is_new_sku = true)
             -- Sprint 9 P2: incluir SKUs rescatados a CZ_alta_vel sin vel actual
             OR (COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric
                 AND EXISTS (SELECT 1 FROM sku_node_policy snp
                             WHERE snp.sku_origen = si.sku_origen
                               AND snp.cell_efectiva LIKE '%\_alta\_vel' ESCAPE '\'))
        ), supplier_lt AS (
         SELECT p.sku, p.proveedor_id,
            COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
            COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
           FROM productos p
             LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
          WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'::text
        ), politica_efectiva AS (
         SELECT snp.sku_origen, snp.node_id,
            COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada,
            snp.cell AS cell_original,
            COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
            COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
            snp.target_dias_flex,
            COALESCE(pt_efectiva.action, snp.action) AS action,
            snp.xyz_confidence, snp.seasonal_match_source, snp.policy_status,
            snp.flex_priority, snp.tendencia, snp.promocion_activa, snp.promocion_motivo,
            snp.is_new_sku
           FROM sku_node_policy snp
             LEFT JOIN policy_templates pt_efectiva ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
        ), stock_por_sku AS (
         SELECT v.sku_origen, sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total
           FROM v_stock_por_nodo v GROUP BY v.sku_origen
        )
 SELECT pe.sku_origen, pe.node_id,
    pe.cell_aplicada AS cell, pe.cell_original,
    pe.tendencia, pe.promocion_activa, pe.promocion_motivo,
    pe.action AS policy_action, pe.z_value AS z,
    d.d_avg_sem, d.d_avg_sem / 7.0 AS d_avg_dia,
    d.sigma_sem, d.sigma_sem / sqrt(7.0) AS sigma_dia,
    COALESCE(slt.lt_dias_avg, 14::numeric) AS lt_dias,
    COALESCE(slt.sigma_lt, 2::numeric) AS sigma_lt,
    round(
        CASE
            WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric THEN COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
            ELSE COALESCE(pe.z_value, 0::numeric) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric) * power(d.sigma_sem / sqrt(7.0), 2::numeric) + power(d.d_avg_sem / 7.0, 2::numeric) * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric)) * 1.075
        END)::integer AS safety_stock,
    round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
    round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric) + COALESCE(pe.z_value, 0::numeric) * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
    CASE WHEN pe.node_id = 'full_ml'::text THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer ELSE 0 END AS pre_full_target,
    CASE WHEN pe.node_id = 'bodega_central'::text THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer ELSE 0 END AS reserva_flex_target,
    pe.xyz_confidence, pe.seasonal_match_source, pe.policy_status,
    d.es_quiebre_proveedor, d.vel_pre_quiebre, d.vel_actual,
    d.factor_rampup_aplicado, d.rampup_motivo, d.evento_activo, d.multiplicador_evento,
    pe.target_dias_flex, pe.flex_priority,
    CASE WHEN d.d_avg_sem > 0::numeric AND COALESCE(sps.stock_total, 0::numeric) >= 0::numeric THEN round(COALESCE(sps.stock_total, 0::numeric) / (d.d_avg_sem / 7.0), 2) ELSE 999::numeric END AS dio
   FROM politica_efectiva pe
     JOIN demand_stats d ON d.sku_origen = pe.sku_origen
     LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
     LEFT JOIN stock_por_sku sps ON sps.sku_origen = pe.sku_origen
  WHERE pe.policy_status = 'active'::text
    AND (pe.action <> 'no_reorder'::policy_action_enum OR pe.is_new_sku = true);

-- ───────────────────────────────────────────────────────────────────────
-- (5) Disparar el refresh para repoblar cell_efectiva con la nueva lógica
-- ───────────────────────────────────────────────────────────────────────
SELECT * FROM refresh_trend_in_sku_node_policy();
