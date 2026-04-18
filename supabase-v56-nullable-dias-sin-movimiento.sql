-- v56: dias_sin_movimiento nullable (PR6a)
--
-- El centinela DEFAULT 999 escondía un bug silencioso: los 533 SKUs quedaron
-- con dias_sin_movimiento=999 aunque 335 de ellos SÍ tienen movimientos en
-- la tabla `movimientos` (3.271 filas últimos 60 días). La acción `NUEVO`
-- (que exige `diasSinMov <= 30`) se volvió rama muerta → 49 SKUs con
-- movimiento real quedaron mal-clasificados como `DEAD_STOCK`.
--
-- Fix: hacer el campo honestamente NULL cuando no hay movimiento conocido.
-- PR5 ya enseñó la lección: centinelas numéricos esconden bugs. Ver §14
-- de docs/banva-bodega-inteligencia.md.

ALTER TABLE sku_intelligence
  ALTER COLUMN dias_sin_movimiento DROP DEFAULT,
  ALTER COLUMN dias_sin_movimiento DROP NOT NULL;

COMMENT ON COLUMN sku_intelligence.dias_sin_movimiento IS
  'PR6a: días calendario desde el último movimiento. NULL si el SKU no tiene movimiento conocido en ventana 60d. Antes del fix caía a 999 (centinela).';
