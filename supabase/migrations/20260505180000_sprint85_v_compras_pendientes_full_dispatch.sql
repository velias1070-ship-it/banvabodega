-- Sprint 8.5 — Extender filtro v_compras_pendientes para incluir despacho Full
-- batch:20260505-sprint-85-full-dispatch | sprint:8.5 | hotfix:full-dispatch-gap
--
-- Bug: v_compras_pendientes filtra solo "necesita comprar" (stock_total +
-- in_transit < ROP_combinado). SKUs con stock total OK pero distribuido mal
-- (Full=0, bodega con stock disponible) son excluidos => deficit_full,
-- disponible_para_full y mandar_full_uds quedan NULL en v_reposicion_explain
-- via LEFT JOIN, aunque accion='MANDAR_FULL' este correcta.
--
-- Caso testigo: ALPCMPRCL4575 (Limpiapies Coco 45x75 Clean).
--   stock_full=0, stock_bodega=47, in_transit=45 (OC al proveedor)
--   pre_full_target=40, reserva_flex_target=5, safety=4 => ROP=49
--   Filtro: (47+45) < 49 = false => excluido
--   Pero stock_full=0 < pre_full_target=40 AND stock_bodega(47) > reserva(5)
--   El SKU NECESITA despacho Bodega->Full ya, aunque no necesite comprar.
--
-- Fix: agregar tercera rama al filtro WHERE para capturar "deficit Full con
-- disponibilidad en bodega", independiente del estado de compra.
--
-- Resultado validacion: 32 SKUs adicionales pasan el filtro (152 -> 184).
-- ALPCMPRCL4575 ahora con mandar_full_uds=40, deficit_full=40,
-- disponible_para_full=42 (47 - 5 reserva).
--
-- Definicion verbatim de v_compras_pendientes excepto la cláusula WHERE final.

CREATE OR REPLACE VIEW public.v_compras_pendientes AS
WITH stock_total_por_sku AS (
  SELECT v.sku_origen,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total,
    sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bodega,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml'::text) AS stock_full,
    sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bruto_bodega,
    sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS qty_reserved_bodega
  FROM v_stock_por_nodo v
  GROUP BY v.sku_origen
), en_transito AS (
  SELECT v.sku_origen,
    sum(v.qty_in_transit) AS in_transit_total,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
    sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
  FROM v_in_transit_por_nodo v
  GROUP BY v.sku_origen
), pre_full_por_sku AS (
  SELECT s.sku_origen, s.pre_full_target
  FROM v_safety_stock s
  WHERE s.node_id = 'full_ml'::text
), reserva_flex_por_sku AS (
  SELECT s.sku_origen, s.reserva_flex_target
  FROM v_safety_stock s
  WHERE s.node_id = 'bodega_central'::text
), inner_packs AS (
  SELECT p_1.sku, COALESCE(pc.inner_pack, p_1.inner_pack, 1) AS inner_pack
  FROM productos p_1
  LEFT JOIN proveedor_catalogo pc ON pc.sku_origen = p_1.sku AND pc.proveedor_id = p_1.proveedor_id
), policy_bodega AS (
  SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad
  FROM sku_node_policy snp
  WHERE snp.node_id = 'bodega_central'::text
), qty_calc AS (
  SELECT ss_1.sku_origen,
    GREATEST(0::numeric, (COALESCE(ss_1.safety_stock, 0) + COALESCE(pf_1.pre_full_target, 0) + COALESCE(rf_1.reserva_flex_target, 0))::numeric - COALESCE(st_1.stock_total, 0::numeric) - COALESCE(et_1.in_transit_total, 0::numeric)) AS qty_raw,
    ip_1.inner_pack
  FROM v_safety_stock ss_1
  LEFT JOIN stock_total_por_sku st_1 ON st_1.sku_origen = ss_1.sku_origen
  LEFT JOIN en_transito et_1 ON et_1.sku_origen = ss_1.sku_origen
  LEFT JOIN pre_full_por_sku pf_1 ON pf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN reserva_flex_por_sku rf_1 ON rf_1.sku_origen = ss_1.sku_origen
  LEFT JOIN inner_packs ip_1 ON ip_1.sku = ss_1.sku_origen
  WHERE ss_1.node_id = 'bodega_central'::text
)
SELECT ss.sku_origen,
  p.nombre,
  ss.cell, ss.cell_original, ss.tendencia,
  ss.promocion_activa, ss.promocion_motivo,
  ss.policy_action, ss.xyz_confidence, ss.seasonal_match_source,
  ss.z, ss.lt_dias, ss.d_avg_dia, ss.cycle_stock, ss.safety_stock, ss.reorder_point,
  COALESCE(pf.pre_full_target, 0) AS pre_full_target,
  COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
  COALESCE(st.stock_total, 0::numeric) AS stock_total,
  COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
  COALESCE(st.stock_full, 0::numeric) AS stock_full,
  COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
  COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
  qc.qty_raw,
  COALESCE(ip.inner_pack, 1) AS inner_pack,
  CASE
    WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
    ELSE qc.qty_raw
  END AS qty_a_comprar,
  CASE
    WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
    ELSE qc.qty_raw
  END - qc.qty_raw AS delta_pack,
  CASE
    WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
    ELSE
      CASE
        WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0::numeric THEN ceil(qc.qty_raw / ip.inner_pack::numeric) * ip.inner_pack::numeric
        ELSE qc.qty_raw
      END * p.costo_promedio
  END AS clp_estimado,
  CASE
    WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
    ELSE NULL::numeric
  END AS dias_cobertura_actual,
  CASE
    WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric)) < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric THEN true
    ELSE false
  END AS bajo_rop,
  p.proveedor_id, pr.nombre_canonico AS proveedor_nombre,
  ss.es_quiebre_proveedor, ss.vel_pre_quiebre, ss.vel_actual,
  ss.factor_rampup_aplicado, ss.rampup_motivo,
  ss.evento_activo, ss.multiplicador_evento,
  ss.target_dias_flex, ss.flex_priority,
  COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
  COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
  COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
  COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
  COALESCE(pb.is_new_sku, false) AS is_new_sku,
  pb.accion AS accion_nueva,
  pb.prioridad AS prioridad_nueva,
  GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric)) AS deficit_full,
  GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric) AS disponible_para_full,
  CASE
    WHEN COALESCE(pb.is_new_sku, false) = true AND COALESCE(st.stock_full, 0::numeric) = 0::numeric AND COALESCE(st.stock_bodega, 0::numeric) > 0::numeric
      THEN LEAST(GREATEST(COALESCE(ip.inner_pack, 1), 2)::numeric, COALESCE(st.stock_bodega, 0::numeric))
    WHEN COALESCE(ss.vel_actual, 0::numeric) > 0::numeric
         AND GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric)) > 0::numeric
         AND GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric) > 0::numeric
      THEN LEAST(ceil(GREATEST(0::numeric, COALESCE(pf.pre_full_target, 0)::numeric - COALESCE(st.stock_full, 0::numeric) - COALESCE(et.in_transit_picking_full, 0::numeric))),
                 GREATEST(0::numeric, COALESCE(st.stock_bodega, 0::numeric) - COALESCE(rf.reserva_flex_target, 0)::numeric))
    ELSE 0::numeric
  END AS mandar_full_uds
FROM v_safety_stock ss
JOIN productos p ON p.sku = ss.sku_origen
LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
LEFT JOIN inner_packs ip ON ip.sku = ss.sku_origen
LEFT JOIN policy_bodega pb ON pb.sku_origen = ss.sku_origen
LEFT JOIN qty_calc qc ON qc.sku_origen = ss.sku_origen
WHERE ss.node_id = 'bodega_central'::text
  AND (
    -- Caso 1 (legacy): bajo ROP combinado => necesita comprar
    (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
      < (COALESCE(ss.safety_stock, 0) + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
    -- Caso 2 (legacy): SKU nuevo (bypass)
    OR COALESCE(pb.is_new_sku, false)
    -- Caso 3 (Sprint 8.5): deficit Full con disponibilidad en bodega.
    -- Captura SKUs con accion='MANDAR_FULL' que tenian deficit_full/mandar_full_uds=NULL
    -- por exclusion del filtro 1-D de compra. ALPCMPRCL4575 caso testigo.
    OR (COALESCE(st.stock_full, 0::numeric) < COALESCE(pf.pre_full_target, 0)::numeric
        AND COALESCE(st.stock_bodega, 0::numeric) > COALESCE(rf.reserva_flex_target, 0)::numeric)
  );
