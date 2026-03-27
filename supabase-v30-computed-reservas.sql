-- ============================================================================
-- BANVA BODEGA — Migración v30: Modelo computado de reservas
--
-- CAMBIO FUNDAMENTAL:
--   qty_reserved ya no se mantiene incrementalmente (webhook reserva, pick libera).
--   Se COMPUTA desde el estado actual: shipments pendientes - items pickeados.
--   Se materializa periódicamente via reconciliar_reservas().
--
-- FUNCIONES:
--   1. resolver_sku_fisico() — resolución canónica seller_sku → sku físico
--   2. calcular_reservas_correctas() — computación pura sin side effects
--   3. reconciliar_reservas() — materializa per-SKU (no destructiva global)
--   4. auto_adjust_reserved trigger — previene constraint violation
--
-- EJECUTAR EN: Supabase SQL Editor (reemplaza v29)
-- ============================================================================


-- ============================================================================
-- 1. resolver_sku_fisico() — Resolución canónica de SKU
--
-- Prioridad: mapeo real (origen != venta) > auto-referencial > passthrough
-- ============================================================================

CREATE OR REPLACE FUNCTION resolver_sku_fisico(p_seller_sku TEXT)
RETURNS TEXT AS $$
  SELECT COALESCE(
    -- Prioridad 1: mapeo donde origen es diferente a venta (mapeo real)
    (SELECT UPPER(sku_origen) FROM composicion_venta
     WHERE UPPER(sku_venta) = UPPER(p_seller_sku)
       AND UPPER(sku_origen) != UPPER(sku_venta)
     ORDER BY id LIMIT 1),
    -- Prioridad 2: cualquier mapeo (incluye auto-referencial)
    (SELECT UPPER(sku_origen) FROM composicion_venta
     WHERE UPPER(sku_venta) = UPPER(p_seller_sku)
     ORDER BY id LIMIT 1),
    -- Prioridad 3: passthrough (el seller_sku es el físico)
    UPPER(p_seller_sku)
  );
$$ LANGUAGE sql STABLE;


-- ============================================================================
-- 2. calcular_reservas_correctas() — Computación pura
--
-- Retorna qué qty_reserved DEBERÍA tener cada SKU basándose en:
--   shipments pendientes (ready_to_ship/shipped) - items ya pickeados
-- ============================================================================

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
    -- Find when the oldest pending shipment was last updated
    -- Movements before this are from already-delivered shipments
    SELECT MIN(s.updated_at) AS cutoff
    FROM ml_shipments s
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
  ),
  picked_qty AS (
    -- Count flex picks since the oldest pending shipment arrived.
    -- This excludes picks from already-delivered shipments.
    SELECT
      UPPER(m.sku) AS sku,
      SUM(m.cantidad)::INTEGER AS qty_picked
    FROM movimientos m, oldest_pending op
    WHERE m.tipo = 'salida'
      AND m.motivo = 'venta_flex'
      AND m.created_at >= COALESCE(op.cutoff, now())
    GROUP BY UPPER(m.sku)
  )
  SELECT
    sd.sku AS sku_fisico,
    GREATEST(0, sd.total_qty - COALESCE(pq.qty_picked, 0))::INTEGER AS qty_deberia_reservar
  FROM shipment_demand sd
  LEFT JOIN picked_qty pq ON pq.sku = sd.sku;
END;
$$ LANGUAGE plpgsql STABLE;


-- ============================================================================
-- 3. reconciliar_reservas() — Materialización no-destructiva
--
-- Opera por SKU: solo toca los SKUs que necesitan ajuste.
-- No hace reset global — seguro para ejecución concurrente con picking.
-- ============================================================================

DROP FUNCTION IF EXISTS reconciliar_reservas();

CREATE OR REPLACE FUNCTION reconciliar_reservas()
RETURNS TABLE(out_sku TEXT, reserva_anterior INTEGER, reserva_nueva INTEGER) AS $$
DECLARE
  v_row RECORD;
  v_restante INTEGER;
  v_stock_row RECORD;
BEGIN
  FOR v_row IN
    SELECT
      COALESCE(c.sku_fisico, s.sku) AS sku,
      COALESCE(s.current_reserved, 0)::INTEGER AS current_reserved,
      COALESCE(c.qty_deberia_reservar, 0)::INTEGER AS target_reserved
    FROM calcular_reservas_correctas() c
    FULL OUTER JOIN (
      SELECT stock.sku, SUM(stock.qty_reserved)::INTEGER AS current_reserved
      FROM stock WHERE stock.qty_reserved > 0 GROUP BY stock.sku
    ) s ON s.sku = c.sku_fisico
    WHERE COALESCE(s.current_reserved, 0) != COALESCE(c.qty_deberia_reservar, 0)
  LOOP
    -- Resetear reservas solo para ESTE SKU
    UPDATE stock SET qty_reserved = 0, updated_at = now()
    WHERE stock.sku = v_row.sku AND stock.qty_reserved > 0;

    -- Si hay que reservar, distribuir entre posiciones
    IF v_row.target_reserved > 0 THEN
      v_restante := v_row.target_reserved;
      FOR v_stock_row IN
        SELECT stock.id, stock.cantidad
        FROM stock
        WHERE stock.sku = v_row.sku AND stock.cantidad > 0
        ORDER BY stock.cantidad DESC, stock.id
        FOR UPDATE
      LOOP
        EXIT WHEN v_restante <= 0;
        IF v_stock_row.cantidad >= v_restante THEN
          UPDATE stock SET qty_reserved = v_restante, updated_at = now()
          WHERE id = v_stock_row.id;
          v_restante := 0;
        ELSE
          UPDATE stock SET qty_reserved = v_stock_row.cantidad, updated_at = now()
          WHERE id = v_stock_row.id;
          v_restante := v_restante - v_stock_row.cantidad;
        END IF;
      END LOOP;
    END IF;

    -- Reportar cambio
    out_sku := v_row.sku;
    reserva_anterior := v_row.current_reserved;
    reserva_nueva := v_row.target_reserved;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 4. Trigger auto_adjust_reserved
--
-- Si cantidad baja por debajo de qty_reserved (ej: stock deducido por picking),
-- ajusta qty_reserved automáticamente para evitar constraint violation.
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_adjust_reserved()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cantidad < NEW.qty_reserved THEN
    NEW.qty_reserved := GREATEST(0, NEW.cantidad);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_adjust_reserved ON stock;

CREATE TRIGGER trg_auto_adjust_reserved
BEFORE UPDATE ON stock
FOR EACH ROW
EXECUTE FUNCTION auto_adjust_reserved();
