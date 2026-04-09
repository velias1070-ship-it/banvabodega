-- ============================================================
-- v42: proveedor_catalogo.stock_disponible — sentinel -1 → NULL
--
-- Contexto:
--   Hasta v41, la columna usaba default -1 como sentinel de
--   "desconocido". El motor de inteligencia (intelligence.ts:557)
--   trataba -1 como "sí tiene stock" (optimista), lo que hacía
--   indistinguible un SKU nunca importado de uno con stock real.
--
--   Con el cambio a NULL, el código puede decidir explícitamente:
--     stock_disponible IS NULL  → desconocido (optimista por default)
--     stock_disponible = 0      → AGOTADO (dato real, dispara alertas)
--     stock_disponible > 0      → disponible
--
-- Impacto:
--   1. Nueva alerta "proveedor_agotado_con_cola_full" depende de
--      distinguir 0 explícito de desconocido.
--   2. Re-evaluación de es_quiebre_proveedor usa esta semántica
--      en cada recálculo (no arrastra estado previo).
-- ============================================================

-- 1. Convertir los -1 existentes a NULL
UPDATE proveedor_catalogo
SET stock_disponible = NULL
WHERE stock_disponible = -1;

-- 2. Quitar el default -1 (ahora NULL implícito)
ALTER TABLE proveedor_catalogo
  ALTER COLUMN stock_disponible DROP DEFAULT;
