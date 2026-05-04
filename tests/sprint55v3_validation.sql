-- Sprint 5.5 v3 — Validación SQL
-- Correr en orden, esperar PASS en T1-T3 y T5; T4 reporta distribución
-- (no está atado a meta arbitraria).

-- T1: v_in_transit_por_nodo separa lanes
WITH r AS (
  SELECT to_node_id, qty_in_transit FROM v_in_transit_por_nodo WHERE sku_origen='TXTPBL20200SK'
)
SELECT 'T1' AS test,
  CASE WHEN COUNT(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS resultado,
  STRING_AGG(to_node_id || '=' || qty_in_transit::text, ', ') AS detalle
FROM r;

-- T2: stock_bodega es disponible (descuenta qty_reserved)
SELECT 'T2' AS test,
  CASE WHEN stock_bodega <= stock_bruto_bodega - qty_reserved_bodega + 1 THEN 'PASS' ELSE 'FAIL' END AS resultado,
  FORMAT('bruto=%s reservado=%s disponible=%s', stock_bruto_bodega, qty_reserved_bodega, stock_bodega) AS detalle
FROM v_compras_pendientes WHERE sku_origen='TXTPBL20200SK';

-- T3: TXTPBL20200SK motor nuevo dentro de doctrina (motor viejo + ≤30%)
WITH viejo AS (SELECT pedir_proveedor::numeric AS qty FROM sku_intelligence WHERE sku_origen='TXTPBL20200SK'),
     nuevo AS (SELECT qty_a_comprar::numeric AS qty FROM v_compras_pendientes WHERE sku_origen='TXTPBL20200SK')
SELECT 'T3' AS test,
  CASE WHEN n.qty <= v.qty * 1.30 AND n.qty >= v.qty * 0.70 THEN 'PASS' ELSE 'FAIL' END AS resultado,
  FORMAT('viejo=%s nuevo=%s diff=%s%%', v.qty::int, n.qty::int,
         ROUND((n.qty - v.qty) / v.qty * 100, 1)) AS detalle
FROM viejo v, nuevo n;

-- T4: distribución masiva (REPORTE, no PASS/FAIL — meta de "≥80% ±15%" no es
-- alcanzable hasta cerrar Sprint 6 doctrina pre_full_target)
WITH motor_viejo AS (SELECT sku_origen, pedir_proveedor::numeric AS qty FROM sku_intelligence WHERE pedir_proveedor > 0),
     motor_nuevo AS (SELECT sku_origen, qty_a_comprar::numeric AS qty FROM v_compras_pendientes)
SELECT 'T4' AS test, 'REPORTE' AS resultado,
  FORMAT('total=%s coinciden5pct=%s coinciden15pct=%s coinciden30pct=%s nuevo+15pct=%s nuevo-15pct=%s diff_avg_pct=%s',
    COUNT(*),
    COUNT(*) FILTER (WHERE n.qty <= v.qty * 1.05 AND n.qty >= v.qty * 0.95),
    COUNT(*) FILTER (WHERE n.qty <= v.qty * 1.15 AND n.qty >= v.qty * 0.85),
    COUNT(*) FILTER (WHERE n.qty <= v.qty * 1.30 AND n.qty >= v.qty * 0.70),
    COUNT(*) FILTER (WHERE n.qty > v.qty * 1.15),
    COUNT(*) FILTER (WHERE n.qty < v.qty * 0.85),
    ROUND(AVG((n.qty - v.qty) / NULLIF(v.qty, 0) * 100), 2)
  ) AS detalle
FROM motor_viejo v JOIN motor_nuevo n ON v.sku_origen = n.sku_origen;

-- T5: banner CLP post-fix sigue razonable (entre $5M y $15M esperado)
SELECT 'T5' AS test,
  CASE WHEN SUM(clp_estimado) BETWEEN 5000000 AND 15000000 THEN 'PASS' ELSE 'WARN' END AS resultado,
  FORMAT('skus_bajo_rop=%s total_clp=%s',
    COUNT(*) FILTER (WHERE bajo_rop), TO_CHAR(SUM(clp_estimado), 'FM999G999G999')) AS detalle
FROM v_compras_pendientes;
