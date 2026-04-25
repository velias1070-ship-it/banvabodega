-- v74: ml_campaigns_config_history
-- Registra cambios de config (acos_target/budget/strategy/status) detectados por trigger SQL.
-- Permite cruzar "el día X cambié esto, los siguientes 7 días pasó esto otro".

CREATE TABLE IF NOT EXISTS ml_campaigns_config_history (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field TEXT NOT NULL,        -- 'acos_target' | 'budget' | 'strategy' | 'status' | 'initial.*'
  old_value TEXT,
  new_value TEXT,
  source TEXT NOT NULL DEFAULT 'sync'  -- 'sync' | 'manual' | 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_config_history_campaign
  ON ml_campaigns_config_history(campaign_id, changed_at DESC);

-- Trigger: detecta INSERT inicial (baseline) + cambios reales en UPDATE.
-- INSERT solo registra baseline si la campaña nunca fue vista antes (evita duplicar al reinsertar).
-- UPDATE usa IS DISTINCT FROM para no registrar cuando el valor no cambió.
CREATE OR REPLACE FUNCTION track_campaign_config_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM ml_campaigns_config_history
      WHERE campaign_id = NEW.campaign_id LIMIT 1
    ) THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES
        (NEW.campaign_id, 'initial.acos_target', NULL, NEW.acos_target::TEXT, 'sync'),
        (NEW.campaign_id, 'initial.budget',      NULL, NEW.budget::TEXT,      'sync'),
        (NEW.campaign_id, 'initial.strategy',    NULL, NEW.strategy,          'sync'),
        (NEW.campaign_id, 'initial.status',      NULL, NEW.status,            'sync');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.acos_target IS DISTINCT FROM OLD.acos_target THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'acos_target', OLD.acos_target::TEXT, NEW.acos_target::TEXT, 'sync');
    END IF;
    IF NEW.budget IS DISTINCT FROM OLD.budget THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'budget', OLD.budget::TEXT, NEW.budget::TEXT, 'sync');
    END IF;
    IF NEW.strategy IS DISTINCT FROM OLD.strategy THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'strategy', OLD.strategy, NEW.strategy, 'sync');
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO ml_campaigns_config_history(campaign_id, field, old_value, new_value, source)
      VALUES (NEW.campaign_id, 'status', OLD.status, NEW.status, 'sync');
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_campaign_config_changes ON ml_campaigns_daily_cache;
CREATE TRIGGER trg_campaign_config_changes
AFTER INSERT OR UPDATE ON ml_campaigns_daily_cache
FOR EACH ROW EXECUTE FUNCTION track_campaign_config_changes();

ALTER TABLE ml_campaigns_config_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissive" ON ml_campaigns_config_history;
CREATE POLICY "permissive" ON ml_campaigns_config_history USING (true) WITH CHECK (true);
