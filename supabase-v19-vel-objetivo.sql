-- v19: Velocidad objetivo por SKU + gap + config targets ABC
-- Ejecutar en Supabase SQL Editor

-- 1. Columnas nuevas en sku_intelligence
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS vel_objetivo numeric DEFAULT 0;
ALTER TABLE sku_intelligence ADD COLUMN IF NOT EXISTS gap_vel_pct numeric DEFAULT NULL;

-- 2. Tabla de configuración de targets por ABC
CREATE TABLE IF NOT EXISTS intel_config (
  id text PRIMARY KEY DEFAULT 'main',
  target_dias_a integer NOT NULL DEFAULT 42,
  target_dias_b integer NOT NULL DEFAULT 28,
  target_dias_c integer NOT NULL DEFAULT 14,
  updated_at timestamptz DEFAULT now()
);

-- RLS permisivo
ALTER TABLE intel_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "intel_config_all" ON intel_config;
CREATE POLICY "intel_config_all" ON intel_config FOR ALL USING (true) WITH CHECK (true);

-- Insertar config default si no existe
INSERT INTO intel_config (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;
