-- ============================================================
-- v43: sku_intelligence.oportunidad_perdida_es_estimacion
--
-- Contexto:
--   El fix del paso 14c agregó fallbacks en cascada para calcular
--   venta_perdida_pesos cuando margen_full_30d = 0 (SKUs agotados
--   hace mucho no tienen órdenes recientes de donde sacar margen):
--     1) margen_full_30d  (dato real)
--     2) margen_full_60d  (dato real, ventana más larga)
--     3) precio_promedio × 0.25  (estimación — margen 25% asumido)
--
--   Los textiles BANVA suelen tener márgenes más bajos que 25%
--   (quilts 12-18%, toallas 15-20%), así que el fallback del 25%
--   puede inflar venta_perdida_pesos. Este flag marca cuando se
--   usó ese fallback, para poder filtrar en la UI y no tomar
--   decisiones grandes con números estimados.
--
--   Semántica:
--     true  → venta_perdida_pesos > 0 y se usó precio_promedio × 0.25
--     false → venta_perdida_pesos derivó de márgenes reales
--             (o es 0, irrelevante)
-- ============================================================

ALTER TABLE sku_intelligence
  ADD COLUMN IF NOT EXISTS oportunidad_perdida_es_estimacion boolean DEFAULT false;
