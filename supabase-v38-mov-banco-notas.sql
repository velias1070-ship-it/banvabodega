-- v38: Agregar columna notas a movimientos_banco
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS notas text;
