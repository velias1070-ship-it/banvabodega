-- v107: pricing_changes_audit ignora snapshots diarios
--
-- Contexto: ml_price_history ahora recibe filas con fuente='daily_snapshot'
-- generadas por el cron /api/cron/price-daily-snapshot, que garantiza 1 fila
-- por SKU activo por día (necesario para responder "estado al día X" sin
-- extrapolar). Esos snapshots NO son cambios reales y polucionan la vista
-- pricing_changes_audit que se usa para auditar decisiones de pricing.
--
-- Decisión: la vista filtra fuente <> 'daily_snapshot' por default. Cualquier
-- consumer que QUIERA ver los snapshots, va directo a ml_price_history.

CREATE OR REPLACE VIEW pricing_changes_audit AS
SELECT h.id AS history_id,
    h.detected_at,
    h.sku,
    h.sku_origen,
    h.precio_anterior,
    h.precio,
    h.delta_pct,
    h.fuente,
    h.motivo,
    h.actor,
    h.ejecutado_por AS legacy_ejecutado_por,
    h.correlation_id,
    d.id AS decision_id,
    d.motivo AS decision_motivo,
    d.actor AS decision_actor,
    d.applied AS decision_applied,
    d.rule_set_hash AS decision_rule_set_hash,
    d.inputs AS decision_inputs,
    d.decision AS decision_decision,
    h.contexto AS history_contexto,
    h.motivo_detalle
FROM ml_price_history h
LEFT JOIN pricing_decision_log d ON d.request_id = h.correlation_id
WHERE h.fuente <> 'daily_snapshot'
ORDER BY h.detected_at DESC;

COMMENT ON VIEW pricing_changes_audit IS 'Cambios reales de precio (excluye snapshots diarios). Para incluir snapshots ir directo a ml_price_history.';
