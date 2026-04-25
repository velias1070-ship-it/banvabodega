-- v77: ml_campaigns_monthly_summary (VIEW)
-- Reemplaza ml_campaigns_mensual (huérfana, nadie la lee). Calcula desde daily.
-- ACOS y ROAS desde totales (no AVG diario). Ratios ponderados por prints.

CREATE OR REPLACE VIEW ml_campaigns_monthly_summary AS
SELECT
  campaign_id,
  TO_CHAR(date, 'YYYY-MM') AS periodo,
  -- Tráfico
  SUM(prints) AS prints,
  SUM(clicks) AS clicks,
  -- Financieras
  SUM(cost) AS cost,
  SUM(total_amount) AS total_amount,
  SUM(direct_amount) AS direct_amount,
  SUM(indirect_amount) AS indirect_amount,
  SUM(organic_amount) AS organic_amount,
  -- Unidades / items
  SUM(direct_units) AS direct_units,
  SUM(indirect_units) AS indirect_units,
  SUM(organic_units) AS organic_units,
  SUM(direct_items) AS direct_items,
  SUM(indirect_items) AS indirect_items,
  SUM(organic_items) AS organic_items,
  -- ACOS y ROAS calculados desde totales (no AVG diario)
  CASE WHEN SUM(total_amount) > 0
       THEN SUM(cost)::NUMERIC / SUM(total_amount) * 100
       ELSE NULL END AS acos_real,
  CASE WHEN SUM(cost) > 0
       THEN SUM(total_amount)::NUMERIC / SUM(cost)
       ELSE NULL END AS roas_real,
  -- Ratios ponderados por prints (no AVG simple)
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * impression_share)::NUMERIC / SUM(prints)
       ELSE NULL END AS impression_share_avg,
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * lost_by_budget)::NUMERIC / SUM(prints)
       ELSE NULL END AS lost_by_budget_avg,
  CASE WHEN SUM(prints) > 0
       THEN SUM(prints * lost_by_rank)::NUMERIC / SUM(prints)
       ELSE NULL END AS lost_by_rank_avg,
  -- Config al final del período (último día con dato)
  (array_agg(strategy ORDER BY date DESC))[1] AS strategy_final,
  (array_agg(status   ORDER BY date DESC))[1] AS status_final,
  (array_agg(budget   ORDER BY date DESC))[1] AS budget_final,
  (array_agg(acos_target ORDER BY date DESC))[1] AS acos_target_final,
  MAX(synced_at) AS last_synced_at
FROM ml_campaigns_daily_cache
GROUP BY campaign_id, TO_CHAR(date, 'YYYY-MM');
