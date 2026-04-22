-- v59: rollback completo de `flex_objetivo` (v57).
--
-- Razón (2026-04-22): el flag como metadato de política no sirvió. El motor
-- hoy asume "todo SKU activo vive en Flex si stock_bodega > buffer_ml" sin
-- opt-in por SKU. La función canon `calcularEstadoFlexFull` ya no consume
-- `productos.flex_objetivo`; se eliminan las 3 columnas + índice parcial.
--
-- Los 125 registros con flex_objetivo=true se pierden con el drop. No
-- controlaban nada operativo (la publicación ML ya se había independizado
-- del flag en el revert parcial de PR3, commit 9030d98).

ALTER TABLE productos
  DROP COLUMN IF EXISTS flex_objetivo,
  DROP COLUMN IF EXISTS flex_objetivo_auto,
  DROP COLUMN IF EXISTS flex_objetivo_motivo;

DROP INDEX IF EXISTS idx_productos_flex_objetivo;
