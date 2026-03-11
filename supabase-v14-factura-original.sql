-- v14: Factura original snapshot + historial de ajustes de recepción
-- Permite comparar siempre la factura del proveedor vs lo que realmente se recibió

-- 1. Campo factura_original en recepciones (snapshot JSON inmutable)
ALTER TABLE recepciones ADD COLUMN IF NOT EXISTS factura_original jsonb;

-- 2. Tabla de historial de ajustes
CREATE TABLE IF NOT EXISTS recepcion_ajustes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recepcion_id uuid NOT NULL REFERENCES recepciones(id),
  tipo text NOT NULL,
  sku_original text,
  sku_nuevo text,
  campo text,
  valor_anterior text,
  valor_nuevo text,
  motivo text,
  admin text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ajustes_recepcion ON recepcion_ajustes(recepcion_id, created_at);

ALTER TABLE recepcion_ajustes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ajustes_all" ON recepcion_ajustes FOR ALL USING (true) WITH CHECK (true);
