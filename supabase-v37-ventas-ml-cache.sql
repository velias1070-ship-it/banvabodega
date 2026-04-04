-- v37: Cache de ventas ML para consulta instantánea
CREATE TABLE IF NOT EXISTS ventas_ml_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_number TEXT,
  fecha TEXT,
  fecha_date DATE,
  cliente TEXT,
  razon_social TEXT,
  sku_venta TEXT NOT NULL,
  nombre_producto TEXT,
  cantidad INTEGER DEFAULT 1,
  canal TEXT,
  precio_unitario NUMERIC DEFAULT 0,
  subtotal NUMERIC DEFAULT 0,
  comision_unitaria NUMERIC DEFAULT 0,
  comision_total NUMERIC DEFAULT 0,
  costo_envio NUMERIC DEFAULT 0,
  ingreso_envio NUMERIC DEFAULT 0,
  ingreso_adicional_tc NUMERIC DEFAULT 0,
  total NUMERIC DEFAULT 0,
  total_neto NUMERIC DEFAULT 0,
  logistic_type TEXT,
  estado TEXT,
  documento_tributario TEXT,
  estado_documento TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(order_id, sku_venta)
);

CREATE INDEX IF NOT EXISTS idx_ventas_ml_cache_fecha ON ventas_ml_cache(fecha_date);
CREATE INDEX IF NOT EXISTS idx_ventas_ml_cache_order ON ventas_ml_cache(order_id);

ALTER TABLE ventas_ml_cache ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ventas_ml_cache_all ON ventas_ml_cache FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
