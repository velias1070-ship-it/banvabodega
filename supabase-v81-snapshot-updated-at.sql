-- v81: updated_at en ml_snapshot_mensual + ml_resumen_mensual
--
-- Necesario para output-based validation del cron metrics-sync. El script de
-- validación anterior solo miraba phase_status.last_success (timestamp de log)
-- y dio falso positivo cuando el sync no re-corrió pero el script no detectó
-- la diferencia entre "corrió y escribió" vs "no corrió".
--
-- Patrón: trigger BEFORE UPDATE setea updated_at = NOW(). Default NOW() para INSERT.

ALTER TABLE ml_snapshot_mensual
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE ml_resumen_mensual
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION set_updated_at_now()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_mensual_updated_at ON ml_snapshot_mensual;
CREATE TRIGGER trg_snapshot_mensual_updated_at
BEFORE UPDATE ON ml_snapshot_mensual
FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();

DROP TRIGGER IF EXISTS trg_resumen_mensual_updated_at ON ml_resumen_mensual;
CREATE TRIGGER trg_resumen_mensual_updated_at
BEFORE UPDATE ON ml_resumen_mensual
FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();
