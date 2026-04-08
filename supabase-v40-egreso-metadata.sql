-- v40: Metadata y archivo de respaldo en conciliaciones (Agregar Egreso)
ALTER TABLE conciliaciones ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE conciliaciones ADD COLUMN IF NOT EXISTS archivo_url text;
