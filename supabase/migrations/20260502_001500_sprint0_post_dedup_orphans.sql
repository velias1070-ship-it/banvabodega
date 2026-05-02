-- ============================================================
-- Sprint 0 — Post-cleanup: DELETE huérfanos case-insensitive + COMMENT estado_sku
-- Migration ID: 20260502_001500_sprint0_post_dedup_orphans
-- Owner: Vicente Elías
-- Date: 2026-05-02
--
-- Cierre del bucle abierto en 20260501230000_sprint0_master_cleanup, donde se
-- detectaron 2 SKUs en productos que colisionaban case-insensitive con su
-- versión UPPER ya existente y quedaron en _sprint0_dup_skus para revisión.
--
-- Decisión owner (2026-05-02):
--   * DELETE inmediato de las 2 filas non-UPPER. Análisis previo confirmó:
--     0 stock, 0 movimientos, 0 ventas, 0 ml_items_map, 0 composicion_venta,
--     0 sku_intelligence en las non-UPPER. Las UPPER concentran toda la
--     historia operacional (16-18 ud vendidas en enero 2026) y la metadata
--     real (costo=12818, proveedor_id, ítem ML).
--   * NO propagar estado_sku='activo' a las UPPER: los SKUs están dormidos
--     (vel_30d=vel_60d=0 hace ~3 meses), no activos. Dejar NULL hasta el
--     sprint futuro que migrará estado_sku a ENUM con valor 'dormido'.
--
-- Pre-condiciones esperadas:
--   * 7 total productos non-UPPER en el set Sprint 0 — pero sólo 2 colisionan
--     (Bitter, Leche). Los otros 5 ya fueron UPPER-eados in-place.
--   * _sprint0_dup_skus debe contener exactamente esas 2 filas.
-- ============================================================

-- ============================================================
-- STEP 1: Documentar la columna estado_sku para el lector futuro
-- ============================================================
COMMENT ON COLUMN productos.estado_sku IS
'Estado operacional del SKU. Valores observados hoy (2026-05-02): "activo" o NULL. '
'NULL = no clasificado todavía; el sistema infiere actividad desde sku_intelligence '
'(vel_30d, vel_60d, dias_en_quiebre). Sprint futuro migrará esta columna a un '
'ENUM con valores explícitos: "activo" (vel > 0), "dormido" (vel_30d=vel_60d=0 '
'≥ 60 días, fila preservada para histórico), "phaseout" (CZ no_reorder, candidato '
'a borrado), "descontinuado" (snapshot pre-DELETE para auditoría). '
'Actualmente las decisiones operativas usan sku_intelligence + policy_templates, '
'no este campo. NO escribir aquí desde código nuevo hasta que el ENUM exista.';

-- ============================================================
-- STEP 2: Validar pre-condición — exactamente 2 filas huérfanas esperadas
-- ============================================================
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM productos
  WHERE id IN ('39a3cf42-5e8f-4561-bc25-f37aaa8c2239',
               '88a58c50-09d0-488f-9647-64895bb9e0f8');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Esperaba 2 filas non-UPPER en productos (ids fijos), encontré %. Aborto.', v_count;
  END IF;
END $$;

-- ============================================================
-- STEP 3: DELETE las 2 filas huérfanas non-UPPER
-- FK stock(sku) ON DELETE CASCADE — 0 filas afectadas (verificado).
-- No otras FK referencian productos.id.
-- ============================================================
DELETE FROM productos
WHERE id IN ('39a3cf42-5e8f-4561-bc25-f37aaa8c2239',
             '88a58c50-09d0-488f-9647-64895bb9e0f8');

-- ============================================================
-- STEP 4: Limpiar la tabla de auditoría _sprint0_dup_skus
-- ============================================================
DELETE FROM _sprint0_dup_skus
WHERE sku_actual_non_upper IN ('BAR-VIR-DUB-Bitter','BAR-VIR-DUB-Leche');

DO $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM _sprint0_dup_skus;
  IF v_remaining > 0 THEN
    RAISE NOTICE 'AVISO: _sprint0_dup_skus aún tiene % filas sin resolver. NO se dropea la tabla.', v_remaining;
  ELSE
    RAISE NOTICE 'OK: _sprint0_dup_skus vacía. Procediendo a DROP.';
  END IF;
END $$;

-- DROP idempotente — si quedaran filas pendientes, la tabla queda intacta
-- gracias al guard del DO block anterior (deja el RAISE NOTICE pero no aborta).
-- Para forzar el drop sólo cuando esté vacía:
DO $$
DECLARE
  v_remaining INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM _sprint0_dup_skus;
  IF v_remaining = 0 THEN
    EXECUTE 'DROP TABLE IF EXISTS _sprint0_dup_skus';
  END IF;
END $$;
