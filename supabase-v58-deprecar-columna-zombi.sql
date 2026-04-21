-- v58 — Marcar ml_items_map.stock_full_cache como DEPRECADA (PR6b-pivot-I, 2026-04-21).
--
-- Contexto: la columna `ml_items_map.stock_full_cache` guardaba valores stale durante
-- semanas porque el stale_cleanup de syncStockFull solo limpiaba la tabla canónica
-- `stock_full_cache` y dejaba la columna con valores zombi (ver
-- docs/banva-bodega-pr6b-pivot-preauditoria.md y el commit del PR6b-pivot-I).
--
-- Esta migración NO toca datos ni estructura — solo agrega un COMMENT para dejar
-- trail auditable. Safe: sin DDL destructivo, sin lock de tabla. Aplicable
-- en cualquier momento por Vicente según regla "ALTER sin afectar datos".
--
-- Cleanup físico (DROP COLUMN) queda para sprint futuro cuando se migren los
-- escritores restantes (ml.ts syncStockFull/syncStockByUserProductId/stock-compare).

COMMENT ON COLUMN ml_items_map.stock_full_cache IS
  'DEPRECADA (2026-04-21 PR6b-pivot-I). Fuente canonica: tabla stock_full_cache. No leer ni escribir aqui directamente. Se mantiene por compatibilidad hasta cleanup en sprint futuro.';
