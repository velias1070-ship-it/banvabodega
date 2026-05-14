-- v113: RPC promo_backfill_candidatos
--
-- Devuelve filas de ventas_ml_cache con promo_name_aplicada=NULL que tienen
-- un match en ml_price_history (mismo item_id, detected_at en ventana de ±1 dia
-- respecto a fecha_date de la venta). Para cada candidato devuelve el promo_name
-- mas cercano en tiempo a la venta.
--
-- Usada por /api/cron/promo-backfill para llenar columnas *_aplicada retroactivamente.

CREATE OR REPLACE FUNCTION public.promo_backfill_candidatos(p_days int DEFAULT 60)
RETURNS TABLE (
  id uuid,
  promo_name text,
  promo_pct numeric,
  precio_lista numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH ventas_sin_promo AS (
    SELECT v.id, v.sku_venta, v.fecha, v.fecha_date
    FROM ventas_ml_cache v
    WHERE v.promo_name_aplicada IS NULL
      AND v.anulada = false
      AND v.fecha_date::date > (now()::date - (p_days || ' days')::interval)
  ),
  ranked AS (
    SELECT
      v.id,
      ph.promo_name,
      ph.promo_pct,
      ph.precio_lista,
      ROW_NUMBER() OVER (
        PARTITION BY v.id
        ORDER BY ABS(EXTRACT(EPOCH FROM (ph.detected_at - v.fecha::timestamptz))) ASC
      ) AS rn
    FROM ventas_sin_promo v
    JOIN ml_items_map m ON UPPER(m.sku) = UPPER(v.sku_venta) AND m.activo = true
    JOIN ml_price_history ph ON ph.item_id = m.item_id
    WHERE ph.promo_name IS NOT NULL
      AND ph.detected_at::date BETWEEN v.fecha_date::date - 1 AND v.fecha_date::date + 1
  )
  SELECT id, promo_name, promo_pct, precio_lista
  FROM ranked
  WHERE rn = 1;
$$;

COMMENT ON FUNCTION public.promo_backfill_candidatos(int) IS
  'Candidatos para rellenar promo_name_aplicada en ventas_ml_cache. Match por sku_venta -> item_id -> ml_price_history con detected_at +-1 dia. Devuelve el match temporal mas cercano por venta.';
