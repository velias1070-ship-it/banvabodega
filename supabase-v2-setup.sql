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
