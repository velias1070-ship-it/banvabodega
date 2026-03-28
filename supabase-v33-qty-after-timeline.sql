-- ============================================================================
-- BANVA BODEGA — qty_after en movimientos + vista timeline
--
-- 1. qty_after: stock total del SKU después de cada movimiento
-- 2. v_timeline_sku: une movimientos + syncs ML en orden cronológico
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

-- 1. Columna qty_after
ALTER TABLE movimientos ADD COLUMN IF NOT EXISTS qty_after INTEGER;

-- 2. Actualizar registrar_movimiento_stock para calcular qty_after
CREATE OR REPLACE FUNCTION registrar_movimiento_stock(
    p_sku         TEXT,
    p_posicion    TEXT,
    p_delta       INTEGER,
    p_tipo        TEXT,
    p_sku_venta   TEXT DEFAULT NULL,
    p_motivo      TEXT DEFAULT NULL,
    p_operario    TEXT DEFAULT '',
    p_nota        TEXT DEFAULT '',
    p_recepcion_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_movimiento_id UUID;
    v_qty_after INTEGER;
BEGIN
    INSERT INTO movimientos (
        tipo, motivo, sku, posicion_id, cantidad,
        operario, nota, recepcion_id, created_at
    ) VALUES (
        p_tipo, p_motivo, p_sku, p_posicion, ABS(p_delta),
        p_operario, p_nota, p_recepcion_id, now()
    )
    RETURNING id INTO v_movimiento_id;

    PERFORM update_stock(p_sku, p_posicion, p_delta, p_sku_venta);

    SELECT COALESCE(SUM(cantidad), 0) INTO v_qty_after
    FROM stock WHERE sku = p_sku;

    UPDATE movimientos SET qty_after = v_qty_after WHERE id = v_movimiento_id;

    RETURN v_movimiento_id;
END;
$$ LANGUAGE plpgsql;

-- 3. Vista timeline
CREATE OR REPLACE VIEW v_timeline_sku AS
SELECT
    m.created_at AS ts,
    'movimiento' AS evento,
    m.sku,
    m.tipo || ': ' || COALESCE(m.motivo, '') AS detalle,
    CASE WHEN m.tipo = 'entrada' THEN m.cantidad ELSE -m.cantidad END AS delta,
    m.qty_after,
    m.posicion_id AS posicion,
    m.operario,
    m.nota,
    m.id::TEXT AS referencia_id
FROM movimientos m

UNION ALL

SELECT
    a.created_at AS ts,
    'sync_ml' AS evento,
    COALESCE(a.params->>'sku_origen', a.params->>'sku') AS sku,
    'PUT ' || (a.params->>'stockType') || ': ' || (a.params->>'quantity') || ' uds' AS detalle,
    ((a.params->>'quantity')::int - (a.params->>'currentInML')::int) AS delta,
    NULL AS qty_after,
    NULL AS posicion,
    'sync' AS operario,
    'ML actual: ' || (a.params->>'currentInML') || ' → ' || (a.params->>'quantity') AS nota,
    a.entidad_id AS referencia_id
FROM audit_log a
WHERE a.accion = 'stock_sync:put_ok'

ORDER BY ts DESC;
