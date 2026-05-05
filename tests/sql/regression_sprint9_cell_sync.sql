-- Sprint 9 Prioridad 1 — Tests invariantes del sync cell_efectiva ↔ visibilidad
-- batch:20260505-sprint-9-cell-sync | sprint:9 | milestone:sprint-9-cell-sync-canon
--
-- Estos 2 tests son invariantes del filtro de visibilidad. Pin a 0:
-- si en el futuro el trend detector promueve/degrada un SKU y el sync se
-- rompe, los tests fallan inmediatamente.
--
-- Origen del desync (pre-Sprint 9):
-- - refresh_trend_in_sku_node_policy actualiza snp.cell_efectiva pero NO
--   reconcilia snp.action.
-- - v_safety_stock filtra por snp.action en cláusula WHERE final.
-- - Resultado: SKUs degradados (cell_efectiva peor que cell) siguen
--   comprables; SKUs promovidos (cell_efectiva mejor) quedan invisibles.
--
-- Fix Sprint 9 P1 (opción d): v_safety_stock filtra por
-- policy_templates.action resolviendo COALESCE(cell_efectiva, cell).
-- snp.action queda como cache informativo, no autoritativo.

-- ─────────────────────────────────────────────────────────────────────
-- T28: no_compra_post_degradacion
-- ─────────────────────────────────────────────────────────────────────
-- Invariante: SKUs cuya celda fue degradada (cell_efectiva con primera
-- letra peor que cell original) NO deben aparecer en v_compras_pendientes
-- (independientemente de si su stock circunstancial los hace tener
-- qty_a_comprar=0 hoy). Si el stock cae, la presencia en la vista los
-- vuelve comprables automáticamente — el bug está latente, no resuelto.
-- Pre-fix: >0. Post-fix Sprint 9 P1: 0.

WITH t28 AS (
  SELECT COUNT(*) AS skus_degradados_visibles_compras
  FROM v_compras_pendientes vcp
  JOIN sku_node_policy snp ON snp.sku_origen = vcp.sku_origen
   AND snp.node_id = 'bodega_central'
  WHERE substring(snp.cell_efectiva,1,1) > substring(snp.cell,1,1)
)
SELECT
  'T28_no_compra_post_degradacion'::text AS test_name,
  skus_degradados_visibles_compras AS valor,
  0 AS esperado,
  CASE WHEN skus_degradados_visibles_compras = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t28;

-- ─────────────────────────────────────────────────────────────────────
-- T29: promovido_visible
-- ─────────────────────────────────────────────────────────────────────
-- Invariante: SKUs cuya celda fue promovida (cell_efectiva con primera
-- letra mejor que cell original) DEBEN ser visibles en v_safety_stock.
-- Pre-fix: >0 (algunos invisibles). Post-fix Sprint 9 P1: 0.

WITH t29 AS (
  SELECT COUNT(*) AS skus_promovidos_invisibles
  FROM sku_node_policy snp
  LEFT JOIN v_safety_stock vss ON vss.sku_origen = snp.sku_origen
   AND vss.node_id = 'bodega_central'
  WHERE snp.node_id = 'bodega_central'
    AND snp.policy_status = 'active'
    AND substring(snp.cell_efectiva,1,1) < substring(snp.cell,1,1)
    AND vss.sku_origen IS NULL
)
SELECT
  'T29_promovido_visible'::text AS test_name,
  skus_promovidos_invisibles AS valor,
  0 AS esperado,
  CASE WHEN skus_promovidos_invisibles = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t29;
