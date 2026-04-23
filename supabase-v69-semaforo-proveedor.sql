-- v69: Agregar info de proveedor al semaforo
-- Permite distinguir "proveedor agotado" (irrecuperable) vs "falta de OC nuestra"
-- (recuperable pidiendo al proveedor). Data viene de proveedor_catalogo.

ALTER TABLE semaforo_semanal
  ADD COLUMN IF NOT EXISTS proveedor text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stock_proveedor integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS es_quiebre_proveedor boolean DEFAULT false;

COMMENT ON COLUMN semaforo_semanal.proveedor IS
  'Nombre del proveedor segun proveedor_catalogo (ej. Idetex)';
COMMENT ON COLUMN semaforo_semanal.stock_proveedor IS
  'Uds disponibles HOY en el proveedor segun ultimo import';
COMMENT ON COLUMN semaforo_semanal.es_quiebre_proveedor IS
  'True si stock_proveedor = 0. Indica que no se puede reponer.';
