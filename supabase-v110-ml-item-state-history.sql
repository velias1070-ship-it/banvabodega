-- v110: log de cambios de estado del item ML (status_ml, listing_type)
--
-- Hoy ml_margin_cache tiene status_ml + listing_type pero solo el snapshot
-- actual. Si un SKU pasa de active → paused o de Clásica → Premium, no
-- queda registrado el cambio.
--
-- Diseño: tabla append-only ml_item_state_history (item_id, campo, valor_anterior,
-- valor_nuevo, detected_at). Se llena desde el cron margin-cache/refresh
-- cuando detecta diff vs el snapshot anterior.

CREATE TABLE IF NOT EXISTS ml_item_state_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  sku text,
  sku_origen text,
  campo text NOT NULL CHECK (campo IN ('status_ml','listing_type','category_id','logistic_type')),
  valor_anterior text,
  valor_nuevo text NOT NULL,
  fuente text NOT NULL DEFAULT 'sync_diff',
  contexto jsonb,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ml_item_state_history_item_idx ON ml_item_state_history(item_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS ml_item_state_history_sku_idx ON ml_item_state_history(sku, detected_at DESC);
CREATE INDEX IF NOT EXISTS ml_item_state_history_campo_idx ON ml_item_state_history(campo, detected_at DESC);

COMMENT ON TABLE ml_item_state_history IS 'Append-only log de cambios de status_ml/listing_type/category_id/logistic_type por item. Para reconstruir cuándo un SKU se pausó, cambió de Clásica a Premium, etc.';
