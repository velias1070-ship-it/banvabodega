-- ============================================
-- V12: orders_history + orders_imports
-- Persistencia de órdenes para Reposición y agentes IA
-- ============================================

-- Tabla principal: toda orden importada, para siempre
CREATE TABLE IF NOT EXISTS orders_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id text NOT NULL,
  order_number text,
  fecha timestamptz NOT NULL,
  sku_venta text NOT NULL,
  nombre_producto text,
  cantidad integer NOT NULL,
  canal text NOT NULL,
  precio_unitario integer NOT NULL,
  subtotal integer NOT NULL,
  comision_unitaria integer NOT NULL,
  comision_total integer NOT NULL,
  costo_envio integer NOT NULL,
  ingreso_envio integer DEFAULT 0,
  ingreso_adicional_tc integer DEFAULT 0,
  total integer NOT NULL,
  logistic_type text NOT NULL,
  estado text NOT NULL,
  fuente text NOT NULL DEFAULT 'manual',
  importado_at timestamptz DEFAULT now(),
  UNIQUE(order_id, sku_venta)
);

CREATE INDEX IF NOT EXISTS idx_orders_fecha ON orders_history(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders_history(sku_venta, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_orders_canal ON orders_history(canal, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_orders_estado ON orders_history(estado);
CREATE INDEX IF NOT EXISTS idx_orders_logistic ON orders_history(logistic_type, fecha DESC);

ALTER TABLE orders_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders_history_all" ON orders_history FOR ALL USING (true) WITH CHECK (true);

-- Registro de cada importación
CREATE TABLE IF NOT EXISTS orders_imports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fuente text NOT NULL,
  rango_desde timestamptz,
  rango_hasta timestamptz,
  ordenes_nuevas integer DEFAULT 0,
  ordenes_actualizadas integer DEFAULT 0,
  ordenes_sin_cambio integer DEFAULT 0,
  ordenes_total integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE orders_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "imports_all" ON orders_imports FOR ALL USING (true) WITH CHECK (true);
