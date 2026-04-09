-- Schema completo BANVA Bodega (modo test)
-- Generado: Thu Mar 19 18:37:02 -03 2026

-- ============================================
-- Migracion: supabase-v2-setup.sql
-- ============================================
-- ==============================================
-- BANVA WMS v2 — Setup completo
-- Ejecutar en: Supabase → SQL Editor → New query
-- ==============================================

-- 1. OPERARIOS
CREATE TABLE IF NOT EXISTS operarios (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  pin text DEFAULT '1234',
  activo boolean DEFAULT true,
  rol text DEFAULT 'operario' CHECK (rol IN ('operario', 'admin')),
  created_at timestamptz DEFAULT now()
);

-- Admin por defecto
INSERT INTO operarios (id, nombre, pin, rol) VALUES ('admin', 'Administrador', '1234', 'admin')
ON CONFLICT (id) DO NOTHING;

-- 2. PRODUCTOS (diccionario maestro)
CREATE TABLE IF NOT EXISTS productos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text UNIQUE NOT NULL,
  sku_venta text DEFAULT '',
  codigo_ml text DEFAULT '',
  nombre text NOT NULL,
  categoria text DEFAULT 'Otros',
  proveedor text DEFAULT 'Otro',
  costo numeric DEFAULT 0,
  precio numeric DEFAULT 0,
  reorder integer DEFAULT 20,
  requiere_etiqueta boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_productos_sku ON productos(sku);
CREATE INDEX IF NOT EXISTS idx_productos_codigo_ml ON productos(codigo_ml);

-- 3. POSICIONES
CREATE TABLE IF NOT EXISTS posiciones (
  id text PRIMARY KEY,
  label text NOT NULL,
  tipo text DEFAULT 'pallet' CHECK (tipo IN ('pallet', 'shelf')),
  activa boolean DEFAULT true,
  mx numeric DEFAULT 0,
  my numeric DEFAULT 0,
  mw numeric DEFAULT 2,
  mh numeric DEFAULT 2,
  color text DEFAULT '#3b82f6'
);

-- Posiciones por defecto
INSERT INTO posiciones (id, label, tipo) VALUES
  ('1', 'Posición 1', 'pallet'), ('2', 'Posición 2', 'pallet'),
  ('3', 'Posición 3', 'pallet'), ('4', 'Posición 4', 'pallet'),
  ('5', 'Posición 5', 'pallet'), ('6', 'Posición 6', 'pallet'),
  ('7', 'Posición 7', 'pallet'), ('8', 'Posición 8', 'pallet'),
  ('9', 'Posición 9', 'pallet'), ('10', 'Posición 10', 'pallet'),
  ('11', 'Posición 11', 'pallet'), ('12', 'Posición 12', 'pallet'),
  ('13', 'Posición 13', 'pallet'), ('14', 'Posición 14', 'pallet'),
  ('15', 'Posición 15', 'pallet'),
  ('E1-1', 'Estante 1 Nivel 1', 'shelf'), ('E1-2', 'Estante 1 Nivel 2', 'shelf'),
  ('E1-3', 'Estante 1 Nivel 3', 'shelf'), ('E2-1', 'Estante 2 Nivel 1', 'shelf'),
  ('E2-2', 'Estante 2 Nivel 2', 'shelf'), ('E2-3', 'Estante 2 Nivel 3', 'shelf'),
  ('SIN_ASIGNAR', 'Sin asignar', 'pallet')
ON CONFLICT (id) DO NOTHING;

-- 4. STOCK (una fila = un SKU en una posición)
CREATE TABLE IF NOT EXISTS stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL REFERENCES productos(sku) ON DELETE CASCADE,
  posicion_id text NOT NULL REFERENCES posiciones(id),
  cantidad integer NOT NULL DEFAULT 0 CHECK (cantidad >= 0),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(sku, posicion_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_sku ON stock(sku);
CREATE INDEX IF NOT EXISTS idx_stock_posicion ON stock(posicion_id);

-- 5. RECEPCIONES
CREATE TABLE IF NOT EXISTS recepciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio text NOT NULL,
  proveedor text NOT NULL,
  imagen_url text DEFAULT '',
  estado text DEFAULT 'CREADA' CHECK (estado IN ('CREADA', 'EN_PROCESO', 'COMPLETADA', 'CERRADA')),
  notas text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  created_by text DEFAULT 'admin',
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_recepciones_estado ON recepciones(estado);
CREATE INDEX IF NOT EXISTS idx_recepciones_created ON recepciones(created_at DESC);

-- 6. RECEPCION LINEAS
CREATE TABLE IF NOT EXISTS recepcion_lineas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recepcion_id uuid NOT NULL REFERENCES recepciones(id) ON DELETE CASCADE,
  sku text NOT NULL,
  codigo_ml text DEFAULT '',
  nombre text NOT NULL,
  qty_factura integer NOT NULL DEFAULT 0,
  qty_recibida integer DEFAULT 0,
  qty_etiquetada integer DEFAULT 0,
  qty_ubicada integer DEFAULT 0,
  estado text DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'CONTADA', 'EN_ETIQUETADO', 'ETIQUETADA', 'UBICADA')),
  requiere_etiqueta boolean DEFAULT true,
  costo_unitario numeric DEFAULT 0,
  notas text DEFAULT '',
  operario_conteo text DEFAULT '',
  operario_etiquetado text DEFAULT '',
  operario_ubicacion text DEFAULT '',
  ts_conteo timestamptz,
  ts_etiquetado timestamptz,
  ts_ubicacion timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lineas_recepcion ON recepcion_lineas(recepcion_id);
CREATE INDEX IF NOT EXISTS idx_lineas_estado ON recepcion_lineas(estado);

-- 7. MOVIMIENTOS
CREATE TABLE IF NOT EXISTS movimientos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('entrada', 'salida', 'transferencia')),
  motivo text NOT NULL,
  sku text NOT NULL,
  posicion_id text NOT NULL,
  cantidad integer NOT NULL,
  recepcion_id uuid REFERENCES recepciones(id),
  operario text DEFAULT '',
  nota text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movimientos_sku ON movimientos(sku);
CREATE INDEX IF NOT EXISTS idx_movimientos_created ON movimientos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movimientos_recepcion ON movimientos(recepcion_id);

-- 8. MAPA CONFIG
CREATE TABLE IF NOT EXISTS mapa_config (
  id text PRIMARY KEY DEFAULT 'main',
  config jsonb DEFAULT '[]'::jsonb,
  grid_w integer DEFAULT 20,
  grid_h integer DEFAULT 14,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO mapa_config (id, config) VALUES ('main', '[
  {"id":"door1","label":"ENTRADA","kind":"door","mx":0,"my":5,"mw":1,"mh":3,"color":"#f59e0b"},
  {"id":"desk1","label":"Escritorio","kind":"desk","mx":1,"my":1,"mw":3,"mh":2,"color":"#6366f1"}
]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- 9. RLS (Row Level Security) — acceso público con anon key
ALTER TABLE operarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE posiciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE recepciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE recepcion_lineas ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapa_config ENABLE ROW LEVEL SECURITY;

-- Políticas: acceso completo para anon (la app maneja auth internamente)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['operarios','productos','posiciones','stock','recepciones','recepcion_lineas','movimientos','mapa_config'])
  LOOP
    EXECUTE format('CREATE POLICY "allow_select_%s" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('CREATE POLICY "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY "allow_update_%s" ON %I FOR UPDATE USING (true)', t, t);
    EXECUTE format('CREATE POLICY "allow_delete_%s" ON %I FOR DELETE USING (true)', t, t);
  END LOOP;
END $$;

-- 10. FUNCIONES ÚTILES

-- Función atómica para actualizar stock (sin race conditions)
CREATE OR REPLACE FUNCTION update_stock(p_sku text, p_posicion text, p_delta integer)
RETURNS void AS $$
BEGIN
  INSERT INTO stock (sku, posicion_id, cantidad, updated_at)
  VALUES (p_sku, p_posicion, GREATEST(0, p_delta), now())
  ON CONFLICT (sku, posicion_id)
  DO UPDATE SET 
    cantidad = GREATEST(0, stock.cantidad + p_delta),
    updated_at = now();
  
  -- Limpiar filas con cantidad 0
  DELETE FROM stock WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad = 0;
END;
$$ LANGUAGE plpgsql;

-- Función para obtener stock total de un SKU
CREATE OR REPLACE FUNCTION stock_total(p_sku text)
RETURNS integer AS $$
  SELECT COALESCE(SUM(cantidad), 0)::integer FROM stock WHERE sku = p_sku;
$$ LANGUAGE sql;

-- 11. BORRAR TABLA VIEJA (del v1 con JSON blob)
DROP TABLE IF EXISTS wms_state;

-- ============================================
-- LISTO! Ejecuta esto y luego deploya el código
-- ============================================


-- ============================================
-- Migracion: supabase-v3-setup.sql
-- ============================================
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
    EXECUTE format('DROP POLICY IF EXISTS "allow_select_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_select_%s" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_insert_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_update_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_update_%s" ON %I FOR UPDATE USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_delete_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_delete_%s" ON %I FOR DELETE USING (true)', t, t);
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


-- ============================================
-- Migracion: supabase-v4-flex-stock.sql
-- ============================================
-- ==============================================
-- BANVA WMS v4 — Flex Distributed Stock API
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v3-setup.sql
-- ==============================================

-- 1. Agregar columnas para el API de stock distribuido a ml_items_map
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS user_product_id text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS stock_version integer;

-- Índice para búsqueda por user_product_id
CREATE INDEX IF NOT EXISTS idx_ml_items_user_product ON ml_items_map(user_product_id);

-- 2. Agregar service_id a ml_config (necesario para endpoints Flex)
ALTER TABLE ml_config ADD COLUMN IF NOT EXISTS flex_service_id text DEFAULT '';

-- ============================================
-- LISTO! Ejecuta esto en Supabase SQL Editor
-- ============================================


-- ============================================
-- Migracion: supabase-v5-locks.sql
-- ============================================
-- ============================================================
-- v5: Add line-level locking for operator concurrency control
-- ============================================================

-- New columns for optimistic locking on recepcion_lineas
ALTER TABLE recepcion_lineas
  ADD COLUMN IF NOT EXISTS bloqueado_por text,
  ADD COLUMN IF NOT EXISTS bloqueado_hasta timestamptz;

-- Index for quick lookups of locked lines
CREATE INDEX IF NOT EXISTS idx_lineas_bloqueado ON recepcion_lineas(bloqueado_por) WHERE bloqueado_por IS NOT NULL;


-- ============================================
-- Migracion: supabase-v6-atomic-lock.sql
-- ============================================
-- ============================================================
-- v6: Atomic line locking via RPC (prevents race conditions)
-- Run AFTER v5-locks.sql
-- ============================================================

-- Atomic lock: uses SELECT ... FOR UPDATE to guarantee only one operator wins
CREATE OR REPLACE FUNCTION bloquear_linea(p_linea_id uuid, p_operario text, p_minutos integer DEFAULT 15)
RETURNS boolean AS $$
DECLARE
  v_bloqueado_por text;
  v_bloqueado_hasta timestamptz;
BEGIN
  -- Lock the row exclusively so no other transaction can read/modify it concurrently
  SELECT bloqueado_por, bloqueado_hasta
    INTO v_bloqueado_por, v_bloqueado_hasta
    FROM recepcion_lineas
   WHERE id = p_linea_id
     FOR UPDATE;

  -- Row not found
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Check if already locked by someone else and lock hasn't expired
  IF v_bloqueado_por IS NOT NULL
     AND v_bloqueado_por <> p_operario
     AND v_bloqueado_hasta > now() THEN
    RETURN false;
  END IF;

  -- Lock it for this operator
  UPDATE recepcion_lineas
     SET bloqueado_por = p_operario,
         bloqueado_hasta = now() + (p_minutos || ' minutes')::interval
   WHERE id = p_linea_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Atomic unlock
CREATE OR REPLACE FUNCTION desbloquear_linea(p_linea_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE recepcion_lineas
     SET bloqueado_por = NULL,
         bloqueado_hasta = NULL
   WHERE id = p_linea_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================
-- Migracion: supabase-v7-discrepancias-qty.sql
-- ============================================
-- ==============================================
-- BANVA WMS v7 — Discrepancias de Cantidad en Recepciones
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v6-atomic-lock.sql
-- ==============================================

-- 1. Tabla discrepancias_costo (crear si no existe — puede haber sido creada manualmente)
CREATE TABLE IF NOT EXISTS discrepancias_costo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recepcion_id text NOT NULL,
  linea_id text NOT NULL,
  sku text NOT NULL,
  costo_diccionario numeric NOT NULL DEFAULT 0,
  costo_factura numeric NOT NULL DEFAULT 0,
  diferencia numeric NOT NULL DEFAULT 0,
  porcentaje numeric NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
  resuelto_por text,
  resuelto_at timestamptz,
  notas text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE discrepancias_costo ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "discrepancias_costo_all" ON discrepancias_costo FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Tabla discrepancias_qty — resolución de diferencias de cantidad
CREATE TABLE IF NOT EXISTS discrepancias_qty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recepcion_id text NOT NULL,
  linea_id text,
  sku text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('FALTANTE','SOBRANTE','SKU_ERRONEO','NO_EN_FACTURA')),
  qty_factura integer NOT NULL DEFAULT 0,
  qty_recibida integer NOT NULL DEFAULT 0,
  diferencia integer NOT NULL DEFAULT 0,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ACEPTADO','RECLAMADO','NOTA_CREDITO','DEVOLUCION')),
  resuelto_por text,
  resuelto_at timestamptz,
  notas text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disc_qty_recepcion ON discrepancias_qty(recepcion_id);
CREATE INDEX IF NOT EXISTS idx_disc_qty_estado ON discrepancias_qty(estado);

ALTER TABLE discrepancias_qty ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "discrepancias_qty_all" ON discrepancias_qty FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ============================================
-- Migracion: supabase-v7-conciliacion.sql
-- ============================================
-- ============================================================
-- BANVA Conciliador v7 — Conciliación Tributaria-Bancaria
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v6-atomic-lock.sql
-- ============================================================

-- 1. EMPRESAS (multi-empresa)
CREATE TABLE IF NOT EXISTS empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rut TEXT NOT NULL UNIQUE,
  razon_social TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Insertar empresa default BANVA
INSERT INTO empresas (rut, razon_social)
VALUES ('77994007-1', 'BANVA SPA')
ON CONFLICT (rut) DO NOTHING;

-- 2. SYNC LOG (registro de sincronizaciones SII)
CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  periodo TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('compras', 'ventas')),
  registros INT,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_empresa ON sync_log(empresa_id);

-- 3. RCV COMPRAS (Registro de Compras y Ventas — compras)
CREATE TABLE IF NOT EXISTS rcv_compras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  periodo TEXT NOT NULL,
  estado TEXT NOT NULL,
  tipo_doc INT NOT NULL,
  nro_doc TEXT,
  rut_proveedor TEXT,
  razon_social TEXT,
  fecha_docto DATE,
  monto_exento NUMERIC DEFAULT 0,
  monto_neto NUMERIC DEFAULT 0,
  monto_iva NUMERIC DEFAULT 0,
  monto_total NUMERIC DEFAULT 0,
  fecha_recepcion DATE,
  evento_receptor TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empresa_id, periodo, tipo_doc, nro_doc, rut_proveedor)
);

CREATE INDEX IF NOT EXISTS idx_rcv_compras_periodo ON rcv_compras(empresa_id, periodo);
CREATE INDEX IF NOT EXISTS idx_rcv_compras_rut ON rcv_compras(rut_proveedor);
CREATE INDEX IF NOT EXISTS idx_rcv_compras_fecha ON rcv_compras(fecha_docto);

-- 4. RCV VENTAS (Registro de Compras y Ventas — ventas)
CREATE TABLE IF NOT EXISTS rcv_ventas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  periodo TEXT NOT NULL,
  tipo_doc TEXT NOT NULL,
  nro TEXT,
  rut_emisor TEXT,
  folio TEXT,
  fecha_docto DATE,
  monto_neto NUMERIC DEFAULT 0,
  monto_exento NUMERIC DEFAULT 0,
  monto_iva NUMERIC DEFAULT 0,
  monto_total NUMERIC DEFAULT 0,
  fecha_recepcion DATE,
  evento_receptor TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empresa_id, periodo, tipo_doc, folio)
);

CREATE INDEX IF NOT EXISTS idx_rcv_ventas_periodo ON rcv_ventas(empresa_id, periodo);
CREATE INDEX IF NOT EXISTS idx_rcv_ventas_rut ON rcv_ventas(rut_emisor);
CREATE INDEX IF NOT EXISTS idx_rcv_ventas_fecha ON rcv_ventas(fecha_docto);

-- 5. MOVIMIENTOS BANCARIOS
CREATE TABLE IF NOT EXISTS movimientos_banco (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  banco TEXT NOT NULL,
  cuenta TEXT,
  fecha DATE NOT NULL,
  descripcion TEXT,
  monto NUMERIC NOT NULL,
  saldo NUMERIC,
  referencia TEXT,
  origen TEXT DEFAULT 'csv' CHECK (origen IN ('csv', 'api', 'manual')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mov_banco_empresa_fecha ON movimientos_banco(empresa_id, fecha);
CREATE INDEX IF NOT EXISTS idx_mov_banco_banco ON movimientos_banco(banco);

-- 6. CONCILIACIONES (matches banco ↔ RCV)
CREATE TABLE IF NOT EXISTS conciliaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  movimiento_banco_id UUID REFERENCES movimientos_banco(id),
  rcv_compra_id UUID REFERENCES rcv_compras(id),
  rcv_venta_id UUID REFERENCES rcv_ventas(id),
  confianza NUMERIC,
  estado TEXT DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmado', 'rechazado')),
  tipo_partida TEXT,
  metodo TEXT,
  notas TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conciliaciones_empresa_estado ON conciliaciones(empresa_id, estado);
CREATE INDEX IF NOT EXISTS idx_conciliaciones_mov ON conciliaciones(movimiento_banco_id);

-- 7. ALERTAS
CREATE TABLE IF NOT EXISTS alertas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  descripcion TEXT,
  referencia_id UUID,
  estado TEXT DEFAULT 'activa' CHECK (estado IN ('activa', 'vista', 'resuelta')),
  prioridad TEXT DEFAULT 'media' CHECK (prioridad IN ('alta', 'media', 'baja')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alertas_empresa_estado ON alertas(empresa_id, estado);

-- 8. PERÍODOS DE CONCILIACIÓN (estado del proceso por período)
CREATE TABLE IF NOT EXISTS periodos_conciliacion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  periodo TEXT NOT NULL,
  saldo_inicial_banco NUMERIC,
  saldo_final_banco NUMERIC,
  saldo_inicial_libro NUMERIC,
  saldo_final_libro NUMERIC,
  diferencia NUMERIC DEFAULT 0,
  estado TEXT DEFAULT 'abierto' CHECK (estado IN ('abierto', 'en_proceso', 'cerrado')),
  fecha_cierre TIMESTAMPTZ,
  reporte_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empresa_id, periodo)
);

CREATE INDEX IF NOT EXISTS idx_periodos_conc_empresa ON periodos_conciliacion(empresa_id, periodo);

-- 9. RLS + políticas permisivas para todas las tablas
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE rcv_compras ENABLE ROW LEVEL SECURITY;
ALTER TABLE rcv_ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE movimientos_banco ENABLE ROW LEVEL SECURITY;
ALTER TABLE conciliaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE periodos_conciliacion ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'empresas', 'sync_log', 'rcv_compras', 'rcv_ventas',
    'movimientos_banco', 'conciliaciones', 'alertas', 'periodos_conciliacion'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "allow_select_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_select_%s" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_insert_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_update_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_update_%s" ON %I FOR UPDATE USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_delete_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_delete_%s" ON %I FOR DELETE USING (true)', t, t);
  END LOOP;
END $$;

-- ============================================================
-- LISTO! Ejecuta esto en Supabase SQL Editor.
-- Verifica que la tabla 'empresas' tenga un registro BANVA SPA.
-- ============================================================


-- ============================================
-- Migracion: supabase-v8-stock-sku-venta.sql
-- ============================================
-- v8: Stock por SKU venta
-- Agrega sku_venta al stock para rastrear formato de etiquetado (individual, pack, sin etiquetar)

-- 1. Agregar columna sku_venta (nullable, NULL = sin etiquetar / legacy)
ALTER TABLE stock ADD COLUMN IF NOT EXISTS sku_venta text DEFAULT NULL;

-- 2. Crear columna generada para manejar NULL en unique constraint
-- PostgreSQL no trata NULL=NULL como duplicado en UNIQUE, así que usamos una columna generada
ALTER TABLE stock ADD COLUMN IF NOT EXISTS sku_venta_key text GENERATED ALWAYS AS (COALESCE(sku_venta, '')) STORED;

-- 3. Eliminar constraint anterior y crear nueva
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_sku_posicion_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS stock_sku_skuventa_posicion_idx ON stock(sku, sku_venta_key, posicion_id);

-- 4. Índice para búsquedas por sku_venta
CREATE INDEX IF NOT EXISTS idx_stock_sku_venta ON stock(sku_venta) WHERE sku_venta IS NOT NULL;

-- 5. ELIMINAR la función vieja update_stock(3 params) antes de crear la nueva(4 params)
-- PostgreSQL trata funciones con distinta aridad como funciones separadas (overloading).
-- Si no dropeamos la vieja, quedan las dos y llamar con 3 args es ambiguo.
DROP FUNCTION IF EXISTS update_stock(text, text, integer);

-- 6. Crear función update_stock con soporte para sku_venta
CREATE OR REPLACE FUNCTION update_stock(p_sku text, p_posicion text, p_delta integer, p_sku_venta text DEFAULT NULL)
RETURNS void AS $$
BEGIN
  INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
  VALUES (p_sku, p_posicion, GREATEST(0, p_delta), p_sku_venta, now())
  ON CONFLICT (sku, sku_venta_key, posicion_id)
  DO UPDATE SET
    cantidad = GREATEST(0, stock.cantidad + p_delta),
    updated_at = now();

  -- Limpiar filas con cantidad 0
  DELETE FROM stock
  WHERE sku = p_sku
    AND posicion_id = p_posicion
    AND COALESCE(sku_venta, '') = COALESCE(p_sku_venta, '')
    AND cantidad = 0;
END;
$$ LANGUAGE plpgsql;

-- 7. Actualizar función stock_total (suma todo independiente de sku_venta)
CREATE OR REPLACE FUNCTION stock_total(p_sku text)
RETURNS integer AS $$
  SELECT COALESCE(SUM(cantidad), 0)::integer FROM stock WHERE sku = p_sku;
$$ LANGUAGE sql STABLE;


-- ============================================
-- Migracion: supabase-v8-finanzas.sql
-- ============================================
-- ============================================================
-- BANVA Conciliador v8 — Finanzas: Plan de cuentas, Reglas,
-- Pasarelas, Cuentas bancarias, Presupuesto, Cobranza
-- ============================================================
-- Ejecutar en Supabase SQL Editor DESPUÉS de v7

-- ==================== TABLAS NUEVAS ====================

-- 1. Plan de cuentas — Árbol jerárquico contable
CREATE TABLE IF NOT EXISTS plan_cuentas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','costo','gasto_operacional','gasto_no_op')),
  parent_id UUID REFERENCES plan_cuentas(id),
  nivel INT NOT NULL DEFAULT 0,
  es_hoja BOOLEAN NOT NULL DEFAULT true,
  activa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_cuentas_tipo ON plan_cuentas(tipo);
CREATE INDEX IF NOT EXISTS idx_plan_cuentas_parent ON plan_cuentas(parent_id);

-- 2. Reglas de conciliación — Motor de reglas automáticas
CREATE TABLE IF NOT EXISTS reglas_conciliacion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  activa BOOLEAN NOT NULL DEFAULT true,
  prioridad INT NOT NULL DEFAULT 99,
  condiciones JSONB NOT NULL DEFAULT '[]',
  accion_auto BOOLEAN NOT NULL DEFAULT false,
  confianza_minima NUMERIC(3,2) NOT NULL DEFAULT 0.80,
  categoria_cuenta_id UUID REFERENCES plan_cuentas(id),
  stats_matches INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reglas_prioridad ON reglas_conciliacion(prioridad);

-- 3. Conciliacion items — Permite 1 movimiento ↔ N documentos
CREATE TABLE IF NOT EXISTS conciliacion_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conciliacion_id UUID NOT NULL REFERENCES conciliaciones(id) ON DELETE CASCADE,
  documento_tipo TEXT NOT NULL CHECK (documento_tipo IN ('rcv_compra','rcv_venta','pasarela')),
  documento_id UUID NOT NULL,
  monto_aplicado NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conc_items_conciliacion ON conciliacion_items(conciliacion_id);
CREATE INDEX IF NOT EXISTS idx_conc_items_documento ON conciliacion_items(documento_tipo, documento_id);

-- 4. Pasarelas de pago — MercadoPago, Transbank, etc.
CREATE TABLE IF NOT EXISTS pasarelas_pago (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id),
  pasarela TEXT NOT NULL,
  fecha_operacion DATE,
  fecha_liquidacion DATE,
  referencia_externa TEXT,
  monto_bruto NUMERIC NOT NULL DEFAULT 0,
  comision NUMERIC NOT NULL DEFAULT 0,
  monto_neto NUMERIC NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  orden_ml_id TEXT,
  conciliacion_id UUID REFERENCES conciliaciones(id),
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pasarelas_empresa ON pasarelas_pago(empresa_id);
CREATE INDEX IF NOT EXISTS idx_pasarelas_ref ON pasarelas_pago(pasarela, referencia_externa);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pasarelas_ref_unique ON pasarelas_pago(pasarela, referencia_externa) WHERE referencia_externa IS NOT NULL;

-- 5. Cuentas bancarias — Registro de cuentas
CREATE TABLE IF NOT EXISTS cuentas_bancarias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id),
  banco TEXT NOT NULL,
  tipo_cuenta TEXT,
  numero_cuenta TEXT,
  alias TEXT,
  saldo_actual NUMERIC NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'CLP',
  activa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cuentas_empresa ON cuentas_bancarias(empresa_id);

-- 6. Presupuesto — Presupuesto anual por cuenta/mes
CREATE TABLE IF NOT EXISTS presupuesto (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id),
  anio INT NOT NULL,
  mes INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  categoria_cuenta_id UUID NOT NULL REFERENCES plan_cuentas(id),
  monto_presupuestado NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(empresa_id, anio, mes, categoria_cuenta_id)
);

-- 7. Cobranza acciones — Historial de gestión de cobro
CREATE TABLE IF NOT EXISTS cobranza_acciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  documento_id UUID NOT NULL,
  tipo_accion TEXT NOT NULL,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  destinatario TEXT,
  contenido TEXT,
  resultado TEXT,
  proximo_seguimiento DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cobranza_documento ON cobranza_acciones(documento_id);

-- ==================== ALTER TABLAS EXISTENTES ====================

-- Expandir movimientos_banco
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS cuenta_bancaria_id UUID REFERENCES cuentas_bancarias(id);
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS estado_conciliacion TEXT DEFAULT 'pendiente';
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS categoria_cuenta_id UUID REFERENCES plan_cuentas(id);
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS referencia_unica TEXT;

-- Índice único parcial para referencia_unica (evitar duplicados de import CSV)
CREATE UNIQUE INDEX IF NOT EXISTS idx_mov_banco_ref_unica
  ON movimientos_banco(empresa_id, banco, referencia_unica)
  WHERE referencia_unica IS NOT NULL;

-- Expandir conciliaciones
ALTER TABLE conciliaciones ADD COLUMN IF NOT EXISTS regla_id UUID REFERENCES reglas_conciliacion(id);

-- Expandir rcv_compras
ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS estado_pago TEXT DEFAULT 'pendiente';
ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;
ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS categoria_cuenta_id UUID REFERENCES plan_cuentas(id);

-- Expandir rcv_ventas
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS estado_pago TEXT DEFAULT 'pendiente';
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS categoria_cuenta_id UUID REFERENCES plan_cuentas(id);
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS estado_cobranza TEXT;

-- ==================== RLS (Políticas permisivas) ====================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'plan_cuentas','reglas_conciliacion','conciliacion_items',
    'pasarelas_pago','cuentas_bancarias','presupuesto','cobranza_acciones'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_select_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_select_%s" ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_insert_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_insert_%s" ON %I FOR INSERT WITH CHECK (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_update_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_update_%s" ON %I FOR UPDATE USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "allow_delete_%s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "allow_delete_%s" ON %I FOR DELETE USING (true)', t, t);
  END LOOP;
END;
$$;

-- ==================== SEED DATA ====================

-- Plan de cuentas BANVA
INSERT INTO plan_cuentas (codigo, nombre, tipo, nivel, es_hoja) VALUES
  -- INGRESOS
  ('4',      'INGRESOS',                    'ingreso',           0, false),
  ('4.1',    'Ingresos por Ventas',          'ingreso',           1, false),
  ('4.1.01', 'Ventas MercadoLibre',          'ingreso',           2, true),
  ('4.1.02', 'Ventas Shopify (futuro)',       'ingreso',           2, true),
  ('4.1.03', 'Otros ingresos',              'ingreso',           2, true),
  -- COSTO DE VENTAS
  ('5',      'COSTO DE VENTAS',             'costo',             0, false),
  ('5.1',    'Costos Directos',             'costo',             1, false),
  ('5.1.01', 'Compras Idetex (textiles)',    'costo',             2, true),
  ('5.1.02', 'Compras otros proveedores',    'costo',             2, true),
  ('5.1.03', 'Costo de envío',              'costo',             2, true),
  ('5.1.04', 'Comisiones MercadoLibre',      'costo',             2, true),
  -- GASTOS OPERACIONALES
  ('6',      'GASTOS OPERACIONALES',         'gasto_operacional', 0, false),
  ('6.1',    'Gastos de Operación',          'gasto_operacional', 1, false),
  ('6.1.01', 'Publicidad MercadoLibre Ads',  'gasto_operacional', 2, true),
  ('6.1.02', 'Publicidad otros canales',     'gasto_operacional', 2, true),
  ('6.1.03', 'Remuneraciones',              'gasto_operacional', 2, true),
  ('6.1.04', 'Arriendo bodega',             'gasto_operacional', 2, true),
  ('6.1.05', 'Software y suscripciones',     'gasto_operacional', 2, true),
  ('6.1.06', 'Embalaje y materiales',        'gasto_operacional', 2, true),
  ('6.1.07', 'Otros gastos operacionales',   'gasto_operacional', 2, true),
  -- GASTOS NO OPERACIONALES
  ('7',      'GASTOS NO OPERACIONALES',      'gasto_no_op',       0, false),
  ('7.1',    'Otros Gastos',                'gasto_no_op',       1, false),
  ('7.1.01', 'Gastos financieros',           'gasto_no_op',       2, true),
  ('7.1.02', 'Impuestos',                   'gasto_no_op',       2, true)
ON CONFLICT (codigo) DO NOTHING;

-- Actualizar parent_id del árbol
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '4')
  WHERE codigo LIKE '4.1%' AND codigo != '4';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '4.1')
  WHERE codigo LIKE '4.1.%';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '5')
  WHERE codigo LIKE '5.1%' AND codigo != '5';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '5.1')
  WHERE codigo LIKE '5.1.%';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '6')
  WHERE codigo LIKE '6.1%' AND codigo != '6';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '6.1')
  WHERE codigo LIKE '6.1.%';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '7')
  WHERE codigo LIKE '7.1%' AND codigo != '7';
UPDATE plan_cuentas SET parent_id = (SELECT id FROM plan_cuentas WHERE codigo = '7.1')
  WHERE codigo LIKE '7.1.%';

-- Reglas de conciliación predefinidas
INSERT INTO reglas_conciliacion (nombre, prioridad, condiciones, accion_auto, confianza_minima) VALUES
  ('Liquidación Mercado Pago', 1,
   '[{"campo":"descripcion","operador":"contiene","valor":"MERCADO PAGO"},{"campo":"monto","operador":"mayor_que","valor":0}]'::jsonb,
   true, 0.90),
  ('Pago Idetex', 2,
   '[{"campo":"descripcion","operador":"contiene","valor":"IDETEX"},{"campo":"monto","operador":"menor_que","valor":0}]'::jsonb,
   true, 0.90),
  ('Comisión bancaria', 3,
   '[{"campo":"descripcion","operador":"contiene","valor":"COMISION"}]'::jsonb,
   true, 0.95),
  ('Mantención cuenta', 4,
   '[{"campo":"descripcion","operador":"contiene","valor":"MANTENC"}]'::jsonb,
   true, 0.95);

-- Cuenta bancaria default: Santander BANVA
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, alias, activa)
SELECT id, 'santander', 'cuenta_corriente', 'Santander BANVA', true
FROM empresas WHERE rut = '77994007-1';

-- ============================================================
-- FIN v8 — Ejecutar en Supabase SQL Editor
-- ============================================================


-- ============================================
-- Migracion: supabase-v8b-feedback.sql
-- ============================================
-- ============================================================
-- BANVA Conciliador v8b — Feedback agentes + Cuentas bancarias
-- ============================================================
-- Ejecutar en Supabase SQL Editor DESPUÉS de v8

-- ==================== TABLA FEEDBACK AGENTES ====================

CREATE TABLE IF NOT EXISTS feedback_agentes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  agente TEXT NOT NULL,
  accion_sugerida JSONB,
  accion_correcta JSONB,
  contexto JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_agente ON feedback_agentes(agente, created_at DESC);

-- RLS permisivo
ALTER TABLE feedback_agentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_select_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_select_feedback_agentes" ON feedback_agentes FOR SELECT USING (true);
DROP POLICY IF EXISTS "allow_insert_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_insert_feedback_agentes" ON feedback_agentes FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_update_feedback_agentes" ON feedback_agentes FOR UPDATE USING (true);
DROP POLICY IF EXISTS "allow_delete_feedback_agentes" ON feedback_agentes;
CREATE POLICY "allow_delete_feedback_agentes" ON feedback_agentes FOR DELETE USING (true);

-- ==================== ACTUALIZAR CUENTAS BANCARIAS ====================

-- La empresa BANVA usa Banco de Chile, no Santander
UPDATE cuentas_bancarias SET banco = 'Banco de Chile', alias = 'BANVA CC Empresa'
WHERE alias = 'Santander BANVA';

-- Agregar TC personal de Vicente
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, numero_cuenta, alias, moneda)
SELECT id, 'Santander', 'tc_credito', '****', 'Vicente TC Personal', 'CLP'
FROM empresas WHERE rut = '77994007-1';

-- Agregar MercadoPago
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, numero_cuenta, alias, moneda)
SELECT id, 'MercadoPago', 'digital', '1953806321', 'BANVA MercadoPago', 'CLP'
FROM empresas WHERE rut = '77994007-1';

-- ============================================================
-- FIN v8b — Ejecutar en Supabase SQL Editor
-- ============================================================


-- ============================================
-- Migracion: supabase-v9-inner-pack.sql
-- ============================================
-- v9: Agregar columna inner_pack a productos
-- Para persistir el tamaño de bulto del proveedor y usarlo en redondeo inteligente de envíos Full

ALTER TABLE productos ADD COLUMN IF NOT EXISTS inner_pack integer DEFAULT NULL;

COMMENT ON COLUMN productos.inner_pack IS 'Unidades por bulto del proveedor (ej: 5 = bultos de 5 uds). NULL = sin info.';


-- ============================================
-- Migracion: supabase-v9-banco-sync.sql
-- ============================================
-- ============================================================
-- MIGRACIÓN v9: Soporte para sync de fuentes bancarias
-- Ejecutar después de v8/v8b
-- ============================================================

-- 1. Expandir CHECK constraint de sync_log.tipo
-- para permitir nuevos tipos de sync (mercadopago, banco_chile, santander_tc)
ALTER TABLE sync_log DROP CONSTRAINT IF EXISTS sync_log_tipo_check;
ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check
  CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));

-- 2. Expandir CHECK constraint de movimientos_banco.origen
-- para incluir scrapers
ALTER TABLE movimientos_banco DROP CONSTRAINT IF EXISTS movimientos_banco_origen_check;
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_origen_check
  CHECK (origen IN ('csv', 'api', 'manual', 'scraper_bchile', 'scraper_santander'));

-- 3. Agregar columna metadata a movimientos_banco (para clasificación TC, etc.)
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 4. Índice para buscar movimientos por origen (útil para filtrar por fuente)
CREATE INDEX IF NOT EXISTS idx_mov_banco_origen ON movimientos_banco(origen);

-- 5. Constraint UNIQUE real para pasarelas_pago (reemplaza el parcial)
-- PostgREST necesita un constraint real, no un partial unique index
DROP INDEX IF EXISTS idx_pasarelas_ref_unique;
ALTER TABLE pasarelas_pago DROP CONSTRAINT IF EXISTS pasarelas_pago_ref_unique;
ALTER TABLE pasarelas_pago ADD CONSTRAINT pasarelas_pago_ref_unique
  UNIQUE (empresa_id, pasarela, referencia_externa);

-- 6. Constraint UNIQUE real para movimientos_banco.referencia_unica
-- PostgREST no soporta partial unique indexes con ON CONFLICT
DROP INDEX IF EXISTS idx_mov_banco_ref_unica;
ALTER TABLE movimientos_banco DROP CONSTRAINT IF EXISTS movimientos_banco_ref_unica;
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_ref_unica
  UNIQUE (empresa_id, banco, referencia_unica);


-- ============================================
-- Migracion: supabase-v9-fix.sql
-- ============================================
-- ============================================================
-- FIX v9: Arreglar constraints que no se aplicaron
-- Copiar y pegar TODO este bloque en el SQL Editor de Supabase
-- ============================================================

-- 1. Listar todos los constraints de sync_log para debug
-- (puedes ver el resultado antes de ejecutar los ALTER)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sync_log'::regclass;

-- 2. Eliminar TODOS los check constraints de sync_log.tipo
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'sync_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%tipo%'
  LOOP
    EXECUTE 'ALTER TABLE sync_log DROP CONSTRAINT ' || r.conname;
    RAISE NOTICE 'Dropped: %', r.conname;
  END LOOP;
END $$;

-- 3. Crear nuevo constraint expandido
ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check
  CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));

-- 4. Eliminar check constraints de movimientos_banco.origen
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'movimientos_banco'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%origen%'
  LOOP
    EXECUTE 'ALTER TABLE movimientos_banco DROP CONSTRAINT ' || r.conname;
    RAISE NOTICE 'Dropped: %', r.conname;
  END LOOP;
END $$;

-- 5. Crear nuevo constraint expandido para origen
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_origen_check
  CHECK (origen IN ('csv', 'api', 'manual', 'scraper_bchile', 'scraper_santander'));

-- 6. Agregar columna metadata si no existe
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 7. Índice por origen
CREATE INDEX IF NOT EXISTS idx_mov_banco_origen ON movimientos_banco(origen);

-- 8. Verificar
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('sync_log'::regclass, 'movimientos_banco'::regclass)
AND contype = 'c';


-- ============================================
-- Migracion: supabase-v9-simple.sql
-- ============================================
-- EJECUTAR ESTE SQL EN EL SQL EDITOR DE SUPABASE
-- Cada línea es independiente, ejecutar de a una si falla

ALTER TABLE sync_log DROP CONSTRAINT sync_log_tipo_check;

ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));


-- ============================================
-- Migracion: supabase-v9b-mp-liquidacion.sql
-- ============================================
-- ============================================================
-- MIGRACIÓN v9b: Tabla para liquidaciones MercadoPago (Excel)
-- + columna metadata en movimientos_banco
-- Ejecutar después de v9
-- ============================================================

-- 1. Columna metadata en movimientos_banco (si no se creó en v9)
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 2. Tabla de detalle de liquidación MercadoPago
CREATE TABLE IF NOT EXISTS mp_liquidacion_detalle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id),
  factura_folio TEXT NOT NULL,
  fecha_desde DATE,
  fecha_hasta DATE,
  fecha_operacion TIMESTAMPTZ,
  tipo_documento TEXT,
  dte INT,
  folio_dte TEXT,
  venta_id TEXT,
  descripcion TEXT,
  cantidad INT DEFAULT 1,
  monto NUMERIC,
  iva NUMERIC,
  sku TEXT,
  codigo_producto TEXT,
  folio_asociado TEXT,
  tipo_devolucion TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mp_liq_empresa ON mp_liquidacion_detalle(empresa_id);
CREATE INDEX IF NOT EXISTS idx_mp_liq_factura ON mp_liquidacion_detalle(factura_folio);
CREATE INDEX IF NOT EXISTS idx_mp_liq_venta ON mp_liquidacion_detalle(venta_id);
CREATE INDEX IF NOT EXISTS idx_mp_liq_sku ON mp_liquidacion_detalle(sku);

-- Unique para evitar duplicados de import
CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_liq_unique
  ON mp_liquidacion_detalle(empresa_id, factura_folio, venta_id, dte, folio_dte)
  WHERE venta_id IS NOT NULL;

-- 3. RLS permisivo
ALTER TABLE mp_liquidacion_detalle ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "allow_select_mp_liq" ON mp_liquidacion_detalle';
  EXECUTE 'CREATE POLICY "allow_select_mp_liq" ON mp_liquidacion_detalle FOR SELECT USING (true)';
  EXECUTE 'DROP POLICY IF EXISTS "allow_insert_mp_liq" ON mp_liquidacion_detalle';
  EXECUTE 'CREATE POLICY "allow_insert_mp_liq" ON mp_liquidacion_detalle FOR INSERT WITH CHECK (true)';
  EXECUTE 'DROP POLICY IF EXISTS "allow_update_mp_liq" ON mp_liquidacion_detalle';
  EXECUTE 'CREATE POLICY "allow_update_mp_liq" ON mp_liquidacion_detalle FOR UPDATE USING (true)';
  EXECUTE 'DROP POLICY IF EXISTS "allow_delete_mp_liq" ON mp_liquidacion_detalle';
  EXECUTE 'CREATE POLICY "allow_delete_mp_liq" ON mp_liquidacion_detalle FOR DELETE USING (true)';
END $$;


-- ============================================
-- Migracion: supabase-v10-reembolsos.sql
-- ============================================
-- ============================================================
-- MIGRACIÓN v10: Rastreo de reembolsos TC Personal → Empresa
-- Ejecutar en SQL Editor de Supabase
-- ============================================================

-- 1. Campos de reembolso en movimientos_banco
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS requiere_reembolso BOOLEAN DEFAULT false;
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS reembolso_estado TEXT;
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS reembolso_movimiento_id UUID REFERENCES movimientos_banco(id);

-- 2. Índice para búsqueda rápida de reembolsos pendientes
CREATE INDEX IF NOT EXISTS idx_mov_banco_reembolso
  ON movimientos_banco(empresa_id, requiere_reembolso)
  WHERE requiere_reembolso = true;

-- 3. Check constraint para estados de reembolso
ALTER TABLE movimientos_banco ADD CONSTRAINT movimientos_banco_reembolso_estado_check
  CHECK (reembolso_estado IS NULL OR reembolso_estado IN ('pendiente', 'conciliado', 'descartado'));


-- ============================================
-- Migracion: supabase-v10-picking-tipo-titulo.sql
-- ============================================
-- v10: Add tipo and titulo columns to picking_sessions
-- These columns are used by the envio_full and flex picking creation flows

ALTER TABLE picking_sessions
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'flex',
  ADD COLUMN IF NOT EXISTS titulo text;


-- ============================================
-- Migracion: supabase-v11-agents.sql
-- ============================================
-- ============================================
-- BANVA WMS — v11: Arquitectura de Agentes IA
-- ============================================

-- Tabla agent_config — Configuración de cada agente
CREATE TABLE IF NOT EXISTS agent_config (
  id text PRIMARY KEY, -- 'reposicion', 'inventario', 'rentabilidad', 'recepcion', 'orquestador'
  nombre_display text NOT NULL,
  descripcion text,
  model text DEFAULT 'claude-sonnet-4-20250514',
  system_prompt_base text,
  activo boolean DEFAULT true,
  max_tokens_input integer DEFAULT 50000,
  max_tokens_output integer DEFAULT 4000,
  schedule text, -- cron expression nullable
  last_run_at timestamptz,
  last_run_tokens integer,
  last_run_cost_usd numeric,
  config_extra jsonb DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- Tabla agent_insights — Lo que producen los agentes
CREATE TABLE IF NOT EXISTS agent_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  run_id uuid,
  tipo text CHECK (tipo IN ('alerta', 'sugerencia', 'analisis', 'resumen')),
  severidad text CHECK (severidad IN ('critica', 'alta', 'media', 'info')),
  categoria text,
  titulo text NOT NULL,
  contenido text,
  datos jsonb,
  skus_relacionados text[],
  estado text DEFAULT 'nuevo' CHECK (estado IN ('nuevo', 'visto', 'aceptado', 'rechazado', 'corregido')),
  feedback_texto text,
  feedback_at timestamptz,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

-- Tabla agent_rules — Reglas aprendidas por feedback
CREATE TABLE IF NOT EXISTS agent_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  regla text NOT NULL,
  contexto text,
  origen text CHECK (origen IN ('feedback_admin', 'manual', 'sistema')),
  origen_insight_id uuid REFERENCES agent_insights(id),
  prioridad integer DEFAULT 5,
  veces_aplicada integer DEFAULT 0,
  activa boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Tabla agent_runs — Registro de cada ejecución
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agente text REFERENCES agent_config(id),
  trigger text CHECK (trigger IN ('cron', 'manual', 'evento', 'chat')),
  estado text DEFAULT 'corriendo' CHECK (estado IN ('corriendo', 'completado', 'error')),
  tokens_input integer,
  tokens_output integer,
  costo_usd numeric,
  duracion_ms integer,
  insights_generados integer,
  error_mensaje text,
  datos_snapshot_hash text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- Tabla agent_conversations — Chat con el orquestador
CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  role text CHECK (role IN ('user', 'assistant')),
  contenido text NOT NULL,
  agentes_invocados text[],
  tokens_usados integer,
  created_at timestamptz DEFAULT now()
);

-- Tabla agent_data_snapshots — Snapshots para reproducibilidad
CREATE TABLE IF NOT EXISTS agent_data_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  hash text UNIQUE NOT NULL,
  datos jsonb,
  created_at timestamptz DEFAULT now()
);

-- ============================================
-- Índices
-- ============================================
CREATE INDEX IF NOT EXISTS idx_agent_insights_agente_estado ON agent_insights(agente, estado, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_insights_skus ON agent_insights USING GIN(skus_relacionados);
CREATE INDEX IF NOT EXISTS idx_agent_rules_agente ON agent_rules(agente, activa);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agente ON agent_runs(agente, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_session ON agent_conversations(session_id, created_at);

-- ============================================
-- RLS — Políticas permisivas (igual que el resto del sistema)
-- ============================================
ALTER TABLE agent_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_data_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_config_all" ON agent_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_insights_all" ON agent_insights FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_rules_all" ON agent_rules FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_runs_all" ON agent_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_conversations_all" ON agent_conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "agent_data_snapshots_all" ON agent_data_snapshots FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- Datos iniciales — Configuración de agentes
-- ============================================
INSERT INTO agent_config (id, nombre_display, descripcion, model, system_prompt_base, config_extra) VALUES
(
  'reposicion',
  'Reposición',
  'Analiza stock, velocidad de venta y cobertura para sugerir reposición a Full y pedidos a proveedor',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en gestión de inventario y reposición para un warehouse de e-commerce en Chile (MercadoLibre).

Tu trabajo es analizar los datos de stock, velocidad de venta por canal (Full y Flex), cobertura en días, y datos de proveedor para generar insights accionables.

Prioridades:
1. Detectar SKUs agotados o por agotarse (cobertura < 14 días) — severidad crítica o alta
2. Identificar oportunidades de envío a Full (stock en bodega sin enviar)
3. Alertar sobre exceso de stock (cobertura > 60 días)
4. Sugerir pedidos a proveedor cuando el stock total es insuficiente
5. Detectar anomalías en velocidad (cambios bruscos semana a semana)
6. Identificar SKUs donde la distribución Full/Flex no es óptima según márgenes

Reglas de negocio:
- Punto de reorden: 14 días de cobertura
- Objetivo de cobertura: 45 días (o 30 días si margen Flex > margen Full)
- Cobertura máxima antes de exceso: 60 días
- Los envíos a Full deben respetar inner_pack del producto
- Considerar que Full tiene tiempo de procesamiento (no es inmediato)',
  '{"cobObjetivo": 45, "puntoReorden": 14, "cobMaxima": 60}'
),
(
  'inventario',
  'Inventario',
  'Analiza discrepancias de stock, sugiere conteos cíclicos prioritarios y detecta anomalías',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en control de inventario para un warehouse de e-commerce en Chile.

Tu trabajo es analizar el estado del inventario, detectar discrepancias, sugerir conteos cíclicos prioritarios y encontrar anomalías.

Prioridades:
1. SKUs con discrepancias recientes en conteos — severidad alta
2. SKUs de alta rotación sin conteo reciente (>30 días) — sugerir conteo
3. Posiciones con múltiples SKUs que podrían generar confusión
4. Stock negativo o cero en SKUs activos (con ventas recientes)
5. Movimientos inusuales (cantidades atípicas, horarios fuera de rango)
6. SKUs sin etiquetar que requieren etiqueta

Responde con sugerencias específicas de conteo para el día, priorizando por impacto en ventas.',
  '{}'
),
(
  'rentabilidad',
  'Rentabilidad',
  'Analiza márgenes por SKU y canal, detecta productos no rentables y sugiere optimizaciones',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en rentabilidad de e-commerce para un seller de MercadoLibre Chile.

Tu trabajo es analizar márgenes por SKU y por canal (Full vs Flex), detectar productos no rentables, y sugerir optimizaciones de distribución.

Prioridades:
1. SKUs con margen negativo — severidad crítica
2. SKUs donde el canal actual no es el óptimo (ej: vendiendo por Full cuando Flex es más rentable)
3. Tendencias de margen: SKUs cuyo margen está bajando semana a semana
4. Oportunidades de mejora: productos con buen margen que podrían vender más
5. Costos de envío anómalos
6. Impacto de comisiones ML en la rentabilidad

Usa datos concretos: porcentajes, montos en CLP, comparaciones.',
  '{}'
),
(
  'recepcion',
  'Recepción',
  'Analiza recepciones de mercadería, detecta discrepancias de costo y cantidad con proveedores',
  'claude-sonnet-4-20250514',
  'Eres un analista experto en recepción de mercadería y control de proveedores para un warehouse en Chile.

Tu trabajo es analizar las recepciones recientes, detectar patrones de discrepancias y sugerir acciones correctivas.

Prioridades:
1. Discrepancias de cantidad recurrentes por proveedor — severidad alta
2. Discrepancias de costo > 2% entre factura y precio esperado
3. Recepciones pendientes o atrasadas
4. Proveedores con patrón de envíos incompletos
5. Productos que frecuentemente llegan dañados o con SKU erróneo
6. Tiempos de recepción anómalos (muy lentos o muy rápidos)

Sugiere acciones concretas: reclamar, actualizar precio, cambiar proveedor, etc.',
  '{}'
),
(
  'orquestador',
  'Orquestador',
  'Agente conversacional que responde preguntas del admin integrando insights de todos los agentes',
  'claude-sonnet-4-20250514',
  'Eres el asistente de gestión de BANVA Bodega, un warehouse de e-commerce en Chile que vende por MercadoLibre (Full y Flex).

Tienes acceso a insights generados por agentes especializados:
- **Reposición**: stock, velocidad, cobertura, envíos a Full, pedidos a proveedor
- **Inventario**: discrepancias, conteos cíclicos, anomalías de stock
- **Rentabilidad**: márgenes por SKU y canal, optimización de distribución
- **Recepción**: discrepancias con proveedores, costos, calidad

Responde en español, de forma concisa y accionable. Cuando cites datos, sé específico (SKUs, números, fechas). Si no tienes datos suficientes para responder, dilo claramente.

Puedes sugerir ejecutar un agente específico si la pregunta requiere datos frescos.',
  '{}'
)
ON CONFLICT (id) DO NOTHING;


-- ============================================
-- Migracion: supabase-v12-orders-history.sql
-- ============================================
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


-- ============================================
-- Migracion: supabase-v12-profitguard-cache.sql
-- ============================================
-- v12: Cache de órdenes ProfitGuard
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS profitguard_cache (
  id text PRIMARY KEY DEFAULT 'orders',
  datos jsonb NOT NULL DEFAULT '[]'::jsonb,
  rango_desde text,
  rango_hasta text,
  cantidad_ordenes integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- RLS permisivo (consistente con el resto del proyecto)
ALTER TABLE profitguard_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profitguard_cache_select" ON profitguard_cache FOR SELECT USING (true);
CREATE POLICY "profitguard_cache_insert" ON profitguard_cache FOR INSERT WITH CHECK (true);
CREATE POLICY "profitguard_cache_update" ON profitguard_cache FOR UPDATE USING (true);
CREATE POLICY "profitguard_cache_delete" ON profitguard_cache FOR DELETE USING (true);


-- ============================================
-- Migracion: supabase-v13-fix-update-stock.sql
-- ============================================
-- v13: Fix update_stock para manejar sku_venta NULL cuando hay variantes con sku_venta asignado
-- Problema: cuando se llama update_stock(sku, pos, delta) sin sku_venta (NULL),
-- la RPC no encuentra la fila existente que tiene sku_venta = 'LA-BIB-9' (u otro),
-- porque el ON CONFLICT busca sku_venta_key = '' en vez de 'LA-BIB-9'.
-- Fix: Si p_sku_venta es NULL y no existe fila con sku_venta NULL, pero SÍ existen
-- filas con sku_venta asignado, distribuir el delta entre esas filas.

CREATE OR REPLACE FUNCTION update_stock(p_sku text, p_posicion text, p_delta integer, p_sku_venta text DEFAULT NULL)
RETURNS void AS $$
DECLARE
  v_remaining integer;
  v_row record;
BEGIN
  -- Si se especifica sku_venta, comportamiento directo (sin cambio)
  IF p_sku_venta IS NOT NULL THEN
    INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
    VALUES (p_sku, p_posicion, GREATEST(0, p_delta), p_sku_venta, now())
    ON CONFLICT (sku, sku_venta_key, posicion_id)
    DO UPDATE SET
      cantidad = GREATEST(0, stock.cantidad + p_delta),
      updated_at = now();

    DELETE FROM stock
    WHERE sku = p_sku
      AND posicion_id = p_posicion
      AND COALESCE(sku_venta, '') = COALESCE(p_sku_venta, '')
      AND cantidad = 0;
    RETURN;
  END IF;

  -- p_sku_venta IS NULL: para entradas, insertar normalmente con NULL
  IF p_delta >= 0 THEN
    INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
    VALUES (p_sku, p_posicion, GREATEST(0, p_delta), NULL, now())
    ON CONFLICT (sku, sku_venta_key, posicion_id)
    DO UPDATE SET
      cantidad = GREATEST(0, stock.cantidad + p_delta),
      updated_at = now();
    RETURN;
  END IF;

  -- p_sku_venta IS NULL y p_delta < 0 (salida):
  -- Primero intentar decrementar fila con sku_venta NULL
  -- Si no existe, distribuir entre filas con sku_venta asignado
  IF EXISTS (
    SELECT 1 FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad > 0
  ) THEN
    UPDATE stock SET
      cantidad = GREATEST(0, cantidad + p_delta),
      updated_at = now()
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL;

    DELETE FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad = 0;
    RETURN;
  END IF;

  -- No hay fila con sku_venta NULL — distribuir entre variantes existentes
  v_remaining := ABS(p_delta);
  FOR v_row IN
    SELECT id, cantidad, sku_venta
    FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad > 0
    ORDER BY cantidad DESC
    FOR UPDATE
  LOOP
    IF v_remaining <= 0 THEN EXIT; END IF;

    IF v_row.cantidad >= v_remaining THEN
      UPDATE stock SET
        cantidad = cantidad - v_remaining,
        updated_at = now()
      WHERE id = v_row.id;
      v_remaining := 0;
    ELSE
      v_remaining := v_remaining - v_row.cantidad;
      UPDATE stock SET cantidad = 0, updated_at = now() WHERE id = v_row.id;
    END IF;
  END LOOP;

  -- Limpiar filas con cantidad 0
  DELETE FROM stock
  WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad = 0;
END;
$$ LANGUAGE plpgsql;


-- ============================================
-- Migracion: supabase-v14-agent-triggers.sql
-- ============================================
-- =============================================================
-- V14: Agent Triggers — Sistema de triggers y reglas para agentes IA
-- =============================================================

-- Tabla de triggers
CREATE TABLE IF NOT EXISTS agent_triggers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agente text NOT NULL,
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('tiempo', 'evento', 'manual')),
  configuracion jsonb NOT NULL DEFAULT '{}',
  activo boolean DEFAULT true,
  ultima_ejecucion timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE agent_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "triggers_all" ON agent_triggers FOR ALL USING (true) WITH CHECK (true);

-- Índices
CREATE INDEX IF NOT EXISTS idx_agent_triggers_agente ON agent_triggers(agente);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_tipo ON agent_triggers(tipo);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_activo ON agent_triggers(activo);

-- =============================================================
-- Datos iniciales
-- =============================================================

INSERT INTO agent_triggers (agente, nombre, tipo, configuracion) VALUES
-- Reposición
('reposicion', 'Órdenes importadas', 'evento', '{"evento": "ordenes_importadas", "condicion": "cantidad_nuevas > 0"}'),
('reposicion', 'Stock proveedor actualizado', 'evento', '{"evento": "proveedor_cargado"}'),
('reposicion', 'Revisión L/J', 'tiempo', '{"intervalo": "semanal", "hora": "08:00", "dias": ["lun", "jue"]}'),
('reposicion', 'Cobertura crítica', 'evento', '{"evento": "picking_completado"}'),

-- Rentabilidad
('rentabilidad', 'Órdenes importadas', 'evento', '{"evento": "ordenes_importadas", "condicion": "cantidad_nuevas > 0"}'),
('rentabilidad', 'Costo aprobado', 'evento', '{"evento": "costo_aprobado"}'),
('rentabilidad', 'Revisión semanal', 'tiempo', '{"intervalo": "semanal", "hora": "09:00", "dias": ["lun"]}'),

-- Inventario
('inventario', 'Recepción completada', 'evento', '{"evento": "recepcion_completada"}'),
('inventario', 'Picking completado', 'evento', '{"evento": "picking_completado"}'),
('inventario', 'Conteo cíclico', 'tiempo', '{"intervalo": "diario", "hora": "08:00", "dias": ["lun", "mar", "mie", "jue", "vie", "sab"]}'),
('inventario', 'Dead stock', 'tiempo', '{"intervalo": "semanal", "hora": "08:00", "dias": ["lun"]}'),

-- Recepción
('recepcion', 'Recepción cerrada', 'evento', '{"evento": "recepcion_cerrada"}'),
('recepcion', 'Discrepancia costo', 'evento', '{"evento": "discrepancia_costo_detectada"}'),
('recepcion', 'Revisión mensual', 'tiempo', '{"intervalo": "mensual", "dia_mes": 1, "hora": "08:00"}'),

-- Observador
('observador', 'Revisión semanal', 'tiempo', '{"intervalo": "semanal", "hora": "17:00", "dias": ["vie"]}'),
('observador', 'Acciones acumuladas', 'evento', '{"evento": "acciones_acumuladas", "condicion": "count > 50"}');

-- =============================================================
-- Actualizar modelos de agentes
-- =============================================================

UPDATE agent_config SET model = 'claude-opus-4-6' WHERE id = 'orquestador';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'reposicion';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'rentabilidad';
UPDATE agent_config SET model = 'claude-sonnet-4-6' WHERE id = 'recepcion';
UPDATE agent_config SET model = 'claude-haiku-4-5-20251001' WHERE id = 'inventario';
UPDATE agent_config SET model = 'claude-haiku-4-5-20251001' WHERE id = 'observador';


-- ============================================
-- Migracion: supabase-v14-factura-original.sql
-- ============================================
-- v14: Factura original snapshot + historial de ajustes de recepción
-- Permite comparar siempre la factura del proveedor vs lo que realmente se recibió

-- 1. Campo factura_original en recepciones (snapshot JSON inmutable)
ALTER TABLE recepciones ADD COLUMN IF NOT EXISTS factura_original jsonb;

-- 2. Tabla de historial de ajustes
CREATE TABLE IF NOT EXISTS recepcion_ajustes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  recepcion_id uuid NOT NULL REFERENCES recepciones(id),
  tipo text NOT NULL,
  sku_original text,
  sku_nuevo text,
  campo text,
  valor_anterior text,
  valor_nuevo text,
  motivo text,
  admin text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ajustes_recepcion ON recepcion_ajustes(recepcion_id, created_at);

ALTER TABLE recepcion_ajustes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ajustes_all" ON recepcion_ajustes FOR ALL USING (true) WITH CHECK (true);


-- ============================================
-- Migracion: supabase-v15-ventas-razon-social.sql
-- ============================================
-- =====================================================
-- v15: Agregar razón social y rut_receptor a rcv_ventas
-- =====================================================
-- Campos nuevos para mostrar el nombre del receptor en ventas
-- (obtenidos via endpoint JSON del SII en vez de CSV)

-- Agregar columnas nuevas
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS razon_social TEXT;
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS rut_receptor TEXT;
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS estado TEXT;

-- Índice para búsqueda por razón social
CREATE INDEX IF NOT EXISTS idx_rcv_ventas_razon_social
  ON rcv_ventas (empresa_id, periodo)
  WHERE razon_social IS NOT NULL;


-- ============================================
-- Datos de ejemplo para modo test
-- ============================================

-- Operarios de prueba
INSERT INTO operarios (id, nombre, pin, activo, rol) VALUES
  ('TEST-ADMIN', 'Admin Test', '1234', true, 'admin'),
  ('TEST-OP1', 'Operador Test 1', '1111', true, 'operario'),
  ('TEST-OP2', 'Operador Test 2', '2222', true, 'operario')
ON CONFLICT (id) DO NOTHING;

-- Posiciones de prueba
INSERT INTO posiciones (id, label, tipo) VALUES
  ('P1', 'Pallet 1', 'pallet'),
  ('P2', 'Pallet 2', 'pallet'),
  ('P3', 'Pallet 3', 'pallet'),
  ('E1-1', 'Estante 1-1', 'shelf'),
  ('E1-2', 'Estante 1-2', 'shelf'),
  ('E2-1', 'Estante 2-1', 'shelf'),
  ('SIN_ASIGNAR', 'Sin Asignar', 'shelf')
ON CONFLICT (id) DO NOTHING;

-- Productos de prueba
INSERT INTO productos (sku, nombre, categoria, costo, precio) VALUES
  ('TEST-001', 'Producto Test A', 'Categoria 1', 5000, 9990),
  ('TEST-002', 'Producto Test B', 'Categoria 1', 3000, 5990),
  ('TEST-003', 'Producto Test C', 'Categoria 2', 8000, 14990),
  ('TEST-004', 'Producto Test D', 'Categoria 2', 2000, 3990),
  ('TEST-005', 'Producto Test E', 'Categoria 3', 12000, 19990)
ON CONFLICT (sku) DO NOTHING;

-- Stock inicial de prueba
INSERT INTO stock (sku, posicion_id, cantidad) VALUES
  ('TEST-001', 'P1', 50),
  ('TEST-001', 'E1-1', 10),
  ('TEST-002', 'P2', 30),
  ('TEST-003', 'E1-2', 20),
  ('TEST-004', 'E2-1', 100),
  ('TEST-005', 'P3', 15)
ON CONFLICT (sku, sku_venta_key, posicion_id) DO NOTHING;

