-- =============================================================================
-- Sprint 2 — Populate sku_node_policy desde policy_templates × clasificación
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-02
-- Decisiones cerradas: H1 (Pareto 70/90), H2 (xyz status quo + flag confidence
--   estacional, Sprint 7+ deseasonaliza), H3 (9 celdas SL+z), H5 (Camino C),
--   H11 (target_dias_full diferencial). Opción A: TODOS los SKUs activos × 2
--   nodos (warehouse + fulfillment); CZ entran con action=no_reorder explícito.
--
-- Cambio de diseño vs Sprint 1:
--   sku_node_policy estaba vacía (override-only schema). Sprint 2 la convierte
--   en SNAPSHOT: una fila por (sku_origen, node_id) con valores concretos.
--   manual_override=true preserva la fila contra el cron de re-sync.
--   Por eso la migración dropea las columnas *_override de Sprint 1 (la tabla
--   está vacía, no hay data loss) y agrega columnas de snapshot.
--
-- [non-reversible:sprint1-empty-table-redesigned-snapshot-model]
--
-- Frontera Reposición/Pricing actualizada en
-- /docs/policies/frontera-reposicion-pricing.md (re-derivada con nuevo modelo).
--
-- Validación: tests/sprint2_validation.sql (13 tests).
-- =============================================================================

-- STEP 1: Tabla seasonal_categories (mitigación H2 - flag estacional).
CREATE TABLE IF NOT EXISTS seasonal_categories (
  category   text PRIMARY KEY,
  reason     text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  added_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE seasonal_categories IS
  'Categorías textil hogar Chile con estacionalidad fuerte. Match contra
   LOWER(productos.categoria). Productos con categoría acá + xyz IN (Y,Z)
   reciben xyz_confidence=low_confidence_seasonal y z_score fallback (1.88,
   conservador) en lugar del z bajo de la celda AZ/BZ. H2 backlog: cuando
   ≥80% del catálogo tenga 52 semanas de historia (ETA Sprint 7+, ~2027-04),
   se reemplaza esta tabla por v_cv_52sem deseasonalizada + xyz_confidence
   derivado.';

-- Seed: la categoría real de productos.categoria que tiene material seasonal
-- es "quilt" (101 productos al 2026-05-02). Las otras (plumones, frazadas, etc.)
-- son seeds aspiracionales: hoy no hay productos con esos valores en
-- productos.categoria (que es de granularidad alta: textil/quilt/otros/
-- alfombras/textil - infantil), pero quedan documentados para cuando categoría
-- se refine. is_active=false marca los aspiracionales hasta que matcheen algo.
INSERT INTO seasonal_categories (category, reason, is_active) VALUES
  ('quilt',            'Categoría real (101 productos). Pico invierno mayo-agosto. CV crudo infla.', true),
  ('quilts',           'Alias plural — spec original; productos.categoria usa singular.',            false),
  ('plumones',         'Aspiracional. Hoy productos.categoria solo tiene textil/quilt/otros/alfombras/textil-infantil.', false),
  ('frazadas',         'Aspiracional. Idem plumones.',                                               false),
  ('sabanas_termicas', 'Aspiracional. Solo invierno.',                                               false),
  ('mantas',           'Aspiracional. Estacionalidad invierno.',                                     false)
ON CONFLICT (category) DO UPDATE SET reason=EXCLUDED.reason, is_active=EXCLUDED.is_active;


-- STEP 2: Reshape sku_node_policy a snapshot model.
-- Tabla está vacía (0 rows pre-migration, baseline.json) — drop seguro.
-- Las _override columns del Sprint 1 quedaron sin uso porque la frontera v1
-- nunca se llenó. Sprint 2 reemplaza el pattern por full-snapshot + flag.

ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS service_level_override;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS z_value_override;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS target_dias_override;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS reorder_action_override;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS lead_time_override_days;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS rampup_factor_override;
ALTER TABLE sku_node_policy DROP COLUMN IF EXISTS override_reason;

-- Nuevas columnas snapshot. Nombres: cell, service_level, z_value, target_dias_full,
-- action — alineados con policy_templates (mismas semantics, mismo enum).
-- velocidad_observada se popula en Sprint 2; *_censurada y dias_quiebre en Sprint 3.
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS cell                    text;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS service_level           numeric(4,3);
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS z_value                 numeric(4,3);
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS target_dias_full        integer;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS action                  policy_action_enum;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS velocidad_observada     numeric;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS velocidad_censurada     numeric;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS dias_quiebre_window_30d integer;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS xyz_confidence          text;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS policy_status           text NOT NULL DEFAULT 'active';
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS source_template         text;
ALTER TABLE sku_node_policy ADD COLUMN IF NOT EXISTS manual_override         boolean NOT NULL DEFAULT false;

ALTER TABLE sku_node_policy DROP CONSTRAINT IF EXISTS sku_node_policy_policy_status_check;
ALTER TABLE sku_node_policy ADD CONSTRAINT sku_node_policy_policy_status_check
  CHECK (policy_status IN ('active','blocked_no_cost','blocked_no_history','blocked_no_template'));

ALTER TABLE sku_node_policy DROP CONSTRAINT IF EXISTS sku_node_policy_xyz_confidence_check;
ALTER TABLE sku_node_policy ADD CONSTRAINT sku_node_policy_xyz_confidence_check
  CHECK (xyz_confidence IS NULL OR xyz_confidence IN ('high','low_confidence_seasonal'));

CREATE INDEX IF NOT EXISTS idx_sku_node_policy_cell ON sku_node_policy(cell);
CREATE INDEX IF NOT EXISTS idx_sku_node_policy_status ON sku_node_policy(policy_status);

COMMENT ON TABLE sku_node_policy IS
  'Política de inventario por SKU×Nodo (snapshot, Sprint 2). Una fila por
   cada (sku_origen, node_id) activo. Lookup desde policy_templates por cell
   (ABC×XYZ). manual_override=true preserva la fila contra el cron weekly
   /api/policy/sync-from-templates. Cambio de diseño vs Sprint 1: pasó de
   override-only (vacía) a snapshot (poblada). Frontera Reposición/Pricing
   re-derivada en /docs/policies/frontera-reposicion-pricing.md.';
COMMENT ON COLUMN sku_node_policy.cell             IS 'ABC×XYZ derivada de sku_intelligence (abc_unidades || xyz). NULL si SKU sin clasificación.';
COMMENT ON COLUMN sku_node_policy.service_level    IS 'Service level efectivo. Default = policy_templates.service_level por celda.';
COMMENT ON COLUMN sku_node_policy.z_value          IS 'Z efectivo. Si xyz_confidence=low_confidence_seasonal, fallback 1.88 (conservador) en vez de z de la celda. Sprint 7+ revisita con CV52 deseasonalizado.';
COMMENT ON COLUMN sku_node_policy.target_dias_full IS 'Target días Full. Default = policy_templates.target_dias_full por celda.';
COMMENT ON COLUMN sku_node_policy.action           IS 'Acción canónica. Default = policy_templates.action. Para CZ siempre no_reorder explícito.';
COMMENT ON COLUMN sku_node_policy.velocidad_observada IS 'sku_intelligence.vel_ponderada al momento del último refresh. Sprint 3 agrega velocidad_censurada.';
COMMENT ON COLUMN sku_node_policy.velocidad_censurada IS 'NULL en Sprint 2. Sprint 3 popula con velocidad censurando semanas con ≥3 días en quiebre.';
COMMENT ON COLUMN sku_node_policy.dias_quiebre_window_30d IS 'NULL en Sprint 2. Sprint 3 popula.';
COMMENT ON COLUMN sku_node_policy.xyz_confidence   IS 'high (CV crudo confiable) | low_confidence_seasonal (categoría estacional, fallback z=1.88). H2 mitigation.';
COMMENT ON COLUMN sku_node_policy.policy_status    IS 'active | blocked_no_cost | blocked_no_history | blocked_no_template. Filas blocked tienen valores de política NULL.';
COMMENT ON COLUMN sku_node_policy.source_template  IS 'Cell del template usado (= cell). NULL si blocked.';
COMMENT ON COLUMN sku_node_policy.manual_override  IS 'true → cron weekly NO re-escribe esta fila. Para excepciones documentadas.';


-- STEP 3: Función pura calc_sku_node_policy_row (idempotente).
CREATE OR REPLACE FUNCTION calc_sku_node_policy_row(
  p_sku_origen text,
  p_node_id    text
) RETURNS TABLE (
  sku_origen              text,
  node_id                 text,
  cell                    text,
  service_level           numeric,
  z_value                 numeric,
  target_dias_full        integer,
  action                  policy_action_enum,
  velocidad_observada     numeric,
  velocidad_censurada     numeric,
  dias_quiebre_window_30d integer,
  xyz_confidence          text,
  policy_status           text,
  source_template         text
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_costo            numeric;
  v_categoria        text;
  v_abc              text;
  v_xyz              text;
  v_vel_pond         numeric;
  v_template         policy_templates%ROWTYPE;
  v_cell             text;
  v_is_seasonal      boolean;
  v_xyz_confidence   text;
  v_z_efectivo       numeric;
  v_status           text;
BEGIN
  -- 1. Producto: costo + categoría
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,''))
    INTO v_costo, v_categoria
    FROM productos p
   WHERE p.sku = p_sku_origen
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;  -- SKU inexistente: no devolver fila
  END IF;

  -- 2. sku_intelligence: clasificación
  SELECT si.abc_unidades, si.xyz, si.vel_ponderada
    INTO v_abc, v_xyz, v_vel_pond
    FROM sku_intelligence si
   WHERE si.sku_origen = p_sku_origen
   LIMIT 1;

  -- 3. Pre-checks de bloqueo
  IF v_costo IS NULL OR v_costo = 0 THEN
    v_status := 'blocked_no_cost';
  ELSIF v_abc IS NULL OR v_xyz IS NULL THEN
    v_status := 'blocked_no_history';
  ELSE
    v_status := 'active';
  END IF;

  -- 4. Si bloqueado, devolver fila con política NULL
  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, v_status, NULL::text;
    RETURN;
  END IF;

  -- 5. Lookup template por celda
  v_cell := v_abc || v_xyz;
  SELECT * INTO v_template FROM policy_templates pt WHERE pt.cell = v_cell LIMIT 1;
  IF NOT FOUND THEN
    -- Celda inválida (no debería ocurrir con seed Sprint 0)
    RETURN QUERY SELECT
      p_sku_origen, p_node_id, v_cell,
      NULL::numeric, NULL::numeric, NULL::integer, NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, 'blocked_no_template', NULL::text;
    RETURN;
  END IF;

  -- 6. xyz_confidence (mitigación H2)
  v_is_seasonal := EXISTS (
    SELECT 1 FROM seasonal_categories sc
     WHERE sc.is_active = true
       AND LOWER(sc.category) = v_categoria
  );
  IF v_is_seasonal AND v_xyz IN ('Y','Z') THEN
    v_xyz_confidence := 'low_confidence_seasonal';
  ELSE
    v_xyz_confidence := 'high';
  END IF;

  -- 7. z efectivo: fallback conservador 1.88 si low_confidence_seasonal
  IF v_xyz_confidence = 'low_confidence_seasonal' THEN
    v_z_efectivo := 1.88;
  ELSE
    v_z_efectivo := v_template.z_value;
  END IF;

  -- 8. Devolver fila completa
  RETURN QUERY SELECT
    p_sku_origen,
    p_node_id,
    v_template.cell,
    v_template.service_level,
    v_z_efectivo,
    v_template.target_dias_full,
    v_template.action,
    COALESCE(v_vel_pond, 0)::numeric,
    NULL::numeric,
    NULL::integer,
    v_xyz_confidence,
    'active',
    v_template.cell;
END;
$$;

COMMENT ON FUNCTION calc_sku_node_policy_row IS
  'Función pura: calcula una fila candidata de sku_node_policy para (sku, node).
   Lee productos (costo, categoría), sku_intelligence (clasificación),
   policy_templates (canónico por celda), seasonal_categories (mitigación H2).
   No escribe. Idempotente. Sprint 2.';


-- STEP 4: RPC refresh_sku_node_policy_from_templates.
CREATE OR REPLACE FUNCTION refresh_sku_node_policy_from_templates()
RETURNS TABLE (rows_affected integer) LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  WITH
    skus_activos AS (
      SELECT sku FROM productos
       WHERE estado_sku = 'activo' OR estado_sku IS NULL
    ),
    nodos_inv AS (
      SELECT id FROM nodes WHERE node_type IN ('warehouse','fulfillment')
    ),
    combos AS (
      SELECT s.sku AS sku_origen, n.id AS node_id
        FROM skus_activos s CROSS JOIN nodos_inv n
    ),
    upserted AS (
      INSERT INTO sku_node_policy (
        sku_origen, node_id, cell, service_level, z_value, target_dias_full,
        action, velocidad_observada, velocidad_censurada, dias_quiebre_window_30d,
        xyz_confidence, policy_status, source_template, manual_override,
        created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.action, calc.velocidad_observada,
        calc.velocidad_censurada, calc.dias_quiebre_window_30d,
        calc.xyz_confidence, calc.policy_status, calc.source_template,
        false, now(), now()
      FROM combos c
      CROSS JOIN LATERAL calc_sku_node_policy_row(c.sku_origen, c.node_id) calc
      ON CONFLICT (sku_origen, node_id) DO UPDATE SET
        cell                    = EXCLUDED.cell,
        service_level           = EXCLUDED.service_level,
        z_value                 = EXCLUDED.z_value,
        target_dias_full        = EXCLUDED.target_dias_full,
        action                  = EXCLUDED.action,
        velocidad_observada     = EXCLUDED.velocidad_observada,
        xyz_confidence          = EXCLUDED.xyz_confidence,
        policy_status           = EXCLUDED.policy_status,
        source_template         = EXCLUDED.source_template,
        updated_at              = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$$;

COMMENT ON FUNCTION refresh_sku_node_policy_from_templates IS
  'Recalcula sku_node_policy desde policy_templates × sku_intelligence × productos.
   Preserva manual_override=true. Idempotente. Llamado por
   /api/policy/sync-from-templates (Vercel cron lunes 11:30 UTC, Sprint 2).';


-- STEP 5: Backfill inicial — invocar la RPC.
-- Idempotente: re-correr produce el mismo estado.
SELECT * FROM refresh_sku_node_policy_from_templates();


-- STEP 6: Vista v_sku_policy_diff (auditoría).
CREATE OR REPLACE VIEW v_sku_policy_diff AS
SELECT
  snp.sku_origen,
  snp.node_id,
  snp.cell,
  snp.z_value           AS z_actual,
  pt.z_value            AS z_template,
  snp.target_dias_full  AS target_actual,
  pt.target_dias_full   AS target_template,
  snp.action            AS action_actual,
  pt.action             AS action_template,
  snp.manual_override,
  snp.xyz_confidence,
  snp.policy_status,
  CASE
    WHEN snp.manual_override                          THEN 'override_manual'
    WHEN snp.xyz_confidence = 'low_confidence_seasonal' THEN 'fallback_seasonal'
    WHEN snp.policy_status <> 'active'                  THEN 'blocked'
    WHEN pt.cell IS NULL                                THEN 'blocked'
    WHEN snp.z_value          IS NOT DISTINCT FROM pt.z_value
     AND snp.target_dias_full IS NOT DISTINCT FROM pt.target_dias_full
     AND snp.action           IS NOT DISTINCT FROM pt.action       THEN 'aligned'
    ELSE 'drift_unexpected'
  END AS diff_status
FROM sku_node_policy snp
LEFT JOIN policy_templates pt ON pt.cell = snp.cell;

COMMENT ON VIEW v_sku_policy_diff IS
  'Auditoría: para cada (sku_origen, node_id), compara contra policy_templates.
   diff_status: override_manual | fallback_seasonal | blocked | aligned |
   drift_unexpected. drift_unexpected debería ser 0 bajo proceso normal.';
