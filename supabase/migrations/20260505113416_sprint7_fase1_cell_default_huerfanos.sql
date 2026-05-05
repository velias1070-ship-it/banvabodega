-- Sprint 7 Fase 1.2 — cell default para is_new_sku huérfanos
-- batch:20260505-sprint-7-fase12 | sprint:7 | fase:1.2
--
-- Bug: SKUs sin abc/xyz computado quedan en 'blocked_no_history' con cell=NULL,
-- lo que los excluye de v_safety_stock (no tienen template asociado). 4 SKUs
-- nuevos (JSCNAE190P15W, JSCNAE190P20W, SPAFE30E10W26, SPAFE40O15W26) no
-- aparecen en v_compras_pendientes a pesar de estar flagged is_new_sku.
--
-- Fix: cuando abc o xyz es NULL, asignar cell default:
--   - is_new_sku=true → 'BY' (defensivo: lote inicial razonable)
--   - resto → 'CY' (conservador: bajo volumen, demanda variable)
-- y mantener policy_status='active' para que entren al pipeline.
--
-- Nota: este primer intento NO cubrió a los 4 SKUs porque tenían
-- costo_promedio=0 y caían antes en 'blocked_no_cost'. La migración
-- 20260505113543 extiende el bypass al caso sin costo.

CREATE OR REPLACE FUNCTION public.calc_sku_node_policy_row(p_sku_origen text, p_node_id text)
 RETURNS TABLE(sku_origen text, node_id text, cell text, service_level numeric, z_value numeric, target_dias_full integer, target_dias_flex integer, action policy_action_enum, velocidad_observada numeric, velocidad_censurada numeric, dias_quiebre_window_30d integer, xyz_confidence text, policy_status text, source_template text, accion policy_accion_enum, prioridad smallint, is_new_sku boolean, dias_de_vida integer)
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
  v_xyz_confidence text; v_z_efectivo numeric; v_status text;
  v_tiene_stock_prov boolean; v_es_quiebre_prov boolean; v_en_quiebre_prol boolean;
  v_accion policy_accion_enum; v_prioridad smallint;
  v_date_created_ml timestamp with time zone; v_dias_de_vida integer;
  v_is_new_sku boolean; v_mov_reciente boolean;
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

  SELECT MIN(mim.date_created_ml) INTO v_date_created_ml
    FROM ml_items_map mim
   WHERE mim.sku_origen = p_sku_origen AND mim.activo = true;

  v_dias_de_vida := CASE
    WHEN v_date_created_ml IS NULL THEN NULL
    ELSE (CURRENT_DATE - v_date_created_ml::date)::int
  END;

  v_is_new_sku := (v_dias_de_vida IS NOT NULL AND v_dias_de_vida < 60
                   AND COALESCE(v_vel_pond, 0) = 0
                   AND COALESCE(v_vel_pre, 0) = 0);

  v_mov_reciente := (v_dias_sin_mov IS NULL OR v_dias_sin_mov <= 30);

  -- Sprint 7 Fase 1.2: cell default cuando abc/xyz no resuelven
  IF v_costo IS NULL OR v_costo = 0 THEN
    v_status := 'blocked_no_cost';
  ELSE
    v_status := 'active';
    IF v_abc IS NULL OR v_xyz IS NULL THEN
      v_cell := CASE WHEN v_is_new_sku THEN 'BY' ELSE 'CY' END;
    ELSE
      v_cell := v_abc || v_xyz;
    END IF;
  END IF;

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

  RETURN QUERY SELECT
    p_sku_origen, p_node_id, v_template.cell, v_template.service_level, v_z_efectivo,
    v_template.target_dias_full, v_template.target_dias_flex, v_template.action,
    COALESCE(v_vel_pond, 0)::numeric, NULL::numeric, NULL::integer,
    v_xyz_confidence, 'active', v_template.cell,
    v_accion, v_prioridad,
    v_is_new_sku, v_dias_de_vida;
END; $function$;
