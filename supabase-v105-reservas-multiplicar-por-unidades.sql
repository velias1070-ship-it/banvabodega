-- ============================================================================
-- BANVA BODEGA — v105: calcular_reservas_correctas multiplica por composicion.unidades
--
-- BUG: La funcion calcular_reservas_correctas() (v32) sumaba si.quantity
-- directo sin multiplicar por composicion_venta.unidades. Para SKUs venta cuyo
-- componente fisico tiene unidades > 1 (packs/combos), las reservas quedaban
-- a la mitad (o fraccion correspondiente).
--
-- CASO TESTIGO: venta 2000016321008334 (1 unid de RAPAC50X70AFAX4 = Pack 4
-- almohadas). Composicion: 1 venta = 2 uds de TX2ALIMFP5070 (pack-2 fisico).
-- Sistema reservaba qty_reserved=1 en vez de 2.
--
-- ALCANCE: 5 SKUs venta con unidades>1 al 2026-05-07
--   RAPAC50X70AFAX4, RAPAC50X70AFAX2, LICAAFVIS5746,
--   LICALCNDAMF57X2, TXALMILLVIS46X2
-- 501 SKUs con unidades=1 no afectados.
--
-- FIX: reemplazar resolver_sku_fisico(seller_sku) por LATERAL JOIN que
-- devuelve sku_origen Y unidades, y multiplicar si.quantity * unidades.
--
-- Mantiene firma (sku_fisico TEXT, qty_deberia_reservar INTEGER) — reconciliar_reservas
-- la consume sin cambios.
-- ============================================================================

CREATE OR REPLACE FUNCTION calcular_reservas_correctas()
RETURNS TABLE(sku_fisico TEXT, qty_deberia_reservar INTEGER)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  WITH
  flex_demand AS (
    SELECT
      UPPER(COALESCE(cv.sku_origen, si.seller_sku)) AS sku,
      SUM(si.quantity * COALESCE(cv.unidades, 1))::INTEGER AS qty
    FROM ml_shipment_items si
    JOIN ml_shipments s ON s.shipment_id = si.shipment_id
    LEFT JOIN LATERAL (
      SELECT sku_origen, unidades
      FROM composicion_venta
      WHERE UPPER(sku_venta) = UPPER(si.seller_sku)
        AND tipo_relacion = 'componente'
      ORDER BY
        CASE WHEN UPPER(sku_origen) != UPPER(si.seller_sku) THEN 0 ELSE 1 END,
        id
      LIMIT 1
    ) cv ON TRUE
    WHERE s.status IN ('ready_to_ship', 'shipped')
      AND s.logistic_type != 'fulfillment'
      AND si.stock_deducted = false
    GROUP BY UPPER(COALESCE(cv.sku_origen, si.seller_sku))
  ),
  full_demand AS (
    SELECT
      UPPER(l->'componentes'->0->>'skuOrigen') AS sku,
      SUM((l->'componentes'->0->>'unidades')::INTEGER)::INTEGER AS qty
    FROM picking_sessions ps,
         jsonb_array_elements(ps.lineas) AS l
    WHERE ps.tipo = 'envio_full'
      AND ps.estado IN ('ABIERTA', 'EN_PROCESO')
      AND l->>'estado' = 'PENDIENTE'
    GROUP BY UPPER(l->'componentes'->0->>'skuOrigen')
  ),
  combined AS (
    SELECT sku, SUM(qty)::INTEGER AS total
    FROM (
      SELECT sku, qty FROM flex_demand
      UNION ALL
      SELECT sku, qty FROM full_demand
    ) all_demand
    GROUP BY sku
  )
  SELECT c.sku AS sku_fisico, c.total AS qty_deberia_reservar
  FROM combined c
  WHERE c.total > 0;
END;
$$;
