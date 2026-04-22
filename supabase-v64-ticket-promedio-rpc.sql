-- ============================================
-- BANVA BODEGA — v64: RPC ticket_promedio_por_sku
--
-- Devuelve ticket promedio (revenue/unidades) y unidades vendidas por
-- sku_venta en ventanas 7d y 30d desde ventas_ml_cache, excluyendo
-- ventas anuladas.
--
-- Por que RPC y no SELECT directo: el cliente PostgREST lanza SELECT
-- con default limit=1000, y ventas_ml_cache tiene >3000 filas/30d. El
-- truncation hacia que ticket_7d diera 0 porque las primeras 1000 filas
-- devueltas podian ser todas del inicio del periodo. Con la RPC la
-- agregacion corre en DB sin limit.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

CREATE OR REPLACE FUNCTION ticket_promedio_por_sku()
RETURNS TABLE (
  sku_venta TEXT,
  unidades_30d INTEGER,
  ticket_30d INTEGER,
  unidades_7d INTEGER,
  ticket_7d INTEGER
) AS $$
  SELECT
    v.sku_venta,
    SUM(v.cantidad)::int AS unidades_30d,
    CASE WHEN SUM(v.cantidad) > 0 THEN ROUND(SUM(v.subtotal) / SUM(v.cantidad))::int ELSE 0 END AS ticket_30d,
    SUM(CASE WHEN v.fecha_date >= current_date - 7 THEN v.cantidad ELSE 0 END)::int AS unidades_7d,
    CASE
      WHEN SUM(CASE WHEN v.fecha_date >= current_date - 7 THEN v.cantidad ELSE 0 END) > 0
      THEN ROUND(
        SUM(CASE WHEN v.fecha_date >= current_date - 7 THEN v.subtotal ELSE 0 END) /
        SUM(CASE WHEN v.fecha_date >= current_date - 7 THEN v.cantidad ELSE 0 END)
      )::int
      ELSE 0
    END AS ticket_7d
  FROM ventas_ml_cache v
  WHERE v.fecha_date >= current_date - 30
    AND COALESCE(v.anulada, false) = false
    AND v.sku_venta IS NOT NULL
    AND COALESCE(v.cantidad, 0) > 0
  GROUP BY v.sku_venta;
$$ LANGUAGE sql STABLE;

-- ============================================
-- FIN v64
-- ============================================
