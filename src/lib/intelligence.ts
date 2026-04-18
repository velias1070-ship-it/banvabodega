/**
 * Motor de Inteligencia de Inventario — Lógica pura de cálculo.
 * Sin dependencias de React, DOM, Next.js, ni Supabase.
 * Todas las funciones son puras: reciben datos, retornan resultados.
 *
 * Los 19+ pasos del algoritmo de recálculo.
 */

import { calcularCobertura, calcularTargetDias, calcularMargen, COSTO_ENVIO_FLEX } from "./reposicion";
import type { FinancialAgg } from "./reposicion";
import { calcularFactorRampup } from "./rampup";
import { calcularTSB, seleccionarModeloZ } from "./tsb";

/**
 * Determina si un SKU está en "quiebre prolongado" para dimensionar
 * pedir_proveedor usando vel_pre_quiebre en vez de vel_ponderada actual
 * (que queda aplastada cuando no hay ventas por no haber stock).
 *
 * Tres caminos (OR):
 *
 *   1) Zara genérica — días >= 14 con historia robusta (vel_pre > 2).
 *   2) Protección ESTRELLA / CASHCOW — basta 7 días si la velocidad
 *      actual cayó a la mitad (o menos) de la histórica. Evita aplastar
 *      SKUs A que el quiebre está suprimiendo (Manual Parte 1 §2.4;
 *      Guía Completa: "quiebre crónico de A's requiere alerta temprana").
 *   3) Quiebre de proveedor — sin umbral de días si la velocidad actual
 *      cayó a la mitad, la caída viene del proveedor y no del producto
 *      (Manual Parte 3 Error #5).
 *
 * Preconds comunes: stock_full=0 (agotado real) y vel_pre_quiebre > 0.
 */
function esQuiebreProlongadoProtegido(r: SkuIntelRow): boolean {
  if (r.stock_full !== 0) return false;
  if (r.vel_pre_quiebre <= 0) return false;
  const diasQ = r.dias_en_quiebre ?? 0;
  const velAct = r.vel_ponderada;
  const cuad = r.cuadrante;
  // Rama 1: Zara genérica.
  if (diasQ >= 14 && r.vel_pre_quiebre > 2 && velAct > 0) return true;
  // Rama 2: protección ESTRELLA/CASHCOW con caída de velocidad.
  if (diasQ >= 7 && (cuad === "ESTRELLA" || cuad === "CASHCOW") && r.vel_pre_quiebre > velAct * 2) return true;
  // Rama 3: quiebre de proveedor con caída de velocidad.
  if (r.es_quiebre_proveedor && r.vel_pre_quiebre > velAct * 2) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════
   TIPOS
   ═══════════════════════════════════════════════════════════ */

export type AccionIntel =
  | "INACTIVO"
  | "DEAD_STOCK"
  | "MANDAR_FULL"
  | "AGOTADO_PEDIR"
  | "AGOTADO_SIN_PROVEEDOR"
  | "URGENTE"
  | "EN_TRANSITO"
  | "PLANIFICAR"
  | "OK"
  | "EXCESO"
  | "NUEVO";

export type TendenciaVel = "subiendo" | "bajando" | "estable";
export type ClaseABC = "A" | "B" | "C";
export type ClaseXYZ = "X" | "Y" | "Z";
export type Cuadrante = "ESTRELLA" | "VOLUMEN" | "CASHCOW" | "REVISAR";

export type AlertaIntel =
  | "agotado_full"
  | "urgente"
  | "margen_negativo_full"
  | "margen_negativo_flex"
  | "pico_demanda"
  | "caida_demanda"
  | "sin_stock_proveedor"
  | "proveedor_agotado_con_cola_full"
  | "exceso"
  | "dead_stock"
  | "margen_full_bajando"
  | "margen_flex_bajando"
  | "requiere_ajuste_precio"
  | "sin_conteo_30d"
  | "liquidar"
  | "evento_activo"
  | "en_transito"
  // PR2/3 — forecast accuracy
  | "forecast_descalibrado_critico"
  | "forecast_descalibrado"
  | "forecast_sesgo_sostenido"
  | "estrella_quiebre_prolongado"
  | "proveedor_volvio_stock"
  | "catch_up_post_quiebre"
  | "stock_danado_full"
  | "bajo_meta"
  | "sobre_meta"
  | "sin_costo"
  | "costo_posiblemente_obsoleto"
  | "pedido_bajo_moq"
  | "necesita_pedir";

export interface SkuIntelRow {
  sku_origen: string;
  nombre: string | null;
  categoria: string | null;
  proveedor: string | null;
  skus_venta: string[];

  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  vel_ponderada: number;
  vel_full: number;
  vel_flex: number;
  vel_total: number;
  pct_full: number;
  pct_flex: number;

  tendencia_vel: TendenciaVel;
  tendencia_vel_pct: number;
  es_pico: boolean;
  pico_magnitud: number;

  multiplicador_evento: number;
  evento_activo: string | null;
  vel_ajustada_evento: number;

  stock_full: number;
  stock_bodega: number;
  stock_total: number;
  stock_sin_etiquetar: number;
  /** Stock reportado por el proveedor. null = desconocido (nunca importado) */
  stock_proveedor: number | null;
  tiene_stock_prov: boolean;
  inner_pack: number;
  stock_en_transito: number;
  stock_proyectado: number;
  oc_pendientes: number;

  cob_full: number;
  cob_flex: number;
  cob_total: number;
  target_dias_full: number;

  margen_full_7d: number;
  margen_full_30d: number;
  margen_full_60d: number;
  margen_flex_7d: number;
  margen_flex_30d: number;
  margen_flex_60d: number;
  margen_tendencia_full: TendenciaVel;
  margen_tendencia_flex: TendenciaVel;
  canal_mas_rentable: "full" | "flex";
  precio_promedio: number;

  // ABC-XYZ se asignan después del loop global
  // 3 ejes Pareto: margen_bruto (principal), ingreso, unidades.
  // El campo `abc` se mantiene para compatibilidad y siempre = abc_margen.
  abc: ClaseABC;
  abc_margen: ClaseABC;
  abc_ingreso: ClaseABC;
  abc_unidades: ClaseABC;
  ingreso_30d: number;
  pct_ingreso_acumulado: number;
  margen_neto_30d: number;            // margen bruto últimos 30d (input del Pareto)
  pct_margen_acumulado: number;
  uds_30d: number;
  pct_unidades_acumulado: number;
  cv: number;
  xyz: ClaseXYZ;
  desviacion_std: number;
  cuadrante: Cuadrante;

  gmroi: number;
  dio: number;
  costo_neto: number;
  costo_bruto: number;
  costo_fuente: "costo_promedio" | "costo_manual" | "proveedor_catalogo" | null;
  costo_inventario_total: number;

  stock_seguridad: number;       // legacy: SS_simple = Z × σ_D × √LT (sin σ_LT)
  punto_reorden: number;          // legacy: vel × LT + stock_seguridad
  nivel_servicio: number;
  // Fase B reposición: cálculos nuevos en paralelo
  lead_time_real_dias: number | null;       // LT promedio observado (cuando hay OCs)
  lead_time_real_sigma: number | null;      // σ_LT observada
  lead_time_usado_dias: number;             // el que efectivamente entró al cálculo
  lead_time_fuente: "oc_real" | "manual_proveedor" | "manual_producto_legacy" | "fallback_default";
  lt_muestras: number;
  safety_stock_simple: number;              // copia de stock_seguridad (legacy)
  safety_stock_completo: number;            // Z × √(LT × σ_D² + D̄² × σ_LT²)
  safety_stock_fuente: "formula_completa" | "fallback_simple";
  rop_calculado: number;                    // D̄ × LT + safety_stock_completo
  necesita_pedir: boolean;                  // stock_total ≤ rop_calculado

  dias_sin_stock_full: number;
  semanas_con_quiebre: number;
  venta_perdida_uds: number;
  venta_perdida_pesos: number;
  /** true cuando venta_perdida_pesos se calculó con el fallback
   *  precio_promedio × 0.25 (margen estimado) en lugar de margen real.
   *  Permite filtrar en la UI y no tomar decisiones grandes basadas en estimación. */
  oportunidad_perdida_es_estimacion: boolean;
  ingreso_perdido: number;

  accion: AccionIntel;
  prioridad: number;
  mandar_full: number;
  pedir_proveedor: number;
  pedir_proveedor_bultos: number;
  pedir_proveedor_sin_rampup: number;
  factor_rampup_aplicado: number;
  rampup_motivo: string;
  requiere_ajuste_precio: boolean;

  liquidacion_accion: string | null;
  liquidacion_dias_extra: number;
  liquidacion_descuento_sugerido: number;

  ultimo_conteo: string | null;
  dias_sin_conteo: number;
  diferencias_conteo: number;
  ultimo_movimiento: string | null;
  dias_sin_movimiento: number;

  alertas: AlertaIntel[];
  alertas_count: number;

  // Quiebre prolongado
  vel_pre_quiebre: number;
  /** Snapshot del margen unitario al entrar en quiebre. Permite imputar
   *  margen_neto_30d cuando no hay ventas reales últimos 30d. */
  margen_unitario_pre_quiebre: number;
  /** null = historia de quiebre incompleta (sin snapshot válido >= 2020). */
  dias_en_quiebre: number | null;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  gmroi_potencial: number;
  es_catch_up: boolean;

  vel_objetivo: number;
  gap_vel_pct: number | null;

  // PR2/3 — Forecast accuracy (snapshot de la última corrida confiable en ventana 8s).
  // Redundante con forecast_accuracy; cacheado aquí para que la UI filtre sin join.
  forecast_wmape_8s: number | null;
  forecast_bias_8s: number | null;
  forecast_tracking_signal_8s: number | null;
  forecast_semanas_evaluadas_8s: number | null;
  forecast_es_confiable_8s: boolean | null;
  forecast_calculado_at: string | null;

  // PR3 Fase A — TSB shadow (no consumido por el motor, sólo persistido).
  vel_ponderada_tsb: number | null;
  tsb_alpha: number | null;
  tsb_beta: number | null;
  tsb_modelo_usado: "sma_ponderado" | "tsb" | null;
  primera_venta: string | null;           // YYYY-MM-DD
  dias_desde_primera_venta: number | null;

  updated_at: string;
  datos_desde: string | null;
  datos_hasta: string | null;
}

/* ═══════════════════════════════════════════════════════════
   INPUTS
   ═══════════════════════════════════════════════════════════ */

export interface OrdenInput {
  sku_venta: string;
  cantidad: number;
  canal: string;   // "Full" o "Flex"
  fecha: string;    // ISO
  subtotal: number;
  comision_total: number;
  costo_envio: number;
  ingreso_envio: number;
}

export interface ProductoInput {
  sku: string;
  sku_venta: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  costo: number;
  costo_promedio: number;
  precio: number;
  inner_pack: number | null;
  lead_time_dias: number;
  moq: number;                 // mínimo de compra al proveedor
  estado_sku: string;
  updated_at: string | null;
}

export interface ComposicionInput {
  sku_venta: string;
  sku_origen: string;
  unidades: number;
  tipo_relacion?: "componente" | "alternativo";
}

export interface EventoInput {
  nombre: string;
  multiplicador: number;
  categorias: string[];
}

export interface QuiebreSnapshot {
  fecha: string;
  sku_origen: string;
  en_quiebre_full: boolean;
  /** true = viene de stock_snapshots (dato real). false/undefined = inferido */
  explicito?: boolean;
}

export interface ConteoInput {
  lineas: { sku?: string; diferencia?: number }[];
  created_at: string;
}

export interface MovimientoInput {
  sku: string;
  created_at: string;
}

export interface RecalculoConfig {
  cobObjetivo: number;
  cobMaxima: number;
  targetDiasA: number;
  targetDiasB: number;
  targetDiasC: number;
}

export const DEFAULT_INTEL_CONFIG: RecalculoConfig = {
  cobObjetivo: 40,
  cobMaxima: 60,
  targetDiasA: 42,
  targetDiasB: 28,
  targetDiasC: 14,
};

/** Datos previos de sku_intelligence para continuidad de quiebre prolongado */
export interface PrevIntelRow {
  sku_origen: string;
  vel_pre_quiebre: number;
  /** Snapshot del margen unitario al entrar en quiebre. Se preserva entre recálculos. */
  margen_unitario_pre_quiebre: number;
  dias_en_quiebre: number | null;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  vel_ponderada: number;
  abc: string;
  stock_full: number;
  tiene_stock_prov: boolean;
}

export interface StockFullDetailRow {
  sku_venta: string;
  stock_danado: number;
  stock_perdido: number;
  stock_transferencia: number;
}

export interface ProveedorCatalogoInput {
  sku_origen: string;
  proveedor: string;
  inner_pack: number;
  precio_neto: number;
  /** null = desconocido; 0 = explícitamente agotado; >0 = disponible */
  stock_disponible: number | null;
  updated_at: string;
}

export interface RecalculoInput {
  productos: ProductoInput[];
  composicion: ComposicionInput[];
  ordenes: OrdenInput[];
  stockBodega: Map<string, number>;
  stockFull: Map<string, number>;
  stockFullDetail: Map<string, StockFullDetailRow>;
  eventosActivos: EventoInput[];
  quiebres: QuiebreSnapshot[];
  conteos: ConteoInput[];
  movimientos: MovimientoInput[];
  stockEnTransito: Map<string, number>;
  ocPendientesPorSku: Map<string, number>;
  prevIntelligence: Map<string, PrevIntelRow>;
  velObjetivos: Map<string, number>;
  proveedorCatalogo?: Map<string, ProveedorCatalogoInput>;
  /** Margen bruto últimos 30d agregado por sku_origen desde ventas_ml_cache.
   *  Input principal del Pareto abc_margen. Si vacío para un sku, se imputa
   *  desde vel_pre_quiebre × margen_unitario_pre_quiebre × 4.3 (SKUs en quiebre). */
  margenPorSku?: Map<string, number>;
  /** Unidades vendidas últimos 30d agregadas por sku_origen desde ventas_ml_cache.
   *  Input del Pareto abc_unidades. */
  unidadesPorSku?: Map<string, number>;
  /** Lead time por proveedor desde tabla `proveedores` (Fase B reposición).
   *  Map<nombre_proveedor, {lt_dias, sigma_dias, fuente, muestras}>. */
  proveedoresLT?: Map<string, {
    lead_time_dias: number;
    lead_time_sigma_dias: number;
    lead_time_fuente: string;
    lead_time_muestras: number;
  }>;
  /** PR2/3 — últimas métricas de forecast_accuracy por SKU (ventana 8s).
   *  Vacío o ausente si la tabla falla; el motor sigue funcionando sin las
   *  alertas de forecast. Map<sku_origen, MetricaActual>. */
  metricasAccuracy?: Map<string, {
    wmape: number | null;
    bias: number | null;
    tracking_signal: number | null;
    semanas_evaluadas: number;
    es_confiable: boolean;
    calculado_at: string;
  }>;
  /** PR3 Fase A — primera venta histórica por sku_origen (fuera de la ventana
   *  de 60d que trae `ordenes`). Usada para la puerta "edad mínima 60d" que
   *  decide si el SKU entra al régimen TSB. Map<sku_origen (UPPER), Date>.
   *  Si no se pasa, todos los SKUs quedan en régimen SMA ponderado (seguro). */
  primeraVentaPorSkuOrigen?: Map<string, Date>;
  /** PR4 Fase 1 — SKUs marcados manualmente como estacionales. Set<sku_origen
   *  UPPER>. Si está en el set, `seleccionarModeloZ()` devuelve sma_ponderado
   *  aunque sea Z maduro. Si no se pasa, todos los SKUs se consideran no-estacionales. */
  skusEstacionales?: Set<string>;
  config: RecalculoConfig;
  hoy: Date;
  debugSku?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DebugSkuLog = Record<string, any>;

/* ═══════════════════════════════════════════════════════════
   HELPERS PUROS
   ═══════════════════════════════════════════════════════════ */

/** Agrupa órdenes por semana ISO desde una fecha base */
function agruparPorSemana(
  ordenes: { cantidad: number; fecha: string }[],
  semanas: number,
  fechaRef: Date,
): number[] {
  const resultado = new Array(semanas).fill(0);
  for (const o of ordenes) {
    const fechaOrden = new Date(o.fecha);
    const diffMs = fechaRef.getTime() - fechaOrden.getTime();
    const diffDias = diffMs / 86400000;
    const semIdx = Math.floor(diffDias / 7);
    if (semIdx >= 0 && semIdx < semanas) {
      resultado[semIdx] += o.cantidad;
    }
  }
  return resultado;
}

/** Calcula media y desviación estándar */
function mediaYDesviacion(valores: number[]): { media: number; std: number } {
  if (valores.length === 0) return { media: 0, std: 0 };
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const varianza = valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length;
  return { media, std: Math.sqrt(varianza) };
}

/** Calcula tendencia como porcentaje */
function calcTendencia(corto: number, largo: number): { pct: number; dir: TendenciaVel } {
  if (largo <= 0) return { pct: 0, dir: "estable" };
  const pct = ((corto - largo) / largo) * 100;
  if (pct > 15) return { pct, dir: "subiendo" };
  if (pct < -15) return { pct, dir: "bajando" };
  return { pct, dir: "estable" };
}

/** Z-score para nivel de servicio */
function zScore(nivel: number): number {
  if (nivel >= 0.97) return 1.88;
  if (nivel >= 0.95) return 1.65;
  return 1.28;
}

/**
 * Evalúa qué alertas de forecast_accuracy corresponden a un SKU, dada su
 * clasificación y la última medición confiable (ventana 8s).
 *
 * Reglas:
 *   - Sólo dispara si `metrica.es_confiable` (≥4 semanas evaluadas).
 *   - Clase Z excluida: WMAPE alto en Z es ruido de intermitencia, no sesgo.
 *     PR3 (TSB) lo va a tratar aparte.
 *   - Clase A y B solamente (C no es foco; mucho ruido para la señal).
 *   - Umbrales hardcoded (|TS| > 4 y |bias| > vel × 0.3); si hace falta config,
 *     va en un PR posterior.
 */
export function evaluarAlertasForecast(
  row: { abc: ClaseABC; xyz: ClaseXYZ; cuadrante: Cuadrante; vel_ponderada: number },
  metrica: {
    tracking_signal: number | null;
    bias: number | null;
    semanas_evaluadas: number;
    es_confiable: boolean;
  },
): AlertaIntel[] {
  const alertas: AlertaIntel[] = [];
  if (!metrica.es_confiable) return alertas;

  const esAB = row.abc === "A" || row.abc === "B";
  const esXY = row.xyz === "X" || row.xyz === "Y";
  const absTs = metrica.tracking_signal !== null ? Math.abs(metrica.tracking_signal) : 0;

  if (esAB && esXY && absTs > 4) {
    if (row.cuadrante === "ESTRELLA") alertas.push("forecast_descalibrado_critico");
    else alertas.push("forecast_descalibrado");
  }
  if (esAB && metrica.bias !== null && metrica.semanas_evaluadas >= 8
      && Math.abs(metrica.bias) > row.vel_ponderada * 0.3) {
    alertas.push("forecast_sesgo_sostenido");
  }
  return alertas;
}

/* ═══════════════════════════════════════════════════════════
   PASO PRINCIPAL: RECÁLCULO COMPLETO
   ═══════════════════════════════════════════════════════════ */

export function recalcularTodo(input: RecalculoInput): { rows: SkuIntelRow[]; debugLog?: DebugSkuLog } {
  const {
    productos, composicion, ordenes, stockBodega, stockFull, stockFullDetail,
    eventosActivos, quiebres, conteos, movimientos,
    stockEnTransito, ocPendientesPorSku, prevIntelligence, velObjetivos,
    proveedorCatalogo, config, hoy,
    debugSku,
  } = input;
  const proveedoresLT = input.proveedoresLT || new Map();
  const debugSkuUp = debugSku?.toUpperCase();
  let debugLog: DebugSkuLog | undefined;

  const hoyStr = hoy.toISOString().slice(0, 10);
  const hoyMs = hoy.getTime();

  // ── Mapas de lookup ──
  const prodMap = new Map<string, ProductoInput>();
  for (const p of productos) prodMap.set(p.sku.toUpperCase(), p);

  // SKU Origen → SKU Ventas asociados — SOLO desde composicion_venta (excluyendo alternativos)
  const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();

  // SKU Origen principal → SKUs Origen alternativos (por SKU Venta)
  // Ejemplo: RAPAC50X70AFA → [TX2ALIMFP5070]
  const alternativosPorOrigen = new Map<string, string[]>();

  // Construir ventasPorOrigen SOLO desde composicion_venta, normalizado y deduplicado
  for (const c of composicion) {
    const svUp = c.sku_venta.toUpperCase();
    const soUp = c.sku_origen.toUpperCase();
    const esAlternativo = c.tipo_relacion === "alternativo";

    if (esAlternativo) {
      // Buscar el principal de este sku_venta para asociar el alternativo
      const principal = composicion.find(
        p => p.sku_venta.toUpperCase() === svUp && (p.tipo_relacion || "componente") === "componente"
      );
      if (principal) {
        const principalUp = principal.sku_origen.toUpperCase();
        if (!alternativosPorOrigen.has(principalUp)) alternativosPorOrigen.set(principalUp, []);
        const alts = alternativosPorOrigen.get(principalUp)!;
        if (!alts.includes(soUp)) alts.push(soUp);
      }
      continue; // No agregar alternativos a ventasPorOrigen
    }

    if (!ventasPorOrigen.has(soUp)) ventasPorOrigen.set(soUp, []);
    const existing = ventasPorOrigen.get(soUp)!;
    // Deduplicar por UPPER
    if (!existing.some(e => e.skuVenta === svUp)) {
      existing.push({ skuVenta: svUp, unidades: c.unidades });
    }
  }

  // Auto-detect alternativas: si un SKU venta tiene 2+ SKU origen "componente"
  // con las mismas unidades, los secundarios son alternativos del principal
  const compsPorSkuVenta = new Map<string, { soUp: string; unidades: number }[]>();
  for (const c of composicion) {
    if (c.tipo_relacion === "alternativo") continue;
    const svUp = c.sku_venta.toUpperCase();
    if (!compsPorSkuVenta.has(svUp)) compsPorSkuVenta.set(svUp, []);
    compsPorSkuVenta.get(svUp)!.push({ soUp: c.sku_origen.toUpperCase(), unidades: c.unidades });
  }
  for (const [, comps] of Array.from(compsPorSkuVenta.entries())) {
    if (comps.length < 2) continue;
    // El principal es el que tiene sku_origen === sku_venta, o el primero
    const principal = comps.find(c => compsPorSkuVenta.has(c.soUp)) || comps[0];
    for (const c of comps) {
      if (c.soUp === principal.soUp) continue;
      if (c.unidades !== principal.unidades) continue; // diferente unidades = combo real, no alternativo
      if (!alternativosPorOrigen.has(principal.soUp)) alternativosPorOrigen.set(principal.soUp, []);
      const alts = alternativosPorOrigen.get(principal.soUp)!;
      if (!alts.includes(c.soUp)) alts.push(c.soUp);
      // Bidireccional: el alternativo también conoce al principal
      if (!alternativosPorOrigen.has(c.soUp)) alternativosPorOrigen.set(c.soUp, []);
      const alts2 = alternativosPorOrigen.get(c.soUp)!;
      if (!alts2.includes(principal.soUp)) alts2.push(principal.soUp);
    }
  }

  // ── Normalizar Maps de entrada a UPPERCASE ──
  const normMap = <V>(m: Map<string, V>): Map<string, V> => {
    const out = new Map<string, V>();
    m.forEach((v, k) => {
      const ku = k.toUpperCase();
      const existing = out.get(ku);
      if (existing === undefined) out.set(ku, v);
      else if (typeof v === "number" && typeof existing === "number") out.set(ku, (existing + v) as V);
    });
    return out;
  };
  const stockBodegaN = normMap(stockBodega);
  const stockFullN = normMap(stockFull);
  const stockFullDetailN = new Map<string, StockFullDetailRow>();
  stockFullDetail.forEach((v, k) => stockFullDetailN.set(k.toUpperCase(), v));
  const stockEnTransitoN = normMap(stockEnTransito);
  const ocPendientesPorSkuN = normMap(ocPendientesPorSku);

  // Todos los SKU Origen activos
  const allSkusOrigen = new Set<string>();
  for (const p of productos) {
    if (p.estado_sku !== "descontinuado") allSkusOrigen.add(p.sku.toUpperCase());
  }
  ventasPorOrigen.forEach((_, sku) => allSkusOrigen.add(sku));
  stockBodegaN.forEach((qty, sku) => {
    if (qty > 0) allSkusOrigen.add(sku);
  });

  // ── Pre-agrupar órdenes por SKU Venta (normalizado UPPER) ──
  const ordenesPorSkuVenta = new Map<string, OrdenInput[]>();
  for (const o of ordenes) {
    const svUp = o.sku_venta.toUpperCase();
    if (!ordenesPorSkuVenta.has(svUp)) ordenesPorSkuVenta.set(svUp, []);
    ordenesPorSkuVenta.get(svUp)!.push(o);
  }

  // ── Reasignar órdenes huérfanas: sku_venta == sku_origen sin formato propio ──
  // Si hay órdenes bajo un SKU que es sku_origen pero NO es sku_venta en composición,
  // esas órdenes corresponden al formato individual (unidades=1) de ese origen.
  const allSkusVentaComp = new Set<string>();
  for (const c of composicion) allSkusVentaComp.add(c.sku_venta.toUpperCase());

  for (const svUp of Array.from(ordenesPorSkuVenta.keys())) {
    // Solo reasignar si svUp es un sku_origen con formatos pero NO es un sku_venta registrado
    if (allSkusVentaComp.has(svUp)) continue; // ya es un sku_venta válido
    const formatos = ventasPorOrigen.get(svUp);
    if (!formatos || formatos.length === 0) continue; // no es un sku_origen conocido
    // Buscar el formato individual (unidades=1)
    const individual = formatos.find(f => f.unidades === 1);
    if (!individual) continue; // no hay formato individual
    // Mover órdenes al formato individual
    const target = individual.skuVenta;
    if (!ordenesPorSkuVenta.has(target)) ordenesPorSkuVenta.set(target, []);
    ordenesPorSkuVenta.get(target)!.push(...(ordenesPorSkuVenta.get(svUp) || []));
    ordenesPorSkuVenta.delete(svUp);
  }

  // ── Pre-agrupar quiebres por SKU Origen ──
  const quiebresPorSku = new Map<string, QuiebreSnapshot[]>();
  for (const q of quiebres) {
    if (!quiebresPorSku.has(q.sku_origen)) quiebresPorSku.set(q.sku_origen, []);
    quiebresPorSku.get(q.sku_origen)!.push(q);
  }

  // ── Pre-agrupar conteos y movimientos ──
  const conteoPorSku = new Map<string, { ultimoConteo: string; diferencias: number }>();
  for (const c of conteos) {
    if (!Array.isArray(c.lineas)) continue;
    for (const linea of c.lineas) {
      const l = linea as { sku?: string; diferencia?: number };
      if (!l.sku) continue;
      const prev = conteoPorSku.get(l.sku);
      if (!prev || c.created_at > prev.ultimoConteo) {
        conteoPorSku.set(l.sku, {
          ultimoConteo: c.created_at,
          diferencias: (prev?.diferencias || 0) + (l.diferencia && l.diferencia !== 0 ? 1 : 0),
        });
      } else if (l.diferencia && l.diferencia !== 0) {
        prev.diferencias++;
      }
    }
  }

  const ultimoMovPorSku = new Map<string, string>();
  for (const m of movimientos) {
    const prev = ultimoMovPorSku.get(m.sku);
    if (!prev || m.created_at > prev) {
      ultimoMovPorSku.set(m.sku, m.created_at);
    }
  }

  // ── Fechas de referencia ──
  const hace7d = hoyMs - 7 * 86400000;
  const hace30d = hoyMs - 30 * 86400000;
  const hace60d = hoyMs - 60 * 86400000;

  // Buscar rango de datos
  let fechaMin: string | null = null;
  let fechaMax: string | null = null;
  for (const o of ordenes) {
    if (!fechaMin || o.fecha < fechaMin) fechaMin = o.fecha;
    if (!fechaMax || o.fecha > fechaMax) fechaMax = o.fecha;
  }

  // ════════════════════════════════════════
  // LOOP POR SKU ORIGEN (pasos 1-8, 12-19)
  // ════════════════════════════════════════
  const rows: SkuIntelRow[] = [];

  for (const skuOrigen of Array.from(allSkusOrigen)) {
    const prod = prodMap.get(skuOrigen);
    const ventasAsoc = ventasPorOrigen.get(skuOrigen) || [];
    const skusVenta = ventasAsoc.map(v => v.skuVenta);

    // ── PASO 1: Identidad (con datos de proveedor_catalogo si disponible) ──
    const provCat = proveedorCatalogo?.get(skuOrigen);
    const nombre = prod?.nombre || null;
    const categoria = prod?.categoria || null;
    const proveedor = prod?.proveedor || provCat?.proveedor || null;
    // Cascada de costo (prioridad más alta = fuente más confiable)
    // 1. costo_promedio (WAC real calculado desde recepciones)
    // 2. costo (catálogo manual, editado desde admin)
    // 3. precio_neto del proveedor (lista ofrecida por el proveedor)
    let costoNeto = 0;
    let costoFuente: "costo_promedio" | "costo_manual" | "proveedor_catalogo" | null = null;
    if (prod?.costo_promedio && prod.costo_promedio > 0) {
      costoNeto = prod.costo_promedio;
      costoFuente = "costo_promedio";
    } else if (prod?.costo && prod.costo > 0) {
      costoNeto = prod.costo;
      costoFuente = "costo_manual";
    } else if (provCat?.precio_neto && provCat.precio_neto > 0) {
      costoNeto = provCat.precio_neto;
      costoFuente = "proveedor_catalogo";
    }
    const costoBruto = costoNeto > 0 ? Math.round(costoNeto * 1.19) : 0;
    const leadTimeDias = prod?.lead_time_dias || 7;
    const innerPack = provCat?.inner_pack || prod?.inner_pack || 1;
    // null = desconocido (nunca importado) → optimista por default.
    // 0 = explícitamente agotado por el proveedor (dispara alertas).
    // >0 = disponible.
    const stockProveedor: number | null = provCat?.stock_disponible ?? null;
    const tieneStockProv = stockProveedor === null ? true : stockProveedor > 0;

    // ── PASO 2: Demanda (velocidades en unidades físicas) ──
    // Recolectar órdenes de todos los SKU Venta asociados, convertidas a unidades físicas
    const ordenesFisicas7d: number[] = [];
    const ordenesFisicas30d: number[] = [];
    const ordenesFisicas60d: number[] = [];
    let fullQty30d = 0;
    let flexQty30d = 0;

    // Para financials por ventana y canal
    const financials = {
      full_7d: emptyFinancial(), flex_7d: emptyFinancial(),
      full_30d: emptyFinancial(), flex_30d: emptyFinancial(),
      full_60d: emptyFinancial(), flex_60d: emptyFinancial(),
    };
    let precioTotal = 0;
    let precioCnt = 0;

    // Para XYZ: ventas semanales últimas 8.6 semanas
    const ventasSemana = new Array(9).fill(0); // 9 semanas para cubrir 60d

    // Lookup rápido: skuVenta → unidades físicas por formato
    const unidadesPorSkuVenta = new Map<string, number>();
    for (const va of ventasAsoc) {
      unidadesPorSkuVenta.set(va.skuVenta, va.unidades);
    }

    // Recolectar órdenes de todos los SKU Venta asociados SIN duplicar.
    // Cada orden se procesa una sola vez con el multiplicador de SU formato.
    const ordenesYaProcesadas = new Set<OrdenInput>();
    for (const va of ventasAsoc) {
      const ords = ordenesPorSkuVenta.get(va.skuVenta) || [];
      for (const o of ords) {
        if (ordenesYaProcesadas.has(o)) continue;
        ordenesYaProcesadas.add(o);

        // Usar el multiplicador del formato que coincide con el sku_venta de la orden
        const svUp = o.sku_venta.toUpperCase();
        const unidades = unidadesPorSkuVenta.get(svUp) ?? va.unidades;

        const fechaMs = new Date(o.fecha).getTime();
        const udsFisicas = o.cantidad * unidades;
        const esFull = o.canal === "Full";

        // Precio promedio
        if (o.subtotal > 0 && o.cantidad > 0) {
          precioTotal += o.subtotal / o.cantidad;
          precioCnt++;
        }

        // Ventana 60d
        if (fechaMs >= hace60d) {
          ordenesFisicas60d.push(udsFisicas);
          addFinancial(financials[esFull ? "full_60d" : "flex_60d"], o);
          // Semana para XYZ
          const semIdx = Math.floor((hoyMs - fechaMs) / (7 * 86400000));
          if (semIdx >= 0 && semIdx < 9) ventasSemana[semIdx] += udsFisicas;
        }
        if (fechaMs >= hace30d) {
          ordenesFisicas30d.push(udsFisicas);
          addFinancial(financials[esFull ? "full_30d" : "flex_30d"], o);
          if (esFull) fullQty30d += udsFisicas;
          else flexQty30d += udsFisicas;
        }
        if (fechaMs >= hace7d) {
          ordenesFisicas7d.push(udsFisicas);
          addFinancial(financials[esFull ? "full_7d" : "flex_7d"], o);
        }
      }
    }

    // Detección de quiebres para excluir del promedio.
    // SOLO contar semanas con registro EXPLÍCITO en_quiebre_full = true.
    // La ausencia de datos en stock_snapshots NO es evidencia de quiebre.
    // Además, solo excluir si la semana tiene ≥3 días marcados como quiebre
    // (para evitar que un solo registro afecte toda la semana).
    const quiebresDelSku = quiebresPorSku.get(skuOrigen) || [];
    const diasQuiebrePorSemana = new Map<number, number>();
    for (const q of quiebresDelSku) {
      if (q.en_quiebre_full && q.explicito) {
        const fechaMs = new Date(q.fecha).getTime();
        const semIdx = Math.floor((hoyMs - fechaMs) / (7 * 86400000));
        if (semIdx >= 0 && semIdx < 9) {
          diasQuiebrePorSemana.set(semIdx, (diasQuiebrePorSemana.get(semIdx) || 0) + 1);
        }
      }
    }
    const semanasEnQuiebre = new Set<number>();
    diasQuiebrePorSemana.forEach((dias, sem) => {
      if (dias >= 3) semanasEnQuiebre.add(sem);
    });

    // Velocidades con exclusión de quiebres
    const vel7d = sumar(ordenesFisicas7d); // 7 días = 1 semana, no se excluye
    const semanas30d = 4.3;
    const semanas60d = 8.6;

    // Para vel_30d y vel_60d, excluir semanas en quiebre del divisor
    const semanasActivas30d = Math.max(1, countActiveSemanas(4, semanasEnQuiebre));
    const semanasActivas60d = Math.max(1, countActiveSemanas(9, semanasEnQuiebre));

    const vel30d = sumar(ordenesFisicas30d) / semanasActivas30d;
    const vel60d = sumar(ordenesFisicas60d) / semanasActivas60d;

    // Velocidad ponderada (Promedio Móvil Ponderado)
    // Override PG eliminado (decisión Vicente, sesión auditoría Fase B)
    // vel_ponderada se calcula solo desde ventas reales + exclusión de quiebres
    // Para SKUs en quiebre prolongado, vel_pre_quiebre cubre la imputación
    const velPonderada = (vel7d * 0.5) + (vel30d * 0.3) + (vel60d * 0.2);

    // ── DEBUG: capturar datos intermedios para un SKU específico ──
    if (debugSkuUp && skuOrigen.toUpperCase() === debugSkuUp) {
      // Órdenes encontradas por formato
      const ordenesPorFormato: Record<string, { count: number; totalQty: number; udsFisicas: number }> = {};
      for (const va of ventasAsoc) {
        const ords = ordenesPorSkuVenta.get(va.skuVenta) || [];
        const totalQty = ords.reduce((s, o) => s + o.cantidad, 0);
        ordenesPorFormato[va.skuVenta] = {
          count: ords.length,
          totalQty,
          udsFisicas: totalQty * va.unidades,
        };
      }

      // Detalle quiebres
      const quiebresExplicitos = quiebresDelSku.filter(q => q.explicito && q.en_quiebre_full);
      const quiebresInferidos = quiebresDelSku.filter(q => !q.explicito && q.en_quiebre_full);
      const diasQuiebreDebug: Record<number, number> = {};
      diasQuiebrePorSemana.forEach((dias, sem) => { diasQuiebreDebug[sem] = dias; });

      debugLog = {
        sku_origen: skuOrigen,
        ventasAsoc_count: ventasAsoc.length,
        ventasAsoc: ventasAsoc.map(v => ({ skuVenta: v.skuVenta, unidades: v.unidades })),
        ordenes_por_formato: ordenesPorFormato,
        ordenes_procesadas_total: ordenesYaProcesadas.size,
        suma_uds_fisicas_7d: sumar(ordenesFisicas7d),
        suma_uds_fisicas_30d: sumar(ordenesFisicas30d),
        suma_uds_fisicas_60d: sumar(ordenesFisicas60d),
        quiebres_total: quiebresDelSku.length,
        quiebres_explicitos: quiebresExplicitos.length,
        quiebres_inferidos_ignorados: quiebresInferidos.length,
        dias_quiebre_por_semana: diasQuiebreDebug,
        semanas_en_quiebre: Array.from(semanasEnQuiebre),
        semanas_activas_30d: semanasActivas30d,
        semanas_activas_60d: semanasActivas60d,
        vel_7d: round2(vel7d),
        vel_30d: round2(vel30d),
        vel_60d: round2(vel60d),
        vel_ponderada: round2(velPonderada),
        fullQty30d,
        flexQty30d,
      };
    }

    // Distribución por canal (inicial por volumen, se ajusta por margen en paso 7b)
    const totalCanal30d = fullQty30d + flexQty30d;
    let pctFull = totalCanal30d > 0 ? fullQty30d / totalCanal30d : 1.0;
    let pctFlex = 1 - pctFull;

    const velFull = velPonderada * pctFull;
    const velFlex = velPonderada * pctFlex;

    // ── PASO 3: Tendencia y picos ──
    const tendVel = calcTendencia(vel7d, vel30d);
    const esPico = vel30d > 0 && vel7d > vel30d * 1.5;
    const picoMagnitud = vel30d > 0 ? vel7d / vel30d : 0;

    // ── PASO 4: Eventos estacionales ──
    let multiplicadorEvento = 1.0;
    let eventoActivo: string | null = null;
    for (const ev of eventosActivos) {
      if (ev.categorias.length === 0 || (categoria && ev.categorias.includes(categoria))) {
        multiplicadorEvento = Math.max(multiplicadorEvento, ev.multiplicador);
        eventoActivo = ev.nombre;
      }
    }
    const velAjustadaEvento = velPonderada * multiplicadorEvento;

    // ── PASO 5: Stock ──
    // Sumar stock del principal + alternativos
    let stBodega = stockBodegaN.get(skuOrigen) || 0;
    const alts = alternativosPorOrigen.get(skuOrigen);
    if (alts) {
      for (const altSku of alts) {
        stBodega += stockBodegaN.get(altSku) || 0;
      }
    }
    // Stock Full: sumar de todos los SKU Venta asociados (convertir a físico)
    let stFull = 0;
    for (const va of ventasAsoc) {
      const sfVenta = stockFullN.get(va.skuVenta) || 0;
      stFull += sfVenta * va.unidades;
    }
    const stTotal = stFull + stBodega;
    let stEnTransito = stockEnTransitoN.get(skuOrigen) || 0;
    if (alts) {
      for (const altSku of alts) {
        stEnTransito += stockEnTransitoN.get(altSku) || 0;
      }
    }
    const stProyectado = stTotal + stEnTransito;
    const ocPend = ocPendientesPorSkuN.get(skuOrigen) || 0;

    // ── PASO 6: Cobertura ──
    const velCalculo = multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada;
    const velFullCalc = velCalculo * pctFull;
    const velFlexCalc = velCalculo * pctFlex;

    const cobFull = calcularCobertura(stFull, velFullCalc);
    const cobFlex = calcularCobertura(stBodega, velFlexCalc);
    const cobTotal = calcularCobertura(stTotal, velCalculo);

    // ── PASO 7: Margen por canal (3 ventanas) ──
    const margenFull7d = calcMargenIntel(financials.full_7d, "full", costoBruto);
    const margenFull30d = calcMargenIntel(financials.full_30d, "full", costoBruto);
    const margenFull60d = calcMargenIntel(financials.full_60d, "full", costoBruto);
    const margenFlex7d = calcMargenIntel(financials.flex_7d, "flex", costoBruto);
    const margenFlex30d = calcMargenIntel(financials.flex_30d, "flex", costoBruto);
    const margenFlex60d = calcMargenIntel(financials.flex_60d, "flex", costoBruto);

    const tendMargenFull = calcTendencia(margenFull7d, margenFull30d);
    const tendMargenFlex = calcTendencia(margenFlex7d, margenFlex30d);
    const canalMasRentable: "full" | "flex" = margenFlex30d > margenFull30d ? "flex" : "full";
    const precioPromedio = precioCnt > 0 ? Math.round(precioTotal / precioCnt) : 0;

    // ── PASO 7b: Ratio de reposición por margen ──
    // Si margen_flex / margen_full > 1.1 → 70/30 (más Flex porque es más rentable)
    // De lo contrario → 80/20 (priorizar Full como canal principal)
    if (margenFull30d > 0 && margenFlex30d > 0 && margenFlex30d / margenFull30d > 1.1) {
      // Flex significativamente más rentable
      pctFull = 0.70;
      pctFlex = 0.30;
    } else {
      // Default: Full como canal principal
      pctFull = 0.80;
      pctFlex = 0.20;
    }

    // ── PASO 8: Target de cobertura (placeholder — se asigna por ABC en paso 8b) ──
    const targetDiasFull = config.cobObjetivo;

    // ── PASO 10 (parcial): XYZ — CV con datos semanales ──
    // Usar solo semanas sin quiebre
    const ventasSemanaActivas = ventasSemana.filter((_, i) => !semanasEnQuiebre.has(i));
    const { media: mediaSemanal, std: stdSemanal } = mediaYDesviacion(ventasSemanaActivas);
    const cv = mediaSemanal > 0 ? stdSemanal / mediaSemanal : 999;
    let xyz: ClaseXYZ = "Z";
    if (cv < 0.5) xyz = "X";
    else if (cv < 1.0) xyz = "Y";

    // ── PASO 10b (PR3 Fase A): TSB shadow ──
    // Corre TSB en paralelo al SMA ponderado. NO se consume para decisiones
    // del motor — sólo se persiste. Fase C decide activar. Try/catch: cualquier
    // error en TSB no rompe el recálculo, sólo queda con valores null.
    let velPonderadaTsb: number | null = null;
    let tsbAlpha: number | null = null;
    let tsbBeta: number | null = null;
    let tsbModeloUsado: "sma_ponderado" | "tsb" | null = null;
    let primeraVentaIso: string | null = null;
    let diasDesdePrimeraVenta: number | null = null;
    try {
      const primeraVentaDate = input.primeraVentaPorSkuOrigen?.get(skuOrigen);
      if (primeraVentaDate) {
        primeraVentaIso = primeraVentaDate.toISOString().slice(0, 10);
        diasDesdePrimeraVenta = Math.floor(
          (hoyMs - primeraVentaDate.getTime()) / 86_400_000,
        );
      }
      const esEstacional = input.skusEstacionales?.has(skuOrigen) ?? false;
      const modelo = seleccionarModeloZ(
        { primera_venta: primeraVentaDate ?? null, xyz, es_estacional: esEstacional },
        hoy,
      );
      tsbModeloUsado = modelo;
      if (modelo === "tsb") {
        // ventasSemana[0] = semana más reciente; TSB espera ASC (vieja → nueva).
        const ventasAsc = [...ventasSemana].reverse();
        const tsb = calcularTSB(ventasAsc);
        if (tsb) {
          velPonderadaTsb = tsb.forecast;
          tsbAlpha = tsb.alpha_usado;
          tsbBeta = tsb.beta_usado;
        }
      }
    } catch (err) {
      // Falla silenciosa — shadow mode no debe romper el motor.
      // Deja los campos en null; el warning es útil para debug puntual.
      if (debugSkuUp && skuOrigen.toUpperCase() === debugSkuUp) {
        console.warn(`[intelligence] TSB falló para ${skuOrigen}:`, err);
      }
    }

    // ── PASO 12: Stock de seguridad (preliminar, se ajusta después con ABC) ──
    const leadTimeSemanas = leadTimeDias / 7;
    // Nivel de servicio se ajusta después con ABC
    const nivelServicio = 0.95;
    const Z = zScore(nivelServicio);
    const stockSeguridad = Z * stdSemanal * Math.sqrt(leadTimeSemanas);
    const puntoReorden = (velPonderada * leadTimeSemanas) + stockSeguridad;

    // ── PASO 13: Indicadores financieros ──
    const margenProm = margenFull30d * pctFull + margenFlex30d * pctFlex;
    const margenBrutoAnual = margenProm * velPonderada * 52;
    const costoInventarioTotal = costoBruto * stTotal;
    const gmroi = costoInventarioTotal > 0 ? margenBrutoAnual / costoInventarioTotal : 0;
    const dio = velPonderada > 0 ? (stTotal / velPonderada) * 7 : 999;

    // ── PASO 14: Oportunidad perdida (dias + semanas) ──
    // El cálculo en pesos se hace más abajo, después de paso 14b,
    // porque depende de vel_pre_quiebre para SKUs en quiebre prolongado.
    //
    // diasQuiebre: días calendario desde el primer snapshot válido de quiebre
    // (NO el COUNT bruto de registros, que se disparaba a miles cuando el
    // histórico de stock_snapshots acumulaba filas viejas). Guard contra
    // fechas pre-2020 (epoch/datos corruptos) y cap a 365 días.
    const fechasQuiebreValidas = quiebresDelSku
      .filter(q => q.en_quiebre_full && q.fecha)
      .map(q => new Date(q.fecha))
      .filter(d => !Number.isNaN(d.getTime()) && d.getFullYear() >= 2020)
      .sort((a, b) => a.getTime() - b.getTime());
    const primerQuiebre = fechasQuiebreValidas[0] ?? null;
    const diasQuiebre = primerQuiebre
      ? Math.min(365, Math.max(0, Math.floor((hoyMs - primerQuiebre.getTime()) / 86400000)))
      : 0;
    const semanasQuiebre = semanasEnQuiebre.size;

    // ── PASO 14b: Quiebre prolongado ──
    const prev = prevIntelligence.get(skuOrigen);
    let velPreQuiebre = prev?.vel_pre_quiebre || 0;
    let margenUnitarioPreQuiebre = prev?.margen_unitario_pre_quiebre || 0;
    let diasEnQuiebre: number | null = prev?.dias_en_quiebre ?? 0;
    // Flag re-evaluado SIEMPRE contra el catálogo actual — no se arrastra del
    // estado previo. La semántica ahora es "el proveedor está agotado HOY",
    // no "estaba agotado cuando el SKU entró en quiebre".
    let esQuiebreProveedor = !tieneStockProv
      || (!prod || prod.estado_sku === "sin_stock_proveedor");
    let abcPreQuiebre: string | null = prev?.abc_pre_quiebre || null;
    let esCatchUp = false;
    let gmroiPotencial = 0;

    const enQuiebreAhora = stFull === 0 && velPonderada > 0;

    // Velocidad histórica para quiebre prolongado: vel60d ya excluye
    // semanas en quiebre (línea 737, usa semanasActivas60d), así que
    // representa la demanda real antes del quiebre. Si vel60d se degradó
    // por SKU nuevo o quiebre >60d, se cae a velPonderada como fallback.
    // Sin este max, velPreQuiebre quedaba aplastada cuando el SKU llevaba
    // días sin stock — subestimando SKUs legítimos (Guía Completa:
    // "quiebre crónico de A's requiere reconstruir vel histórica").
    const velHistorica = Math.max(vel60d, velPonderada);

    if (enQuiebreAhora) {
      const prevDias = prev?.dias_en_quiebre;
      if (prev && (prevDias === null || (prevDias ?? 0) > 0)) {
        // Continúa en quiebre — incrementar días (flag ya re-evaluado arriba).
        // Si prev era null (historia incompleta), se preserva null.
        diasEnQuiebre = prevDias === null ? null : (prevDias ?? 0) + 1;
        // velPre: preservar el mayor entre histórico calculado y persistido.
        // Evita perder velocidad buena si vel60d ahora está degradado pero
        // prev capturó un buen valor, y recupera velocidad si prev quedó
        // bajo (caso SKUs con vel_pre=velPonderada heredado).
        velPreQuiebre = Math.max(velHistorica, prev.vel_pre_quiebre);
        margenUnitarioPreQuiebre = prev.margen_unitario_pre_quiebre || 0;
        abcPreQuiebre = prev.abc_pre_quiebre;
      } else {
        // Acaba de entrar en quiebre — inicializar desde primer snapshot válido.
        // Si no hay snapshot confiable, diasEnQuiebre = null (historia incompleta).
        if (primerQuiebre) {
          diasEnQuiebre = diasQuiebre > 0 ? diasQuiebre : 1;
        } else {
          diasEnQuiebre = null;
        }
        velPreQuiebre = velHistorica;
        margenUnitarioPreQuiebre = margenProm;  // snapshot del margen unitario al entrar en quiebre
        abcPreQuiebre = null; // Se asigna después del paso ABC global
      }
    } else if (prev && (prev.dias_en_quiebre ?? 0) > 0 && stFull > 0) {
      // SKU se repuso — verificar catch-up
      if (prev.vel_pre_quiebre > 2 && vel7d > prev.vel_pre_quiebre * 1.5) {
        esCatchUp = true;
      }
      if (vel30d > 0 && !esCatchUp) {
        // 3+ semanas vendiendo → reset completo de quiebre prolongado
        velPreQuiebre = 0;
        margenUnitarioPreQuiebre = 0;
        diasEnQuiebre = 0;
        abcPreQuiebre = null;
      } else {
        // Primeras semanas post-reposición
        velPreQuiebre = prev.vel_pre_quiebre;
        margenUnitarioPreQuiebre = prev.margen_unitario_pre_quiebre || 0;
        diasEnQuiebre = 0;
        abcPreQuiebre = prev.abc_pre_quiebre;
      }
    }

    const enQuiebreProlongado = enQuiebreAhora && (diasEnQuiebre ?? 0) >= 14 && velPreQuiebre > 2;

    // ── PASO 14c: Oportunidad perdida en pesos (depende de 14b) ──
    // Días efectivos: diasQuiebre cuenta registros explícitos en stock_snapshots
    // pero SKUs agotados hace mucho (antes de que existiera el tracking) pueden
    // tener diasQuiebre=0 con diasEnQuiebre=78. Usar el max para no subestimar.
    const diasEfectivos = Math.max(diasQuiebre, diasEnQuiebre ?? 0);
    // Cuando el SKU lleva tiempo en quiebre, velFull está artificialmente
    // baja (no hay órdenes recientes) y margenFull30d puede ser 0. Caer a:
    //  1) vel_pre_quiebre × pctFull si estamos en quiebre prolongado
    //  2) margen_60d, luego precio_promedio × 0.25 como fallbacks de margen
    const velParaPerdida = enQuiebreProlongado && velPreQuiebre > 0
      ? velPreQuiebre * pctFull
      : velFull;
    const ventaPerdidaUds = diasEfectivos * (velParaPerdida / 7);
    // Cascada de fallbacks de margen. usaFallbackEstimacion=true significa
    // que ni 30d ni 60d tenían margen real → se usó precio × 0.25 (asumido).
    const usaFallbackEstimacion = margenFull30d <= 0 && margenFull60d <= 0 && precioPromedio > 0;
    const margenParaPerdida = margenFull30d > 0
      ? margenFull30d
      : margenFull60d > 0
        ? margenFull60d
        : precioPromedio > 0
          ? precioPromedio * 0.25
          : 0;
    const ventaPerdidaPesos = ventaPerdidaUds * margenParaPerdida;
    // El flag solo importa cuando el output > 0 (si es 0, no hay decisión que tomar)
    const oportunidadPerdidaEsEstimacion = ventaPerdidaPesos > 0 && usaFallbackEstimacion;
    const ingresoPerdido = ventaPerdidaUds * precioPromedio;

    // GMROI potencial: cuánto DEBERÍA rendir si tuviera stock
    if (enQuiebreProlongado && velPreQuiebre > 0 && costoBruto > 0) {
      const margenPromPot = margenFull30d * pctFull + margenFlex30d * pctFlex;
      const margenAnualPot = margenPromPot * velPreQuiebre * 52;
      const costoInvPot = costoBruto * velPreQuiebre * (targetDiasFull / 7);
      gmroiPotencial = costoInvPot > 0 ? round2(margenAnualPot / costoInvPot) : 0;
    }

    // ── PASO 15: Acción y prioridad ──
    const ultimoMov = ultimoMovPorSku.get(skuOrigen) || null;
    const diasSinMov = ultimoMov ? Math.floor((hoyMs - new Date(ultimoMov).getTime()) / 86400000) : 999;

    // Usar velEfectiva para pedir (vel_pre_quiebre si en quiebre prolongado)
    const velParaPedir = enQuiebreProlongado ? velPreQuiebre : (multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada);
    const velTarget = multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada;
    const targetFullUds = velParaPedir * pctFull * targetDiasFull / 7;
    const targetFlexUds = velParaPedir * pctFlex * 30 / 7;
    const disponibleParaFull = Math.max(0, stBodega - Math.ceil(targetFlexUds));
    let mandarFull = Math.max(0, Math.min(Math.ceil(targetFullUds - stFull - stEnTransito), disponibleParaFull));
    const pedirFull = Math.max(0, Math.ceil(targetFullUds - stFull - stEnTransito));
    const pedirFlex = Math.max(0, Math.ceil(targetFlexUds - stBodega));
    const pedirTotal = pedirFull + pedirFlex;
    const pedirProvBultos = innerPack > 1 && pedirTotal > 0 ? Math.ceil(pedirTotal / innerPack) : pedirTotal;

    // Productos nuevos: si no tiene ventas, tiene stock en bodega y no tiene stock en Full,
    // sugerir enviar un lote inicial (inner pack o mínimo 2 unidades)
    const esNuevo = velPonderada === 0 && velPreQuiebre === 0 && stTotal > 0;
    if (esNuevo && stFull === 0 && stBodega > 0) {
      const loteInicial = Math.max(innerPack, 2);
      mandarFull = Math.min(loteInicial, stBodega);
    }

    let accion: AccionIntel;
    let prioridad: number;
    if (velPonderada === 0 && velPreQuiebre === 0 && stTotal === 0) { accion = "INACTIVO"; prioridad = 99; }
    else if (esNuevo && stFull === 0 && stBodega > 0) { accion = "MANDAR_FULL"; prioridad = 10; }
    else if (esNuevo && diasSinMov <= 30) { accion = "NUEVO"; prioridad = 50; }
    else if (velPonderada === 0 && velPreQuiebre === 0 && stTotal > 0) { accion = "DEAD_STOCK"; prioridad = 80; }
    else if (stFull === 0 && (velFull > 0 || enQuiebreProlongado) && stBodega > 0) { accion = "MANDAR_FULL"; prioridad = 10; }
    else if (stFull === 0 && (velFull > 0 || enQuiebreProlongado) && stBodega === 0 && (esQuiebreProveedor || !tieneStockProv)) { accion = "AGOTADO_SIN_PROVEEDOR"; prioridad = 3; }
    else if (stFull === 0 && (velFull > 0 || enQuiebreProlongado) && stBodega === 0) { accion = "AGOTADO_PEDIR"; prioridad = 5; }
    else if (cobFull < puntoReorden && cobFull < 999) { accion = "URGENTE"; prioridad = 15; }
    else if (cobFull < 30) { accion = "PLANIFICAR"; prioridad = 40; }
    else if (cobFull <= config.cobMaxima) { accion = "OK"; prioridad = 60; }
    else { accion = "EXCESO"; prioridad = 70; }

    // Ajuste: si hay stock en tránsito que cubre >7 días, moderar urgencia
    if ((accion === "URGENTE" || accion === "AGOTADO_PEDIR") && stEnTransito > 0) {
      const cobTransito = velFullCalc > 0 ? (stEnTransito / velFullCalc) * 7 : 0;
      if (cobTransito >= 7) {
        accion = "EN_TRANSITO";
        prioridad = 25;
      }
    }

    // ── PASO 16: Ajuste de precio ──
    let requiereAjustePrecio = false;
    if (velPonderada >= 5 && (margenFull30d < 0 || margenFlex30d < 0)) requiereAjustePrecio = true;
    if (velPonderada >= 10 && precioPromedio > 0 && margenProm < precioPromedio * 0.05) requiereAjustePrecio = true;

    // ── PASO 18: Operación (conteos y movimientos) ──
    const conteoInfo = conteoPorSku.get(skuOrigen);
    const ultimoConteo = conteoInfo?.ultimoConteo || null;
    const diasSinConteo = ultimoConteo ? Math.floor((hoyMs - new Date(ultimoConteo).getTime()) / 86400000) : 999;
    const diferenciasConteo = conteoInfo?.diferencias || 0;

    // Ingreso estimado 30d (para ABC)
    const ingreso30d = velPonderada * precioPromedio * 4.3;

    // Vel objetivo
    const velObj = velObjetivos.get(skuOrigen) || 0;
    const gapVelPct = velObj > 0
      ? round2(((velPonderada - velObj) / velObj) * 100)
      : null;

    rows.push({
      sku_origen: skuOrigen,
      nombre, categoria, proveedor,
      skus_venta: skusVenta,

      vel_7d: round2(vel7d),
      vel_30d: round2(vel30d),
      vel_60d: round2(vel60d),
      vel_ponderada: round2(velPonderada),
      vel_full: round2(velFull),
      vel_flex: round2(velFlex),
      vel_total: round2(velPonderada), // vel_total = vel_ponderada

      pct_full: round2(pctFull),
      pct_flex: round2(pctFlex),

      tendencia_vel: tendVel.dir,
      tendencia_vel_pct: round2(tendVel.pct),
      es_pico: esPico,
      pico_magnitud: round2(picoMagnitud),

      multiplicador_evento: multiplicadorEvento,
      evento_activo: eventoActivo,
      vel_ajustada_evento: round2(velAjustadaEvento),

      stock_full: stFull,
      stock_bodega: stBodega,
      stock_total: stTotal,
      stock_sin_etiquetar: 0, // TODO: cuando se implemente etiquetado
      stock_proveedor: stockProveedor,
      tiene_stock_prov: tieneStockProv,
      inner_pack: innerPack,
      stock_en_transito: stEnTransito,
      stock_proyectado: stProyectado,
      oc_pendientes: ocPend,

      cob_full: round2(cobFull),
      cob_flex: round2(cobFlex),
      cob_total: round2(cobTotal),
      target_dias_full: targetDiasFull,

      margen_full_7d: margenFull7d,
      margen_full_30d: margenFull30d,
      margen_full_60d: margenFull60d,
      margen_flex_7d: margenFlex7d,
      margen_flex_30d: margenFlex30d,
      margen_flex_60d: margenFlex60d,
      margen_tendencia_full: tendMargenFull.dir,
      margen_tendencia_flex: tendMargenFlex.dir,
      canal_mas_rentable: canalMasRentable,
      precio_promedio: precioPromedio,

      // ABC se asigna después (paso 11 global). Defaults a "C".
      abc: "C",
      abc_margen: "C",
      abc_ingreso: "C",
      abc_unidades: "C",
      ingreso_30d: round2(ingreso30d),
      pct_ingreso_acumulado: 0,
      margen_neto_30d: 0,        // se asigna en paso 11 desde input.margenPorSku
      pct_margen_acumulado: 0,
      uds_30d: 0,                // se asigna en paso 11 desde input.unidadesPorSku
      pct_unidades_acumulado: 0,
      cv: round2(cv),
      xyz,
      desviacion_std: round2(stdSemanal),
      cuadrante: "REVISAR",

      gmroi: round2(gmroi),
      dio: round2(dio),
      costo_neto: costoNeto,
      costo_bruto: costoBruto,
      costo_fuente: costoFuente,
      costo_inventario_total: costoInventarioTotal,

      stock_seguridad: round2(stockSeguridad),
      punto_reorden: round2(puntoReorden),
      nivel_servicio: nivelServicio,
      // Fase B: defaults, se completan en paso de SS por ABC global
      lead_time_real_dias: null,
      lead_time_real_sigma: null,
      lead_time_usado_dias: leadTimeDias,
      lead_time_fuente: "fallback_default",
      lt_muestras: 0,
      safety_stock_simple: round2(stockSeguridad),
      safety_stock_completo: 0,
      safety_stock_fuente: "fallback_simple",
      rop_calculado: 0,
      necesita_pedir: false,

      dias_sin_stock_full: diasQuiebre,
      semanas_con_quiebre: semanasQuiebre,
      venta_perdida_uds: round2(ventaPerdidaUds),
      venta_perdida_pesos: round2(ventaPerdidaPesos),
      oportunidad_perdida_es_estimacion: oportunidadPerdidaEsEstimacion,
      ingreso_perdido: round2(ingresoPerdido),

      accion,
      prioridad,
      mandar_full: mandarFull,
      pedir_proveedor: pedirTotal,
      pedir_proveedor_bultos: pedirProvBultos,
      pedir_proveedor_sin_rampup: pedirTotal,
      factor_rampup_aplicado: 1.0,
      rampup_motivo: "no_aplica",
      requiere_ajuste_precio: requiereAjustePrecio,

      // Liquidación se asigna después (paso 17 global, requiere ABC)
      liquidacion_accion: null,
      liquidacion_dias_extra: 0,
      liquidacion_descuento_sugerido: 0,

      ultimo_conteo: ultimoConteo,
      dias_sin_conteo: diasSinConteo,
      diferencias_conteo: diferenciasConteo,
      ultimo_movimiento: ultimoMov,
      dias_sin_movimiento: diasSinMov,

      // Alertas se asignan al final (paso 19)
      alertas: [],
      alertas_count: 0,

      // Quiebre prolongado
      vel_pre_quiebre: round2(velPreQuiebre),
      margen_unitario_pre_quiebre: round2(margenUnitarioPreQuiebre),
      dias_en_quiebre: diasEnQuiebre,
      es_quiebre_proveedor: esQuiebreProveedor,
      abc_pre_quiebre: abcPreQuiebre,
      gmroi_potencial: gmroiPotencial,
      es_catch_up: esCatchUp,

      vel_objetivo: velObj,
      gap_vel_pct: gapVelPct,

      // Forecast accuracy — se pueblan en paso 19 si el input trae metricasAccuracy
      forecast_wmape_8s: null,
      forecast_bias_8s: null,
      forecast_tracking_signal_8s: null,
      forecast_semanas_evaluadas_8s: null,
      forecast_es_confiable_8s: null,
      forecast_calculado_at: null,

      // PR3 Fase A — TSB shadow (computado en Paso 10b, no consumido)
      vel_ponderada_tsb: velPonderadaTsb,
      tsb_alpha: tsbAlpha,
      tsb_beta: tsbBeta,
      tsb_modelo_usado: tsbModeloUsado,
      primera_venta: primeraVentaIso,
      dias_desde_primera_venta: diasDesdePrimeraVenta,

      updated_at: hoy.toISOString(),
      datos_desde: fechaMin ? fechaMin.slice(0, 10) : null,
      datos_hasta: fechaMax ? fechaMax.slice(0, 10) : null,
    });
  }

  // ════════════════════════════════════════
  // PASOS GLOBALES (9, 11, 12-ajuste, 17, 19)
  // ════════════════════════════════════════

  // ── PASO 9: Clasificación ABC sobre 3 ejes (margen / ingreso / unidades) ──
  //
  // El motor calcula tres clasificaciones Pareto independientes:
  //
  //   - abc_margen   → Pareto sobre margen bruto últimos 30d (ventas_ml_cache.margen)
  //                    Es el PRINCIPAL. abc = abc_margen (compatibilidad).
  //   - abc_ingreso  → Pareto sobre ingreso bruto últimos 30d (vel × precio)
  //   - abc_unidades → Pareto sobre unidades vendidas 30d
  //
  // Para SKUs en quiebre prolongado se imputa cada métrica con el snapshot
  // pre-quiebre × velPreQuiebre × 4.3 semanas para que no caigan injustamente.

  const margenPorSku = input.margenPorSku || new Map<string, number>();
  const unidadesPorSku = input.unidadesPorSku || new Map<string, number>();

  for (const r of rows) {
    // Imputar ingreso para SKUs en quiebre prolongado (lógica histórica)
    if ((r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2) {
      r.ingreso_30d = round2(r.vel_pre_quiebre * r.precio_promedio * 4.3);
    }
    // Margen real desde ventas_ml_cache (input externo)
    const margenReal = margenPorSku.get(r.sku_origen) || 0;
    if (margenReal > 0) {
      r.margen_neto_30d = round2(margenReal);
    } else if ((r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2 && r.margen_unitario_pre_quiebre > 0) {
      // Imputación pre-quiebre: vel × margen_unitario × 4.3 sem
      r.margen_neto_30d = round2(r.vel_pre_quiebre * r.margen_unitario_pre_quiebre * 4.3);
    } else {
      r.margen_neto_30d = round2(margenReal); // 0 o negativo
    }
    // Unidades reales desde ventas_ml_cache, con fallback imputado
    const udsReal = unidadesPorSku.get(r.sku_origen) || 0;
    if (udsReal > 0) {
      r.uds_30d = udsReal;
    } else if ((r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2) {
      r.uds_30d = Math.round(r.vel_pre_quiebre * 4.3);
    } else {
      r.uds_30d = udsReal;
    }
  }

  // Helper Pareto: ordena desc, asigna A (≤80%), B (≤95%), C (resto). Retorna pct acum por SKU.
  function paretoABC<T extends { sku_origen: string }>(
    items: T[], getVal: (r: T) => number,
  ): Map<string, { clase: ClaseABC; pctAcum: number }> {
    const result = new Map<string, { clase: ClaseABC; pctAcum: number }>();
    const positivos = items.filter(r => getVal(r) > 0).sort((a, b) => getVal(b) - getVal(a));
    const total = positivos.reduce((s, r) => s + getVal(r), 0);
    if (total <= 0) return result;
    let acum = 0;
    for (const r of positivos) {
      acum += getVal(r);
      const pct = round2((acum / total) * 100);
      let clase: ClaseABC;
      if (pct <= 80) clase = "A";
      else if (pct <= 95) clase = "B";
      else clase = "C";
      result.set(r.sku_origen, { clase, pctAcum: pct });
    }
    return result;
  }

  const paretoMargen = paretoABC(rows, r => r.margen_neto_30d);
  const paretoIngreso = paretoABC(rows, r => r.ingreso_30d);
  const paretoUnidades = paretoABC(rows, r => r.uds_30d);

  for (const r of rows) {
    const m = paretoMargen.get(r.sku_origen);
    r.abc_margen = m?.clase || "C";
    r.pct_margen_acumulado = m?.pctAcum || 0;

    const i = paretoIngreso.get(r.sku_origen);
    r.abc_ingreso = i?.clase || "C";
    r.pct_ingreso_acumulado = i?.pctAcum || 0;

    const u = paretoUnidades.get(r.sku_origen);
    r.abc_unidades = u?.clase || "C";
    r.pct_unidades_acumulado = u?.pctAcum || 0;

    // Compatibilidad: abc = abc_margen (el principal, dispara decisiones)
    r.abc = r.abc_margen;
  }

  // Asignar abc_pre_quiebre para SKUs que acaban de entrar en quiebre
  for (const r of rows) {
    if ((r.dias_en_quiebre ?? 0) > 0 && !r.abc_pre_quiebre) {
      r.abc_pre_quiebre = r.abc;
    }
  }

  // ── PASO 8b: Asignar target de cobertura por ABC ──
  for (const r of rows) {
    if (r.abc === "A") r.target_dias_full = config.targetDiasA;
    else if (r.abc === "B") r.target_dias_full = config.targetDiasB;
    else r.target_dias_full = config.targetDiasC;
  }

  // ── PASO 11: Cuadrante (matriz fija abc_margen × abc_unidades) ──
  // Movido aquí (antes del recálculo de pedir_proveedor) para que
  // esQuiebreProlongadoProtegido() pueda leer r.cuadrante — la
  // protección ESTRELLA/CASHCOW depende de esta clasificación.
  for (const r of rows) {
    const esMargenA = r.abc_margen === "A";
    const esUnidadesA = r.abc_unidades === "A";
    if (esMargenA && esUnidadesA) r.cuadrante = "ESTRELLA";
    else if (esMargenA && !esUnidadesA) r.cuadrante = "CASHCOW";
    else if (!esMargenA && esUnidadesA) r.cuadrante = "VOLUMEN";
    else r.cuadrante = "REVISAR";
  }

  // ── Recalcular mandar_full y pedir_proveedor con targets actualizados ──
  // Fase B: refactor del cálculo. Antes se duplicaba Full/Flex con 30d hardcoded.
  // Ahora una sola cantidad por SKU (en unidades físicas, ya respetan composición).
  // La distribución Full vs Flex se decide en envío (mandar_full), no en el pedido.
  //
  // Fórmula:
  //   demanda_ciclo = D̄ × target_dias / 7  (en unidades semanales)
  //   cantidad_objetivo = demanda_ciclo + safety_stock_completo
  //   pedir_proveedor = max(0, ceil(cantidad_objetivo − stock_total))
  // donde stock_total = stock_full + stock_bodega + stock_en_transito.
  for (const r of rows) {
    const prod = prodMap.get(r.sku_origen);
    const provCatR = proveedorCatalogo?.get(r.sku_origen);
    const innerPack = provCatR?.inner_pack || prod?.inner_pack || 1;
    const velCalcR = r.multiplicador_evento > 1 ? r.vel_ajustada_evento : r.vel_ponderada;
    const enQP = esQuiebreProlongadoProtegido(r);
    const velParaPedir = enQP ? r.vel_pre_quiebre : velCalcR;

    // mandar_full: solo el split a Full según target_dias_full y pct_full.
    // (Mantengo lógica vieja porque mandar_full es decisión operativa diaria,
    // no parte del pedido al proveedor.)
    const targetFullUds = velParaPedir * r.pct_full * r.target_dias_full / 7;
    const targetFlexUds = velParaPedir * r.pct_flex * r.target_dias_full / 7;  // unificado: usa target por ABC, no 30d hardcoded
    const disponibleParaFullR = Math.max(0, r.stock_bodega - Math.ceil(targetFlexUds));
    r.mandar_full = Math.max(0, Math.min(Math.ceil(targetFullUds - r.stock_full - r.stock_en_transito), disponibleParaFullR));
    if (r.vel_ponderada === 0 && r.vel_pre_quiebre === 0 && r.stock_full === 0 && r.stock_en_transito === 0 && r.stock_bodega > 0) {
      const loteInicial = Math.max(innerPack, 2);
      r.mandar_full = Math.min(loteInicial, r.stock_bodega);
    }

    // pedir_proveedor: cantidad agregada al proveedor.
    // demanda_ciclo cubre target_dias × velocidad. SS_completo amortigua variabilidad demanda+LT.
    const demandaCicloUds = velParaPedir * r.target_dias_full / 7;
    const cantidadObjetivo = demandaCicloUds + r.safety_stock_completo;
    const stockTotalR = r.stock_full + r.stock_bodega + r.stock_en_transito;  // fix bug Flex: en_transito también del lado bodega
    r.pedir_proveedor = Math.max(0, Math.ceil(cantidadObjetivo - stockTotalR));
    r.pedir_proveedor_bultos = innerPack > 1 && r.pedir_proveedor > 0 ? Math.ceil(r.pedir_proveedor / innerPack) : r.pedir_proveedor;

    // Recalcular cobertura Full (visualización)
    const velFullCalcR = velCalcR * r.pct_full;
    r.cob_full = round2(calcularCobertura(r.stock_full, velFullCalcR));
  }

  // ── PASO 10b: Deduplicar pedido entre alternativas ──
  // Si un SKU tiene alternativas con stock suficiente, no pedir para este SKU
  const rowMap = new Map<string, SkuIntelRow>();
  for (const r of rows) rowMap.set(r.sku_origen, r);
  for (const r of rows) {
    if (r.pedir_proveedor <= 0) continue;
    const altsR = alternativosPorOrigen.get(r.sku_origen);
    if (!altsR || altsR.length === 0) continue;
    // Check if any alternative has enough bodega stock to cover this SKU's flex needs
    // AND the group's total stock covers the combined demand
    let stockBodegaGrupo = r.stock_bodega; // already includes alts from step 5
    let stockFullGrupo = r.stock_full;
    let stockTransitoGrupo = r.stock_en_transito; // already includes alts
    // The demand is shared — it's the same publication/listing
    // So we only need to cover it once, not per SKU origen
    const velCalcR = r.multiplicador_evento > 1 ? r.vel_ajustada_evento : r.vel_ponderada;
    const enQP = esQuiebreProlongadoProtegido(r);
    const velR = enQP ? r.vel_pre_quiebre : velCalcR;
    const tFull = velR * r.pct_full * r.target_dias_full / 7;
    const tFlex = velR * r.pct_flex * 30 / 7;
    const totalNecesario = tFull + tFlex;
    const totalDisponible = stockFullGrupo + stockBodegaGrupo + stockTransitoGrupo;
    if (totalDisponible >= totalNecesario) {
      // Group has enough — don't need to order
      r.pedir_proveedor = 0;
      r.pedir_proveedor_bultos = 0;
    } else {
      // Recalculate with group stock
      const pedirFullR = Math.max(0, Math.ceil(tFull - stockFullGrupo - stockTransitoGrupo));
      const pedirFlexR = Math.max(0, Math.ceil(tFlex - stockBodegaGrupo));
      r.pedir_proveedor = pedirFullR + pedirFlexR;
      const prod2 = prodMap.get(r.sku_origen);
      const provCat2 = proveedorCatalogo?.get(r.sku_origen);
      const ip2 = provCat2?.inner_pack || prod2?.inner_pack || 1;
      r.pedir_proveedor_bultos = ip2 > 1 && r.pedir_proveedor > 0 ? Math.ceil(r.pedir_proveedor / ip2) : r.pedir_proveedor;
    }
  }

  // ── Aplicar factor ramp-up post-quiebre sobre pedir_proveedor ──
  // Matriz en src/lib/rampup.ts. Distingue quiebre propio vs proveedor y
  // modula por duración (Manual Inv. Parte 3 Error #5, Parte 2 §7.4).
  for (const r of rows) {
    const rampup = calcularFactorRampup(r.dias_en_quiebre, r.es_quiebre_proveedor);
    const pedirSinRampup = r.pedir_proveedor;
    r.pedir_proveedor_sin_rampup = pedirSinRampup;
    r.factor_rampup_aplicado = rampup.factor;
    r.rampup_motivo = rampup.motivo;
    if (rampup.factor !== 1.0 && pedirSinRampup > 0) {
      r.pedir_proveedor = Math.round(pedirSinRampup * rampup.factor);
      const prodR = prodMap.get(r.sku_origen);
      const provCatR = proveedorCatalogo?.get(r.sku_origen);
      const ipR = provCatR?.inner_pack || prodR?.inner_pack || 1;
      r.pedir_proveedor_bultos = ipR > 1 && r.pedir_proveedor > 0
        ? Math.ceil(r.pedir_proveedor / ipR)
        : r.pedir_proveedor;
    }
  }

  // ── Ajustar safety stock + ROP por ABC (Fase B: doble cálculo) ──
  // Resolver LT por SKU usando cascada: oc_real → manual_proveedor → manual_producto_legacy → fallback
  function resolverLeadTime(prodInput: ProductoInput | undefined): {
    dias: number;
    sigma_dias: number;
    fuente: "oc_real" | "manual_proveedor" | "manual_producto_legacy" | "fallback_default";
    muestras: number;
  } {
    const provNombre = (prodInput?.proveedor || "").trim();
    const provData = provNombre ? proveedoresLT.get(provNombre) : undefined;

    if (provData && provData.lead_time_fuente === "oc_real" && provData.lead_time_muestras >= 3) {
      return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias, fuente: "oc_real", muestras: provData.lead_time_muestras };
    }
    if (provData) {
      return { dias: provData.lead_time_dias, sigma_dias: provData.lead_time_sigma_dias, fuente: "manual_proveedor", muestras: provData.lead_time_muestras };
    }
    // Fallback a productos.lead_time_dias si difiere del default 7 (señal de que fue editado manual)
    if (prodInput?.lead_time_dias && prodInput.lead_time_dias !== 7) {
      return { dias: prodInput.lead_time_dias, sigma_dias: 0.30 * prodInput.lead_time_dias, fuente: "manual_producto_legacy", muestras: 0 };
    }
    return { dias: 5, sigma_dias: 1.5, fuente: "fallback_default", muestras: 0 };
  }

  for (const r of rows) {
    // Nivel de servicio por ABC
    let ns = 0.95;
    if (r.abc === "A") ns = 0.97;
    else if (r.abc === "C") ns = 0.90;
    r.nivel_servicio = ns;
    const Z = zScore(ns);

    // Resolver LT (cascada por proveedor)
    const prodR = prodMap.get(r.sku_origen);
    const lt = resolverLeadTime(prodR);
    r.lead_time_real_dias = lt.fuente === "oc_real" ? lt.dias : null;
    r.lead_time_real_sigma = lt.fuente === "oc_real" ? lt.sigma_dias : null;
    r.lead_time_usado_dias = lt.dias;
    r.lead_time_fuente = lt.fuente;
    r.lt_muestras = lt.muestras;

    const ltSem = lt.dias / 7;
    const sigmaLtSem = lt.sigma_dias / 7;
    const D = r.vel_ponderada;            // u/semana, ya en unidades físicas (composición × cantidad)
    const sigmaD = r.desviacion_std;      // u/semana, ya calculada en paso XYZ

    // SS legacy (solo σ_D × √LT, sin σ_LT) — para compatibilidad y comparación
    const ssSimple = round2(Z * sigmaD * Math.sqrt(ltSem));
    r.safety_stock_simple = ssSimple;
    r.stock_seguridad = ssSimple;          // se preserva el campo viejo
    r.punto_reorden = round2((D * ltSem) + ssSimple);

    // SS completo: incluye σ_LT
    // Fórmula: Z × √(LT × σ_D² + D̄² × σ_LT²)
    if (sigmaD > 0 || sigmaLtSem > 0) {
      const ssCompleto = round2(Z * Math.sqrt(ltSem * sigmaD * sigmaD + D * D * sigmaLtSem * sigmaLtSem));
      r.safety_stock_completo = ssCompleto;
      r.safety_stock_fuente = "formula_completa";
    } else {
      // Sin variabilidad medida → cae al simple
      r.safety_stock_completo = ssSimple;
      r.safety_stock_fuente = "fallback_simple";
    }
    r.rop_calculado = round2((D * ltSem) + r.safety_stock_completo);

    // necesita_pedir: stock total disponible ≤ ROP
    const stockTotal = r.stock_full + r.stock_bodega + r.stock_en_transito;
    r.necesita_pedir = stockTotal <= r.rop_calculado && D > 0;
  }

  // ── Ajustar prioridad por ABC ──
  for (const r of rows) {
    if (r.abc === "A") r.prioridad = Math.max(0, r.prioridad - 5);
    else if (r.abc === "C") r.prioridad += 5;
  }

  // ── PASO 17: Protocolo de liquidación ──
  for (const r of rows) {
    if (r.abc !== "C" && r.cuadrante !== "REVISAR") continue;
    if (r.vel_ponderada <= 0) continue;
    const diasExtra = Math.max(0, Math.round(r.dio - r.target_dias_full));
    r.liquidacion_dias_extra = diasExtra;
    if (diasExtra > 90) {
      r.liquidacion_accion = "precio_costo";
      r.liquidacion_descuento_sugerido = 40;
    } else if (diasExtra > 60) {
      r.liquidacion_accion = "liquidar_activa";
      r.liquidacion_descuento_sugerido = 25;
    } else if (diasExtra > 30) {
      r.liquidacion_accion = "descuento_10";
      r.liquidacion_descuento_sugerido = 10;
    }
  }

  // ── PASO 19: Alertas ──
  // Staleness de costo: 90 días sin update de productos.updated_at para SKUs
  // cuya fuente de costo es manual/proveedor (no costo_promedio que se actualiza con recepciones).
  const limiteStale = new Date(hoy);
  limiteStale.setDate(limiteStale.getDate() - 90);
  for (const r of rows) {
    const alertas: AlertaIntel[] = [];

    if (r.vel_ponderada > 0 && (!r.costo_bruto || r.costo_bruto === 0)) {
      alertas.push("sin_costo");
    }
    if (r.costo_fuente === "costo_manual" || r.costo_fuente === "proveedor_catalogo") {
      const prod = prodMap.get(r.sku_origen);
      if (prod?.updated_at && new Date(prod.updated_at) < limiteStale && r.vel_ponderada > 0) {
        alertas.push("costo_posiblemente_obsoleto");
      }
    }
    // Fase B: alertas de reposición
    if (r.necesita_pedir) alertas.push("necesita_pedir");
    const prodMoq = prodMap.get(r.sku_origen)?.moq;
    if (r.pedir_proveedor > 0 && prodMoq && prodMoq > 1 && r.pedir_proveedor < prodMoq) {
      alertas.push("pedido_bajo_moq");
    }

    if (r.stock_full === 0 && r.vel_full > 0) alertas.push("agotado_full");
    if (r.cob_full < r.punto_reorden && r.cob_full < 999) alertas.push("urgente");
    if (r.margen_full_30d < 0 && r.vel_full > 0) alertas.push("margen_negativo_full");
    if (r.margen_flex_30d < 0 && r.vel_flex > 0) alertas.push("margen_negativo_flex");
    if (r.es_pico) alertas.push("pico_demanda");
    if (r.tendencia_vel === "bajando" && Math.abs(r.tendencia_vel_pct) > 30) alertas.push("caida_demanda");
    if (!r.tiene_stock_prov) alertas.push("sin_stock_proveedor");
    // Ventana de acción: el proveedor reporta 0 explícito pero aún hay
    // cola en Full. Es la alerta temprana — tenemos runway vendible pero
    // no podemos reponer cuando se acabe.
    if (r.stock_proveedor === 0 && r.stock_full > 0 && r.vel_ponderada > 0) {
      alertas.push("proveedor_agotado_con_cola_full");
    }
    if (r.cob_total > 60) alertas.push("exceso");
    if (r.vel_ponderada === 0 && r.stock_total > 0) alertas.push("dead_stock");
    if (r.margen_tendencia_full === "bajando") alertas.push("margen_full_bajando");
    if (r.margen_tendencia_flex === "bajando") alertas.push("margen_flex_bajando");
    if (r.requiere_ajuste_precio) alertas.push("requiere_ajuste_precio");
    if (r.dias_sin_conteo > 30) alertas.push("sin_conteo_30d");
    if (r.liquidacion_accion !== null) alertas.push("liquidar");
    if (r.evento_activo !== null) alertas.push("evento_activo");
    if (r.stock_en_transito > 0) alertas.push("en_transito");

    // Stock dañado o perdido en Full (ML)
    if (stockFullDetail) {
      let totalDanado = 0;
      let totalPerdido = 0;
      for (const sv of r.skus_venta) {
        const detail = stockFullDetailN.get(sv);
        if (detail) {
          totalDanado += detail.stock_danado;
          totalPerdido += detail.stock_perdido;
        }
      }
      if (totalDanado > 0 || totalPerdido > 0) alertas.push("stock_danado_full");
    }

    // Quiebre prolongado
    if ((r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A")) {
      alertas.push("estrella_quiebre_prolongado");
    }
    if (r.es_catch_up) alertas.push("catch_up_post_quiebre");

    // Alertas de velocidad vs objetivo
    if (r.vel_objetivo > 0 && r.vel_ponderada < r.vel_objetivo * 0.8) alertas.push("bajo_meta");
    if (r.vel_objetivo > 0 && r.vel_ponderada > r.vel_objetivo * 1.3) alertas.push("sobre_meta");

    // Proveedor volvió a tener stock (antes no tenía, ahora sí)
    const prev2 = prevIntelligence.get(r.sku_origen);
    if (prev2 && prev2.es_quiebre_proveedor && !r.es_quiebre_proveedor && r.vel_pre_quiebre > 2) {
      alertas.push("proveedor_volvio_stock");
    }

    // PR2/3 — Forecast accuracy. Lógica extraída a evaluarAlertasForecast()
    // para poder testearla sin montar todo el motor.
    const fa = input.metricasAccuracy?.get(r.sku_origen);
    if (fa && fa.es_confiable) {
      r.forecast_wmape_8s = fa.wmape;
      r.forecast_bias_8s = fa.bias;
      r.forecast_tracking_signal_8s = fa.tracking_signal;
      r.forecast_semanas_evaluadas_8s = fa.semanas_evaluadas;
      r.forecast_es_confiable_8s = true;
      r.forecast_calculado_at = fa.calculado_at;

      for (const a of evaluarAlertasForecast(r, fa)) alertas.push(a);
    }

    r.alertas = alertas;
    r.alertas_count = alertas.length;
  }

  return { rows, debugLog };
}

/* ═══════════════════════════════════════════════════════════
   FUNCIONES AUXILIARES
   ═══════════════════════════════════════════════════════════ */

function emptyFinancial(): FinancialAgg {
  return { totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0, totalIngresoEnvio: 0, totalCantidad: 0 };
}

function addFinancial(agg: FinancialAgg, o: OrdenInput): void {
  agg.totalSubtotal += o.subtotal || 0;
  agg.totalComision += o.comision_total || 0;
  agg.totalCostoEnvio += o.costo_envio || 0;
  agg.totalIngresoEnvio += o.ingreso_envio || 0;
  agg.totalCantidad += o.cantidad || 0;
}

function calcMargenIntel(agg: FinancialAgg, canal: "flex" | "full", costoBruto: number): number {
  const result = calcularMargen(agg, canal, costoBruto);
  return result ?? 0;
}

function sumar(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mediana(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Cuenta semanas activas (sin quiebre) de las primeras N semanas */
function countActiveSemanas(n: number, quiebres: Set<number>): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!quiebres.has(i)) count++;
  }
  return count;
}

/* ═══════════════════════════════════════════════════════════
   SNAPSHOT HELPERS
   ═══════════════════════════════════════════════════════════ */

/** Genera las filas de history a partir de los resultados del recálculo */
export function generarHistoryRows(
  rows: SkuIntelRow[],
  fecha: string,
): Record<string, unknown>[] {
  return rows
    .filter(r => r.vel_ponderada > 0 || r.stock_total > 0)
    .map(r => ({
      fecha,
      sku_origen: r.sku_origen,
      vel_ponderada: r.vel_ponderada,
      vel_full: r.vel_full,
      vel_flex: r.vel_flex,
      stock_full: r.stock_full,
      stock_bodega: r.stock_bodega,
      stock_total: r.stock_total,
      cob_full: r.cob_full,
      cob_total: r.cob_total,
      margen_full: r.margen_full_30d,
      margen_flex: r.margen_flex_30d,
      abc: r.abc,
      abc_margen: r.abc_margen,
      abc_ingreso: r.abc_ingreso,
      abc_unidades: r.abc_unidades,
      xyz: r.xyz,
      cuadrante: r.cuadrante,
      gmroi: r.gmroi,
      dio: r.dio,
      accion: r.accion,
      alertas: r.alertas,
      margen_neto_30d: r.margen_neto_30d,
      margen_unitario_pre_quiebre: r.margen_unitario_pre_quiebre,
      lead_time_usado_dias: r.lead_time_usado_dias,
      safety_stock_completo: r.safety_stock_completo,
      rop_calculado: r.rop_calculado,
      venta_perdida_pesos: r.venta_perdida_pesos,
      vel_objetivo: r.vel_objetivo,
      gap_vel_pct: r.gap_vel_pct,
    }));
}

/** Genera snapshots de stock para registro de quiebres */
export function generarStockSnapshots(
  rows: SkuIntelRow[],
  fecha: string,
): Record<string, unknown>[] {
  return rows
    .filter(r => r.vel_ponderada > 0 || r.stock_total > 0)
    .map(r => ({
      fecha,
      sku_origen: r.sku_origen,
      stock_full: r.stock_full,
      stock_bodega: r.stock_bodega,
      stock_total: r.stock_total,
      en_quiebre_full: r.stock_full === 0 && r.vel_full > 0,
      en_quiebre_bodega: r.stock_bodega === 0 && r.vel_flex > 0,
    }));
}
