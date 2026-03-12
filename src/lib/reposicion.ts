/**
 * Lógica pura de cálculo de reposición — extraída para testing.
 * Sin dependencias de React, DOM, o store.
 */

/* ───── Tipos ───── */
export interface OrdenRaw {
  sku: string;
  cantidad: number;
  fecha: Date;
  canal: "full" | "flex";
  subtotal: number;
  comisionTotal: number;
  costoEnvio: number;
  ingresoEnvio: number;
}

export interface VelocidadRaw {
  skuVenta: string;
  nombre: string;
  promedioSemanal: number;
  stockFull: number;
  semanas: number[];
}

export interface CalculationStep {
  label: string;
  formula: string;
  value: string;
}

export interface SkuCalculationLog {
  skuVenta: string;
  pasos: CalculationStep[];
}

export type Accion = "SIN VENTA" | "MANDAR A FULL" | "AGOTADO PEDIR" | "URGENTE" | "PLANIFICAR" | "OK" | "EXCESO";

export interface Config {
  cobObjetivo: number;
  puntoReorden: number;
  cobMaxima: number;
}

export const DEFAULT_CONFIG: Config = { cobObjetivo: 45, puntoReorden: 14, cobMaxima: 60 };

export interface FinancialAgg {
  totalSubtotal: number;
  totalComision: number;
  totalCostoEnvio: number;
  totalIngresoEnvio: number;
  totalCantidad: number;
}

export const COSTO_ENVIO_FLEX = 3320;

/**
 * Resultado intermedio del cálculo de velocidad para un SKU.
 * Exportado para testing.
 */
export interface VelocidadResult {
  velOrdenesTotal: number;
  pgPromedio: number;
  velTotal: number;
  pctFull: number;
  pctFlex: number;
  velFull: number;
  velFlex: number;
  ordFull6sem: number;
  ordFlex6sem: number;
}

/**
 * Calcula velocidades para un SKU dado las órdenes y ProfitGuard.
 * Función pura, sin side effects.
 */
export function calcularVelocidadSku(
  ordFull: number,   // sum of Full qty in last 6 weeks (NOT divided by 6 yet)
  ordFlex: number,   // sum of Flex qty in last 6 weeks (NOT divided by 6 yet)
  pgPromedio: number, // ProfitGuard weekly average
): VelocidadResult {
  const velFull6 = ordFull / 6;
  const velFlex6 = ordFlex / 6;
  const velOrdenesTotal = velFull6 + velFlex6;
  const velTotal = Math.max(pgPromedio, velOrdenesTotal);

  const velOrdenSum = velFull6 + velFlex6;
  const pctFull = velOrdenSum > 0 ? velFull6 / velOrdenSum : 1;
  const pctFlex = 1 - pctFull;

  return {
    velOrdenesTotal,
    pgPromedio,
    velTotal,
    pctFull,
    pctFlex,
    velFull: velTotal * pctFull,
    velFlex: velTotal * pctFlex,
    ordFull6sem: ordFull,
    ordFlex6sem: ordFlex,
  };
}

/**
 * Calcula cobertura en días.
 */
export function calcularCobertura(stock: number, velocidadSemanal: number): number {
  if (velocidadSemanal <= 0) return 999;
  return (stock / velocidadSemanal) * 7;
}

/**
 * Calcula target de días: 30 si margenFlex > margenFull, sino cobObjetivo.
 */
export function calcularTargetDias(
  margenFlex: number | null,
  margenFull: number | null,
  cobObjetivo: number,
): number {
  return (margenFlex !== null && margenFull !== null && margenFlex > margenFull) ? 30 : cobObjetivo;
}

/**
 * Calcula cuántas unidades mandar a Full.
 */
export function calcularMandarFull(
  velFull: number,
  targetDias: number,
  stockFull: number,
  stockBodega: number,
): number {
  const targetFull = velFull * targetDias / 7;
  return Math.max(0, Math.min(Math.ceil(targetFull - stockFull), stockBodega));
}

/**
 * Calcula cuántas unidades pedir al proveedor (a nivel SKU Venta).
 */
export function calcularPedirVenta(
  velFull: number,
  velFlex: number,
  targetDias: number,
  stockFull: number,
  stockBodega: number,
): number {
  const targetFull = velFull * targetDias / 7;
  const targetFlex = velFlex * targetDias / 7;
  return Math.max(0, Math.ceil((targetFull + targetFlex) - (stockFull + stockBodega)));
}

/**
 * Determina la acción basada en las condiciones de stock y velocidad.
 */
export function determinarAccion(
  velTotal: number,
  velFull: number,
  stockFull: number,
  stockBodega: number,
  cobFull: number,
  puntoReorden: number,
  cobMaxima: number,
): Accion {
  if (velTotal === 0) return "SIN VENTA";
  if (stockFull === 0 && velFull > 0 && stockBodega > 0) return "MANDAR A FULL";
  if (stockFull === 0 && velFull > 0 && stockBodega === 0) return "AGOTADO PEDIR";
  if (cobFull < puntoReorden) return "URGENTE";
  if (cobFull < 30) return "PLANIFICAR";
  if (cobFull <= cobMaxima) return "OK";
  return "EXCESO";
}

/**
 * Calcula margen unitario por canal.
 */
export function calcularMargen(
  financialAgg: FinancialAgg,
  canal: "flex" | "full",
  costoProducto: number,
): number | null {
  if (financialAgg.totalCantidad <= 0) return null;
  const ingresoUnit = financialAgg.totalSubtotal / financialAgg.totalCantidad;
  const comisionUnit = financialAgg.totalComision / financialAgg.totalCantidad;
  if (canal === "flex") {
    const costoEnvioReal = COSTO_ENVIO_FLEX - (financialAgg.totalIngresoEnvio / financialAgg.totalCantidad);
    return Math.round(ingresoUnit - comisionUnit - costoEnvioReal - costoProducto);
  } else {
    const costoEnvioUnit = financialAgg.totalCostoEnvio / financialAgg.totalCantidad;
    return Math.round(ingresoUnit - comisionUnit - costoEnvioUnit - costoProducto);
  }
}
