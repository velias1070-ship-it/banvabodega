-- v23: Notas operativas + Picking bultos
-- Ejecutar en Supabase SQL Editor

-- =============================================
-- 1. Notas operativas en composicion_venta
-- =============================================
ALTER TABLE composicion_venta ADD COLUMN IF NOT EXISTS nota_operativa text;

-- =============================================
-- 2. Tablas de bultos para picking envio_full
-- =============================================
CREATE TABLE IF NOT EXISTS picking_bultos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  picking_session_id uuid NOT NULL REFERENCES picking_sessions(id),
  numero_bulto integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS picking_bultos_lineas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bulto_id uuid NOT NULL REFERENCES picking_bultos(id) ON DELETE CASCADE,
  sku_venta text NOT NULL,
  sku_origen text,
  cantidad integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bultos_session ON picking_bultos(picking_session_id);
CREATE INDEX IF NOT EXISTS idx_bultos_lineas ON picking_bultos_lineas(bulto_id);

ALTER TABLE picking_bultos ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bultos_all' AND tablename = 'picking_bultos') THEN
    CREATE POLICY "bultos_all" ON picking_bultos FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE picking_bultos_lineas ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'bultos_lineas_all' AND tablename = 'picking_bultos_lineas') THEN
    CREATE POLICY "bultos_lineas_all" ON picking_bultos_lineas FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
