-- ============================================================================
-- BANVA BODEGA — Migración: qty_reserved en tabla stock
--
-- QUÉ HACE:
--   1. Agrega columna qty_reserved a stock
--   2. Backfill: calcula reserved actual desde ml_shipment_items
--   3. Función reservar_stock() — atómica, previene sobreventa
--   4. Función liberar_reserva() — cuando se despacha o cancela
--   5. Vista v_stock_disponible — reemplaza el JOIN actual
--   6. Vista v_stock_proyectado — para módulo de Reposición
--
-- EJECUTAR EN: Supabase SQL Editor (todo junto, en orden)
-- ANTES DE: hacer deploy del código que use las nuevas funciones
-- ============================================================================


-- ============================================================================
-- PASO 1: Agregar columna qty_reserved
-- ============================================================================

ALTER TABLE stock
ADD COLUMN IF NOT EXISTS qty_reserved INTEGER NOT NULL DEFAULT 0;

-- Constraint: reserved nunca puede ser negativo ni superar cantidad
ALTER TABLE stock
ADD CONSTRAINT stock_qty_reserved_check
CHECK (qty_reserved >= 0);

ALTER TABLE stock
ADD CONSTRAINT stock_reserved_lte_cantidad
CHECK (qty_reserved <= cantidad);


-- ============================================================================
-- PASO 2: Backfill desde ml_shipment_items actuales
--
-- Calcula el committed actual (ready_to_ship + shipped, no fulfillment)
-- y lo escribe en qty_reserved. Esto sincroniza el estado inicial.
-- ============================================================================

-- Primero verificar qué va a hacer (DRY RUN — ejecutar solo para revisar)
-- SELECT
--     si.seller_sku,
--     SUM(si.quantity) AS committed_actual
-- FROM ml_shipment_items si
-- JOIN ml_shipments s ON s.shipment_id = si.shipment_id
-- WHERE s.status IN ('ready_to_ship', 'shipped')
--   AND s.logistic_type != 'fulfillment'
-- GROUP BY si.seller_sku
-- ORDER BY committed_actual DESC;

-- Backfill real: distribuir reserved entre filas de stock por SKU
-- Usa la misma lógica que tu stock-sync: committed a nivel de SKU,
-- distribuido entre las posiciones que tengan stock
WITH committed AS (
    SELECT
        si.seller_sku AS sku,
        SUM(si.quantity) AS total_committed
    FROM ml_shipment_items si
    JOIN ml_shipments s ON s.shipment_id = si.shipment_id
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
    GROUP BY si.seller_sku
),
stock_ranked AS (
    -- Ordenar filas de stock por cantidad DESC para distribuir
    SELECT
        st.id,
        st.sku,
        st.cantidad,
        c.total_committed,
        SUM(st.cantidad) OVER (
            PARTITION BY st.sku
            ORDER BY st.cantidad DESC, st.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_total
    FROM stock st
    JOIN committed c ON c.sku = st.sku
    WHERE st.cantidad > 0
)
UPDATE stock s
SET qty_reserved = GREATEST(0, LEAST(
    sr.cantidad,
    sr.total_committed - (sr.running_total - sr.cantidad)
))
FROM stock_ranked sr
WHERE s.id = sr.id
  AND sr.total_committed - (sr.running_total - sr.cantidad) > 0;


-- ============================================================================
-- PASO 3: Función reservar_stock()
--
-- Llamar cuando llega una orden (webhook ML u otro canal).
-- UPDATE atómico con condición — si no hay stock, retorna false.
-- No necesita SELECT FOR UPDATE a tu escala.
-- ============================================================================

CREATE OR REPLACE FUNCTION reservar_stock(
    p_sku       TEXT,
    p_cantidad  INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_disponible INTEGER;
    v_restante   INTEGER;
    v_row        RECORD;
BEGIN
    -- Verificar disponible total para este SKU
    SELECT COALESCE(SUM(cantidad - qty_reserved), 0)
    INTO v_disponible
    FROM stock
    WHERE sku = p_sku AND cantidad > qty_reserved;

    IF v_disponible < p_cantidad THEN
        RETURN FALSE;  -- Stock insuficiente
    END IF;

    -- Distribuir reserva entre posiciones con stock disponible
    v_restante := p_cantidad;

    FOR v_row IN
        SELECT id, cantidad, qty_reserved, (cantidad - qty_reserved) AS libre
        FROM stock
        WHERE sku = p_sku AND cantidad > qty_reserved
        ORDER BY (cantidad - qty_reserved) DESC, id
        FOR UPDATE  -- Lock las filas que vamos a modificar
    LOOP
        EXIT WHEN v_restante <= 0;

        IF v_row.libre >= v_restante THEN
            -- Esta fila cubre todo lo que falta
            UPDATE stock
            SET qty_reserved = qty_reserved + v_restante,
                updated_at = now()
            WHERE id = v_row.id;
            v_restante := 0;
        ELSE
            -- Reservar todo lo libre de esta fila, seguir con la siguiente
            UPDATE stock
            SET qty_reserved = qty_reserved + v_row.libre,
                updated_at = now()
            WHERE id = v_row.id;
            v_restante := v_restante - v_row.libre;
        END IF;
    END LOOP;

    RETURN (v_restante = 0);
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- PASO 4: Función liberar_reserva()
--
-- Llamar en DOS casos:
--   a) Despacho (picking done): liberar reserva Y descontar stock
--   b) Cancelación: solo liberar reserva sin descontar
-- ============================================================================

CREATE OR REPLACE FUNCTION liberar_reserva(
    p_sku           TEXT,
    p_cantidad      INTEGER,
    p_descontar     BOOLEAN DEFAULT FALSE,  -- true = despacho, false = cancelación
    p_motivo        TEXT DEFAULT NULL,
    p_operario      TEXT DEFAULT ''
) RETURNS BOOLEAN AS $$
DECLARE
    v_restante   INTEGER;
    v_row        RECORD;
BEGIN
    v_restante := p_cantidad;

    FOR v_row IN
        SELECT id, cantidad, qty_reserved, posicion_id
        FROM stock
        WHERE sku = p_sku AND qty_reserved > 0
        ORDER BY qty_reserved DESC, id
        FOR UPDATE
    LOOP
        EXIT WHEN v_restante <= 0;

        IF v_row.qty_reserved >= v_restante THEN
            -- Esta fila cubre todo
            IF p_descontar THEN
                -- Despacho: bajar cantidad Y reserved
                UPDATE stock
                SET cantidad = cantidad - v_restante,
                    qty_reserved = qty_reserved - v_restante,
                    updated_at = now()
                WHERE id = v_row.id;

                -- Registrar movimiento de salida
                INSERT INTO movimientos (tipo, motivo, sku, posicion_id, cantidad, operario, created_at)
                VALUES ('salida', COALESCE(p_motivo, 'despacho'), p_sku, v_row.posicion_id, v_restante, p_operario, now());
            ELSE
                -- Cancelación: solo bajar reserved
                UPDATE stock
                SET qty_reserved = qty_reserved - v_restante,
                    updated_at = now()
                WHERE id = v_row.id;
            END IF;
            v_restante := 0;
        ELSE
            -- Liberar todo el reserved de esta fila
            IF p_descontar THEN
                UPDATE stock
                SET cantidad = cantidad - v_row.qty_reserved,
                    qty_reserved = 0,
                    updated_at = now()
                WHERE id = v_row.id;

                INSERT INTO movimientos (tipo, motivo, sku, posicion_id, cantidad, operario, created_at)
                VALUES ('salida', COALESCE(p_motivo, 'despacho'), p_sku, v_row.posicion_id, v_row.qty_reserved, p_operario, now());
            ELSE
                UPDATE stock
                SET qty_reserved = 0,
                    updated_at = now()
                WHERE id = v_row.id;
            END IF;
            v_restante := v_restante - v_row.qty_reserved;
        END IF;
    END LOOP;

    -- Limpiar filas con cantidad 0
    DELETE FROM stock WHERE sku = p_sku AND cantidad = 0;

    RETURN (v_restante = 0);
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- PASO 5: Vista v_stock_disponible
--
-- REEMPLAZA el JOIN actual a ml_shipment_items en stock-sync.
-- Tu stock-sync pasa de:
--   SELECT SUM(stock.cantidad) - (SELECT SUM(si.quantity) FROM ml_shipment_items...)
-- A simplemente:
--   SELECT * FROM v_stock_disponible WHERE sku = $1
-- ============================================================================

CREATE OR REPLACE VIEW v_stock_disponible AS
SELECT
    sku,
    SUM(cantidad) AS on_hand,
    SUM(qty_reserved) AS reserved,
    SUM(cantidad - qty_reserved) AS disponible
FROM stock
WHERE cantidad > 0
GROUP BY sku;


-- ============================================================================
-- PASO 6: Vista v_stock_proyectado
--
-- Incluye OC pendientes. Para tu módulo de Reposición.
-- ============================================================================

CREATE OR REPLACE VIEW v_stock_proyectado AS
SELECT
    sd.sku,
    sd.on_hand,
    sd.reserved,
    sd.disponible,
    COALESCE(oc.en_camino, 0) AS en_camino,
    sd.disponible + COALESCE(oc.en_camino, 0) AS proyectado
FROM v_stock_disponible sd
LEFT JOIN (
    SELECT
        ocl.sku_origen AS sku,
        SUM(ocl.cantidad_pedida - COALESCE(ocl.cantidad_recibida, 0)) AS en_camino
    FROM ordenes_compra_lineas ocl
    JOIN ordenes_compra oc ON oc.id = ocl.orden_id
    WHERE oc.estado IN ('confirmada', 'en_transito', 'parcial')
    GROUP BY ocl.sku_origen
) oc ON oc.sku = sd.sku;


-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
--
-- Ejecutar después de correr todo lo anterior.
-- Compara qty_reserved vs committed calculado desde ml_shipment_items.
-- Si hay discrepancias grandes, revisar antes de hacer deploy.
-- ============================================================================

-- SELECT
--     sd.sku,
--     sd.reserved AS reserved_en_stock,
--     COALESCE(c.committed_ml, 0) AS committed_en_shipments,
--     sd.reserved - COALESCE(c.committed_ml, 0) AS diferencia
-- FROM v_stock_disponible sd
-- LEFT JOIN (
--     SELECT si.seller_sku AS sku, SUM(si.quantity) AS committed_ml
--     FROM ml_shipment_items si
--     JOIN ml_shipments s ON s.shipment_id = si.shipment_id
--     WHERE s.status IN ('ready_to_ship', 'shipped')
--       AND s.logistic_type != 'fulfillment'
--     GROUP BY si.seller_sku
-- ) c ON c.sku = sd.sku
-- WHERE sd.reserved > 0 OR COALESCE(c.committed_ml, 0) > 0
-- ORDER BY ABS(sd.reserved - COALESCE(c.committed_ml, 0)) DESC;
