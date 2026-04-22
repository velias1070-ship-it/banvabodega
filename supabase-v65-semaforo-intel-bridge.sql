-- v65: Exponer campos de sku_intelligence en semaforo_semanal
-- El motor de inteligencia ya calcula estos datos. El semaforo ahora los
-- persiste para poder mostrarlos en la UI sin JOINs en runtime.

ALTER TABLE semaforo_semanal
  ADD COLUMN IF NOT EXISTS accion text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS alertas jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dias_sin_stock_full integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS venta_perdida_pesos numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ingreso_perdido numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidacion_accion text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS liquidacion_descuento_sugerido numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS factor_rampup_aplicado numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rampup_motivo text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS vel_pre_quiebre numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dias_en_quiebre integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abc_ingreso text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tendencia_vel text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tendencia_vel_pct numeric DEFAULT 0;

COMMENT ON COLUMN semaforo_semanal.accion IS
  'Accion recomendada por intelligence (REPOSICION|EXCESO|DEAD_STOCK|NUEVO|OK|...)';
COMMENT ON COLUMN semaforo_semanal.alertas IS
  'Array de alertas emitidas por intelligence (jsonb)';
COMMENT ON COLUMN semaforo_semanal.dias_sin_stock_full IS
  'Dias consecutivos con stock Full bajo o vacio (detecta cuasi-quiebre)';
COMMENT ON COLUMN semaforo_semanal.venta_perdida_pesos IS
  'Lost sales estimado en CLP por falta de stock';
COMMENT ON COLUMN semaforo_semanal.factor_rampup_aplicado IS
  'Factor 0-1 aplicado a reposicion durante recuperacion post-quiebre (1=normal)';
