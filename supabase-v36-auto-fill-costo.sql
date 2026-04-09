-- ============================================
-- BANVA BODEGA — v36: Auto-fill costo desde costo_promedio
-- Si productos.costo = 0 y costo_promedio > 0, copiar automáticamente.
-- También actualizar en cada recepción futura.
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

-- 1. Backfill: copiar costo_promedio a costo donde costo = 0
UPDATE productos
SET costo = costo_promedio
WHERE (costo IS NULL OR costo = 0)
  AND costo_promedio IS NOT NULL
  AND costo_promedio > 0;

-- 2. Actualizar RPC registrar_movimiento_stock para auto-fill costo
-- Después de calcular costo_promedio, si costo = 0 lo actualiza también
CREATE OR REPLACE FUNCTION registrar_movimiento_stock(
    p_sku TEXT,
    p_posicion TEXT,
    p_delta INTEGER,
    p_tipo TEXT DEFAULT 'entrada',
    p_razon TEXT DEFAULT NULL,
    p_operario TEXT DEFAULT NULL,
    p_nota TEXT DEFAULT NULL,
    p_sku_venta TEXT DEFAULT NULL,
    p_costo_unitario NUMERIC DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_movimiento_id UUID;
    v_stock_total INTEGER;
    v_costo_actual NUMERIC;
    v_nuevo_promedio NUMERIC;
    v_costo_diccionario NUMERIC;
BEGIN
    -- 1. Registrar movimiento
    INSERT INTO movimientos (sku, posicion_id, cantidad, tipo, razon, operario, nota, sku_venta, costo_unitario)
    VALUES (p_sku, p_posicion, ABS(p_delta), p_tipo, p_razon, p_operario, p_nota, p_sku_venta, p_costo_unitario)
    RETURNING id INTO v_movimiento_id;

    -- 2. Actualizar stock
    PERFORM update_stock(p_sku, p_posicion, p_delta, p_sku_venta);

    -- 3. Recalcular costo promedio ponderado en productos (solo en entradas con costo)
    IF p_tipo = 'entrada' AND p_costo_unitario IS NOT NULL AND p_costo_unitario > 0 THEN
        -- Leer stock total ACTUAL (ya incluye el delta)
        SELECT COALESCE(SUM(cantidad), 0) INTO v_stock_total
        FROM stock WHERE sku = p_sku;

        -- Leer costo promedio actual
        SELECT COALESCE(costo_promedio, 0) INTO v_costo_actual
        FROM productos WHERE sku = p_sku;

        -- Calcular nuevo promedio ponderado
        IF v_stock_total <= ABS(p_delta) THEN
            -- No había stock antes, el nuevo costo es el de esta entrada
            v_nuevo_promedio := p_costo_unitario;
        ELSE
            -- (stock_anterior * costo_anterior + delta * costo_nuevo) / stock_total
            v_nuevo_promedio := (
                ((v_stock_total - ABS(p_delta)) * v_costo_actual) + (ABS(p_delta) * p_costo_unitario)
            ) / v_stock_total;
        END IF;

        -- Leer costo diccionario actual
        SELECT COALESCE(costo, 0) INTO v_costo_diccionario
        FROM productos WHERE sku = p_sku;

        -- Actualizar costo_promedio, y si costo = 0 auto-fill con el promedio
        IF v_costo_diccionario = 0 THEN
            UPDATE productos
            SET costo_promedio = ROUND(v_nuevo_promedio, 2),
                costo = ROUND(v_nuevo_promedio, 2)
            WHERE sku = p_sku;
        ELSE
            UPDATE productos
            SET costo_promedio = ROUND(v_nuevo_promedio, 2)
            WHERE sku = p_sku;
        END IF;
    END IF;

    RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- FIN v36
-- ============================================
