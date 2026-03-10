-- v13: Fix update_stock para manejar sku_venta NULL cuando hay variantes con sku_venta asignado
-- Problema: cuando se llama update_stock(sku, pos, delta) sin sku_venta (NULL),
-- la RPC no encuentra la fila existente que tiene sku_venta = 'LA-BIB-9' (u otro),
-- porque el ON CONFLICT busca sku_venta_key = '' en vez de 'LA-BIB-9'.
-- Fix: Si p_sku_venta es NULL y no existe fila con sku_venta NULL, pero SÍ existen
-- filas con sku_venta asignado, distribuir el delta entre esas filas.

CREATE OR REPLACE FUNCTION update_stock(p_sku text, p_posicion text, p_delta integer, p_sku_venta text DEFAULT NULL)
RETURNS void AS $$
DECLARE
  v_remaining integer;
  v_row record;
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
  -- Primero intentar decrementar fila con sku_venta NULL
  -- Si no existe, distribuir entre filas con sku_venta asignado
  IF EXISTS (
    SELECT 1 FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad > 0
  ) THEN
    UPDATE stock SET
      cantidad = GREATEST(0, cantidad + p_delta),
      updated_at = now()
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL;

    DELETE FROM stock
    WHERE sku = p_sku AND posicion_id = p_posicion AND sku_venta IS NULL AND cantidad = 0;
    RETURN;
  END IF;

  -- No hay fila con sku_venta NULL — distribuir entre variantes existentes
  v_remaining := ABS(p_delta);
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

  -- Limpiar filas con cantidad 0
  DELETE FROM stock
  WHERE sku = p_sku AND posicion_id = p_posicion AND cantidad = 0;
END;
$$ LANGUAGE plpgsql;
