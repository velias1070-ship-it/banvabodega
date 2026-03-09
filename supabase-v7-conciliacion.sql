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
