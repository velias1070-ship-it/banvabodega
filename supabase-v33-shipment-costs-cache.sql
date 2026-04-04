-- supabase-v33-shipment-costs-cache.sql
-- Cache de costos de envío en ml_shipments para evitar llamadas repetidas a /shipments/{id}/costs
-- Ejecutar en: Supabase → SQL Editor → New query

ALTER TABLE ml_shipments ADD COLUMN IF NOT EXISTS sender_cost INTEGER;
ALTER TABLE ml_shipments ADD COLUMN IF NOT EXISTS bonificacion INTEGER;
ALTER TABLE ml_shipments ADD COLUMN IF NOT EXISTS costs_cached_at TIMESTAMPTZ;
