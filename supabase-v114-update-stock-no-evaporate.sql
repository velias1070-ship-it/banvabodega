-- v114: Fix bug del RPC update_stock — branch sku_venta=NULL + salida ya no evapora excedente
--
-- BUG DOCUMENTADO (TXALMILLVIS46, mayo 2026):
-- Cuando se llamaba update_stock(p_sku_venta=NULL, p_delta=-40) y existía fila NULL con
-- cantidad=4, el GREATEST(0, cantidad + delta) dejaba la fila en 0 y RETURN.
-- Los 36 restantes se evaporaban sin descontarse de las filas con sku_venta especificado.
-- Resultado: el stock app quedaba inflado vs la realidad y vs el log de movimientos.
--
-- FIX:
-- - Descontar de la fila NULL solo lo que puede (LEAST(qty_null, ABS(delta)))
-- - Si queda excedente, NO retornar — caer al loop de distribución entre variantes
-- - El loop ya existía abajo, ahora también lo aprovecha este branch
--
-- IMPACTO:
-- - Salidas con sku_venta especificado: SIN CAMBIO
-- - Entradas (delta >= 0): SIN CAMBIO
-- - Salidas con sku_venta=NULL y fila NULL alcanza: SIN CAMBIO (mismo resultado)
-- - Salidas con sku_venta=NULL y fila NULL NO existe: SIN CAMBIO (loop ya se ejecutaba)
-- - Salidas con sku_venta=NULL y fila NULL NO alcanza: ANTES evaporaba, AHORA distribuye

CREATE OR REPLACE FUNCTION public.update_stock(p_sku text, p_posicion text, p_delta integer, p_sku_venta text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_remaining integer;
  v_row record;
  v_null_qty integer;
  v_to_deduct integer;
BEGIN
  -- Si se especifica sku_venta, comportamiento directo (sin cambio)
  IF p_sku_venta IS NOT NULL THEN
    INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
    VALUES (p_sku, p_posicion, GREATEST(0, p_delta), p_sku_venta, now())
    ON CONFLICT (sku, sku_venta_key, posicion_id)
    DO UPDATE SET
      cantidad = GREATEST(0, stock.cantidad + p_delta),
      updated_at = now();

    DELETE FROM stock
    WHERE sku = p_sku
      AND posicion_id = p_posicion
      AND COALESCE(sku_venta, '') = COALESCE(p_sku_venta, '')
      AND cantidad = 0;
    RETURN;
  END IF;

  -- p_sku_venta IS NULL: para entradas, insertar normalmente con NULL
  IF p_delta >= 0 THEN
    INSERT INTO stock (sku, posicion_id, cantidad, sku_venta, updated_at)
    VALUES (p_sku, p_posicion, GREATEST(0, p_delta), NULL, now())
    ON CONFLICT (sku, sku_venta_key, posicion_id)
    DO UPDATE SET
      cantidad = GREATEST(0, stock.cantidad + p_delta),
      updated_at = now();
    RETURN;
  END IF;

  -- p_sku_venta IS NULL y p_delta < 0 (salida):
  -- v114 FIX: descontar lo posible de la fila NULL, y si queda excedente,
  -- caer al loop de distribución (no return). Antes evaporaba silenciosamente.
  v_remaining := ABS(p_delta);

  SELECT cantidad INTO v_null_qty
  FROM stock
  WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad > 0
  FOR UPDATE;

  IF FOUND THEN
    v_to_deduct := LEAST(v_null_qty, v_remaining);
    UPDATE stock SET
      cantidad = cantidad - v_to_deduct,
      updated_at = now()
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL;

    DELETE FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad = 0;

    v_remaining := v_remaining - v_to_deduct;
    IF v_remaining <= 0 THEN RETURN; END IF;
    -- Si queda excedente, continúa al loop de distribución abajo (sin return)
  END IF;

  -- Distribuir excedente entre filas con sku_venta asignado (loop ya existía)
  FOR v_row IN
    SELECT id, cantidad, sku_venta
    FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad > 0
    ORDER BY cantidad DESC
    FOR UPDATE
  LOOP
    IF v_remaining <= 0 THEN EXIT; END IF;

    IF v_row.cantidad >= v_remaining THEN
      UPDATE stock SET
        cantidad = cantidad - v_remaining,
        updated_at = now()
      WHERE id = v_row.id;
      v_remaining := 0;
    ELSE
      v_remaining := v_remaining - v_row.cantidad;
      UPDATE stock SET cantidad = 0, updated_at = now() WHERE id = v_row.id;
    END IF;
  END LOOP;

  -- Si queda v_remaining > 0, significa que el stock total no alcanzaba para descontar
  -- la salida completa. Antes esto se silenciaba con GREATEST(0,...). Ahora lo loggeamos
  -- en NOTICE para que aparezca en logs de Supabase y se pueda detectar.
  IF v_remaining > 0 THEN
    RAISE NOTICE 'update_stock: % unidades sin descontar para sku=%, posicion=% (stock insuficiente)',
      v_remaining, p_sku, p_posicion;
  END IF;

  -- Limpiar filas con cantidad 0
  DELETE FROM stock
  WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad = 0;
END;
$function$;

COMMENT ON FUNCTION public.update_stock(text, text, integer, text) IS
  'v114: Salida con sku_venta=NULL ya no evapora excedente. Si fila NULL no alcanza, distribuye entre variantes via loop. Bug original: GREATEST(0, ...) absorbía silenciosamente.';
