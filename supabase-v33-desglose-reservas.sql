-- ============================================================================
-- BANVA BODEGA — Desglose de reservas: Flex vs Full
--
-- Retorna totales separados para mostrar en dashboard.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE FUNCTION desglose_reservas()
RETURNS TABLE(fuente TEXT, total_reservado INTEGER)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY

    SELECT 'flex'::TEXT AS fuente,
        COALESCE(SUM(si.quantity), 0)::INTEGER AS total_reservado
    FROM ml_shipment_items si
    JOIN ml_shipments s ON s.shipment_id = si.shipment_id
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
      AND si.stock_deducted = false

    UNION ALL

    SELECT 'full'::TEXT AS fuente,
        COALESCE(SUM((l->'componentes'->0->>'unidades')::INTEGER), 0)::INTEGER AS total_reservado
    FROM picking_sessions ps,
         jsonb_array_elements(ps.lineas) AS l
    WHERE ps.tipo = 'envio_full'
      AND ps.estado IN ('ABIERTA', 'EN_PROCESO')
      AND l->>'estado' = 'PENDIENTE';
END;
$$;
