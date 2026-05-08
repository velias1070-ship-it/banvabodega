-- ============================================================================
-- v108: subir statement_timeout para anon/authenticated de 8s a 30s
--
-- BUG: queries a v_reposicion_explain (vista compuesta de 7+ subviews con
-- EXISTS subqueries vs proveedor_catalogo) timeoutean intermitentemente.
-- Tiempo medido: 1.6s ~ 5.6s. Con default Supabase de 8s para anon role,
-- ~30% de las requests del frontend devuelven HTTP 500 con
-- "canceling statement due to statement timeout".
--
-- IMPACTO: AdminInteligencia.tsx#cargarOrigen falla → rows=[] → todas las
-- vistas (Pedido a Proveedor, Envío a Full, etc.) muestran empty state
-- "No hay SKUs con pedir_proveedor > 0. Ejecuta Recalcular." aunque
-- el motor tiene 125+ SKUs con qty_a_comprar > 0.
--
-- FIX TEMPORAL: subir el timeout a 30s (más holgura que la peor ejecución
-- vista). Esto NO arregla la complejidad de la vista, solo la tolera.
--
-- FIX PERMANENTE PENDIENTE (sprint próximo):
--   - Materializar v_safety_stock como matview con REFRESH on-demand tras
--     refresh_sku_node_policy_from_templates.
--   - O reescribir v_reposicion_explain como función plpgsql con plan
--     cacheable, evitando re-evaluar EXISTS subqueries por SKU.
--
-- NOTIFY pgrst, 'reload config' es necesario para que PostgREST recargue
-- los settings de los roles (sin él no se aplican hasta el próximo restart).
-- ============================================================================

ALTER ROLE anon SET statement_timeout = '30s';
ALTER ROLE authenticated SET statement_timeout = '30s';
NOTIFY pgrst, 'reload config';
