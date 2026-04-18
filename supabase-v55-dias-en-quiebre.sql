-- v55: fecha_entrada_quiebre como ancla temporal (PR5)
--
-- El campo `dias_en_quiebre` hoy se incrementaba +1 por cada recálculo del
-- motor, no por día calendario. Con ~80 recálculos/día llegaba a valores
-- absurdos (máx observado: 2 071 días, 5.7 años). Ese valor se propagaba a
-- la matriz de ramp-up post-quiebre (rampup.ts) y dejaba pedir_proveedor=0
-- para SKUs que tenían proveedor disponible.
--
-- Fix: persistir la fecha de entrada a quiebre y derivar `dias_en_quiebre`
-- como diferencia en días UTC. Idempotente ante múltiples recálculos.
--
-- - fecha_entrada_quiebre = NULL cuando el SKU NO está en quiebre ahora.
-- - fecha_entrada_quiebre = día UTC del primer recálculo en quiebre
--   (o min(stock_snapshots.fecha) con en_quiebre_full=true si hay historia).
-- - Durante el quiebre, NO se modifica entre recálculos.
-- - Al reponer, se pone a NULL y dias_en_quiebre a 0.

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS fecha_entrada_quiebre date NULL;

COMMENT ON COLUMN sku_intelligence.fecha_entrada_quiebre IS
  'PR5: ancla temporal para calcular dias_en_quiebre. UTC. NULL si el SKU no está en quiebre.';

CREATE INDEX IF NOT EXISTS idx_sku_intel_fecha_entrada_quiebre
  ON sku_intelligence(fecha_entrada_quiebre)
  WHERE fecha_entrada_quiebre IS NOT NULL;
