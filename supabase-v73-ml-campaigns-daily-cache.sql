-- v73: ml_campaigns_daily_cache
-- Fuente de verdad daily de métricas de campañas Product Ads.
-- Reemplaza la lógica mensual de ml_campaigns_mensual (que se llenaba 1× al mes con cron condicional).
-- Origen: docs/auditorias/banva-bodega-pr-ads-pipeline-preauditoria.md

CREATE TABLE IF NOT EXISTS ml_campaigns_daily_cache (
  campaign_id BIGINT NOT NULL,
  date DATE NOT NULL,
  -- Tráfico
  prints INTEGER,
  clicks INTEGER,
  -- Eficiencia
  cpc NUMERIC(10,2),
  ctr NUMERIC(8,4),
  cvr NUMERIC(8,4),
  -- Subasta (NULL hoy — ML rechaza estos campos por tier de cuenta, ver §1.1 de la preauditoría)
  sov NUMERIC(8,4),
  impression_share NUMERIC(8,4),
  top_impression_share NUMERIC(8,4),
  lost_by_budget NUMERIC(8,4),
  lost_by_rank NUMERIC(8,4),
  -- Financieras
  cost NUMERIC(12,2),
  direct_amount NUMERIC(12,2),
  indirect_amount NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  acos_real NUMERIC(8,4),
  acos_benchmark NUMERIC(8,4), -- NULL hoy (tier)
  roas_real NUMERIC(8,4),
  -- Unidades (units = packs vendidos, items = SKUs distintos)
  direct_units INTEGER,
  indirect_units INTEGER,
  organic_units INTEGER,
  direct_items INTEGER,
  indirect_items INTEGER,
  organic_items INTEGER,
  organic_amount NUMERIC(12,2),
  -- Config snapshot del día
  acos_target NUMERIC(8,4),
  budget NUMERIC(12,2),
  strategy TEXT,
  status TEXT,
  -- Meta
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, date)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_daily_date ON ml_campaigns_daily_cache(date DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_daily_status ON ml_campaigns_daily_cache(status, date DESC);

ALTER TABLE ml_campaigns_daily_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_campaigns_daily_cache;
CREATE POLICY "permissive" ON ml_campaigns_daily_cache USING (true) WITH CHECK (true);
