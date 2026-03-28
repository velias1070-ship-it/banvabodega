-- v31: Fix cutoff de calcular_reservas_correctas()
-- Bug: usaba MIN(updated_at) de shipments pendientes como cutoff para contar picks.
-- Si el sync de ML actualizaba updated_at DESPUÉS del picking, los picks quedaban
-- antes del cutoff y no se contaban → stock comprometido nunca bajaba.
-- Fix: usar handling_limit - 48h como cutoff (estable, no cambia con syncs).

CREATE OR REPLACE FUNCTION calcular_reservas_correctas()
RETURNS TABLE(sku_fisico TEXT, qty_deberia_reservar INTEGER) AS $$
BEGIN
  RETURN QUERY
  WITH shipment_demand AS (
    SELECT
      resolver_sku_fisico(si.seller_sku) AS sku,
      SUM(si.quantity)::INTEGER AS total_qty
    FROM ml_shipment_items si
    JOIN ml_shipments s ON s.shipment_id = si.shipment_id
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
    GROUP BY resolver_sku_fisico(si.seller_sku)
  ),
  oldest_pending AS (
    SELECT MIN(s.handling_limit) - interval '48 hours' AS cutoff
    FROM ml_shipments s
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
      AND s.handling_limit IS NOT NULL
  ),
  picked_qty AS (
    SELECT
      UPPER(m.sku) AS sku,
      SUM(m.cantidad)::INTEGER AS qty_picked
    FROM movimientos m, oldest_pending op
    WHERE m.tipo = 'salida'
      AND m.motivo = 'venta_flex'
      AND m.created_at >= COALESCE(op.cutoff, now() - interval '7 days')
    GROUP BY UPPER(m.sku)
  )
  SELECT
    sd.sku AS sku_fisico,
    GREATEST(0, sd.total_qty - COALESCE(pq.qty_picked, 0))::INTEGER AS qty_deberia_reservar
  FROM shipment_demand sd
  LEFT JOIN picked_qty pq ON pq.sku = sd.sku;
END;
$$ LANGUAGE plpgsql STABLE;
