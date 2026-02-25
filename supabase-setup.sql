-- ==============================================
-- BANVA WMS - Supabase Setup
-- ==============================================
-- Ejecutar en: Supabase → SQL Editor → New query
-- ==============================================

-- Tabla principal: guarda todo el estado del WMS como JSON
CREATE TABLE IF NOT EXISTS wms_state (
  id TEXT PRIMARY KEY DEFAULT 'banva_main',
  state JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permitir acceso público (anon) para lectura y escritura
-- (la app usa la anon key, no hay auth de usuarios)
ALTER TABLE wms_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON wms_state
  FOR SELECT USING (true);

CREATE POLICY "Allow public insert" ON wms_state
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update" ON wms_state
  FOR UPDATE USING (true);

-- Índice para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_wms_state_updated ON wms_state(updated_at);

-- Insertar fila inicial vacía (se sobreescribirá al primer save)
INSERT INTO wms_state (id, state) VALUES ('banva_main', '{}')
ON CONFLICT (id) DO NOTHING;
