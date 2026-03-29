-- supabase-v32-fixes-operador.sql
-- FIX 2: Idempotencia en movimientos de stock
-- Ejecutar en: Supabase → SQL Editor → New query

-- =============================================================
-- 1. Agregar idempotency_key a movimientos
-- =============================================================
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_idempotency
  ON movimientos (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- =============================================================
-- 2. registrar_movimiento_stock() con soporte idempotencia
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
    p_costo_unitario NUMERIC DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_movimiento_id UUID;
    v_stock_total   INTEGER;
    v_costo_actual  NUMERIC;
    v_nuevo_promedio NUMERIC;
BEGIN
    -- Idempotency check: si ya existe un movimiento con esta key, retornar su id
    IF p_idempotency_key IS NOT NULL THEN
      SELECT id INTO v_movimiento_id FROM movimientos WHERE idempotency_key = p_idempotency_key;
      IF FOUND THEN
        RETURN v_movimiento_id;
      END IF;
    END IF;

    -- 1. INSERT en movimientos (audit trail / fuente de verdad)
    INSERT INTO movimientos (
        tipo, motivo, sku, posicion_id, cantidad,
        operario, nota, recepcion_id, costo_unitario, idempotency_key, created_at
    ) VALUES (
        p_tipo, p_motivo, p_sku, p_posicion, ABS(p_delta),
        p_operario, p_nota, p_recepcion_id, p_costo_unitario, p_idempotency_key, now()
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

-- =============================================================
-- 3. liberar_reserva() con soporte idempotencia
-- =============================================================
CREATE OR REPLACE FUNCTION liberar_reserva(
    p_sku           TEXT,
    p_cantidad      INTEGER,
    p_descontar     BOOLEAN DEFAULT FALSE,  -- true = despacho, false = cancelación
    p_motivo        TEXT DEFAULT NULL,
    p_operario      TEXT DEFAULT '',
    p_idempotency_key_prefix TEXT DEFAULT NULL
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
                INSERT INTO movimientos (tipo, motivo, sku, posicion_id, cantidad, operario, idempotency_key, created_at)
                VALUES ('salida', COALESCE(p_motivo, 'despacho'), p_sku, v_row.posicion_id, v_restante, p_operario, CASE WHEN p_idempotency_key_prefix IS NOT NULL THEN p_idempotency_key_prefix || '-' || v_row.posicion_id ELSE NULL END, now());
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

                INSERT INTO movimientos (tipo, motivo, sku, posicion_id, cantidad, operario, idempotency_key, created_at)
                VALUES ('salida', COALESCE(p_motivo, 'despacho'), p_sku, v_row.posicion_id, v_row.qty_reserved, p_operario, CASE WHEN p_idempotency_key_prefix IS NOT NULL THEN p_idempotency_key_prefix || '-' || v_row.posicion_id ELSE NULL END, now());
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
