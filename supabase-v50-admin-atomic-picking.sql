-- ============================================================================
-- BANVA BODEGA v50 — eliminar_linea_picking / dividir_envio_full
--
-- Complemento de v49. Cierra el hueco donde el admin UI escribia el array
-- lineas completo para operaciones destructivas (eliminar linea) y splits.
-- Ambas funciones lockean la fila con SELECT FOR UPDATE para evitar clobber
-- de picks concurrentes hechos por operadores.
--
-- EJECUTAR EN: Supabase SQL Editor (o MCP apply_migration)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- eliminar_linea_picking
-- Remueve atomicamente una linea (por id) del array lineas de una sesion.
-- Recalcula el estado global: COMPLETADA si todas las restantes estan
-- PICKEADO+armadas, ABIERTA si el array queda vacio, EN_PROCESO en otro caso.
-- Retorna true si removio la linea, false si la sesion o la linea no existen.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION eliminar_linea_picking(
  p_session_id uuid,
  p_linea_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lineas       jsonb;
  v_new_lineas   jsonb;
  v_found        boolean;
  v_count        int;
  v_all_picked   boolean;
  v_all_armado   boolean;
  v_session_done boolean;
  v_new_estado   text;
BEGIN
  SELECT lineas INTO v_lineas
    FROM picking_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF v_lineas IS NULL THEN
    RETURN false;
  END IF;

  -- Check if the linea exists in the current array
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_lineas) AS l
     WHERE l->>'id' = p_linea_id
  ) INTO v_found;

  IF NOT v_found THEN
    RETURN false;
  END IF;

  -- Filter the linea out preserving order
  SELECT COALESCE(jsonb_agg(l ORDER BY ord), '[]'::jsonb)
    INTO v_new_lineas
    FROM jsonb_array_elements(v_lineas) WITH ORDINALITY AS t(l, ord)
   WHERE l->>'id' <> p_linea_id;

  SELECT jsonb_array_length(v_new_lineas) INTO v_count;

  IF v_count = 0 THEN
    v_new_estado := 'ABIERTA';
    v_session_done := false;
  ELSE
    SELECT
      bool_and((l->>'estado') = 'PICKEADO'),
      bool_and(
        (l->>'estadoArmado') IS NULL
        OR (l->>'estadoArmado') = 'null'
        OR (l->>'estadoArmado') = 'COMPLETADO'
      )
      INTO v_all_picked, v_all_armado
      FROM jsonb_array_elements(v_new_lineas) AS l;

    v_session_done := COALESCE(v_all_picked, false) AND COALESCE(v_all_armado, true);
    v_new_estado := CASE WHEN v_session_done THEN 'COMPLETADA' ELSE 'EN_PROCESO' END;
  END IF;

  UPDATE picking_sessions
     SET lineas       = v_new_lineas,
         estado       = v_new_estado,
         completed_at = CASE WHEN v_session_done THEN COALESCE(completed_at, now()) ELSE NULL END
   WHERE id = p_session_id;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION eliminar_linea_picking(uuid, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- dividir_envio_full
-- Mueve atomicamente las lineas cuyo id esta en p_linea_ids desde una sesion
-- envio_full existente a una nueva sesion envio_full. Renumera las lineas
-- movidas a F001..Fnnn (padStart 3). Lockea la sesion original con
-- SELECT FOR UPDATE para evitar clobber de picks concurrentes. Recalcula el
-- estado de la sesion original. Retorna el uuid de la nueva sesion o NULL en
-- error.
--
-- Validaciones:
--   - La sesion original debe existir.
--   - p_linea_ids no puede ser vacio.
--   - No se pueden mover TODAS las lineas (debe quedar al menos una).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dividir_envio_full(
  p_session_id   uuid,
  p_linea_ids    text[],
  p_nuevo_titulo text,
  p_fecha        date
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lineas         jsonb;
  v_lineas_movidas jsonb;
  v_lineas_renum   jsonb;
  v_lineas_resto   jsonb;
  v_count_total    int;
  v_count_movidas  int;
  v_count_resto    int;
  v_all_picked     boolean;
  v_all_armado     boolean;
  v_session_done   boolean;
  v_new_estado     text;
  v_new_id         uuid;
BEGIN
  IF p_linea_ids IS NULL OR array_length(p_linea_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'dividir_envio_full: p_linea_ids vacio';
  END IF;

  SELECT lineas INTO v_lineas
    FROM picking_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF v_lineas IS NULL THEN
    RAISE EXCEPTION 'dividir_envio_full: sesion % no encontrada', p_session_id;
  END IF;

  SELECT jsonb_array_length(v_lineas) INTO v_count_total;

  -- Lineas movidas: en el orden en que aparecen en el array original
  SELECT COALESCE(jsonb_agg(l ORDER BY ord), '[]'::jsonb)
    INTO v_lineas_movidas
    FROM jsonb_array_elements(v_lineas) WITH ORDINALITY AS t(l, ord)
   WHERE l->>'id' = ANY(p_linea_ids);

  SELECT jsonb_array_length(v_lineas_movidas) INTO v_count_movidas;

  IF v_count_movidas = 0 THEN
    RAISE EXCEPTION 'dividir_envio_full: ninguna linea del set % coincide', p_linea_ids;
  END IF;

  IF v_count_movidas >= v_count_total THEN
    RAISE EXCEPTION 'dividir_envio_full: no se pueden mover todas las lineas (% de %)', v_count_movidas, v_count_total;
  END IF;

  -- Renumerar lineas movidas a F001..Fnnn
  SELECT COALESCE(jsonb_agg(
           jsonb_set(l, '{id}', to_jsonb('F' || lpad(ord::text, 3, '0')))
           ORDER BY ord
         ), '[]'::jsonb)
    INTO v_lineas_renum
    FROM jsonb_array_elements(v_lineas_movidas) WITH ORDINALITY AS t(l, ord);

  -- Lineas restantes en la sesion original (mantienen ids)
  SELECT COALESCE(jsonb_agg(l ORDER BY ord), '[]'::jsonb)
    INTO v_lineas_resto
    FROM jsonb_array_elements(v_lineas) WITH ORDINALITY AS t(l, ord)
   WHERE NOT (l->>'id' = ANY(p_linea_ids));

  SELECT jsonb_array_length(v_lineas_resto) INTO v_count_resto;

  -- Recalcular estado de la sesion original tras la remocion
  SELECT
    bool_and((l->>'estado') = 'PICKEADO'),
    bool_and(
      (l->>'estadoArmado') IS NULL
      OR (l->>'estadoArmado') = 'null'
      OR (l->>'estadoArmado') = 'COMPLETADO'
    )
    INTO v_all_picked, v_all_armado
    FROM jsonb_array_elements(v_lineas_resto) AS l;

  v_session_done := COALESCE(v_all_picked, false) AND COALESCE(v_all_armado, true) AND v_count_resto > 0;
  v_new_estado := CASE WHEN v_session_done THEN 'COMPLETADA' ELSE 'EN_PROCESO' END;

  -- Actualizar la sesion original
  UPDATE picking_sessions
     SET lineas       = v_lineas_resto,
         estado       = v_new_estado,
         completed_at = CASE WHEN v_session_done THEN COALESCE(completed_at, now()) ELSE NULL END
   WHERE id = p_session_id;

  -- Crear la nueva sesion
  INSERT INTO picking_sessions (fecha, estado, lineas, tipo, titulo)
  VALUES (p_fecha, 'ABIERTA', v_lineas_renum, 'envio_full', p_nuevo_titulo)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION dividir_envio_full(uuid, text[], text, date) TO anon, authenticated;
