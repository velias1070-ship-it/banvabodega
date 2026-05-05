-- =============================================================================
-- Sprint 6 — Fase 2: accion + prioridad persistidas en sku_node_policy
-- =============================================================================
-- batch:20260504-sprint-6-cerrar-gap | sprint:6 | fase:2
--
-- Cambios:
--  1. CREATE TYPE policy_accion_enum (no confundir con policy_action_enum,
--     que es el reorder_normal/reorder_lt_corto/etc. de la columna `action`).
--  2. ALTER TABLE sku_node_policy ADD accion + prioridad.
--  3. DROP/CREATE calc_sku_node_policy_row con árbol de decisión port motor
--     viejo (intelligence.ts:1486-1507) + override EN_TRANSITO.
--  4. DROP/CREATE refresh_sku_node_policy_from_templates con upsert extendido.
--  5. Backfill inline.
--
-- IMPORTANTE — alcance Fase 2 vs Fase 3:
--  Las ramas `is_new_sku → MANDAR_FULL/NUEVO` quedan FUERA en Fase 2 (esa
--  columna entra en Fase 3). Mientras tanto, SKUs sin ventas con stock caen
--  en DEAD_STOCK (igual al motor viejo cuando movimientoReciente=false).
-- =============================================================================

-- 1. ENUM
CREATE TYPE policy_accion_enum AS ENUM (
  'INACTIVO',
  'AGOTADO_SIN_PROVEEDOR',
  'AGOTADO_PEDIR',
  'MANDAR_FULL',
  'URGENTE',
  'EN_TRANSITO',
  'PLANIFICAR',
  'NUEVO',
  'OK',
  'EXCESO',
  'DEAD_STOCK'
);

-- 2. Columnas
ALTER TABLE sku_node_policy
  ADD COLUMN accion policy_accion_enum,
  ADD COLUMN prioridad smallint;

COMMENT ON COLUMN sku_node_policy.accion IS
  'Sprint 6 Fase 2: acción operativa portada del motor viejo. Se actualiza en
   refresh_sku_node_policy_from_templates() (cron sync-from-templates).';
COMMENT ON COLUMN sku_node_policy.prioridad IS
  'Sprint 6 Fase 2: prioridad numérica derivada de accion. 3=AGOTADO_SIN_PROVEEDOR,
   5=AGOTADO_PEDIR, 10=MANDAR_FULL, 15=URGENTE, 25=EN_TRANSITO, 40=PLANIFICAR,
   50=NUEVO, 60=OK, 70=EXCESO, 80=DEAD_STOCK, 99=INACTIVO.';

-- 3. calc_sku_node_policy_row — extendida con accion + prioridad
DROP FUNCTION IF EXISTS calc_sku_node_policy_row(text, text);

CREATE OR REPLACE FUNCTION public.calc_sku_node_policy_row(p_sku_origen text, p_node_id text)
RETURNS TABLE(
  sku_origen text,
  node_id text,
  cell text,
  service_level numeric,
  z_value numeric,
  target_dias_full integer,
  target_dias_flex integer,
  action policy_action_enum,
  velocidad_observada numeric,
  velocidad_censurada numeric,
  dias_quiebre_window_30d integer,
  xyz_confidence text,
  policy_status text,
  source_template text,
  accion policy_accion_enum,
  prioridad smallint
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  -- Producto
  v_costo numeric; v_categoria text; v_estado_sku text;
  -- sku_intelligence
  v_abc text; v_xyz text;
  v_vel_pond numeric; v_vel_pre numeric; v_vel_full numeric;
  v_dias_en_quiebre integer; v_dias_sin_mov integer;
  v_st_total integer; v_st_bodega integer; v_st_full integer;
  v_st_en_transito integer; v_stock_proveedor integer;
  v_tiene_stock_prov_si boolean;
  v_cob_full numeric; v_punto_reorden numeric;
  -- Templates
  v_template policy_templates%ROWTYPE;
  v_cell text; v_is_seasonal boolean;
  v_xyz_confidence text; v_z_efectivo numeric;
  v_status text;
  -- Árbol
  v_tiene_stock_prov boolean;
  v_es_quiebre_prov boolean;
  v_en_quiebre_prol boolean;
  v_accion policy_accion_enum;
  v_prioridad smallint;
  -- Constantes (port DEFAULT_INTEL_CONFIG, intelligence.ts:387)
  c_cob_maxima numeric := 60;
BEGIN
  -- Lectura producto
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,'')), p.estado_sku
    INTO v_costo, v_categoria, v_estado_sku
    FROM productos p WHERE p.sku = p_sku_origen LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  -- Lectura sku_intelligence (stock_proveedor + tiene_stock_prov viven aca)
  SELECT si.abc_unidades, si.xyz, si.vel_ponderada, si.vel_pre_quiebre, si.vel_full,
         si.dias_en_quiebre, si.dias_sin_movimiento,
         si.stock_total, si.stock_bodega, si.stock_full, si.stock_en_transito,
         si.stock_proveedor, si.tiene_stock_prov,
         si.cob_full, si.punto_reorden
    INTO v_abc, v_xyz, v_vel_pond, v_vel_pre, v_vel_full,
         v_dias_en_quiebre, v_dias_sin_mov,
         v_st_total, v_st_bodega, v_st_full, v_st_en_transito,
         v_stock_proveedor, v_tiene_stock_prov_si,
         v_cob_full, v_punto_reorden
    FROM sku_intelligence si
   WHERE si.sku_origen = p_sku_origen LIMIT 1;

  -- Status base (igual a versión Sprint 4.3a)
  IF v_costo IS NULL OR v_costo = 0 THEN v_status := 'blocked_no_cost';
  ELSIF v_abc IS NULL OR v_xyz IS NULL THEN v_status := 'blocked_no_history';
  ELSE v_status := 'active'; END IF;

  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum, COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer, NULL::text, v_status, NULL::text,
      NULL::policy_accion_enum, NULL::smallint;
    RETURN;
  END IF;

  v_cell := v_abc || v_xyz;
  SELECT * INTO v_template FROM policy_templates pt WHERE pt.cell = v_cell LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id, v_cell,
      NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum, COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer, NULL::text, 'blocked_no_template', NULL::text,
      NULL::policy_accion_enum, NULL::smallint;
    RETURN;
  END IF;

  v_is_seasonal := EXISTS (SELECT 1 FROM seasonal_categories sc
    WHERE sc.is_active = true AND LOWER(sc.category) = v_categoria);
  IF v_is_seasonal AND v_xyz IN ('Y','Z') THEN v_xyz_confidence := 'low_confidence_seasonal';
  ELSE v_xyz_confidence := 'high'; END IF;

  IF v_xyz_confidence = 'low_confidence_seasonal' THEN v_z_efectivo := 1.88;
  ELSE v_z_efectivo := v_template.z_value; END IF;

  -- ── Árbol de decisión accion + prioridad ──
  -- Sprint 6 Fase 2: replica motor viejo intelligence.ts:1486-1507.
  -- Las ramas is_new_sku entran en Fase 3.

  -- Stock proveedor optimismo (intelligence.ts:1330-1331)
  -- Preferir el flag de sku_intelligence si esta disponible; si no, derivar.
  v_tiene_stock_prov := COALESCE(v_tiene_stock_prov_si,
                                 (v_stock_proveedor IS NULL OR v_stock_proveedor > 0));
  v_es_quiebre_prov := (NOT v_tiene_stock_prov) OR v_estado_sku = 'sin_stock_proveedor';

  -- Quiebre prolongado: alineado con Fase 1 (dias>=14 + vel_pre>vel_pond)
  v_en_quiebre_prol := (v_dias_en_quiebre IS NOT NULL AND v_dias_en_quiebre >= 14
                        AND COALESCE(v_vel_pre, 0) > COALESCE(v_vel_pond, 0)
                        AND COALESCE(v_vel_pre, 0) > 0);

  -- Árbol (orden importa)
  IF COALESCE(v_vel_pond, 0) = 0 AND COALESCE(v_vel_pre, 0) = 0
     AND COALESCE(v_st_total, 0) = 0 THEN
    v_accion := 'INACTIVO'; v_prioridad := 99;

  ELSIF COALESCE(v_vel_pond, 0) = 0 AND COALESCE(v_vel_pre, 0) = 0
        AND COALESCE(v_st_total, 0) > 0 THEN
    v_accion := 'DEAD_STOCK'; v_prioridad := 80;

  ELSIF COALESCE(v_st_full, 0) = 0
        AND (COALESCE(v_vel_full, 0) > 0 OR v_en_quiebre_prol)
        AND COALESCE(v_st_bodega, 0) > 0 THEN
    v_accion := 'MANDAR_FULL'; v_prioridad := 10;

  ELSIF COALESCE(v_st_full, 0) = 0
        AND (COALESCE(v_vel_full, 0) > 0 OR v_en_quiebre_prol)
        AND COALESCE(v_st_bodega, 0) = 0
        AND (v_es_quiebre_prov OR NOT v_tiene_stock_prov) THEN
    v_accion := 'AGOTADO_SIN_PROVEEDOR'; v_prioridad := 3;

  ELSIF COALESCE(v_st_full, 0) = 0
        AND (COALESCE(v_vel_full, 0) > 0 OR v_en_quiebre_prol)
        AND COALESCE(v_st_bodega, 0) = 0 THEN
    v_accion := 'AGOTADO_PEDIR'; v_prioridad := 5;

  ELSIF COALESCE(v_cob_full, 999) < COALESCE(v_punto_reorden, 0)
        AND COALESCE(v_cob_full, 999) < 999 THEN
    v_accion := 'URGENTE'; v_prioridad := 15;

  ELSIF COALESCE(v_cob_full, 999) < 30 THEN
    v_accion := 'PLANIFICAR'; v_prioridad := 40;

  ELSIF COALESCE(v_cob_full, 999) <= c_cob_maxima THEN
    v_accion := 'OK'; v_prioridad := 60;

  ELSE
    v_accion := 'EXCESO'; v_prioridad := 70;
  END IF;

  -- Override EN_TRANSITO (intelligence.ts:1499-1505)
  IF v_accion IN ('URGENTE','AGOTADO_PEDIR')
     AND COALESCE(v_st_en_transito, 0) > 0
     AND COALESCE(v_vel_full, 0) > 0
     AND (v_st_en_transito::numeric / v_vel_full * 7) >= 7 THEN
    v_accion := 'EN_TRANSITO'; v_prioridad := 25;
  END IF;

  RETURN QUERY SELECT
    p_sku_origen, p_node_id, v_template.cell, v_template.service_level, v_z_efectivo,
    v_template.target_dias_full, v_template.target_dias_flex, v_template.action,
    COALESCE(v_vel_pond, 0)::numeric, NULL::numeric, NULL::integer,
    v_xyz_confidence, 'active', v_template.cell,
    v_accion, v_prioridad;
END; $function$;

COMMENT ON FUNCTION calc_sku_node_policy_row(text,text) IS
'Sprint 6 Fase 2 (2026-05-04 PM): extendida con accion+prioridad portados del
 motor viejo intelligence.ts:1486-1507. Sin ramas is_new_sku (entran Fase 3).';

-- 4. refresh_sku_node_policy_from_templates — extendido
DROP FUNCTION IF EXISTS refresh_sku_node_policy_from_templates();

CREATE OR REPLACE FUNCTION public.refresh_sku_node_policy_from_templates()
RETURNS TABLE(rows_affected integer)
LANGUAGE plpgsql
AS $function$
DECLARE v_count integer;
BEGIN
  WITH
    skus_activos AS (
      SELECT sku FROM productos
       WHERE estado_sku IS DISTINCT FROM 'descontinuado'
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
        accion, prioridad,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.target_dias_flex, calc.action,
        calc.velocidad_observada, calc.velocidad_censurada,
        calc.dias_quiebre_window_30d, calc.xyz_confidence, calc.policy_status,
        calc.source_template,
        calc.accion, calc.prioridad,
        false, now(), now()
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
        accion                  = EXCLUDED.accion,
        prioridad               = EXCLUDED.prioridad,
        updated_at              = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$function$;

COMMENT ON FUNCTION refresh_sku_node_policy_from_templates() IS
'Sprint 6 Fase 2 (2026-05-04 PM): incluye accion + prioridad en upsert.';

-- 5. Backfill inline
SELECT * FROM refresh_sku_node_policy_from_templates();
