-- ============================================================
-- Sprint 0 — Master cleanup + foundation IA
-- Migration ID: 20260501230000_sprint0_master_cleanup
-- Owner: Vicente Elías
-- Date: 2026-05-01
-- Decisions closed: H3 (service_level by cell), H2 (XYZ bands), H11 (target_dias_full per cell)
--
-- Format note: this is the first migration in the new YYYYMMDDHHMMSS naming convention
-- (decision 4B). Legacy supabase-vNN-*.sql files at repo root remain unchanged.
--
-- Applied to prod via mcp__supabase__apply_migration on 2026-05-01.
-- All 9 validation tests passed (see tests/sprint0_validation.sql).
-- ============================================================

-- ============================================================
-- STEP 1: DROP zombie table
-- ============================================================
DROP TABLE IF EXISTS _deprecated_ml_velocidad_semanal_2026_05_09;

-- ============================================================
-- STEP 2: Validate productos.precio zombi state, then DROP
-- ============================================================
DO $$
DECLARE
  v_non_zero INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_non_zero FROM productos WHERE precio IS NOT NULL AND precio <> 0;
  IF v_non_zero > 0 THEN
    RAISE EXCEPTION 'productos.precio has % non-zero rows; not safe to drop. Aborting Sprint 0.', v_non_zero;
  END IF;
END $$;

ALTER TABLE productos DROP COLUMN IF EXISTS precio;

-- ============================================================
-- STEP 3: Detect case-insensitive duplicate SKUs (audit before any UPPER)
-- ============================================================
DROP TABLE IF EXISTS _sprint0_dup_skus;

CREATE TABLE _sprint0_dup_skus AS
SELECT
  'productos.sku' AS origen_tabla_columna,
  p1.sku AS sku_actual_non_upper,
  p2.sku AS sku_existente_upper,
  p1.id::text AS pk_non_upper,
  p2.id::text AS pk_upper,
  p1.nombre AS nombre_non_upper,
  p2.nombre AS nombre_upper,
  'merge_required' AS accion_sugerida,
  NOW() AS detected_at
FROM productos p1
JOIN productos p2
  ON p2.sku = UPPER(TRIM(p1.sku))
 AND p2.sku <> p1.sku
WHERE p1.sku <> UPPER(TRIM(p1.sku));

COMMENT ON TABLE _sprint0_dup_skus IS
'Sprint 0 audit: case-insensitive duplicate SKUs detected pre-cleanup. Requires human merge decision before applying UPPER. Created 2026-05-01.';

-- ============================================================
-- STEP 4: UPPER+TRIM non-colliding SKUs
-- ============================================================

-- 4.1 productos: skip the 2 colliding pairs (BAR-VIR-DUB-Bitter, BAR-VIR-DUB-Leche)
UPDATE productos p
SET sku = UPPER(TRIM(p.sku))
WHERE p.sku <> UPPER(TRIM(p.sku))
  AND NOT EXISTS (
    SELECT 1 FROM productos p2
    WHERE p2.sku = UPPER(TRIM(p.sku))
      AND p2.id <> p.id
  );

-- 4.2 stock_full_cache: cache table, all collisions had cantidad=0. Delete non-UPPER rows; cache rebuilds on next ML sync.
DELETE FROM stock_full_cache s
WHERE s.sku_venta <> UPPER(TRIM(s.sku_venta))
  AND EXISTS (
    SELECT 1 FROM stock_full_cache s2
    WHERE s2.sku_venta = UPPER(TRIM(s.sku_venta))
      AND s2.sku_venta <> s.sku_venta
  );

UPDATE stock_full_cache s
SET sku_venta = UPPER(TRIM(s.sku_venta))
WHERE s.sku_venta <> UPPER(TRIM(s.sku_venta))
  AND NOT EXISTS (
    SELECT 1 FROM stock_full_cache s2
    WHERE s2.sku_venta = UPPER(TRIM(s.sku_venta))
      AND s2.sku_venta <> s.sku_venta
  );

-- 4.3 composicion_venta: 0 collisions detected; safe to UPPER both columns
UPDATE composicion_venta cv
SET sku_venta = UPPER(TRIM(cv.sku_venta)),
    sku_origen = UPPER(TRIM(cv.sku_origen))
WHERE (cv.sku_venta <> UPPER(TRIM(cv.sku_venta)))
   OR (cv.sku_origen <> UPPER(TRIM(cv.sku_origen)));

-- 4.4 ml_items_map: 0 collisions detected on (sku, item_id); safe to UPPER all 3 sku columns
UPDATE ml_items_map m
SET sku = UPPER(TRIM(m.sku)),
    sku_venta = COALESCE(UPPER(TRIM(m.sku_venta)), m.sku_venta),
    sku_origen = COALESCE(UPPER(TRIM(m.sku_origen)), m.sku_origen)
WHERE (m.sku IS NOT NULL AND m.sku <> UPPER(TRIM(m.sku)))
   OR (m.sku_venta IS NOT NULL AND m.sku_venta <> UPPER(TRIM(m.sku_venta)))
   OR (m.sku_origen IS NOT NULL AND m.sku_origen <> UPPER(TRIM(m.sku_origen)));

-- ============================================================
-- STEP 5: Foundation IA — policy_action_enum + policy_templates
-- ============================================================

CREATE TYPE policy_action_enum AS ENUM (
  'reorder_normal',
  'reorder_lt_corto',
  'reorder_periodic',
  'reorder_bulk',
  'reorder_minimo',
  'no_reorder'
);

COMMENT ON TYPE policy_action_enum IS
'Acciones de reposición prescritas por celda ABC×XYZ. Mapeadas según SPM:255-265 (Umbrex 9-cell matrix). reorder_normal=ROP+SS estándar. reorder_lt_corto=AZ requiere LT corto (no z alto, per Lokad/Thieuleux SPM:267). reorder_periodic=BZ revisión periódica. reorder_bulk=CX compras grandes infrecuentes. reorder_minimo=CY min effort. no_reorder=CZ phase-out.';

CREATE TABLE policy_templates (
  cell TEXT PRIMARY KEY CHECK (cell ~ '^[ABC][XYZ]$'),
  service_level NUMERIC(5,4) CHECK (service_level IS NULL OR (service_level >= 0 AND service_level <= 1)),
  z_value NUMERIC(5,3) CHECK (z_value IS NULL OR z_value >= 0),
  target_dias_full INTEGER NOT NULL CHECK (target_dias_full >= 0),
  action policy_action_enum NOT NULL,
  source_ref TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE policy_templates IS
'Plantilla canónica por celda ABC×XYZ. Closed via H3+H11+H2 (2026-05-01). Sin overrides aún (Sprint 1 introducirá policy_overrides). Fuente primaria: SPM:255-265 worked example cubrecolchón impermeable 2P; AZ excepción per SPM:267 (Lokad/Thieuleux); CY per Manual_Experto:140; CZ per H3.';

COMMENT ON COLUMN policy_templates.cell IS 'ABC×XYZ cell. ABC: A=top 70%, B=70-90%, C=bottom 10%. XYZ: X=CV<0.25, Y=0.25-0.6, Z>0.6.';
COMMENT ON COLUMN policy_templates.service_level IS 'Probabilidad target de no quiebre durante LT. NULL para CZ (no_reorder).';
COMMENT ON COLUMN policy_templates.z_value IS 'Z-score del SS King Method. NULL para CZ. AX z=2.05 es worked example SPM:713.';
COMMENT ON COLUMN policy_templates.target_dias_full IS 'Días de cobertura target Full ML. 42=conservador A; 28=B; 15=CX; 7=CY; 0=CZ. H11 cerró 2026-05-01.';
COMMENT ON COLUMN policy_templates.action IS 'Acción prescrita por celda. AZ=reorder_lt_corto exige reducir LT (no subir z) per Lokad SPM:267.';
COMMENT ON COLUMN policy_templates.source_ref IS 'Referencia bibliográfica del valor (manual, página, hallazgo).';

INSERT INTO policy_templates (cell, service_level, z_value, target_dias_full, action, source_ref, notes) VALUES
  ('AX', 0.98,  2.05, 42, 'reorder_normal',     'SPM:255-265,713', 'Conservador del rango. Replica worked example cubrecolchón impermeable 2P.'),
  ('AY', 0.96,  1.75, 42, 'reorder_normal',     'SPM:255-265', NULL),
  ('AZ', 0.90,  1.28, 42, 'reorder_lt_corto',   'SPM:267 (Lokad/Thieuleux)', 'Lean del rango. NO subir z; reducir LT.'),
  ('BX', 0.95,  1.65, 28, 'reorder_normal',     'SPM:255-265', NULL),
  ('BY', 0.92,  1.41, 28, 'reorder_normal',     'SPM:255-265', NULL),
  ('BZ', 0.90,  1.28, 28, 'reorder_periodic',   'SPM:255-265', NULL),
  ('CX', 0.90,  1.28, 15, 'reorder_bulk',       'Gestion:265', 'Borde inferior rango.'),
  ('CY', 0.85,  1.04, 7,  'reorder_minimo',     'Manual_Experto:140', 'Mínimo esfuerzo.'),
  ('CZ', NULL,  NULL, 0,  'no_reorder',         'SPM:683 + H3', 'No se recompra.');
