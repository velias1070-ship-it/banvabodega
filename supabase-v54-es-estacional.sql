-- v54: flag es_estacional con metadata auditable (PR4 Fase 1)
--
-- Marca manual de SKUs con patrón estacional / fin-de-ciclo, NO adecuados
-- para TSB (ni para ningún Croston-like). Cuando es_estacional=true, el
-- motor usa SMA ponderado aunque el SKU cumpla la puerta de 60d de TSB.
--
-- Metadata: guardamos QUIÉN marcó, CUÁNDO, POR QUÉ y CUÁNDO revisar.
-- Sin esto, en 6 meses el flag es caja negra. Además sirve para
-- contrastar "humano" vs "modelo" cuando Fase 2 agregue detección
-- automática (~julio 2026).
--
-- No se marca a nadie automáticamente en esta migración. El script
-- scripts/marcar-estacionales-iniciales.sql marca los 3 SKUs del
-- benchmark PR3 Fase B cuando se ejecute manualmente.

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS es_estacional           boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS estacional_motivo       text        NULL,
  ADD COLUMN IF NOT EXISTS estacional_marcado_por  text        NULL,
  ADD COLUMN IF NOT EXISTS estacional_marcado_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS estacional_revisar_en   date        NULL;

COMMENT ON COLUMN sku_intelligence.es_estacional IS
  'Flag manual: SKU con patrón estacional que NO debe usar TSB. Revisar cada 6 meses.';
COMMENT ON COLUMN sku_intelligence.estacional_motivo IS
  'Razón de la marca. Texto libre. Ejemplo: "pico invierno abr-ago 2025".';
COMMENT ON COLUMN sku_intelligence.estacional_marcado_por IS
  'Usuario/operador que marcó. Texto libre. Ejemplo: "vicente", "admin".';
COMMENT ON COLUMN sku_intelligence.estacional_marcado_at IS
  'Timestamp del marcado. Usar now() al insertar.';
COMMENT ON COLUMN sku_intelligence.estacional_revisar_en IS
  'Fecha en que debe re-evaluarse si sigue siendo estacional. Típico: marcado_at + 6 meses.';

-- Índice parcial para el banner del tab Accuracy: buscar estacionales vencidos.
CREATE INDEX IF NOT EXISTS idx_sku_intel_estacional_revisar
  ON sku_intelligence(estacional_revisar_en)
  WHERE es_estacional = true;
