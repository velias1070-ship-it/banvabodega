-- Sprint 7 Fase 6 — Vista de explicación narrativa por SKU
-- batch:20260505-sprint-7-fase6 | sprint:7 | fase:6
--
-- Doctrina autónoma: el sistema decide solo. La explicación existe para que
-- el owner pueda preguntar "¿por qué este SKU está así?" y recibir respuesta
-- sin abrir el código. Consumo: SQL directo, no UI.

DROP VIEW IF EXISTS v_sku_explanation;

CREATE VIEW v_sku_explanation AS
WITH oc_eta AS (
  SELECT DISTINCT ON (UPPER(ocl.sku_origen))
         UPPER(ocl.sku_origen) AS sku_origen_u,
         oc.fecha_emision,
         oc.numero,
         (ocl.cantidad_pedida - COALESCE(ocl.cantidad_recibida, 0)) AS pendiente_uds
    FROM ordenes_compra_lineas ocl
    JOIN ordenes_compra oc ON oc.id = ocl.orden_id
   WHERE oc.estado <> 'ANULADA'
     AND COALESCE(ocl.cantidad_pedida, 0) > COALESCE(ocl.cantidad_recibida, 0)
     AND oc.fecha_emision IS NOT NULL
   ORDER BY UPPER(ocl.sku_origen), oc.fecha_emision DESC
), base AS (
  SELECT
    vre.*,
    -- Heurística arquitectural: motor usa vel_pre_quiebre cuando quiebre
    -- prolongado (>=14d) y pre_quiebre > velocidad declarada.
    (COALESCE(vre.dias_en_quiebre, 0) >= 14
       AND vre.vel_pre_quiebre IS NOT NULL
       AND vre.vel_pre_quiebre > COALESCE(vre.vel_decl_sem, 0)) AS usa_pre_quiebre,
    -- ETA = emisión + LT declarado (lt_decl es el LT del template).
    -- Cuando in_transit_oc>0, intenta calcular desde la OC abierta más reciente.
    CASE
      WHEN COALESCE(vre.in_transit_oc_bodega, 0) > 0 AND oce.fecha_emision IS NOT NULL
        THEN (oce.fecha_emision + COALESCE(vre.lt_decl, 7)::int)
      ELSE NULL
    END AS eta_oc,
    oce.numero AS eta_oc_numero
  FROM v_reposicion_explain vre
  LEFT JOIN oc_eta oce ON oce.sku_origen_u = UPPER(vre.sku_origen)
), exp AS (
  SELECT b.sku_origen,

         -- VELOCIDAD ----------------------------------------------------
         CASE
           WHEN b.evento_activo IS NOT NULL AND COALESCE(b.multiplicador_evento, 1) <> 1
             THEN format('vel=%s/d ajustada por evento ''%s'' (multiplicador %s)',
                         to_char(COALESCE(b.vel_decl_dia, 0), 'FM990.00'),
                         b.evento_activo,
                         to_char(b.multiplicador_evento, 'FM990.00'))
           WHEN b.usa_pre_quiebre
             THEN format('vel pre-quiebre %s/d > vel actual %s/d porque %s días en quiebre prolongado, motor usa el mayor para SS y ROP',
                         to_char(b.vel_pre_quiebre / 7.0, 'FM990.00'),
                         to_char(COALESCE(b.vel_real_dia, 0), 'FM990.00'),
                         b.dias_en_quiebre)
           ELSE format('vel=%s/d (declarada %s/d, drift %s)',
                       to_char(COALESCE(b.vel_real_dia, 0), 'FM990.00'),
                       to_char(COALESCE(b.vel_decl_dia, 0), 'FM990.00'),
                       CASE
                         WHEN b.vel_drift_pct IS NULL THEN 'sin baseline'
                         ELSE to_char(b.vel_drift_pct, 'FM990.0') || '%'
                       END)
         END AS explicacion_velocidad,

         -- CELDA --------------------------------------------------------
         CASE
           WHEN COALESCE(b.manual_override, false)
             THEN format('cell %s (override manual del owner)', b.cell)
           WHEN COALESCE(b.cell_efectiva, b.cell) <> COALESCE(b.cell_original, b.cell)
                AND b.tendencia LIKE 'acelerando%'
             THEN format('cell %s ORIGINAL → %s EFECTIVA por trend %s (ratio %s vs baseline)',
                         b.cell_original, b.cell_efectiva, b.tendencia,
                         to_char(COALESCE(b.ratio_recent_vs_baseline, 0), 'FM990.00'))
           WHEN COALESCE(b.cell_efectiva, b.cell) <> COALESCE(b.cell_original, b.cell)
                AND b.tendencia LIKE 'desacelerando%'
             THEN format('cell %s ORIGINAL → %s EFECTIVA por %s',
                         b.cell_original, b.cell_efectiva, b.tendencia)
           ELSE format('cell %s (target %sd Full, %sd Flex), z=%s',
                       b.cell,
                       b.target_dias_template,
                       COALESCE(b.target_dias_flex, b.target_dias_flex_template),
                       to_char(COALESCE(b.z, 0), 'FM990.00'))
         END AS explicacion_celda,

         -- QUIEBRE ------------------------------------------------------
         CASE
           WHEN COALESCE(b.dias_en_quiebre, 0) <= 0 THEN NULL
           ELSE format('%s días en quiebre. Causa: %s. Rampup factor: %s%s.',
                       b.dias_en_quiebre,
                       CASE WHEN COALESCE(b.es_quiebre_proveedor, false)
                            THEN 'proveedor' ELSE 'propio' END,
                       to_char(COALESCE(b.factor_rampup_aplicado, 1), 'FM990.00'),
                       CASE WHEN b.rampup_motivo IS NOT NULL
                            THEN ' (' || b.rampup_motivo || ')'
                            ELSE '' END)
         END AS explicacion_quiebre,

         -- COMPROMISOS --------------------------------------------------
         format('stock_bodega %s = bruto %s - reservado %s%s. in_transit OC proveedor: %s uds%s.',
                to_char(COALESCE(b.stock_bodega, 0), 'FM999990'),
                to_char(COALESCE(b.stock_bruto_bodega, 0), 'FM999990'),
                to_char(COALESCE(b.qty_reserved_bodega, 0), 'FM999990'),
                CASE
                  WHEN COALESCE(b.in_transit_picking_full, 0) > 0
                    THEN format(' (picking activo de %s uds hacia Full)',
                                to_char(b.in_transit_picking_full, 'FM999990'))
                  ELSE ''
                END,
                to_char(COALESCE(b.in_transit_oc_bodega, 0), 'FM999990'),
                CASE
                  WHEN b.eta_oc IS NOT NULL
                    THEN format(' (ETA %s, %s)', b.eta_oc::text,
                                COALESCE(b.eta_oc_numero, 'OC'))
                  ELSE ''
                END
         ) AS explicacion_compromisos,

         -- DECISION -----------------------------------------------------
         format(E'deficit Full = pre_full_target %s - stock_full %s - in_transit %s = %s. Disponible para Full = stock_bodega %s - reserva_flex %s = %s. mandar_full_uds = %s.\nqty_a_comprar = MAX(0, ROP %s - stock_total %s - in_transit_oc %s) = %s%s.',
                to_char(COALESCE(b.pre_full_target, 0), 'FM999990'),
                to_char(COALESCE(b.stock_full, 0), 'FM999990'),
                to_char(COALESCE(b.in_transit_picking_full, 0), 'FM999990'),
                to_char(COALESCE(b.deficit_full, 0), 'FM999990'),
                to_char(COALESCE(b.stock_bodega, 0), 'FM999990'),
                to_char(COALESCE(b.reserva_flex_target, 0), 'FM999990'),
                to_char(COALESCE(b.disponible_para_full, 0), 'FM999990'),
                to_char(COALESCE(b.mandar_full_uds, 0), 'FM999990'),
                to_char(COALESCE(b.reorder_point, 0), 'FM999990'),
                to_char(COALESCE(b.stock_total, 0), 'FM999990'),
                to_char(COALESCE(b.in_transit_oc_bodega, 0), 'FM999990'),
                to_char(COALESCE(b.qty_raw, 0), 'FM999990'),
                CASE
                  WHEN COALESCE(b.delta_pack, 0) <> 0
                       OR (COALESCE(b.qty_a_comprar, 0) <> COALESCE(b.qty_raw, 0))
                    THEN format('. Redondeado a inner_pack %s: %s',
                                COALESCE(b.inner_pack, 1),
                                to_char(COALESCE(b.qty_a_comprar, 0), 'FM999990'))
                  ELSE ''
                END
         ) AS explicacion_decision,

         -- LIQUIDACION --------------------------------------------------
         CASE
           WHEN b.liquidacion_accion IS NULL THEN NULL
           ELSE format('dias_extra=%s (DIO %s - target_full %s). liquidacion_accion=''%s'', descuento sugerido %s%%%s.',
                       COALESCE(b.dias_extra, 0),
                       to_char(COALESCE(b.dio, 0), 'FM999990.0'),
                       b.target_dias_template,
                       b.liquidacion_accion::text,
                       to_char(COALESCE(b.liquidacion_descuento_sugerido, 0) * 100, 'FM990'),
                       CASE WHEN b.liquidacion_override IS NOT NULL
                            THEN ' (override owner)'
                            ELSE '' END)
         END AS explicacion_liquidacion,

         -- ALERTAS ------------------------------------------------------
         CASE
           WHEN COALESCE(b.alertas_count, 0) = 0 THEN NULL
           ELSE 'Alertas activas: ' || array_to_string(b.alertas, ', ') || '.'
         END AS explicacion_alertas
    FROM base b
)
SELECT
  e.sku_origen,
  jsonb_strip_nulls(jsonb_build_object(
    'velocidad',   e.explicacion_velocidad,
    'celda',       e.explicacion_celda,
    'quiebre',     e.explicacion_quiebre,
    'compromisos', e.explicacion_compromisos,
    'decision',    e.explicacion_decision,
    'liquidacion', e.explicacion_liquidacion,
    'alertas',     e.explicacion_alertas
  )) AS explicacion,
  CONCAT_WS(E'\n',
    e.explicacion_velocidad,
    e.explicacion_celda,
    e.explicacion_quiebre,
    e.explicacion_compromisos,
    e.explicacion_decision,
    e.explicacion_liquidacion,
    e.explicacion_alertas
  ) AS explicacion_texto
FROM exp e;

COMMENT ON VIEW v_sku_explanation IS
  'Sprint 7 Fase 6: narrativa estructurada por SKU. JSONB por sección (jsonb_strip_nulls) + texto plano. Doctrina autónoma — auditoría puntual del owner vía SQL directo.';

NOTIFY pgrst, 'reload schema';
