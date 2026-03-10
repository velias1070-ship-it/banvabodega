-- v12: Cache de órdenes ProfitGuard
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS profitguard_cache (
  id text PRIMARY KEY DEFAULT 'orders',
  datos jsonb NOT NULL DEFAULT '[]'::jsonb,
  rango_desde text,
  rango_hasta text,
  cantidad_ordenes integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- RLS permisivo (consistente con el resto del proyecto)
ALTER TABLE profitguard_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profitguard_cache_select" ON profitguard_cache FOR SELECT USING (true);
CREATE POLICY "profitguard_cache_insert" ON profitguard_cache FOR INSERT WITH CHECK (true);
CREATE POLICY "profitguard_cache_update" ON profitguard_cache FOR UPDATE USING (true);
CREATE POLICY "profitguard_cache_delete" ON profitguard_cache FOR DELETE USING (true);
