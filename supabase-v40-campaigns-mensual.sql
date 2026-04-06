-- v40: Tabla para métricas de campañas de publicidad por mes
-- impression_share, lost_by_budget/rank solo están disponibles a nivel de campaña (no de ad)

CREATE TABLE IF NOT EXISTS ml_campaigns_mensual (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo text NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  campaign_status text,
  budget numeric DEFAULT 0,
  strategy text,
  acos_target numeric DEFAULT 0,
  roas_target numeric DEFAULT 0,
  -- métricas estándar
  clicks integer DEFAULT 0,
  prints integer DEFAULT 0,
  ctr numeric DEFAULT 0,
  cost numeric DEFAULT 0,
  cpc numeric DEFAULT 0,
  acos numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  cvr numeric DEFAULT 0,
  -- métricas de impression share (solo disponibles a nivel de campaña)
  sov numeric DEFAULT 0,
  impression_share numeric DEFAULT 0,
  top_impression_share numeric DEFAULT 0,
  lost_by_budget numeric DEFAULT 0,
  lost_by_rank numeric DEFAULT 0,
  acos_benchmark numeric DEFAULT 0,
  -- ingresos
  direct_amount numeric DEFAULT 0,
  indirect_amount numeric DEFAULT 0,
  total_amount numeric DEFAULT 0,
  direct_units integer DEFAULT 0,
  indirect_units integer DEFAULT 0,
  total_units integer DEFAULT 0,
  organic_units integer DEFAULT 0,
  organic_amount numeric DEFAULT 0,
  -- meta
  ads_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(periodo, campaign_id)
);

ALTER TABLE ml_campaigns_mensual ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ml_campaigns_mensual_all" ON ml_campaigns_mensual FOR ALL USING (true) WITH CHECK (true);
