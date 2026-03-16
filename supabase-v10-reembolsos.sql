-- ============================================================
-- MIGRACIÓN v10: Rastreo de reembolsos TC Personal → Empresa
-- Ejecutar en SQL Editor de Supabase
-- ============================================================

-- 1. Campos de reembolso en movimientos_banco
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS requiere_reembolso BOOLEAN DEFAULT false;
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS reembolso_estado TEXT;
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS reembolso_movimiento_id UUID REFERENCES movimientos_banco(id);

-- 2. Índice para búsqueda rápida de reembolsos pendientes
CREATE INDEX IF NOT EXISTS idx_mov_banco_reembolso
  ON movimientos_banco(empresa_id, requiere_reembolso)
  WHERE requiere_reembolso = true;

-- 3. Check constraint para estados de reembolso
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_reembolso_estado_check
  CHECK (reembolso_estado IS NULL OR reembolso_estado IN ('pendiente', 'conciliado', 'descartado'));
