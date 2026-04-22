-- v68: PK de semaforo_semanal es (sku_venta, semana_calculo)
-- Motivo: item_id puede tener multiples variation_id (ej. mismo listing con 3
-- colores). Cada variante tiene su propio sku_venta. El grain correcto es
-- sku_venta, que es unico por variante.

ALTER TABLE semaforo_semanal DROP CONSTRAINT IF EXISTS semaforo_semanal_pkey;
ALTER TABLE semaforo_semanal ADD PRIMARY KEY (sku_venta, semana_calculo);
