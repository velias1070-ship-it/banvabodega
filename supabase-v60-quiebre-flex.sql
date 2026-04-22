-- v60: paridad de tracking Flex con Full (rollback de flag flex_objetivo en v59).
--
-- Full ya tenia snapshot historico (en_quiebre_full), contador ancla
-- (dias_en_quiebre + fecha_entrada_quiebre) y velocidad pre-quiebre.
-- Flex solo tenia deteccion en tiempo real (publicar_flex === 0) sin
-- historia ni contador. Esta migracion suma la paridad.
--
-- Deteccion (codigo): en_quiebre_flex = publicar_flex === 0 && max(vel_flex, vel_flex_pre_quiebre) > 0
-- Politica: Flex es universal como Full tras el rollback de v59 (sin flag opt-in).

ALTER TABLE stock_snapshots
  ADD COLUMN IF NOT EXISTS en_quiebre_flex boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS publicar_flex integer;

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS dias_en_quiebre_flex integer,
  ADD COLUMN IF NOT EXISTS fecha_entrada_quiebre_flex date,
  ADD COLUMN IF NOT EXISTS vel_flex_pre_quiebre numeric DEFAULT 0;

COMMENT ON COLUMN stock_snapshots.en_quiebre_flex IS 'v60: publicar_flex=0 con historial de vel_flex > 0.';
COMMENT ON COLUMN stock_snapshots.publicar_flex IS 'v60: uds publicables floor((bodega-buffer)/inner_pack) para trazabilidad.';
COMMENT ON COLUMN sku_intelligence.dias_en_quiebre_flex IS 'v60: dias desde fecha_entrada_quiebre_flex. NULL si no esta en quiebre Flex.';
COMMENT ON COLUMN sku_intelligence.fecha_entrada_quiebre_flex IS 'v60: ancla temporal del quiebre Flex. ISO YYYY-MM-DD UTC.';
COMMENT ON COLUMN sku_intelligence.vel_flex_pre_quiebre IS 'v60: snapshot de vel_flex al entrar en quiebre Flex.';
