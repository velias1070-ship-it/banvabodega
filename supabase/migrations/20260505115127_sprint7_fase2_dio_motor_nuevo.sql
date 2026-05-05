-- Sprint 7 Fase 2 — DIO en motor nuevo
-- batch:20260505-sprint-7-fase2 | sprint:7 | fase:2
--
-- Motor viejo (intelligence.ts:1280): dio = (stock_total/vel_pond)*7
-- (vel_pond es semanal → /vel_pond * 7 = días). Centinela 999 si vel=0.
-- Motor nuevo no exponía DIO al pipeline.
--
-- Fix: agregar dio a v_safety_stock (formula equivalente: stock_total/d_avg_dia)
-- y propagar a v_reposicion_explain. Caso testigo JSAFAB422P20S: stock=1,
-- d_avg_dia=0.4 → DIO=2.5 días (paridad exacta con motor viejo).
--
-- CASCADE: v_compras_pendientes + v_reposicion_explain (sin cambios de lógica,
-- solo reconstrucción por dependencia).

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;
DROP VIEW IF EXISTS v_safety_stock CASCADE;

CREATE VIEW v_safety_stock AS
WITH demand_stats AS (
  SELECT si.sku_origen,
         CASE
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
   WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric
      OR si.dias_en_quiebre >= 14 AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric
      OR (EXISTS (SELECT 1
                    FROM sku_node_policy snp
                   WHERE snp.sku_origen = si.sku_origen
                     AND snp.is_new_sku = true))
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
         snp.action,
         snp.xyz_confidence,
         snp.seasonal_match_source,
         snp.policy_status,
         snp.flex_priority,
         snp.tendencia,
         snp.promocion_activa,
         snp.promocion_motivo,
         snp.is_new_sku
    FROM sku_node_policy snp
    LEFT JOIN policy_templates pt_efectiva
      ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
), stock_por_sku AS (
  -- Sprint 7 Fase 2: stock_total para DIO. Mismo cálculo que v_compras_pendientes
  -- (canonico vía v_stock_por_nodo).
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
           WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric
             THEN COALESCE(pe.z_value, 0::numeric)
                  * (d.sigma_sem / sqrt(7.0))
                  * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
           ELSE COALESCE(pe.z_value, 0::numeric)
                * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)
                       * power(d.sigma_sem / sqrt(7.0), 2::numeric)
                       + power(d.d_avg_sem / 7.0, 2::numeric)
                         * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric))
                * 1.075
         END)::integer AS safety_stock,
       round(d.d_avg_sem / 7.0
             * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
       round(d.d_avg_sem / 7.0
             * COALESCE(slt.lt_dias_avg, 14::numeric)
             + COALESCE(pe.z_value, 0::numeric)
               * (d.sigma_sem / sqrt(7.0))
               * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
       CASE
         WHEN pe.node_id = 'full_ml'::text
           THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer
         ELSE 0
       END AS pre_full_target,
       CASE
         WHEN pe.node_id = 'bodega_central'::text
           THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer
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
       -- Sprint 7 Fase 2: DIO = stock_total / d_avg_dia. Centinela 999 si vel=0
       -- (paridad exacta con motor viejo intelligence.ts:1280).
       CASE
         WHEN d.d_avg_sem > 0::numeric AND COALESCE(sps.stock_total, 0::numeric) >= 0::numeric
           THEN round(COALESCE(sps.stock_total, 0::numeric) / (d.d_avg_sem / 7.0), 2)
         ELSE 999::numeric
       END AS dio
  FROM politica_efectiva pe
  JOIN demand_stats d ON d.sku_origen = pe.sku_origen
  LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
  LEFT JOIN stock_por_sku sps ON sps.sku_origen = pe.sku_origen
 WHERE pe.policy_status = 'active'::text
   AND (pe.action <> 'no_reorder'::policy_action_enum OR pe.is_new_sku = true);
