-- Sprint 7 Fase 4 — Alertas autónomas mínimas
-- batch:20260505-sprint-7-fase4 | sprint:7 | fase:4
--
-- Doctrina autónoma: solo se portan alertas que (1) bloquean el pipeline,
-- (2) son anomalías que el sistema NO puede resolver solo, o (3) requieren
-- acción humana excepcional. Las 17 alertas P19 motor viejo se reducen a 5:
--
--   1. sin_costo                — vel>0 sin costo bloquea cálculo
--   2. sin_stock_proveedor      — sistema no puede comprar
--   3. quiebre_largo            — dias_en_quiebre > 30 (decisión humana)
--   4. flex_no_publicado        — ML requiere acción manual
--   5. stock_danado_full        — anomalía física, reconciliación humana
--
-- Eliminadas (10 redundantes con accion + 7 medianas no útiles):
--   urgente, dead_stock, exceso, agotado_full, necesita_pedir,
--   reponer_proactivo, en_transito, nuevo_con_stock, liquidar,
--   promovido_por_trend, pedido_bajo_moq, proveedor_agotado_con_cola_full,
--   pico_demanda, caida_demanda, evento_activo, catch_up_post_quiebre,
--   bajo_meta, sobre_meta, proveedor_volvio_stock,
--   estrella_quiebre_prolongado, quiebre_flex_prolongado, forecast_*

CREATE OR REPLACE VIEW v_sku_alertas AS
WITH publicar_flex_latest AS (
  SELECT DISTINCT ON (sku_origen) sku_origen, publicar_flex
    FROM stock_snapshots
   WHERE publicar_flex IS NOT NULL
   ORDER BY sku_origen, fecha DESC
), stock_full_danado AS (
  SELECT cv.sku_origen,
         SUM(COALESCE(sfc.stock_danado, 0))  AS uds_danado,
         SUM(COALESCE(sfc.stock_perdido, 0)) AS uds_perdido
    FROM stock_full_cache sfc
    JOIN composicion_venta cv ON cv.sku_venta = sfc.sku_venta
   GROUP BY cv.sku_origen
), inputs AS (
  SELECT si.sku_origen,
         si.vel_ponderada,
         si.tiene_stock_prov,
         si.dias_en_quiebre,
         si.vel_flex,
         si.vel_flex_pre_quiebre,
         p.costo_promedio,
         pfl.publicar_flex,
         COALESCE(sfd.uds_danado, 0)  AS uds_danado,
         COALESCE(sfd.uds_perdido, 0) AS uds_perdido
    FROM sku_intelligence si
    LEFT JOIN productos p ON p.sku = si.sku_origen
    LEFT JOIN publicar_flex_latest pfl ON pfl.sku_origen = si.sku_origen
    LEFT JOIN stock_full_danado sfd ON sfd.sku_origen = si.sku_origen
)
SELECT sku_origen,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN COALESCE(vel_ponderada, 0) > 0
                   AND (costo_promedio IS NULL OR costo_promedio = 0)
              THEN 'sin_costo' END,
         CASE WHEN tiene_stock_prov = false
              THEN 'sin_stock_proveedor' END,
         CASE WHEN COALESCE(dias_en_quiebre, 0) > 30
              THEN 'quiebre_largo' END,
         CASE WHEN COALESCE(publicar_flex, 0) = 0
                   AND (COALESCE(vel_flex, 0) > 0 OR COALESCE(vel_flex_pre_quiebre, 0) > 0)
              THEN 'flex_no_publicado' END,
         CASE WHEN uds_danado > 0 OR uds_perdido > 0
              THEN 'stock_danado_full' END
       ], NULL) AS alertas,
       (SELECT COUNT(*) FROM unnest(ARRAY_REMOVE(ARRAY[
         CASE WHEN COALESCE(vel_ponderada, 0) > 0
                   AND (costo_promedio IS NULL OR costo_promedio = 0)
              THEN 'sin_costo' END,
         CASE WHEN tiene_stock_prov = false
              THEN 'sin_stock_proveedor' END,
         CASE WHEN COALESCE(dias_en_quiebre, 0) > 30
              THEN 'quiebre_largo' END,
         CASE WHEN COALESCE(publicar_flex, 0) = 0
                   AND (COALESCE(vel_flex, 0) > 0 OR COALESCE(vel_flex_pre_quiebre, 0) > 0)
              THEN 'flex_no_publicado' END,
         CASE WHEN uds_danado > 0 OR uds_perdido > 0
              THEN 'stock_danado_full' END
       ], NULL))) AS alertas_count
  FROM inputs;

COMMENT ON VIEW v_sku_alertas IS
  'Sprint 7 Fase 4: alertas autónomas mínimas (5 alertas). Doctrina autónoma — solo se exponen condiciones que requieren acción humana excepcional o bloquean el pipeline. Las 17 alertas motor viejo se reducen a 5; el resto se computa o auto-resuelve por el motor.';
