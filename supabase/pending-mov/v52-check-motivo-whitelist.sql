-- supabase-v52-check-motivo-whitelist.sql
-- Sprint 1 costeo · PASO 2
-- Aplica CHECK constraint con whitelist de motivos por tipo.
--
-- PRE-REQUISITOS ESTRICTOS:
--   1. v51 aplicada (motivos históricos renombrados y no-contables movidos).
--   2. Código TS modificado para emitir sólo motivos del whitelist. Si
--      cualquier ruta sigue emitiendo legacy (ej: 'ajuste_entrada',
--      'reset_linea', 'reconciliacion', 'despacho_ml'...), los nuevos writes
--      van a fallar con CHECK violation tras aplicar este archivo.
--
-- El DO block de verificación aborta la transacción si existe alguna fila
-- fuera del whitelist, así no entra un CHECK constraint inválido.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Verificación previa — abort si hay motivos fuera del whitelist
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_malos integer;
BEGIN
  SELECT COUNT(*) INTO v_malos
  FROM movimientos
  WHERE NOT (
    (tipo = 'entrada' AND motivo IN (
      'recepcion',
      'carga_inicial',
      'devolucion_cliente',
      'ajuste_conteo_positivo',
      'transferencia_in'
    )) OR
    (tipo = 'salida' AND motivo IN (
      'venta_flex',
      'venta_full',
      'envio_full',
      'merma',
      'obsolescencia',
      'devolucion_proveedor',
      'ajuste_conteo_negativo',
      'transferencia_out'
    )) OR
    (tipo = 'transferencia' AND motivo IN (
      'cambio_posicion'
    ))
  );

  IF v_malos > 0 THEN
    RAISE EXCEPTION
      'v52 abort: % filas con motivo fuera del whitelist. Ejecutar: SELECT motivo, tipo, COUNT(*) FROM movimientos GROUP BY 1,2 ORDER BY motivo, tipo; para investigar.',
      v_malos;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- 2. Aplicar CHECK constraint
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE movimientos
  ADD CONSTRAINT movimientos_motivo_check CHECK (
    (tipo = 'entrada' AND motivo IN (
      'recepcion',
      'carga_inicial',
      'devolucion_cliente',
      'ajuste_conteo_positivo',
      'transferencia_in'
    )) OR
    (tipo = 'salida' AND motivo IN (
      'venta_flex',
      'venta_full',
      'envio_full',
      'merma',
      'obsolescencia',
      'devolucion_proveedor',
      'ajuste_conteo_negativo',
      'transferencia_out'
    )) OR
    (tipo = 'transferencia' AND motivo IN (
      'cambio_posicion'
    ))
  );

COMMIT;
