-- v97: Flag para excluir proveedores del EERR (gestión)
--
-- Motivación: ML factura período 27→26 (no calendario), entonces sus comisiones,
-- NC y ND del RCV no cuadran con un EERR mensual. El margen ML real se gestiona
-- desde `ventas_ml_cache` por mes calendario. Por tanto, los docs SII de ML son
-- ruido para el EERR de gestión.
--
-- El flag NO borra docs ni los esconde del SII view — solo los excluye del
-- cómputo del EERR. Se aplican siempre el último doc al RUT, tanto para
-- compras como overrides futuros.

ALTER TABLE proveedor_cuenta
  ADD COLUMN IF NOT EXISTS excluir_eerr BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN proveedor_cuenta.excluir_eerr IS
  'Si true, los rcv_compras de este proveedor se excluyen del EERR. Caso típico: ML (período 27-26 no cuadra con calendario, margen se gestiona desde ventas_ml_cache).';

-- Por default ML queda excluido del EERR (caso original que motivó la regla).
INSERT INTO proveedor_cuenta (rut_proveedor, razon_social, cuenta_variable, excluir_eerr)
VALUES ('77398220-1', 'MercadoLibre Chile Ltda.', TRUE, TRUE)
ON CONFLICT (rut_proveedor) DO UPDATE
  SET excluir_eerr = TRUE;
