-- v106: dimensiones físicas de productos + espejo de lo declarado en ML
--
-- Objetivo: tener fuente única en BANVA de las dimensiones reales (medidas
-- en bodega o declaradas por nosotros) Y espejo de lo que ML tiene
-- declarado, para detectar discrepancias que afectan costo de envío.
--
-- Diseño: dos pares de columnas en `productos`.
--   - largo_cm/ancho_cm/alto_cm/peso_real_gr  → VERDAD BANVA (medido)
--   - ml_largo_cm/.../ml_peso_gr              → ESPEJO de lo que ML reporta
--
-- Si BANVA y ML coinciden → todo OK.
-- Si difieren → flag de discrepancia en v_dim_discrepancias (otra migración).
--
-- Convención NULL:
--   - Cualquier columna NULL = "no sé". Nada de centinelas (regla 1
--     inventory-policy).
--   - Solo tocar columnas ml_* desde el endpoint sync-dimensiones-ml.
--   - Solo tocar columnas BANVA desde edición manual / Excel / bodega.
--
-- Tipos:
--   - cm con decimal(6,1) → hasta 99999.9 cm (>>cualquier bulto BANVA)
--   - peso en gr int → suficiente (BANVA bultos < 50kg = 50.000.000g)

ALTER TABLE productos
  -- BANVA = verdad (medido o declarado por nosotros)
  ADD COLUMN IF NOT EXISTS largo_cm     numeric(6,1),
  ADD COLUMN IF NOT EXISTS ancho_cm     numeric(6,1),
  ADD COLUMN IF NOT EXISTS alto_cm      numeric(6,1),
  ADD COLUMN IF NOT EXISTS peso_real_gr int,
  ADD COLUMN IF NOT EXISTS dimensiones_origen text,
  ADD COLUMN IF NOT EXISTS dimensiones_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS dimensiones_updated_by text,
  -- ML = espejo de lo que ML tiene declarado (cosechado por sync)
  ADD COLUMN IF NOT EXISTS ml_largo_cm     numeric(6,1),
  ADD COLUMN IF NOT EXISTS ml_ancho_cm     numeric(6,1),
  ADD COLUMN IF NOT EXISTS ml_alto_cm      numeric(6,1),
  ADD COLUMN IF NOT EXISTS ml_peso_gr      int,
  ADD COLUMN IF NOT EXISTS ml_dim_synced_at timestamptz;

-- Constraint del origen (vida útil esperada: si después agregamos 'proveedor_catalogo' u otro, ampliar)
ALTER TABLE productos DROP CONSTRAINT IF EXISTS productos_dimensiones_origen_check;
ALTER TABLE productos ADD CONSTRAINT productos_dimensiones_origen_check
  CHECK (dimensiones_origen IS NULL OR dimensiones_origen IN ('ml','excel','manual','bodega'));

COMMENT ON COLUMN productos.largo_cm     IS 'Largo bulto empaquetado en cm. Fuente BANVA (medición real). NULL = no medido.';
COMMENT ON COLUMN productos.ancho_cm     IS 'Ancho bulto empaquetado en cm. Fuente BANVA.';
COMMENT ON COLUMN productos.alto_cm      IS 'Alto bulto empaquetado en cm. Fuente BANVA.';
COMMENT ON COLUMN productos.peso_real_gr IS 'Peso real medido en gramos. Fuente BANVA. ML factura por max(peso_real_gr, peso_volumetrico).';
COMMENT ON COLUMN productos.dimensiones_origen IS 'Origen de las dimensiones BANVA: ml=copiado de ML como baseline, excel=carga masiva, manual=admin, bodega=operario midió.';
COMMENT ON COLUMN productos.ml_largo_cm  IS 'Largo declarado en ML (attributes.PACKAGE_LENGTH). Espejo, no editable manual.';
COMMENT ON COLUMN productos.ml_ancho_cm  IS 'Ancho declarado en ML.';
COMMENT ON COLUMN productos.ml_alto_cm   IS 'Alto declarado en ML.';
COMMENT ON COLUMN productos.ml_peso_gr   IS 'Peso declarado en ML (attributes.PACKAGE_WEIGHT) en gramos.';
COMMENT ON COLUMN productos.ml_dim_synced_at IS 'Timestamp del último fetch a /items/{id} para sincronizar dim ML.';

-- Índice para filtrar rápido los SKUs sin dim cargada (cobertura)
CREATE INDEX IF NOT EXISTS productos_sin_dim_idx
  ON productos (sku) WHERE largo_cm IS NULL OR ancho_cm IS NULL OR alto_cm IS NULL OR peso_real_gr IS NULL;

-- Vista de discrepancias: cruza BANVA vs ML y calcula deltas + peso volumétrico
-- de cada lado. Divisor ML Chile = 4000 (cm³ → kg).
CREATE OR REPLACE VIEW v_dim_discrepancias AS
SELECT
  p.sku,
  p.nombre,
  p.largo_cm,
  p.ancho_cm,
  p.alto_cm,
  p.peso_real_gr,
  p.dimensiones_origen,
  p.ml_largo_cm,
  p.ml_ancho_cm,
  p.ml_alto_cm,
  p.ml_peso_gr,
  p.ml_dim_synced_at,
  -- Peso volumétrico calculado a cada lado (gramos), divisor ML Chile = 4000
  CASE WHEN p.largo_cm > 0 AND p.ancho_cm > 0 AND p.alto_cm > 0
       THEN ROUND((p.largo_cm * p.ancho_cm * p.alto_cm) / 4000.0 * 1000) END AS peso_vol_banva_gr,
  CASE WHEN p.ml_largo_cm > 0 AND p.ml_ancho_cm > 0 AND p.ml_alto_cm > 0
       THEN ROUND((p.ml_largo_cm * p.ml_ancho_cm * p.ml_alto_cm) / 4000.0 * 1000) END AS peso_vol_ml_gr,
  -- Peso facturable (max real vs vol) cada lado
  CASE WHEN p.peso_real_gr > 0 AND p.largo_cm > 0
       THEN GREATEST(p.peso_real_gr, ROUND((p.largo_cm * p.ancho_cm * p.alto_cm) / 4000.0 * 1000)) END AS peso_facturable_banva_gr,
  CASE WHEN p.ml_peso_gr > 0 AND p.ml_largo_cm > 0
       THEN GREATEST(p.ml_peso_gr, ROUND((p.ml_largo_cm * p.ml_ancho_cm * p.ml_alto_cm) / 4000.0 * 1000)) END AS peso_facturable_ml_gr,
  -- Deltas absolutos (cm/gr)
  ABS(COALESCE(p.largo_cm, 0) - COALESCE(p.ml_largo_cm, 0)) AS delta_largo_cm,
  ABS(COALESCE(p.ancho_cm, 0) - COALESCE(p.ml_ancho_cm, 0)) AS delta_ancho_cm,
  ABS(COALESCE(p.alto_cm,  0) - COALESCE(p.ml_alto_cm,  0)) AS delta_alto_cm,
  ABS(COALESCE(p.peso_real_gr, 0) - COALESCE(p.ml_peso_gr, 0)) AS delta_peso_gr,
  -- Flag: tiene discrepancia (alguna dim difiere >5cm o peso >10%)
  CASE
    WHEN p.largo_cm IS NULL OR p.ml_largo_cm IS NULL THEN false
    WHEN ABS(p.largo_cm - p.ml_largo_cm) > 5
      OR ABS(p.ancho_cm - p.ml_ancho_cm) > 5
      OR ABS(p.alto_cm  - p.ml_alto_cm)  > 5
      OR (p.peso_real_gr > 0 AND ABS(p.peso_real_gr - COALESCE(p.ml_peso_gr,0))::float / p.peso_real_gr > 0.10)
    THEN true
    ELSE false
  END AS tiene_discrepancia
FROM productos p
WHERE p.largo_cm IS NOT NULL OR p.ml_largo_cm IS NOT NULL;

COMMENT ON VIEW v_dim_discrepancias IS 'Discrepancia entre dim declaradas en BANVA vs ML. Solo SKUs con datos en al menos un lado. tiene_discrepancia=true si alguna dim difiere >5cm o peso >10%.';
