-- v91: precio_venta_efectivo en semaforo_semanal
--
-- Contexto: hoy semaforo_semanal.precio_actual guarda ml_items_map.price (precio
-- base del listing, sin promo). Para evaluar 30-day rolling rule (Comparada:103),
-- analisis de elasticidad pre/post markdown (Engines:282) y diagnostico de
-- "precio que el cliente realmente pago", necesitamos tambien el precio efectivo
-- con promo aplicada.
--
-- Fuente: ml_margin_cache.precio_venta (computado en margin-cache/refresh
-- analizando seller-promotions y eligiendo la promo activa de menor price).
--
-- precio_actual se mantiene como esta (price_ml base) para no romper consumidores.
-- precio_venta_efectivo es aditivo.

ALTER TABLE semaforo_semanal
  ADD COLUMN IF NOT EXISTS precio_venta_efectivo numeric;

COMMENT ON COLUMN semaforo_semanal.precio_venta_efectivo IS
  'Precio efectivo con promo aplicada al momento del snapshot. Source: ml_margin_cache.precio_venta. v91 (2026-04-28).';
