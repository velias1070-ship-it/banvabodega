-- =============================================================================
-- Sprint 4.1 — Validación post-deploy (5 tests)
-- =============================================================================
-- Correr después de aplicar 20260503210000_sprint41_fix_pre_full.sql.
-- Idempotente: solo lecturas.
-- =============================================================================

-- T01 — LITAF400G4PCL: qty_a_comprar >= 30 (era 4 pre-fix)
SELECT 'T01_litaf_qty_fixed' AS test,
  CASE WHEN qty_a_comprar >= 30
       THEN FORMAT('PASS (qty=%s, pre_full=%s)', qty_a_comprar, pre_full_target)
       ELSE FORMAT('FAIL (qty=%s, esperado >=30)', qty_a_comprar) END AS result
FROM v_compras_pendientes
WHERE sku_origen = 'LITAF400G4PCL';

-- T02 — pre_full_target >0 para SKUs AX/AY con vel >= 0.5/día.
-- Pre-fix siempre era 0; post-fix debe ser >0 para SKUs estrella.
SELECT 'T02_pre_full_propagated' AS test,
  CASE WHEN COUNT(*) > 0 AND COUNT(*) FILTER (WHERE pre_full_target = 0) = 0
       THEN FORMAT('PASS (%s SKUs AX/AY rápidos con pre_full>0)', COUNT(*))
       WHEN COUNT(*) = 0 THEN 'PASS (no AX/AY rápidos en compras_pendientes; vacuously true)'
       ELSE FORMAT('FAIL: %s con pre_full=0',
                   COUNT(*) FILTER (WHERE pre_full_target = 0))
  END AS result
FROM v_compras_pendientes
WHERE cell IN ('AX','AY') AND d_avg_dia >= 0.5;

-- T03 — stock_objetivo > cycle + SS para SKUs con pre_full > 0
SELECT 'T03_stock_objetivo_includes_prefull' AS test,
  CASE
    WHEN COUNT(*) = 0 THEN 'PASS (no SKUs con pre_full>0; vacuously true)'
    WHEN COUNT(*) FILTER (WHERE stock_objetivo <= cycle_stock + safety_stock) = 0
      THEN FORMAT('PASS (%s SKUs, stock_objetivo siempre incluye pre_full)', COUNT(*))
    ELSE FORMAT('FAIL: %s con stock_objetivo no incluye pre_full',
                COUNT(*) FILTER (WHERE stock_objetivo <= cycle_stock + safety_stock))
  END AS result
FROM v_compras_pendientes
WHERE pre_full_target > 0;

-- T04 — Total CLP aumentó significativamente vs Sprint 4 baseline ($787k).
-- Esperable: por orden de magnitud mayor (x2 o más).
SELECT 'T04_clp_increase' AS test,
  CASE
    WHEN SUM(clp_estimado) > 1500000
      THEN FORMAT('PASS (CLP=%s, era $786.900 pre-fix)',
                  ROUND(SUM(clp_estimado))::text)
    ELSE FORMAT('FAIL (CLP=%s, esperado >1.5M)', ROUND(SUM(clp_estimado))::text)
  END AS result
FROM v_compras_pendientes;

-- T05 — Cero CZ en v_compras_pendientes (siguen excluidos por v_safety_stock)
SELECT 'T05_cz_still_excluded' AS test,
  CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE FORMAT('FAIL: %s CZ', COUNT(*)) END AS result
FROM v_compras_pendientes
WHERE cell = 'CZ';
