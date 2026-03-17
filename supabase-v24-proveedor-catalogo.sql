-- ============================================================
-- v24: Proveedor Catálogo, Imports, Costos Historial
--      + ALTER ordenes_compra (BORRADOR, ANULADA, lead_time_real, etc.)
--      + ALTER ordenes_compra_lineas (snapshot al pedir)
--      + ALTER recepciones (orden_compra_id)
-- ============================================================

-- 1. Catálogo de proveedor (persistencia de Excel)
CREATE TABLE IF NOT EXISTS proveedor_catalogo (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  proveedor text NOT NULL,
  sku_origen text NOT NULL,
  nombre text,
  inner_pack integer DEFAULT 1,
  precio_neto numeric DEFAULT 0,
  stock_disponible integer DEFAULT -1,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(proveedor, sku_origen)
);

CREATE INDEX IF NOT EXISTS idx_prov_cat_proveedor ON proveedor_catalogo(proveedor);
CREATE INDEX IF NOT EXISTS idx_prov_cat_sku ON proveedor_catalogo(sku_origen);

ALTER TABLE proveedor_catalogo ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "prov_cat_all" ON proveedor_catalogo FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Log de importaciones de proveedor
CREATE TABLE IF NOT EXISTS proveedor_imports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  proveedor text NOT NULL,
  archivo_nombre text,
  skus_total integer DEFAULT 0,
  skus_con_stock integer DEFAULT 0,
  skus_sin_stock integer DEFAULT 0,
  skus_nuevos integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE proveedor_imports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "prov_imp_all" ON proveedor_imports FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Historial de costos
CREATE TABLE IF NOT EXISTS costos_historial (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sku_origen text NOT NULL,
  costo_anterior numeric DEFAULT 0,
  costo_nuevo numeric DEFAULT 0,
  diferencia_pct numeric DEFAULT 0,
  fuente text DEFAULT 'lista_proveedor',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costos_hist_sku ON costos_historial(sku_origen);
CREATE INDEX IF NOT EXISTS idx_costos_hist_fecha ON costos_historial(created_at DESC);

ALTER TABLE costos_historial ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "costos_hist_all" ON costos_historial FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. ALTER ordenes_compra: agregar estados BORRADOR y ANULADA + columnas de cierre
-- Primero quitar el constraint existente y recrear con los nuevos estados
ALTER TABLE ordenes_compra DROP CONSTRAINT IF EXISTS ordenes_compra_estado_check;
ALTER TABLE ordenes_compra ADD CONSTRAINT ordenes_compra_estado_check
  CHECK (estado IN ('BORRADOR','PENDIENTE','EN_TRANSITO','RECIBIDA_PARCIAL','RECIBIDA','CERRADA','ANULADA'));

ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS lead_time_real integer;
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS total_recibido integer;
ALTER TABLE ordenes_compra ADD COLUMN IF NOT EXISTS pct_cumplimiento numeric;

-- 5. ALTER ordenes_compra_lineas: snapshot al pedir
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS abc text;
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS vel_ponderada numeric;
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS cob_total_al_pedir numeric;
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS stock_full_al_pedir integer;
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS stock_bodega_al_pedir integer;
ALTER TABLE ordenes_compra_lineas ADD COLUMN IF NOT EXISTS accion_al_pedir text;

-- 6. ALTER recepciones: vincular a OC
ALTER TABLE recepciones ADD COLUMN IF NOT EXISTS orden_compra_id uuid;

-- Índice para buscar recepciones por OC
CREATE INDEX IF NOT EXISTS idx_recepciones_oc ON recepciones(orden_compra_id) WHERE orden_compra_id IS NOT NULL;
