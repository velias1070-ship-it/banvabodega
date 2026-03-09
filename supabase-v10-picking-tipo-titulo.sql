-- v10: Add tipo and titulo columns to picking_sessions
-- These columns are used by the envio_full and flex picking creation flows

ALTER TABLE picking_sessions
  ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'flex',
  ADD COLUMN IF NOT EXISTS titulo text;
