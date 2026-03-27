-- v28: Migración de costos — costo_promedio en productos + costo_unitario en movimientos
-- Permite valorizar inventario a costo promedio ponderado (weighted average cost)
-- en vez de usar el costo de catálogo (productos.costo).

-- =============================================================
-- 1. Agregar costo_unitario a movimientos
--    Solo se llena en entradas. Salidas/transferencias = NULL.
-- =============================================================
ALTER TABLE movimientos
ADD COLUMN IF NOT EXISTS costo_unitario NUMERIC DEFAULT NULL;

-- =============================================================
-- 2. Agregar costo_promedio a productos
--    Valor real ponderado. productos.costo sigue siendo referencia/catálogo.
-- =============================================================
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS costo_promedio NUMERIC NOT NULL DEFAULT 0;

-- Backfill: inicializar con el costo de catálogo actual
UPDATE productos
SET costo_promedio = COALESCE(costo, 0)
WHERE costo_promedio = 0 AND COALESCE(costo, 0) > 0;

-- =============================================================
-- 3. Actualizar registrar_movimiento_stock() para soportar costo
--    Agrega p_costo_unitario. Cuando es entrada con costo,
--    recalcula productos.costo_promedio (weighted average).
-- =============================================================
CREATE OR REPLACE FUNCTION registrar_movimiento_stock(
    p_sku         TEXT,
    p_posicion    TEXT,
    p_delta       INTEGER,
    p_tipo        TEXT,           -- 'entrada', 'salida', 'transferencia', 'ajuste'
    p_sku_venta   TEXT DEFAULT NULL,
    p_motivo      TEXT DEFAULT NULL,
    p_operario    TEXT DEFAULT '',
    p_nota        TEXT DEFAULT '',
    p_recepcion_id UUID DEFAULT NULL,
    p_costo_unitario NUMERIC DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_movimiento_id UUID;
    v_stock_total   INTEGER;
    v_costo_actual  NUMERIC;
    v_nuevo_promedio NUMERIC;
BEGIN
    -- 1. INSERT en movimientos (audit trail / fuente de verdad)
    INSERT INTO movimientos (
        tipo, motivo, sku, posicion_id, cantidad,
        operario, nota, recepcion_id, costo_unitario, created_at
    ) VALUES (
        p_tipo, p_motivo, p_sku, p_posicion, ABS(p_delta),
        p_operario, p_nota, p_recepcion_id, p_costo_unitario, now()
    )
    RETURNING id INTO v_movimiento_id;

    -- 2. UPDATE stock (caché) — reutiliza función existente
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

        UPDATE productos
        SET costo_promedio = ROUND(v_nuevo_promedio, 2)
        WHERE sku = p_sku;
    END IF;

    RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;
