-- v93: Sincronización automática de ordenes_compra_lineas.cantidad_recibida
--
-- Problema: el campo `ordenes_compra_lineas.cantidad_recibida` se queda en 0
-- (default) porque ni `cerrarOC` ni App Etiquetas lo escriben. La fuente real
-- de "cuánto se recibió" vive en `recepcion_lineas.qty_recibida` cruzado con
-- `recepciones.orden_compra_id`. El motor de inteligencia
-- (`intelligence-queries.ts:382-384`) lee el campo stale y calcula
-- `stock_en_transito = cantidad_pedida - cantidad_recibida` → sub-pedido en
-- `pedir_proveedor`. Caso testigo OC-005 SKU TXTPBL20200SK: pedido 60,
-- recibido 30, motor lo veía como 60 en tránsito.
--
-- Manual de referencia: docs/manuales/BANVA_Reposicion.md (precisión de
-- stock en tránsito como precondición de la decisión de pedido).
--
-- Antipatrón violado: Regla 5 de inventory-policy.md (fuentes duplicadas del
-- mismo dato). Aquí `recepcion_lineas.qty_recibida` es la canónica y
-- `ordenes_compra_lineas.cantidad_recibida` queda como cache derivada
-- mantenida por trigger (no por código aplicación).
--
-- Solución: trigger AFTER INSERT/UPDATE/DELETE en recepcion_lineas (y en
-- recepciones cuando cambia orden_compra_id) que recompute el campo como
-- SUM idempotente. Match case-insensitive sobre el SKU para reflejar la
-- lógica que ya usa AdminCompras.tsx.

CREATE OR REPLACE FUNCTION sync_ocl_cantidad_recibida(
  p_orden_id uuid,
  p_sku_origen text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_orden_id IS NULL OR p_sku_origen IS NULL THEN
    RETURN;
  END IF;

  UPDATE ordenes_compra_lineas ocl
  SET cantidad_recibida = COALESCE((
    SELECT SUM(rl.qty_recibida)
    FROM recepcion_lineas rl
    JOIN recepciones r ON r.id = rl.recepcion_id
    WHERE r.orden_compra_id = p_orden_id
      AND UPPER(rl.sku) = UPPER(p_sku_origen)
  ), 0)
  WHERE ocl.orden_id = p_orden_id
    AND UPPER(ocl.sku_origen) = UPPER(p_sku_origen);
END;
$$;

-- Trigger en recepcion_lineas: cualquier cambio recompute la línea de OC
-- afectada. La recepción puede no estar linkeada a OC (recepciones de App
-- Etiquetas sin OC origen) — en ese caso orden_compra_id es NULL y el SET
-- no encuentra fila para actualizar, lo cual es correcto.
CREATE OR REPLACE FUNCTION tg_recepcion_lineas_sync_ocl()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_orden_old uuid;
  v_orden_new uuid;
  v_sku_old text;
  v_sku_new text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    SELECT r.orden_compra_id INTO v_orden_old
    FROM recepciones r WHERE r.id = OLD.recepcion_id;
    v_sku_old := OLD.sku;
    PERFORM sync_ocl_cantidad_recibida(v_orden_old, v_sku_old);
    RETURN OLD;
  END IF;

  -- INSERT o UPDATE
  SELECT r.orden_compra_id INTO v_orden_new
  FROM recepciones r WHERE r.id = NEW.recepcion_id;
  v_sku_new := NEW.sku;
  PERFORM sync_ocl_cantidad_recibida(v_orden_new, v_sku_new);

  -- Si en UPDATE cambió el sku o cambió de recepción, también recalcular el
  -- combo viejo (de lo contrario quedaría inflado).
  IF (TG_OP = 'UPDATE') THEN
    IF OLD.recepcion_id <> NEW.recepcion_id THEN
      SELECT r.orden_compra_id INTO v_orden_old
      FROM recepciones r WHERE r.id = OLD.recepcion_id;
    ELSE
      v_orden_old := v_orden_new;
    END IF;
    v_sku_old := OLD.sku;
    IF v_orden_old IS DISTINCT FROM v_orden_new
       OR UPPER(COALESCE(v_sku_old,'')) <> UPPER(COALESCE(v_sku_new,'')) THEN
      PERFORM sync_ocl_cantidad_recibida(v_orden_old, v_sku_old);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recepcion_lineas_sync_ocl ON recepcion_lineas;
CREATE TRIGGER trg_recepcion_lineas_sync_ocl
AFTER INSERT OR UPDATE OR DELETE ON recepcion_lineas
FOR EACH ROW EXECUTE FUNCTION tg_recepcion_lineas_sync_ocl();

-- Trigger en recepciones: si cambia orden_compra_id (link/unlink/relink),
-- todas las líneas de esa recepción cambian de OC. Recalcular el (orden, sku)
-- viejo y nuevo para cada línea de la recepción.
CREATE OR REPLACE FUNCTION tg_recepciones_sync_ocl()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rl_record RECORD;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    -- Recepción recién creada todavía no tiene líneas; el insert de líneas
    -- dispara el otro trigger. No hay nada que recalcular acá.
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    FOR rl_record IN
      SELECT sku FROM recepcion_lineas WHERE recepcion_id = OLD.id
    LOOP
      PERFORM sync_ocl_cantidad_recibida(OLD.orden_compra_id, rl_record.sku);
    END LOOP;
    RETURN OLD;
  END IF;

  -- UPDATE: solo nos importa si cambió orden_compra_id
  IF OLD.orden_compra_id IS DISTINCT FROM NEW.orden_compra_id THEN
    FOR rl_record IN
      SELECT sku FROM recepcion_lineas WHERE recepcion_id = NEW.id
    LOOP
      PERFORM sync_ocl_cantidad_recibida(OLD.orden_compra_id, rl_record.sku);
      PERFORM sync_ocl_cantidad_recibida(NEW.orden_compra_id, rl_record.sku);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recepciones_sync_ocl ON recepciones;
CREATE TRIGGER trg_recepciones_sync_ocl
AFTER INSERT OR UPDATE OR DELETE ON recepciones
FOR EACH ROW EXECUTE FUNCTION tg_recepciones_sync_ocl();

-- Backfill: recomputar todas las líneas de OCs no anuladas.
-- Idempotente. Se puede correr de nuevo sin efecto si el trigger ya está
-- haciendo su trabajo.
UPDATE ordenes_compra_lineas ocl
SET cantidad_recibida = COALESCE((
  SELECT SUM(rl.qty_recibida)
  FROM recepcion_lineas rl
  JOIN recepciones r ON r.id = rl.recepcion_id
  WHERE r.orden_compra_id = ocl.orden_id
    AND UPPER(rl.sku) = UPPER(ocl.sku_origen)
), 0)
FROM ordenes_compra oc
WHERE ocl.orden_id = oc.id
  AND oc.estado <> 'ANULADA';

COMMENT ON FUNCTION sync_ocl_cantidad_recibida(uuid, text) IS
  'v93: Sincroniza ordenes_compra_lineas.cantidad_recibida con SUM(recepcion_lineas.qty_recibida) para un (orden_id, sku_origen). Idempotente. Llamado por triggers en recepcion_lineas y recepciones.';

COMMENT ON COLUMN ordenes_compra_lineas.cantidad_recibida IS
  'v93: Cache derivado mantenido por trigger desde recepcion_lineas.qty_recibida (canónico). NO escribir manualmente desde código aplicación — el trigger se desincroniza si hay UPDATE directo. Match case-insensitive UPPER(sku) = UPPER(sku_origen).';
