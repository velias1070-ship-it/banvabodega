-- v92: registrar pricing_baseline_cron en ml_sync_health
--
-- Contexto: cron /api/pricing/recalcular-floors corre 11:30 UTC diario y
-- alimenta auto_postulacion_log con decision='baseline_warming' (snapshot
-- diario de precio efectivo por SKU). Gap detectado 2026-04-27: el cron no
-- corrió o falló silencioso, dejando 2 SKUs registrados ese día (vs ~342
-- esperados). Sin telemetría a ml_sync_health no detectamos hasta que un
-- analisis posterior preguntó "¿cuánto valía ayer?".
--
-- Threshold 36h: cron diario, tolerancia para 1 falla aislada.
-- Alert destination: mismo WhatsApp de los demás crons críticos.

INSERT INTO ml_sync_health (
  job_name, staleness_threshold_hours, alert_channel, alert_destination,
  threshold_reason
)
VALUES (
  'pricing_baseline_cron', 36, 'whatsapp', '56991655931@s.whatsapp.net',
  'Cron diario 11:30 UTC. Cobertura esperada ~342 SKUs/dia. Gap >36h o cobertura <250 = alerta.'
)
ON CONFLICT (job_name) DO UPDATE SET
  staleness_threshold_hours = EXCLUDED.staleness_threshold_hours,
  threshold_reason = EXCLUDED.threshold_reason;
