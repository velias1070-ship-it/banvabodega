-- v83: seed ml_sync en ml_sync_health (P1.2)
INSERT INTO ml_sync_health(job_name, staleness_threshold_hours, threshold_reason, alert_channel, alert_destination, last_attempt_at, last_success_at) VALUES
  ('ml_sync', 0.5, 'Cron 1min. Órdenes con delay <30min siguen siendo procesables sin impacto. Threshold ×2 sería 2min, generaría ruido por deploys + lentitud transitoria del API ML.', 'whatsapp', '56991655931@s.whatsapp.net', NOW(), NOW())
ON CONFLICT (job_name) DO UPDATE SET
  staleness_threshold_hours = EXCLUDED.staleness_threshold_hours,
  threshold_reason = EXCLUDED.threshold_reason;
