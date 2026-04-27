-- v90 — Trazabilidad del origen de un conteo cíclico
--
-- Hoy un conteo creado desde "Sugerir lista del día" pierde el contexto de
-- POR QUÉ se creó: qué SKU(s) dispararon la sugerencia, qué clase ABC tenían
-- al disparar, etc. Solo queda la lista de líneas (SKUs en las posiciones).
--
-- v90 agrega:
--   - origen: discriminador del proceso de creación
--   - skus_disparadores: SKUs vencidos que disparaban la sugerencia ABC
--
-- Manual Inventarios Parte2 §5.6.2: la trazabilidad alimenta mejoras de proceso.
-- Esto es la versión "upstream" — no solo qué pasó (causa_raiz por línea), sino
-- por qué se hizo este conteo en primer lugar.

ALTER TABLE conteos
  ADD COLUMN IF NOT EXISTS origen text,
  ADD COLUMN IF NOT EXISTS skus_disparadores jsonb;

COMMENT ON COLUMN conteos.origen IS
'Origen del conteo: manual, sugerencia_abc, trigger_discrepancia, auditoria_aleatoria. Manual Inventarios Parte2 §5.6.2.';
COMMENT ON COLUMN conteos.skus_disparadores IS
'Cuando origen=sugerencia_abc, lista de SKUs vencidos que dispararon la creación con su ABC y razón.';
