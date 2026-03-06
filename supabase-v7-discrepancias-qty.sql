-- ==============================================
-- BANVA WMS v7 — Discrepancias de Cantidad en Recepciones
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v6-atomic-lock.sql
-- ==============================================

-- 1. Tabla discrepancias_costo (crear si no existe — puede haber sido creada manualmente)
CREATE TABLE IF NOT EXISTS discrepancias_costo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recepcion_id text NOT NULL,
  linea_id text NOT NULL,
  sku text NOT NULL,
  costo_diccionario numeric NOT NULL DEFAULT 0,
  costo_factura numeric NOT NULL DEFAULT 0,
  diferencia numeric NOT NULL DEFAULT 0,
  porcentaje numeric NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
  resuelto_por text,
  resuelto_at timestamptz,
  notas text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE discrepancias_costo ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "discrepancias_costo_all" ON discrepancias_costo FOR ALL USING (true) WITH CHECK (true);

-- 2. Tabla discrepancias_qty — resolución de diferencias de cantidad
CREATE TABLE IF NOT EXISTS discrepancias_qty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recepcion_id text NOT NULL,
  linea_id text,
  sku text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('FALTANTE','SOBRANTE','SKU_ERRONEO','NO_EN_FACTURA')),
  qty_factura integer NOT NULL DEFAULT 0,
  qty_recibida integer NOT NULL DEFAULT 0,
  diferencia integer NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ACEPTADO','RECLAMADO','NOTA_CREDITO','DEVOLUCION')),
  resuelto_por text,
  resuelto_at timestamptz,
  notas text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disc_qty_recepcion ON discrepancias_qty(recepcion_id);
CREATE INDEX IF NOT EXISTS idx_disc_qty_estado ON discrepancias_qty(estado);

ALTER TABLE discrepancias_qty ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discrepancias_qty_all" ON discrepancias_qty FOR ALL USING (true) WITH CHECK (true);
