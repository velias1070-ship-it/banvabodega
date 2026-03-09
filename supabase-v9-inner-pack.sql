-- v9: Agregar columna inner_pack a productos
-- Para persistir el tamaño de bulto del proveedor y usarlo en redondeo inteligente de envíos Full

ALTER TABLE productos ADD COLUMN IF NOT EXISTS inner_pack integer DEFAULT NULL;

COMMENT ON COLUMN productos.inner_pack IS 'Unidades por bulto del proveedor (ej: 5 = bultos de 5 uds). NULL = sin info.';
