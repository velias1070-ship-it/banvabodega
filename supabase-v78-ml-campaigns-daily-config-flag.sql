-- v78: agregar flag config_is_historical en ml_campaigns_daily_cache
--
-- Caveat del endpoint ML: en backfill, devuelve config actual (acos_target/budget/strategy/status)
-- propagado a todos los días pasados. No es config histórico real del día.
--
-- Este flag permite filtrar el dataset según necesidad:
--   - true  = "config del día es real" (sync diario en curso)
--   - false = "config snapshot del día del backfill, no representa el config real de ese día"
--
-- Default TRUE: los syncs diarios futuros entran como históricos correctos automáticamente.
-- El backfill marcó FALSE manualmente todos los rows previos a 2026-04-25.

ALTER TABLE ml_campaigns_daily_cache
  ADD COLUMN IF NOT EXISTS config_is_historical BOOLEAN NOT NULL DEFAULT TRUE;

-- Marcar todos los rows del backfill (anteriores al primer sync diario) como NO confiables en config
UPDATE ml_campaigns_daily_cache
SET config_is_historical = FALSE
WHERE date < '2026-04-25';
