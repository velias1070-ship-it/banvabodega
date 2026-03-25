-- ============================================================================
-- BANVA BODEGA — registrar_movimiento_stock()
--
-- Wrappea update_stock() existente + INSERT en movimientos
-- en UNA sola transacción. Si cualquiera falla, rollback completo.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE FUNCTION registrar_movimiento_stock(
    p_sku         TEXT,
    p_posicion    TEXT,
    p_delta       INTEGER,
    p_tipo        TEXT,           -- 'entrada', 'salida', 'transferencia', 'ajuste'
    p_sku_venta   TEXT DEFAULT NULL,
    p_motivo      TEXT DEFAULT NULL,
    p_operario    TEXT DEFAULT '',
    p_nota        TEXT DEFAULT '',
    p_recepcion_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_movimiento_id UUID;
BEGIN
    -- 1. INSERT en movimientos (audit trail / fuente de verdad)
    INSERT INTO movimientos (
        tipo, motivo, sku, posicion_id, cantidad,
        operario, nota, recepcion_id, created_at
    ) VALUES (
        p_tipo, p_motivo, p_sku, p_posicion, ABS(p_delta),
        p_operario, p_nota, p_recepcion_id, now()
    )
    RETURNING id INTO v_movimiento_id;

    -- 2. UPDATE stock (caché) — reutiliza tu función existente
    --    que ya maneja toda la lógica de sku_venta y distribución
    PERFORM update_stock(p_sku, p_posicion, p_delta, p_sku_venta);

    -- Si llegamos acá, ambos se commitean juntos
    -- Si cualquiera falla, PostgreSQL hace rollback de toda la tx
    RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;
