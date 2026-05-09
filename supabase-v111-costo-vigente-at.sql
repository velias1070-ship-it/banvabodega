-- v111: función costo_vigente_at(sku, fecha) y vista de estado completo
--
-- Hoy costos_historial captura cambios de costo (sku_origen, costo_anterior,
-- costo_nuevo, created_at) pero no expone vigencia. Para reconstruir el
-- margen histórico exacto, necesitamos saber el costo del momento.
--
-- Diseño:
--   1. Función costo_vigente_at(sku, fecha): retorna el costo_nuevo del
--      último cambio en o antes de fecha. Si no hay registros en
--      costos_historial, fallback a productos.costo_promedio actual.
--   2. Función margen_reconstruido_at(sku, fecha): combina precio (de
--      ml_price_history) + costo (de costos_historial) en esa fecha y
--      devuelve estimación bruta de margen.

CREATE OR REPLACE FUNCTION costo_vigente_at(p_sku text, p_fecha timestamptz)
RETURNS TABLE (costo numeric, fuente text, vigente_desde timestamptz) AS $$
BEGIN
  -- 1. Buscar en costos_historial el último cambio en o antes de la fecha
  RETURN QUERY
  SELECT ch.costo_nuevo, ch.fuente, ch.created_at
  FROM costos_historial ch
  WHERE ch.sku_origen = p_sku AND ch.created_at <= p_fecha
  ORDER BY ch.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- 2. Fallback: productos.costo_promedio actual (no hay registro histórico)
  RETURN QUERY
  SELECT p.costo_promedio, 'productos.costo_promedio_actual'::text, NULL::timestamptz
  FROM productos p
  WHERE p.sku = p_sku
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION costo_vigente_at IS 'Costo del SKU en o antes de la fecha dada, derivado de costos_historial. Si no hay registros previos, fallback a productos.costo_promedio actual.';

-- Función combinada: estado completo del SKU al cierre de una fecha.
-- Devuelve precio + promo + costo + margen estimado en una sola query.
CREATE OR REPLACE FUNCTION estado_sku_at(p_sku text, p_fecha timestamptz)
RETURNS TABLE (
  precio numeric,
  promo_name text,
  promo_pct numeric,
  evento_tag text,
  fuente_precio text,
  desde_precio timestamptz,
  costo numeric,
  fuente_costo text,
  desde_costo timestamptz,
  margen_estimado numeric,
  margen_pct_estimado numeric
) AS $$
DECLARE
  v_precio numeric; v_promo_name text; v_promo_pct numeric;
  v_evento_tag text;
  v_fuente_precio text; v_desde_precio timestamptz;
  v_costo numeric; v_fuente_costo text; v_desde_costo timestamptz;
  v_margen numeric; v_margen_pct numeric;
BEGIN
  -- Precio + promo desde history (incluye snapshots diarios)
  SELECT h.precio, h.promo_name, h.promo_pct, e.evento_tag, h.fuente, h.detected_at
  INTO v_precio, v_promo_name, v_promo_pct, v_evento_tag, v_fuente_precio, v_desde_precio
  FROM ml_price_history h
  LEFT JOIN promos_eventos e ON e.promo_name = h.promo_name
  WHERE h.sku = p_sku AND h.detected_at <= p_fecha
  ORDER BY h.detected_at DESC LIMIT 1;

  -- Costo
  SELECT c.costo, c.fuente, c.vigente_desde
  INTO v_costo, v_fuente_costo, v_desde_costo
  FROM costo_vigente_at(p_sku, p_fecha) c;

  -- Margen estimado (precio - costo, sin comisión/envío que dependen de
  -- otras variables — esto es solo bruto, útil como sanity check)
  IF v_precio IS NOT NULL AND v_costo IS NOT NULL AND v_precio > 0 THEN
    v_margen := v_precio - v_costo;
    v_margen_pct := (v_margen / v_precio) * 100;
  END IF;

  RETURN QUERY SELECT v_precio, v_promo_name, v_promo_pct, v_evento_tag,
    v_fuente_precio, v_desde_precio,
    v_costo, v_fuente_costo, v_desde_costo,
    v_margen, v_margen_pct;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION estado_sku_at IS 'Estado completo del SKU al cierre de una fecha: precio, promo, evento_tag, costo y margen estimado bruto.';
