-- v115: Trigger invariante stock = log (versión NOTICE, no bloqueante)
--
-- OBJETIVO: detectar en tiempo real cualquier escritura a la tabla `stock`
-- que deje el total desincronizado con la suma del log de `movimientos`.
--
-- COMPORTAMIENTO:
-- - AFTER INSERT/UPDATE/DELETE en `stock`
-- - Calcula stock_total y log_neto del SKU afectado
-- - Si divergen, RAISE NOTICE (aparece en logs de Supabase pero no aborta)
-- - No bloquea operaciones — solo observa
--
-- POR QUÉ SOLO TRIGGER EN STOCK (no en movimientos):
-- El flow normal del RPC `registrar_movimiento_stock` hace:
--   1. INSERT movimientos
--   2. UPDATE stock (via update_stock)
-- Si pongo trigger en movimientos, dispara entre paso 1 y 2 → falso positivo.
-- Trigger en stock dispara solo en paso 2, cuando ambos deberían estar
-- sincronizados → cero ruido en flow normal.
--
-- LOS DIRECT WRITES A STOCK (setStock, deleteStockBySku, /api/debug-fix,
-- SQL manual) son lo más peligroso históricamente y este trigger los
-- detecta de inmediato.
--
-- Después de 1 semana de NOTICE, si los logs salen limpios, podemos
-- subir a versión ERROR (bloqueante) en v116.

CREATE OR REPLACE FUNCTION public.check_stock_log_invariant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  v_sku text;
  v_stock_total int;
  v_log_neto int;
  v_diff int;
BEGIN
  -- Tomar SKU de NEW (INSERT/UPDATE) o OLD (DELETE)
  v_sku := COALESCE(NEW.sku, OLD.sku);

  IF v_sku IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Calcular stock total y log neto para este SKU
  SELECT COALESCE(SUM(cantidad), 0) INTO v_stock_total
  FROM stock WHERE sku = v_sku;

  SELECT COALESCE(SUM(
    CASE
      WHEN tipo = 'entrada' THEN cantidad
      WHEN tipo = 'salida' THEN -cantidad
      ELSE 0
    END
  ), 0) INTO v_log_neto
  FROM movimientos WHERE sku = v_sku;

  v_diff := v_stock_total - v_log_neto;

  -- Si divergen, NOTICE (no bloquea)
  IF v_diff <> 0 THEN
    RAISE NOTICE 'INVARIANTE_STOCK_LOG sku=% stock=% log=% diff=% op=% tabla=%',
      v_sku, v_stock_total, v_log_neto, v_diff, TG_OP, TG_TABLE_NAME;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Drop existente si hay
DROP TRIGGER IF EXISTS trg_stock_invariant_check ON public.stock;

-- Crear trigger AFTER en stock
CREATE TRIGGER trg_stock_invariant_check
AFTER INSERT OR UPDATE OR DELETE ON public.stock
FOR EACH ROW
EXECUTE FUNCTION public.check_stock_log_invariant();

COMMENT ON FUNCTION public.check_stock_log_invariant() IS
  'v115: trigger NOTICE no-bloqueante. Detecta divergencia stock vs log neto en escrituras directas a stock.';
