-- v79: RPC ultima_venta_por_sku_origen()
-- Reemplaza la query manual del endpoint /api/pricing/markdown-auto que
-- traía solo 1000 filas por default (sin paginar) y daba fechas estaladas.
-- Bug detectado en validación: SKU TXSB144ISY10P aparecía como "97d sin venta"
-- cuando había vendido 20 veces en abril (último 2026-04-24).
--
-- Hace el GROUP BY en DB con un solo query, devuelve 1 fila por sku_origen.

CREATE OR REPLACE FUNCTION ultima_venta_por_sku_origen()
RETURNS TABLE(sku_origen text, ultima_venta date)
LANGUAGE sql STABLE AS $$
  SELECT cv.sku_origen, MAX(o.fecha::date) AS ultima_venta
  FROM orders_history o
  JOIN composicion_venta cv ON cv.sku_venta = o.sku_venta
  WHERE o.estado = 'Pagada'
  GROUP BY cv.sku_origen;
$$;

GRANT EXECUTE ON FUNCTION ultima_venta_por_sku_origen() TO anon, authenticated;
