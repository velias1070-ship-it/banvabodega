-- v75: ml_sync_health
-- Health monitoring de jobs recurrentes. Reemplaza la lección de los 19 días
-- silenciosos de ml_campaigns_mensual: el sistema bien construido se queja solo cuando no funciona.

CREATE TABLE IF NOT EXISTS ml_sync_health (
  job_name TEXT PRIMARY KEY,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  staleness_threshold_hours INTEGER NOT NULL,
  alert_channel TEXT NOT NULL DEFAULT 'whatsapp',
  alert_destination TEXT,
  is_alerting BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_sent_at TIMESTAMPTZ
);

-- Thresholds calibrados a la frecuencia natural del job:
--   campaigns_daily: cron diario → alerta si 36h sin éxito
--   ads_daily:       cron 6h     → alerta si 12h sin éxito
--   metrics_monthly: cron 1× mes → alerta si 35d (840h) sin éxito
INSERT INTO ml_sync_health(job_name, staleness_threshold_hours, alert_channel, alert_destination) VALUES
  ('campaigns_daily',  36,  'whatsapp', '56991655931@s.whatsapp.net'),
  ('ads_daily',        12,  'whatsapp', '56991655931@s.whatsapp.net'),
  ('metrics_monthly',  840, 'whatsapp', '56991655931@s.whatsapp.net')
ON CONFLICT (job_name) DO NOTHING;

ALTER TABLE ml_sync_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_sync_health;
CREATE POLICY "permissive" ON ml_sync_health USING (true) WITH CHECK (true);
