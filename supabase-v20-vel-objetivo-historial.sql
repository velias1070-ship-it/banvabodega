-- v20: Persistencia de vel_objetivo — historial de cambios + snapshot diario
-- Ejecutar en Supabase SQL Editor

-- 1. Agregar vel_objetivo y gap_vel_pct a sku_intelligence_history
ALTER TABLE sku_intelligence_history ADD COLUMN IF NOT EXISTS vel_objetivo numeric DEFAULT 0;
ALTER TABLE sku_intelligence_history ADD COLUMN IF NOT EXISTS gap_vel_pct numeric DEFAULT NULL;

-- 2. Historial de cambios de vel_objetivo
CREATE TABLE IF NOT EXISTS vel_objetivo_historial (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sku_origen text NOT NULL,
  vel_objetivo_anterior numeric,
  vel_objetivo_nueva numeric,
  motivo text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vel_obj_hist ON vel_objetivo_historial(sku_origen, created_at DESC);

ALTER TABLE vel_objetivo_historial ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vel_obj_all" ON vel_objetivo_historial FOR ALL USING (true) WITH CHECK (true);

-- 3. Historial de cambios de configuración
CREATE TABLE IF NOT EXISTS config_historial (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  parametro text NOT NULL,
  valor_anterior text,
  valor_nuevo text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_hist_param ON config_historial(parametro, created_at DESC);

ALTER TABLE config_historial ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config_hist_all" ON config_historial FOR ALL USING (true) WITH CHECK (true);

-- 4. Log de acciones admin (para agente observador)
CREATE TABLE IF NOT EXISTS admin_actions_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  accion text NOT NULL,
  entidad text,
  entidad_id text,
  detalle jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_log_accion ON admin_actions_log(accion, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_log_entidad ON admin_actions_log(entidad, entidad_id, created_at DESC);

ALTER TABLE admin_actions_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_log_all" ON admin_actions_log FOR ALL USING (true) WITH CHECK (true);
