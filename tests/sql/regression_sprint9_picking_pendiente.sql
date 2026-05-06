-- Sprint 9 P1.8 — Test invariante picking PENDIENTE no causa overshoot Full
-- batch:20260506-sprint-9-picking-pendiente | sprint:9 | milestone:sprint-9-cell-sync-canon
--
-- Invariante T30: cuando hay picking PENDIENTE Bodega→Full activo,
-- la suma de (uds que ya están en el picking) + (uds nuevas que el motor
-- propone mandar) NUNCA debe exceder el deficit_full pre-pickeo.
--
-- Si lo excede, hay overshoot del target_full causado por la ceguera del
-- motor a las uds ya comprometidas en picking PENDIENTE (estado previo a
-- escanear/PICKEADO).
--
-- Caso testigo pre-fix: LITAF400G4PNG con 16 uds picking pendiente,
-- motor sugiere mandar 19 más → 16+19=35 > deficit pre-pickeo 19. FAIL.
--
-- Post-fix esperado: motor descuenta qty_picking_pendiente_full en AMBOS
-- sub-cálculos (deficit_full y disponible_para_full). mandar_full_uds
-- pasa de 19 a 3 → 16+3=19 ≤ 19. PASS.
--
-- Pre-condición: que la implementación exponga la columna
-- `qty_picking_pendiente_full` en v_compras_pendientes. Si todavía no
-- está implementada, el test falla por columna inexistente — esperar
-- a que se aplique la migración del fix doble.

WITH t30 AS (
  SELECT COUNT(*) AS skus_overshoot_picking_pendiente
  FROM v_compras_pendientes vcp
  WHERE qty_picking_pendiente_full > 0
    AND (mandar_full_uds + qty_picking_pendiente_full)
        > GREATEST(0, pre_full_target - stock_full)
)
SELECT
  'T30_picking_pendiente_no_overshoot'::text AS test_name,
  skus_overshoot_picking_pendiente AS valor,
  0 AS esperado,
  CASE WHEN skus_overshoot_picking_pendiente = 0 THEN 'PASS' ELSE 'FAIL' END AS status
FROM t30;
