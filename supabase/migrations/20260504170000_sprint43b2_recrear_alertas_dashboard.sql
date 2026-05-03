-- =============================================================================
-- Sprint 4.3b.2 — Fix: recrear v_alertas_quiebre + v_reposicion_dashboard
-- =============================================================================
-- Tag: [non-reversible:re-create-views]
--
-- Causa raíz:
--   Sprint 4.3b (20260504130000) hizo `DROP VIEW v_safety_stock CASCADE` para
--   reorganizar columnas con cell_efectiva. El CASCADE tumbó las 4 vistas
--   dependientes pero la migración solo recreó 3 de ellas:
--     ✓ v_safety_stock        (recreada)
--     ✓ v_compras_pendientes  (recreada)
--     ✓ v_reposicion_explain  (recreada)
--     ✗ v_alertas_quiebre     ← quedó huérfana
--     ✗ v_reposicion_dashboard ← quedó huérfana
--
-- Síntoma: /admin/reposicion-suggestions tira 500
--   "Could not find the table 'public.v_reposicion_dashboard' in the schema cache".
--
-- Fix: recrear las 2 vistas. Sin DROP previo (no existen). Sin tocar las otras.
-- Las definiciones replican la versión sana del Sprint 4.3a
-- (20260504100100_sprint43a_views_with_old_logic.sql:208-242). Verificado contra
-- columnas actuales de v_compras_pendientes (todas existen).
--
-- Por qué [non-reversible]: re-create de vistas (sin data); el atlas tracker
-- detecta diff de schema. No hay backup de la definición previa más reciente
-- en código (Sprint 4.3a es la última versión sana, pero post-4.3b las dos
-- vistas no existieron entre el deploy de 4.3b y este fix).
-- =============================================================================

-- v_alertas_quiebre — niveles + prioridad sobre v_compras_pendientes filtrada por bajo_rop
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

COMMENT ON VIEW v_alertas_quiebre IS 'Sprint 4 + 4.3a + 4.3b.2: alertas priorizadas. Hereda velocidad efectiva via v_compras_pendientes.';


-- v_reposicion_dashboard — master view consumida por /admin/reposicion-suggestions
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

COMMENT ON VIEW v_reposicion_dashboard IS 'Sprint 4 + 4.3a + 4.3b.2: master view consumida por /admin/reposicion-suggestions.';
