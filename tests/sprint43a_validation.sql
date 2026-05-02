-- =============================================================================
-- Sprint 4.3a — Validación post-deploy (7 tests)
-- =============================================================================
-- Correr después de:
--   1) 20260504100000_sprint43a_target_dias_flex.sql
--   2) 20260504100100_sprint43a_views_with_old_logic.sql
-- Idempotente: solo lecturas. No escribe nada en producción.
--
-- Notas sobre rangos:
-- - TXV23QLAT20NG (AY): motor viejo dice pedir_proveedor=78 (vel_pre=10.57).
--   Dashboard nuevo agrega reserva_flex_target (target_dias_flex=5d × vel/7 ≈ 8 uds)
--   + diferencias de redondeo, dando ≈ 86. Rango aceptado 78-95 cubre tanto el
--   valor objetivo como la conservación adicional por reserva Flex.
-- - LITAF400G4PCL (AX): motor viejo dice 41. Dashboard nuevo con reserva_flex
--   (target=7d) ≈ 45. Rango aceptado 38-55.
-- =============================================================================

-- T1 — target_dias_flex agregado y poblado en las 9 templates.
SELECT 'T01_target_dias_flex_templates' AS test,
  CASE WHEN COUNT(*) FILTER (WHERE target_dias_flex IS NOT NULL) = 9
       THEN FORMAT('PASS (%s/9 templates con target_dias_flex)',
                   COUNT(*) FILTER (WHERE target_dias_flex IS NOT NULL))
       ELSE FORMAT('FAIL: %s templates con target_dias_flex NULL',
                   COUNT(*) FILTER (WHERE target_dias_flex IS NULL)) END AS result
FROM policy_templates;

-- T2 — TXV23QLAT20NG (AY, en quiebre proveedor) sugiere 78-95 (era 27).
-- Motor viejo: 78 (sin reserva_flex). Dashboard nuevo: ≈86 (con reserva_flex 8).
SELECT 'T02_TXV23QLAT20NG' AS test,
  CASE WHEN qty_a_comprar BETWEEN 78 AND 95
       THEN FORMAT('PASS: qty=%s (era 27, motor viejo=78)', qty_a_comprar)
       ELSE FORMAT('FAIL: qty=%s (esperado 78-95, motor viejo dice 78)', qty_a_comprar)
  END AS result
FROM v_compras_pendientes WHERE sku_origen = 'TXV23QLAT20NG';

-- T3 — LITAF400G4PCL (AX, en quiebre proveedor) sugiere 38-55 (era 33).
SELECT 'T03_LITAF400G4PCL' AS test,
  CASE WHEN qty_a_comprar BETWEEN 38 AND 55
       THEN FORMAT('PASS: qty=%s (era 33, motor viejo=41)', qty_a_comprar)
       ELSE FORMAT('FAIL: qty=%s (esperado 38-55, motor viejo dice 41)', qty_a_comprar)
  END AS result
FROM v_compras_pendientes WHERE sku_origen = 'LITAF400G4PCL';

-- T4 — Reserva Flex calculada en >50 SKUs activos.
SELECT 'T04_reserva_flex_poblada' AS test,
  CASE WHEN COUNT(*) > 50
       THEN FORMAT('PASS (%s SKUs con reserva_flex > 0)', COUNT(*))
       ELSE FORMAT('FAIL: %s SKUs (esperado >50)', COUNT(*)) END AS result
FROM v_compras_pendientes WHERE reserva_flex_target > 0;

-- T5 — SKUs en quiebre proveedor con vel_pre × 2 > vel_act usan vel_pre.
-- d_avg_sem >= vel_pre × factor_rampup × 0.99 (tolerancia round).
SELECT 'T05_quiebre_usa_vel_pre' AS test,
  CASE WHEN COUNT(*) > 0
       THEN FORMAT('PASS (%s SKUs en quiebre prov usan vel_pre)', COUNT(*))
       ELSE 'FAIL: ningún SKU en quiebre proveedor con vel_pre' END AS result
FROM v_safety_stock
WHERE es_quiebre_proveedor = true
  AND vel_pre_quiebre IS NOT NULL AND vel_pre_quiebre > 0
  AND vel_pre_quiebre > COALESCE(vel_actual, 0) * 2
  AND d_avg_sem >= vel_pre_quiebre * COALESCE(factor_rampup_aplicado, 1.0) * 0.99;

-- T6 — Total CLP banner aumenta vs Sprint 4.1 (era ~$6.7M).
SELECT 'T06_total_clp_banner' AS test,
  CASE WHEN SUM(clp_estimado) > 7000000
       THEN FORMAT('PASS: total_clp=%s', ROUND(SUM(clp_estimado))::text)
       ELSE FORMAT('WARN: total_clp=%s bajó vs Sprint 4.1', ROUND(SUM(clp_estimado))::text) END AS result
FROM v_compras_pendientes;

-- T7 — Banner counts informativo.
SELECT 'T07_banner_counts' AS test,
  FORMAT('PASS bajo_rop=%s, total=%s',
         COUNT(*) FILTER (WHERE bajo_rop = true), COUNT(*)) AS result
FROM v_compras_pendientes;
