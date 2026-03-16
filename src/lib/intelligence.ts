/**
 * Motor de Inteligencia de Inventario — Lógica pura de cálculo.
 * Sin dependencias de React, DOM, Next.js, ni Supabase.
 * Todas las funciones son puras: reciben datos, retornan resultados.
 *
 * Los 19+ pasos del algoritmo de recálculo.
 */

import { calcularCobertura, calcularTargetDias, calcularMargen, COSTO_ENVIO_FLEX } from "./reposicion";
import type { FinancialAgg } from "./reposicion";

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
  | "EXCESO";

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
  | "exceso"
  | "dead_stock"
  | "margen_full_bajando"
  | "margen_flex_bajando"
  | "requiere_ajuste_precio"
  | "sin_conteo_30d"
  | "liquidar"
  | "evento_activo"
  | "cambio_canal_rentable"
  | "en_transito"
  | "estrella_quiebre_prolongado"
  | "proveedor_volvio_stock"
  | "catch_up_post_quiebre"
  | "stock_danado_full";

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
  stock_proveedor: number;
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
  abc: ClaseABC;
  ingreso_30d: number;
  pct_ingreso_acumulado: number;
  cv: number;
  xyz: ClaseXYZ;
  desviacion_std: number;
  cuadrante: Cuadrante;

  gmroi: number;
  dio: number;
  costo_neto: number;
  costo_bruto: number;
  costo_inventario_total: number;

  stock_seguridad: number;
  punto_reorden: number;
  nivel_servicio: number;

  dias_sin_stock_full: number;
  semanas_con_quiebre: number;
  venta_perdida_uds: number;
  venta_perdida_pesos: number;
  ingreso_perdido: number;

  accion: AccionIntel;
  prioridad: number;
  mandar_full: number;
  pedir_proveedor: number;
  pedir_proveedor_bultos: number;
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
  dias_en_quiebre: number;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  gmroi_potencial: number;
  es_catch_up: boolean;

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
  precio: number;
  inner_pack: number | null;
  lead_time_dias: number;
  moq: number;
  estado_sku: string;
}

export interface ComposicionInput {
  sku_venta: string;
  sku_origen: string;
  unidades: number;
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
}

export const DEFAULT_INTEL_CONFIG: RecalculoConfig = {
  cobObjetivo: 40,
  cobMaxima: 60,
};

/** Datos previos de sku_intelligence para continuidad de quiebre prolongado */
export interface PrevIntelRow {
  sku_origen: string;
  vel_pre_quiebre: number;
  dias_en_quiebre: number;
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

export interface RecalculoInput {
  productos: ProductoInput[];
  composicion: ComposicionInput[];
  ordenes: OrdenInput[];
  stockBodega: Map<string, number>;
  stockFull: Map<string, number>;
  stockFullDetail: Map<string, StockFullDetailRow>;
  velProfitguard: Map<string, number>;
  eventosActivos: EventoInput[];
  quiebres: QuiebreSnapshot[];
  conteos: ConteoInput[];
  movimientos: MovimientoInput[];
  stockEnTransito: Map<string, number>;
  ocPendientesPorSku: Map<string, number>;
  prevIntelligence: Map<string, PrevIntelRow>;
  config: RecalculoConfig;
  hoy: Date;
}

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

/* ═══════════════════════════════════════════════════════════
   PASO PRINCIPAL: RECÁLCULO COMPLETO
   ═══════════════════════════════════════════════════════════ */

export function recalcularTodo(input: RecalculoInput): SkuIntelRow[] {
  const {
    productos, composicion, ordenes, stockBodega, stockFull, stockFullDetail,
    velProfitguard, eventosActivos, quiebres, conteos, movimientos,
    stockEnTransito, ocPendientesPorSku, prevIntelligence, config, hoy,
  } = input;

  const hoyStr = hoy.toISOString().slice(0, 10);
  const hoyMs = hoy.getTime();

  // ── Mapas de lookup ──
  const prodMap = new Map<string, ProductoInput>();
  for (const p of productos) prodMap.set(p.sku, p);

  // SKU Origen → SKU Ventas asociados — SOLO desde composicion_venta
  const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();

  // Construir ventasPorOrigen SOLO desde composicion_venta, normalizado y deduplicado
  for (const c of composicion) {
    const svUp = c.sku_venta.toUpperCase();
    const soUp = c.sku_origen.toUpperCase();
    if (!ventasPorOrigen.has(soUp)) ventasPorOrigen.set(soUp, []);
    const existing = ventasPorOrigen.get(soUp)!;
    // Deduplicar por UPPER
    if (!existing.some(e => e.skuVenta === svUp)) {
      existing.push({ skuVenta: svUp, unidades: c.unidades });
    }
  }

  // Todos los SKU Origen activos
  const allSkusOrigen = new Set<string>();
  for (const p of productos) {
    if (p.estado_sku !== "descontinuado") allSkusOrigen.add(p.sku);
  }
  ventasPorOrigen.forEach((_, sku) => allSkusOrigen.add(sku));
  stockBodega.forEach((qty, sku) => {
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

  ordenesPorSkuVenta.forEach((ords, svUp) => {
    // Solo reasignar si svUp es un sku_origen con formatos pero NO es un sku_venta registrado
    if (allSkusVentaComp.has(svUp)) return; // ya es un sku_venta válido
    const formatos = ventasPorOrigen.get(svUp);
    if (!formatos || formatos.length === 0) return; // no es un sku_origen conocido
    // Buscar el formato individual (unidades=1)
    const individual = formatos.find(f => f.unidades === 1);
    if (!individual) return; // no hay formato individual
    // Mover órdenes al formato individual
    const target = individual.skuVenta;
    if (!ordenesPorSkuVenta.has(target)) ordenesPorSkuVenta.set(target, []);
    ordenesPorSkuVenta.get(target)!.push(...ords);
    ordenesPorSkuVenta.delete(svUp);
  });

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

    // ── PASO 1: Identidad ──
    const nombre = prod?.nombre || null;
    const categoria = prod?.categoria || null;
    const proveedor = prod?.proveedor || null;
    const costoNeto = prod?.costo || 0;
    const costoBruto = costoNeto > 0 ? Math.round(costoNeto * 1.19) : 0;
    const leadTimeDias = prod?.lead_time_dias || 7;
    const innerPack = prod?.inner_pack || 1;

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

    for (const va of ventasAsoc) {
      const ords = ordenesPorSkuVenta.get(va.skuVenta) || [];
      for (const o of ords) {
        const fechaMs = new Date(o.fecha).getTime();
        const udsFisicas = o.cantidad * va.unidades;
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

    // Detección de quiebres para excluir del promedio
    const quiebresDelSku = quiebresPorSku.get(skuOrigen) || [];
    const semanasEnQuiebre = new Set<number>();
    for (const q of quiebresDelSku) {
      if (q.en_quiebre_full) {
        const fechaMs = new Date(q.fecha).getTime();
        const semIdx = Math.floor((hoyMs - fechaMs) / (7 * 86400000));
        if (semIdx >= 0 && semIdx < 9) semanasEnQuiebre.add(semIdx);
      }
    }

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
    let velPonderada = (vel7d * 0.5) + (vel30d * 0.3) + (vel60d * 0.2);

    // Referencia ProfitGuard: max (no suma) de vel_promedio de los SKU Venta asociados.
    // PG reporta velocidad total del listing, no por formato — sumar duplica la velocidad.
    let velPG = 0;
    for (const va of ventasAsoc) {
      const vpg = velProfitguard.get(va.skuVenta) || 0;
      velPG = Math.max(velPG, vpg * va.unidades);
    }
    if (velPG > velPonderada) velPonderada = velPG;

    // Distribución por canal
    const totalCanal30d = fullQty30d + flexQty30d;
    const pctFull = totalCanal30d > 0 ? fullQty30d / totalCanal30d : 1.0;
    const pctFlex = 1 - pctFull;

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
    const stBodega = stockBodega.get(skuOrigen) || 0;
    // Stock Full: sumar de todos los SKU Venta asociados (convertir a físico)
    let stFull = 0;
    for (const va of ventasAsoc) {
      const sfVenta = stockFull.get(va.skuVenta) || 0;
      stFull += sfVenta * va.unidades;
    }
    const stTotal = stFull + stBodega;
    const stEnTransito = stockEnTransito.get(skuOrigen) || 0;
    const stProyectado = stTotal + stEnTransito;
    const ocPend = ocPendientesPorSku.get(skuOrigen) || 0;

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

    // ── PASO 8: Target dinámico ──
    const targetDiasFull = calcularTargetDias(
      margenFlex30d || null,
      margenFull30d || null,
      config.cobObjetivo,
    );

    // ── PASO 10 (parcial): XYZ — CV con datos semanales ──
    // Usar solo semanas sin quiebre
    const ventasSemanaActivas = ventasSemana.filter((_, i) => !semanasEnQuiebre.has(i));
    const { media: mediaSemanal, std: stdSemanal } = mediaYDesviacion(ventasSemanaActivas);
    const cv = mediaSemanal > 0 ? stdSemanal / mediaSemanal : 999;
    let xyz: ClaseXYZ = "Z";
    if (cv < 0.5) xyz = "X";
    else if (cv < 1.0) xyz = "Y";

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

    // ── PASO 14: Oportunidad perdida ──
    const diasQuiebre = quiebresDelSku.filter(q => q.en_quiebre_full).length;
    const semanasQuiebre = semanasEnQuiebre.size;
    // Velocidad sin quiebres para estimar venta perdida
    const velFullSinQuiebre = velFull; // ya excluye quiebres
    const ventaPerdidaUds = diasQuiebre * (velFullSinQuiebre / 7);
    const ventaPerdidaPesos = ventaPerdidaUds * margenFull30d;
    const ingresoPerdido = ventaPerdidaUds * precioPromedio;

    // ── PASO 14b: Quiebre prolongado ──
    const prev = prevIntelligence.get(skuOrigen);
    let velPreQuiebre = prev?.vel_pre_quiebre || 0;
    let diasEnQuiebre = prev?.dias_en_quiebre || 0;
    let esQuiebreProveedor = prev?.es_quiebre_proveedor || false;
    let abcPreQuiebre: string | null = prev?.abc_pre_quiebre || null;
    let esCatchUp = false;
    let gmroiPotencial = 0;

    const enQuiebreAhora = stFull === 0 && velPonderada > 0;

    if (enQuiebreAhora) {
      if (prev && prev.dias_en_quiebre > 0) {
        // Continúa en quiebre — incrementar días
        diasEnQuiebre = prev.dias_en_quiebre + 1;
        velPreQuiebre = prev.vel_pre_quiebre;
        abcPreQuiebre = prev.abc_pre_quiebre;
        esQuiebreProveedor = prev.es_quiebre_proveedor;
      } else {
        // Acaba de entrar en quiebre — congelar velocidad actual
        diasEnQuiebre = diasQuiebre > 0 ? diasQuiebre : 1;
        velPreQuiebre = velPonderada;
        abcPreQuiebre = null; // Se asigna después del paso ABC global
        esQuiebreProveedor = !prod || prod.estado_sku === "sin_stock_proveedor";
      }
    } else if (prev && prev.dias_en_quiebre > 0 && stFull > 0) {
      // SKU se repuso — verificar catch-up
      if (prev.vel_pre_quiebre > 2 && vel7d > prev.vel_pre_quiebre * 1.5) {
        esCatchUp = true;
      }
      if (vel30d > 0 && !esCatchUp) {
        // 3+ semanas vendiendo → reset completo
        velPreQuiebre = 0;
        diasEnQuiebre = 0;
        esQuiebreProveedor = false;
        abcPreQuiebre = null;
      } else {
        // Primeras semanas post-reposición
        velPreQuiebre = prev.vel_pre_quiebre;
        diasEnQuiebre = 0;
        abcPreQuiebre = prev.abc_pre_quiebre;
      }
    }

    const enQuiebreProlongado = enQuiebreAhora && diasEnQuiebre >= 14 && velPreQuiebre > 2;

    // GMROI potencial: cuánto DEBERÍA rendir si tuviera stock
    if (enQuiebreProlongado && velPreQuiebre > 0 && costoBruto > 0) {
      const margenPromPot = margenFull30d * pctFull + margenFlex30d * pctFlex;
      const margenAnualPot = margenPromPot * velPreQuiebre * 52;
      const costoInvPot = costoBruto * velPreQuiebre * (targetDiasFull / 7);
      gmroiPotencial = costoInvPot > 0 ? round2(margenAnualPot / costoInvPot) : 0;
    }

    // ── PASO 15: Acción y prioridad ──
    // Usar velEfectiva para pedir (vel_pre_quiebre si en quiebre prolongado)
    const velParaPedir = enQuiebreProlongado ? velPreQuiebre : (multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada);
    const velTarget = multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada;
    const targetFullUds = velParaPedir * pctFull * targetDiasFull / 7;
    const targetFlexUds = velParaPedir * pctFlex * 30 / 7;
    const mandarFull = Math.max(0, Math.min(Math.ceil(targetFullUds - stFull), stBodega));
    const pedirTotal = Math.max(0, Math.ceil((targetFullUds + targetFlexUds) - stProyectado));
    const pedirProvBultos = innerPack > 1 && pedirTotal > 0 ? Math.ceil(pedirTotal / innerPack) : pedirTotal;

    let accion: AccionIntel;
    let prioridad: number;
    if (velPonderada === 0 && velPreQuiebre === 0 && stTotal === 0) { accion = "INACTIVO"; prioridad = 99; }
    else if (velPonderada === 0 && velPreQuiebre === 0 && stTotal > 0) { accion = "DEAD_STOCK"; prioridad = 80; }
    else if (stFull === 0 && (velFull > 0 || enQuiebreProlongado) && stBodega > 0) { accion = "MANDAR_FULL"; prioridad = 10; }
    else if (stFull === 0 && (velFull > 0 || enQuiebreProlongado) && stBodega === 0 && esQuiebreProveedor) { accion = "AGOTADO_SIN_PROVEEDOR"; prioridad = 3; }
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

    const ultimoMov = ultimoMovPorSku.get(skuOrigen) || null;
    const diasSinMov = ultimoMov ? Math.floor((hoyMs - new Date(ultimoMov).getTime()) / 86400000) : 999;

    // Ingreso estimado 30d (para ABC)
    const ingreso30d = velPonderada * precioPromedio * 4.3;

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
      stock_proveedor: -1,    // se llena desde cache de proveedor
      tiene_stock_prov: true,
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

      // ABC se asigna después (paso 9 global)
      abc: "C",
      ingreso_30d: round2(ingreso30d),
      pct_ingreso_acumulado: 0,
      cv: round2(cv),
      xyz,
      desviacion_std: round2(stdSemanal),
      cuadrante: "REVISAR",

      gmroi: round2(gmroi),
      dio: round2(dio),
      costo_neto: costoNeto,
      costo_bruto: costoBruto,
      costo_inventario_total: costoInventarioTotal,

      stock_seguridad: round2(stockSeguridad),
      punto_reorden: round2(puntoReorden),
      nivel_servicio: nivelServicio,

      dias_sin_stock_full: diasQuiebre,
      semanas_con_quiebre: semanasQuiebre,
      venta_perdida_uds: round2(ventaPerdidaUds),
      venta_perdida_pesos: round2(ventaPerdidaPesos),
      ingreso_perdido: round2(ingresoPerdido),

      accion,
      prioridad,
      mandar_full: mandarFull,
      pedir_proveedor: pedirTotal,
      pedir_proveedor_bultos: pedirProvBultos,
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
      dias_en_quiebre: diasEnQuiebre,
      es_quiebre_proveedor: esQuiebreProveedor,
      abc_pre_quiebre: abcPreQuiebre,
      gmroi_potencial: gmroiPotencial,
      es_catch_up: esCatchUp,

      updated_at: hoy.toISOString(),
      datos_desde: fechaMin ? fechaMin.slice(0, 10) : null,
      datos_hasta: fechaMax ? fechaMax.slice(0, 10) : null,
    });
  }

  // ════════════════════════════════════════
  // PASOS GLOBALES (9, 11, 12-ajuste, 17, 19)
  // ════════════════════════════════════════

  // ── PASO 9: Clasificación ABC (Pareto 80/20) ──
  // Para SKUs en quiebre prolongado, usar vel_pre_quiebre × precio para ingreso estimado
  for (const r of rows) {
    if (r.dias_en_quiebre >= 14 && r.vel_pre_quiebre > 2) {
      r.ingreso_30d = round2(r.vel_pre_quiebre * r.precio_promedio * 4.3);
    }
  }
  const rowsConIngreso = rows.filter(r => r.ingreso_30d > 0);
  rowsConIngreso.sort((a, b) => b.ingreso_30d - a.ingreso_30d);
  const ingresoTotal = rowsConIngreso.reduce((s, r) => s + r.ingreso_30d, 0);

  if (ingresoTotal > 0) {
    let acum = 0;
    for (const r of rowsConIngreso) {
      acum += r.ingreso_30d;
      r.pct_ingreso_acumulado = round2((acum / ingresoTotal) * 100);
      if (r.pct_ingreso_acumulado <= 80) r.abc = "A";
      else if (r.pct_ingreso_acumulado <= 95) r.abc = "B";
      else r.abc = "C";
    }
  }
  // SKUs sin ingreso → C
  for (const r of rows) {
    if (r.ingreso_30d <= 0) r.abc = "C";
  }
  // Asignar abc_pre_quiebre para SKUs que acaban de entrar en quiebre
  for (const r of rows) {
    if (r.dias_en_quiebre > 0 && !r.abc_pre_quiebre) {
      r.abc_pre_quiebre = r.abc;
    }
  }

  // ── PASO 11: Cuadrante (mediana vel × margen) ──
  const rowsActivos = rows.filter(r => r.vel_ponderada > 0);
  if (rowsActivos.length > 0) {
    const vels = rowsActivos.map(r => r.vel_ponderada).sort((a, b) => a - b);
    const margenes = rowsActivos.map(r => r.margen_full_30d * r.pct_full + r.margen_flex_30d * r.pct_flex).sort((a, b) => a - b);
    const velMediana = mediana(vels);
    const margenMediana = mediana(margenes);

    for (const r of rowsActivos) {
      const margenProm = r.margen_full_30d * r.pct_full + r.margen_flex_30d * r.pct_flex;
      if (r.vel_ponderada >= velMediana && margenProm >= margenMediana) r.cuadrante = "ESTRELLA";
      else if (r.vel_ponderada >= velMediana && margenProm < margenMediana) r.cuadrante = "VOLUMEN";
      else if (r.vel_ponderada < velMediana && margenProm >= margenMediana) r.cuadrante = "CASHCOW";
      else r.cuadrante = "REVISAR";
    }
  }

  // ── Ajustar stock de seguridad y punto de reorden por ABC (paso 12 refinado) ──
  for (const r of rows) {
    let ns = 0.95;
    if (r.abc === "A") ns = 0.97;
    else if (r.abc === "C") ns = 0.90;
    r.nivel_servicio = ns;
    const Z = zScore(ns);
    const lt = (prodMap.get(r.sku_origen)?.lead_time_dias || 7) / 7;
    r.stock_seguridad = round2(Z * r.desviacion_std * Math.sqrt(lt));
    r.punto_reorden = round2((r.vel_ponderada * lt) + r.stock_seguridad);
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
  for (const r of rows) {
    const alertas: AlertaIntel[] = [];

    if (r.stock_full === 0 && r.vel_full > 0) alertas.push("agotado_full");
    if (r.cob_full < r.punto_reorden && r.cob_full < 999) alertas.push("urgente");
    if (r.margen_full_30d < 0 && r.vel_full > 0) alertas.push("margen_negativo_full");
    if (r.margen_flex_30d < 0 && r.vel_flex > 0) alertas.push("margen_negativo_flex");
    if (r.es_pico) alertas.push("pico_demanda");
    if (r.tendencia_vel === "bajando" && Math.abs(r.tendencia_vel_pct) > 30) alertas.push("caida_demanda");
    if (!r.tiene_stock_prov) alertas.push("sin_stock_proveedor");
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
        const detail = stockFullDetail.get(sv);
        if (detail) {
          totalDanado += detail.stock_danado;
          totalPerdido += detail.stock_perdido;
        }
      }
      if (totalDanado > 0 || totalPerdido > 0) alertas.push("stock_danado_full");
    }

    // Quiebre prolongado
    if (r.dias_en_quiebre >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A")) {
      alertas.push("estrella_quiebre_prolongado");
    }
    if (r.es_catch_up) alertas.push("catch_up_post_quiebre");

    // Proveedor volvió a tener stock (antes no tenía, ahora sí)
    const prev2 = prevIntelligence.get(r.sku_origen);
    if (prev2 && prev2.es_quiebre_proveedor && !r.es_quiebre_proveedor && r.vel_pre_quiebre > 2) {
      alertas.push("proveedor_volvio_stock");
    }

    r.alertas = alertas;
    r.alertas_count = alertas.length;
  }

  return rows;
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
      cuadrante: r.cuadrante,
      gmroi: r.gmroi,
      dio: r.dio,
      accion: r.accion,
      alertas: r.alertas,
      venta_perdida_pesos: r.venta_perdida_pesos,
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
