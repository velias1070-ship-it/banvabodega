-- ============================================
-- BANVA BODEGA — v66: promos_postulables en ml_margin_cache
--
-- Permite filtrar "items que pueden postular a X pero aun no lo hicieron".
-- Array JSONB con {name, type, id} de promos en status=candidate.
-- Se popla en el refresh desde /seller-promotions/items/{id}.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

ALTER TABLE ml_margin_cache
ADD COLUMN IF NOT EXISTS promos_postulables JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN ml_margin_cache.promos_postulables
IS 'Array de {name,type,id} para promos con status=candidate (disponibles pero no postuladas).';

-- ============================================
-- FIN v66
-- ============================================
