-- ============================================================================
-- BANVA BODEGA — envio_full_pendiente
--
-- Tracks SKUs that should be auto-added to an envio_full picking session
-- when their reception is processed (ubicarLinea). Enables "queue for Full
-- when stock arrives" workflow.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS envio_full_pendiente (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sku TEXT NOT NULL,
    sku_venta TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    cantidad_agregada INTEGER NOT NULL DEFAULT 0,
    picking_session_id UUID,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(sku, picking_session_id)
);

ALTER TABLE envio_full_pendiente ENABLE ROW LEVEL SECURITY;
CREATE POLICY "envio_full_pendiente_all" ON envio_full_pendiente FOR ALL USING (true) WITH CHECK (true);
