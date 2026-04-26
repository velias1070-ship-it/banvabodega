-- v82: threshold_reason en ml_sync_health + permitir thresholds fraccionales
--
-- Documentar la justificación de cada threshold para que en 6 meses nadie mire
-- "stock-sync threshold 30min, cron cada 1min" y piense que es bug.
--
-- También: staleness_threshold_hours pasa a NUMERIC(10,4) para permitir thresholds
-- subminuto si fuera necesario (aunque por ahora el más bajo es 30min = 0.5h).

ALTER TABLE ml_sync_health
  ALTER COLUMN staleness_threshold_hours TYPE NUMERIC(10,4) USING staleness_threshold_hours::NUMERIC(10,4);

ALTER TABLE ml_sync_health
  ADD COLUMN IF NOT EXISTS threshold_reason TEXT;

-- Backfill jobs existentes (creados en v75)
UPDATE ml_sync_health SET threshold_reason =
  'Cron 1×/día. Cierre del mes anterior corre en días 1-3. Threshold 35d cubre el ciclo natural; gap >35d indica que el cron de cierre mensual no se ejecutó.'
WHERE job_name = 'metrics_monthly' AND threshold_reason IS NULL;

UPDATE ml_sync_health SET threshold_reason =
  'Cron cada 6h. Threshold 12h = 2 corridas perdidas seguidas. Stock de ads se desincroniza a partir de ahí.'
WHERE job_name = 'ads_daily' AND threshold_reason IS NULL;

UPDATE ml_sync_health SET threshold_reason =
  'Cron diario 06:00 UTC. Threshold 36h = ~1.5 días sin corrida exitosa. Evita falso positivo si el cron de hoy se atrasó <12h.'
WHERE job_name = 'campaigns_daily' AND threshold_reason IS NULL;

-- Seed nuevo job: stock_sync (P1.1 — máxima criticidad operativa)
INSERT INTO ml_sync_health(job_name, staleness_threshold_hours, threshold_reason, alert_channel, alert_destination) VALUES
  ('stock_sync', 0.5, 'Cron 1min. Deploys + lentitud API generan gaps ~5min normales. Solo alertar si es problema operativo real (>30min sin éxito = stock ML desincronizado, picking bloqueado).', 'whatsapp', '56991655931@s.whatsapp.net')
ON CONFLICT (job_name) DO UPDATE SET
  staleness_threshold_hours = EXCLUDED.staleness_threshold_hours,
  threshold_reason = EXCLUDED.threshold_reason;
