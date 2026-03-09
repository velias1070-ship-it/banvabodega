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
