-- v108: ventas_ml_cache guarda la promo aplicada al momento de la venta
--
-- Hoy ventas_ml_cache solo tiene precio_unitario. Para saber qué promo se
-- aplicó, hay que reconstruir por join temporal con ml_price_history.
-- Eso falla si el cron no había sincronizado el cambio de promo aún.
--
-- Solución: capturar el snapshot de promo al momento del sync de la orden
-- y guardarlo permanente en la fila de la venta.

ALTER TABLE ventas_ml_cache
  ADD COLUMN IF NOT EXISTS promo_name_aplicada text,
  ADD COLUMN IF NOT EXISTS promo_pct_aplicada numeric,
  ADD COLUMN IF NOT EXISTS promo_id_aplicada text,
  ADD COLUMN IF NOT EXISTS price_lista_aplicada numeric;

COMMENT ON COLUMN ventas_ml_cache.promo_name_aplicada IS 'Nombre de la promo activa en ML al momento del sync de la orden. Capturado de ml_margin_cache.promo_name. Inmutable post-sync.';
COMMENT ON COLUMN ventas_ml_cache.promo_pct_aplicada IS 'Porcentaje de descuento de la promo aplicada (si lo reportaba ML).';
COMMENT ON COLUMN ventas_ml_cache.promo_id_aplicada IS 'Deal ID o promo ID raw de ML, si la promo lo expone.';
COMMENT ON COLUMN ventas_ml_cache.price_lista_aplicada IS 'Precio de lista (sin promo) al momento de la venta. Permite calcular descuento absoluto sin reconstruir por join temporal.';
