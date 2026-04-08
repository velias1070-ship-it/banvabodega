-- v41: Semaforo Semanal BANVA
-- Sistema de triage semanal de SKUs por cubeta (velocidad x stock)

-- 1. Tabla principal del semaforo (reemplaza vista materializada)
CREATE TABLE IF NOT EXISTS semaforo_semanal (
  sku_origen text NOT NULL,
  nombre text,
  item_id text,
  thumbnail text,
  permalink text,
  vel_7d numeric DEFAULT 0,
  vel_30d numeric DEFAULT 0,
  vel_60d numeric DEFAULT 0,
  vel_ponderada numeric DEFAULT 0,
  stock_total integer DEFAULT 0,
  stock_full integer DEFAULT 0,
  stock_bodega integer DEFAULT 0,
  cob_total numeric DEFAULT 0,
  cob_full numeric DEFAULT 0,
  dias_sin_venta integer DEFAULT 999,
  margen_full_30d numeric DEFAULT 0,
  margen_flex_30d numeric DEFAULT 0,
  cuadrante text,
  precio_actual numeric DEFAULT 0,
  costo_promedio numeric DEFAULT 0,
  cantidad_publicaciones_ml integer DEFAULT 0,
  cubeta text NOT NULL,
  antiguedad_muerto_bucket text,
  impacto_clp numeric DEFAULT 0,
  es_holdout boolean DEFAULT false,
  semana_calculo date NOT NULL,
  PRIMARY KEY (sku_origen, semana_calculo)
);

CREATE INDEX IF NOT EXISTS idx_semaforo_cubeta ON semaforo_semanal(cubeta);
CREATE INDEX IF NOT EXISTS idx_semaforo_impacto ON semaforo_semanal(impacto_clp DESC);
CREATE INDEX IF NOT EXISTS idx_semaforo_semana ON semaforo_semanal(semana_calculo);

ALTER TABLE semaforo_semanal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "semaforo_semanal_all" ON semaforo_semanal FOR ALL USING (true) WITH CHECK (true);

-- 2. Config de umbrales (parametrizables sin redeploy)
CREATE TABLE IF NOT EXISTS semaforo_config (
  key text PRIMARY KEY,
  value numeric NOT NULL,
  descripcion text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE semaforo_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "semaforo_config_all" ON semaforo_config FOR ALL USING (true) WITH CHECK (true);

INSERT INTO semaforo_config VALUES
  ('cayo_factor_caida', 0.6, 'vel_7d debe ser < vel_30d * este factor'),
  ('cayo_vel_minima_base', 2, 'vel_30d minima para considerar caida'),
  ('despegando_factor_alza', 1.4, 'vel_7d debe ser > vel_30d * este factor'),
  ('despegando_vel_minima', 3, 'vel_7d minima para considerar despegue'),
  ('quiebre_cobertura_dias', 14, 'cobertura maxima para quiebre inminente'),
  ('quiebre_vel_minima', 2, 'vel_30d minima para considerar quiebre real'),
  ('estancado_vel_maxima', 1, 'vel_30d maxima para estancado'),
  ('estancado_cobertura_minima', 56, 'cobertura minima para estancado (8 sem)'),
  ('muerto_dias_sin_venta', 60, 'dias sin venta para muerto'),
  ('holdout_porcentaje', 0.10, 'porcentaje del catalogo en holdout')
ON CONFLICT (key) DO NOTHING;

-- 3. Log de revisiones humanas
CREATE TABLE IF NOT EXISTS sku_revision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_origen text NOT NULL,
  semana date NOT NULL,
  cubeta text NOT NULL,
  vel_7d_snapshot numeric,
  vel_30d_snapshot numeric,
  stock_snapshot integer,
  precio_snapshot numeric,
  impacto_clp_snapshot numeric,
  revisado_por text NOT NULL,
  revisado_at timestamptz NOT NULL DEFAULT now(),
  causa_identificada text NOT NULL,
  causa_detalle text,
  accion_tomada text NOT NULL,
  accion_detalle text,
  dias_desde_aparicion integer,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT causa_valida CHECK (causa_identificada IN (
    'precio_propio_alto',
    'precio_competencia_bajo',
    'foto_o_titulo_debil',
    'stock_quiebre_o_full_vacio',
    'salio_de_campana',
    'estacionalidad',
    'cambio_algoritmo_ml',
    'calidad_listado_basica',
    'producto_descontinuado',
    'otro',
    'no_identificada'
  )),
  CONSTRAINT accion_valida CHECK (accion_tomada IN (
    'bajar_precio',
    'subir_precio',
    'postular_campana',
    'mejorar_foto',
    'mejorar_titulo',
    'reposicion_urgente',
    'pausar_publicacion',
    'liquidar',
    'descontinuar',
    'aumentar_ads',
    'reducir_ads',
    'sin_accion_monitorear',
    'otro'
  ))
);

CREATE INDEX IF NOT EXISTS idx_revision_semana ON sku_revision_log(semana);
CREATE INDEX IF NOT EXISTS idx_revision_sku ON sku_revision_log(sku_origen);

ALTER TABLE sku_revision_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sku_revision_log_all" ON sku_revision_log FOR ALL USING (true) WITH CHECK (true);

-- 4. Snapshot semanal (tracking historico)
CREATE TABLE IF NOT EXISTS semaforo_snapshot_semanal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semana date NOT NULL UNIQUE,
  count_cayo integer DEFAULT 0,
  count_quiebre_inminente integer DEFAULT 0,
  count_ya_quebrado integer DEFAULT 0,
  count_despegando integer DEFAULT 0,
  count_estancado integer DEFAULT 0,
  count_muerto integer DEFAULT 0,
  count_normal integer DEFAULT 0,
  count_holdout integer DEFAULT 0,
  impacto_total_cayo numeric DEFAULT 0,
  impacto_total_quiebre numeric DEFAULT 0,
  impacto_total_estancado numeric DEFAULT 0,
  impacto_total_muerto numeric DEFAULT 0,
  unidades_semana integer,
  revenue_semana numeric,
  margen_semana numeric,
  delta_unidades_pct numeric,
  delta_revenue_pct numeric,
  delta_margen_pct numeric,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE semaforo_snapshot_semanal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "semaforo_snapshot_all" ON semaforo_snapshot_semanal FOR ALL USING (true) WITH CHECK (true);

-- 5. Holdout en sku_intelligence
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sku_intelligence' AND column_name='es_holdout') THEN
    ALTER TABLE sku_intelligence ADD COLUMN es_holdout boolean DEFAULT false;
    ALTER TABLE sku_intelligence ADD COLUMN holdout_asignado_at timestamptz;
  END IF;
END $$;

-- 6. Asignacion inicial de holdouts (10% estratificado por cuadrante)
WITH ranked AS (
  SELECT sku_origen, cuadrante,
         ROW_NUMBER() OVER (PARTITION BY cuadrante ORDER BY random()) as rn,
         COUNT(*) OVER (PARTITION BY cuadrante) as total
  FROM sku_intelligence
  WHERE (vel_ponderada > 0 OR stock_total > 0)
)
UPDATE sku_intelligence si
SET es_holdout = true,
    holdout_asignado_at = now()
FROM ranked r
WHERE si.sku_origen = r.sku_origen
AND r.rn <= CEIL(r.total * 0.10)
AND si.es_holdout = false;
