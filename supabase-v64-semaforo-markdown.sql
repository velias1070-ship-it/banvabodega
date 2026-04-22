-- v64: Semaforo markdown sugerido
-- Agrega columnas para sugerir precio de markdown automatico segun regla 60/90/120/180 dias
-- Basado en manuales de inventario clase mundial (Error #6, Regla 90/120/180)

ALTER TABLE semaforo_semanal
  ADD COLUMN IF NOT EXISTS precio_markdown_sugerido numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS markdown_motivo text DEFAULT NULL;

COMMENT ON COLUMN semaforo_semanal.precio_markdown_sugerido IS
  'Precio sugerido para liquidar/acelerar rotacion. NULL = sin sugerencia.';
COMMENT ON COLUMN semaforo_semanal.markdown_motivo IS
  'Codigo del motivo: liquidar_Xd, markdown_40_Xd, markdown_20_Xd, markdown_10_Xd';
