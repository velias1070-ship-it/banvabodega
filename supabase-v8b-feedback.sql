-- ============================================================
-- BANVA Conciliador v8b — Feedback agentes + Cuentas bancarias
-- ============================================================
-- Ejecutar en Supabase SQL Editor DESPUÉS de v8

-- ==================== TABLA FEEDBACK AGENTES ====================

CREATE TABLE IF NOT EXISTS feedback_agentes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  agente TEXT NOT NULL,
  accion_sugerida JSONB,
  accion_correcta JSONB,
  contexto JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_agente ON feedback_agentes(agente, created_at DESC);

-- RLS permisivo
ALTER TABLE feedback_agentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_select_feedback_agentes" ON feedback_agentes FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_insert_feedback_agentes" ON feedback_agentes FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_update_feedback_agentes" ON feedback_agentes FOR UPDATE USING (true);
DROP POLICY IF EXISTS "allow_delete_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_delete_feedback_agentes" ON feedback_agentes FOR DELETE USING (true);

-- ==================== ACTUALIZAR CUENTAS BANCARIAS ====================

-- La empresa BANVA usa Banco de Chile, no Santander
UPDATE cuentas_bancarias SET banco = 'Banco de Chile', alias = 'BANVA CC Empresa'
WHERE alias = 'Santander BANVA';

-- Agregar TC personal de Vicente
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, numero_cuenta, alias, moneda)
SELECT id, 'Santander', 'tc_credito', '****', 'Vicente TC Personal', 'CLP'
FROM empresas WHERE rut = '77994007-1'
ON CONFLICT DO NOTHING;

-- Agregar MercadoPago
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, numero_cuenta, alias, moneda)
SELECT id, 'MercadoPago', 'digital', '1953806321', 'BANVA MercadoPago', 'CLP'
FROM empresas WHERE rut = '77994007-1'
ON CONFLICT DO NOTHING;

-- ============================================================
-- FIN v8b — Ejecutar en Supabase SQL Editor
-- ============================================================
