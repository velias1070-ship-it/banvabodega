-- v45: Vincular Notas de Crédito a su factura origen
--
-- SII guarda en cada NC los campos "Tipo Doc Referencia" y "Folio Doc Referencia"
-- que apuntan al documento origen (la factura que la NC modifica/anula).
--
-- Agregamos 3 columnas:
--   factura_ref_tipo   - INT del tipo del doc origen (33 factura, 34 exenta, etc.)
--   factura_ref_folio  - folio del doc origen (string)
--   factura_ref_id     - UUID resuelto al row de rcv_compras correspondiente
--                        (auto-resuelto via trigger cuando factura_ref_folio existe)

ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS factura_ref_tipo INT;
ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS factura_ref_folio TEXT;
ALTER TABLE rcv_compras ADD COLUMN IF NOT EXISTS factura_ref_id UUID REFERENCES rcv_compras(id);

CREATE INDEX IF NOT EXISTS idx_rcv_compras_factura_ref_id ON rcv_compras(factura_ref_id);
CREATE INDEX IF NOT EXISTS idx_rcv_compras_ref_lookup ON rcv_compras(empresa_id, rut_proveedor, tipo_doc, nro_doc);

-- Trigger: cuando se inserta/actualiza una NC con factura_ref_folio,
-- intenta resolver factura_ref_id buscando la factura original del mismo proveedor.
CREATE OR REPLACE FUNCTION resolver_factura_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.factura_ref_folio IS NOT NULL AND NEW.factura_ref_id IS NULL THEN
    SELECT id INTO NEW.factura_ref_id
    FROM rcv_compras
    WHERE empresa_id = NEW.empresa_id
      AND rut_proveedor = NEW.rut_proveedor
      AND tipo_doc = COALESCE(NEW.factura_ref_tipo, 33)
      AND nro_doc = NEW.factura_ref_folio
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rcv_compras_resolver_ref ON rcv_compras;

CREATE TRIGGER trg_rcv_compras_resolver_ref
BEFORE INSERT OR UPDATE ON rcv_compras
FOR EACH ROW
EXECUTE FUNCTION resolver_factura_ref();
