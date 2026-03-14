-- v18: Normalizar todos los SKU a UPPER en tablas existentes
-- Ejecutar manualmente en Supabase SQL Editor

-- orders_history
UPDATE orders_history SET sku_venta = UPPER(sku_venta) WHERE sku_venta != UPPER(sku_venta);

-- stock_full_cache
UPDATE stock_full_cache SET sku_venta = UPPER(sku_venta) WHERE sku_venta != UPPER(sku_venta);

-- composicion_venta
UPDATE composicion_venta SET sku_venta = UPPER(sku_venta) WHERE sku_venta != UPPER(sku_venta);
UPDATE composicion_venta SET sku_origen = UPPER(sku_origen) WHERE sku_origen != UPPER(sku_origen);

-- productos
UPDATE productos SET sku = UPPER(sku) WHERE sku != UPPER(sku);
UPDATE productos SET sku_venta = UPPER(sku_venta) WHERE sku_venta IS NOT NULL AND sku_venta != UPPER(sku_venta);

-- stock
UPDATE stock SET sku = UPPER(sku) WHERE sku != UPPER(sku);
UPDATE stock SET sku_venta = UPPER(sku_venta) WHERE sku_venta IS NOT NULL AND sku_venta != UPPER(sku_venta);

-- movimientos
UPDATE movimientos SET sku = UPPER(sku) WHERE sku != UPPER(sku);

-- pedidos_flex
UPDATE pedidos_flex SET sku_venta = UPPER(sku_venta) WHERE sku_venta != UPPER(sku_venta);

-- ml_items_map
UPDATE ml_items_map SET sku = UPPER(sku) WHERE sku != UPPER(sku);

-- stock_sync_queue
UPDATE stock_sync_queue SET sku = UPPER(sku) WHERE sku != UPPER(sku);

-- sku_intelligence
UPDATE sku_intelligence SET sku_origen = UPPER(sku_origen) WHERE sku_origen != UPPER(sku_origen);

-- stock_snapshots
UPDATE stock_snapshots SET sku_origen = UPPER(sku_origen) WHERE sku_origen != UPPER(sku_origen);

-- recepcion_lineas
UPDATE recepcion_lineas SET sku = UPPER(sku) WHERE sku IS NOT NULL AND sku != UPPER(sku);
