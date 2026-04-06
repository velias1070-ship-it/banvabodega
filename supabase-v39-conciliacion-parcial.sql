-- v39: Soporte para conciliación parcial de movimientos bancarios

-- 1. Agregar monto_conciliado a movimientos_banco
ALTER TABLE movimientos_banco ADD COLUMN IF NOT EXISTS monto_conciliado NUMERIC NOT NULL DEFAULT 0;

-- 2. Agregar monto_aplicado a conciliaciones
ALTER TABLE conciliaciones ADD COLUMN IF NOT EXISTS monto_aplicado NUMERIC;

-- 3. Backfill: conciliaciones existentes sin monto_aplicado = monto completo del movimiento
UPDATE conciliaciones c SET monto_aplicado = ABS((
  SELECT mb.monto FROM movimientos_banco mb WHERE mb.id = c.movimiento_banco_id
))
WHERE c.estado = 'confirmado'
  AND c.monto_aplicado IS NULL
  AND c.movimiento_banco_id IS NOT NULL;

-- 4. Backfill: movimientos conciliados → monto_conciliado = ABS(monto)
UPDATE movimientos_banco SET monto_conciliado = ABS(monto)
WHERE estado_conciliacion = 'conciliado' AND monto_conciliado = 0;
