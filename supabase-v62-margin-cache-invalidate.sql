-- ============================================
-- BANVA BODEGA — v62: Auto-invalidar ml_margin_cache
--
-- Problema: el cron stale=true prioriza synced_at ASC, pero nada invalida la
-- cache cuando cambia productos.costo_promedio o productos.costo. Resultado:
-- 270/623 items quedan con costo=0 mostrando márgenes falsos del 75-82% en la
-- sección Márgenes. Caso real: BOLMATCUERNEG2L mostraba 76% de margen cuando
-- el real era 15,11% (diff de 61 puntos).
--
-- Fix: cuando cambia costo_promedio o costo, poner synced_at = NULL en todos
-- los ml_margin_cache.sku afectados (directo + vía composicion_venta.sku_origen).
-- El cron los toma primero por el orden nullsFirst.
--
-- EJECUTAR EN: Supabase SQL Editor (producción)
-- ============================================

CREATE OR REPLACE FUNCTION invalidate_margin_cache_on_costo_change()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.costo_promedio IS DISTINCT FROM OLD.costo_promedio)
       OR (NEW.costo IS DISTINCT FROM OLD.costo) THEN
        -- 1. Invalidar el SKU directo (items sin composicion o con composicion trivial)
        UPDATE ml_margin_cache
        SET synced_at = NULL
        WHERE sku = NEW.sku;

        -- 2. Invalidar los sku_venta (packs) cuyo sku_origen es este producto
        UPDATE ml_margin_cache
        SET synced_at = NULL
        WHERE sku IN (
            SELECT sku_venta
            FROM composicion_venta
            WHERE sku_origen = NEW.sku
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invalidate_margin_cache_on_costo_change ON productos;
CREATE TRIGGER trg_invalidate_margin_cache_on_costo_change
    AFTER UPDATE ON productos
    FOR EACH ROW
    EXECUTE FUNCTION invalidate_margin_cache_on_costo_change();

-- Bootstrap: marcar como stale todo item cuya costo_bruto actual difiera del
-- costo real derivado de productos + composicion_venta. Esto pone la cache en
-- sync en la próxima ronda del cron sin tener que esperar que alguien toque
-- costos.
WITH costo_real AS (
    SELECT cv.sku_venta AS sku,
           SUM(COALESCE(p.costo_promedio, p.costo, 0) * cv.unidades) AS costo_neto_real
    FROM composicion_venta cv
    LEFT JOIN productos p ON p.sku = cv.sku_origen
    GROUP BY cv.sku_venta
    UNION ALL
    SELECT p.sku, COALESCE(p.costo_promedio, p.costo, 0)
    FROM productos p
    WHERE NOT EXISTS (SELECT 1 FROM composicion_venta cv WHERE cv.sku_venta = p.sku)
)
UPDATE ml_margin_cache mc
SET synced_at = NULL
FROM costo_real cr
WHERE mc.sku = cr.sku
  AND ROUND(cr.costo_neto_real * 1.19) != mc.costo_bruto;

-- ============================================
-- FIN v62
-- ============================================
