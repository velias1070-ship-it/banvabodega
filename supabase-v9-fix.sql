-- ============================================================
-- FIX v9: Arreglar constraints que no se aplicaron
-- Copiar y pegar TODO este bloque en el SQL Editor de Supabase
-- ============================================================

-- 1. Listar todos los constraints de sync_log para debug
-- (puedes ver el resultado antes de ejecutar los ALTER)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sync_log'::regclass;

-- 2. Eliminar TODOS los check constraints de sync_log.tipo
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'sync_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%tipo%'
  LOOP
    EXECUTE 'ALTER TABLE sync_log DROP CONSTRAINT ' || r.conname;
    RAISE NOTICE 'Dropped: %', r.conname;
  END LOOP;
END $$;

-- 3. Crear nuevo constraint expandido
ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check
  CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));

-- 4. Eliminar check constraints de movimientos_banco.origen
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'movimientos_banco'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%origen%'
  LOOP
    EXECUTE 'ALTER TABLE movimientos_banco DROP CONSTRAINT ' || r.conname;
    RAISE NOTICE 'Dropped: %', r.conname;
  END LOOP;
END $$;

-- 5. Crear nuevo constraint expandido para origen
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_origen_check
  CHECK (origen IN ('csv', 'api', 'manual', 'scraper_bchile', 'scraper_santander'));

-- 6. Agregar columna metadata si no existe
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 7. Índice por origen
CREATE INDEX IF NOT EXISTS idx_mov_banco_origen ON movimientos_banco(origen);

-- 8. Verificar
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('sync_log'::regclass, 'movimientos_banco'::regclass)
AND contype = 'c';
