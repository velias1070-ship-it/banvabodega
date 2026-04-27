-- v87 — Eliminar centinela 999 en dias_sin_conteo
-- Regla 1 inventory-policy.md: NULL en lugar de número mágico.
--
-- Antes: DEFAULT 999 + NOT NULL implícito vía default. 535/646 SKUs tenían 999
-- (nunca-contados confundidos con conteos hechos hace 999 días reales).
-- Después: DROP DEFAULT, asumir nullable. El motor (intelligence.ts:1440)
-- escribe NULL cuando no hay conteo previo.

ALTER TABLE sku_intelligence
  ALTER COLUMN dias_sin_conteo DROP DEFAULT;

UPDATE sku_intelligence
SET dias_sin_conteo = NULL
WHERE dias_sin_conteo = 999;

-- Verificación esperada: 0 filas con 999.
-- SELECT COUNT(*) FROM sku_intelligence WHERE dias_sin_conteo = 999;

COMMENT ON COLUMN sku_intelligence.dias_sin_conteo IS 'Días desde el último conteo cíclico cerrado. NULL = nunca contado. Regla 1 inventory-policy.md (no usar centinela 999).';
