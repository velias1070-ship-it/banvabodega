-- Sprint 8.5 — Relajar condicion de salida is_new_sku
-- batch:20260505-sprint-85-is-new-sku | sprint:8.5 | hotfix:is-new-sku-gap
--
-- Bug: la condicion v_is_new_sku := (dias<60 AND vel_pond=0 AND vel_pre=0)
-- saca el flag apenas el SKU vende su primera unidad. Combinado con
-- ABC=NULL/XYZ=NULL → cell=CY (default), pero al obtener primer dato
-- ABC×XYZ típicamente cae en CZ (no_reorder). El SKU queda invisible
-- ~50 dias hasta que ABC×XYZ acumule muestra robusta y lo reclasifique.
--
-- Caso testigo: SPAFE33E20W26 (34d, vel=0.69, abc=C, xyz=Z, cat=textil
-- no seasonal => xyz_confidence=high). Vendio 2 uds en 90d, no_reorder,
-- invisible en /inteligencia.
--
-- Diagnostico user: 62 SKUs activos en este gap, edad avg 41d,
-- vendiendo 3.65 uds/28d.
--
-- Fix: cambiar condicion a (dias<60 AND uds_90d<15). Mantiene el "lote
-- inicial" hasta que el clasificador tenga muestra robusta, sin importar
-- si vendio o no. SKUs <60d con 15+ uds ya tienen señal robusta y deben
-- usar ABC×XYZ normal.
--
-- Por que uds_90d<15 y no xyz_confidence!='high':
-- xyz_confidence='low_confidence_seasonal' solo aplica para SKUs en
-- categorias estacionales (sabanas/cubrecamas/etc) con xyz IN (Y,Z).
-- Caso testigo SPAFE33E20W26 es categoria textil no seasonal con xyz=Z
-- => xyz_confidence='high' => Opcion (1) NO lo rescataria. uds_90d es
-- el criterio agnostico de categoria que captura el caso real.
--
-- Resultado validacion: motor nuevo 253 -> 278 SKUs (+25 rescatados),
-- new_skus activos 102 -> 182 (91 distintos x 2 nodos).
--
-- Mantiene codigo verbatim de migracion sprint7_fase3_calc_row_with_liquidacion
-- (lookup markdown_policy, EN_TRANSITO branch, vel_pre quiebre en d_avg_sem,
-- NUEVO_MANDAR_FULL accion). Solo cambia condicion is_new_sku.

DROP FUNCTION IF EXISTS calc_sku_node_policy_row(text, text) CASCADE;

CREATE FUNCTION public.calc_sku_node_policy_row(p_sku_origen text, p_node_id text)
 RETURNS TABLE(
   sku_origen text, node_id text, cell text, service_level numeric, z_value numeric,
   target_dias_full integer, target_dias_flex integer, action policy_action_enum,
   velocidad_observada numeric, velocidad_censurada numeric, dias_quiebre_window_30d integer,
   xyz_confidence text, policy_status text, source_template text,
   accion policy_accion_enum, prioridad smallint, is_new_sku boolean, dias_de_vida integer,
   dias_extra integer, liquidacion_accion liquidacion_accion_enum,
   liquidacion_descuento_sugerido numeric
 )
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_costo numeric; v_categoria text; v_estado_sku text;
  v_abc text; v_xyz text; v_cuadrante text;
  v_vel_pond numeric; v_vel_pre numeric; v_vel_full numeric;
  v_dias_en_quiebre integer; v_dias_sin_mov integer;
  v_st_total integer; v_st_bodega integer; v_st_full integer;
  v_st_en_transito integer; v_stock_proveedor integer;
  v_tiene_stock_prov_si boolean;
  v_cob_full numeric; v_punto_reorden numeric;
  v_template policy_templates%ROWTYPE;
  v_cell text; v_is_seasonal boolean;
  v_xyz_confidence text; v_z_efectivo numeric; v_status text;
  v_tiene_stock_prov boolean; v_es_quiebre_prov boolean; v_en_quiebre_prol boolean;
  v_accion policy_accion_enum; v_prioridad smallint;
  v_date_created_ml timestamp with time zone; v_dias_de_vida integer;
  v_is_new_sku boolean; v_mov_reciente boolean;
  v_uds_90d integer;
  v_factor_rampup numeric; v_mult_evento numeric;
  v_d_avg_sem numeric; v_d_avg_dia numeric; v_dio numeric;
  v_target_dias_full integer; v_dias_extra integer;
  v_liq_override liquidacion_accion_enum;
  v_liq_accion liquidacion_accion_enum; v_liq_descuento numeric;
  c_cob_maxima numeric := 60;
BEGIN
  SELECT p.costo_promedio, LOWER(COALESCE(p.categoria,'')), p.estado_sku
    INTO v_costo, v_categoria, v_estado_sku
    FROM productos p WHERE p.sku = p_sku_origen LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT si.abc_unidades, si.xyz, si.cuadrante,
         si.vel_ponderada, si.vel_pre_quiebre, si.vel_full,
         si.dias_en_quiebre, si.dias_sin_movimiento,
         si.stock_total, si.stock_bodega, si.stock_full, si.stock_en_transito,
         si.stock_proveedor, si.tiene_stock_prov,
         si.cob_full, si.punto_reorden,
         COALESCE(si.factor_rampup_aplicado, 1.0),
         COALESCE(si.multiplicador_evento, 1.0)
    INTO v_abc, v_xyz, v_cuadrante,
         v_vel_pond, v_vel_pre, v_vel_full,
         v_dias_en_quiebre, v_dias_sin_mov,
         v_st_total, v_st_bodega, v_st_full, v_st_en_transito,
         v_stock_proveedor, v_tiene_stock_prov_si,
         v_cob_full, v_punto_reorden,
         v_factor_rampup, v_mult_evento
    FROM sku_intelligence si
   WHERE si.sku_origen = p_sku_origen LIMIT 1;

  SELECT snp.liquidacion_override INTO v_liq_override
    FROM sku_node_policy snp
   WHERE snp.sku_origen = p_sku_origen AND snp.node_id = p_node_id LIMIT 1;

  SELECT MIN(mim.date_created_ml) INTO v_date_created_ml
    FROM ml_items_map mim
   WHERE mim.sku_origen = p_sku_origen AND mim.activo = true;

  v_dias_de_vida := CASE
    WHEN v_date_created_ml IS NULL THEN NULL
    ELSE (CURRENT_DATE - v_date_created_ml::date)::int
  END;

  -- Sprint 8.5: uds_90d para gate de muestra robusta del nuevo SKU
  SELECT COALESCE(SUM(vmc.cantidad)::int, 0) INTO v_uds_90d
    FROM ventas_ml_cache vmc
    JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
   WHERE cv.sku_origen = p_sku_origen
     AND vmc.fecha_date >= CURRENT_DATE - 90
     AND COALESCE(vmc.anulada, false) = false;

  -- Sprint 8.5: cambio de condicion de salida is_new_sku.
  -- Antes: dias<60 AND vel_pond=0 AND vel_pre=0 (lo sacaba al primer venta,
  -- luego invisible ~50d hasta que ABC×XYZ acumule muestra robusta)
  -- Ahora: dias<60 AND uds_90d<15 (mantiene flag hasta muestra robusta)
  v_is_new_sku := (v_dias_de_vida IS NOT NULL
                   AND v_dias_de_vida < 60
                   AND COALESCE(v_uds_90d, 0) < 15);

  v_mov_reciente := (v_dias_sin_mov IS NULL OR v_dias_sin_mov <= 30);

  IF v_is_new_sku THEN
    v_status := 'active';
    v_cell := 'BY';
  ELSIF v_costo IS NULL OR v_costo = 0 THEN
    v_status := 'blocked_no_cost';
  ELSIF v_abc IS NULL OR v_xyz IS NULL THEN
    v_status := 'active';
    v_cell := 'CY';
  ELSE
    v_status := 'active';
    v_cell := v_abc || v_xyz;
  END IF;

  IF v_status <> 'active' THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id,
      NULL::text, NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum, COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer, NULL::text, v_status, NULL::text,
      NULL::policy_accion_enum, NULL::smallint,
      v_is_new_sku, v_dias_de_vida,
      NULL::integer, NULL::liquidacion_accion_enum, NULL::numeric;
    RETURN;
  END IF;

  SELECT * INTO v_template FROM policy_templates pt WHERE pt.cell = v_cell LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      p_sku_origen, p_node_id, v_cell,
      NULL::numeric, NULL::numeric, NULL::integer, NULL::integer,
      NULL::policy_action_enum, COALESCE(v_vel_pond, 0)::numeric,
      NULL::numeric, NULL::integer, NULL::text, 'blocked_no_template', NULL::text,
      NULL::policy_accion_enum, NULL::smallint,
      v_is_new_sku, v_dias_de_vida,
      NULL::integer, NULL::liquidacion_accion_enum, NULL::numeric;
    RETURN;
  END IF;

  v_is_seasonal := EXISTS (SELECT 1 FROM seasonal_categories sc
    WHERE sc.is_active = true AND LOWER(sc.category) = v_categoria);
  IF v_is_seasonal AND COALESCE(v_xyz,'') IN ('Y','Z') THEN v_xyz_confidence := 'low_confidence_seasonal';
  ELSE v_xyz_confidence := 'high'; END IF;

  IF v_xyz_confidence = 'low_confidence_seasonal' THEN v_z_efectivo := 1.88;
  ELSE v_z_efectivo := v_template.z_value; END IF;

  v_tiene_stock_prov := COALESCE(v_tiene_stock_prov_si,
                                 (v_stock_proveedor IS NULL OR v_stock_proveedor > 0));
  v_es_quiebre_prov := (NOT v_tiene_stock_prov) OR v_estado_sku = 'sin_stock_proveedor';

  v_en_quiebre_prol := (v_dias_en_quiebre IS NOT NULL AND v_dias_en_quiebre >= 14
                        AND COALESCE(v_vel_pre, 0) > COALESCE(v_vel_pond, 0)
                        AND COALESCE(v_vel_pre, 0) > 0);

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
  ELSIF (COALESCE(v_cob_full, 999) < COALESCE(v_punto_reorden, 0)
         AND COALESCE(v_cob_full, 999) < 999)
        OR (COALESCE(v_st_total, 0) > 0
            AND COALESCE(v_vel_pond, 0) > 0
            AND COALESCE(v_st_total, 0)::numeric < COALESCE(v_vel_pond, 0)) THEN
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

  v_d_avg_sem := CASE
    WHEN v_dias_en_quiebre >= 14 AND v_vel_pre IS NOT NULL
         AND v_vel_pre > 0 AND v_vel_pre > COALESCE(v_vel_pond, 0)
       THEN v_vel_pre
    WHEN v_mult_evento > 1 THEN COALESCE(v_vel_pond, 0) * v_mult_evento
    ELSE COALESCE(v_vel_pond, 0)
  END * v_factor_rampup;
  v_d_avg_dia := v_d_avg_sem / 7.0;
  v_target_dias_full := COALESCE(v_template.target_dias_full, 0);
  v_dio := CASE
    WHEN v_d_avg_sem > 0 THEN COALESCE(v_st_total, 0)::numeric / v_d_avg_dia
    ELSE 999::numeric
  END;
  v_dias_extra := GREATEST(0, ROUND(v_dio - v_target_dias_full)::int);

  IF v_liq_override IS NOT NULL THEN
    v_liq_accion := v_liq_override;
    SELECT mp.descuento_pct INTO v_liq_descuento
      FROM markdown_policy mp
     WHERE mp.cell = v_cell AND mp.liquidacion_accion = v_liq_override
     ORDER BY mp.dias_extra_threshold DESC LIMIT 1;
  ELSIF (v_abc = 'C' OR v_cuadrante = 'REVISAR')
        AND COALESCE(v_vel_pond, 0) > 0 THEN
    SELECT mp.liquidacion_accion, mp.descuento_pct
      INTO v_liq_accion, v_liq_descuento
      FROM markdown_policy mp
     WHERE mp.cell = v_cell AND v_dias_extra > mp.dias_extra_threshold
     ORDER BY mp.dias_extra_threshold DESC LIMIT 1;
  ELSE
    v_liq_accion := NULL; v_liq_descuento := NULL;
  END IF;

  RETURN QUERY SELECT
    p_sku_origen, p_node_id, v_template.cell, v_template.service_level, v_z_efectivo,
    v_template.target_dias_full, v_template.target_dias_flex, v_template.action,
    COALESCE(v_vel_pond, 0)::numeric, NULL::numeric, NULL::integer,
    v_xyz_confidence, 'active', v_template.cell,
    v_accion, v_prioridad,
    v_is_new_sku, v_dias_de_vida,
    v_dias_extra, v_liq_accion, v_liq_descuento;
END; $function$;

CREATE OR REPLACE FUNCTION public.refresh_sku_node_policy_from_templates()
 RETURNS TABLE(rows_affected integer)
 LANGUAGE plpgsql
AS $function$
DECLARE v_count integer;
BEGIN
  WITH
    skus_activos AS (
      SELECT sku FROM productos WHERE estado_sku IS DISTINCT FROM 'descontinuado'
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
        dias_extra, liquidacion_accion, liquidacion_descuento_sugerido,
        manual_override, created_at, updated_at
      )
      SELECT
        c.sku_origen, c.node_id, calc.cell, calc.service_level, calc.z_value,
        calc.target_dias_full, calc.target_dias_flex, calc.action,
        calc.velocidad_observada, calc.velocidad_censurada,
        calc.dias_quiebre_window_30d, calc.xyz_confidence, calc.policy_status,
        calc.source_template, calc.accion, calc.prioridad,
        COALESCE(calc.is_new_sku, false), calc.dias_de_vida,
        calc.dias_extra, calc.liquidacion_accion, calc.liquidacion_descuento_sugerido,
        false, now(), now()
      FROM combos c
      CROSS JOIN LATERAL calc_sku_node_policy_row(c.sku_origen, c.node_id) calc
      ON CONFLICT (sku_origen, node_id) DO UPDATE SET
        cell                            = EXCLUDED.cell,
        service_level                   = EXCLUDED.service_level,
        z_value                         = EXCLUDED.z_value,
        target_dias_full                = EXCLUDED.target_dias_full,
        target_dias_flex                = EXCLUDED.target_dias_flex,
        action                          = EXCLUDED.action,
        velocidad_observada             = EXCLUDED.velocidad_observada,
        xyz_confidence                  = EXCLUDED.xyz_confidence,
        policy_status                   = EXCLUDED.policy_status,
        source_template                 = EXCLUDED.source_template,
        accion                          = EXCLUDED.accion,
        prioridad                       = EXCLUDED.prioridad,
        is_new_sku                      = EXCLUDED.is_new_sku,
        dias_de_vida                    = EXCLUDED.dias_de_vida,
        dias_extra                      = EXCLUDED.dias_extra,
        liquidacion_accion              = EXCLUDED.liquidacion_accion,
        liquidacion_descuento_sugerido  = EXCLUDED.liquidacion_descuento_sugerido,
        updated_at                      = now()
        WHERE sku_node_policy.manual_override = false
      RETURNING 1
    )
  SELECT COUNT(*)::integer INTO v_count FROM upserted;
  RETURN QUERY SELECT v_count;
END;
$function$;
