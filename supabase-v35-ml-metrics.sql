-- ============================================
-- BANVA BODEGA — v35: Sistema de Métricas Mensuales ML
-- Tablas para recopilación mensual de métricas desde
-- MercadoLibre API: visitas, calidad, reviews, preguntas,
-- ads, reputación. Agregación por SKU/mes.
-- EJECUTAR EN: Supabase SQL Editor
-- ============================================

-- 1. Columnas nuevas en ml_config para Ads API
ALTER TABLE ml_config ADD COLUMN IF NOT EXISTS advertiser_id TEXT;
ALTER TABLE ml_config ADD COLUMN IF NOT EXISTS account_id TEXT;

-- 2. Control table: estado del sync (singleton)
CREATE TABLE IF NOT EXISTS ml_sync_estado (
  id TEXT PRIMARY KEY DEFAULT 'metrics',
  periodo TEXT NOT NULL DEFAULT '',
  fase TEXT NOT NULL DEFAULT 'idle',
  items_procesados INTEGER DEFAULT 0,
  items_total INTEGER DEFAULT 0,
  ultimo_item_idx INTEGER DEFAULT 0,
  error_msg TEXT,
  iniciado_at TIMESTAMPTZ,
  actualizado_at TIMESTAMPTZ DEFAULT NOW(),
  completado_at TIMESTAMPTZ
);

ALTER TABLE ml_sync_estado ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sync_estado_all" ON ml_sync_estado FOR ALL USING (true) WITH CHECK (true);

-- Insertar fila singleton si no existe
INSERT INTO ml_sync_estado (id, periodo, fase)
VALUES ('metrics', '', 'idle')
ON CONFLICT (id) DO NOTHING;

-- 3. Tabla core: snapshot mensual por item
CREATE TABLE IF NOT EXISTS ml_snapshot_mensual (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sku_venta TEXT,
  sku_origen TEXT,
  titulo TEXT,

  -- Visitas (GET /items/visits)
  visitas INTEGER DEFAULT 0,

  -- Ventas (de orders_history)
  unidades_vendidas INTEGER DEFAULT 0,
  ingreso_bruto INTEGER DEFAULT 0,
  comisiones INTEGER DEFAULT 0,
  costo_envio_total INTEGER DEFAULT 0,
  ingreso_envio_total INTEGER DEFAULT 0,
  ingreso_neto INTEGER DEFAULT 0,

  -- Tasa de conversión
  cvr NUMERIC DEFAULT 0,

  -- Calidad / Performance (GET /items/{ID}/health)
  quality_score NUMERIC,
  quality_level TEXT,
  performance_data JSONB,

  -- Reviews (GET /reviews/item/{ID})
  reviews_promedio NUMERIC,
  reviews_total INTEGER DEFAULT 0,
  reviews_nuevas INTEGER DEFAULT 0,

  -- Preguntas (GET /questions/search?item={ID})
  preguntas_total INTEGER DEFAULT 0,
  preguntas_sin_responder INTEGER DEFAULT 0,

  -- Ads
  ads_activo BOOLEAN DEFAULT FALSE,
  ads_campaign_id TEXT,
  ads_campaign_name TEXT,
  ads_status TEXT,
  ads_daily_budget NUMERIC,
  ads_strategy TEXT,
  ads_clicks INTEGER DEFAULT 0,
  ads_prints INTEGER DEFAULT 0,
  ads_cost NUMERIC DEFAULT 0,
  ads_cpc NUMERIC DEFAULT 0,
  ads_ctr NUMERIC DEFAULT 0,
  ads_cvr NUMERIC DEFAULT 0,
  ads_acos NUMERIC DEFAULT 0,
  ads_roas NUMERIC DEFAULT 0,
  ads_sov NUMERIC DEFAULT 0,
  ads_impression_share NUMERIC DEFAULT 0,
  ads_top_impression_share NUMERIC DEFAULT 0,
  ads_lost_by_budget NUMERIC DEFAULT 0,
  ads_lost_by_rank NUMERIC DEFAULT 0,
  ads_acos_benchmark NUMERIC DEFAULT 0,
  ads_direct_amount NUMERIC DEFAULT 0,
  ads_indirect_amount NUMERIC DEFAULT 0,
  ads_total_amount NUMERIC DEFAULT 0,
  ads_direct_units INTEGER DEFAULT 0,
  ads_indirect_units INTEGER DEFAULT 0,
  ads_total_units INTEGER DEFAULT 0,
  ads_organic_units INTEGER DEFAULT 0,
  ads_organic_amount NUMERIC DEFAULT 0,

  -- Envíos (de orders_history)
  envios_flex INTEGER DEFAULT 0,
  envios_full INTEGER DEFAULT 0,
  costo_envio_promedio NUMERIC DEFAULT 0,

  -- Velocidad semanal (de sku_intelligence)
  vel_semanal NUMERIC DEFAULT 0,

  -- Stock al cierre (de sku_intelligence)
  stock_al_cierre INTEGER,
  cobertura_dias NUMERIC,

  -- Margen (de sku_intelligence)
  margen_unitario NUMERIC,
  abc TEXT,
  cuadrante TEXT,

  -- Item details (de ml_items_map / items API)
  status TEXT,
  listing_type TEXT,
  logistic_type TEXT,
  catalog_listing BOOLEAN DEFAULT FALSE,
  precio NUMERIC,
  precio_original NUMERIC,

  -- Prioridad calculada
  prioridad TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(periodo, item_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_mensual_periodo ON ml_snapshot_mensual(periodo);
CREATE INDEX IF NOT EXISTS idx_snapshot_mensual_item ON ml_snapshot_mensual(item_id, periodo);
CREATE INDEX IF NOT EXISTS idx_snapshot_mensual_sku ON ml_snapshot_mensual(sku_venta, periodo);
CREATE INDEX IF NOT EXISTS idx_snapshot_mensual_prioridad ON ml_snapshot_mensual(prioridad, periodo);

ALTER TABLE ml_snapshot_mensual ENABLE ROW LEVEL SECURITY;
CREATE POLICY "snapshot_mensual_all" ON ml_snapshot_mensual FOR ALL USING (true) WITH CHECK (true);

-- 4. Velocidad semanal
CREATE TABLE IF NOT EXISTS ml_velocidad_semanal (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id TEXT NOT NULL,
  sku_venta TEXT,
  semana_inicio DATE NOT NULL,
  unidades INTEGER DEFAULT 0,
  ingreso INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item_id, semana_inicio)
);

CREATE INDEX IF NOT EXISTS idx_vel_semanal_item ON ml_velocidad_semanal(item_id, semana_inicio);

ALTER TABLE ml_velocidad_semanal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vel_semanal_all" ON ml_velocidad_semanal FOR ALL USING (true) WITH CHECK (true);

-- 5. Acciones / optimizaciones
CREATE TABLE IF NOT EXISTS ml_acciones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id TEXT NOT NULL,
  sku_venta TEXT,
  periodo TEXT NOT NULL,
  tipo_accion TEXT NOT NULL,
  campo TEXT,
  valor_antes TEXT,
  valor_despues TEXT,
  notas TEXT,
  ejecutado_por TEXT DEFAULT 'manual',
  fecha TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_acciones_item ON ml_acciones(item_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_acciones_periodo ON ml_acciones(periodo);

ALTER TABLE ml_acciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "acciones_all" ON ml_acciones FOR ALL USING (true) WITH CHECK (true);

-- 6. Benchmarks por categoría
CREATE TABLE IF NOT EXISTS ml_benchmarks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo TEXT NOT NULL,
  categoria TEXT NOT NULL,
  items_count INTEGER DEFAULT 0,
  avg_visitas NUMERIC DEFAULT 0,
  avg_cvr NUMERIC DEFAULT 0,
  avg_unidades NUMERIC DEFAULT 0,
  avg_ingreso NUMERIC DEFAULT 0,
  avg_review_score NUMERIC,
  avg_quality_score NUMERIC,
  pct_con_ads NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(periodo, categoria)
);

ALTER TABLE ml_benchmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "benchmarks_all" ON ml_benchmarks FOR ALL USING (true) WITH CHECK (true);

-- 7. Resumen mensual global
CREATE TABLE IF NOT EXISTS ml_resumen_mensual (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo TEXT NOT NULL UNIQUE,
  items_activos INTEGER DEFAULT 0,
  items_inactivos INTEGER DEFAULT 0,
  visitas_total INTEGER DEFAULT 0,
  unidades_total INTEGER DEFAULT 0,
  ingreso_bruto_total INTEGER DEFAULT 0,
  ingreso_neto_total INTEGER DEFAULT 0,
  comisiones_total INTEGER DEFAULT 0,
  costo_envio_total INTEGER DEFAULT 0,
  cvr_promedio NUMERIC DEFAULT 0,
  review_promedio NUMERIC,
  quality_promedio NUMERIC,
  items_con_ads INTEGER DEFAULT 0,
  ads_inversion_total NUMERIC DEFAULT 0,
  ads_ingresos_total NUMERIC DEFAULT 0,
  items_sin_stock INTEGER DEFAULT 0,
  -- Conteo por prioridad
  pri_pausar_ads INTEGER DEFAULT 0,
  pri_reponer_stock INTEGER DEFAULT 0,
  pri_opt_ficha_urgente INTEGER DEFAULT 0,
  pri_opt_ficha INTEGER DEFAULT 0,
  pri_proteger_stock INTEGER DEFAULT 0,
  pri_proteger_winner INTEGER DEFAULT 0,
  pri_monitorear INTEGER DEFAULT 0,
  -- Reputación vendedor (snapshot)
  reputacion_level TEXT,
  reputacion_power_seller TEXT,
  reputacion_completadas INTEGER,
  reputacion_canceladas INTEGER,
  reputacion_pct_positivas NUMERIC,
  reputacion_pct_negativas NUMERIC,
  reputacion_reclamos NUMERIC,
  reputacion_demoras NUMERIC,
  reputacion_cancelaciones NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE ml_resumen_mensual ENABLE ROW LEVEL SECURITY;
CREATE POLICY "resumen_mensual_all" ON ml_resumen_mensual FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- VIEWS
-- ============================================

-- V1: Evolución de un SKU a lo largo de los meses
CREATE OR REPLACE VIEW v_evolucion_sku AS
SELECT
  sm.sku_venta,
  sm.sku_origen,
  sm.titulo,
  sm.periodo,
  sm.visitas,
  sm.unidades_vendidas,
  sm.ingreso_bruto,
  sm.ingreso_neto,
  sm.cvr,
  sm.quality_score,
  sm.quality_level,
  sm.reviews_promedio,
  sm.reviews_total,
  sm.preguntas_total,
  sm.preguntas_sin_responder,
  sm.ads_activo,
  sm.ads_acos,
  sm.ads_roas,
  sm.ads_cost,
  sm.vel_semanal,
  sm.stock_al_cierre,
  sm.cobertura_dias,
  sm.margen_unitario,
  sm.abc,
  sm.cuadrante,
  sm.prioridad
FROM ml_snapshot_mensual sm
ORDER BY sm.sku_venta, sm.periodo;

-- V2: SKUs que mejoraron vs mes anterior
CREATE OR REPLACE VIEW v_skus_mejoraron AS
SELECT
  curr.sku_venta,
  curr.titulo,
  curr.periodo AS periodo_actual,
  prev.periodo AS periodo_anterior,
  curr.unidades_vendidas AS uds_actual,
  prev.unidades_vendidas AS uds_anterior,
  curr.unidades_vendidas - COALESCE(prev.unidades_vendidas, 0) AS delta_uds,
  curr.cvr AS cvr_actual,
  prev.cvr AS cvr_anterior,
  ROUND(curr.cvr - COALESCE(prev.cvr, 0), 2) AS delta_cvr,
  curr.ingreso_neto AS ingreso_actual,
  prev.ingreso_neto AS ingreso_anterior,
  curr.ingreso_neto - COALESCE(prev.ingreso_neto, 0) AS delta_ingreso,
  curr.reviews_promedio AS review_actual,
  prev.reviews_promedio AS review_anterior,
  curr.quality_score AS quality_actual,
  prev.quality_score AS quality_anterior,
  curr.prioridad
FROM ml_snapshot_mensual curr
LEFT JOIN ml_snapshot_mensual prev
  ON curr.item_id = prev.item_id
  AND prev.periodo = TO_CHAR(TO_DATE(curr.periodo || '-01', 'YYYY-MM-DD') - INTERVAL '1 month', 'YYYY-MM')
WHERE
  curr.unidades_vendidas > COALESCE(prev.unidades_vendidas, 0)
  OR curr.cvr > COALESCE(prev.cvr, 0)
ORDER BY (curr.unidades_vendidas - COALESCE(prev.unidades_vendidas, 0)) DESC;

-- V3: Tendencia mensual global
CREATE OR REPLACE VIEW v_tendencia_mensual AS
SELECT
  periodo,
  items_activos,
  visitas_total,
  unidades_total,
  ingreso_bruto_total,
  ingreso_neto_total,
  cvr_promedio,
  review_promedio,
  quality_promedio,
  items_con_ads,
  ads_inversion_total,
  ads_ingresos_total,
  items_sin_stock,
  reputacion_level,
  reputacion_power_seller
FROM ml_resumen_mensual
ORDER BY periodo;

-- V4: Impacto de acciones de optimización
CREATE OR REPLACE VIEW v_impacto_acciones AS
SELECT
  a.id AS accion_id,
  a.item_id,
  a.sku_venta,
  a.tipo_accion,
  a.campo,
  a.valor_antes,
  a.valor_despues,
  a.notas,
  a.ejecutado_por,
  a.fecha AS fecha_accion,
  a.periodo AS periodo_accion,
  sm_antes.visitas AS visitas_antes,
  sm_despues.visitas AS visitas_despues,
  sm_antes.cvr AS cvr_antes,
  sm_despues.cvr AS cvr_despues,
  sm_antes.unidades_vendidas AS uds_antes,
  sm_despues.unidades_vendidas AS uds_despues,
  sm_despues.unidades_vendidas - COALESCE(sm_antes.unidades_vendidas, 0) AS delta_uds,
  ROUND(sm_despues.cvr - COALESCE(sm_antes.cvr, 0), 2) AS delta_cvr,
  sm_antes.ads_acos AS acos_antes,
  sm_despues.ads_acos AS acos_despues
FROM ml_acciones a
LEFT JOIN ml_snapshot_mensual sm_antes
  ON a.item_id = sm_antes.item_id AND a.periodo = sm_antes.periodo
LEFT JOIN ml_snapshot_mensual sm_despues
  ON a.item_id = sm_despues.item_id
  AND sm_despues.periodo = TO_CHAR(TO_DATE(a.periodo || '-01', 'YYYY-MM-DD') + INTERVAL '1 month', 'YYYY-MM')
ORDER BY a.fecha DESC;

-- ============================================
-- FIN v35
-- ============================================
