-- ============================================================================
-- v107: ampliar rescate CZ_alta_vel a durmientes con stock proveedor
--
-- CONTEXTO: Sprint 9 P2 (`20260506200000_sprint9_p2_cz_alta_vel.sql`) creó el
-- mecanismo de rescate que promueve cell_efectiva CZ → CZ_alta_vel cuando un
-- SKU CZ tiene venta histórica relevante (uds_180d≥10 OR uds_365d≥20 con
-- ult_venta≤120d, o uds_30d≥1 con ult_venta≤7d). El template CZ_alta_vel
-- (target_full=7, target_flex=2, action=reorder_normal) le devuelve buffer
-- a SKUs CZ que el cuadrante por sí solo enterraría.
--
-- BUG: SKUs durmientes con vel_pre_quiebre>0 + stock_proveedor>0 pero
-- uds_180d<10 (caso JSAFAB425P20S: vel_pre=0.22, uds_180d=8, stock_prov=10)
-- caen entre dos sillas:
--   - El v106 d_avg_sem CASE rescata su demanda (0.22 uds/sem).
--   - Pero cell_efectiva sigue en 'CZ' → template no_reorder con target=0.
--   - safety_stock=0, reorder_point=0, target_bodega_minimo=0 → qty=0.
--
-- FIX: agregar tercera condición OR al UPDATE de rescate del paso (C) en
-- refresh_trend_in_sku_node_policy(): si el SKU CZ tiene vel_pre_quiebre>0
-- + stock_proveedor>0, también promover a CZ_alta_vel. La idea: si el
-- proveedor todavía lo tiene listo y vendía algo en el pasado, vale el
-- buffer mínimo (LT cycle_stock) para reactivarlo.
--
-- CASO TESTIGO: JSAFAB425P20S — Idetex, vel_pre_quiebre=0.22 uds/sem,
-- stock_proveedor=10, ult_venta 80d. Con esta extensión:
--   cell_efectiva CZ → CZ_alta_vel
--   target_dias_full=7, target_dias_flex=2, action=reorder_normal
--   d_avg_sem=0.22 (ya rescatado en v106 CASE order)
--   cycle_stock = round(0.22/7 * 5) = 0 (todavía bajo)
--   reserva_flex_target = round(0.22/7 * 2) = 0
--   pre_full_target = round(0.22/7 * 7) = 0
-- → con vel tan baja igual qty puede quedar en 0. Esto es CORRECTO; el SKU
-- entra a la vista pero el motor decide que no vale la pena pedirlo.
-- Lo importante: ya no está oculto, y si la velocidad sube el motor lo
-- procesa automáticamente.
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_trend_in_sku_node_policy()
RETURNS TABLE(rows_affected INTEGER, summary JSONB)
LANGUAGE plpgsql
AS $$
DECLARE
  v_matched INTEGER;
  v_orphans INTEGER;
  v_cz_rescate INTEGER;
  v_summary JSONB;
BEGIN
  -- (A) trend → cell_efectiva (acelerando promueve)
  WITH updates AS (
    UPDATE sku_node_policy snp
    SET tendencia = vtd.tendencia,
        cell_efectiva = CASE
          WHEN vtd.tendencia IN ('acelerando','acelerando_fuerte') THEN
            CASE WHEN snp.cell IN ('CX','CY','CZ') THEN 'B' || SUBSTRING(snp.cell FROM 2)
                 WHEN snp.cell IN ('BX','BY','BZ') THEN 'A' || SUBSTRING(snp.cell FROM 2)
                 ELSE snp.cell END
          ELSE snp.cell
        END,
        promocion_activa = (vtd.tendencia IN ('acelerando','acelerando_fuerte')
                            AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')),
        promocion_motivo = CASE
          WHEN vtd.tendencia IN ('acelerando','acelerando_fuerte')
               AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')
          THEN FORMAT('Promovido por aceleración (%s)', vtd.tendencia)
          WHEN vtd.tendencia = 'recuperacion_post_quiebre'
          THEN 'En recuperación post-quiebre (no promueve hasta sostener 4 sem con stock)'
          ELSE NULL
        END,
        tendencia_updated_at = now()
    FROM v_trend_detection vtd
    WHERE snp.sku_origen = vtd.sku_origen AND snp.policy_status = 'active'
    RETURNING vtd.tendencia AS t_tendencia,
              (vtd.tendencia IN ('acelerando','acelerando_fuerte')
               AND (snp.cell LIKE 'C%' OR snp.cell LIKE 'B%')) AS t_promovido
  )
  SELECT COUNT(*)::INTEGER,
    jsonb_build_object(
      'acelerando', COUNT(*) FILTER (WHERE t_tendencia = 'acelerando'),
      'acelerando_fuerte', COUNT(*) FILTER (WHERE t_tendencia = 'acelerando_fuerte'),
      'estable', COUNT(*) FILTER (WHERE t_tendencia = 'estable'),
      'desacelerando', COUNT(*) FILTER (WHERE t_tendencia = 'desacelerando'),
      'desacelerando_fuerte', COUNT(*) FILTER (WHERE t_tendencia = 'desacelerando_fuerte'),
      'insuficiente_data_matched', COUNT(*) FILTER (WHERE t_tendencia = 'insuficiente_data'),
      'recuperacion_post_quiebre', COUNT(*) FILTER (WHERE t_tendencia = 'recuperacion_post_quiebre'),
      'promovidos', COUNT(*) FILTER (WHERE t_promovido = true)
    )
  INTO v_matched, v_summary
  FROM updates;

  -- (B) Orphans (sin v_trend_detection): cell_efectiva = cell
  WITH updates_orphans AS (
    UPDATE sku_node_policy snp
    SET tendencia = 'insuficiente_data',
        cell_efectiva = snp.cell,
        promocion_activa = false,
        promocion_motivo = NULL,
        tendencia_updated_at = now()
    WHERE snp.policy_status = 'active'
      AND NOT EXISTS (SELECT 1 FROM v_trend_detection vtd WHERE vtd.sku_origen = snp.sku_origen)
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM updates_orphans INTO v_orphans;

  -- (C) Rescate CZ_alta_vel (extendido v107).
  -- 3 disparadores OR:
  --   1. Volumen histórico: uds_180d>=10 OR uds_365d>=20, ult_venta<=120d
  --   2. Reciente: uds_30d>=1, ult_venta<=7d
  --   3. v107: durmiente con stock proveedor — vel_pre_quiebre>0
  --      + proveedor_catalogo.stock_disponible>0 (independiente de uds).
  --      Captura "minas de oro" enterradas: SKU vendía cuando había stock,
  --      ML pausó por out-of-stock, proveedor todavía lo tiene listo.
  WITH ventas_agg AS (
    SELECT cv.sku_origen,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 30) AS uds_30d,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 180) AS uds_180d,
      SUM(vmc.cantidad) FILTER (WHERE vmc.fecha_date >= CURRENT_DATE - 365) AS uds_365d,
      MAX(vmc.fecha_date) AS ultima_venta
    FROM ventas_ml_cache vmc
    JOIN composicion_venta cv ON cv.sku_venta = vmc.sku_venta
    WHERE vmc.anulada = false
    GROUP BY cv.sku_origen
  ),
  rescate AS (
    UPDATE sku_node_policy snp
    SET cell_efectiva = 'CZ_alta_vel',
        promocion_activa = true,
        promocion_motivo = CASE
          WHEN EXISTS (SELECT 1 FROM proveedor_catalogo pc
                       WHERE pc.sku_origen = snp.sku_origen
                         AND COALESCE(pc.stock_disponible, -1) > 0)
               AND COALESCE(si.vel_pre_quiebre, 0) > 0
               AND NOT (
                 (COALESCE(va.uds_180d, 0) >= 10 OR COALESCE(va.uds_365d, 0) >= 20)
                 AND va.ultima_venta >= CURRENT_DATE - 120
               )
               AND NOT (COALESCE(va.uds_30d, 0) >= 1 AND va.ultima_venta >= CURRENT_DATE - 7)
          THEN FORMAT(
            'Rescate v107 durmiente_proveedor: vel_pre=%s uds/sem, stock_prov disponible, uds_180d=%s',
            COALESCE(si.vel_pre_quiebre, 0), COALESCE(va.uds_180d, 0)
          )
          ELSE FORMAT(
            'Rescate CZ_alta_vel: uds_30d=%s, uds_180d=%s, uds_365d=%s, ult_venta=%s',
            COALESCE(va.uds_30d, 0), COALESCE(va.uds_180d, 0),
            COALESCE(va.uds_365d, 0), va.ultima_venta::text
          )
        END,
        tendencia_updated_at = now()
    FROM ventas_agg va
    LEFT JOIN sku_intelligence si ON si.sku_origen = va.sku_origen
    WHERE snp.sku_origen = va.sku_origen
      AND snp.policy_status = 'active'
      AND snp.cell = 'CZ'
      AND snp.cell_efectiva = 'CZ'
      AND (
        ((COALESCE(va.uds_180d, 0) >= 10 OR COALESCE(va.uds_365d, 0) >= 20)
         AND va.ultima_venta >= CURRENT_DATE - 120)
        OR (COALESCE(va.uds_30d, 0) >= 1
            AND va.ultima_venta >= CURRENT_DATE - 7)
        -- v107: durmiente reactivable con stock proveedor
        OR (COALESCE(si.vel_pre_quiebre, 0) > 0
            AND EXISTS (SELECT 1 FROM proveedor_catalogo pc
                        WHERE pc.sku_origen = snp.sku_origen
                          AND COALESCE(pc.stock_disponible, -1) > 0))
      )
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM rescate INTO v_cz_rescate;

  v_summary := v_summary || jsonb_build_object(
    'orphans_no_sales_90d', v_orphans,
    'cz_alta_vel_rescates', v_cz_rescate
  );
  RETURN QUERY SELECT (v_matched + v_orphans + v_cz_rescate), v_summary;
END;
$$;

COMMENT ON FUNCTION refresh_trend_in_sku_node_policy() IS
  'v107: triple update — (A) trend → cell_efectiva, (B) orphans → cell_efectiva=cell, (C) CZ_alta_vel rescate (uds_180d>=10 OR uds_365d>=20 [ult_venta<=120d] OR uds_30d>=1 [ult_venta<=7d] OR vel_pre_quiebre>0 + stock_proveedor>0).';

-- Disparar el refresh para repoblar cell_efectiva con la lógica nueva
SELECT * FROM refresh_trend_in_sku_node_policy();
