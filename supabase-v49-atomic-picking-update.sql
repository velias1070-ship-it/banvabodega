-- ============================================================================
-- BANVA BODEGA v49 — actualizar_linea_picking / agregar_linea_picking
--
-- Escrituras atómicas por línea sobre picking_sessions.lineas (jsonb) para
-- evitar race conditions entre operadores concurrentes. Reemplaza el patrón
-- read-mutate-write-full-array por un jsonb_set sobre una sola línea bajo
-- SELECT FOR UPDATE.
--
-- EJECUTAR EN: Supabase SQL Editor (o MCP apply_migration)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- actualizar_linea_picking
-- Patchea una sola línea (por id) dentro de picking_sessions.lineas y
-- recalcula el estado global de la sesión. Idempotente: si la línea no existe
-- retorna NULL sin error. Si el patch contiene 'componentes', reemplaza el
-- array completo de componentes (el caller envía el array ya patcheado).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION actualizar_linea_picking(
  p_session_id uuid,
  p_linea_id   text,
  p_patch      jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lineas        jsonb;
  v_idx           int;
  v_linea         jsonb;
  v_merged        jsonb;
  v_new_lineas    jsonb;
  v_all_picked    boolean;
  v_all_armado    boolean;
  v_session_done  boolean;
  v_new_estado    text;
BEGIN
  -- Lock the row
  SELECT lineas INTO v_lineas
    FROM picking_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF v_lineas IS NULL THEN
    RETURN NULL;
  END IF;

  -- Find index of the linea by id (0-based)
  SELECT (ord - 1)::int, elem
    INTO v_idx, v_linea
    FROM jsonb_array_elements(v_lineas) WITH ORDINALITY AS t(elem, ord)
   WHERE elem->>'id' = p_linea_id
   LIMIT 1;

  -- Line not found — idempotent no-op
  IF v_idx IS NULL THEN
    RETURN NULL;
  END IF;

  -- Shallow merge of patch onto the existing linea (patch keys win)
  v_merged := v_linea || p_patch;

  -- Write back the single linea
  v_new_lineas := jsonb_set(v_lineas, ARRAY[v_idx::text], v_merged, false);

  -- Recompute session state: COMPLETADA only if every linea is PICKEADO AND
  -- either estadoArmado is absent/null or COMPLETADO.
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
  v_new_estado   := CASE WHEN v_session_done THEN 'COMPLETADA' ELSE 'EN_PROCESO' END;

  UPDATE picking_sessions
     SET lineas       = v_new_lineas,
         estado       = v_new_estado,
         completed_at = CASE WHEN v_session_done THEN COALESCE(completed_at, now()) ELSE NULL END
   WHERE id = p_session_id;

  RETURN v_merged;
END;
$$;

GRANT EXECUTE ON FUNCTION actualizar_linea_picking(uuid, text, jsonb) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- agregar_linea_picking
-- Append atómico de una línea nueva al array, reabriendo la sesión si estaba
-- COMPLETADA (caso auto-add desde envio_full_pendiente al ubicar en posición).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agregar_linea_picking(
  p_session_id uuid,
  p_linea      jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_estado_actual text;
BEGIN
  SELECT estado INTO v_estado_actual
    FROM picking_sessions
   WHERE id = p_session_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE picking_sessions
     SET lineas = COALESCE(lineas, '[]'::jsonb) || jsonb_build_array(p_linea),
         estado = CASE
                    WHEN v_estado_actual = 'COMPLETADA' THEN 'EN_PROCESO'
                    ELSE v_estado_actual
                  END,
         completed_at = CASE
                          WHEN v_estado_actual = 'COMPLETADA' THEN NULL
                          ELSE completed_at
                        END
   WHERE id = p_session_id;
END;
$$;

GRANT EXECUTE ON FUNCTION agregar_linea_picking(uuid, jsonb) TO anon, authenticated;
