-- Marca los 3 SKUs bloqueantes del benchmark PR3 Fase B (2026-04-18)
-- como estacionales. NO ejecutado automáticamente — correr manualmente
-- en el SQL Editor de Supabase post-aplicar v54, para que el trail
-- quede asociado al usuario humano.
--
-- Ver diagnóstico por SKU en:
--   docs/banva-bodega-tsb-benchmark-2026-04-18.md
--   docs/banva-bodega-pr4-preauditoria.md §2

UPDATE sku_intelligence SET
  es_estacional          = true,
  estacional_motivo      = 'pico+caída post-temporada, evaluar con 6 meses más historia',
  estacional_marcado_por = 'vicente',
  estacional_marcado_at  = now(),
  estacional_revisar_en  = (now() + interval '6 months')::date
WHERE sku_origen = 'TXTPBL105200S';

UPDATE sku_intelligence SET
  es_estacional          = true,
  estacional_motivo      = 'decay monotónico fuerte, posible fin-temporada o obsolescencia — revisar con año completo',
  estacional_marcado_por = 'vicente',
  estacional_marcado_at  = now(),
  estacional_revisar_en  = (now() + interval '6 months')::date
WHERE sku_origen = 'TXTPBL1520020';

UPDATE sku_intelligence SET
  es_estacional          = true,
  estacional_motivo      = 'crecimiento sostenido, probablemente NO estacional — revisar clasificación Z (candidato a re-clasificar como Y)',
  estacional_marcado_por = 'vicente',
  estacional_marcado_at  = now(),
  estacional_revisar_en  = (now() + interval '6 months')::date
WHERE sku_origen = 'TXSB144ISY10P';

-- Verificar después de correr:
--   SELECT sku_origen, es_estacional, estacional_motivo, estacional_revisar_en
--   FROM sku_intelligence
--   WHERE es_estacional = true
--   ORDER BY sku_origen;
