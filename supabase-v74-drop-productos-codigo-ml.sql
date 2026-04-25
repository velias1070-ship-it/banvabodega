-- v74 — DROP productos.codigo_ml
-- Contexto: la columna duplicaba inventory_id que ya vive (100% sincronizado)
-- en composicion_venta.codigo_ml + ml_items_map.inventory_id.
-- PR de cleanup ya migro las lecturas a esos otros lugares via helpers
-- getCodigosMlBySkuOrigen / getCodigoMlPrimario en store.ts.
-- Auditoria confirmo cero drift y cero referencias en triggers/vistas/RLS.
-- El index idx_productos_codigo_ml se dropea junto con la columna automaticamente.

ALTER TABLE productos DROP COLUMN IF EXISTS codigo_ml;
