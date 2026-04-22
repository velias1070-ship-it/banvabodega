-- ============================================
-- BANVA BODEGA — v65: status_ml en ml_margin_cache
--
-- La tabla guardaba items con activo=true en ml_items_map pero sin el
-- status_ml (active/paused/closed/under_review). Resultado: la UI de
-- Margenes mezclaba 348 active + 275 paused y no se podian separar.
-- Ahora se guarda el status_ml para filtrar por estado real en ML.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

ALTER TABLE ml_margin_cache
ADD COLUMN IF NOT EXISTS status_ml TEXT;

-- Backfill desde ml_items_map
UPDATE ml_margin_cache mc
SET status_ml = mim.status_ml
FROM ml_items_map mim
WHERE mc.item_id = mim.item_id
  AND mc.status_ml IS DISTINCT FROM mim.status_ml;

-- ============================================
-- FIN v65
-- ============================================
