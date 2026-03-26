-- ============================================================================
-- BANVA BODEGA — audit_log table
--
-- Registro persistente de acciones para debugging.
-- Reemplaza la dependencia de logs de Vercel que rotan rápido.
--
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    accion TEXT NOT NULL,
    entidad TEXT,
    entidad_id TEXT,
    params JSONB,
    resultado JSONB,
    operario TEXT DEFAULT '',
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entidad ON audit_log (entidad, entidad_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_accion ON audit_log (accion);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_all" ON audit_log FOR ALL USING (true) WITH CHECK (true);
