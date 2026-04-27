-- v84: seed intelligence_recalcular en ml_sync_health (P1.3)
INSERT INTO ml_sync_health(job_name, staleness_threshold_hours, threshold_reason, alert_channel, alert_destination, last_attempt_at, last_success_at) VALUES
  ('intelligence_recalcular', 48, 'Cron diario 11:00 UTC. Threshold 48h = ~2 días sin recálculo. Si muere silencioso, motor de inteligencia opera con vel_ponderada/ABC/cuadrantes/pedir_proveedor del día anterior, contaminando todas las decisiones SKU-level. Threshold ×2 cadencia (24h) según regla.', 'whatsapp', '56991655931@s.whatsapp.net', NOW(), NOW())
ON CONFLICT (job_name) DO UPDATE SET
  staleness_threshold_hours = EXCLUDED.staleness_threshold_hours,
  threshold_reason = EXCLUDED.threshold_reason;
