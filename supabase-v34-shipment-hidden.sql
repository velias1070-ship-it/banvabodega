-- supabase-v34-shipment-hidden.sql
-- Permite al admin ocultar un shipment del picking/armado/etiquetas del operador
-- Ejecutar en: Supabase → SQL Editor → New query

ALTER TABLE ml_shipments ADD COLUMN IF NOT EXISTS hidden_from_picking BOOLEAN NOT NULL DEFAULT FALSE;
