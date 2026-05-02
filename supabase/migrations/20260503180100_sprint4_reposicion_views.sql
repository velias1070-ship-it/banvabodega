-- =============================================================================
-- Sprint 4 — Vistas SQL para reposición humana (Camino 1)
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-4]
--
-- 4 vistas que consolidan sku_node_policy + sku_intelligence + stock real
-- + proveedores en un dashboard listo para decisiones humanas:
--
--  v_safety_stock           — SS, cycle_stock, ROP, pre_full_target.
--  v_compras_pendientes     — qué reordenar y cuánto, con costo CLP.
--  v_alertas_quiebre        — SKUs en/cerca de quiebre, priorizados.
--  v_reposicion_dashboard   — vista master para /admin/reposicion-suggestions.
--
-- ADAPTACIONES SPEC vs SCHEMA REAL:
--  - sku_node_policy.action      (NO policy_action)
--  - sku_node_policy.z_value     (NO z_score)
--  - sku_intelligence.desviacion_std  (NO sigma_demand_sem; semanal)
--  - v_stock_por_nodo.qty_on_hand     (NO on_hand)
--  - v_in_transit_por_nodo.qty_in_transit + to_node_id (NO sku-grouped)
--
-- Idempotente: CREATE OR REPLACE en cada vista.
-- Validación: tests/sprint4_validation.sql + tests/sprint4_golden_tests.sql.
-- =============================================================================

-- =============================================================================
-- v_safety_stock — SS, cycle_stock, ROP, pre_full_target
-- =============================================================================

CREATE OR REPLACE VIEW v_safety_stock AS
WITH demand_stats AS (
  -- desviacion_std está calculado en intelligence.ts:1549 a partir de
  -- semanas activas. Fallback: 30% de vel_ponderada cuando ausente.
  SELECT
    si.sku_origen,
    si.vel_ponderada                                              AS d_avg_sem,
    COALESCE(NULLIF(si.desviacion_std, 0), si.vel_ponderada * 0.3) AS sigma_sem
  FROM sku_intelligence si
  WHERE si.vel_ponderada IS NOT NULL
    AND si.vel_ponderada > 0
),
supplier_lt AS (
  -- Lead time canónico: proveedores.lead_time_dias (Sprint 0 limpieza).
  -- Fallback: productos.lead_time_dias (legacy). σ_LT default 2 días.
  SELECT
    p.sku,
    p.proveedor_id,
    COALESCE(pr.lead_time_dias, p.lead_time_dias, 14) AS lt_dias_avg,
    COALESCE(pr.lead_time_sigma_dias, 2)              AS sigma_lt
  FROM productos p
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  WHERE p.estado_sku = 'activo' OR p.estado_sku IS NULL
)
SELECT
  snp.sku_origen,
  snp.node_id,
  snp.cell,
  snp.action            AS policy_action,
  snp.z_value           AS z,
  d.d_avg_sem,
  d.d_avg_sem / 7.0     AS d_avg_dia,
  d.sigma_sem,
  d.sigma_sem / sqrt(7.0) AS sigma_dia,
  COALESCE(slt.lt_dias_avg, 14) AS lt_dias,
  COALESCE(slt.sigma_lt,    2)  AS sigma_lt,
  -- safety_stock: fórmula combinada cuando σ_LT >= 2 (importados China),
  -- simple Idetex local cuando σ_LT < 2. Margen 7.5% por return rate.
  ROUND(
    CASE
      WHEN COALESCE(slt.sigma_lt, 0) < 2 THEN
        snp.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14)) * 1.075
      ELSE
        snp.z_value * sqrt(
          COALESCE(slt.lt_dias_avg, 14) * power(d.sigma_sem / sqrt(7.0), 2)
          + power(d.d_avg_sem / 7.0, 2) * power(COALESCE(slt.sigma_lt, 2), 2)
        ) * 1.075
    END
  )::int AS safety_stock,
  -- cycle_stock = velocidad_dia × LT
  ROUND((d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14))::int AS cycle_stock,
  -- ROP = cycle_stock + safety_stock simple (sin margen 7.5%)
  ROUND(
    (d.d_avg_sem / 7.0) * COALESCE(slt.lt_dias_avg, 14)
    + snp.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14))
  )::int AS reorder_point,
  -- pre_full_target solo cuando node es full_ml
  CASE
    WHEN snp.node_id = 'full_ml' THEN
      ROUND((d.d_avg_sem / 7.0) * COALESCE(snp.target_dias_full, 0))::int
    ELSE 0
  END AS pre_full_target,
  snp.xyz_confidence,
  snp.seasonal_match_source,
  snp.policy_status
FROM sku_node_policy snp
JOIN demand_stats d  ON d.sku_origen   = snp.sku_origen
LEFT JOIN supplier_lt slt ON slt.sku   = snp.sku_origen
WHERE snp.policy_status = 'active'
  AND snp.action       <> 'no_reorder';

COMMENT ON VIEW v_safety_stock IS
  'Sprint 4 (2026-05-03): SS + cycle_stock + ROP + pre_full_target por (SKU x Nodo). Lee sku_node_policy + sku_intelligence (vel_ponderada, desviacion_std semanal) + proveedores (lead_time_dias, lead_time_sigma_dias). Excluye CZ y blocked. Fórmula combinada cuando sigma_lt>=2 (importados China), simple cuando <2 (Idetex local). Margen 7.5% por return rate. Vista canónica para reposición Camino 1 (humanos consultan).';


-- =============================================================================
-- v_compras_pendientes — qué reordenar (solo bodega_central, bajo ROP)
-- =============================================================================

CREATE OR REPLACE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT
    sku_origen,
    SUM(qty_on_hand)                                               AS stock_total,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'bodega_central')     AS stock_bodega,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'full_ml')            AS stock_full
  FROM v_stock_por_nodo
  GROUP BY sku_origen
),
en_transito AS (
  -- in_transit hacia bodega_central (compras a proveedor)
  SELECT
    sku_origen,
    SUM(qty_in_transit) AS in_transit_bodega
  FROM v_in_transit_por_nodo
  WHERE to_node_id = 'bodega_central'
  GROUP BY sku_origen
)
SELECT
  ss.sku_origen,
  p.nombre,
  ss.cell,
  ss.policy_action,
  ss.xyz_confidence,
  ss.seasonal_match_source,
  ss.z,
  ss.lt_dias,
  ss.d_avg_dia,
  ss.cycle_stock,
  ss.safety_stock,
  ss.reorder_point,
  ss.pre_full_target,
  COALESCE(st.stock_total, 0)        AS stock_total,
  COALESCE(st.stock_bodega, 0)       AS stock_bodega,
  COALESCE(st.stock_full, 0)         AS stock_full,
  COALESCE(et.in_transit_bodega, 0)  AS in_transit_bodega,
  -- Stock objetivo total (cycle + SS + pre_full si aplica)
  ss.cycle_stock + ss.safety_stock + ss.pre_full_target AS stock_objetivo,
  -- Cantidad a comprar (lower-bounded en 0)
  GREATEST(
    0,
    (ss.cycle_stock + ss.safety_stock + ss.pre_full_target)
    - COALESCE(st.stock_total, 0)
    - COALESCE(et.in_transit_bodega, 0)
  ) AS qty_a_comprar,
  -- Costo CLP estimado (NULL si sin costo conocido — feedback_no_inferir_costos)
  CASE
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0 THEN NULL
    ELSE GREATEST(
           0,
           (ss.cycle_stock + ss.safety_stock + ss.pre_full_target)
           - COALESCE(st.stock_total, 0)
           - COALESCE(et.in_transit_bodega, 0)
         ) * p.costo_promedio
  END AS clp_estimado,
  -- Días de cobertura actual
  CASE
    WHEN ss.d_avg_dia > 0 THEN ROUND(COALESCE(st.stock_total, 0) / ss.d_avg_dia)
    ELSE NULL
  END AS dias_cobertura_actual,
  -- Flag bajo ROP (incluye in_transit como buffer)
  CASE
    WHEN COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0) < ss.reorder_point
    THEN true ELSE false
  END AS bajo_rop,
  p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr           ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st   ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et           ON et.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'  -- compras a proveedor van a bodega
  AND COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0) < ss.reorder_point;

COMMENT ON VIEW v_compras_pendientes IS
  'Sprint 4: SKUs con stock_total + in_transit < ROP. Excluye CZ (no_reorder). Cantidad sugerida = stock_objetivo - stock_actual - in_transit. Costo NULL cuando productos.costo_promedio es NULL (feedback_no_inferir_costos: no rellenar). Lectura humana: ordenar por dias_cobertura_actual ASC para priorizar críticos.';


-- =============================================================================
-- v_alertas_quiebre — priorizada para alertas operativas
-- =============================================================================

CREATE OR REPLACE VIEW v_alertas_quiebre AS
SELECT
  vcp.sku_origen,
  vcp.nombre,
  vcp.cell,
  vcp.stock_total,
  vcp.stock_bodega,
  vcp.stock_full,
  vcp.dias_cobertura_actual,
  vcp.qty_a_comprar,
  vcp.clp_estimado,
  vcp.proveedor_nombre,
  CASE
    WHEN vcp.stock_total = 0                       THEN 'QUIEBRE_TOTAL'
    WHEN vcp.dias_cobertura_actual <= 3            THEN 'CRITICO'
    WHEN vcp.dias_cobertura_actual <= 7            THEN 'URGENTE'
    WHEN vcp.dias_cobertura_actual <= 14           THEN 'ATENCION'
    ELSE 'OK'
  END AS nivel_alerta,
  CASE
    WHEN vcp.stock_total = 0 AND vcp.cell IN ('AX','AY','AZ') THEN 1
    WHEN vcp.stock_total = 0                                  THEN 2
    WHEN vcp.dias_cobertura_actual <= 3 AND vcp.cell IN ('AX','AY','AZ') THEN 3
    WHEN vcp.dias_cobertura_actual <= 3                       THEN 4
    WHEN vcp.dias_cobertura_actual <= 7                       THEN 5
    ELSE 9
  END AS prioridad
FROM v_compras_pendientes vcp
WHERE vcp.bajo_rop = true;

COMMENT ON VIEW v_alertas_quiebre IS
  'Sprint 4: vista priorizada de SKUs en o cerca de quiebre. Niveles: QUIEBRE_TOTAL > CRITICO (<=3d) > URGENTE (<=7d) > ATENCION (<=14d) > OK. Estrellas (AX/AY/AZ) priorizadas dentro de mismo nivel.';


-- =============================================================================
-- v_reposicion_dashboard — master para /admin/reposicion-suggestions
-- =============================================================================

CREATE OR REPLACE VIEW v_reposicion_dashboard AS
SELECT
  vcp.sku_origen,
  vcp.nombre,
  vcp.cell,
  vcp.policy_action,
  vcp.xyz_confidence,
  vcp.seasonal_match_source,
  vcp.proveedor_nombre,
  vcp.proveedor_id,
  vcp.stock_bodega,
  vcp.stock_full,
  vcp.stock_total,
  vcp.in_transit_bodega,
  vcp.cycle_stock,
  vcp.safety_stock,
  vcp.reorder_point,
  vcp.pre_full_target,
  vcp.stock_objetivo,
  vcp.qty_a_comprar,
  vcp.clp_estimado,
  vcp.dias_cobertura_actual,
  vcp.bajo_rop,
  COALESCE(vaq.nivel_alerta, 'OK') AS nivel_alerta,
  COALESCE(vaq.prioridad,    9)    AS prioridad,
  vcp.lt_dias,
  vcp.z,
  vcp.d_avg_dia
FROM v_compras_pendientes vcp
LEFT JOIN v_alertas_quiebre vaq USING (sku_origen);

COMMENT ON VIEW v_reposicion_dashboard IS
  'Sprint 4: master view consumida por /admin/reposicion-suggestions. Consolida stock + politica + sugerencia + alerta. Default ORDER BY prioridad ASC, clp_estimado DESC NULLS LAST.';
