-- v40: Snapshot de atributos de items ML para detectar cambios externos
CREATE TABLE IF NOT EXISTS ml_item_attr_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  attr_id text NOT NULL,
  attr_value text,
  snapshot_at timestamptz DEFAULT now(),
  UNIQUE(item_id, attr_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_item_attr_snapshot_item ON ml_item_attr_snapshot(item_id);

-- Log de cambios detectados
CREATE TABLE IF NOT EXISTS ml_item_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  titulo text,
  attr_id text NOT NULL,
  valor_anterior text,
  valor_nuevo text,
  detected_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ml_item_changes_detected ON ml_item_changes(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_item_changes_item ON ml_item_changes(item_id);

-- RLS
ALTER TABLE ml_item_attr_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_item_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_snapshot" ON ml_item_attr_snapshot FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all_changes" ON ml_item_changes FOR ALL USING (true) WITH CHECK (true);
