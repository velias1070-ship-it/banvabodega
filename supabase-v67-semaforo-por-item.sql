-- v67: Semaforo por item_id (publicacion ML)
-- Antes: 1 fila por sku_origen. Aggregaba 2+ publicaciones en una sola.
-- Ahora: 1 fila por item_id. Cada publicacion ML tiene su propia cubeta,
-- precio, stock visible y metricas de marketing (visitas, cvr, ads).
-- sku_origen queda como atributo para backlinking y metricas compartidas.

-- Cambio de PK: de (sku_origen, semana_calculo) a (item_id, semana_calculo)
-- Drop old table data (semaforo es snapshot semanal — se regenera con refresh)
DROP TABLE IF EXISTS semaforo_semanal CASCADE;

CREATE TABLE semaforo_semanal (
  -- Identidad
  item_id text NOT NULL,
  sku_venta text NOT NULL,
  sku_origen text NOT NULL,
  nombre text,
  titulo text,
  thumbnail text,
  permalink text,
  semana_calculo date NOT NULL,

  -- Velocidades (por publicacion, unidades fisicas ya multiplicadas por pack)
  vel_7d numeric DEFAULT 0,
  vel_30d numeric DEFAULT 0,
  vel_60d numeric DEFAULT 0,
  vel_ponderada numeric DEFAULT 0,
  unidades_pack integer DEFAULT 1,

  -- Stock (por publicacion en su canal)
  stock_full integer DEFAULT 0,
  stock_flex integer DEFAULT 0,
  stock_bodega_compartido integer DEFAULT 0,
  stock_total integer DEFAULT 0,
  cob_total numeric DEFAULT 0,
  cob_full numeric DEFAULT 0,

  -- Tiempo / actividad
  dias_sin_venta integer DEFAULT 999,

  -- Margen (a nivel sku_origen, compartido)
  margen_full_30d numeric DEFAULT 0,
  margen_flex_30d numeric DEFAULT 0,

  -- Precio (por publicacion)
  precio_actual numeric DEFAULT 0,
  precio_promedio_30d numeric DEFAULT NULL,
  costo_promedio numeric DEFAULT 0,

  -- Clasificacion
  cuadrante text,
  abc_ingreso text,
  cubeta text NOT NULL,
  antiguedad_muerto_bucket text,
  es_holdout boolean DEFAULT false,

  -- Impacto financiero
  impacto_clp numeric DEFAULT 0,

  -- Markdown sugerido
  precio_markdown_sugerido numeric DEFAULT NULL,
  markdown_motivo text DEFAULT NULL,

  -- Bridge con sku_intelligence (nivel sku_origen, compartido entre pubs)
  accion text,
  alertas jsonb DEFAULT '[]'::jsonb,
  dias_sin_stock_full integer,
  venta_perdida_pesos numeric DEFAULT 0,
  ingreso_perdido numeric DEFAULT 0,
  liquidacion_accion text,
  liquidacion_descuento_sugerido numeric,
  factor_rampup_aplicado numeric DEFAULT 1,
  rampup_motivo text,
  vel_pre_quiebre numeric DEFAULT 0,
  dias_en_quiebre integer DEFAULT 0,
  tendencia_vel text,
  tendencia_vel_pct numeric DEFAULT 0,

  -- Marketing / performance (por publicacion, de ml_snapshot_mensual)
  visitas_30d integer DEFAULT 0,
  cvr_30d numeric DEFAULT 0,
  ads_activo boolean DEFAULT false,
  ads_cost_30d numeric DEFAULT 0,
  ads_roas_30d numeric DEFAULT 0,
  quality_score numeric DEFAULT NULL,
  status_ml text,

  -- Metadatos
  cantidad_publicaciones_ml integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),

  PRIMARY KEY (item_id, semana_calculo)
);

CREATE INDEX idx_semaforo_cubeta ON semaforo_semanal(cubeta);
CREATE INDEX idx_semaforo_sku_origen ON semaforo_semanal(sku_origen);
CREATE INDEX idx_semaforo_impacto ON semaforo_semanal(impacto_clp DESC);
CREATE INDEX idx_semaforo_semana ON semaforo_semanal(semana_calculo);
CREATE INDEX idx_semaforo_cuadrante ON semaforo_semanal(cuadrante);

ALTER TABLE semaforo_semanal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "semaforo_semanal_all" ON semaforo_semanal FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE semaforo_semanal IS
  'Snapshot semanal del semaforo. Grano: una fila por publicacion ML (item_id) por semana. Cada publicacion tiene su propia cubeta y metricas; los atributos de sku_origen (venta_perdida, rampup, etc) son compartidos entre publicaciones del mismo sku_origen.';
