-- v57: flag flex_objetivo por SKU (política explícita de canal Flex)
--
-- PR2 del sprint estructura Flex/Full. Separa política de cálculo:
--   - flex_objetivo = true  → SKU debe sostener stock para publicar en Flex
--   - flex_objetivo = false → SKU solo va a Full (default conservador)
--
-- flex_objetivo_auto = true significa que la migración inicial marcó el flag
-- automáticamente por histórico; requiere validación humana. Cuando Vicente
-- toggle desde UI, auto pasa a false y motivo queda etiquetado como 'manual_<fecha>'.
--
-- No cambia el comportamiento del motor todavía. Esa unificación viene en PR3
-- (función `calcularEstadoFlexFull` en src/lib/flex-full.ts).

ALTER TABLE productos
  ADD COLUMN flex_objetivo BOOL DEFAULT false,
  ADD COLUMN flex_objetivo_auto BOOL DEFAULT false,
  ADD COLUMN flex_objetivo_motivo TEXT;

CREATE INDEX idx_productos_flex_objetivo ON productos(flex_objetivo)
  WHERE flex_objetivo = true;

-- Migración inicial (Opción 3+4 con cutoff por ABC + preservación pct_flex=0.30):
-- Nota 2026-04-21: `ventas_ml_cache.canal` usa 'Flex' mayúscula (NO 'flex').
-- `ventas_ml_cache` tiene sku_venta, no sku_origen → join vía composicion_venta.
-- `ventas_ml_cache.fecha` es text; `fecha_date` es date tipada (usar esta).

WITH ventas_flex_agg AS (
  SELECT cv.sku_origen, COUNT(*) AS ventas_flex_90d
  FROM ventas_ml_cache v
  JOIN composicion_venta cv ON cv.sku_venta = v.sku_venta
  WHERE v.canal = 'Flex'
    AND v.fecha_date > (NOW() - INTERVAL '90 days')::date
  GROUP BY cv.sku_origen
),
candidatos AS (
  SELECT si.sku_origen, si.abc, si.pct_flex,
         COALESCE(vfa.ventas_flex_90d, 0) AS ventas_flex_90d
  FROM sku_intelligence si
  LEFT JOIN ventas_flex_agg vfa USING (sku_origen)
  WHERE (
    (si.abc = 'A' AND COALESCE(vfa.ventas_flex_90d, 0) >= 2) OR
    (si.abc = 'B' AND COALESCE(vfa.ventas_flex_90d, 0) >= 3) OR
    (si.abc = 'C' AND COALESCE(vfa.ventas_flex_90d, 0) >= 5) OR
    si.pct_flex::numeric = 0.30
  )
)
UPDATE productos p
SET flex_objetivo = true,
    flex_objetivo_auto = true,
    flex_objetivo_motivo = 'migracion_inicial_2026_04_21'
FROM candidatos c
WHERE p.sku = c.sku_origen;
