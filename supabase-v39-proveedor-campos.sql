-- v39: Agregar campos de dirección y contacto a proveedor_cuenta
ALTER TABLE proveedor_cuenta ADD COLUMN IF NOT EXISTS direccion text;
ALTER TABLE proveedor_cuenta ADD COLUMN IF NOT EXISTS comuna text;
ALTER TABLE proveedor_cuenta ADD COLUMN IF NOT EXISTS contacto text;
