-- v71: transferir_stock hereda sku_venta del origen
--
-- Bug: la RPC transferir_stock pasaba NULL como p_sku_venta en ambas patas
-- (salida + entrada). Resultado: el stock etiquetado se desetiquetaba al
-- transferir entre posiciones.
--
-- Fix: leer el/los sku_venta presentes en la posición origen y hacer un loop
-- proporcional. Si origen tiene stock mixto (varias variantes), consume por
-- orden de cantidad DESC y etiqueta cada pata con el sku_venta correspondiente.
--
-- Regla 5 de inventory-policy.md (fuente canónica única de sku_venta por fila).

CREATE OR REPLACE FUNCTION public.transferir_stock(
  p_sku text,
  p_pos_origen text,
  p_pos_destino text,
  p_cantidad integer,
  p_operario text DEFAULT 'Admin'::text
)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  v_restante integer := p_cantidad;
  v_row record;
  v_take integer;
  v_total_origen integer;
BEGIN
  IF p_cantidad <= 0 THEN
    RAISE EXCEPTION 'transferir_stock: cantidad debe ser > 0 (recibido %)', p_cantidad;
  END IF;

  SELECT COALESCE(SUM(cantidad), 0) INTO v_total_origen
  FROM stock
  WHERE sku = p_sku AND posicion_id = p_pos_origen;

  IF v_total_origen < p_cantidad THEN
    RAISE EXCEPTION 'transferir_stock: stock insuficiente en % (hay %, pide %)',
      p_pos_origen, v_total_origen, p_cantidad;
  END IF;

  -- Consumir del origen por filas (cantidad DESC), preservando sku_venta por pata.
  FOR v_row IN
    SELECT sku_venta, cantidad
    FROM stock
    WHERE sku = p_sku AND posicion_id = p_pos_origen AND cantidad > 0
    ORDER BY cantidad DESC, sku_venta NULLS LAST
  LOOP
    EXIT WHEN v_restante <= 0;
    v_take := LEAST(v_row.cantidad, v_restante);

    PERFORM registrar_movimiento_stock(
      p_sku, p_pos_origen, -v_take, 'salida',
      v_row.sku_venta, 'transferencia_out', p_operario,
      'Transferencia → ' || p_pos_destino ||
        CASE WHEN v_row.sku_venta IS NOT NULL THEN ' [' || v_row.sku_venta || ']' ELSE '' END
    );

    PERFORM registrar_movimiento_stock(
      p_sku, p_pos_destino, v_take, 'entrada',
      v_row.sku_venta, 'transferencia_in', p_operario,
      'Transferencia ← ' || p_pos_origen ||
        CASE WHEN v_row.sku_venta IS NOT NULL THEN ' [' || v_row.sku_venta || ']' ELSE '' END
    );

    v_restante := v_restante - v_take;
  END LOOP;

  IF v_restante > 0 THEN
    RAISE EXCEPTION 'transferir_stock: no se pudo consumir toda la cantidad (restante %)', v_restante;
  END IF;

  RETURN TRUE;
END;
$function$;
