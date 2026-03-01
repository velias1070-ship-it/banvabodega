-- ==============================================
-- BANVA WMS v4 — Flex Distributed Stock API
-- Ejecutar en: Supabase → SQL Editor → New query
-- NOTA: Ejecutar DESPUÉS de supabase-v3-setup.sql
-- ==============================================

-- 1. Agregar columnas para el API de stock distribuido a ml_items_map
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS user_product_id text;
ALTER TABLE ml_items_map ADD COLUMN IF NOT EXISTS stock_version integer;

-- Índice para búsqueda por user_product_id
CREATE INDEX IF NOT EXISTS idx_ml_items_user_product ON ml_items_map(user_product_id);

-- 2. Agregar service_id a ml_config (necesario para endpoints Flex)
ALTER TABLE ml_config ADD COLUMN IF NOT EXISTS flex_service_id text DEFAULT '';

-- ============================================
-- LISTO! Ejecuta esto en Supabase SQL Editor
-- ============================================
