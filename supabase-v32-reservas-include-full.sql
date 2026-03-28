-- ============================================================================
-- BANVA BODEGA — calcular_reservas_correctas incluye envío a Full
--
-- Ahora qty_reserved considera DOS fuentes:
-- 1. Ventas Flex pendientes (ml_shipment_items WHERE stock_deducted = false)
-- 2. Envíos a Full pendientes de pickear (picking_sessions envio_full)
--
-- Previene que reconciliar_reservas() borre las reservas de envío Full
-- cuando corre después de cada webhook.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE FUNCTION calcular_reservas_correctas()
RETURNS TABLE(sku_fisico TEXT, qty_deberia_reservar INTEGER)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    WITH
    flex_demand AS (
        SELECT
            resolver_sku_fisico(si.seller_sku) AS sku,
            SUM(si.quantity)::INTEGER AS qty
        FROM ml_shipment_items si
        JOIN ml_shipments s ON s.shipment_id = si.shipment_id
        WHERE s.status IN ('ready_to_ship', 'shipped')
          AND s.logistic_type != 'fulfillment'
          AND si.stock_deducted = false
        GROUP BY resolver_sku_fisico(si.seller_sku)
    ),
    full_demand AS (
        SELECT
            UPPER(l->'componentes'->0->>'skuOrigen') AS sku,
            SUM((l->'componentes'->0->>'unidades')::INTEGER)::INTEGER AS qty
        FROM picking_sessions ps,
             jsonb_array_elements(ps.lineas) AS l
        WHERE ps.tipo = 'envio_full'
          AND ps.estado IN ('ABIERTA', 'EN_PROCESO')
          AND l->>'estado' = 'PENDIENTE'
        GROUP BY UPPER(l->'componentes'->0->>'skuOrigen')
    ),
    combined AS (
        SELECT sku, SUM(qty)::INTEGER AS total
        FROM (
            SELECT sku, qty FROM flex_demand
            UNION ALL
            SELECT sku, qty FROM full_demand
        ) all_demand
        GROUP BY sku
    )
    SELECT c.sku AS sku_fisico, c.total AS qty_deberia_reservar
    FROM combined c
    WHERE c.total > 0;
END;
$$;
