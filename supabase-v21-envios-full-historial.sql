-- v21: Historial de envíos a Full desde Inteligencia
-- Ejecutar en Supabase SQL Editor

-- 1. Tabla cabecera: un registro por envío creado
CREATE TABLE IF NOT EXISTS envios_full_historial (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  picking_session_id uuid,
  fecha date NOT NULL DEFAULT CURRENT_DATE,

  -- Totales del envío
  total_skus integer NOT NULL,
  total_uds_venta integer NOT NULL,
  total_uds_fisicas integer NOT NULL,
  total_bultos integer NOT NULL,

  -- Contexto al momento del envío
  evento_activo text,
  multiplicador_evento numeric DEFAULT 1.0,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_envios_fecha ON envios_full_historial(fecha DESC);

ALTER TABLE envios_full_historial ENABLE ROW LEVEL SECURITY;
CREATE POLICY "envios_hist_all" ON envios_full_historial FOR ALL USING (true) WITH CHECK (true);

-- 2. Tabla detalle: snapshot de cada SKU al momento de enviar
CREATE TABLE IF NOT EXISTS envios_full_lineas (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  envio_id uuid NOT NULL REFERENCES envios_full_historial(id),
  sku_venta text NOT NULL,
  sku_origen text NOT NULL,

  -- Cantidades
  cantidad_sugerida integer NOT NULL,
  cantidad_enviada integer NOT NULL,
  fue_editada boolean DEFAULT false,

  -- Snapshot del estado al momento de enviar
  abc text,
  vel_ponderada numeric,
  vel_objetivo numeric,
  stock_full_antes integer,
  stock_bodega_antes integer,
  cob_full_antes numeric,
  target_dias numeric,
  margen_full numeric,
  inner_pack integer,
  redondeo text,

  -- Alertas activas al momento
  alertas text[],
  nota text,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_envios_lineas_sku ON envios_full_lineas(sku_venta, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_envios_lineas_envio ON envios_full_lineas(envio_id);

ALTER TABLE envios_full_lineas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "envios_lineas_all" ON envios_full_lineas FOR ALL USING (true) WITH CHECK (true);
