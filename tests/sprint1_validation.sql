-- =============================================================================
-- Sprint 1 — Validación post-deploy (12 tests)
-- =============================================================================
-- Correr después de aplicar 20260502120000_sprint1_nodes_lanes_policy.sql.
-- Cada test imprime test + result (PASS/FAIL). Si CUALQUIER test devuelve FAIL,
-- investigar antes de avanzar a Sprint 2.
--
-- Resultado esperado: 12/12 PASS.
-- Última corrida: 2026-05-02 (12/12 PASS).
-- =============================================================================

-- TEST 1: Enums creados
SELECT 'T01_enums' AS test,
  CASE WHEN COUNT(*)=2 THEN 'PASS' ELSE 'FAIL: '||COUNT(*) END AS result
FROM pg_type WHERE typname IN ('node_type_enum','lane_type_enum');


-- TEST 2: 3 nodes seedeados con tipos correctos
SELECT 'T02_nodes_seed' AS test,
  CASE WHEN COUNT(*)=3
        AND COUNT(*) FILTER (WHERE node_type='warehouse')=1
        AND COUNT(*) FILTER (WHERE node_type='fulfillment')=1
        AND COUNT(*) FILTER (WHERE node_type='supplier_ref')=1
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM nodes;


-- TEST 3: 2 lanes seedeados con FKs válidas y lead_time > 0
SELECT 'T03_lanes_seed' AS test,
  CASE WHEN COUNT(*)=2
        AND BOOL_AND(from_node_id IN ('supplier_generic','bodega_central'))
        AND BOOL_AND(to_node_id IN ('bodega_central','full_ml'))
        AND BOOL_AND(lead_time_days > 0)
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM lanes;


-- TEST 4: Constraint lanes.from <> lanes.to enforced
DO $$ BEGIN
  BEGIN
    INSERT INTO lanes (id, from_node_id, to_node_id, lane_type, lead_time_days)
      VALUES ('test_loop','bodega_central','bodega_central','transfer',1);
    RAISE EXCEPTION 'T04_FAIL: insert con from=to debió rechazarse';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;
END $$;
SELECT 'T04_lane_no_loop' AS test, 'PASS' AS result;


-- TEST 5: sku_node_policy FK a productos(sku) enforced
DO $$ BEGIN
  BEGIN
    INSERT INTO sku_node_policy (sku_origen, node_id, override_reason)
      VALUES ('SKU_INEXISTENTE_XYZ','bodega_central','test');
    RAISE EXCEPTION 'T05_FAIL: FK productos(sku) no enforced';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;
SELECT 'T05_policy_fks' AS test, 'PASS' AS result;


-- TEST 6: v_stock_por_nodo retorna filas para ambos nodos (bodega + full)
SELECT 'T06_view_stock_dual_node' AS test,
  CASE WHEN COUNT(DISTINCT node_id) >= 2 THEN 'PASS' ELSE 'FAIL' END AS result,
  COUNT(*) AS total_rows
FROM v_stock_por_nodo;


-- TEST 7: v_stock_por_nodo lee desde fuentes canónicas (no duplica con
-- ml_items_map.stock_full_cache deprecada). full_ml ≥ stock_full_cache.cantidad
-- (mayor por unidades de composición).
WITH v AS (SELECT SUM(qty_on_hand) AS via_view FROM v_stock_por_nodo WHERE node_id='full_ml'),
canon AS (SELECT SUM(cantidad)::numeric AS direct FROM stock_full_cache)
SELECT 'T07_canonical_only' AS test,
  CASE WHEN v.via_view IS NOT NULL AND v.via_view >= canon.direct THEN 'PASS'
       ELSE 'FAIL' END AS result,
  v.via_view AS view_full_ml,
  canon.direct AS direct_sum_full
FROM v, canon;


-- TEST 8: v_in_transit_por_nodo respeta filtros (qty_in_transit > 0 siempre).
SELECT 'T08_in_transit_states' AS test,
  CASE WHEN COUNT(*)=0 OR BOOL_AND(qty_in_transit > 0)
       THEN 'PASS' ELSE 'FAIL: filas con qty<=0' END AS result,
  COUNT(*) AS rows_returned
FROM v_in_transit_por_nodo;


-- TEST 9: Insert sku_node_policy con FKs válidas funciona; cleanup
DO $$
DECLARE v_sku text;
BEGIN
  SELECT sku INTO v_sku FROM productos LIMIT 1;
  INSERT INTO sku_node_policy (sku_origen, node_id, target_dias_override, override_reason)
    VALUES (v_sku, 'bodega_central', 30, 'Sprint 1 smoke test');
  DELETE FROM sku_node_policy WHERE sku_origen=v_sku AND node_id='bodega_central'
    AND override_reason='Sprint 1 smoke test';
END $$;
SELECT 'T09_policy_insert_delete' AS test, 'PASS' AS result;


-- TEST 10: Composite PK enforced (sku_origen + node_id)
DO $$
DECLARE v_sku text;
BEGIN
  SELECT sku INTO v_sku FROM productos LIMIT 1;
  INSERT INTO sku_node_policy (sku_origen, node_id, override_reason)
    VALUES (v_sku, 'full_ml', 't10a');
  BEGIN
    INSERT INTO sku_node_policy (sku_origen, node_id, override_reason)
      VALUES (v_sku, 'full_ml', 't10b');
    DELETE FROM sku_node_policy WHERE sku_origen=v_sku AND node_id='full_ml';
    RAISE EXCEPTION 'T10_FAIL: PK duplicado debió rechazarse';
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM sku_node_policy WHERE sku_origen=v_sku AND node_id='full_ml';
  END;
END $$;
SELECT 'T10_composite_pk' AS test, 'PASS' AS result;


-- TEST 11: COMMENT existe en cada nueva tabla / vista / type
WITH expected(obj) AS (VALUES
  ('TABLE: nodes'),('TABLE: lanes'),('TABLE: sku_node_policy'),
  ('TABLE: _deprecated_column_reads'),
  ('VIEW: v_stock_por_nodo'),('VIEW: v_in_transit_por_nodo'),
  ('TYPE: node_type_enum'),('TYPE: lane_type_enum')
),
actual AS (
  SELECT 'TABLE: '||c.relname AS obj FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'
     AND c.relname IN ('nodes','lanes','sku_node_policy','_deprecated_column_reads')
     AND obj_description(c.oid,'pg_class') IS NOT NULL
  UNION ALL
  SELECT 'VIEW: '||c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v'
     AND c.relname IN ('v_stock_por_nodo','v_in_transit_por_nodo')
     AND obj_description(c.oid,'pg_class') IS NOT NULL
  UNION ALL
  SELECT 'TYPE: '||t.typname FROM pg_type t
    JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname='public' AND t.typname IN ('node_type_enum','lane_type_enum')
     AND obj_description(t.oid,'pg_type') IS NOT NULL
)
SELECT 'T11_comments' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE a.obj IS NULL)=0 THEN 'PASS' ELSE 'FAIL' END AS result
FROM expected e LEFT JOIN actual a USING (obj);


-- TEST 12: Snake_case en TODOS los identificadores nuevos (CONVENTIONS.md §1)
WITH cols AS (
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('nodes','lanes','sku_node_policy','_deprecated_column_reads',
                       'v_stock_por_nodo','v_in_transit_por_nodo')
)
SELECT 'T12_snake_case' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE column_name !~ '^[a-z][a-z0-9_]*$')=0
       THEN 'PASS' ELSE 'FAIL' END AS result
FROM cols;
