-- v51: forecast accuracy (PR1/3)
-- Medición de error del forecast vel_ponderada. Sin alertas ni UI (vienen en PR2 y PR3).

-- Snapshot semanal del forecast persistido cada lunes (audit trail del predictor).
-- origen='real'         → fila escrita por el cron los lunes con datos en vivo.
-- origen='reconstruido' → fila generada por backfill; en_quiebre obligatoriamente NULL
--                         porque stock_snapshots no tiene historia suficiente.
CREATE TABLE IF NOT EXISTS forecast_snapshots_semanales (
  sku_origen     text        NOT NULL,
  semana_inicio  date        NOT NULL,
  vel_ponderada  numeric     NOT NULL,
  vel_7d         numeric     NOT NULL,
  vel_30d        numeric     NOT NULL,
  vel_60d        numeric     NOT NULL,
  abc            text        NULL,
  xyz            text        NULL,
  en_quiebre     boolean     NULL,
  origen         text        NOT NULL CHECK (origen IN ('real','reconstruido')),
  creado_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_origen, semana_inicio)
);

CREATE INDEX IF NOT EXISTS idx_forecast_snap_semana
  ON forecast_snapshots_semanales(semana_inicio);

-- Métricas de accuracy por SKU y ventana (4, 8, 12 semanas).
CREATE TABLE IF NOT EXISTS forecast_accuracy (
  sku_origen         text        NOT NULL REFERENCES sku_intelligence(sku_origen) ON DELETE CASCADE,
  ventana_semanas    int         NOT NULL CHECK (ventana_semanas IN (4, 8, 12)),
  calculado_at       timestamptz NOT NULL DEFAULT now(),
  semanas_evaluadas  int         NOT NULL,
  semanas_excluidas  int         NOT NULL DEFAULT 0,
  wmape              numeric     NULL,
  bias               numeric     NULL,
  mad                numeric     NULL,
  tracking_signal    numeric     NULL,
  forecast_total     numeric     NOT NULL,
  actual_total       numeric     NOT NULL,
  es_confiable       boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (sku_origen, ventana_semanas, calculado_at)
);

CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_sku_ventana
  ON forecast_accuracy(sku_origen, ventana_semanas, calculado_at DESC);

-- RLS permisivo (convención del proyecto; la seguridad vive en que la anon key no escape).
ALTER TABLE forecast_snapshots_semanales ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_accuracy             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all" ON forecast_snapshots_semanales;
CREATE POLICY "allow_all" ON forecast_snapshots_semanales USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all" ON forecast_accuracy;
CREATE POLICY "allow_all" ON forecast_accuracy USING (true) WITH CHECK (true);
