-- ============================================================================
-- BANVA BODEGA — calcular_qty_ubicada()
--
-- Calcula qty_ubicada desde movimientos (fuente de verdad) en vez de
-- acumular manualmente. Previene divergencia entre movimientos y líneas.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE OR REPLACE FUNCTION calcular_qty_ubicada(p_recepcion_id UUID, p_sku TEXT)
RETURNS INTEGER AS $$
    SELECT COALESCE(SUM(cantidad), 0)::INTEGER
    FROM movimientos
    WHERE recepcion_id = p_recepcion_id
      AND sku = p_sku
      AND tipo = 'entrada'
      AND motivo = 'recepcion';
$$ LANGUAGE SQL STABLE;
