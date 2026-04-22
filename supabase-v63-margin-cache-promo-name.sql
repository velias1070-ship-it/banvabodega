-- ============================================
-- BANVA BODEGA — v63: promo_name en ml_margin_cache
--
-- Antes la UI mostraba promo_type ("SELLER_CAMPAIGN") que es generico.
-- ML expone el nombre real de la campaña ("Dia de la Madre") en el campo
-- .name de /seller-promotions/items/{id}. Lo guardamos para mostrar en UI.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

ALTER TABLE ml_margin_cache
ADD COLUMN IF NOT EXISTS promo_name TEXT;

-- ============================================
-- FIN v63
-- ============================================
