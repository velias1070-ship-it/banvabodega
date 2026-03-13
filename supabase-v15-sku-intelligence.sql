-- ============================================
-- BANVA WMS — v15: Motor de Inteligencia de Inventario
-- ============================================
-- Tablas: sku_intelligence, sku_intelligence_history, eventos_demanda,
--         stock_full_cache, stock_snapshots, ordenes_compra, ordenes_compra_lineas
-- Campos nuevos en productos: lead_time_dias, moq, estado_sku, fecha_ultima_compra, fecha_primera_venta, notas_proveedor

-- =============================================================
-- 1. Tabla principal: sku_intelligence
-- =============================================================
CREATE TABLE IF NOT EXISTS sku_intelligence (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- ============ IDENTIDAD ============
  sku_origen text NOT NULL UNIQUE,
  nombre text,
  categoria text,
  proveedor text,
  skus_venta text[] DEFAULT '{}',

  -- ============ FORECAST / DEMANDA ============
  vel_7d numeric DEFAULT 0,
  vel_30d numeric DEFAULT 0,
  vel_60d numeric DEFAULT 0,
  vel_ponderada numeric DEFAULT 0,
  vel_full numeric DEFAULT 0,
  vel_flex numeric DEFAULT 0,
  vel_total numeric DEFAULT 0,
  pct_full numeric DEFAULT 1.0,
  pct_flex numeric DEFAULT 0.0,

  -- Tendencia
  tendencia_vel text DEFAULT 'estable',
  tendencia_vel_pct numeric DEFAULT 0,

  -- Picos y anomalías
  es_pico boolean DEFAULT false,
  pico_magnitud numeric DEFAULT 0,

  -- Estacionalidad
  multiplicador_evento numeric DEFAULT 1.0,
  evento_activo text,
  vel_ajustada_evento numeric DEFAULT 0,

  -- ============ STOCK ============
  stock_full integer DEFAULT 0,
  stock_bodega integer DEFAULT 0,
  stock_total integer DEFAULT 0,
  stock_sin_etiquetar integer DEFAULT 0,
  stock_proveedor integer DEFAULT -1,
  tiene_stock_prov boolean DEFAULT true,
  inner_pack integer DEFAULT 1,
  stock_en_transito integer DEFAULT 0,
  stock_proyectado integer DEFAULT 0,
  oc_pendientes integer DEFAULT 0,

  -- ============ COBERTURA (días) ============
  cob_full numeric DEFAULT 0,
  cob_flex numeric DEFAULT 0,
  cob_total numeric DEFAULT 0,
  target_dias_full numeric DEFAULT 40,

  -- ============ MARGEN (CLP por unidad) ============
  margen_full_7d numeric DEFAULT 0,
  margen_full_30d numeric DEFAULT 0,
  margen_full_60d numeric DEFAULT 0,
  margen_flex_7d numeric DEFAULT 0,
  margen_flex_30d numeric DEFAULT 0,
  margen_flex_60d numeric DEFAULT 0,
  margen_tendencia_full text DEFAULT 'estable',
  margen_tendencia_flex text DEFAULT 'estable',
  canal_mas_rentable text DEFAULT 'full',
  precio_promedio numeric DEFAULT 0,

  -- ============ CLASIFICACIÓN ABC-XYZ ============
  abc text DEFAULT 'C',
  ingreso_30d numeric DEFAULT 0,
  pct_ingreso_acumulado numeric DEFAULT 0,

  cv numeric DEFAULT 0,
  xyz text DEFAULT 'Z',
  desviacion_std numeric DEFAULT 0,

  cuadrante text DEFAULT 'REVISAR',

  -- ============ INDICADORES FINANCIEROS ============
  gmroi numeric DEFAULT 0,
  dio numeric DEFAULT 0,
  costo_neto numeric DEFAULT 0,
  costo_bruto numeric DEFAULT 0,
  costo_inventario_total numeric DEFAULT 0,

  -- ============ STOCK DE SEGURIDAD ============
  stock_seguridad numeric DEFAULT 0,
  punto_reorden numeric DEFAULT 0,
  nivel_servicio numeric DEFAULT 0.95,

  -- ============ OPORTUNIDAD PERDIDA ============
  dias_sin_stock_full integer DEFAULT 0,
  semanas_con_quiebre integer DEFAULT 0,
  venta_perdida_uds numeric DEFAULT 0,
  venta_perdida_pesos numeric DEFAULT 0,
  ingreso_perdido numeric DEFAULT 0,

  -- ============ REPOSICIÓN ============
  accion text DEFAULT 'OK',
  prioridad integer DEFAULT 99,
  mandar_full numeric DEFAULT 0,
  pedir_proveedor numeric DEFAULT 0,
  pedir_proveedor_bultos integer DEFAULT 0,
  requiere_ajuste_precio boolean DEFAULT false,

  -- ============ LIQUIDACIÓN ============
  liquidacion_accion text,
  liquidacion_dias_extra integer DEFAULT 0,
  liquidacion_descuento_sugerido numeric DEFAULT 0,

  -- ============ OPERACIÓN ============
  ultimo_conteo timestamptz,
  dias_sin_conteo integer DEFAULT 999,
  diferencias_conteo integer DEFAULT 0,
  ultimo_movimiento timestamptz,
  dias_sin_movimiento integer DEFAULT 999,

  -- ============ ALERTAS ============
  alertas text[] DEFAULT '{}',
  alertas_count integer DEFAULT 0,

  -- ============ METADATA ============
  updated_at timestamptz DEFAULT now(),
  datos_desde date,
  datos_hasta date
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_intel_sku ON sku_intelligence(sku_origen);
CREATE INDEX IF NOT EXISTS idx_sku_intel_accion ON sku_intelligence(accion);
CREATE INDEX IF NOT EXISTS idx_sku_intel_abc ON sku_intelligence(abc);
CREATE INDEX IF NOT EXISTS idx_sku_intel_prioridad ON sku_intelligence(prioridad);
CREATE INDEX IF NOT EXISTS idx_sku_intel_proveedor ON sku_intelligence(proveedor);
CREATE INDEX IF NOT EXISTS idx_sku_intel_cuadrante ON sku_intelligence(cuadrante);
CREATE INDEX IF NOT EXISTS idx_sku_intel_alertas ON sku_intelligence USING GIN(alertas);
CREATE INDEX IF NOT EXISTS idx_sku_intel_gmroi ON sku_intelligence(gmroi);
CREATE INDEX IF NOT EXISTS idx_sku_intel_liquidacion ON sku_intelligence(liquidacion_accion) WHERE liquidacion_accion IS NOT NULL;

ALTER TABLE sku_intelligence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sku_intel_all" ON sku_intelligence FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- 2. Snapshots históricos: sku_intelligence_history
-- =============================================================
CREATE TABLE IF NOT EXISTS sku_intelligence_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha date NOT NULL,
  sku_origen text NOT NULL,

  vel_ponderada numeric,
  vel_full numeric,
  vel_flex numeric,
  stock_full integer,
  stock_bodega integer,
  stock_total integer,
  cob_full numeric,
  cob_total numeric,
  margen_full numeric,
  margen_flex numeric,
  abc text,
  cuadrante text,
  gmroi numeric,
  dio numeric,
  accion text,
  alertas text[],
  venta_perdida_pesos numeric,

  created_at timestamptz DEFAULT now(),
  UNIQUE(fecha, sku_origen)
);

CREATE INDEX IF NOT EXISTS idx_sku_hist_fecha ON sku_intelligence_history(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_sku_hist_sku ON sku_intelligence_history(sku_origen, fecha DESC);

ALTER TABLE sku_intelligence_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sku_hist_all" ON sku_intelligence_history FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- 3. Eventos de demanda estacional
-- =============================================================
CREATE TABLE IF NOT EXISTS eventos_demanda (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre text NOT NULL,
  fecha_inicio date NOT NULL,
  fecha_fin date NOT NULL,
  fecha_prep_desde date NOT NULL,
  multiplicador numeric DEFAULT 2.0,
  categorias text[] DEFAULT '{}',
  notas text,
  activo boolean DEFAULT true,
  multiplicador_real numeric,
  evaluado boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE eventos_demanda ENABLE ROW LEVEL SECURITY;
CREATE POLICY "eventos_all" ON eventos_demanda FOR ALL USING (true) WITH CHECK (true);

-- Eventos Chile 2026
INSERT INTO eventos_demanda (nombre, fecha_inicio, fecha_fin, fecha_prep_desde, multiplicador, notas) VALUES
('Cyber Day Mayo', '2026-05-25', '2026-05-27', '2026-05-04', 2.5, 'Evento grande, afecta todo el catálogo'),
('Día de la Madre', '2026-05-10', '2026-05-10', '2026-04-26', 1.8, 'Textiles hogar buen regalo'),
('CyberMonday Octubre', '2026-10-05', '2026-10-07', '2026-09-14', 2.5, 'Segundo cyber del año'),
('Fiestas Patrias', '2026-09-18', '2026-09-19', '2026-09-01', 1.3, 'Aumento leve en textiles'),
('Black Friday', '2026-11-27', '2026-11-27', '2026-11-09', 2.0, 'Cada vez más fuerte en Chile'),
('Navidad', '2026-12-25', '2026-12-25', '2026-12-01', 2.0, 'Regalos, toallas y sábanas suben'),
('Rebajas Año Nuevo', '2026-12-26', '2027-01-05', '2026-12-20', 1.5, 'Liquidaciones post navidad');

-- =============================================================
-- 4. Cache de stock Full (server-side, reemplaza localStorage)
-- =============================================================
CREATE TABLE IF NOT EXISTS stock_full_cache (
  sku_venta text PRIMARY KEY,
  cantidad integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE stock_full_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sfc_all" ON stock_full_cache FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- 5. Snapshots diarios de stock (registro de quiebres)
-- =============================================================
CREATE TABLE IF NOT EXISTS stock_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha date NOT NULL,
  sku_origen text NOT NULL,
  stock_full integer DEFAULT 0,
  stock_bodega integer DEFAULT 0,
  stock_total integer DEFAULT 0,
  en_quiebre_full boolean DEFAULT false,
  en_quiebre_bodega boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(fecha, sku_origen)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_fecha ON stock_snapshots(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_sku ON stock_snapshots(sku_origen, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_quiebre ON stock_snapshots(en_quiebre_full, fecha DESC);

ALTER TABLE stock_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "snapshots_all" ON stock_snapshots FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- 6. Campos nuevos en maestro de productos
-- =============================================================
ALTER TABLE productos ADD COLUMN IF NOT EXISTS lead_time_dias integer DEFAULT 7;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS moq integer DEFAULT 1;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS estado_sku text DEFAULT 'activo';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS fecha_ultima_compra timestamptz;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS fecha_primera_venta timestamptz;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS notas_proveedor text;

-- =============================================================
-- 7. Órdenes de compra
-- =============================================================
CREATE TABLE IF NOT EXISTS ordenes_compra (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  numero text NOT NULL,
  proveedor text NOT NULL,
  fecha_emision date NOT NULL DEFAULT CURRENT_DATE,
  fecha_esperada date,
  fecha_recepcion date,
  estado text DEFAULT 'PENDIENTE'
    CHECK (estado IN ('PENDIENTE', 'EN_TRANSITO', 'RECIBIDA_PARCIAL', 'RECIBIDA', 'CERRADA')),
  notas text,
  total_neto numeric DEFAULT 0,
  total_bruto numeric DEFAULT 0,
  recepcion_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oc_estado ON ordenes_compra(estado);
CREATE INDEX IF NOT EXISTS idx_oc_proveedor ON ordenes_compra(proveedor);
CREATE INDEX IF NOT EXISTS idx_oc_fecha ON ordenes_compra(fecha_emision DESC);

ALTER TABLE ordenes_compra ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oc_all" ON ordenes_compra FOR ALL USING (true) WITH CHECK (true);

-- =============================================================
-- 8. Líneas de órdenes de compra
-- =============================================================
CREATE TABLE IF NOT EXISTS ordenes_compra_lineas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  orden_id uuid NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  sku_origen text NOT NULL,
  nombre text,
  cantidad_pedida integer NOT NULL,
  cantidad_recibida integer DEFAULT 0,
  costo_unitario numeric NOT NULL,
  inner_pack integer DEFAULT 1,
  bultos integer DEFAULT 0,
  estado text DEFAULT 'PENDIENTE'
    CHECK (estado IN ('PENDIENTE', 'EN_TRANSITO', 'RECIBIDA_PARCIAL', 'RECIBIDA')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocl_orden ON ordenes_compra_lineas(orden_id);
CREATE INDEX IF NOT EXISTS idx_ocl_sku ON ordenes_compra_lineas(sku_origen);

ALTER TABLE ordenes_compra_lineas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ocl_all" ON ordenes_compra_lineas FOR ALL USING (true) WITH CHECK (true);
