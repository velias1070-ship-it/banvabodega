-- v47: Tabla oficial de costos de envío ML Chile (vigente desde 2026-04-13).
--
-- Fuente oficial:
-- https://www.mercadolibre.cl/ayuda/nuevos-costos-envio-vendedores-reputacion-verde-sin-reputacion_48392
--
-- Aplica a: MercadoLíderes / reputación verde / sin reputación.
-- Canales: Envíos Full, Colecta, Centros de envío, Correo.
-- El costo se factura por el MAYOR entre peso físico y peso volumétrico.
-- Para reputación verde, ML aplica 50% de descuento sobre la columna >=$19.990
-- (debe aplicarlo el caller; la tabla guarda el valor bruto publicado).

CREATE TABLE IF NOT EXISTS ml_shipping_tariffs (
  peso_hasta_gr     INTEGER     NOT NULL PRIMARY KEY,
  peso_hasta_label  TEXT        NOT NULL,
  costo_barato      INTEGER     NOT NULL,   -- precio < $9.990
  costo_medio       INTEGER     NOT NULL,   -- precio $9.990 a $19.989
  costo_caro        INTEGER     NOT NULL,   -- precio >= $19.990
  vigente_desde     DATE        NOT NULL DEFAULT '2026-04-13',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ml_shipping_tariffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ml_shipping_tariffs_all ON ml_shipping_tariffs;
CREATE POLICY ml_shipping_tariffs_all ON ml_shipping_tariffs FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE ml_shipping_tariffs IS
  'Tarifas oficiales de envío ML Chile publicadas el 2026-04-13. Vendedores MercadoLíderes/verde/sin reputación. peso_hasta_gr es el límite superior inclusivo del tramo (en gramos). Buscar con: WHERE peso_hasta_gr >= peso ORDER BY peso_hasta_gr LIMIT 1.';

COMMENT ON COLUMN ml_shipping_tariffs.costo_barato IS 'Costo CLP cuando precio del producto < $9.990';
COMMENT ON COLUMN ml_shipping_tariffs.costo_medio  IS 'Costo CLP cuando precio entre $9.990 y $19.989';
COMMENT ON COLUMN ml_shipping_tariffs.costo_caro   IS 'Costo CLP cuando precio >= $19.990. Reputación verde tiene 50% off sobre este valor.';

-- Poblado (34 tramos desde ≤0,3 kg hasta >300 kg).
INSERT INTO ml_shipping_tariffs (peso_hasta_gr, peso_hasta_label, costo_barato, costo_medio, costo_caro) VALUES
  (300,        'Hasta 0,3 kg',        800,   1000,   3050),
  (500,        'De 0,3 a 0,5 kg',     810,   1020,   3150),
  (1000,       'De 0,5 a 1 kg',       830,   1040,   3250),
  (1500,       'De 1 a 1,5 kg',       850,   1060,   3400),
  (2000,       'De 1,5 a 2 kg',       870,   1080,   3600),
  (3000,       'De 2 a 3 kg',         900,   1100,   3950),
  (4000,       'De 3 a 4 kg',        1040,   1280,   4550),
  (5000,       'De 4 a 5 kg',        1180,   1460,   4900),
  (6000,       'De 5 a 6 kg',        1330,   1640,   5200),
  (8000,       'De 6 a 8 kg',        1470,   1820,   5800),
  (10000,      'De 8 a 10 kg',       1590,   1990,   6200),
  (15000,      'De 10 a 15 kg',      1740,   2290,   7200),
  (20000,      'De 15 a 20 kg',      1890,   2590,   8500),
  (25000,      'De 20 a 25 kg',      2040,   2890,  10000),
  (30000,      'De 25 a 30 kg',      2190,   3190,  13050),
  (40000,      'De 30 a 40 kg',      2390,   3590,  15000),
  (50000,      'De 40 a 50 kg',      2590,   3990,  17300),
  (60000,      'De 50 a 60 kg',      2790,   4390,  19000),
  (70000,      'De 60 a 70 kg',      2990,   4790,  20000),
  (80000,      'De 70 a 80 kg',      3190,   5190,  22300),
  (90000,      'De 80 a 90 kg',      3390,   5590,  24200),
  (100000,     'De 90 a 100 kg',     3590,   5990,  26300),
  (110000,     'De 100 a 110 kg',    3790,   6390,  28400),
  (120000,     'De 110 a 120 kg',    3990,   6790,  31600),
  (130000,     'De 120 a 130 kg',    4190,   7190,  34900),
  (140000,     'De 130 a 140 kg',    4390,   7590,  38400),
  (150000,     'De 140 a 150 kg',    4590,   7990,  41600),
  (175000,     'De 150 a 175 kg',    4790,   8390,  47400),
  (200000,     'De 175 a 200 kg',    4990,   8790,  55600),
  (225000,     'De 200 a 225 kg',    5190,   9190,  63900),
  (250000,     'De 225 a 250 kg',    5390,   9590,  70900),
  (275000,     'De 250 a 275 kg',    5590,   9990,  78400),
  (300000,     'De 275 a 300 kg',    5790,  10390,  85900),
  (2147483647, 'Más de 300 kg',      5990,  10990,  93400)
ON CONFLICT (peso_hasta_gr) DO UPDATE SET
  peso_hasta_label = EXCLUDED.peso_hasta_label,
  costo_barato     = EXCLUDED.costo_barato,
  costo_medio      = EXCLUDED.costo_medio,
  costo_caro       = EXCLUDED.costo_caro,
  updated_at       = now();

-- ── Función de lookup ──────────────────────────────────────────────────
-- calcular_costo_envio_ml(peso_gr, precio) → costo CLP
-- No aplica descuento de reputación verde; el caller debe aplicarlo (50% off
-- sobre costo_caro si el seller tiene reputación verde).

CREATE OR REPLACE FUNCTION calcular_costo_envio_ml(
  p_peso_gr INTEGER,
  p_precio  INTEGER
) RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT
    CASE
      WHEN COALESCE(p_precio, 0) < 9990  THEN costo_barato
      WHEN COALESCE(p_precio, 0) < 19990 THEN costo_medio
      ELSE                                    costo_caro
    END
  FROM ml_shipping_tariffs
  WHERE peso_hasta_gr >= COALESCE(p_peso_gr, 0)
  ORDER BY peso_hasta_gr ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION calcular_costo_envio_ml(INTEGER, INTEGER) IS
  'Devuelve costo envío oficial ML (CLP bruto) según peso facturable en gramos y precio del producto. Usa el mayor entre peso físico y volumétrico como entrada. No aplica 50% off de reputación verde.';
