-- =============================================================================
-- Sprint 6 — Fase 3: is_new_sku + lote inicial Full + redondeo inner_pack
-- =============================================================================
-- batch:20260504-sprint-6-cerrar-gap | sprint:6 | fase:3
--
-- Cambios:
--  1. ALTER TABLE sku_node_policy ADD is_new_sku boolean DEFAULT false +
--     dias_de_vida int.
--  2. DROP/CREATE calc_sku_node_policy_row con:
--     - lectura de ml_items_map.date_created_ml (MIN por sku entre variantes)
--     - lectura de si.dias_sin_movimiento
--     - cómputo is_new_sku + dias_de_vida
--     - ramas NUEVO/MANDAR_FULL antes de DEAD_STOCK (port motor viejo
--       intelligence.ts:1480-1490)
--  3. DROP/CREATE refresh_sku_node_policy_from_templates con upsert extendido.
--  4. DROP v_reposicion_explain, v_compras_pendientes, v_safety_stock CASCADE.
--  5. CREATE v_safety_stock (idéntica Fase 1).
--  6. CREATE v_compras_pendientes con qty_raw + qty_a_comprar redondeado +
--     delta_pack + mandar_full_uds (lote inicial is_new_sku).
--  7. CREATE v_reposicion_explain (idéntica Fase 1).
--  8. Backfill via refresh_sku_node_policy_from_templates().
-- =============================================================================

-- 1. Columnas nuevas
ALTER TABLE sku_node_policy
  ADD COLUMN is_new_sku boolean NOT NULL DEFAULT false,
  ADD COLUMN dias_de_vida int;

COMMENT ON COLUMN sku_node_policy.is_new_sku IS
  'Sprint 6 Fase 3: SKU con date_created_ml < 60d AND sin historial robusto
   (vel_ponderada=0 AND vel_pre_quiebre=0). Habilita ramas NUEVO/MANDAR_FULL
   y lote inicial Full en v_compras_pendientes.';
COMMENT ON COLUMN sku_node_policy.dias_de_vida IS
  'Sprint 6 Fase 3: días desde MIN(ml_items_map.date_created_ml). Calculado
   en cron sync-from-templates.';

-- 2. calc_sku_node_policy_row — extendido con is_new_sku + ramas NUEVO/MANDAR_FULL
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
  prioridad smallint,
  is_new_sku boolean,
  dias_de_vida integer
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_costo numeric; v_categoria text; v_estado_sku text;
  v_abc text; v_xyz text;
  v_vel_pond numeric; v_vel_pre numeric; v_vel_full numeric;
  v_dias_en_quiebre integer; v_dias_sin_mov integer;
  v_st_total integer; v_st_bodega integer; v_st_full integer;
  v_st_en_transito integer; v_stock_proveedor integer;
  v_tiene_stock_prov_si boolean;
  v_cob_full numeric; v_punto_reorden numeric;
  v_template policy_templates%ROWTYPE;
  v_cell text; v_is_seasonal boolean;
  v_xyz_confidence text; v_z_efectivo numeric;
  v_status text;
  v_tiene_stock_prov boolean;
  v_es_quiebre_prov boolean;
  v_en_quiebre_prol boolean;
  v_accion policy_accion_enum;
  v_prioridad smallint;
  v_date_created_ml timestamp with time zone;
  v_dias_de_vida integer;
  v_is_new_sku boolean;
  v_mov_reciente boolean;
  c_cob_maxima numeric := 60;
BEGIN
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,'')), p.estado_sku
    INTO v_costo, v_categoria, v_estado_sku
    FROM productos p WHERE p.sku = p_sku_origen LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

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

  -- Edad ML: MIN entre variantes activas
  SELECT MIN(mim.date_created_ml) INTO v_date_created_ml
    FROM ml_items_map mim
   WHERE mim.sku_origen = p_sku_origen AND mim.activo = true;

  v_dias_de_vida := CASE
    WHEN v_date_created_ml IS NULL THEN NULL
    ELSE (CURRENT_DATE - v_date_created_ml::date)::int
  END;

  -- is_new_sku: edad <60d Y sin historial robusto
  v_is_new_sku := (v_dias_de_vida IS NOT NULL AND v_dias_de_vida < 60
                   AND COALESCE(v_vel_pond, 0) = 0
                   AND COALESCE(v_vel_pre, 0) = 0);

  -- movimientoReciente (intelligence.ts:1472)
  v_mov_reciente := (v_dias_sin_mov IS NULL OR v_dias_sin_mov <= 30);

  IF v_costo IS NULL OR v_costo = 0 THEN v_status := 'blocked_no_cost';
  ELSIF v_abc IS NULL OR v_xyz IS NULL THEN v_status := 'blocked_no_history';
  ELSE v_status := 'active'; END IF;

  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum, COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer, NULL::text, v_status, NULL::text,
      NULL::policy_accion_enum, NULL::smallint,
      v_is_new_sku, v_dias_de_vida;
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
      NULL::policy_accion_enum, NULL::smallint,
      v_is_new_sku, v_dias_de_vida;
    RETURN;
  END IF;

  v_is_seasonal := EXISTS (SELECT 1 FROM seasonal_categories sc
    WHERE sc.is_active = true AND LOWER(sc.category) = v_categoria);
  IF v_is_seasonal AND v_xyz IN ('Y','Z') THEN v_xyz_confidence := 'low_confidence_seasonal';
  ELSE v_xyz_confidence := 'high'; END IF;

  IF v_xyz_confidence = 'low_confidence_seasonal' THEN v_z_efectivo := 1.88;
  ELSE v_z_efectivo := v_template.z_value; END IF;

  v_tiene_stock_prov := COALESCE(v_tiene_stock_prov_si,
                                 (v_stock_proveedor IS NULL OR v_stock_proveedor > 0));
  v_es_quiebre_prov := (NOT v_tiene_stock_prov) OR v_estado_sku = 'sin_stock_proveedor';

  v_en_quiebre_prol := (v_dias_en_quiebre IS NOT NULL AND v_dias_en_quiebre >= 14
                        AND COALESCE(v_vel_pre, 0) > COALESCE(v_vel_pond, 0)
                        AND COALESCE(v_vel_pre, 0) > 0);

  -- ── Árbol Sprint 6 Fase 3: ramas NUEVO/MANDAR_FULL is_new_sku BEFORE DEAD_STOCK ──
  IF COALESCE(v_vel_pond, 0) = 0 AND COALESCE(v_vel_pre, 0) = 0
     AND COALESCE(v_st_total, 0) = 0 THEN
    v_accion := 'INACTIVO'; v_prioridad := 99;

  ELSIF v_is_new_sku AND v_mov_reciente
        AND COALESCE(v_st_full, 0) = 0
        AND COALESCE(v_st_bodega, 0) > 0 THEN
    v_accion := 'MANDAR_FULL'; v_prioridad := 10;

  ELSIF v_is_new_sku AND v_mov_reciente THEN
    v_accion := 'NUEVO'; v_prioridad := 50;

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
    v_accion, v_prioridad,
    v_is_new_sku, v_dias_de_vida;
END; $function$;

COMMENT ON FUNCTION calc_sku_node_policy_row(text,text) IS
'Sprint 6 Fase 3 (2026-05-04 PM): is_new_sku + dias_de_vida + ramas
 NUEVO/MANDAR_FULL is_new_sku antes de DEAD_STOCK (port motor viejo
 intelligence.ts:1480-1490).';

-- 3. refresh_sku_node_policy_from_templates — incluye is_new_sku + dias_de_vida
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
        accion, prioridad, is_new_sku, dias_de_vida,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.target_dias_flex, calc.action,
        calc.velocidad_observada, calc.velocidad_censurada,
        calc.dias_quiebre_window_30d, calc.xyz_confidence, calc.policy_status,
        calc.source_template,
        calc.accion, calc.prioridad,
        COALESCE(calc.is_new_sku, false), calc.dias_de_vida,
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
        is_new_sku              = EXCLUDED.is_new_sku,
        dias_de_vida            = EXCLUDED.dias_de_vida,
        updated_at              = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$function$;

COMMENT ON FUNCTION refresh_sku_node_policy_from_templates() IS
'Sprint 6 Fase 3 (2026-05-04 PM): incluye is_new_sku + dias_de_vida en upsert.';

-- 4-7. Recreate views: v_compras_pendientes con qty_raw/redondeo/mandar_full_uds
DROP VIEW IF EXISTS v_reposicion_explain CASCADE;
DROP VIEW IF EXISTS v_compras_pendientes CASCADE;
DROP VIEW IF EXISTS v_safety_stock CASCADE;

-- v_safety_stock — IDENTICA Fase 1 (sin cambios)
CREATE VIEW v_safety_stock AS
WITH demand_stats AS (
    SELECT si.sku_origen,
           CASE
               WHEN si.dias_en_quiebre >= 14
                    AND si.vel_pre_quiebre IS NOT NULL
                    AND si.vel_pre_quiebre > 0::numeric
                    AND si.vel_pre_quiebre > COALESCE(si.vel_ponderada, 0::numeric)
               THEN si.vel_pre_quiebre
               WHEN COALESCE(si.multiplicador_evento, 1.0) > 1::numeric
               THEN COALESCE(si.vel_ponderada, 0::numeric) * si.multiplicador_evento
               ELSE COALESCE(si.vel_ponderada, 0::numeric)
           END * COALESCE(si.factor_rampup_aplicado, 1.0) AS d_avg_sem,
           COALESCE(NULLIF(si.desviacion_std, 0::numeric),
                    COALESCE(si.vel_ponderada, 0::numeric) * 0.3) AS sigma_sem,
           si.es_quiebre_proveedor,
           si.vel_pre_quiebre,
           si.vel_ponderada AS vel_actual,
           si.factor_rampup_aplicado,
           si.rampup_motivo,
           si.evento_activo,
           si.multiplicador_evento
      FROM sku_intelligence si
     WHERE COALESCE(si.vel_ponderada, 0::numeric) > 0::numeric
        OR (si.dias_en_quiebre >= 14
            AND COALESCE(si.vel_pre_quiebre, 0::numeric) > 0::numeric)
), supplier_lt AS (
    SELECT p.sku, p.proveedor_id,
           COALESCE(pr.lead_time_dias, p.lead_time_dias::numeric, 14::numeric) AS lt_dias_avg,
           COALESCE(pr.lead_time_sigma_dias, 2::numeric) AS sigma_lt
      FROM productos p
      LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE p.estado_sku IS DISTINCT FROM 'descontinuado'::text
), politica_efectiva AS (
    SELECT snp.sku_origen,
           snp.node_id,
           COALESCE(snp.cell_efectiva, snp.cell) AS cell_aplicada,
           snp.cell AS cell_original,
           COALESCE(pt_efectiva.z_value, snp.z_value) AS z_value,
           COALESCE(pt_efectiva.target_dias_full, snp.target_dias_full) AS target_dias_full,
           snp.target_dias_flex,
           snp.action,
           snp.xyz_confidence,
           snp.seasonal_match_source,
           snp.policy_status,
           snp.flex_priority,
           snp.tendencia,
           snp.promocion_activa,
           snp.promocion_motivo
      FROM sku_node_policy snp
      LEFT JOIN policy_templates pt_efectiva ON pt_efectiva.cell = COALESCE(snp.cell_efectiva, snp.cell)
)
SELECT pe.sku_origen,
       pe.node_id,
       pe.cell_aplicada AS cell,
       pe.cell_original,
       pe.tendencia,
       pe.promocion_activa,
       pe.promocion_motivo,
       pe.action AS policy_action,
       pe.z_value AS z,
       d.d_avg_sem,
       d.d_avg_sem / 7.0 AS d_avg_dia,
       d.sigma_sem,
       d.sigma_sem / sqrt(7.0) AS sigma_dia,
       COALESCE(slt.lt_dias_avg, 14::numeric) AS lt_dias,
       COALESCE(slt.sigma_lt, 2::numeric) AS sigma_lt,
       round(
           CASE
               WHEN COALESCE(slt.sigma_lt, 0::numeric) < 2::numeric
               THEN pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)) * 1.075
               ELSE pe.z_value * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric) * power(d.sigma_sem / sqrt(7.0), 2::numeric)
                                      + power(d.d_avg_sem / 7.0, 2::numeric) * power(COALESCE(slt.sigma_lt, 2::numeric), 2::numeric)) * 1.075
           END)::integer AS safety_stock,
       round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric))::integer AS cycle_stock,
       round(d.d_avg_sem / 7.0 * COALESCE(slt.lt_dias_avg, 14::numeric)
             + pe.z_value * (d.sigma_sem / sqrt(7.0)) * sqrt(COALESCE(slt.lt_dias_avg, 14::numeric)))::integer AS reorder_point,
       CASE WHEN pe.node_id = 'full_ml'::text
            THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_full, 0)::numeric)::integer
            ELSE 0 END AS pre_full_target,
       CASE WHEN pe.node_id = 'bodega_central'::text
            THEN round(d.d_avg_sem / 7.0 * COALESCE(pe.target_dias_flex, 0)::numeric)::integer
            ELSE 0 END AS reserva_flex_target,
       pe.xyz_confidence,
       pe.seasonal_match_source,
       pe.policy_status,
       d.es_quiebre_proveedor,
       d.vel_pre_quiebre,
       d.vel_actual,
       d.factor_rampup_aplicado,
       d.rampup_motivo,
       d.evento_activo,
       d.multiplicador_evento,
       pe.target_dias_flex,
       pe.flex_priority
  FROM politica_efectiva pe
  JOIN demand_stats d ON d.sku_origen = pe.sku_origen
  LEFT JOIN supplier_lt slt ON slt.sku = pe.sku_origen
 WHERE pe.policy_status = 'active'::text
   AND pe.action <> 'no_reorder'::policy_action_enum;

COMMENT ON VIEW v_safety_stock IS
'Sprint 6 Fase 1 (2026-05-04 PM): CTE demand_stats con threshold vel_pre_quiebre
 corregido. Recreada en Fase 3 por CASCADE — definicion identica.';

-- v_compras_pendientes — agregada qty_raw, qty_a_comprar (redondeado), delta_pack, mandar_full_uds
CREATE VIEW v_compras_pendientes AS
WITH stock_total_por_sku AS (
    SELECT v.sku_origen,
           sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) AS stock_total,
           sum(v.qty_on_hand - COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bodega,
           sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'full_ml'::text) AS stock_full,
           sum(v.qty_on_hand) FILTER (WHERE v.node_id = 'bodega_central'::text) AS stock_bruto_bodega,
           sum(COALESCE(v.qty_reserved, 0::numeric)) FILTER (WHERE v.node_id = 'bodega_central'::text) AS qty_reserved_bodega
      FROM v_stock_por_nodo v
     GROUP BY v.sku_origen
), en_transito AS (
    SELECT v.sku_origen,
           sum(v.qty_in_transit) AS in_transit_total,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
      FROM v_in_transit_por_nodo v
     GROUP BY v.sku_origen
), pre_full_por_sku AS (
    SELECT s.sku_origen, s.pre_full_target
      FROM v_safety_stock s
     WHERE s.node_id = 'full_ml'::text
), reserva_flex_por_sku AS (
    SELECT s.sku_origen, s.reserva_flex_target
      FROM v_safety_stock s
     WHERE s.node_id = 'bodega_central'::text
), inner_packs AS (
    SELECT p.sku,
           COALESCE(pc.inner_pack, p.inner_pack, 1) AS inner_pack
      FROM productos p
      LEFT JOIN proveedor_catalogo pc
        ON pc.sku_origen = p.sku AND pc.proveedor_id = p.proveedor_id
), policy_bodega AS (
    SELECT snp.sku_origen, snp.is_new_sku, snp.accion, snp.prioridad
      FROM sku_node_policy snp
     WHERE snp.node_id = 'bodega_central'::text
), qty_calc AS (
    SELECT
        ss.sku_origen,
        GREATEST(0::numeric,
                 (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
                 - COALESCE(st.stock_total, 0::numeric) - COALESCE(et.in_transit_total, 0::numeric)) AS qty_raw,
        ip.inner_pack
      FROM v_safety_stock ss
      LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
      LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
      LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
      LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
      LEFT JOIN inner_packs ip ON ip.sku = ss.sku_origen
     WHERE ss.node_id = 'bodega_central'::text
)
SELECT ss.sku_origen,
       p.nombre,
       ss.cell,
       ss.cell_original,
       ss.tendencia,
       ss.promocion_activa,
       ss.promocion_motivo,
       ss.policy_action,
       ss.xyz_confidence,
       ss.seasonal_match_source,
       ss.z,
       ss.lt_dias,
       ss.d_avg_dia,
       ss.cycle_stock,
       ss.safety_stock,
       ss.reorder_point,
       COALESCE(pf.pre_full_target, 0) AS pre_full_target,
       COALESCE(rf.reserva_flex_target, 0) AS reserva_flex_target,
       COALESCE(st.stock_total, 0::numeric) AS stock_total,
       COALESCE(st.stock_bodega, 0::numeric) AS stock_bodega,
       COALESCE(st.stock_full, 0::numeric) AS stock_full,
       COALESCE(et.in_transit_total, 0::numeric) AS in_transit_bodega,
       ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0) AS stock_objetivo,
       qc.qty_raw,
       COALESCE(ip.inner_pack, 1) AS inner_pack,
       CASE
         WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
         THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
         ELSE qc.qty_raw
       END AS qty_a_comprar,
       (CASE
         WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
         THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
         ELSE qc.qty_raw
       END - qc.qty_raw) AS delta_pack,
       CASE WHEN p.costo_promedio IS NULL OR p.costo_promedio = 0::numeric THEN NULL::numeric
            ELSE (CASE
                    WHEN COALESCE(ip.inner_pack, 1) > 1 AND qc.qty_raw > 0
                    THEN CEIL(qc.qty_raw / ip.inner_pack::numeric)::numeric * ip.inner_pack
                    ELSE qc.qty_raw
                  END) * p.costo_promedio
       END AS clp_estimado,
       CASE WHEN ss.d_avg_dia > 0::numeric THEN round(COALESCE(st.stock_total, 0::numeric) / ss.d_avg_dia)
            ELSE NULL::numeric END AS dias_cobertura_actual,
       CASE WHEN (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
                 < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
            THEN true ELSE false END AS bajo_rop,
       p.proveedor_id,
       pr.nombre_canonico AS proveedor_nombre,
       ss.es_quiebre_proveedor,
       ss.vel_pre_quiebre,
       ss.vel_actual,
       ss.factor_rampup_aplicado,
       ss.rampup_motivo,
       ss.evento_activo,
       ss.multiplicador_evento,
       ss.target_dias_flex,
       ss.flex_priority,
       COALESCE(st.stock_bruto_bodega, 0::numeric) AS stock_bruto_bodega,
       COALESCE(st.qty_reserved_bodega, 0::numeric) AS qty_reserved_bodega,
       COALESCE(et.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
       COALESCE(et.in_transit_picking_full, 0::numeric) AS in_transit_picking_full,
       COALESCE(pb.is_new_sku, false) AS is_new_sku,
       pb.accion AS accion_nueva,
       pb.prioridad AS prioridad_nueva,
       -- Sprint 6 Fase 3: lote inicial Full para SKUs nuevos
       CASE
         WHEN COALESCE(pb.is_new_sku, false)
              AND COALESCE(st.stock_full, 0::numeric) = 0
              AND COALESCE(st.stock_bodega, 0::numeric) > 0
         THEN LEAST(GREATEST(COALESCE(ip.inner_pack, 1), 2)::numeric,
                    COALESCE(st.stock_bodega, 0::numeric))
         ELSE 0::numeric
       END AS mandar_full_uds
  FROM v_safety_stock ss
  JOIN productos p ON p.sku = ss.sku_origen
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  LEFT JOIN stock_total_por_sku st ON st.sku_origen = ss.sku_origen
  LEFT JOIN en_transito et ON et.sku_origen = ss.sku_origen
  LEFT JOIN pre_full_por_sku pf ON pf.sku_origen = ss.sku_origen
  LEFT JOIN reserva_flex_por_sku rf ON rf.sku_origen = ss.sku_origen
  LEFT JOIN inner_packs ip ON ip.sku = ss.sku_origen
  LEFT JOIN policy_bodega pb ON pb.sku_origen = ss.sku_origen
  LEFT JOIN qty_calc qc ON qc.sku_origen = ss.sku_origen
 WHERE ss.node_id = 'bodega_central'::text
   AND (
     (COALESCE(st.stock_total, 0::numeric) + COALESCE(et.in_transit_total, 0::numeric))
       < (ss.safety_stock + COALESCE(pf.pre_full_target, 0) + COALESCE(rf.reserva_flex_target, 0))::numeric
     OR COALESCE(pb.is_new_sku, false)
   );

COMMENT ON VIEW v_compras_pendientes IS
'Sprint 6 Fase 3 (2026-05-04 PM): agregadas columnas qty_raw + qty_a_comprar
 (redondeado a inner_pack) + delta_pack + is_new_sku + mandar_full_uds (lote
 inicial Full). inner_pack via proveedor_catalogo (preferido) o productos.';

-- v_reposicion_explain — IDENTICA Fase 1 (sin cambios funcionales)
CREATE VIEW v_reposicion_explain AS
WITH ventas_30d_real AS (
    SELECT cv.sku_origen,
           sum(vmc.cantidad)::numeric AS uds_30d_real,
           count(DISTINCT vmc.order_id) AS num_ordenes_30d,
           sum(vmc.cantidad)::numeric / 30.0 AS vel_real_dia,
           sum(vmc.cantidad)::numeric * 7.0 / 30.0 AS vel_real_sem
      FROM ventas_ml_cache vmc
      JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
     WHERE vmc.fecha_date >= (CURRENT_DATE - 30) AND vmc.anulada = false
     GROUP BY cv.sku_origen
), ultimo_oc_real AS (
    SELECT DISTINCT ON (ocl.sku_origen) ocl.sku_origen,
           oc.fecha_emision AS ultimo_oc_fecha_emision,
           oc.fecha_recepcion AS ultimo_oc_fecha_recepcion,
           oc.lead_time_real AS lt_real_ultimo_oc_dias,
           oc.numero AS ultimo_oc_numero
      FROM ordenes_compra_lineas ocl
      JOIN ordenes_compra oc ON oc.id = ocl.orden_id
     WHERE oc.estado = 'RECIBIDA_PARCIAL'::text
       AND oc.fecha_recepcion IS NOT NULL
       AND oc.lead_time_real IS NOT NULL
     ORDER BY ocl.sku_origen, oc.fecha_recepcion DESC
), quiebre_por_nodo AS (
    SELECT s.sku_origen,
           max(s.fecha) FILTER (WHERE s.stock_bodega > 0) AS ultimo_dia_bodega_con_stock,
           max(s.fecha) FILTER (WHERE s.stock_full > 0) AS ultimo_dia_full_con_stock,
           min(s.fecha) AS primer_snapshot_sku
      FROM stock_snapshots s
     GROUP BY s.sku_origen
), in_transit_split AS (
    SELECT v.sku_origen,
           sum(v.qty_in_transit) AS in_transit_total,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'bodega_central'::text) AS in_transit_oc_bodega,
           sum(v.qty_in_transit) FILTER (WHERE v.to_node_id = 'full_ml'::text) AS in_transit_picking_full
      FROM v_in_transit_por_nodo v
     GROUP BY v.sku_origen
)
SELECT vsf.sku_origen,
       p.nombre,
       p.categoria,
       p.proveedor_id,
       pr.nombre_canonico AS proveedor_nombre,
       vsf.cell,
       vsf.cell_original,
       vsf.policy_action,
       pt.service_level AS sl_template,
       pt.z_value AS z_template,
       pt.target_dias_full AS target_dias_template,
       pt.target_dias_flex AS target_dias_flex_template,
       pt.source_ref AS template_fuente,
       si.vel_ponderada AS vel_decl_sem,
       si.vel_7d AS vel_7d_decl,
       si.vel_30d AS vel_30d_decl,
       si.vel_60d AS vel_60d_decl,
       vsf.d_avg_dia AS vel_decl_dia,
       COALESCE(v30.vel_real_dia, 0::numeric) AS vel_real_dia,
       COALESCE(v30.vel_real_sem, 0::numeric) AS vel_real_sem,
       COALESCE(v30.uds_30d_real, 0::numeric) AS uds_30d_real,
       COALESCE(v30.num_ordenes_30d, 0::bigint) AS num_ordenes_30d,
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN NULL::numeric
            ELSE round((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada * 100::numeric, 1)
       END AS vel_drift_pct,
       CASE WHEN si.vel_ponderada IS NULL OR si.vel_ponderada = 0::numeric THEN 'sin_baseline'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.10 THEN 'aligned'::text
            WHEN abs((COALESCE(v30.vel_real_sem, 0::numeric) - si.vel_ponderada) / si.vel_ponderada) <= 0.30 THEN 'drift_moderate'::text
            ELSE 'drift_high'::text
       END AS vel_drift_status,
       vsf.lt_dias AS lt_decl,
       vsf.sigma_lt AS sigma_lt_decl,
       uo.lt_real_ultimo_oc_dias,
       uo.ultimo_oc_fecha_emision,
       uo.ultimo_oc_fecha_recepcion,
       uo.ultimo_oc_numero,
       CASE WHEN uo.lt_real_ultimo_oc_dias IS NULL THEN 'sin_data'::text
            WHEN abs(uo.lt_real_ultimo_oc_dias::numeric - vsf.lt_dias) <= 2::numeric THEN 'aligned'::text
            ELSE 'drift'::text
       END AS lt_drift_status,
       vsf.z,
       vsf.d_avg_sem,
       vsf.sigma_sem,
       vsf.sigma_dia,
       vsf.cycle_stock,
       vsf.safety_stock,
       vsf.reorder_point,
       COALESCE(pre_full.pre_full_target, 0) AS pre_full_target,
       vsf.reserva_flex_target,
       vsf.xyz_confidence,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) AS stock_bodega,
       COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_full,
       COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) + COALESCE(vsn_f.qty_on_hand, 0::numeric) AS stock_total,
       COALESCE(its.in_transit_total, 0::numeric) AS in_transit_bodega,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text
            ELSE 'OK'::text
       END AS quiebre_bodega_estado,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku
       END AS quiebre_bodega_fecha,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_bodega_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_bodega_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer
       END AS quiebre_bodega_dias,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric THEN 'EN_QUIEBRE'::text
            ELSE 'OK'::text
       END AS quiebre_full_estado,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::date
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            ELSE qpn.primer_snapshot_sku
       END AS quiebre_full_fecha,
       CASE WHEN COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric THEN NULL::integer
            WHEN qpn.ultimo_dia_full_con_stock IS NOT NULL THEN CURRENT_DATE - LEAST((qpn.ultimo_dia_full_con_stock + '1 day'::interval)::date, CURRENT_DATE)
            WHEN qpn.primer_snapshot_sku IS NOT NULL THEN CURRENT_DATE - qpn.primer_snapshot_sku
            ELSE NULL::integer
       END AS quiebre_full_dias,
       CASE WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
            THEN 'QUIEBRE TOTAL: comprar urgente al proveedor + armar envío parcial cuando llegue'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) <= 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) > 0::numeric
            THEN 'Bodega quebrada: comprar al proveedor; Full sigue vendiendo mientras tanto'::text
            WHEN COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric) > 0::numeric AND COALESCE(vsn_f.qty_on_hand, 0::numeric) <= 0::numeric
            THEN ('Full quebrado: armar envío Bodega->Full hoy. Tenes '::text || COALESCE(vsn_b.qty_on_hand - COALESCE(vsn_b.qty_reserved, 0::numeric), 0::numeric)::text) || ' unidades disponibles'::text
            ELSE NULL::text
       END AS alerta_operativa,
       si.fecha_entrada_quiebre,
       CASE WHEN si.fecha_entrada_quiebre IS NULL THEN NULL::integer
            ELSE EXTRACT(day FROM now() - si.fecha_entrada_quiebre::timestamp with time zone)::integer
       END AS dias_en_quiebre,
       p.costo_promedio,
       snp.manual_override,
       snp.policy_status,
       snp.seasonal_match_source,
       si.margen_neto_30d_imputed,
       vcp.qty_a_comprar,
       vcp.qty_raw,
       vcp.delta_pack,
       vcp.inner_pack,
       vcp.mandar_full_uds,
       vcp.is_new_sku,
       snp.dias_de_vida,
       snp.accion AS accion_nueva,
       snp.prioridad AS prioridad_nueva,
       vcp.clp_estimado,
       vcp.dias_cobertura_actual,
       vcp.bajo_rop,
       si.accion,
       si.es_quiebre_proveedor,
       si.vel_pre_quiebre,
       si.factor_rampup_aplicado,
       si.rampup_motivo,
       si.evento_activo,
       si.multiplicador_evento,
       si.mandar_full,
       si.pedir_proveedor AS pedir_proveedor_motor_viejo,
       si.pedir_proveedor_sin_rampup,
       snp.target_dias_flex,
       snp.flex_priority,
       vsf.d_avg_sem AS d_avg_sem_efectivo,
       vsf.tendencia,
       COALESCE(snp.cell_efectiva, snp.cell) AS cell_efectiva,
       vsf.promocion_activa,
       vsf.promocion_motivo,
       snp.tendencia_updated_at,
       vtd.vel_recent_sem AS vel_28d_recent,
       vtd.vel_previous_sem AS vel_28d_previous,
       vtd.vel_baseline_sem AS vel_baseline_90d,
       vtd.ratio_recent_vs_previous,
       vtd.ratio_recent_vs_baseline,
       vtd.ratio_recent_vs_pre_quiebre,
       vtd.dias_stock_recent,
       vtd.dias_stock_previous,
       vtd.dias_quiebre_recent,
       vtd.dias_quiebre_previous,
       vtd.dias_total_recent,
       vtd.dias_total_previous,
       vtd.uds_28d AS uds_ultimas_4_semanas,
       vtd.uds_28d_previas AS uds_4_semanas_previas,
       si.updated_at AS sku_intelligence_updated_at,
       snp.updated_at AS policy_updated_at,
       COALESCE(vsn_b.qty_on_hand, 0::numeric) AS stock_bruto_bodega,
       COALESCE(vsn_b.qty_reserved, 0::numeric) AS qty_reserved_bodega,
       COALESCE(its.in_transit_oc_bodega, 0::numeric) AS in_transit_oc_bodega,
       COALESCE(its.in_transit_picking_full, 0::numeric) AS in_transit_picking_full
  FROM v_safety_stock vsf
  JOIN productos p ON p.sku = vsf.sku_origen
  LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
  JOIN sku_intelligence si ON si.sku_origen = vsf.sku_origen
  JOIN sku_node_policy snp ON snp.sku_origen = vsf.sku_origen AND snp.node_id = vsf.node_id
  LEFT JOIN policy_templates pt ON pt.cell = vsf.cell
  LEFT JOIN ventas_30d_real v30 ON v30.sku_origen = vsf.sku_origen
  LEFT JOIN ultimo_oc_real uo ON uo.sku_origen = vsf.sku_origen
  LEFT JOIN v_stock_por_nodo vsn_b ON vsn_b.sku_origen = vsf.sku_origen AND vsn_b.node_id = 'bodega_central'::text
  LEFT JOIN v_stock_por_nodo vsn_f ON vsn_f.sku_origen = vsf.sku_origen AND vsn_f.node_id = 'full_ml'::text
  LEFT JOIN in_transit_split its ON its.sku_origen = vsf.sku_origen
  LEFT JOIN v_compras_pendientes vcp ON vcp.sku_origen = vsf.sku_origen
  LEFT JOIN (SELECT s.sku_origen, s.pre_full_target FROM v_safety_stock s WHERE s.node_id = 'full_ml'::text) pre_full ON pre_full.sku_origen = vsf.sku_origen
  LEFT JOIN quiebre_por_nodo qpn ON qpn.sku_origen = vsf.sku_origen
  LEFT JOIN v_trend_detection vtd ON vtd.sku_origen = vsf.sku_origen
 WHERE vsf.node_id = 'bodega_central'::text;

COMMENT ON VIEW v_reposicion_explain IS
'Sprint 6 Fase 3 (2026-05-04 PM): expone qty_raw, delta_pack, inner_pack,
 mandar_full_uds, is_new_sku, dias_de_vida, accion_nueva, prioridad_nueva.';

-- 8. Backfill
SELECT * FROM refresh_sku_node_policy_from_templates();
