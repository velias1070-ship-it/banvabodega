-- =====================================================
-- v15: Agregar razón social y rut_receptor a rcv_ventas
-- =====================================================
-- Campos nuevos para mostrar el nombre del receptor en ventas
-- (obtenidos via endpoint JSON del SII en vez de CSV)

-- Agregar columnas nuevas
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS razon_social TEXT;
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS rut_receptor TEXT;
ALTER TABLE rcv_ventas ADD COLUMN IF NOT EXISTS estado TEXT;

-- Índice para búsqueda por razón social
CREATE INDEX IF NOT EXISTS idx_rcv_ventas_razon_social
  ON rcv_ventas (empresa_id, periodo)
  WHERE razon_social IS NOT NULL;
