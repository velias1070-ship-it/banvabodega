-- v79: Quarantine ml_velocidad_semanal
--
-- Historia:
-- - Creada 2026-04-01 (commit 2089182) como cache para header del semáforo (unidades_semana, revenue_semana, deltas)
-- - El cron que la poblaba estaba roto (*/10 13-23 1-5 * *) → solo días 1-5 del mes → KPI congelado 3+ semanas
-- - 2026-04-22 (commit ae0a2ee) reemplazó el lector por agregado directo sobre orders_history (fuente canónica)
-- - El INSERT del cron metrics-sync siguió escribiendo, pero NADIE leyó la tabla desde entonces (verificado 2026-04-25)
-- - Patrón Regla 5 inventory-policy: cache zombi tras desreemplazo
--
-- Plan:
-- 1. RENAME tabla a _deprecated_*  → si algún consumidor oculto sigue queriendo leer, falla con tabla-no-existe (visible)
-- 2. Comentar la llamada a computeVelocidadSemanal() en ml-metrics.ts → ya no se escribe nada
-- 3. Esperar 2 semanas (hasta 2026-05-09) observando que nada se rompe
-- 4. Si nada grita: DROP definitivo + eliminar función computeVelocidadSemanal()
-- 5. Si algo grita: RENAME de vuelta + descomentar la llamada → investigar quién la necesita
ALTER TABLE ml_velocidad_semanal RENAME TO _deprecated_ml_velocidad_semanal_2026_05_09;

COMMENT ON TABLE _deprecated_ml_velocidad_semanal_2026_05_09 IS
  'Quarantine 2026-04-25. DROP planeado 2026-05-09. Reemplazado por agregados directos sobre orders_history (commit ae0a2ee). Si encontrás un lector nuevo, RENAME de vuelta y avisá.';
