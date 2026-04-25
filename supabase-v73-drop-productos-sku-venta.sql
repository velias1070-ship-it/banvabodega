-- v73 — DROP productos.sku_venta
-- Contexto: la columna estaba 100% vacia en datos (0/436) y duplicaba info
-- que ya vive en composicion_venta.sku_venta + ml_items_map.sku.
-- PR1 (commit 3b1072d) ya desconecto el codigo de la columna.
-- Auditoria confirmo que ningun trigger, vista, function, constraint, RLS
-- ni repo hermano (banva1) la referencia.

ALTER TABLE productos DROP COLUMN IF EXISTS sku_venta;
