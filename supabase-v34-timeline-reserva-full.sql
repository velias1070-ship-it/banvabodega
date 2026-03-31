-- ============================================================================
-- BANVA BODEGA — Timeline: agregar reservas de envío a Full
--
-- Agrega un UNION ALL a v_timeline_sku para mostrar las líneas PENDIENTE
-- de picking sessions envio_full como eventos "reserva" en el timeline.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE VIEW v_timeline_sku AS

-- 1. Movimientos
SELECT
    m.created_at AS ts,
    'movimiento' AS evento,
    m.sku,
    m.tipo || ': ' || COALESCE(m.motivo, '') AS detalle,
    CASE WHEN m.tipo = 'entrada' THEN m.cantidad ELSE -m.cantidad END AS delta,
    m.qty_after,
    m.posicion_id AS posicion,
    m.operario,
    m.nota,
    m.id::TEXT AS referencia_id
FROM movimientos m

UNION ALL

-- 2. Syncs ML
SELECT
    a.created_at AS ts,
    'sync_ml' AS evento,
    COALESCE(a.params->>'sku_origen', a.params->>'sku') AS sku,
    'PUT a ML: ' || (a.params->>'quantity') || ' uds' AS detalle,
    ((a.params->>'quantity')::int - (a.params->>'currentInML')::int) AS delta,
    NULL AS qty_after,
    NULL AS posicion,
    'sync' AS operario,
    'ML actual: ' || (a.params->>'currentInML') || ' → ' || (a.params->>'quantity') AS nota,
    a.entidad_id AS referencia_id
FROM audit_log a
WHERE a.accion = 'stock_sync:put_ok'

UNION ALL

-- 3. Reservas Flex (shipments pendientes)
SELECT
    s.updated_at AS ts,
    'reserva' AS evento,
    resolver_sku_fisico(si.seller_sku) AS sku,
    'Pedido ' || s.status || ': ' || si.quantity || ' uds' AS detalle,
    NULL AS delta,
    NULL AS qty_after,
    NULL AS posicion,
    COALESCE(s.receiver_name, '') AS operario,
    'Shipment ' || s.shipment_id || ' — ' || si.seller_sku
        || CASE WHEN si.stock_deducted THEN ' (pickeado)' ELSE ' (pendiente)' END AS nota,
    s.shipment_id::TEXT AS referencia_id
FROM ml_shipment_items si
JOIN ml_shipments s ON s.shipment_id = si.shipment_id
WHERE s.status IN ('ready_to_ship', 'shipped')
  AND s.logistic_type != 'fulfillment'

UNION ALL

-- 4. Reservas envío a Full (picking sessions pendientes)
SELECT
    ps.created_at AS ts,
    'reserva_full' AS evento,
    UPPER(l->'componentes'->0->>'skuOrigen') AS sku,
    'Envío a Full: ' || (l->'componentes'->0->>'unidades')::TEXT || ' uds' AS detalle,
    -((l->'componentes'->0->>'unidades')::INTEGER) AS delta,
    NULL AS qty_after,
    NULL AS posicion,
    COALESCE(ps.created_by, 'Admin') AS operario,
    ps.titulo || ' — ' || COALESCE(l->>'skuVenta', '')
        || CASE WHEN l->>'estado' = 'PENDIENTE' THEN ' (pendiente)' ELSE ' (pickeado)' END AS nota,
    ps.id::TEXT AS referencia_id
FROM picking_sessions ps,
     jsonb_array_elements(ps.lineas) AS l
WHERE ps.tipo = 'envio_full'
  AND ps.estado IN ('ABIERTA', 'EN_PROCESO')

ORDER BY ts DESC;
