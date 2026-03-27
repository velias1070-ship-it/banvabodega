-- ============================================================================
-- BANVA BODEGA — Migración v29: Función reconciliar_reservas()
--
-- QUÉ HACE:
--   Recalcula qty_reserved en tabla stock basándose en shipments pendientes
--   reales (ready_to_ship + shipped, no fulfillment).
--   Resuelve seller_sku → sku_origen via composicion_venta (primer mapeo).
--   DESCUENTA items ya pickeados desde picking_sessions (componentes PICKEADO).
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE FUNCTION reconciliar_reservas()
RETURNS TABLE(out_sku TEXT, reserva_anterior INTEGER, reserva_nueva INTEGER) AS $$
DECLARE
    v_row RECORD;
    v_restante INTEGER;
    v_stock_row RECORD;
BEGIN
    -- Paso 1: Guardar estado anterior para el reporte
    DROP TABLE IF EXISTS _prev_reserved;
    CREATE TEMP TABLE _prev_reserved ON COMMIT DROP AS
    SELECT s.sku, SUM(s.qty_reserved)::INTEGER AS prev
    FROM stock s WHERE s.qty_reserved > 0 GROUP BY s.sku;

    -- Paso 2: Reset todas las reservas a 0
    UPDATE stock SET qty_reserved = 0 WHERE qty_reserved > 0;

    -- Paso 3: Calcular items ya pickeados desde sesiones ACTIVAS (no completadas)
    -- Solo sesiones ABIERTA/EN_PROCESO — las COMPLETADA ya deberían tener
    -- sus shipments en shipped/delivered (ya no aparecen en committed)
    DROP TABLE IF EXISTS _picked;
    CREATE TEMP TABLE _picked ON COMMIT DROP AS
    SELECT
        UPPER(comp->>'skuOrigen') AS sku,
        SUM((comp->>'unidades')::INTEGER) AS qty_picked
    FROM picking_sessions ps,
        jsonb_array_elements(ps.lineas) AS linea,
        jsonb_array_elements(linea->'componentes') AS comp
    WHERE ps.tipo = 'flex'
      AND ps.estado IN ('ABIERTA', 'EN_PROCESO')
      AND comp->>'estado' = 'PICKEADO'
    GROUP BY UPPER(comp->>'skuOrigen');

    -- Paso 4: Calcular committed real desde shipments pendientes
    -- Resuelve seller_sku → sku_origen via composicion_venta (solo primer mapeo)
    -- Luego resta lo ya pickeado
    FOR v_row IN
        SELECT
            committed.sku_fisico,
            GREATEST(0, committed.total_qty - COALESCE(pk.qty_picked, 0))::INTEGER AS net_qty
        FROM (
            SELECT
                UPPER(COALESCE(cv.sku_origen, si.seller_sku)) AS sku_fisico,
                SUM(si.quantity)::INTEGER AS total_qty
            FROM ml_shipment_items si
            JOIN ml_shipments s ON s.shipment_id = si.shipment_id
            LEFT JOIN (
                SELECT DISTINCT ON (UPPER(sku_venta))
                    UPPER(sku_venta) AS sku_venta_upper,
                    UPPER(sku_origen) AS sku_origen
                FROM composicion_venta ORDER BY UPPER(sku_venta), id
            ) cv ON cv.sku_venta_upper = UPPER(si.seller_sku)
            WHERE s.status IN ('ready_to_ship', 'shipped')
              AND s.logistic_type != 'fulfillment'
            GROUP BY UPPER(COALESCE(cv.sku_origen, si.seller_sku))
        ) committed
        LEFT JOIN _picked pk ON pk.sku = committed.sku_fisico
        WHERE GREATEST(0, committed.total_qty - COALESCE(pk.qty_picked, 0)) > 0
    LOOP
        -- Distribuir reserva entre posiciones con stock
        v_restante := v_row.net_qty;

        FOR v_stock_row IN
            SELECT stock.id, stock.cantidad, stock.qty_reserved, (stock.cantidad - stock.qty_reserved) AS libre
            FROM stock
            WHERE stock.sku = v_row.sku_fisico AND stock.cantidad > stock.qty_reserved
            ORDER BY (stock.cantidad - stock.qty_reserved) DESC, stock.id
            FOR UPDATE
        LOOP
            EXIT WHEN v_restante <= 0;

            IF v_stock_row.libre >= v_restante THEN
                UPDATE stock SET qty_reserved = qty_reserved + v_restante, updated_at = now()
                WHERE id = v_stock_row.id;
                v_restante := 0;
            ELSE
                UPDATE stock SET qty_reserved = qty_reserved + v_stock_row.libre, updated_at = now()
                WHERE id = v_stock_row.id;
                v_restante := v_restante - v_stock_row.libre;
            END IF;
        END LOOP;
    END LOOP;

    -- Paso 5: Retornar reporte de cambios
    RETURN QUERY
    SELECT
        COALESCE(p.sku, n.sku) AS out_sku,
        COALESCE(p.prev, 0)::INTEGER AS reserva_anterior,
        COALESCE(n.nuevo, 0)::INTEGER AS reserva_nueva
    FROM _prev_reserved p
    FULL OUTER JOIN (
        SELECT st.sku, SUM(st.qty_reserved)::INTEGER AS nuevo
        FROM stock st WHERE st.qty_reserved > 0 GROUP BY st.sku
    ) n ON n.sku = p.sku
    WHERE COALESCE(p.prev, 0) != COALESCE(n.nuevo, 0);
END;
$$ LANGUAGE plpgsql;
