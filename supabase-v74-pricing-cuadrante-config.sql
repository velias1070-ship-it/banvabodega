-- v74: pricing_cuadrante_config
-- Defaults de pricing por cuadrante BANVA. Override jerarquico: SKU > cuadrante > global.
-- Fuentes: BANVA_Pricing_Ajuste_Plan §5 (matriz por segmento) +
-- BANVA_Pricing_Investigacion_Comparada §6.2 (defaults por cuadrante con sub-tags ABC-XYZ).
--
-- Mapeo cuadrante codigo -> cuadrante manual:
--   ESTRELLA  -> Estrella
--   VOLUMEN   -> Crecimiento
--   CASHCOW   -> Rentabilidad
--   REVISAR   -> Dudoso/Interrogante
--   _DEFAULT  -> SKUs sin cuadrante asignado (fallback)

CREATE TABLE IF NOT EXISTS pricing_cuadrante_config (
  cuadrante              text PRIMARY KEY,
  margen_min_pct         numeric NOT NULL,
  politica_default       text NOT NULL,
  acos_objetivo_pct      numeric,
  descuento_max_pct      numeric,
  descuento_max_kvi_pct  numeric,
  canal_preferido        text,
  notas                  text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pricing_cuadrante_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pcc_select" ON pricing_cuadrante_config FOR SELECT USING (true);
CREATE POLICY "pcc_update" ON pricing_cuadrante_config FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "pcc_insert" ON pricing_cuadrante_config FOR INSERT WITH CHECK (true);
CREATE POLICY "pcc_delete" ON pricing_cuadrante_config FOR DELETE USING (true);

INSERT INTO pricing_cuadrante_config (cuadrante, margen_min_pct, politica_default, acos_objetivo_pct, descuento_max_pct, descuento_max_kvi_pct, canal_preferido, notas) VALUES
  ('ESTRELLA',  8,  'exprimir', 13, 10, 8,  'full',  'Alto vol + alto margen. Subir +3-5% si elasticidad <1. Cupon en evento, no price cut.'),
  ('VOLUMEN',   5,  'seguir',   18, 25, 15, 'mixto', 'Alto vol + bajo margen (Crecimiento). Match-lowest. Respeta valle muerte.'),
  ('CASHCOW',   20, 'defender', 7,  10, 8,  'flex',  'Bajo vol + alto margen (Rentabilidad). Estatico, value-based, +2-5% cada 6-8 sem.'),
  ('REVISAR',   0,  'liquidar', 5,  60, 30, 'flex',  'Dudoso/Interrogante. Liquidacion agresiva, sin floor estricto. ACOS minimo o pausar.'),
  ('_DEFAULT',  15, 'seguir',   12, 20, 10, 'mixto', 'Fallback global cuando cuadrante = NULL. Defaults conservadores.')
ON CONFLICT (cuadrante) DO NOTHING;

COMMENT ON TABLE pricing_cuadrante_config IS 'Defaults pricing por cuadrante BANVA. Override jerarquico: productos.<campo> > este registro > hardcoded.';
COMMENT ON COLUMN pricing_cuadrante_config.margen_min_pct IS 'Margen minimo neto post-fees.';
COMMENT ON COLUMN pricing_cuadrante_config.descuento_max_pct IS 'Tope % off lista permitido al postular promo.';
COMMENT ON COLUMN pricing_cuadrante_config.canal_preferido IS 'Canal preferente.';
