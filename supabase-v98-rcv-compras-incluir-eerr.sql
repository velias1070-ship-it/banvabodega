-- v98: Override por documento del flag excluir_eerr
--
-- Complemento de v97. El proveedor define el default (ML excluido), pero
-- puede haber facturas específicas que sí son compras reales (no comisiones)
-- y deben entrar al EERR.
--
-- incluir_eerr:
--   NULL  → usa default del proveedor (proveedor_cuenta.excluir_eerr)
--   TRUE  → fuerza inclusión aunque proveedor esté excluido
--   FALSE → fuerza exclusión aunque proveedor esté incluido (raro)

ALTER TABLE rcv_compras
  ADD COLUMN IF NOT EXISTS incluir_eerr BOOLEAN;

COMMENT ON COLUMN rcv_compras.incluir_eerr IS
  'Override por documento del flag excluir_eerr del proveedor. NULL = usar default. TRUE = forzar incluir. FALSE = forzar excluir.';
