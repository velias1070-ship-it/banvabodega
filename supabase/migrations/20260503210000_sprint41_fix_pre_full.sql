-- =============================================================================
-- Sprint 4.1 — Fix bug pre_full_target en v_compras_pendientes
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-03
-- Tag PR: [batch:20260503-5]
--
-- Bug detectado por owner en validación post-Sprint 4 (LITAF400G4PCL):
--   v_safety_stock genera 2 filas por SKU activo (bodega_central + full_ml).
--   pre_full_target solo es != 0 en la fila full_ml. v_compras_pendientes
--   filtra `WHERE ss.node_id = 'bodega_central'` por lo que se queda con
--   pre_full_target = 0. Resultado: stock_objetivo no incluye lo que hay
--   que pre-posicionar en Full → qty_a_comprar al proveedor sub-pide.
--
-- Ejemplo confirmado (pre-fix):
--   LITAF400G4PCL (Set 4 Toallas A. Family Celeste, AX, vel=0.697/día):
--     pre_full_target en fila bodega = 0
--     pre_full_target en fila full_ml = 29 (= round(0.697 × 42))
--     qty_a_comprar = 4 (debería ser ~33).
--
-- Fix: agregar CTE `pre_full_por_sku` que extrae pre_full del nodo full_ml.
-- LEFT JOIN a la fila bodega para sumar al stock_objetivo. Recalcular
-- qty_a_comprar y bajo_rop sobre el stock_objetivo nuevo (no contra el ROP
-- viejo, que era solo bodega).
--
-- Sin cambios en v_safety_stock (la fórmula base está bien).
-- Sin cambios en v_alertas_quiebre / v_reposicion_dashboard (heredan
-- automáticamente porque consumen v_compras_pendientes).
--
-- Idempotente: CREATE OR REPLACE VIEW.
-- Validación: tests/sprint41_validation.sql.
-- =============================================================================

CREATE OR REPLACE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT
    sku_origen,
    SUM(qty_on_hand)                                           AS stock_total,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'bodega_central') AS stock_bodega,
    SUM(qty_on_hand) FILTER (WHERE node_id = 'full_ml')        AS stock_full
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
  -- Sprint 4.1 fix: pre_full_target SOLO existe en la fila full_ml de
  -- v_safety_stock. Lo levantamos por SKU y lo sumamos al stock_objetivo
  -- de bodega para que la sugerencia al proveedor incluya lo que hay
  -- que pre-posicionar en Full.
  SELECT sku_origen, pre_full_target
  FROM v_safety_stock
  WHERE node_id = 'full_ml'
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
  -- pre_full_target ahora viene del nodo full_ml (Sprint 4.1 fix)
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(st.stock_total, 0)        AS stock_total,
  COALESCE(st.stock_bodega, 0)       AS stock_bodega,
  COALESCE(st.stock_full, 0)         AS stock_full,
  COALESCE(et.in_transit_bodega, 0)  AS in_transit_bodega,
  -- stock_objetivo incluye pre_full_full_ml (Sprint 4.1 fix)
  ss.cycle_stock + ss.safety_stock + COALESCE(pf.pre_full_target, 0) AS stock_objetivo,
  GREATEST(
    0,
    (ss.cycle_stock + ss.safety_stock + COALESCE(pf.pre_full_target, 0))
    - COALESCE(st.stock_total, 0)
    - COALESCE(et.in_transit_bodega, 0)
  ) AS qty_a_comprar,
  CASE
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0 THEN NULL
    ELSE GREATEST(0,
      (ss.cycle_stock + ss.safety_stock + COALESCE(pf.pre_full_target, 0))
      - COALESCE(st.stock_total, 0)
      - COALESCE(et.in_transit_bodega, 0)
    ) * p.costo_promedio
  END AS clp_estimado,
  CASE WHEN ss.d_avg_dia > 0 THEN ROUND(COALESCE(st.stock_total, 0) / ss.d_avg_dia) ELSE NULL END AS dias_cobertura_actual,
  -- bajo_rop ahora compara contra stock_objetivo nuevo (Sprint 4.1 fix)
  CASE
    WHEN COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0)
         < (ss.cycle_stock + ss.safety_stock + COALESCE(pf.pre_full_target, 0))
    THEN true ELSE false
  END AS bajo_rop,
  p.proveedor_id,
  pr.nombre_canonico AS proveedor_nombre
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'
  AND COALESCE(st.stock_total, 0) + COALESCE(et.in_transit_bodega, 0)
       < (ss.cycle_stock + ss.safety_stock + COALESCE(pf.pre_full_target, 0));

COMMENT ON VIEW v_compras_pendientes IS
  'Sprint 4.1 (2026-05-03): fix bug pre_full_target. La fila bodega_central de v_safety_stock tiene pre_full=0 (solo full_ml lo tiene >0). Antes: stock_objetivo no incluía pre-posicionado a Full → sub-pedía. Ahora: pre_full_target proviene del nodo full_ml via CTE pre_full_por_sku. stock_objetivo = cycle + SS + pre_full_full_ml. bajo_rop compara contra stock_objetivo (no contra reorder_point bodega-only). Sin cambios en v_safety_stock (fórmula base correcta). v_alertas_quiebre y v_reposicion_dashboard heredan automáticamente.';