-- v26: Formalización de tablas ML shipment-centric
-- Mueve el DDL de ml_shipments y ml_shipment_items desde el endpoint
-- /api/ml/setup-tables a una migración formal.
-- También agrega columnas faltantes y documenta el esquema.

-- ============================================================
-- 1. TABLA: ml_shipments (un registro por envío físico de ML)
-- ============================================================
-- Fuente de verdad para pedidos MercadoLibre.
-- Reemplaza progresivamente a pedidos_flex (legacy).
-- Se llena desde: webhook (orders_v2, shipments), sync polling, sync histórico.

CREATE TABLE IF NOT EXISTS ml_shipments (
  shipment_id    BIGINT PRIMARY KEY,
  order_ids      BIGINT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'unknown',
  substatus      TEXT,
  logistic_type  TEXT NOT NULL DEFAULT 'unknown',
  is_flex        BOOLEAN NOT NULL DEFAULT FALSE,
  handling_limit TIMESTAMPTZ,
  buffering_date TIMESTAMPTZ,
  delivery_date  TIMESTAMPTZ,
  origin_type    TEXT,
  store_id       BIGINT,
  receiver_name  TEXT,
  destination_city TEXT,
  is_fraud_risk  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 2. TABLA: ml_shipment_items (items dentro de cada shipment)
-- ============================================================
-- Detalle de items por envío. seller_sku mapea a composicion_venta.

CREATE TABLE IF NOT EXISTS ml_shipment_items (
  id          SERIAL PRIMARY KEY,
  shipment_id BIGINT NOT NULL REFERENCES ml_shipments(shipment_id) ON DELETE CASCADE,
  order_id    BIGINT NOT NULL,
  item_id     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  seller_sku  TEXT NOT NULL DEFAULT '',
  variation_id BIGINT,
  quantity    INT NOT NULL DEFAULT 1,
  UNIQUE(shipment_id, order_id, item_id)
);

-- ============================================================
-- 3. ÍNDICES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_ml_shipments_handling ON ml_shipments(handling_limit);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_status ON ml_shipments(status);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_logistic ON ml_shipments(logistic_type);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_store ON ml_shipments(store_id);
CREATE INDEX IF NOT EXISTS idx_ml_shipments_updated ON ml_shipments(updated_at);
CREATE INDEX IF NOT EXISTS idx_ml_shipment_items_shipment ON ml_shipment_items(shipment_id);
CREATE INDEX IF NOT EXISTS idx_ml_shipment_items_sku ON ml_shipment_items(seller_sku);

-- ============================================================
-- 4. RLS (permisivo, igual que el resto del sistema)
-- ============================================================

ALTER TABLE ml_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_shipment_items ENABLE ROW LEVEL SECURITY;

-- Políticas idempotentes: DROP IF EXISTS + CREATE
DO $$
BEGIN
  -- ml_shipments
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ml_shipments' AND policyname = 'Allow all ml_shipments') THEN
    DROP POLICY "Allow all ml_shipments" ON ml_shipments;
  END IF;
  CREATE POLICY "Allow all ml_shipments" ON ml_shipments FOR ALL USING (true) WITH CHECK (true);

  -- ml_shipment_items
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ml_shipment_items' AND policyname = 'Allow all ml_shipment_items') THEN
    DROP POLICY "Allow all ml_shipment_items" ON ml_shipment_items;
  END IF;
  CREATE POLICY "Allow all ml_shipment_items" ON ml_shipment_items FOR ALL USING (true) WITH CHECK (true);
END $$;

-- ============================================================
-- 5. COMENTARIOS DE DOCUMENTACIÓN
-- ============================================================

COMMENT ON TABLE ml_shipments IS 'Envíos MercadoLibre (shipment-centric). Fuente de verdad para pedidos ML. Reemplaza a pedidos_flex.';
COMMENT ON COLUMN ml_shipments.order_ids IS 'Array de order_ids que componen este envío (packs = múltiples orders).';
COMMENT ON COLUMN ml_shipments.logistic_type IS 'Tipo logístico: self_service (Flex), fulfillment (Full), xd_drop_off, cross_docking, etc.';
COMMENT ON COLUMN ml_shipments.handling_limit IS 'Fecha/hora límite para despachar. Define prioridad de picking.';
COMMENT ON COLUMN ml_shipments.is_flex IS 'true si logistic_type indica envío Flex (self_service).';
COMMENT ON COLUMN ml_shipments.store_id IS 'ID de tienda ML (para filtrar por tienda en multi-store).';

COMMENT ON TABLE ml_shipment_items IS 'Items dentro de cada envío ML. seller_sku mapea a composicion_venta para resolver SKUs físicos.';
COMMENT ON COLUMN ml_shipment_items.seller_sku IS 'SKU del seller en ML. Coincide con composicion_venta.sku_venta o productos.sku.';

-- ============================================================
-- 6. NOTA: Tablas ML existentes (no se modifican en esta migración)
-- ============================================================
-- ml_config          → OAuth tokens, seller_id, horas corte (singleton id=main)
-- ml_items_map       → Mapeo SKU↔item ML + cache stock Flex/Full
-- stock_full_cache   → Cache de stock Full (fulfillment/Colina)
-- stock_sync_queue   → Cola de SKUs pendientes de sync a ML (actualmente desactivado)
-- pedidos_flex       → LEGACY: se mantiene por compatibilidad con picking operador
-- composicion_venta  → Mapeo SKU venta → SKUs físicos (packs/combos)
