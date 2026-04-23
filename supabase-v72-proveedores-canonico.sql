-- v72: Proveedor canónico — RUT como key + proveedor_id FK nullable en 5 tablas
--
-- Contexto: hoy el "proveedor" vive como string en múltiples tablas y cada
-- integración (App Etiquetas, RCV sync, Admin UI, Sheet) lo escribe distinto
-- ("Idetex" vs "IDETEX S.A." vs "IDETEX SPA"). Cada comparación requiere
-- normalizar y cualquier olvido es un silent failure.
--
-- Plan incremental:
--  1. (esta migración) Enriquecer proveedores con rut canónico + aliases +
--     agregar proveedor_id UUID nullable en las 5 tablas con proveedor.
--  2. Endpoint /api/proveedores/resolve lo resuelve por RUT.
--  3. Apps escriben AMBOS (FK + string cache legible) → zero breakage.
--  4. Backfill script llena proveedor_id histórico.
--  5. Cuando 100% con FK → marcar NOT NULL y deprecar string.
--
-- Esta migración es 100% aditiva: no toca columnas existentes, no rompe queries.

-- 1. Enriquecer proveedores
ALTER TABLE proveedores
  ADD COLUMN IF NOT EXISTS nombre_canonico TEXT,
  ADD COLUMN IF NOT EXISTS razon_social TEXT,
  ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';

-- Inicializar nombre_canonico con nombre actual (fuente de verdad para nuevos registros)
UPDATE proveedores SET nombre_canonico = nombre WHERE nombre_canonico IS NULL;

-- UNIQUE en RUT cuando no sea NULL (partial index — admite filas sin RUT cargado todavía)
CREATE UNIQUE INDEX IF NOT EXISTS proveedores_rut_unique
  ON proveedores(rut) WHERE rut IS NOT NULL AND rut != '';

-- 2. Agregar proveedor_id UUID nullable + FK a cada tabla con "proveedor"
ALTER TABLE recepciones
  ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id);

ALTER TABLE ordenes_compra
  ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id);

ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id);

ALTER TABLE proveedor_catalogo
  ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id);

ALTER TABLE rcv_compras
  ADD COLUMN IF NOT EXISTS proveedor_id UUID REFERENCES proveedores(id);

-- 3. Índices para acelerar lookups por FK (sin ellos, los filtros por proveedor
-- seguirían haciendo seq scan hasta que el estado final reemplace al string).
CREATE INDEX IF NOT EXISTS idx_recepciones_proveedor_id ON recepciones(proveedor_id) WHERE proveedor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proveedor_id ON ordenes_compra(proveedor_id) WHERE proveedor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_productos_proveedor_id ON productos(proveedor_id) WHERE proveedor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proveedor_catalogo_proveedor_id ON proveedor_catalogo(proveedor_id) WHERE proveedor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rcv_compras_proveedor_id ON rcv_compras(proveedor_id) WHERE proveedor_id IS NOT NULL;

-- 4. Comentarios para auditoría y futuros agentes
COMMENT ON COLUMN proveedores.nombre_canonico IS 'Nombre canónico para UI. Fuente de verdad para nombres en todo el sistema.';
COMMENT ON COLUMN proveedores.razon_social IS 'Razón social completa según DTE del SII.';
COMMENT ON COLUMN proveedores.aliases IS 'Aliases conocidos de razón social o escrituras previas. Se alimentan automáticamente al resolver por RUT.';
COMMENT ON COLUMN recepciones.proveedor_id IS 'FK a proveedores(id). Preferir sobre proveedor (text). Ver .claude/rules/supabase.md.';
COMMENT ON COLUMN ordenes_compra.proveedor_id IS 'FK a proveedores(id). Preferir sobre proveedor (text).';
COMMENT ON COLUMN productos.proveedor_id IS 'FK a proveedores(id). Preferir sobre proveedor (text).';
COMMENT ON COLUMN proveedor_catalogo.proveedor_id IS 'FK a proveedores(id). Preferir sobre proveedor (text).';
COMMENT ON COLUMN rcv_compras.proveedor_id IS 'FK a proveedores(id). Se resuelve vía rut_proveedor del DTE.';
