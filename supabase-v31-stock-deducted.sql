-- ============================================================================
-- BANVA BODEGA — stock_deducted en ml_shipment_items
--
-- Marca qué items de shipment ya tuvieron su stock descontado via picking.
-- calcular_reservas_correctas() solo reserva items NO descontados.
-- Previene doble-conteo cuando pickeos de pedidos viejos se confundían
-- con pedidos nuevos del mismo SKU.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

ALTER TABLE ml_shipment_items ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: delivered/cancelled ya fueron descontados
UPDATE ml_shipment_items si
SET stock_deducted = true
FROM ml_shipments s
WHERE s.shipment_id = si.shipment_id
  AND s.status IN ('delivered', 'cancelled', 'not_delivered');

-- Actualizar calcular_reservas_correctas para usar stock_deducted
CREATE OR REPLACE FUNCTION calcular_reservas_correctas()
RETURNS TABLE(sku_fisico TEXT, qty_deberia_reservar INTEGER)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    SELECT
        resolver_sku_fisico(si.seller_sku) AS sku_fisico,
        SUM(si.quantity)::INTEGER AS qty_deberia_reservar
    FROM ml_shipment_items si
    JOIN ml_shipments s ON s.shipment_id = si.shipment_id
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
      AND si.stock_deducted = false
    GROUP BY resolver_sku_fisico(si.seller_sku);
END;
$$;
