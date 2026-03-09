-- EJECUTAR ESTE SQL EN EL SQL EDITOR DE SUPABASE
-- Cada línea es independiente, ejecutar de a una si falla

ALTER TABLE sync_log DROP CONSTRAINT sync_log_tipo_check;

ALTER TABLE sync_log ADD CONSTRAINT sync_log_tipo_check CHECK (tipo IN ('compras', 'ventas', 'mercadopago', 'banco_chile', 'santander_tc'));
