-- ==============================================
-- BANVA WMS v3 — Conteos Cíclicos + MercadoLibre Integration
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v2-setup.sql
-- ==============================================

-- 1. Agregar columnas faltantes a productos (si no existen)
ALTER TABLE productos ADD COLUMN IF NOT EXISTS tamano text DEFAULT '';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS color text DEFAULT '';

-- 2. COMPOSICION VENTA (packs/combos de venta)
CREATE TABLE IF NOT EXISTS composicion_venta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_venta text NOT NULL,
  codigo_ml text DEFAULT '',
  sku_origen text NOT NULL,
  unidades integer NOT NULL DEFAULT 1,
  UNIQUE(sku_venta, sku_origen)
);

CREATE INDEX IF NOT EXISTS idx_composicion_sku_venta ON composicion_venta(sku_venta);
CREATE INDEX IF NOT EXISTS idx_composicion_sku_origen ON composicion_venta(sku_origen);

-- 3. PICKING SESSIONS (sesiones de picking Flex)
CREATE TABLE IF NOT EXISTS picking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha text NOT NULL,
  estado text DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA', 'EN_PROCESO', 'COMPLETADA', 'CANCELADA')),
  lineas jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_picking_fecha ON picking_sessions(fecha);
CREATE INDEX IF NOT EXISTS idx_picking_estado ON picking_sessions(estado);

-- 4. CONTEOS CÍCLICOS
CREATE TABLE IF NOT EXISTS conteos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('por_posicion', 'por_sku')),
  estado text DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA', 'EN_PROCESO', 'REVISION', 'CERRADA')),
  lineas jsonb DEFAULT '[]'::jsonb,
  posiciones text[] DEFAULT '{}',
  posiciones_contadas text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  created_by text DEFAULT 'admin',
  closed_at timestamptz,
  closed_by text
);

CREATE INDEX IF NOT EXISTS idx_conteos_estado ON conteos(estado);
CREATE INDEX IF NOT EXISTS idx_conteos_fecha ON conteos(fecha);

-- 5. ML CONFIG (MercadoLibre OAuth & settings)
CREATE TABLE IF NOT EXISTS ml_config (
  id text PRIMARY KEY DEFAULT 'main',
  seller_id text DEFAULT '',
  client_id text DEFAULT '',
  client_secret text DEFAULT '',
  access_token text DEFAULT '',
  refresh_token text DEFAULT '',
  token_expires_at timestamptz DEFAULT now(),
  webhook_secret text,
  hora_corte_lv integer DEFAULT 14,
  hora_corte_sab integer DEFAULT 11,
  updated_at timestamptz DEFAULT now()
);

-- Insert default config row
INSERT INTO ml_config (id) VALUES ('main') ON CONFLICT (id) DO NOTHING;

-- 6. PEDIDOS FLEX (órdenes de MercadoLibre Flex)
CREATE TABLE IF NOT EXISTS pedidos_flex (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id bigint NOT NULL,
  fecha_venta timestamptz NOT NULL,
  fecha_armado text NOT NULL,
  estado text DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'EN_PICKING', 'DESPACHADO')),
  sku_venta text NOT NULL,
  nombre_producto text NOT NULL,
  cantidad integer NOT NULL DEFAULT 1,
  shipping_id bigint NOT NULL,
  pack_id bigint,
  buyer_nickname text DEFAULT '',
  raw_data jsonb,
  picking_session_id uuid REFERENCES picking_sessions(id),
  etiqueta_url text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(order_id, sku_venta)
);

CREATE INDEX IF NOT EXISTS idx_pedidos_flex_fecha ON pedidos_flex(fecha_armado);
CREATE INDEX IF NOT EXISTS idx_pedidos_flex_estado ON pedidos_flex(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_flex_order ON pedidos_flex(order_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_flex_picking ON pedidos_flex(picking_session_id);

-- 7. ML ITEMS MAP (mapeo SKU → item ML para stock sync)
CREATE TABLE IF NOT EXISTS ml_items_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  item_id text NOT NULL,
  variation_id bigint,
  activo boolean DEFAULT true,
  ultimo_sync timestamptz,
  ultimo_stock_enviado integer,
  UNIQUE(sku, item_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_items_sku ON ml_items_map(sku);
CREATE INDEX IF NOT EXISTS idx_ml_items_activo ON ml_items_map(activo);

-- 8. STOCK SYNC QUEUE (cola de SKUs pendientes de sync a ML)
CREATE TABLE IF NOT EXISTS stock_sync_queue (
  sku text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);

-- 9. RLS + políticas para tablas nuevas
ALTER TABLE composicion_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE picking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conteos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_flex ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_items_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_sync_queue ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'composicion_venta', 'picking_sessions', 'conteos',
    'ml_config', 'pedidos_flex', 'ml_items_map', 'stock_sync_queue'
  ])
  LOOP
    EXECUTE format('CREATE POLICY IF NOT EXISTS "allow_select_%s" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('CREATE POLICY IF NOT EXISTS "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY IF NOT EXISTS "allow_update_%s" ON %I FOR UPDATE USING (true)', t, t);
    EXECUTE format('CREATE POLICY IF NOT EXISTS "allow_delete_%s" ON %I FOR DELETE USING (true)', t, t);
  END LOOP;
END $$;

-- 10. Agregar estados faltantes a recepciones (ANULADA, PAUSADA)
ALTER TABLE recepciones DROP CONSTRAINT IF EXISTS recepciones_estado_check;
ALTER TABLE recepciones ADD CONSTRAINT recepciones_estado_check
  CHECK (estado IN ('CREADA', 'EN_PROCESO', 'COMPLETADA', 'CERRADA', 'ANULADA', 'PAUSADA'));

-- ============================================
-- LISTO! Ejecuta esto en Supabase SQL Editor
-- Luego configura las credenciales ML en el panel admin
-- ============================================
