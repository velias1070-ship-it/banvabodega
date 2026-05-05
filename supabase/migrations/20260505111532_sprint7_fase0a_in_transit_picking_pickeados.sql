-- Sprint 7 Fase 0.A — Fix lane bodega_to_full
-- batch:20260505-sprint-7-fase0 | sprint:7 | fase:0a
--
-- Bug: v_in_transit_por_nodo cuenta componentes en estado != 'PICKEADO'
-- (interpretado como "pendientes de pickear"). Pero la doctrina operativa
-- es la inversa: stock_bodega YA DESCONTÓ los componentes pickeados (vía
-- registrar_movimiento_stock motivo='envio_full'), y stock_full aún no
-- los suma porque ML no los confirmó como recibidos. Esos uds están
-- fisicamente "in transit" entre bodega → Full.
--
-- Fix: lane bodega_to_full = SUM(componente.unidades) WHERE
-- componente.estado='PICKEADO' AND ps.estado IN ('ABIERTA','EN_PROCESO').
-- ETA estimada: ps.created_at + 3 días (ML inbound típico).
--
-- CASCADE: v_safety_stock + v_compras_pendientes + v_reposicion_explain
-- consumen v_in_transit_por_nodo.

DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;
DROP VIEW IF EXISTS v_safety_stock CASCADE;
DROP VIEW IF EXISTS v_in_transit_por_nodo CASCADE;

CREATE VIEW v_in_transit_por_nodo AS
-- Lane: supplier_to_bodega (OCs proveedor pendientes/transito/parciales)
SELECT upper(TRIM(BOTH FROM ocl.sku_origen)) AS sku_origen,
       'bodega_central'::text AS to_node_id,
       'supplier_generic'::text AS from_node_id,
       'supplier_to_bodega'::text AS lane_id,
       sum((ocl.cantidad_pedida - COALESCE(ocl.cantidad_recibida, 0))::numeric) AS qty_in_transit,
       min(oc.fecha_esperada) AS earliest_eta,
       min(oc.fecha_emision) AS earliest_fecha_emision
  FROM ordenes_compra_lineas ocl
  JOIN ordenes_compra oc ON oc.id = ocl.orden_id
 WHERE oc.estado = ANY (ARRAY['PENDIENTE'::text,'EN_TRANSITO'::text,'RECIBIDA_PARCIAL'::text])
   AND ocl.cantidad_pedida > COALESCE(ocl.cantidad_recibida, 0)
 GROUP BY upper(TRIM(BOTH FROM ocl.sku_origen))

UNION ALL

-- Lane: bodega_to_full (pickings tipo envio_full con líneas PICKEADAS,
-- aún no confirmadas como recibidas por ML).
SELECT upper(TRIM(BOTH FROM componente.value ->> 'skuOrigen')) AS sku_origen,
       'full_ml'::text AS to_node_id,
       'bodega_central'::text AS from_node_id,
       'bodega_to_full'::text AS lane_id,
       sum((componente.value ->> 'unidades')::integer)::numeric AS qty_in_transit,
       (min(ps.created_at)::date + INTERVAL '3 days')::date AS earliest_eta,
       min(ps.created_at)::date AS earliest_fecha_emision
  FROM picking_sessions ps,
       LATERAL jsonb_array_elements(ps.lineas) linea(value),
       LATERAL jsonb_array_elements(linea.value -> 'componentes') componente(value)
 WHERE ps.tipo = 'envio_full'
   AND ps.estado = ANY (ARRAY['ABIERTA'::text,'EN_PROCESO'::text])
   AND (componente.value ->> 'estado') = 'PICKEADO'
   AND (componente.value ->> 'skuOrigen') IS NOT NULL
 GROUP BY upper(TRIM(BOTH FROM componente.value ->> 'skuOrigen'));
