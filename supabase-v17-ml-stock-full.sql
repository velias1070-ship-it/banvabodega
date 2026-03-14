-- BANVA WMS — v17: Integración ML API → stock_full_cache
-- ============================================
-- Extiende ml_items_map con campos de inventario fulfillment
-- Extiende stock_full_cache con detalle de stock no disponible
-- ============================================

-- 1. Extender ml_items_map con campos de inventario
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS inventory_id text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS sku_venta text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS titulo text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS available_quantity integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS sold_quantity integer DEFAULT 0;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_ml_items_inventory ON ml_items_map(inventory_id);
CREATE INDEX IF NOT EXISTS idx_ml_items_sku_venta ON ml_items_map(sku_venta);

-- 2. Extender stock_full_cache con detalle de stock no disponible
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_no_disponible integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_danado integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_perdido integer DEFAULT 0;
ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS stock_transferencia integer DEFAULT 0;
