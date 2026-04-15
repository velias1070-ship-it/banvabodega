-- supabase-v51-limpieza-motivos.sql
-- Sprint 1 costeo · PASO 1
-- Objetivo: mover motivos no-contables a tabla aparte + renombrar motivos
-- legacy al whitelist final + corregir los 8 casos sucios detectados.
-- NO crea CHECK constraint (eso va en v52).

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Tabla nueva: eventos_operativos
-- ─────────────────────────────────────────────────────────────────
-- Mismo schema que movimientos, pero SIN costo_unitario, qty_after
-- ni idempotency_key. Es un log de eventos que no son transacciones
-- contables de stock.
CREATE TABLE IF NOT EXISTS eventos_operativos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          text NOT NULL,
  motivo        text NOT NULL,
  sku           text NOT NULL,
  posicion_id   text NOT NULL,
  cantidad      integer NOT NULL,
  recepcion_id  uuid,
  operario      text DEFAULT '',
  nota          text DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eventos_operativos_sku
  ON eventos_operativos(sku);
CREATE INDEX IF NOT EXISTS idx_eventos_operativos_motivo
  ON eventos_operativos(motivo);
CREATE INDEX IF NOT EXISTS idx_eventos_operativos_created_at
  ON eventos_operativos(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 2. Mover motivos no-contables (si existen filas)
-- ─────────────────────────────────────────────────────────────────
-- En prod (2026-04-15) estos motivos tienen 0 filas en movimientos, pero el
-- DML queda defensivo por si staging trae datos distintos o aparece algo
-- insertado entre que corremos el diagnóstico y la migración.
INSERT INTO eventos_operativos
  (id, tipo, motivo, sku, posicion_id, cantidad, recepcion_id, operario, nota, created_at)
SELECT id, tipo, motivo, sku, posicion_id, cantidad, recepcion_id, operario, nota, created_at
FROM movimientos
WHERE motivo IN (
  'reparacion_stock',
  'reclasificacion',
  'reasignacion_formato',
  'despick',
  'cancelacion_ml',
  'operario_skip_scan',
  'regularizacion_historica'
);

DELETE FROM movimientos
WHERE motivo IN (
  'reparacion_stock',
  'reclasificacion',
  'reasignacion_formato',
  'despick',
  'cancelacion_ml',
  'operario_skip_scan',
  'regularizacion_historica'
);

-- ─────────────────────────────────────────────────────────────────
-- 3. Rename masivo de motivos legacy al whitelist
-- ─────────────────────────────────────────────────────────────────
-- Volúmenes esperados en prod al 2026-04-15:
--   devolucion (entrada):            27 filas  → devolucion_cliente
--   ajuste_entrada (entrada):       193 filas  → ajuste_conteo_positivo
--   ajuste_salida (salida):         280 filas  → ajuste_conteo_negativo
--   reconciliacion_conteo (salida):   1 fila   → ajuste_conteo_negativo
--   reset_linea (salida):             3 filas  → ajuste_conteo_negativo
--   ajuste_conteo (entrada):          7 filas  → ajuste_conteo_positivo
--   ajuste_conteo (salida):          10 filas  → ajuste_conteo_negativo

UPDATE movimientos
SET    motivo = 'devolucion_cliente'
WHERE  motivo = 'devolucion' AND tipo = 'entrada';

UPDATE movimientos
SET    motivo = 'ajuste_conteo_positivo'
WHERE  motivo = 'ajuste_entrada';

UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo'
WHERE  motivo = 'ajuste_salida';

UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo'
WHERE  motivo = 'reconciliacion_conteo';

UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo'
WHERE  motivo = 'reset_linea';

-- Defensivo: 'reconciliacion' sin sufijo no existe en prod (0 filas)
-- pero el código TS en store.ts:1757,1768 lo emite. Staging podría tenerlo.
UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo'
WHERE  motivo = 'reconciliacion';

-- ajuste_conteo: split por tipo del movimiento
UPDATE movimientos
SET    motivo = 'ajuste_conteo_positivo'
WHERE  motivo = 'ajuste_conteo' AND tipo = 'entrada';

UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo'
WHERE  motivo = 'ajuste_conteo' AND tipo = 'salida';

-- ─────────────────────────────────────────────────────────────────
-- 4. Correcciones manuales de los 8 casos sucios
-- ─────────────────────────────────────────────────────────────────
-- Decisión de Vicente (2026-04-15):
-- preservamos trazabilidad del incidente del webhook duplicado.
-- Append-only es regla dura, no borramos movimientos para "limpiar ruido".
-- Los 6 movimientos del incidente se cancelan matemáticamente.

-- GRUPO A: 2 movimientos tipo='salida' motivo='recepcion'
--   → retipear a ajuste_conteo_negativo + vaciar recepcion_id (era spurious)
UPDATE movimientos
SET    motivo = 'ajuste_conteo_negativo',
       recepcion_id = NULL
WHERE  id IN (
  '2db509ff-87cb-4f63-b802-4b5ba3ae65e2',  -- LITAF400G4PNG D-1 2026-03-05
  'd72fb97c-f124-4189-8e65-41ec49f185f2'   -- TEXCCWTILL20P C-2 2026-03-13
);

-- GRUPO B: 3 movimientos motivo='despacho_ml' del webhook (2026-03-25)
--   → retipear a venta_full (tipo='salida' se mantiene)
UPDATE movimientos
SET    motivo = 'venta_full'
WHERE  id IN (
  'b41694b7-f48a-4719-a7f1-1449640a5bc2',  -- TXTPBL20200SK B0  19:48
  '53d5cb28-417a-44a4-b782-dc5e6e18a1f5',  -- ALPCMPRLV6012 A-1 19:49
  '9be34673-ba14-4603-8c6d-b1bcbf0b5d43'   -- TXV23QLAT25AQ B-3 19:49
);

-- GRUPO C: 3 movimientos motivo='ajuste' (reversión del incidente)
--   → retipear a ajuste_conteo_positivo (tipo='entrada' se mantiene)
--   la nota se preserva: es documentación del incidente webhook duplicado
UPDATE movimientos
SET    motivo = 'ajuste_conteo_positivo'
WHERE  id IN (
  '32bfec94-c063-4aa1-a856-578ff8784bf2',  -- TXTPBL20200SK B0  20:04
  '47020ad6-2a70-44e8-9e95-882ae3aedb01',  -- ALPCMPRLV6012 A-1 20:04
  '9b5ad754-d693-4dfe-86fc-edafcdbd3f54'   -- TXV23QLAT25AQ B-3 20:04
);

-- ─────────────────────────────────────────────────────────────────
-- 5. Verificación (solo comentario — ejecutar manualmente post-COMMIT)
-- ─────────────────────────────────────────────────────────────────
--   SELECT motivo, tipo, COUNT(*)
--   FROM movimientos
--   GROUP BY 1, 2
--   ORDER BY motivo, tipo;
--
-- Esperado (todos dentro del whitelist de v52):
--   entrada: recepcion, carga_inicial, devolucion_cliente,
--            ajuste_conteo_positivo, transferencia_in
--   salida:  venta_flex, venta_full, envio_full, merma,
--            ajuste_conteo_negativo, transferencia_out
--
-- Si aparece cualquier otro valor, v52 va a abortar en el DO block.

COMMIT;
