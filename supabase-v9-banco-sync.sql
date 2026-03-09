-- ============================================================
-- MIGRACIÓN v9: Soporte para sync de fuentes bancarias
-- Ejecutar después de v8/v8b
-- ============================================================

-- 1. Expandir CHECK constraint de sync_log.tipo
-- para permitir nuevos tipos de sync (mercadopago, banco_chile, santander_tc)
ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_tipo_check;
ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check
  CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));

-- 2. Expandir CHECK constraint de movimientos_banco.origen
-- para incluir scrapers
ALTER TABLE movimientos_banco DROP CONSTRAINT IF EXISTS movimientos_banco_origen_check;
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_origen_check
  CHECK (origen IN ('csv', 'api', 'manual', 'scraper_bchile', 'scraper_santander'));

-- 3. Agregar columna metadata a movimientos_banco (para clasificación TC, etc.)
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 4. Índice para buscar movimientos por origen (útil para filtrar por fuente)
CREATE INDEX IF NOT EXISTS idx_mov_banco_origen ON movimientos_banco(origen);

-- 5. Constraint UNIQUE real para pasarelas_pago (reemplaza el parcial)
-- PostgREST necesita un constraint real, no un partial unique index
DROP INDEX IF EXISTS idx_pasarelas_ref_unique;
ALTER TABLE pasarelas_pago DROP CONSTRAINT IF EXISTS pasarelas_pago_ref_unique;
ALTER TABLE pasarelas_pago ADD CONSTRAINT pasarelas_pago_ref_unique
  UNIQUE (empresa_id, pasarela, referencia_externa);

-- 6. Constraint UNIQUE real para movimientos_banco.referencia_unica
-- PostgREST no soporta partial unique indexes con ON CONFLICT
DROP INDEX IF EXISTS idx_mov_banco_ref_unica;
ALTER TABLE movimientos_banco DROP CONSTRAINT IF EXISTS movimientos_banco_ref_unica;
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_ref_unica
  UNIQUE (empresa_id, banco, referencia_unica);
