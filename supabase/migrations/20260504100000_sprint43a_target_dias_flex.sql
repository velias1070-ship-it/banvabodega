-- =============================================================================
-- Sprint 4.3a — Schema: target_dias_flex separado por celda
-- =============================================================================
-- Owner: Vicente Elías
-- Fecha: 2026-05-04
-- Tag PR: [batch:20260504-1]
--
-- Hasta Sprint 4.2.1 sólo existía `target_dias_full` (cobertura objetivo en
-- Full ML). La reserva Flex se calculaba implícita contra el mismo target —
-- spec del owner exige separar canales con cobertura propia (Manual prescribe
-- Full=30 / Flex=45 — adaptado a BANVA: 60d crédito Idetex + 60d storage fee
-- ML hacen que conservar más en bodega tenga costo, así que valores Flex son
-- conservadores: AX=7 / AY=5 / AZ=3 / BX=5 / BY=3 / BZ=2 / CX=3 / CY=2 / CZ=0).
--
-- Aditivo: NO modifica filas existentes, sólo ADD COLUMN + UPDATE backfill.
-- target_dias_flex SET NOT NULL después de poblar las 9 celdas (no más, no
-- menos: el seed Sprint 0 las garantiza).
--
-- sku_node_policy: ADD target_dias_flex (snapshot, replicado del template) +
-- flex_priority (override de canal por SKU). flex_priority queda nullable
-- (NULL = default = política normal Full > Flex de P-INV-1).
--
-- Función calc_sku_node_policy_row + RPC refresh_sku_node_policy_from_templates
-- se actualizan para propagar target_dias_flex desde template a snapshot.
-- =============================================================================

-- STEP 1: policy_templates — agregar columna y poblar las 9 celdas.
ALTER TABLE policy_templates
  ADD COLUMN IF NOT EXISTS target_dias_flex INTEGER;

UPDATE policy_templates SET target_dias_flex = CASE cell
  WHEN 'AX' THEN 7
  WHEN 'AY' THEN 5
  WHEN 'AZ' THEN 3
  WHEN 'BX' THEN 5
  WHEN 'BY' THEN 3
  WHEN 'BZ' THEN 2
  WHEN 'CX' THEN 3
  WHEN 'CY' THEN 2
  WHEN 'CZ' THEN 0
END
WHERE target_dias_flex IS NULL;

ALTER TABLE policy_templates
  ALTER COLUMN target_dias_flex SET NOT NULL;

ALTER TABLE policy_templates
  ADD CONSTRAINT policy_templates_target_dias_flex_check
  CHECK (target_dias_flex >= 0);

COMMENT ON COLUMN policy_templates.target_dias_flex IS
  'Días de cobertura objetivo en Bodega para venta Flex (separado de
   target_dias_full que aplica a Full ML). Sprint 4.3a: valores conservadores
   por celda (AX=7, AZ=3, CZ=0). Adaptado a BANVA: 60d crédito Idetex + 60d
   storage fee ML hacen costoso retener stock. Override por SKU vía
   sku_node_policy.target_dias_flex (cuando manual_override=true).';


-- STEP 2: sku_node_policy — ADD target_dias_flex + flex_priority.
ALTER TABLE sku_node_policy
  ADD COLUMN IF NOT EXISTS target_dias_flex INTEGER,
  ADD COLUMN IF NOT EXISTS flex_priority   TEXT;

ALTER TABLE sku_node_policy
  DROP CONSTRAINT IF EXISTS sku_node_policy_flex_priority_check;
ALTER TABLE sku_node_policy
  ADD CONSTRAINT sku_node_policy_flex_priority_check
  CHECK (flex_priority IS NULL
         OR flex_priority IN ('default','only_flex','only_full','manual_split'));

COMMENT ON COLUMN sku_node_policy.target_dias_flex IS
  'Snapshot del target_dias_flex del template para esta celda. Replicado por
   refresh_sku_node_policy_from_templates(). manual_override=true preserva
   esta fila contra el cron weekly.';

COMMENT ON COLUMN sku_node_policy.flex_priority IS
  'Prioridad de canal para este SKU:
   - default (NULL incluida): política normal Full > Flex (P-INV-1).
   - only_flex: NO mandar a Full, sólo Flex.
   - only_full: NO reservar para Flex, todo a Full.
   - manual_split: split manual por OC.
   Sólo aplica al nodo bodega_central.';


-- STEP 3: Re-crear calc_sku_node_policy_row con target_dias_flex.
-- Mantiene firma + lógica previa; sólo agrega un OUT col.
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
  target_dias_flex        integer,
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
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,''))
    INTO v_costo, v_categoria
    FROM productos p
   WHERE p.sku = p_sku_origen
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT si.abc_unidades, si.xyz, si.vel_ponderada
    INTO v_abc, v_xyz, v_vel_pond
    FROM sku_intelligence si
   WHERE si.sku_origen = p_sku_origen
   LIMIT 1;

  IF v_costo IS NULL OR v_costo = 0 THEN
    v_status := 'blocked_no_cost';
  ELSIF v_abc IS NULL OR v_xyz IS NULL THEN
    v_status := 'blocked_no_history';
  ELSE
    v_status := 'active';
  END IF;

  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, v_status, NULL::text;
    RETURN;
  END IF;

  v_cell := v_abc || v_xyz;
  SELECT * INTO v_template FROM policy_templates pt WHERE pt.cell = v_cell LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id, v_cell,
      NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum,
      COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer,
      NULL::text, 'blocked_no_template', NULL::text;
    RETURN;
  END IF;

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

  IF v_xyz_confidence = 'low_confidence_seasonal' THEN
    v_z_efectivo := 1.88;
  ELSE
    v_z_efectivo := v_template.z_value;
  END IF;

  RETURN QUERY SELECT
    p_sku_origen,
    p_node_id,
    v_template.cell,
    v_template.service_level,
    v_z_efectivo,
    v_template.target_dias_full,
    v_template.target_dias_flex,
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
  'Sprint 4.3a: agrega target_dias_flex al output (snapshot del template).
   Resto idéntico a Sprint 2. Idempotente.';


-- STEP 4: Re-crear refresh_sku_node_policy_from_templates con propagación de
-- target_dias_flex. flex_priority NO se toca acá (queda en NULL/default; sólo
-- la edita el admin manualmente).
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
        target_dias_flex, action, velocidad_observada, velocidad_censurada,
        dias_quiebre_window_30d, xyz_confidence, policy_status, source_template,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.target_dias_flex, calc.action,
        calc.velocidad_observada, calc.velocidad_censurada,
        calc.dias_quiebre_window_30d, calc.xyz_confidence, calc.policy_status,
        calc.source_template, false, now(), now()
      FROM combos c
      CROSS JOIN LATERAL calc_sku_node_policy_row(c.sku_origen, c.node_id) calc
      ON CONFLICT (sku_origen, node_id) DO UPDATE SET
        cell                    = EXCLUDED.cell,
        service_level           = EXCLUDED.service_level,
        z_value                 = EXCLUDED.z_value,
        target_dias_full        = EXCLUDED.target_dias_full,
        target_dias_flex        = EXCLUDED.target_dias_flex,
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
  'Sprint 4.3a: propaga target_dias_flex de policy_templates a sku_node_policy
   en cada refresh. Preserva manual_override=true. Idempotente.';


-- STEP 5: Backfill — invocar la RPC para poblar target_dias_flex en filas
-- existentes (snapshot ya pobladas en Sprint 2).
SELECT * FROM refresh_sku_node_policy_from_templates();


-- STEP 6: Validar invariantes post-deploy.
-- Las 9 templates deben tener target_dias_flex NOT NULL.
DO $$
DECLARE v_null_templates integer;
BEGIN
  SELECT COUNT(*) INTO v_null_templates FROM policy_templates WHERE target_dias_flex IS NULL;
  IF v_null_templates > 0 THEN
    RAISE EXCEPTION 'Sprint 4.3a invariant violation: % templates con target_dias_flex NULL', v_null_templates;
  END IF;
END $$;

-- Filas active de sku_node_policy deben tener target_dias_flex NOT NULL
-- (las blocked_* mantienen NULL legítimamente).
DO $$
DECLARE v_null_active integer;
BEGIN
  SELECT COUNT(*) INTO v_null_active
    FROM sku_node_policy
   WHERE policy_status = 'active' AND target_dias_flex IS NULL;
  IF v_null_active > 0 THEN
    RAISE EXCEPTION 'Sprint 4.3a invariant violation: % filas active sin target_dias_flex', v_null_active;
  END IF;
END $$;

-- =============================================================================
-- Fin Sprint 4.3a STEP 1 (schema). Ver 20260504100100 para vistas.
-- =============================================================================
