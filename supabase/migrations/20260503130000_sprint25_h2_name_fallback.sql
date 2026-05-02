-- =============================================================================
-- Sprint 2.5 — Hot fix mitigación H2 vía matching por nombre
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-02
--
-- Audit Sprint 2 reveló 13 SKUs estacionales en celdas activas Y/Z sin flag
-- low_confidence_seasonal: 6 plumones, 5 mantas, 1 frazada, 1 quilt residual.
-- Causa: productos.categoria es agregada (textil=215, otros=97, textil-infantil=29).
-- Plumones, mantas y frazadas adultas están escondidas dentro de "textil"/"otros".
--
-- Camino C híbrido (decisión owner): mantener seasonal_categories (regla 1) +
-- agregar matching por productos.nombre con word boundaries (regla 2).
--
-- Sin esto, agente Reposición v2 (Sprint 4) recomendaría lean buffer (z=1.28)
-- para 13 SKUs estacionales durante temporada peak (mayo-julio Chile).
--
-- Validación: tests/sprint25_validation.sql (8 tests).
-- Ver /docs/sprints/sprint-2.5-h2-name-fallback.md.
-- =============================================================================

-- STEP 1: Agregar columna seasonal_match_source.
ALTER TABLE sku_node_policy
  ADD COLUMN IF NOT EXISTS seasonal_match_source text;

ALTER TABLE sku_node_policy DROP CONSTRAINT IF EXISTS sku_node_policy_seasonal_match_source_check;
ALTER TABLE sku_node_policy ADD CONSTRAINT sku_node_policy_seasonal_match_source_check
  CHECK (seasonal_match_source IS NULL
         OR seasonal_match_source IN ('category','name_pattern','manual','none'));

COMMENT ON COLUMN sku_node_policy.seasonal_match_source IS
  'Origen de la marca xyz_confidence=low_confidence_seasonal: category=match contra seasonal_categories (via productos.categoria), name_pattern=match contra productos.nombre con word boundaries (Sprint 2.5), manual=usuario forzo override, none=SKU no estacional. Permite rastrear cobertura de cada heuristica por separado.';


-- STEP 2: Reescribir calc_sku_node_policy_row con regla 6b (nombre).
-- DROP requerido porque agregamos una columna al RETURN TABLE.
DROP FUNCTION IF EXISTS calc_sku_node_policy_row(text, text);

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
  source_template         text,
  seasonal_match_source   text
) LANGUAGE plpgsql STABLE AS $func$
DECLARE
  v_costo            numeric;
  v_categoria        text;
  v_nombre           text;
  v_abc              text;
  v_xyz              text;
  v_vel_pond         numeric;
  v_template         policy_templates%ROWTYPE;
  v_cell             text;
  v_match_category   boolean := false;
  v_match_name       boolean := false;
  v_seasonal_source  text := 'none';
  v_xyz_confidence   text;
  v_z_efectivo       numeric;
  v_status           text;
BEGIN
  -- 1. Producto: costo + categoría + nombre
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,'')), COALESCE(p.nombre,'')
    INTO v_costo, v_categoria, v_nombre
    FROM productos p
   WHERE p.sku = p_sku_origen
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- 2. sku_intelligence
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

  -- 4. Si bloqueado, devolver fila parcial
  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, v_status, NULL::text, 'none'::text;
    RETURN;
  END IF;

  -- 5. Lookup template por celda
  v_cell := v_abc || v_xyz;
  SELECT * INTO v_template FROM policy_templates pt WHERE pt.cell = v_cell LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id, v_cell,
      NULL::numeric, NULL::numeric, NULL::integer, NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, 'blocked_no_template', NULL::text, 'none'::text;
    RETURN;
  END IF;

  -- 6a. REGLA 1 — match por categoría
  v_match_category := EXISTS (
    SELECT 1 FROM seasonal_categories sc
     WHERE sc.is_active = true
       AND LOWER(sc.category) = v_categoria
  );

  -- 6b. REGLA 2 — match por nombre con word boundaries.
  -- Patron conservador: solo terminos inequivocos.
  -- - plumon / plumón
  -- - frazada / frazadas
  -- - manta / mantas (excluye 'mantel' por word boundary natural)
  -- - sabana termica / sabana térmica (sábanas comunes NO son estacionales)
  -- POSIX ~* es case-insensitive; \m y \M son word boundaries (PostgreSQL).
  v_match_name := v_nombre ~* '\m(plumon|plumón|frazada|frazadas|manta|mantas|s[aá]bana\s+t[eé]rmica)\M';

  -- 6c. Determinar source (prioridad: category > name_pattern)
  IF v_match_category THEN
    v_seasonal_source := 'category';
  ELSIF v_match_name THEN
    v_seasonal_source := 'name_pattern';
  ELSE
    v_seasonal_source := 'none';
  END IF;

  -- 7. xyz_confidence (solo low si Y/Z + alguna regla matcheo)
  IF (v_match_category OR v_match_name) AND v_xyz IN ('Y','Z') THEN
    v_xyz_confidence := 'low_confidence_seasonal';
  ELSE
    v_xyz_confidence := 'high';
  END IF;

  -- 8. Z efectivo
  IF v_xyz_confidence = 'low_confidence_seasonal' THEN
    v_z_efectivo := 1.88;
  ELSE
    v_z_efectivo := v_template.z_value;
  END IF;

  -- 9. Devolver fila completa
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
    v_template.cell,
    v_seasonal_source;
END;
$func$;

COMMENT ON FUNCTION calc_sku_node_policy_row IS
  'Sprint 2.5: agrega regla 6b (matching por productos.nombre con word boundaries) como fallback cuando productos.categoria es agregada y no captura el SKU estacional. Prioridad: category > name_pattern > none. Mitigacion H2 hasta Sprint 7+ con v_cv_52sem deseasonalizado.';


-- STEP 3: Refresh actualizado para incluir seasonal_match_source.
DROP FUNCTION IF EXISTS refresh_sku_node_policy_from_templates();

CREATE OR REPLACE FUNCTION refresh_sku_node_policy_from_templates()
RETURNS TABLE (rows_affected integer) LANGUAGE plpgsql AS $func$
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
        xyz_confidence, policy_status, source_template, seasonal_match_source,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.action, calc.velocidad_observada,
        calc.velocidad_censurada, calc.dias_quiebre_window_30d,
        calc.xyz_confidence, calc.policy_status, calc.source_template,
        calc.seasonal_match_source,
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
        seasonal_match_source   = EXCLUDED.seasonal_match_source,
        updated_at              = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$func$;

COMMENT ON FUNCTION refresh_sku_node_policy_from_templates IS
  'Sprint 2.5: incluye seasonal_match_source en INSERT/UPDATE. Idempotente. Llamado por /api/policy/sync-from-templates (cron lunes 11:30 UTC).';


-- STEP 4: Aplicar refresh inmediatamente.
SELECT * FROM refresh_sku_node_policy_from_templates();
