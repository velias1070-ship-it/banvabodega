-- v99: per-SKU PUT error tracking on ml_items_map
-- Antes de v99 los errores del PUT a ML quedaban solo en audit_log y nadie se enteraba.
-- TXTLVAL4G6PBG fue el caso testigo (2026-04-09): ML rechazó con 400 "store not configured",
-- el route igual sobreescribía stock_flex_cache → cache mintiendo durante 4 semanas.

ALTER TABLE ml_items_map
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_sync_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notificado_sync_error_at TIMESTAMPTZ;

COMMENT ON COLUMN ml_items_map.last_sync_error IS
  'Mensaje del último error de PUT distributed-stock. NULL si último intento fue OK.';
COMMENT ON COLUMN ml_items_map.last_sync_error_at IS
  'Timestamp del último error. NULL si último intento fue OK.';
COMMENT ON COLUMN ml_items_map.consecutive_sync_failures IS
  'Contador de fallas consecutivas. Se resetea a 0 cuando un PUT vuelve a salir OK.';
COMMENT ON COLUMN ml_items_map.notificado_sync_error_at IS
  'Cuándo se mandó la última alerta WhatsApp por este SKU. Anti-spam: solo notifica si hay rato sin avisar.';

CREATE INDEX IF NOT EXISTS idx_ml_items_map_sync_failures
  ON ml_items_map(consecutive_sync_failures DESC)
  WHERE consecutive_sync_failures > 0;
