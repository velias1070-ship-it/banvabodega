-- ============================================================
-- v6: Atomic line locking via RPC (prevents race conditions)
-- Run AFTER v5-locks.sql
-- ============================================================

-- Atomic lock: uses SELECT ... FOR UPDATE to guarantee only one operator wins
CREATE OR REPLACE FUNCTION bloquear_linea(p_linea_id uuid, p_operario text, p_minutos integer DEFAULT 15)
RETURNS boolean AS $$
DECLARE
  v_bloqueado_por text;
  v_bloqueado_hasta timestamptz;
BEGIN
  -- Lock the row exclusively so no other transaction can read/modify it concurrently
  SELECT bloqueado_por, bloqueado_hasta
    INTO v_bloqueado_por, v_bloqueado_hasta
    FROM recepcion_lineas
   WHERE id = p_linea_id
     FOR UPDATE;

  -- Row not found
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Check if already locked by someone else and lock hasn't expired
  IF v_bloqueado_por IS NOT NULL
     AND v_bloqueado_por <> p_operario
     AND v_bloqueado_hasta > now() THEN
    RETURN false;
  END IF;

  -- Lock it for this operator
  UPDATE recepcion_lineas
     SET bloqueado_por = p_operario,
         bloqueado_hasta = now() + (p_minutos || ' minutes')::interval
   WHERE id = p_linea_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Atomic unlock
CREATE OR REPLACE FUNCTION desbloquear_linea(p_linea_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE recepcion_lineas
     SET bloqueado_por = NULL,
         bloqueado_hasta = NULL
   WHERE id = p_linea_id;
END;
$$ LANGUAGE plpgsql;
