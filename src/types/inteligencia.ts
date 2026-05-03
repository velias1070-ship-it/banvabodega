/**
 * Type compartido entre /admin tab "intel" (AdminInteligencia.tsx) y los
 * endpoints /api/intelligence/sku-venta(-v2). Sprint 5 (2026-05-04).
 *
 * Mapping de campos:
 * - Caso A — directo desde v_reposicion_explain (motor nuevo Sprint 4.3a/b/b.1).
 * - Caso B — desde v_reposicion_explain con rename/semantica nueva.
 * - Caso C — sigue leyéndose de sku_intelligence en paralelo (frontera-policy:
 *   ABC, XYZ, cuadrante, accion, alertas, prioridad, gmroi, dio, márgenes,
 *   forecast accuracy, vel_objetivo, etc.). Sprint 5 NO migra estos campos —
 *   la migración de pricing/clasificación va en Sprint 6+.
 *
 * Doc autoritativo: docs/discovery/inteligencia-migration-2026-05-04.md
 * Policy: docs/policies/frontera-reposicion-pricing.md
 */

export interface IntelExplainRow {
  // — Identidad —
  sku_origen: string;
  nombre: string | null;

  // — Caso C (sku_intelligence — clasificación / pricing / accuracy) —
  categoria: string | null;
  proveedor: string | null;
  abc: string;
  xyz: string;
  cuadrante: string;
  abc_pre_quiebre: string | null;
  accion: string;
  prioridad: number;
  alertas: string[];
  alertas_count: number;
  gmroi: number;
  dio: number;
  margen_full_30d: number;
  margen_flex_30d: number;
  canal_mas_rentable: string | null;
  precio_promedio: number;
  ingreso_30d: number;
  costo_neto: number;
  costo_bruto: number;
  venta_perdida_pesos: number;
  oportunidad_perdida_es_estimacion: boolean;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number;
  vel_objetivo: number;
  gap_vel_pct: number | null;
  vel_full: number;
  vel_flex: number;
  pct_full: number;
  pct_flex: number;
  cob_total: number;
  dias_sin_stock_full: number;
  inner_pack: number;
  stock_proveedor: number | null;
  tiene_stock_prov: boolean;
  es_catch_up: boolean;
  forecast_wmape_8s?: number | null;
  forecast_bias_8s?: number | null;
  forecast_tracking_signal_8s?: number | null;
  forecast_semanas_evaluadas_8s?: number | null;
  forecast_es_confiable_8s?: boolean | null;
  forecast_calculado_at?: string | null;
  skus_venta: string[];
  updated_at: string;

  // — Caso A — desde v_reposicion_explain (motor nuevo) —
  vel_ponderada: number;
  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  stock_full: number;
  stock_bodega: number;
  stock_total: number;
  stock_en_transito: number;
  stock_proyectado: number;
  oc_pendientes: number;
  cob_full: number;
  target_dias_full: number;
  mandar_full: number; // del motor viejo, expuesto en v_reposicion_explain para comparación
  pedir_proveedor: number; // = qty_a_comprar (motor nuevo, incluye pre_full_target)
  pedir_proveedor_bultos: number;
  pedir_proveedor_sin_rampup: number;
  factor_rampup_aplicado: number;
  rampup_motivo: string | null;
  vel_pre_quiebre: number;
  dias_en_quiebre: number | null;
  es_quiebre_proveedor: boolean;
  evento_activo: string | null;
  multiplicador_evento: number;
  stock_seguridad: number; // safety_stock
  punto_reorden: number; // reorder_point

  // — Caso A — campos exclusivos del motor nuevo —
  cell: string | null;
  cell_efectiva: string | null;
  cell_original: string | null;
  tendencia: string | null;
  promocion_activa: boolean | null;
  promocion_motivo: string | null;
  pre_full_target: number;
  reserva_flex_target: number;
  bajo_rop: boolean;
  clp_estimado: number;
  dias_cobertura_actual: number;

  // — Trazabilidad —
  motor_fuente?: "viejo" | "nuevo"; // de qué endpoint vino la fila
}
