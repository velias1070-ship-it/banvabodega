-- v96: Estado de Resultados devengado
--
-- Permite que el EERR refleje gastos en el mes que corresponden contablemente
-- (servicio devengado), no en el mes de la factura ni del pago.
--
-- Dos niveles de control:
--   1. plan_cuentas.regla_devengo: regla por cuenta (mes_actual | mes_anterior).
--      Útil para gastos con desfase fijo conocido (F29, sueldos, arriendo
--      post-pagado, servicios facturados a inicio de mes siguiente).
--   2. movimientos_banco.periodo_devengo / rcv_compras.periodo_devengo:
--      override manual por movimiento individual (formato YYYYMM).
--
-- Resolución en UI: override > regla > derivado de fecha.

-- ============ PLAN DE CUENTAS: regla por defecto ============
ALTER TABLE plan_cuentas
  ADD COLUMN IF NOT EXISTS regla_devengo TEXT NOT NULL DEFAULT 'mes_actual'
  CHECK (regla_devengo IN ('mes_actual', 'mes_anterior'));

COMMENT ON COLUMN plan_cuentas.regla_devengo IS
  'Cómo asignar el periodo contable de un movimiento categorizado a esta cuenta. mes_actual=mes de la fecha, mes_anterior=el anterior (típico F29, IVA, gastos post-pagados).';

-- ============ MOVIMIENTOS BANCO: override manual ============
ALTER TABLE movimientos_banco
  ADD COLUMN IF NOT EXISTS periodo_devengo TEXT
  CHECK (periodo_devengo IS NULL OR periodo_devengo ~ '^[0-9]{6}$');

COMMENT ON COLUMN movimientos_banco.periodo_devengo IS
  'Override manual del periodo contable (YYYYMM). NULL = usar regla_devengo de la cuenta o mes de la fecha.';

CREATE INDEX IF NOT EXISTS idx_movimientos_banco_periodo_devengo
  ON movimientos_banco(empresa_id, periodo_devengo)
  WHERE periodo_devengo IS NOT NULL;

-- ============ RCV COMPRAS: override manual ============
ALTER TABLE rcv_compras
  ADD COLUMN IF NOT EXISTS periodo_devengo TEXT
  CHECK (periodo_devengo IS NULL OR periodo_devengo ~ '^[0-9]{6}$');

COMMENT ON COLUMN rcv_compras.periodo_devengo IS
  'Override manual del periodo contable (YYYYMM). NULL = usar regla_devengo de la cuenta del proveedor o periodo del documento.';

CREATE INDEX IF NOT EXISTS idx_rcv_compras_periodo_devengo
  ON rcv_compras(empresa_id, periodo_devengo)
  WHERE periodo_devengo IS NOT NULL;

-- ============ DEFAULTS CONOCIDOS ============
-- Formulario F29: el pago de día 12 corresponde al periodo cerrado mes anterior.
UPDATE plan_cuentas
  SET regla_devengo = 'mes_anterior'
  WHERE codigo = '7.1.02.01';
