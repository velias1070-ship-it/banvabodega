-- v20: Agregar campo fuente a stock_full_cache
-- Permite distinguir quién escribió la cantidad: ml_sync (API ML), profitguard (Excel), manual
-- ML sync es la fuente más confiable y tiene prioridad sobre ProfitGuard

ALTER TABLE stock_full_cache ADD COLUMN IF NOT EXISTS fuente text DEFAULT 'manual';
