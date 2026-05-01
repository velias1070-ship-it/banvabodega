-- ============================================================
-- Sprint 0 — Validation tests
-- Run after applying supabase/migrations/20260501230000_sprint0_master_cleanup.sql.
-- All assertions must pass. Use EXPLAIN ANALYZE if you want timings.
-- ============================================================

-- T1 — Zombie table dropped (expect 0)
SELECT COUNT(*) AS t1_zombie_dropped
FROM information_schema.tables
WHERE table_schema='public' AND table_name='_deprecated_ml_velocidad_semanal_2026_05_09';
-- expected: 0

-- T2 — productos.precio column dropped (expect 0)
SELECT COUNT(*) AS t2_precio_col_dropped
FROM information_schema.columns
WHERE table_schema='public' AND table_name='productos' AND column_name='precio';
-- expected: 0

-- T3 — productos.sku non-UPPER remaining = 2 (the colliding pairs awaiting human merge)
SELECT COUNT(*) AS t3_productos_pending_merge
FROM productos
WHERE sku <> UPPER(TRIM(sku));
-- expected: 2

-- T4 — stock_full_cache.sku_venta all UPPER (expect 0)
SELECT COUNT(*) AS t4_sfc_clean
FROM stock_full_cache
WHERE sku_venta <> UPPER(TRIM(sku_venta));
-- expected: 0

-- T5 — composicion_venta both columns UPPER (expect 0)
SELECT COUNT(*) AS t5_cv_clean
FROM composicion_venta
WHERE sku_venta <> UPPER(TRIM(sku_venta))
   OR sku_origen <> UPPER(TRIM(sku_origen));
-- expected: 0

-- T6 — ml_items_map all 3 sku columns UPPER (expect 0)
SELECT COUNT(*) AS t6_mim_clean
FROM ml_items_map
WHERE (sku IS NOT NULL AND sku <> UPPER(TRIM(sku)))
   OR (sku_venta IS NOT NULL AND sku_venta <> UPPER(TRIM(sku_venta)))
   OR (sku_origen IS NOT NULL AND sku_origen <> UPPER(TRIM(sku_origen)));
-- expected: 0

-- T7 — policy_templates exists with 9 cells
SELECT COUNT(*) AS t7_policy_templates_seeded FROM policy_templates;
-- expected: 9

-- T8 — policy_action_enum has 6 values
SELECT COUNT(*) AS t8_enum_values
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'policy_action_enum';
-- expected: 6

-- T9 — _sprint0_dup_skus has 2 rows for human merge
SELECT COUNT(*) AS t9_dup_audit_rows FROM _sprint0_dup_skus;
-- expected: 2

-- T10 — Spot check AX worked example
SELECT cell, service_level, z_value, target_dias_full, action::text
FROM policy_templates WHERE cell = 'AX';
-- expected: AX | 0.9800 | 2.050 | 42 | reorder_normal

-- T11 — CZ no_reorder with NULL service_level + z
SELECT cell, service_level, z_value, target_dias_full, action::text
FROM policy_templates WHERE cell = 'CZ';
-- expected: CZ | NULL | NULL | 0 | no_reorder
