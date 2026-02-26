-- ==================== PICKING SESSIONS ====================
-- Stores daily Flex picking sessions with order lines as JSONB

CREATE TABLE IF NOT EXISTS picking_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha date NOT NULL DEFAULT CURRENT_DATE,
  estado text NOT NULL DEFAULT 'ABIERTA',  -- ABIERTA, EN_PROCESO, COMPLETADA
  lineas jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Index for quick lookups by date
CREATE INDEX IF NOT EXISTS idx_picking_fecha ON picking_sessions(fecha DESC);

-- RLS
ALTER TABLE picking_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "picking_all" ON picking_sessions FOR ALL USING (true) WITH CHECK (true);

-- JSONB lineas structure:
-- [
--   {
--     "id": "P001",
--     "skuVenta": "TXV23QLAT25BE",
--     "qtyPedida": 1,
--     "estado": "PENDIENTE",  -- PENDIENTE, PICKEADO
--     "componentes": [
--       {
--         "skuOrigen": "QLAT-25-BE",
--         "codigoMl": "MLC123456",
--         "nombre": "Cubrecamas King Quilt...",
--         "unidades": 1,
--         "posicion": "3",
--         "estado": "PENDIENTE",  -- PENDIENTE, PICKEADO
--         "pickedAt": null,
--         "operario": null
--       }
--     ]
--   }
-- ]
