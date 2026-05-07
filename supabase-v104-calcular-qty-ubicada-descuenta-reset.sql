-- v104 — fix calcular_qty_ubicada: descontar salidas con motivo=reset_linea
--
-- Antes: SUM(cantidad) WHERE tipo='entrada' AND motivo='recepcion'
--        → si una linea se reseteaba (genera salida -X) y luego se reubicaba,
--          qty_ubicada quedaba inflada (sumaba ambas entradas, no descontaba el reset).
--
-- Caso testigo: factura 530566, SKU ALPCMPRBO4060.
--   +5 entrada (5/5)  -5 reset_linea (7/5 17:05)  +15 entrada (7/5 17:06)
--   Stock real en A1-1 = 15. RPC viejo devolvia 20. RPC nuevo devuelve 15.

CREATE OR REPLACE FUNCTION public.calcular_qty_ubicada(p_recepcion_id uuid, p_sku text)
RETURNS integer
LANGUAGE sql
STABLE
AS $function$
    SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN cantidad ELSE -cantidad END), 0)::INTEGER
    FROM movimientos
    WHERE recepcion_id = p_recepcion_id
      AND sku = p_sku
      AND (
        (tipo = 'entrada' AND motivo = 'recepcion')
        OR
        (tipo = 'salida' AND motivo = 'reset_linea')
      );
$function$;
