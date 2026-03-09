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
   true, 0.95)
ON CONFLICT DO NOTHING;

-- Cuenta bancaria default: Santander BANVA
INSERT INTO cuentas_bancarias (empresa_id, banco, tipo_cuenta, alias, activa)
SELECT id, 'santander', 'cuenta_corriente', 'Santander BANVA', true
FROM empresas WHERE rut = '77994007-1'
ON CONFLICT DO NOTHING;

-- ============================================================
-- FIN v8 — Ejecutar en Supabase SQL Editor
-- ============================================================
