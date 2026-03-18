"use client";
import React, { useState, useMemo, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import { skuTotal, skuPositions, getStore, getComponentesPorSkuVenta, getVentasPorSkuOrigen, getSkuFisicoPorSkuVenta, buildPickingLineasFull, crearPickingSession, findSkuVenta } from "@/lib/store";
import type { ComposicionVenta } from "@/lib/store";
import { getSupabase } from "@/lib/supabase";
import { upsertProveedorCatalogo, insertProveedorImport, insertCostosHistorial, fetchProveedorCatalogo } from "@/lib/db";
import type { DBProveedorCatalogo } from "@/lib/db";

/* ───── Tipos ───── */
interface OrdenRaw {
  sku: string;
  cantidad: number;
  fecha: Date;
  canal: "full" | "flex";
  subtotal: number;
  comisionTotal: number;
  costoEnvio: number;
  ingresoEnvio: number;
}

interface VelocidadRaw {
  skuVenta: string;
  nombre: string;
  promedioSemanal: number;
  stockFull: number;
  semanas: number[];
}

/* ───── Log de auditoría del cálculo ───── */
interface CalculationStep {
  label: string;
  formula: string;
  value: string;
}

interface SkuCalculationLog {
  skuVenta: string;
  pasos: CalculationStep[];
}

interface SkuVentaRow {
  skuVenta: string;
  nombre: string;
  velTotal: number;
  velFull: number;
  velFlex: number;
  stockFull: number;
  stockBodega: number;
  stockTotal: number;
  cobFull: number;
  cobBodega: number;
  cobTotal: number;
  mandarFull: number;
  pedir: number;
  accion: Accion;
  margenFlex: number | null;
  margenFull: number | null;
  costoProducto: number | null;
  sinCosto: boolean;
  // Campos stock compartido
  skuOrigenPrincipal: string;
  esCompartido: boolean;
  formatosCompartidos: number;
  otrosFormatos: string[];
  stockBodegaFisico: number; // stock físico real del SKU Origen
  sinMapeo: boolean; // true si no se encontró mapeo skuVenta→skuOrigen
  // Log de auditoría
  calcLog?: SkuCalculationLog;
}

interface SkuOrigenRow {
  skuOrigen: string;
  nombre: string;
  velTotalFisica: number;
  stockBodega: number;
  demandaFisicaTotal: number;
  targetFisico: number;
  pedirProveedor: number;
  stockFullEquiv: number;
  accion: Accion;
  // Campos stock compartido
  velFullFisica: number;
  velFlexFisica: number;
  coberturaFisicaDias: number;
  skusVentaAsociados: { skuVenta: string; unidades: number; nombre: string; velSemanal: number; stockFull: number }[];
  esCompartido: boolean;
  // Campos proveedor (se llenan cuando se carga lista de precios)
  stockProveedor?: number;
  innerPack?: number;
  bultos?: number;
  pedirReal?: number;
  costoProveedor?: number;
  costoTotalLinea?: number;
  statusProveedor?: ProveedorStatus;
  alertaCosto?: { costoWMS: number; costoProveedor: number };
  diasAgotamiento?: number;
  nombreProveedor?: string; // proveedor del diccionario (Google Sheet)
}

interface ProveedorRaw {
  skuOrigen: string;
  nombre: string;
  innerPack: number;
  precioNeto: number;
  stock: number;
}

type ProveedorStatus = "ok" | "sin_stock" | "otro_proveedor";

type EnvioTipo = "simple" | "pack" | "combo";
type EnvioEstado = "listo" | "armar" | "insuficiente";

interface EnvioComponenteDetalle {
  skuOrigen: string;
  nombreOrigen: string;
  unidadesPorPack: number;
  unidadesFisicas: number;
  innerPack: number | null; // null = no hay info de proveedor
  bultosCompletos: number;
  sueltas: number;
  faltanParaBulto: number;
  sueltasEnPacks: number; // equivalente en SKU Venta
  posiciones: { pos: string; label: string; qty: number }[];
  stockTotal: number;
  alcanza: boolean;
  maxPacks: number; // máximo de packs armables con stock disponible
  alternativos?: string[];
}

interface RedondeoInfo {
  original: number;           // cantidad original antes de redondear
  redondeado: number;         // cantidad final redondeada
  innerPack: number;
  direccion: "arriba" | "abajo" | "sin_cambio";
  opcionAbajo: number;
  opcionArriba: number;
  cobAbajo: number;           // cobertura Full con opción abajo
  cobArriba: number;          // cobertura Full con opción arriba
  razon: string;
  stockBodegaDespues: number; // stock bodega después de enviar
}

interface EnvioFullDetalle {
  skuVenta: string;
  nombre: string;
  mandarFull: number;
  mandarFullOriginal: number; // antes de redondeo
  tipo: EnvioTipo;
  estado: EnvioEstado;
  componentes: EnvioComponenteDetalle[];
  maxPacksGlobal: number; // min de maxPacks de todos los componentes
  accion: Accion;
  stockFull: number;
  cobFull: number;
  velFull: number;
  redondeo: RedondeoInfo | null; // null si no hubo redondeo o no hay inner pack
}

type Accion = "SIN VENTA" | "MANDAR A FULL" | "AGOTADO PEDIR" | "URGENTE" | "PLANIFICAR" | "OK" | "EXCESO";

interface Config {
  cobObjetivo: number;
  puntoReorden: number;
  cobMaxima: number;
}

const DEFAULT_CONFIG: Config = { cobObjetivo: 40, puntoReorden: 14, cobMaxima: 60 };

const ACCION_ORDEN: Record<Accion, number> = {
  "AGOTADO PEDIR": 0, "URGENTE": 1, "MANDAR A FULL": 2, "PLANIFICAR": 3, "OK": 4, "EXCESO": 5, "SIN VENTA": 6,
};

const ACCION_COLOR: Record<Accion, { bg: string; color: string; border: string }> = {
  "SIN VENTA":     { bg: "var(--bg3)",    color: "var(--txt3)",  border: "var(--bg4)" },
  "MANDAR A FULL": { bg: "var(--blueBg)", color: "var(--blue)",  border: "var(--blueBd)" },
  "AGOTADO PEDIR": { bg: "var(--redBg)",  color: "var(--red)",   border: "var(--redBd)" },
  "URGENTE":       { bg: "var(--redBg)",  color: "var(--red)",   border: "var(--redBd)" },
  "PLANIFICAR":    { bg: "var(--amberBg)",color: "var(--amber)", border: "var(--amberBd)" },
  "OK":            { bg: "var(--greenBg)",color: "var(--green)", border: "var(--greenBd)" },
  "EXCESO":        { bg: "var(--amberBg)",color: "var(--amber)", border: "var(--amberBd)" },
};

/* ───── Helpers parseo ───── */
function findColIndex(headers: unknown[], ...patterns: string[]): number {
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const p of patterns) {
      if (h.includes(p)) return c;
    }
  }
  return -1;
}

function parseOrdenes(wb: XLSX.WorkBook): OrdenRaw[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (rows.length < 2) return [];

  // Buscar columnas por nombre en header
  const hdr = rows[0] || [];
  const colSku = findColIndex(hdr, "sku");
  const colCantidad = findColIndex(hdr, "cantidad");
  const colFecha = findColIndex(hdr, "fecha");
  const colEstado = findColIndex(hdr, "estado");
  const colLogistica = findColIndex(hdr, "logistic", "tipo logistic");
  const colSubtotal = findColIndex(hdr, "subtotal");
  const colComision = findColIndex(hdr, "comision");
  const colCostoEnvio = findColIndex(hdr, "costo env");
  const colIngresoEnvio = findColIndex(hdr, "ingreso env");

  // Fallback a posiciones fijas si no se encuentran headers
  const iSku = colSku >= 0 ? colSku : 5;
  const iCantidad = colCantidad >= 0 ? colCantidad : 6;
  const iFecha = colFecha >= 0 ? colFecha : 3;
  const iEstado = colEstado >= 0 ? colEstado : 11;
  const iLogistica = colLogistica >= 0 ? colLogistica : 16;

  const out: OrdenRaw[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;
    const estado = String(row[iEstado] || "").trim();
    if (estado !== "Pagada") continue;
    const sku = String(row[iSku] || "").trim().toUpperCase();
    if (!sku) continue;
    const cantidad = Number(row[iCantidad]) || 0;
    if (cantidad <= 0) continue;
    const fechaRaw = row[iFecha];
    let fecha: Date;
    if (typeof fechaRaw === "number") {
      fecha = excelDateToJS(fechaRaw);
    } else {
      fecha = new Date(String(fechaRaw));
    }
    if (isNaN(fecha.getTime())) continue;
    const logistica = String(row[iLogistica] || "").trim().toLowerCase();
    // fulfillment y xd_drop_off → Full; self_service y otros → Flex
    const canal: "full" | "flex" = (logistica === "fulfillment" || logistica === "xd_drop_off") ? "full" : "flex";

    const subtotal = colSubtotal >= 0 ? (Number(row[colSubtotal]) || 0) : 0;
    const comisionTotal = colComision >= 0 ? (Number(row[colComision]) || 0) : 0;
    const costoEnvio = colCostoEnvio >= 0 ? (Number(row[colCostoEnvio]) || 0) : 0;
    const ingresoEnvio = colIngresoEnvio >= 0 ? (Number(row[colIngresoEnvio]) || 0) : 0;

    out.push({ sku, cantidad, fecha, canal, subtotal, comisionTotal, costoEnvio, ingresoEnvio });
  }
  return out;
}

function excelDateToJS(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400 * 1000);
}

function parseVelocidad(wb: XLSX.WorkBook): VelocidadRaw[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const out: VelocidadRaw[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;
    const skuVenta = String(row[0] || "").trim().toUpperCase();
    if (!skuVenta) continue;
    const nombre = String(row[1] || "").trim();
    const promedioSemanal = Number(row[10]) || 0;
    const stockFull = Number(row[11]) || 0;
    const semanas: number[] = [];
    for (let c = 4; c <= 9; c++) semanas.push(Number(row[c]) || 0);
    out.push({ skuVenta, nombre, promedioSemanal, stockFull, semanas });
  }
  return out;
}

function parseProveedor(wb: XLSX.WorkBook): ProveedorRaw[] {
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (rows.length < 2) return [];
  const out: ProveedorRaw[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;
    // Col B (1) = Codigo AX (SKU Origen), Col C (2) = Producto, Col D (3) = Inner Pack, Col E (4) = Precio Banva neto, Col F (5) = Stock
    const skuOrigen = String(row[1] || "").trim();
    if (!skuOrigen) continue;
    const nombre = String(row[2] || "").trim();
    const innerPack = Math.max(1, Math.round(Number(row[3]) || 1));
    const precioNeto = Number(row[4]) || 0;
    const stock = Math.max(0, Math.round(Number(row[5]) || 0));
    out.push({ skuOrigen, nombre, innerPack, precioNeto, stock });
  }
  return out;
}

/* ───── Costo producto para SKU Venta (con packs) ───── */
const COSTO_ENVIO_FLEX = 3320;

function calcCostoProductoBruto(skuVenta: string): number | null {
  const store = getStore();
  const componentes = getComponentesPorSkuVenta(skuVenta);
  if (componentes.length > 0) {
    // Pack/combo: sumar costo de cada componente × unidades
    let costoNeto = 0;
    for (const c of componentes) {
      const prod = store.products[c.skuOrigen];
      if (!prod || !prod.cost) return null; // sin costo en diccionario
      costoNeto += prod.cost * c.unidades;
    }
    return Math.round(costoNeto * 1.19);
  } else {
    // Producto simple
    const prod = store.products[skuVenta];
    if (!prod || !prod.cost) return null;
    return Math.round(prod.cost * 1.19);
  }
}

interface FinancialAgg {
  totalSubtotal: number;
  totalComision: number;
  totalCostoEnvio: number;
  totalIngresoEnvio: number;
  totalCantidad: number;
}

/* ───── Lógica de cálculo ───── */
function calcularReposicion(
  ordenes: OrdenRaw[],
  velocidades: VelocidadRaw[],
  config: Config,
  sinStockProv: Set<string>,
  proveedorData?: ProveedorRaw[],
): { ventaRows: SkuVentaRow[]; origenRows: SkuOrigenRow[] } {
  // 1. Últimas 6 semanas desde fecha más reciente
  const fechas = ordenes.map(o => o.fecha.getTime());
  const maxFecha = fechas.length > 0 ? Math.max(...fechas) : Date.now();
  const cutoff = maxFecha - 6 * 7 * 86400000;
  const recientes = ordenes.filter(o => o.fecha.getTime() >= cutoff);

  // 2. Velocidad por canal desde órdenes (por SKU venta)
  const velOrdenes = new Map<string, { full: number; flex: number }>();
  // Financials por SKU y canal
  const financials = new Map<string, { flex: FinancialAgg; full: FinancialAgg }>();
  for (const o of recientes) {
    if (!velOrdenes.has(o.sku)) velOrdenes.set(o.sku, { full: 0, flex: 0 });
    const v = velOrdenes.get(o.sku)!;
    if (o.canal === "full") v.full += o.cantidad;
    else v.flex += o.cantidad;

    // Acumular financials
    if (!financials.has(o.sku)) {
      financials.set(o.sku, {
        flex: { totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0, totalIngresoEnvio: 0, totalCantidad: 0 },
        full: { totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0, totalIngresoEnvio: 0, totalCantidad: 0 },
      });
    }
    const fin = financials.get(o.sku)![o.canal];
    fin.totalSubtotal += o.subtotal;
    fin.totalComision += o.comisionTotal;
    fin.totalCostoEnvio += o.costoEnvio;
    fin.totalIngresoEnvio += o.ingresoEnvio;
    fin.totalCantidad += o.cantidad;
  }
  // Dividir por 6 semanas
  velOrdenes.forEach(v => {
    v.full /= 6;
    v.flex /= 6;
  });

  // 3. Mapa de velocidad ProfitGuard
  const velPG = new Map<string, VelocidadRaw>();
  for (const v of velocidades) velPG.set(v.skuVenta, v);

  // Set completo de SKU Venta
  const allSkusVenta = new Set<string>();
  for (const v of velocidades) allSkusVenta.add(v.skuVenta);
  velOrdenes.forEach((_, k) => allSkusVenta.add(k));

  const { cobObjetivo, puntoReorden, cobMaxima } = config;

  // 3.5. Construir mapa SKU Origen → SKU Ventas asociados (detección automática de compartidos)
  const origenToVentasMap = new Map<string, { skuVenta: string; unidades: number }[]>();
  for (const sv of Array.from(allSkusVenta)) {
    const comps = getComponentesPorSkuVenta(sv);
    if (comps.length > 0) {
      for (const c of comps) {
        if (!origenToVentasMap.has(c.skuOrigen)) origenToVentasMap.set(c.skuOrigen, []);
        origenToVentasMap.get(c.skuOrigen)!.push({ skuVenta: sv, unidades: c.unidades });
      }
    } else {
      // SKU simple: buscar SKU físico real
      const skuFisico = getSkuFisicoPorSkuVenta(sv) || sv;
      if (!origenToVentasMap.has(skuFisico)) origenToVentasMap.set(skuFisico, []);
      origenToVentasMap.get(skuFisico)!.push({ skuVenta: sv, unidades: 1 });
    }
  }

  // 4. Calcular filas por SKU Venta
  const ventaRows: SkuVentaRow[] = [];
  // Para acumular demanda física por SKU Origen
  const demandaFisicaPorOrigen = new Map<string, { velFull: number; velFlex: number; velTotal: number }>();
  const stockFullPorOrigen = new Map<string, number>();
  // Nombres por SKU Origen
  const nombreOrigen = new Map<string, string>();
  // Mapa temporal para info de SKU Venta (para asociar a SKU Origen después)
  const ventaInfoMap = new Map<string, { nombre: string; velTotal: number; stockFull: number }>();

  const allSkusVentaArr = Array.from(allSkusVenta);
  for (let _i = 0; _i < allSkusVentaArr.length; _i++) {
    const skuVenta = allSkusVentaArr[_i];
    const pg = velPG.get(skuVenta);
    const ord = velOrdenes.get(skuVenta) || { full: 0, flex: 0 };

    // Velocidad total: max(PG promedio, ordenes full+flex)
    const velOrdenesTotal = ord.full + ord.flex;
    const pgPromedio = pg?.promedioSemanal || 0;
    const velTotal = Math.max(pgPromedio, velOrdenesTotal);

    // Porcentaje por canal
    const velOrdenSum = ord.full + ord.flex;
    let pctFull = velOrdenSum > 0 ? ord.full / velOrdenSum : 1;
    let pctFlex = 1 - pctFull;

    const velFull = velTotal * pctFull;
    const velFlex = velTotal * pctFlex;

    // Stock Full viene de ProfitGuard
    const stockFull = pg?.stockFull || 0;

    // Stock bodega: necesitamos mapear SKU Venta → SKU Origen
    const componentes = getComponentesPorSkuVenta(skuVenta);
    let stockBodega = 0;
    let skuOrigenPrincipal = skuVenta;
    let stockBodegaFisico = 0;
    let sinMapeo = false;
    if (componentes.length > 0) {
      // Para packs/combos, el stock de bodega es el mínimo de (stock_origen / unidades)
      stockBodega = Math.min(...componentes.map(c => Math.floor(skuTotal(c.skuOrigen) / c.unidades)));
      skuOrigenPrincipal = componentes.length === 1 ? componentes[0].skuOrigen : componentes[0].skuOrigen;
      stockBodegaFisico = componentes.length === 1 ? skuTotal(componentes[0].skuOrigen) : skuTotal(componentes[0].skuOrigen);
    } else {
      // SKU simple: intentar buscar SKU físico real en productos
      const skuFisico = getSkuFisicoPorSkuVenta(skuVenta);
      sinMapeo = skuFisico === null;
      skuOrigenPrincipal = skuFisico || skuVenta;
      stockBodega = skuTotal(skuOrigenPrincipal);
      stockBodegaFisico = stockBodega;
    }

    // Detección de stock compartido
    const asociados = origenToVentasMap.get(skuOrigenPrincipal) || [];
    const esCompartido = asociados.length > 1;
    const formatosCompartidos = asociados.length;
    const otrosFormatos = asociados.filter(a => a.skuVenta !== skuVenta).map(a => a.skuVenta);

    const stockTotal = stockFull + stockBodega;

    // Cobertura en días
    const cobFull = velFull > 0 ? (stockFull / velFull) * 7 : 999;
    const cobBodega = velFlex > 0 ? (stockBodega / velFlex) * 7 : 999;
    const cobTotal = velTotal > 0 ? (stockTotal / velTotal) * 7 : 999;

    // Margen por canal
    const costoProducto = calcCostoProductoBruto(skuVenta);
    const sinCosto = costoProducto === null;
    const fin = financials.get(skuVenta);
    let margenFlex: number | null = null;
    let margenFull: number | null = null;

    if (!sinCosto && fin) {
      const fp = fin.flex;
      if (fp.totalCantidad > 0) {
        const ingresoUnit = fp.totalSubtotal / fp.totalCantidad;
        const comisionUnit = fp.totalComision / fp.totalCantidad;
        const costoEnvioReal = COSTO_ENVIO_FLEX - (fp.totalIngresoEnvio / fp.totalCantidad);
        margenFlex = Math.round(ingresoUnit - comisionUnit - costoEnvioReal - costoProducto);
      }
      const fu = fin.full;
      if (fu.totalCantidad > 0) {
        const ingresoUnit = fu.totalSubtotal / fu.totalCantidad;
        const comisionUnit = fu.totalComision / fu.totalCantidad;
        const costoEnvioUnit = fu.totalCostoEnvio / fu.totalCantidad;
        margenFull = Math.round(ingresoUnit - comisionUnit - costoEnvioUnit - costoProducto);
      }
    }

    // Target días según ratio margen Flex/Full
    let targetDias = cobObjetivo; // default 40d (Full >= Flex o sin datos)
    if (margenFlex !== null && margenFull !== null && margenFlex > margenFull) {
      if (margenFull > 0) {
        const ratio = margenFlex / margenFull;
        targetDias = ratio > 1.2 ? 15 : 25;
      } else {
        // margenFull <= 0: Flex es claramente superior → 15d
        targetDias = 15;
      }
    }
    const targetFull = velFull * targetDias / 7;
    const targetFlex = velFlex * targetDias / 7;

    // Mandar a Full
    const mandarFull = Math.max(0, Math.min(Math.ceil(targetFull - stockFull), stockBodega));

    // Pedir a proveedor (a nivel SKU Venta, luego se agrega por origen)
    const pedirVenta = Math.max(0, Math.ceil((targetFull + targetFlex) - (stockFull + stockBodega)));

    // Acción
    let accion: Accion;
    if (velTotal === 0) accion = "SIN VENTA";
    else if (stockFull === 0 && velFull > 0 && stockBodega > 0) accion = "MANDAR A FULL";
    else if (stockFull === 0 && velFull > 0 && stockBodega === 0) accion = "AGOTADO PEDIR";
    else if (cobFull < puntoReorden) accion = "URGENTE";
    else if (cobFull < 30) accion = "PLANIFICAR";
    else if (cobFull <= cobMaxima) accion = "OK";
    else accion = "EXCESO";

    const nombre = pg?.nombre || getStore().products[skuVenta]?.name || skuVenta;

    // ── Log de auditoría paso a paso ──
    const calcLog: SkuCalculationLog = { skuVenta, pasos: [] };
    const p = (label: string, formula: string, value: string) => calcLog.pasos.push({ label, formula, value });

    p("Órdenes Full (6 sem)", `Σ cantidad Full últimas 6 sem = ${(ord.full * 6).toFixed(0)}`, `${(ord.full * 6).toFixed(0)} uds`);
    p("Órdenes Flex (6 sem)", `Σ cantidad Flex últimas 6 sem = ${(ord.flex * 6).toFixed(0)}`, `${(ord.flex * 6).toFixed(0)} uds`);
    p("Vel Órdenes Full", `${(ord.full * 6).toFixed(0)} / 6`, `${ord.full.toFixed(2)} uds/sem`);
    p("Vel Órdenes Flex", `${(ord.flex * 6).toFixed(0)} / 6`, `${ord.flex.toFixed(2)} uds/sem`);
    p("Vel Órdenes Total", `${ord.full.toFixed(2)} + ${ord.flex.toFixed(2)}`, `${velOrdenesTotal.toFixed(2)} uds/sem`);
    p("Vel ProfitGuard", `promedio semanal PG`, `${pgPromedio.toFixed(2)} uds/sem`);
    p("Vel Total (final)", `max(PG=${pgPromedio.toFixed(2)}, Órdenes=${velOrdenesTotal.toFixed(2)})`, `${velTotal.toFixed(2)} uds/sem`);
    p("% Full", `${(ord.full * 6).toFixed(0)} / (${(ord.full * 6).toFixed(0)} + ${(ord.flex * 6).toFixed(0)})`, `${(pctFull * 100).toFixed(1)}%`);
    p("Vel Full", `${velTotal.toFixed(2)} × ${(pctFull * 100).toFixed(1)}%`, `${velFull.toFixed(2)} uds/sem`);
    p("Vel Flex", `${velTotal.toFixed(2)} × ${(pctFlex * 100).toFixed(1)}%`, `${velFlex.toFixed(2)} uds/sem`);
    p("Stock Full", `ProfitGuard`, `${stockFull} uds`);
    p("Stock Bodega", componentes.length > 0 ? `min(stock_origen / unidades_pack)` : `skuTotal(${skuOrigenPrincipal})`, `${stockBodega} uds`);
    p("Stock Total", `${stockFull} + ${stockBodega}`, `${stockTotal} uds`);
    p("Cob Full (días)", velFull > 0 ? `(${stockFull} / ${velFull.toFixed(2)}) × 7` : `sin ventas Full → ∞`, `${Math.round(cobFull)}d`);
    p("Cob Bodega (días)", velFlex > 0 ? `(${stockBodega} / ${velFlex.toFixed(2)}) × 7` : `sin ventas Flex → ∞`, `${Math.round(cobBodega)}d`);
    p("Cob Total (días)", velTotal > 0 ? `(${stockTotal} / ${velTotal.toFixed(2)}) × 7` : `sin ventas → ∞`, `${Math.round(cobTotal)}d`);
    if (margenFlex !== null && margenFull !== null) {
      p("Margen Flex", `ingreso - comisión - envío - costo`, `$${margenFlex.toLocaleString()}`);
      p("Margen Full", `ingreso - comisión - envío - costo`, `$${margenFull.toLocaleString()}`);
    }
    p("Target días", (() => {
      if (margenFlex === null || margenFull === null) return `sin datos de margen → ${cobObjetivo}d`;
      if (margenFlex <= margenFull) return `margenFull($${margenFull}) >= margenFlex($${margenFlex}) → ${cobObjetivo}d`;
      if (margenFull <= 0) return `margenFull <= 0, Flex superior → 15d`;
      const ratio = margenFlex / margenFull;
      return ratio > 1.2
        ? `Flex/Full = ${ratio.toFixed(2)} > 1.2 → 15d`
        : `Flex/Full = ${ratio.toFixed(2)} (1.0–1.2) → 25d`;
    })(), `${targetDias}d`);
    p("Target Full", `${velFull.toFixed(2)} × ${targetDias} / 7`, `${targetFull.toFixed(1)} uds`);
    p("Target Flex", `${velFlex.toFixed(2)} × ${targetDias} / 7`, `${targetFlex.toFixed(1)} uds`);
    p("Mandar a Full", `max(0, min(ceil(${targetFull.toFixed(1)} - ${stockFull}), ${stockBodega}))`, `${mandarFull} uds`);
    p("Pedir (venta)", `max(0, ceil((${targetFull.toFixed(1)} + ${targetFlex.toFixed(1)}) - (${stockFull} + ${stockBodega})))`, `${pedirVenta} uds`);
    p("Acción", `reglas de clasificación`, accion);

    ventaRows.push({
      skuVenta, nombre, velTotal, velFull, velFlex,
      stockFull, stockBodega, stockTotal,
      cobFull: Math.round(cobFull), cobBodega: Math.round(cobBodega), cobTotal: Math.round(cobTotal),
      mandarFull: sinStockProv.has(skuVenta) ? mandarFull : mandarFull,
      pedir: sinStockProv.has(skuVenta) ? 0 : pedirVenta,
      accion,
      margenFlex, margenFull, costoProducto, sinCosto,
      skuOrigenPrincipal, esCompartido, formatosCompartidos, otrosFormatos, stockBodegaFisico, sinMapeo,
      calcLog,
    });
    // Guardar info para asociar a SKU Origen después
    ventaInfoMap.set(skuVenta, { nombre, velTotal, stockFull });

    // Acumular demanda física por SKU Origen
    if (componentes.length > 0) {
      for (const c of componentes) {
        if (!demandaFisicaPorOrigen.has(c.skuOrigen)) {
          demandaFisicaPorOrigen.set(c.skuOrigen, { velFull: 0, velFlex: 0, velTotal: 0 });
          nombreOrigen.set(c.skuOrigen, getStore().products[c.skuOrigen]?.name || c.skuOrigen);
        }
        const d = demandaFisicaPorOrigen.get(c.skuOrigen)!;
        d.velFull += velFull * c.unidades;
        d.velFlex += velFlex * c.unidades;
        d.velTotal += velTotal * c.unidades;
        // Stock full equivalente en unidades físicas
        if (!stockFullPorOrigen.has(c.skuOrigen)) stockFullPorOrigen.set(c.skuOrigen, 0);
        stockFullPorOrigen.set(c.skuOrigen, stockFullPorOrigen.get(c.skuOrigen)! + stockFull * c.unidades);
      }
    } else {
      // SKU simple: usar SKU físico real
      const skuFisicoOrigen = getSkuFisicoPorSkuVenta(skuVenta) || skuVenta;
      if (!demandaFisicaPorOrigen.has(skuFisicoOrigen)) {
        demandaFisicaPorOrigen.set(skuFisicoOrigen, { velFull: 0, velFlex: 0, velTotal: 0 });
        nombreOrigen.set(skuFisicoOrigen, nombre);
      }
      const d = demandaFisicaPorOrigen.get(skuFisicoOrigen)!;
      d.velFull += velFull;
      d.velFlex += velFlex;
      d.velTotal += velTotal;
      if (!stockFullPorOrigen.has(skuFisicoOrigen)) stockFullPorOrigen.set(skuFisicoOrigen, 0);
      stockFullPorOrigen.set(skuFisicoOrigen, stockFullPorOrigen.get(skuFisicoOrigen)! + stockFull);
    }
  }

  // 5. Filas por SKU Origen (Nivel 2 — decisiones de compra y stock bodega)
  const store = getStore();
  const origenRows: SkuOrigenRow[] = [];
  const origenEntries = Array.from(demandaFisicaPorOrigen.entries());
  for (let _j = 0; _j < origenEntries.length; _j++) {
    const [skuOrigen, dem] = origenEntries[_j];
    const stockBodega = skuTotal(skuOrigen);
    const stockFullEquiv = stockFullPorOrigen.get(skuOrigen) || 0;
    const stockFisicoTotal = stockBodega + stockFullEquiv;
    const targetFisico = dem.velTotal * cobObjetivo / 7;
    // Pedido a proveedor: SIEMPRE a nivel SKU Origen (nunca sumando pedidos individuales de SKU Venta)
    const pedirProveedor = Math.max(0, Math.ceil(targetFisico - stockFisicoTotal));
    const coberturaFisicaDias = dem.velTotal > 0 ? (stockFisicoTotal / dem.velTotal) * 7 : 999;

    let accion: Accion;
    if (dem.velTotal === 0) accion = "SIN VENTA";
    else {
      if (stockBodega === 0 && stockFullEquiv === 0) accion = "AGOTADO PEDIR";
      else if (coberturaFisicaDias < puntoReorden) accion = "URGENTE";
      else if (coberturaFisicaDias < 30) accion = "PLANIFICAR";
      else if (coberturaFisicaDias <= cobMaxima) accion = "OK";
      else accion = "EXCESO";
    }

    // Construir lista de SKU Venta asociados
    const asociados = origenToVentasMap.get(skuOrigen) || [];
    const skusVentaAsociados = asociados.map(a => {
      const info = ventaInfoMap.get(a.skuVenta);
      return {
        skuVenta: a.skuVenta,
        unidades: a.unidades,
        nombre: info?.nombre || a.skuVenta,
        velSemanal: info?.velTotal || 0,
        stockFull: info?.stockFull || 0,
      };
    });

    origenRows.push({
      skuOrigen,
      nombre: nombreOrigen.get(skuOrigen) || skuOrigen,
      velTotalFisica: dem.velTotal,
      velFullFisica: dem.velFull,
      velFlexFisica: dem.velFlex,
      stockBodega,
      demandaFisicaTotal: dem.velTotal,
      targetFisico: Math.ceil(targetFisico),
      pedirProveedor: sinStockProv.has(skuOrigen) ? 0 : pedirProveedor,
      stockFullEquiv: Math.round(stockFullEquiv),
      coberturaFisicaDias: Math.round(coberturaFisicaDias),
      skusVentaAsociados,
      esCompartido: asociados.length > 1,
      accion,
      nombreProveedor: store.products[skuOrigen]?.prov || undefined,
    });
  }

  // 5.5. Validación cruzada de envío a Full: verificar que el total de uds físicas
  // que se quiere enviar (de todos los formatos de un mismo SKU Origen) no supere el stock de bodega.
  // Si supera, priorizar por urgencia de cobertura Full.
  const envioFisicoPorOrigen = new Map<string, { skuVenta: string; unidadesFisicas: number; cobFull: number }[]>();
  for (const vr of ventaRows) {
    if (vr.mandarFull <= 0) continue;
    const comps = getComponentesPorSkuVenta(vr.skuVenta);
    const efectivos = comps.length > 0 ? comps : [{ skuOrigen: vr.skuVenta, unidades: 1, skuVenta: vr.skuVenta, codigoMl: "" }];
    for (const c of efectivos) {
      if (!envioFisicoPorOrigen.has(c.skuOrigen)) envioFisicoPorOrigen.set(c.skuOrigen, []);
      envioFisicoPorOrigen.get(c.skuOrigen)!.push({
        skuVenta: vr.skuVenta,
        unidadesFisicas: vr.mandarFull * c.unidades,
        cobFull: vr.cobFull,
      });
    }
  }
  // Ajustar mandarFull cuando el stock no alcanza para todos los formatos
  for (const [skuOrigen, envios] of Array.from(envioFisicoPorOrigen.entries())) {
    const stockBod = skuTotal(skuOrigen);
    const totalFisico = envios.reduce((s, e) => s + e.unidadesFisicas, 0);
    if (totalFisico <= stockBod) continue;
    // Priorizar por menor cobertura Full (más urgente primero)
    envios.sort((a, b) => a.cobFull - b.cobFull);
    let restante = stockBod;
    for (const e of envios) {
      const asignado = Math.min(e.unidadesFisicas, restante);
      restante -= asignado;
      // Actualizar el mandarFull de la fila correspondiente
      const fila = ventaRows.find(r => r.skuVenta === e.skuVenta);
      if (fila) {
        const comps = getComponentesPorSkuVenta(e.skuVenta);
        const unidadesPack = comps.length > 0 ? comps.find(c => c.skuOrigen === skuOrigen)?.unidades || 1 : 1;
        fila.mandarFull = Math.floor(asignado / unidadesPack);
      }
    }
  }

  // 6. Cruce con datos de proveedor
  if (proveedorData && proveedorData.length > 0) {
    const provMap = new Map<string, ProveedorRaw>();
    for (const p of proveedorData) provMap.set(p.skuOrigen, p);

    for (const row of origenRows) {
      const prov = provMap.get(row.skuOrigen);
      if (!prov) {
        // SKU no está en la lista del proveedor → otro proveedor
        row.statusProveedor = "otro_proveedor";
        continue;
      }

      row.innerPack = prov.innerPack;
      row.costoProveedor = prov.precioNeto;
      row.stockProveedor = prov.stock;

      // Validación de costo: comparar con diccionario WMS
      const prodWMS = store.products[row.skuOrigen];
      if (prodWMS?.cost && prov.precioNeto > 0) {
        const diff = Math.abs(prov.precioNeto - prodWMS.cost) / prodWMS.cost;
        if (diff > 0.05) {
          row.alertaCosto = { costoWMS: prodWMS.cost, costoProveedor: prov.precioNeto };
        }
      }

      if (prov.stock <= 0) {
        // Sin stock en proveedor
        row.statusProveedor = "sin_stock";
        row.pedirReal = 0;
        row.bultos = 0;
        row.costoTotalLinea = 0;
        // Calcular días hasta agotamiento a velocidad actual
        if (row.velTotalFisica > 0) {
          const stockActual = row.stockBodega + row.stockFullEquiv;
          row.diasAgotamiento = Math.round((stockActual / row.velTotalFisica) * 7);
        }
      } else {
        // Con stock: calcular pedir real redondeado a inner pack
        row.statusProveedor = "ok";
        const necesita = row.pedirProveedor;
        // Si el proveedor tiene menos stock del que necesitamos, limitar
        const cantidadBase = Math.min(necesita, prov.stock);
        // Redondear al múltiplo de inner pack hacia arriba
        const ip = prov.innerPack;
        row.pedirReal = cantidadBase > 0 ? Math.ceil(cantidadBase / ip) * ip : 0;
        row.bultos = ip > 0 ? row.pedirReal / ip : 0;
        row.costoTotalLinea = row.pedirReal * prov.precioNeto;
      }
    }
  }

  return { ventaRows, origenRows };
}

/* ───── CSV Export ───── */
function exportCSV(headers: string[], rows: string[][], filename: string) {
  const bom = "\uFEFF";
  const csv = bom + [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ───── Componente principal ───── */
export default function AdminReposicion() {
  const [ordenes, setOrdenes] = useState<OrdenRaw[] | null>(() => {
    try {
      const saved = localStorage.getItem("banva_reposicion_ordenes");
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map((o: Record<string, unknown>) => ({ ...o, fecha: new Date(o.fecha as string) }));
      }
    } catch { /* ignore */ }
    return null;
  });
  const [velocidades, setVelocidades] = useState<VelocidadRaw[] | null>(() => {
    try {
      const saved = localStorage.getItem("banva_reposicion_velocidades");
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [showConfig, setShowConfig] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [filtroAccion, setFiltroAccion] = useState<Accion | "TODAS">("TODAS");
  const [sortCol, setSortCol] = useState<string>("accion");
  const [sortAsc, setSortAsc] = useState(true);
  const [sinStockProv, setSinStockProv] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("banva_reposicion_sin_stock");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [showEnvioFull, setShowEnvioFull] = useState(true);
  const [showPedidoProv, setShowPedidoProv] = useState(true);
  const [subTab, setSubTab] = useState<"resumen" | "envio" | "pedido">("resumen");
  const [expandedEnvio, setExpandedEnvio] = useState<Set<string>>(new Set());
  const [vistaOrigen, setVistaOrigen] = useState(false);
  const [expandedOrigenGroup, setExpandedOrigenGroup] = useState<Set<string>>(new Set());
  const [expandedOrigenRow, setExpandedOrigenRow] = useState<Set<string>>(new Set());
  const [fileNameOrdenes, setFileNameOrdenes] = useState(() => localStorage.getItem("banva_reposicion_fn_ordenes") || "");
  const [fileNameVelocidad, setFileNameVelocidad] = useState(() => localStorage.getItem("banva_reposicion_fn_velocidad") || "");
  const [proveedor, setProveedor] = useState<ProveedorRaw[] | null>(() => {
    try {
      const saved = localStorage.getItem("banva_reposicion_proveedor");
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const [fileNameProveedor, setFileNameProveedor] = useState(() => localStorage.getItem("banva_reposicion_fn_proveedor") || "");
  const [creandoPicking, setCreandoPicking] = useState(false);
  const [pickingCreado, setPickingCreado] = useState<string | null>(null);

  // ── Historial de órdenes ──
  const [historialInfo, setHistorialInfo] = useState<{ total: number; fecha_min: string | null; fecha_max: string | null; ultima_importacion: { fuente: string; ordenes_nuevas: number; created_at: string } | null } | null>(null);
  const [historialLoading, setHistorialLoading] = useState(false);
  const [pgLoading, setPgLoading] = useState(false);
  const [pgResult, setPgResult] = useState<{ nuevas: number; actualizadas: number; sinCambio: number; total: number } | null>(null);
  const [pgProgreso, setPgProgreso] = useState("");
  const [fuenteOrdenes, setFuenteOrdenes] = useState<"historial" | "api" | "archivo" | null>(null);
  const [showArchivoOrdenes, setShowArchivoOrdenes] = useState(false);
  const [pgRangoDesde, setPgRangoDesde] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 60);
    return d.toISOString().slice(0, 10);
  });
  const [pgRangoHasta, setPgRangoHasta] = useState(() => new Date().toISOString().slice(0, 10));

  // Modal detalle de cálculo
  const [detalleSkuVenta, setDetalleSkuVenta] = useState<string | null>(null);

  // Editable envio a full
  const [envioEditMode, setEnvioEditMode] = useState(false);
  const [envioEditable, setEnvioEditable] = useState<Map<string, number>>(new Map()); // skuVenta -> qty override
  const [envioRemoved, setEnvioRemoved] = useState<Set<string>>(new Set()); // skuVenta removed
  const [envioAdded, setEnvioAdded] = useState<{skuVenta:string;nombre:string;qty:number;tipo:EnvioTipo;componentes:{skuOrigen:string;nombreOrigen:string;unidadesPorPack:number}[]}[]>([]);
  const [addEnvioSearch, setAddEnvioSearch] = useState("");
  const [envioSaved, setEnvioSaved] = useState(false);

  // Persistir datos en localStorage
  useEffect(() => {
    localStorage.setItem("banva_reposicion_sin_stock", JSON.stringify(Array.from(sinStockProv)));
  }, [sinStockProv]);
  useEffect(() => {
    if (ordenes) localStorage.setItem("banva_reposicion_ordenes", JSON.stringify(ordenes));
    else localStorage.removeItem("banva_reposicion_ordenes");
  }, [ordenes]);
  useEffect(() => {
    if (velocidades) localStorage.setItem("banva_reposicion_velocidades", JSON.stringify(velocidades));
    else localStorage.removeItem("banva_reposicion_velocidades");
  }, [velocidades]);
  useEffect(() => {
    if (proveedor) localStorage.setItem("banva_reposicion_proveedor", JSON.stringify(proveedor));
    else localStorage.removeItem("banva_reposicion_proveedor");
  }, [proveedor]);
  useEffect(() => {
    localStorage.setItem("banva_reposicion_fn_ordenes", fileNameOrdenes);
    localStorage.setItem("banva_reposicion_fn_velocidad", fileNameVelocidad);
    localStorage.setItem("banva_reposicion_fn_proveedor", fileNameProveedor);
  }, [fileNameOrdenes, fileNameVelocidad, fileNameProveedor]);

  // ── Verificar historial al montar ──
  useEffect(() => {
    fetch("/api/orders/query").then(r => r.json()).then(info => {
      if (info && info.total > 0) setHistorialInfo(info);
    }).catch(() => {});
  }, []);

  // ── Funciones de carga de órdenes ──
  const persistirOrdenes = useCallback(async (ordenesArr: OrdenRaw[], fuente: string) => {
    try {
      const mapped = ordenesArr.map(o => ({
        order_id: `manual-${o.fecha.toISOString().slice(0,10)}-${o.sku.toUpperCase().trim()}`,
        fecha: o.fecha.toISOString(),
        sku_venta: o.sku.toUpperCase().trim(),
        cantidad: o.cantidad,
        canal: o.canal === "full" ? "Full" : "Flex",
        precio_unitario: o.subtotal > 0 && o.cantidad > 0 ? Math.round(o.subtotal / o.cantidad) : 0,
        subtotal: o.subtotal,
        comision_unitaria: o.comisionTotal > 0 && o.cantidad > 0 ? Math.round(o.comisionTotal / o.cantidad) : 0,
        comision_total: o.comisionTotal,
        costo_envio: o.costoEnvio,
        ingreso_envio: o.ingresoEnvio,
        total: o.subtotal - o.comisionTotal - o.costoEnvio + o.ingresoEnvio,
        logistic_type: o.canal === "full" ? "fulfillment" : "self_service",
        estado: "Pagada",
        fuente,
      }));
      await fetch("/api/orders/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordenes: mapped, fuente }),
      });
    } catch (err) {
      console.error("Error persistiendo órdenes:", err);
    }
  }, []);

  const cargarDesdeHistorial = useCallback(async () => {
    setHistorialLoading(true);
    try {
      const hace60d = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const res = await fetch(`/api/orders/query?from=${hace60d}&estado=Pagada&group_by=sku_canal`);
      const json = await res.json();
      if (!json.datos || json.datos.length === 0) {
        setHistorialLoading(false);
        return;
      }
      // También traer filas individuales para reconstruir OrdenRaw[]
      const sb = getSupabase();
      if (!sb) { setHistorialLoading(false); return; }
      const { data } = await sb.from("orders_history")
        .select("sku_venta, cantidad, fecha, canal, subtotal, comision_total, costo_envio, ingreso_envio")
        .eq("estado", "Pagada")
        .gte("fecha", hace60d)
        .order("fecha", { ascending: false })
        .limit(50000);
      if (data && data.length > 0) {
        const parsed: OrdenRaw[] = data.map((r: Record<string, unknown>) => ({
          sku: r.sku_venta as string,
          cantidad: r.cantidad as number,
          fecha: new Date(r.fecha as string),
          canal: ((r.canal as string) === "Full" ? "full" : "flex") as "full" | "flex",
          subtotal: (r.subtotal as number) || 0,
          comisionTotal: (r.comision_total as number) || 0,
          costoEnvio: (r.costo_envio as number) || 0,
          ingresoEnvio: (r.ingreso_envio as number) || 0,
        }));
        setOrdenes(parsed);
        setFuenteOrdenes("historial");
        setFileNameOrdenes(`Historial (${data.length} órdenes)`);
      }
    } catch (err) {
      console.error("Error cargando historial:", err);
    }
    setHistorialLoading(false);
  }, []);

  const cargarDesdeProfitGuard = useCallback(async () => {
    setPgLoading(true);
    setPgResult(null);
    setPgProgreso("Preparando...");

    try {
      // Dividir rango en chunks de 14 días
      const chunks: { from: string; to: string; label: string }[] = [];
      const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
      const start = new Date(pgRangoDesde + "T00:00:00");
      const end = new Date(pgRangoHasta + "T23:59:59");

      let cursor = new Date(start);
      while (cursor <= end) {
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + 13); // 14 días
        const actualEnd = chunkEnd > end ? end : chunkEnd;
        const fromStr = cursor.toISOString().slice(0, 10);
        const toStr = actualEnd.toISOString().slice(0, 10);
        const label = `${cursor.getDate()} ${meses[cursor.getMonth()]} – ${actualEnd.getDate()} ${meses[actualEnd.getMonth()]}`;
        chunks.push({ from: fromStr, to: toStr, label });
        cursor = new Date(actualEnd);
        cursor.setDate(cursor.getDate() + 1);
      }

      const totales = { nuevas: 0, actualizadas: 0, sinCambio: 0, total: 0 };

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setPgProgreso(`Cargando ${chunk.label} (${i + 1}/${chunks.length})...`);

        // 1. Fetch órdenes del chunk
        const res = await fetch(`/api/profitguard/orders?from=${chunk.from}&to=${chunk.to}`);
        const json = await res.json();
        if (!res.ok) {
          console.error(`[ProfitGuard] Error chunk ${chunk.label}:`, json.error);
          setPgProgreso(`Error en ${chunk.label}: ${json.error || "Error"}. Continuando...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        if (!json.ordenes || json.ordenes.length === 0) {
          console.log(`[ProfitGuard] Chunk ${chunk.label}: 0 órdenes`);
          continue;
        }

        // 2. Persistir inmediatamente
        setPgProgreso(`Guardando ${json.ordenes.length} órdenes de ${chunk.label} (${i + 1}/${chunks.length})...`);
        const importRes = await fetch("/api/orders/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ordenes: json.ordenes, fuente: "api" }),
        });
        const importJson = await importRes.json();
        if (importJson) {
          totales.nuevas += importJson.nuevas || 0;
          totales.actualizadas += importJson.actualizadas || 0;
          totales.sinCambio += importJson.sinCambio || 0;
          totales.total += importJson.total || 0;
        }
      }

      setPgResult(totales);
      setPgProgreso("");

      // Cargar desde historial actualizado
      await cargarDesdeHistorial();
      setFuenteOrdenes("api");
      fetch("/api/orders/query").then(r => r.json()).then(info => {
        if (info && info.total > 0) setHistorialInfo(info);
      }).catch(() => {});
    } catch (err) {
      console.error("Error ProfitGuard:", err);
      alert("Error de conexión con ProfitGuard");
      setPgProgreso("");
    }
    setPgLoading(false);
  }, [pgRangoDesde, pgRangoHasta, cargarDesdeHistorial]);

  // Pre-cargar ajustes de envío a Full si no hay edición guardada
  useEffect(() => {
    if (localStorage.getItem("banva_envio_full_edit")) return;
    const ajustes: [string, number][] = [
      ["TXPMMF15PJUNG", 10], ["TXSB144IRK15P", 12], ["TXV23QLRM30OV", 8],
      ["TXV23QLRM30GR", 12], ["TXMTFIL1315CL", 15], ["TXV23QLAT25BE", 0],
      ["BOLMATCUERCAF2", 15], ["BOLMATCUERNEG2", 10], ["LITAF400G4PGR", 36],
      ["LITAF400G4PNG", 16], ["RAPAC50X70AFA", 12], ["9788471510211", 11],
      ["ALPCMPRCL4060", 10], ["TXSB144ILD15P", 9], ["ALPCMPRBO6012", 10],
      ["TXTLILL4G4PRS", 24], ["TXSB144ISY15P", 10], ["TXSB144IFX15P", 10],
      ["TXV23QLAT15GR", 16], ["JSECBQ001P20Z", 4], ["JSAFAB421P20S", 4],
      ["TXTPBL20200SK", 2], ["TXTLILL4G4PBC", 16], ["TXPMMF15PBALL", 0],
      ["TXTSQLBC20PTQ", 0], ["TXV23QLAT20BC", 0], ["TXV23QLAT20NG", 8],
      ["BOLMATCUERNEGX4", 12], ["JSAFAB416P20W", 8], ["TXV23QLRM20BC", 13],
      ["TEXCCWTILL15P", 18], ["TXV23QLRM30CL", 0], ["TXV24QLBRVE15", 0],
      ["TXV24QLBRCN15", 7], ["JSAFAB417P20W", 4],
    ];
    const removed = ajustes.filter(([, q]) => q === 0).map(([s]) => s);
    const editable = ajustes.filter(([, q]) => q > 0);
    const added = [{ skuVenta: "LICAAFVIS5746", nombre: "Almohada Visco Cannon (pack)", qty: 2, tipo: "simple" as EnvioTipo, componentes: [{ skuOrigen: "LICAAFVIS5746", nombreOrigen: "Almohada Visco Cannon (pack)", unidadesPorPack: 1 }] }];
    localStorage.setItem("banva_envio_full_edit", JSON.stringify({ editable, removed, added, timestamp: new Date().toISOString() }));
  }, []);

  const toggleSinStock = useCallback((sku: string) => {
    setSinStockProv(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }, []);

  // Parsear archivo de órdenes y persistir
  const handleOrdenes = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameOrdenes(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      const parsed = parseOrdenes(wb);
      setOrdenes(parsed);
      setFuenteOrdenes("archivo");
      // Persistir en background
      if (parsed.length > 0) {
        persistirOrdenes(parsed, "manual").then(() => {
          fetch("/api/orders/query").then(r => r.json()).then(info => {
            if (info && info.total > 0) setHistorialInfo(info);
          }).catch(() => {});
        });
      }
    };
    reader.readAsArrayBuffer(file);
  }, [persistirOrdenes]);

  // Parsear archivo de velocidad
  const handleVelocidad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameVelocidad(file.name);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      const parsed = parseVelocidad(wb);
      setVelocidades(parsed);

      // Persistir stock Full en stock_full_cache para que intelligence lo lea server-side
      // ProfitGuard NO sobreescribe cantidad si ML sync la actualizó en las últimas 24h
      const sb = getSupabase();
      if (sb && parsed.length > 0) {
        const skus = parsed.map(v => v.skuVenta.toUpperCase().trim());
        // Leer filas existentes para determinar cuáles tienen fuente ml_sync reciente
        const { data: existing } = await sb
          .from("stock_full_cache")
          .select("sku_venta, fuente, updated_at")
          .in("sku_venta", skus);

        const mlRecent = new Set<string>();
        const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        for (const row of (existing || [])) {
          if (row.fuente === "ml_sync" && row.updated_at > hace24h) {
            mlRecent.add(row.sku_venta);
          }
        }

        // Separar en dos grupos: los que ML ya actualizó (solo escribir vel_promedio/nombre)
        // y los que no (escribir todo incluyendo cantidad como fallback)
        const rowsPartial: Array<{ sku_venta: string; nombre: string; vel_promedio: number; updated_at: string }> = [];
        const rowsFull: Array<{ sku_venta: string; cantidad: number; nombre: string; vel_promedio: number; fuente: string; updated_at: string }> = [];
        const now = new Date().toISOString();

        for (const v of parsed) {
          const sku = v.skuVenta.toUpperCase().trim();
          if (mlRecent.has(sku)) {
            rowsPartial.push({ sku_venta: sku, nombre: v.nombre, vel_promedio: v.promedioSemanal, updated_at: now });
          } else {
            rowsFull.push({ sku_venta: sku, cantidad: v.stockFull, nombre: v.nombre, vel_promedio: v.promedioSemanal, fuente: "profitguard", updated_at: now });
          }
        }

        // Upsert filas completas (SKUs sin ML sync reciente)
        for (let i = 0; i < rowsFull.length; i += 500) {
          await sb.from("stock_full_cache").upsert(rowsFull.slice(i, i + 500), { onConflict: "sku_venta" });
        }
        // Update parcial: solo vel_promedio y nombre para SKUs con ML sync reciente
        for (const row of rowsPartial) {
          await sb.from("stock_full_cache")
            .update({ nombre: row.nombre, vel_promedio: row.vel_promedio })
            .eq("sku_venta", row.sku_venta);
        }

        console.log(`[AdminReposicion] stock_full_cache actualizado: ${rowsFull.length} completos, ${rowsPartial.length} parciales (ML sync reciente)`);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Estado para resultado de importación proveedor
  const [proveedorImportResult, setProveedorImportResult] = useState<string | null>(null);

  // Parsear archivo de proveedor y persistir en DB
  const handleProveedor = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameProveedor(file.name);
    setProveedorImportResult(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      const provData = parseProveedor(wb);
      setProveedor(provData);

      const sb = getSupabase();
      if (!sb || provData.length === 0) return;

      const store = getStore();

      // Detectar nombre proveedor del primer producto con match en diccionario
      let proveedorNombre = "Proveedor";
      for (const p of provData) {
        const prod = store.products[p.skuOrigen] || store.products[p.skuOrigen.toUpperCase()];
        if (prod?.prov) { proveedorNombre = prod.prov; break; }
      }

      // 1. Fetch existing catálogo para detectar SKUs nuevos
      const existentes = await fetchProveedorCatalogo(proveedorNombre);
      const existenteSet = new Set(existentes.map(e => e.sku_origen.toUpperCase()));

      // 2. Upsert masivo a proveedor_catalogo
      const catalogoRows = provData
        .filter(p => p.skuOrigen && p.skuOrigen.trim().length > 0)
        .map(p => ({
          proveedor: proveedorNombre,
          sku_origen: p.skuOrigen.toUpperCase().trim(),
          nombre: (p.nombre || "").substring(0, 500) || null,
          inner_pack: Number(p.innerPack) || 1,
          precio_neto: Number(p.precioNeto) || 0,
          stock_disponible: Number(p.stock) ?? -1,
        }));
      console.log(`[importProveedor] ${catalogoRows.length} filas a upsert (de ${provData.length} parseadas)`);
      await upsertProveedorCatalogo(catalogoRows);

      // 3. Actualizar inner_pack en productos y detectar cambios de precio
      const costosChanged: { sku_origen: string; costo_anterior: number; costo_nuevo: number; diferencia_pct: number }[] = [];

      for (let i = 0; i < provData.length; i += 500) {
        const batch = provData.slice(i, i + 500);
        for (const p of batch) {
          const skuUp = p.skuOrigen.toUpperCase().trim();
          const prod = store.products[skuUp];
          // Actualizar inner_pack si cambió
          if (p.innerPack > 1) {
            await sb.from("productos").update({ inner_pack: p.innerPack }).eq("sku", skuUp);
            if (prod) prod.innerPack = p.innerPack;
          }
          // Detectar cambio de precio > 5%
          if (prod && prod.cost > 0 && p.precioNeto > 0) {
            const diffPct = Math.abs((p.precioNeto - prod.cost) / prod.cost) * 100;
            if (diffPct > 5) {
              costosChanged.push({
                sku_origen: skuUp,
                costo_anterior: prod.cost,
                costo_nuevo: p.precioNeto,
                diferencia_pct: Math.round(diffPct * 10) / 10,
              });
            }
          }
        }
      }

      // 4. Registrar cambios de precio en costos_historial
      if (costosChanged.length > 0) {
        await insertCostosHistorial(costosChanged.map(c => ({
          sku_origen: c.sku_origen,
          costo_anterior: c.costo_anterior,
          costo_nuevo: c.costo_nuevo,
          diferencia_pct: c.diferencia_pct,
          fuente: "lista_proveedor",
        })));
      }

      // 5. Calcular conteos para proveedor_imports
      const skusTotal = provData.length;
      const skusConStock = provData.filter(p => p.stock > 0).length;
      const skusSinStock = skusTotal - skusConStock;
      const skusNuevos = provData.filter(p => !existenteSet.has(p.skuOrigen.toUpperCase())).length;

      await insertProveedorImport({
        proveedor: proveedorNombre,
        archivo_nombre: file.name,
        skus_total: skusTotal,
        skus_con_stock: skusConStock,
        skus_sin_stock: skusSinStock,
        skus_nuevos: skusNuevos,
      });

      // 6. Mostrar resultado
      const msg = `${skusTotal} productos — ${skusConStock} con stock, ${skusSinStock} sin stock${skusNuevos > 0 ? `, ${skusNuevos} nuevos` : ""}${costosChanged.length > 0 ? `, ${costosChanged.length} precios cambiaron` : ""}`;
      setProveedorImportResult(msg);

      // 7. Disparar recálculo de inteligencia
      try { await fetch("/api/intelligence/recalcular", { method: "POST" }); } catch { /* silenciar */ }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Calcular
  const resultado = useMemo(() => {
    if (!velocidades) return null;
    return calcularReposicion(ordenes || [], velocidades, config, sinStockProv, proveedor || undefined);
  }, [ordenes, velocidades, config, sinStockProv, proveedor]);

  // Filtrar y ordenar filas SKU Venta
  const filasVenta = useMemo(() => {
    if (!resultado) return [];
    let rows = resultado.ventaRows.filter(r => r.velTotal > 0 || r.accion !== "SIN VENTA");
    if (busqueda) {
      const q = busqueda.toLowerCase();
      rows = rows.filter(r => r.skuVenta.toLowerCase().includes(q) || r.nombre.toLowerCase().includes(q));
    }
    if (filtroAccion !== "TODAS") rows = rows.filter(r => r.accion === filtroAccion);
    rows.sort((a, b) => {
      if (sortCol === "accion") {
        const d = ACCION_ORDEN[a.accion] - ACCION_ORDEN[b.accion];
        if (d !== 0) return sortAsc ? d : -d;
        return b.velTotal - a.velTotal;
      }
      const va = (a as unknown as Record<string, unknown>)[sortCol];
      const vb = (b as unknown as Record<string, unknown>)[sortCol];
      if (typeof va === "number" && typeof vb === "number") return sortAsc ? va - vb : vb - va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return rows;
  }, [resultado, busqueda, filtroAccion, sortCol, sortAsc]);

  // Filtrar filas SKU Origen
  const filasOrigen = useMemo(() => {
    if (!resultado) return [];
    let rows = resultado.origenRows.filter(r => r.velTotalFisica > 0);
    if (busqueda) {
      const q = busqueda.toLowerCase();
      rows = rows.filter(r => r.skuOrigen.toLowerCase().includes(q) || r.nombre.toLowerCase().includes(q));
    }
    if (filtroAccion !== "TODAS") rows = rows.filter(r => r.accion === filtroAccion);
    rows.sort((a, b) => {
      if (sortCol === "accion") {
        const d = ACCION_ORDEN[a.accion] - ACCION_ORDEN[b.accion];
        if (d !== 0) return sortAsc ? d : -d;
        return b.velTotalFisica - a.velTotalFisica;
      }
      const va = (a as unknown as Record<string, unknown>)[sortCol];
      const vb = (b as unknown as Record<string, unknown>)[sortCol];
      if (typeof va === "number" && typeof vb === "number") return sortAsc ? va - vb : vb - va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return rows;
  }, [resultado, busqueda, filtroAccion, sortCol, sortAsc]);

  // KPIs
  const kpis = useMemo(() => {
    if (!resultado) return null;
    const vr = resultado.ventaRows;
    const or = resultado.origenRows;
    const agotados = vr.filter(r => r.velTotal > 0 && r.stockFull === 0 && r.velFull > 0).length;
    const urgentes = vr.filter(r => r.accion === "URGENTE").length;
    const totalMandarFull = vr.reduce((s, r) => s + r.mandarFull, 0);
    const totalPedir = or.reduce((s, r) => s + r.pedirProveedor, 0);
    const exceso = vr.filter(r => r.accion === "EXCESO").length;
    // SKUs urgentes (pedirProveedor > 0) que el proveedor no tiene stock
    const sinStockProvCount = or.filter(r => r.statusProveedor === "sin_stock" && r.pedirProveedor > 0).length;
    return { agotados, urgentes, totalMandarFull, totalPedir, exceso, sinStockProvCount };
  }, [resultado]);

  const toggleEnvioExpand = useCallback((sku: string) => {
    setExpandedEnvio(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }, []);

  // Detalle de envío a Full con redondeo inteligente de inner pack
  const envioDetalles = useMemo((): EnvioFullDetalle[] => {
    if (!resultado) return [];
    const store = getStore();
    // Mapa inner pack por SKU Origen: primero desde DB (persistido), luego override con archivo proveedor
    const ipMap = new Map<string, number>();
    // Fallback: usar inner_pack guardado en productos (persistido de uploads anteriores)
    for (const [sku, prod] of Object.entries(store.products)) {
      if (prod.innerPack && prod.innerPack > 1) {
        ipMap.set(sku, prod.innerPack);
      }
    }
    // Override con archivo proveedor si está cargado
    if (proveedor) {
      for (const p of proveedor) ipMap.set(p.skuOrigen, p.innerPack);
    }

    return resultado.ventaRows
      .filter(r => r.mandarFull > 0)
      .sort((a, b) => ACCION_ORDEN[a.accion] - ACCION_ORDEN[b.accion])
      .map(r => {
        const compsAll = getComponentesPorSkuVenta(r.skuVenta);
        const comps = compsAll.filter(c => c.tipoRelacion !== "alternativo");
        const alternativos = compsAll.filter(c => c.tipoRelacion === "alternativo");

        // Determinar tipo
        let tipo: EnvioTipo;
        if (comps.length === 0 || (comps.length === 1 && comps[0].unidades === 1)) {
          tipo = "simple";
        } else if (comps.length === 1 && comps[0].unidades > 1) {
          tipo = "pack";
        } else {
          tipo = "combo";
        }

        // Componentes efectivos
        const efectivos = comps.length > 0 ? comps : [{ skuOrigen: r.skuVenta, skuVenta: r.skuVenta, unidades: 1 }];

        // Redondeo inteligente de inner pack para envío a Full
        // Solo aplica a productos simples o al primer componente de un pack
        // La cantidad a enviar es a nivel SKU Venta (mandarFull), el inner pack es a nivel SKU Origen
        let mandarFullRedondeado = r.mandarFull;
        let redondeo: RedondeoInfo | null = null;

        // Para redondeo, necesitamos el inner pack del componente principal
        const compPrincipal = efectivos[0];
        const ipPrincipal = ipMap.get(compPrincipal.skuOrigen) ?? null;

        if (ipPrincipal && ipPrincipal > 1) {
          // Calcular unidades físicas del componente principal
          const udsFisicasOriginal = r.mandarFull * compPrincipal.unidades;

          if (udsFisicasOriginal % ipPrincipal !== 0) {
            // No es múltiplo del inner pack → aplicar redondeo inteligente
            const opcionAbajoFisicas = Math.floor(udsFisicasOriginal / ipPrincipal) * ipPrincipal;
            const opcionArribaFisicas = Math.ceil(udsFisicasOriginal / ipPrincipal) * ipPrincipal;

            // Convertir de vuelta a unidades de venta
            const opcionAbajo = compPrincipal.unidades > 0 ? Math.floor(opcionAbajoFisicas / compPrincipal.unidades) : opcionAbajoFisicas;
            const opcionArriba = compPrincipal.unidades > 0 ? Math.ceil(opcionArribaFisicas / compPrincipal.unidades) : opcionArribaFisicas;

            // Calcular cobertura Full con cada opción
            const cobAbajo = r.velFull > 0 ? ((r.stockFull + opcionAbajo) / r.velFull) * 7 : 999;
            const cobArriba = r.velFull > 0 ? ((r.stockFull + opcionArriba) / r.velFull) * 7 : 999;

            // Stock bodega disponible
            const stockBodPrincipal = skuPositions(compPrincipal.skuOrigen).reduce((s, p) => s + p.qty, 0);
            const udsFisicasArriba = opcionArriba * compPrincipal.unidades;

            // Decidir dirección de redondeo
            let direccion: "arriba" | "abajo";
            let razon: string;

            if (opcionAbajo === 0 && r.mandarFull > 0 && udsFisicasArriba <= stockBodPrincipal) {
              // Caso especial: redondear abajo = no enviar nada, pero el sistema calculó que hay que enviar
              // y hay stock suficiente → forzar arriba (enviar al menos 1 bulto completo)
              direccion = "arriba";
              razon = `Redondear abajo = 0 uds (no enviar nada). Enviar 1 bulto completo (${opcionArriba} uds). Cobertura Full: ${Math.round(cobArriba)}d.`;
            } else if (udsFisicasArriba > stockBodPrincipal) {
              // Stock insuficiente para redondear arriba → fuerza abajo
              direccion = "abajo";
              razon = `Stock bodega insuficiente para bulto completo (${stockBodPrincipal} uds disponibles). Enviar ${opcionAbajo} uds.`;
            } else if (cobArriba > config.cobMaxima && opcionAbajo > 0) {
              // Redondear arriba supera 60d de cobertura → abajo (solo si abajo > 0)
              direccion = "abajo";
              razon = `Con ${opcionArriba} uds Full queda en ${Math.round(cobArriba)}d (supera ${config.cobMaxima}d máximo). Enviar ${opcionAbajo} uds.`;
            } else if (cobAbajo < config.puntoReorden || opcionAbajo === 0) {
              // Redondear abajo deja < 14d o sería 0 → arriba obligatorio
              direccion = "arriba";
              razon = opcionAbajo === 0
                ? `Redondear abajo = 0 uds. Enviar 1 bulto completo (${opcionArriba} uds). Cobertura Full: ${Math.round(cobArriba)}d.`
                : `Con ${opcionAbajo} uds Full queda en ${Math.round(cobAbajo)}d (bajo mínimo ${config.puntoReorden}d). Con ${opcionArriba} queda en ${Math.round(cobArriba)}d.`;
            } else if ((cobArriba - cobAbajo) < 7) {
              // Diferencia < 7 días → abajo (poca relevancia)
              direccion = "abajo";
              razon = `Con ${opcionAbajo} uds Full queda en ${Math.round(cobAbajo)}d (suficiente). No conviene enviar de más.`;
            } else {
              // Default: arriba para mejor cobertura
              direccion = "arriba";
              razon = `Con ${opcionAbajo} uds Full queda en ${Math.round(cobAbajo)}d. Con ${opcionArriba} queda en ${Math.round(cobArriba)}d (mejor cobertura).`;
            }

            const cantidadFinal = direccion === "arriba" ? opcionArriba : opcionAbajo;
            const udsFisicasFinal = cantidadFinal * compPrincipal.unidades;

            redondeo = {
              original: r.mandarFull,
              redondeado: cantidadFinal,
              innerPack: ipPrincipal,
              direccion,
              opcionAbajo,
              opcionArriba,
              cobAbajo: Math.round(cobAbajo),
              cobArriba: Math.round(cobArriba),
              razon,
              stockBodegaDespues: stockBodPrincipal - udsFisicasFinal,
            };

            mandarFullRedondeado = cantidadFinal;
          }
        }

        const componentes: EnvioComponenteDetalle[] = efectivos.map(c => {
          const unidadesFisicas = mandarFullRedondeado * c.unidades;
          const ip = ipMap.get(c.skuOrigen) ?? null;
          const bultosCompletos = ip ? Math.floor(unidadesFisicas / ip) : 0;
          const sueltas = ip ? unidadesFisicas % ip : 0;
          const faltanParaBulto = ip && sueltas > 0 ? ip - sueltas : 0;
          const sueltasEnPacks = c.unidades > 0 ? Math.floor(sueltas / c.unidades) : 0;

          // Stock principal + alternativos
          const altSkus = comps.length > 0
            ? alternativos.filter(a => a.unidades === c.unidades).map(a => a.skuOrigen)
            : alternativos.map(a => a.skuOrigen);
          const posiciones = skuPositions(c.skuOrigen);
          let stockTotal = posiciones.reduce((s, p) => s + p.qty, 0);
          for (const altSku of altSkus) {
            stockTotal += skuPositions(altSku).reduce((s, p) => s + p.qty, 0);
          }
          const alcanza = stockTotal >= unidadesFisicas;
          const maxPacks = c.unidades > 0 ? Math.floor(stockTotal / c.unidades) : 0;

          return {
            skuOrigen: c.skuOrigen,
            nombreOrigen: store.products[c.skuOrigen]?.name || c.skuOrigen,
            unidadesPorPack: c.unidades,
            unidadesFisicas,
            innerPack: ip,
            bultosCompletos,
            sueltas,
            faltanParaBulto,
            sueltasEnPacks,
            posiciones,
            stockTotal,
            alcanza,
            maxPacks,
            alternativos: altSkus,
          };
        });

        const maxPacksGlobal = Math.min(...componentes.map(c => c.maxPacks));
        const todosAlcanzan = componentes.every(c => c.alcanza);

        let estado: EnvioEstado;
        if (!todosAlcanzan) estado = "insuficiente";
        else if (tipo === "simple") estado = "listo";
        else estado = "armar";

        return {
          skuVenta: r.skuVenta,
          nombre: r.nombre,
          mandarFull: mandarFullRedondeado,
          mandarFullOriginal: r.mandarFull,
          tipo,
          estado,
          componentes,
          maxPacksGlobal,
          accion: r.accion,
          stockFull: r.stockFull,
          cobFull: r.cobFull,
          velFull: r.velFull,
          redondeo,
        };
      });
  }, [resultado, proveedor, config]);

  // Alertas de stock compartido en envío a Full
  const alertasEnvioCompartido = useMemo(() => {
    if (!resultado) return new Map<string, { skuOrigen: string; totalFisico: number; stockBodega: number; formatos: { skuVenta: string; uds: number }[]; priorizado: string }>();
    const alertas = new Map<string, { skuOrigen: string; totalFisico: number; stockBodega: number; formatos: { skuVenta: string; uds: number }[]; priorizado: string }>();
    // Agrupar envíos por SKU Origen
    const enviosPorOrigen = new Map<string, { skuVenta: string; udsFisicas: number; cobFull: number }[]>();
    for (const d of envioDetalles) {
      for (const c of d.componentes) {
        if (!enviosPorOrigen.has(c.skuOrigen)) enviosPorOrigen.set(c.skuOrigen, []);
        enviosPorOrigen.get(c.skuOrigen)!.push({ skuVenta: d.skuVenta, udsFisicas: c.unidadesFisicas, cobFull: d.cobFull });
      }
    }
    for (const [skuOrigen, envios] of Array.from(enviosPorOrigen.entries())) {
      if (envios.length < 2) continue;
      const totalFisico = envios.reduce((s, e) => s + e.udsFisicas, 0);
      const stockBod = skuTotal(skuOrigen);
      if (totalFisico > stockBod) {
        const priorizado = envios.sort((a, b) => a.cobFull - b.cobFull)[0].skuVenta;
        for (const e of envios) {
          alertas.set(e.skuVenta, {
            skuOrigen,
            totalFisico,
            stockBodega: stockBod,
            formatos: envios.map(x => ({ skuVenta: x.skuVenta, uds: x.udsFisicas })),
            priorizado,
          });
        }
      }
    }
    return alertas;
  }, [envioDetalles, resultado]);

  // Agrupación visual: agrupar filasVenta por SKU Origen cuando hay compartidos
  const filasVentaAgrupadas = useMemo(() => {
    if (!filasVenta.length) return [];
    // Construir grupos: filas que comparten SKU Origen van juntas
    const grupos = new Map<string, SkuVentaRow[]>();
    const orden: string[] = [];
    for (const r of filasVenta) {
      const key = r.esCompartido ? r.skuOrigenPrincipal : `_solo_${r.skuVenta}`;
      if (!grupos.has(key)) { grupos.set(key, []); orden.push(key); }
      grupos.get(key)!.push(r);
    }
    return orden.map(key => ({
      key,
      esGrupo: key.startsWith("_solo_") ? false : (grupos.get(key)!.length > 1),
      skuOrigen: key.startsWith("_solo_") ? "" : key,
      filas: grupos.get(key)!,
    }));
  }, [filasVenta]);

  const toggleOrigenGroup = useCallback((key: string) => {
    setExpandedOrigenGroup(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleOrigenRow = useCallback((sku: string) => {
    setExpandedOrigenRow(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }, []);

  const handleSort = (col: string) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(col === "accion"); }
  };

  const thStyle = (col: string): React.CSSProperties => ({
    cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
    background: sortCol === col ? "var(--bg4)" : undefined,
  });

  const fmtNum = (n: number, dec = 1) => {
    if (n === 999) return "∞";
    return n % 1 === 0 ? String(n) : n.toFixed(dec);
  };

  const badge = (accion: Accion) => {
    const c = ACCION_COLOR[accion];
    return (
      <span style={{ display:"inline-block", padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:700, background:c.bg, color:c.color, border:`1px solid ${c.border}`, whiteSpace:"nowrap" }}>
        {accion}
      </span>
    );
  };

  // Export envío a Full (dos secciones)
  const exportEnvioFull = () => {
    if (!envioDetalles.length) return;

    // Sección 1 — Para declarar en ML
    const sec1Headers = ["SKU Venta", "Nombre", "Cantidad uds venta"];
    const sec1Rows = envioDetalles.map(d => [d.skuVenta, d.nombre, String(d.mandarFull)]);

    // Sección 2 — Para logística
    const sec2Headers = ["SKU Venta", "SKU Origen", "Nombre Origen", "Tipo", "Uds físicas", "Inner Pack", "Bultos completos", "Uds sueltas", "Posición bodega", "Acción"];
    const sec2Rows: string[][] = [];
    for (const d of envioDetalles) {
      for (const c of d.componentes) {
        const posStr = c.posiciones.map(p => `${p.label || p.pos}(${p.qty})`).join(", ") || "Sin stock";
        let accionStr = "Enviar tal cual";
        if (d.tipo === "pack") accionStr = `Armar pack de ${c.unidadesPorPack}`;
        else if (d.tipo === "combo") accionStr = `Armar combo`;
        sec2Rows.push([
          d.skuVenta, c.skuOrigen, c.nombreOrigen, d.tipo,
          String(c.unidadesFisicas),
          c.innerPack != null ? String(c.innerPack) : "",
          c.innerPack != null ? String(c.bultosCompletos) : "",
          c.innerPack != null ? String(c.sueltas) : "",
          posStr, accionStr,
        ]);
      }
    }

    // Combinar ambas secciones separadas por fila vacía
    const bom = "\uFEFF";
    const allLines = [
      "SECCIÓN 1 — DECLARAR EN ML",
      sec1Headers.join(";"),
      ...sec1Rows.map(r => r.join(";")),
      "", // fila vacía separadora
      "SECCIÓN 2 — INSTRUCCIONES LOGÍSTICA",
      sec2Headers.join(";"),
      ...sec2Rows.map(r => r.join(";")),
    ];
    const csv = bom + allLines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `envio_full_${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Export pedido proveedor
  const exportPedidoProv = () => {
    if (!resultado) return;
    const tieneProveedor = !!proveedor;
    const rows = resultado.origenRows.filter(r => r.pedirProveedor > 0 || (r.statusProveedor === "sin_stock" && r.velTotalFisica > 0)).sort((a, b) => b.pedirProveedor - a.pedirProveedor);

    if (tieneProveedor) {
      const headers = ["SKU Origen", "Nombre", "Uds a pedir", "Bultos", "Inner Pack", "Pedir Real", "Costo Unitario", "Costo Total Línea", "Stock Proveedor", "Estado"];
      const dataRows = rows.map(r => {
        const estado = r.statusProveedor === "sin_stock" ? "Sin stock" : r.statusProveedor === "otro_proveedor" ? (r.nombreProveedor || "Otro proveedor") : "OK";
        return [
          r.skuOrigen, r.nombre,
          String(r.pedirProveedor),
          String(r.bultos ?? ""),
          String(r.innerPack ?? ""),
          String(r.pedirReal ?? ""),
          String(r.costoProveedor ?? ""),
          String(r.costoTotalLinea ?? ""),
          String(r.stockProveedor ?? ""),
          estado,
        ];
      });
      // Fila de totales
      const totalUds = rows.reduce((s, r) => s + r.pedirProveedor, 0);
      const totalBultos = rows.reduce((s, r) => s + (r.bultos || 0), 0);
      const totalPedirReal = rows.reduce((s, r) => s + (r.pedirReal || 0), 0);
      const totalCosto = rows.reduce((s, r) => s + (r.costoTotalLinea || 0), 0);
      dataRows.push(["TOTAL", "", String(totalUds), String(totalBultos), "", String(totalPedirReal), "", String(totalCosto), "", ""]);
      exportCSV(headers, dataRows, `pedido_proveedor_${new Date().toISOString().slice(0,10)}.csv`);
    } else {
      exportCSV(
        ["SKU Origen", "Nombre", "Uds a pedir", "Stock Total", "Vel Semanal", "Cob Total (días)"],
        rows.map(r => {
          const cobTotal = r.velTotalFisica > 0 ? ((r.stockFullEquiv + r.stockBodega) / r.velTotalFisica) * 7 : 999;
          return [r.skuOrigen, r.nombre, String(r.pedirProveedor), String(r.stockBodega + r.stockFullEquiv), fmtNum(r.velTotalFisica), fmtNum(cobTotal)];
        }),
        `pedido_proveedor_${new Date().toISOString().slice(0,10)}.csv`,
      );
    }
  };

  // Export CSV con verificación de fórmulas
  const exportVerificacionCSV = () => {
    if (!resultado) return;
    const headers = [
      "SKU Venta", "Nombre", "Acción",
      "Vel PG (sem)", "Vel Órdenes Full (6sem÷6)", "Vel Órdenes Flex (6sem÷6)", "Vel Órdenes Total",
      "Vel Final (max PG vs Órd)", "%Full", "%Flex", "Vel Full", "Vel Flex",
      "Stock Full", "Stock Bodega", "Stock Total",
      "Cob Full (días)", "Cob Bodega (días)", "Cob Total (días)",
      "Margen Flex", "Margen Full", "Target días", "Target Full", "Target Flex",
      "Mandar a Full", "Pedir Proveedor",
    ];
    const rows = resultado.ventaRows.map(r => {
      const log = r.calcLog;
      const getVal = (label: string) => log?.pasos.find(p => p.label === label)?.value || "";
      return [
        r.skuVenta, r.nombre, r.accion,
        getVal("Vel ProfitGuard"), getVal("Vel Órdenes Full"), getVal("Vel Órdenes Flex"), getVal("Vel Órdenes Total"),
        getVal("Vel Total (final)"), getVal("% Full"), String((100 - parseFloat(getVal("% Full") || "0")).toFixed(1) + "%"),
        getVal("Vel Full"), getVal("Vel Flex"),
        String(r.stockFull), String(r.stockBodega), String(r.stockTotal),
        getVal("Cob Full (días)"), getVal("Cob Bodega (días)"), getVal("Cob Total (días)"),
        r.margenFlex !== null ? `$${r.margenFlex}` : "sin costo",
        r.margenFull !== null ? `$${r.margenFull}` : "sin costo",
        getVal("Target días"), getVal("Target Full"), getVal("Target Flex"),
        getVal("Mandar a Full"), getVal("Pedir (venta)"),
      ];
    });
    exportCSV(headers, rows, `verificacion_reposicion_${new Date().toISOString().slice(0, 10)}.csv`);
  };

  // ---- Editable envio helpers ----
  const enterEnvioEdit = () => {
    setEnvioEditMode(true);
    setEnvioEditable(new Map());
    setEnvioRemoved(new Set());
    setEnvioAdded([]);
    setAddEnvioSearch("");
    setPickingCreado(null);
    setEnvioSaved(false);
    // Intentar cargar edición guardada
    setTimeout(() => cargarEnvioEdit(), 0);
  };
  const exitEnvioEdit = () => {
    setEnvioEditMode(false);
    setEnvioEditable(new Map());
    setEnvioRemoved(new Set());
    setEnvioAdded([]);
    setEnvioSaved(false);
  };
  const guardarEnvioEdit = () => {
    const payload = {
      editable: Array.from(envioEditable.entries()),
      removed: Array.from(envioRemoved),
      added: envioAdded,
      timestamp: new Date().toISOString(),
    };
    localStorage.setItem("banva_envio_full_edit", JSON.stringify(payload));
    setEnvioSaved(true);
    setTimeout(() => setEnvioSaved(false), 2500);
  };
  const cargarEnvioEdit = () => {
    try {
      const raw = localStorage.getItem("banva_envio_full_edit");
      if (!raw) return false;
      const payload = JSON.parse(raw);
      if (payload.editable) setEnvioEditable(new Map(payload.editable));
      if (payload.removed) setEnvioRemoved(new Set(payload.removed));
      if (payload.added) setEnvioAdded(payload.added);
      return true;
    } catch { return false; }
  };
  const setEnvioQty = (skuVenta: string, qty: number) => {
    setEnvioEditable(prev => { const next = new Map(prev); next.set(skuVenta, Math.max(0, qty)); return next; });
  };
  const removeEnvioItem = (skuVenta: string) => {
    // Check if it's an added item
    const addedIdx = envioAdded.findIndex(a => a.skuVenta === skuVenta);
    if (addedIdx >= 0) {
      setEnvioAdded(prev => prev.filter((_, i) => i !== addedIdx));
    } else {
      setEnvioRemoved(prev => { const next = new Set(prev); next.add(skuVenta); return next; });
    }
    setEnvioEditable(prev => { const next = new Map(prev); next.delete(skuVenta); return next; });
  };
  const restoreEnvioItem = (skuVenta: string) => {
    setEnvioRemoved(prev => { const next = new Set(prev); next.delete(skuVenta); return next; });
  };
  const addEnvioItem = (skuVenta: string, nombre: string, comps: ComposicionVenta[]) => {
    if (envioAdded.some(a => a.skuVenta === skuVenta) || envioDetalles.some(d => d.skuVenta === skuVenta)) return;
    const efectivos = comps.length > 0 ? comps : [{ skuOrigen: skuVenta, skuVenta, unidades: 1, codigoMl: "" }];
    const tipo: EnvioTipo = comps.length === 0 || (comps.length === 1 && comps[0].unidades === 1) ? "simple" : comps.length === 1 ? "pack" : "combo";
    setEnvioAdded(prev => [...prev, {
      skuVenta, nombre, qty: 1, tipo,
      componentes: efectivos.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: getStore().products[c.skuOrigen]?.name || c.skuOrigen, unidadesPorPack: c.unidades })),
    }]);
    setAddEnvioSearch("");
  };
  const setAddedQty = (skuVenta: string, qty: number) => {
    setEnvioAdded(prev => prev.map(a => a.skuVenta === skuVenta ? { ...a, qty: Math.max(0, qty) } : a));
  };

  // Build final envio list combining original + edits + added - removed
  const envioFinal = useMemo(() => {
    const items: { skuVenta: string; nombre: string; mandarFull: number; tipo: EnvioTipo; componentes: { skuOrigen: string; nombreOrigen: string; unidadesPorPack: number; unidadesFisicas: number; alternativos?: string[] }[]; fromOriginal: boolean }[] = [];
    for (const d of envioDetalles) {
      if (envioRemoved.has(d.skuVenta)) continue;
      const qty = envioEditable.has(d.skuVenta) ? envioEditable.get(d.skuVenta)! : d.mandarFull;
      if (qty <= 0) continue;
      items.push({
        skuVenta: d.skuVenta, nombre: d.nombre, mandarFull: qty, tipo: d.tipo, fromOriginal: true,
        componentes: d.componentes.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: c.nombreOrigen, unidadesPorPack: c.unidadesPorPack, unidadesFisicas: qty * c.unidadesPorPack, alternativos: c.alternativos })),
      });
    }
    for (const a of envioAdded) {
      const qty = envioEditable.has(a.skuVenta) ? envioEditable.get(a.skuVenta)! : a.qty;
      if (qty <= 0) continue;
      items.push({
        skuVenta: a.skuVenta, nombre: a.nombre, mandarFull: qty, tipo: a.tipo, fromOriginal: false,
        componentes: a.componentes.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: c.nombreOrigen, unidadesPorPack: c.unidadesPorPack, unidadesFisicas: qty * c.unidadesPorPack })),
      });
    }
    return items;
  }, [envioDetalles, envioEditable, envioRemoved, envioAdded]);

  // Crear sesión de picking desde envío a Full
  const crearPickingEnvioFull = useCallback(async () => {
    const source = envioEditMode ? envioFinal : envioDetalles.map(d => ({
      skuVenta: d.skuVenta, nombre: d.nombre, mandarFull: d.mandarFull, tipo: d.tipo,
      componentes: d.componentes.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: c.nombreOrigen, unidadesPorPack: c.unidadesPorPack, unidadesFisicas: c.unidadesFisicas, alternativos: c.alternativos })),
    }));
    if (!source.length || creandoPicking) return;
    setCreandoPicking(true);
    setPickingCreado(null);

    try {
      const { lineas, errors } = buildPickingLineasFull(source);

      if (errors.length > 0) {
        const continuar = window.confirm(`Advertencias:\n${errors.join("\n")}\n\n¿Crear sesión de picking de todos modos?`);
        if (!continuar) { setCreandoPicking(false); return; }
      }

      const fecha = new Date().toISOString().slice(0, 10);
      const titulo = `Envío a Full — ${fecha}`;
      const id = await crearPickingSession(fecha, lineas, "envio_full", titulo);

      if (id) {
        setPickingCreado(id);
        if (envioEditMode) setEnvioEditMode(false);
      } else {
        alert("Error al crear la sesión de picking. Verificar que la tabla picking_sessions tenga las columnas 'tipo' y 'titulo' (ejecutar migración v10).");
      }
    } catch (err) {
      console.error("crearPickingEnvioFull error:", err);
      alert("Error inesperado al crear la sesión de picking.");
    } finally {
      setCreandoPicking(false);
    }
  }, [envioDetalles, envioFinal, envioEditMode, creandoPicking]);

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
        <h2 style={{ fontSize:20, fontWeight:700, margin:0 }}>Reposición</h2>
      </div>

      {/* Config colapsable */}
      <div className="card" style={{ marginBottom:16 }}>
        <button onClick={() => setShowConfig(!showConfig)} style={{ background:"none", border:"none", color:"var(--txt)", cursor:"pointer", display:"flex", alignItems:"center", gap:8, width:"100%", padding:0, fontSize:13, fontWeight:600 }}>
          <span style={{ transform: showConfig ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block" }}>▶</span>
          Configuración de parámetros
        </button>
        {showConfig && (
          <div style={{ display:"flex", gap:16, marginTop:12, flexWrap:"wrap" }}>
            <div>
              <label className="form-label">Cobertura objetivo (días)</label>
              <input type="number" className="form-input mono" value={config.cobObjetivo}
                onChange={e => setConfig({ ...config, cobObjetivo: Number(e.target.value) || 45 })}
                style={{ width:80 }} />
            </div>
            <div>
              <label className="form-label">Punto de reorden (días)</label>
              <input type="number" className="form-input mono" value={config.puntoReorden}
                onChange={e => setConfig({ ...config, puntoReorden: Number(e.target.value) || 14 })}
                style={{ width:80 }} />
            </div>
            <div>
              <label className="form-label">Cobertura máxima (días)</label>
              <input type="number" className="form-input mono" value={config.cobMaxima}
                onChange={e => setConfig({ ...config, cobMaxima: Number(e.target.value) || 60 })}
                style={{ width:80 }} />
            </div>
          </div>
        )}
      </div>

      {/* Upload files */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:20 }}>
        <div className="card" style={{ padding:16 }}>
          <div style={{ fontSize:24, marginBottom:6, textAlign:"center" }}>📋</div>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:4, textAlign:"center" }}>Órdenes de Venta</div>

          {/* Opción 1: Historial guardado */}
          {historialInfo && historialInfo.total > 0 && (
            <div style={{ background:"var(--bg3)", borderRadius:10, padding:10, marginBottom:8, border:"1px solid var(--bg4)" }}>
              <div style={{ fontSize:11, color:"var(--txt2)", marginBottom:4 }}>
                Historial: <span className="mono" style={{ color:"var(--cyan)" }}>{historialInfo.total.toLocaleString()}</span> órdenes
                {historialInfo.fecha_min && historialInfo.fecha_max && (
                  <span> ({new Date(historialInfo.fecha_min).toLocaleDateString("es-CL", { month:"short" })} – {new Date(historialInfo.fecha_max).toLocaleDateString("es-CL", { month:"short", year:"numeric" })})</span>
                )}
              </div>
              {historialInfo.ultima_importacion && (
                <div style={{ fontSize:10, color:"var(--txt3)", marginBottom:6 }}>
                  Última: {(() => {
                    const h = Math.round((Date.now() - new Date(historialInfo.ultima_importacion.created_at).getTime()) / 3600000);
                    return h < 1 ? "hace menos de 1 hora" : `hace ${h}h`;
                  })()} ({historialInfo.ultima_importacion.fuente})
                  {historialInfo.ultima_importacion.ordenes_nuevas > 0 && ` — ${historialInfo.ultima_importacion.ordenes_nuevas} nuevas`}
                </div>
              )}
              <button onClick={cargarDesdeHistorial} disabled={historialLoading}
                style={{ width:"100%", padding:"6px 0", borderRadius:6, background:"var(--cyanBg)", border:"1px solid var(--cyanBd)", color:"var(--cyan)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                {historialLoading ? "Cargando..." : "Usar historial guardado"}
              </button>
            </div>
          )}

          {/* Opción 2: ProfitGuard API */}
          <div style={{ background:"var(--bg3)", borderRadius:10, padding:10, marginBottom:8, border:"1px solid var(--bg4)" }}>
            <div style={{ fontSize:11, color:"var(--txt2)", marginBottom:4 }}>Actualizar desde ProfitGuard</div>
            <div style={{ display:"flex", gap:4, marginBottom:6 }}>
              <input type="date" className="form-input mono" value={pgRangoDesde} onChange={e => setPgRangoDesde(e.target.value)}
                style={{ flex:1, fontSize:10, padding:"3px 4px" }} />
              <input type="date" className="form-input mono" value={pgRangoHasta} onChange={e => setPgRangoHasta(e.target.value)}
                style={{ flex:1, fontSize:10, padding:"3px 4px" }} />
            </div>
            <button onClick={cargarDesdeProfitGuard} disabled={pgLoading}
              style={{ width:"100%", padding:"6px 0", borderRadius:6, background:"var(--blueBg)", border:"1px solid var(--blueBd)", color:"var(--blue)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
              {pgLoading ? "Consultando API..." : "Cargar desde ProfitGuard"}
            </button>
            {pgProgreso && (
              <div style={{ marginTop:4, fontSize:10, color:"var(--cyan)" }}>
                {pgProgreso}
              </div>
            )}
            {pgResult && (
              <div style={{ marginTop:4, fontSize:10, color:"var(--green)" }}>
                {pgResult.total.toLocaleString()} órdenes — {pgResult.nuevas} nuevas, {pgResult.actualizadas} actualizadas, {pgResult.sinCambio} sin cambio
              </div>
            )}
          </div>

          {/* Opción 3: Subir archivo (colapsado) */}
          <div style={{ textAlign:"center" }}>
            {!showArchivoOrdenes ? (
              <button onClick={() => setShowArchivoOrdenes(true)}
                style={{ background:"none", border:"none", color:"var(--txt3)", fontSize:10, cursor:"pointer", textDecoration:"underline" }}>
                Subir archivo manualmente
              </button>
            ) : (
              <>
                <label style={{ display:"inline-block", padding:"6px 16px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", cursor:"pointer", fontSize:11, fontWeight:600, color:"var(--cyan)" }}>
                  {fileNameOrdenes || "Seleccionar archivo"}
                  <input type="file" accept=".xlsx,.xls,.csv" onChange={handleOrdenes} style={{ display:"none" }} />
                </label>
              </>
            )}
          </div>

          {/* Estado actual */}
          {ordenes && (
            <div style={{ marginTop:6, fontSize:11, color:"var(--green)", textAlign:"center" }}>
              {ordenes.length.toLocaleString()} órdenes cargadas
              {fuenteOrdenes && <span style={{ color:"var(--txt3)" }}> ({fuenteOrdenes})</span>}
            </div>
          )}
        </div>
        <div className="card" style={{ textAlign:"center", padding:20 }}>
          <div style={{ fontSize:24, marginBottom:8 }}>📊</div>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Velocidad y Stock Full</div>
          <div style={{ fontSize:11, color:"var(--txt3)", marginBottom:12 }}>Export ProfitGuard — Velocidad</div>
          <label style={{ display:"inline-block", padding:"8px 20px", borderRadius:8, background:"var(--bg3)", border:"1px solid var(--bg4)", cursor:"pointer", fontSize:12, fontWeight:600, color:"var(--cyan)" }}>
            {fileNameVelocidad || "Seleccionar archivo"}
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleVelocidad} style={{ display:"none" }} />
          </label>
          {velocidades && <div style={{ marginTop:8, fontSize:11, color:"var(--green)" }}>{velocidades.length} SKUs cargados</div>}
        </div>
        <div className="card" style={{ textAlign:"center", padding:20 }}>
          <div style={{ fontSize:24, marginBottom:8 }}>🏭</div>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Lista de Precios Proveedor</div>
          <div style={{ fontSize:11, color:"var(--txt3)", marginBottom:12 }}>Idetex — Stock y precios</div>
          <label style={{ display:"inline-block", padding:"8px 20px", borderRadius:8, background:"var(--bg3)", border:"1px solid var(--bg4)", cursor:"pointer", fontSize:12, fontWeight:600, color:"var(--cyan)" }}>
            {fileNameProveedor || "Seleccionar archivo"}
            <input type="file" accept=".xlsx,.xls" onChange={handleProveedor} style={{ display:"none" }} />
          </label>
          {proveedor && <div style={{ marginTop:8, fontSize:11, color:"var(--green)" }}>{proveedor.length} productos cargados</div>}
          {proveedorImportResult && <div style={{ marginTop:6, fontSize:10, color:"var(--cyan)", lineHeight:1.4 }}>{proveedorImportResult}</div>}
        </div>
      </div>

      {!resultado && (
        <div className="card" style={{ textAlign:"center", padding:40, color:"var(--txt3)" }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📦</div>
          <div style={{ fontSize:14, fontWeight:600 }}>Sube al menos el archivo de Velocidad y Stock para comenzar</div>
          <div style={{ fontSize:12, marginTop:4 }}>El archivo de Órdenes es opcional pero mejora la precisión del desglose por canal</div>
        </div>
      )}

      {resultado && kpis && (
        <>
          {/* KPIs */}
          <div className="admin-kpi-grid" style={{ marginBottom:20 }}>
            <div className="kpi" style={{ borderLeft:"3px solid var(--txt3)" }}>
              <div className="kpi-val mono" style={{ color:"var(--txt)" }}>{kpis.agotados}</div>
              <div className="kpi-label">Agotados en Full</div>
            </div>
            <div className="kpi" style={{ borderLeft:"3px solid var(--red)" }}>
              <div className="kpi-val mono" style={{ color:"var(--red)" }}>{kpis.urgentes}</div>
              <div className="kpi-label">Urgentes (&lt;{config.puntoReorden}d)</div>
            </div>
            <div className="kpi" style={{ borderLeft:"3px solid var(--blue)" }}>
              <div className="kpi-val mono" style={{ color:"var(--blue)" }}>{kpis.totalMandarFull.toLocaleString()}</div>
              <div className="kpi-label">Uds → Full</div>
            </div>
            <div className="kpi" style={{ borderLeft:"3px solid var(--amber)" }}>
              <div className="kpi-val mono" style={{ color:"var(--amber)" }}>{kpis.totalPedir.toLocaleString()}</div>
              <div className="kpi-label">Uds Pedir Prov.</div>
            </div>
            <div className="kpi" style={{ borderLeft:"3px solid var(--amber)" }}>
              <div className="kpi-val mono" style={{ color:"var(--amber)" }}>{kpis.exceso}</div>
              <div className="kpi-label">Exceso (&gt;{config.cobMaxima}d)</div>
            </div>
            {proveedor && (
              <div className="kpi" style={{ borderLeft:"3px solid var(--red)" }}>
                <div className="kpi-val mono" style={{ color:"var(--red)" }}>{kpis.sinStockProvCount}</div>
                <div className="kpi-label">Sin stock prov.</div>
              </div>
            )}
          </div>

          {/* Sub-tabs: Resumen / Envío a Full / Pedido a Proveedor */}
          <div style={{ display:"flex", gap:0, marginBottom:16, borderBottom:"2px solid var(--bg4)" }}>
            {([
              { key: "resumen" as const, label: "📊 Resumen", count: vistaOrigen ? filasOrigen.length : filasVenta.length },
              { key: "envio" as const, label: "📦 Envío a Full", count: envioEditMode ? envioFinal.length : envioDetalles.length },
              { key: "pedido" as const, label: "🛒 Pedido Proveedor", count: resultado.origenRows.filter(r => r.pedirProveedor > 0).length },
            ]).map(t => (
              <button key={t.key} onClick={() => setSubTab(t.key)}
                style={{
                  padding:"10px 20px", fontSize:13, fontWeight:600, cursor:"pointer",
                  background: subTab === t.key ? "var(--bg3)" : "transparent",
                  color: subTab === t.key ? "var(--cyan)" : "var(--txt3)",
                  border:"none", borderBottom: subTab === t.key ? "2px solid var(--cyan)" : "2px solid transparent",
                  marginBottom:-2, transition:"all 0.2s",
                }}>
                {t.label} <span className="mono" style={{ fontSize:11, marginLeft:4, opacity:0.7 }}>({t.count})</span>
              </button>
            ))}
          </div>

          {/* === TAB: Resumen === */}
          {subTab === "resumen" && <>
          {/* Filtros y vista */}
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:12, flexWrap:"wrap" }}>
            <input className="form-input" placeholder="Buscar SKU o nombre..." value={busqueda} onChange={e => setBusqueda(e.target.value)}
              style={{ flex:1, minWidth:200, maxWidth:300, fontSize:12 }} />
            <select className="form-input" value={filtroAccion} onChange={e => setFiltroAccion(e.target.value as Accion | "TODAS")}
              style={{ fontSize:12, width:"auto", minWidth:140 }}>
              <option value="TODAS">Todas las acciones</option>
              <option value="AGOTADO PEDIR">Agotado Pedir</option>
              <option value="URGENTE">Urgente</option>
              <option value="MANDAR A FULL">Mandar a Full</option>
              <option value="PLANIFICAR">Planificar</option>
              <option value="OK">OK</option>
              <option value="EXCESO">Exceso</option>
              <option value="SIN VENTA">Sin Venta</option>
            </select>
            <div style={{ display:"flex", borderRadius:8, overflow:"hidden", border:"1px solid var(--bg4)" }}>
              <button onClick={() => setVistaOrigen(false)} style={{ padding:"6px 14px", fontSize:11, fontWeight:600, background: !vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: !vistaOrigen ? "#000" : "var(--txt3)", border:"none", cursor:"pointer" }}>
                SKU Venta
              </button>
              <button onClick={() => setVistaOrigen(true)} style={{ padding:"6px 14px", fontSize:11, fontWeight:600, background: vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: vistaOrigen ? "#000" : "var(--txt3)", border:"none", cursor:"pointer" }}>
                SKU Origen
              </button>
            </div>
            <span style={{ fontSize:11, color:"var(--txt3)" }}>
              {vistaOrigen ? filasOrigen.length : filasVenta.length} SKUs
            </span>
            <button onClick={exportVerificacionCSV} title="Exportar CSV con fórmulas descompuestas para verificación" style={{ padding:"6px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--amber)", fontSize:11, fontWeight:600, cursor:"pointer", marginLeft:4 }}>
              CSV Verificación
            </button>
          </div>

          {/* Tabla SKU Venta — con agrupación visual por SKU Origen compartido */}
          {!vistaOrigen && (
            <div style={{ overflowX:"auto", marginBottom:20 }}>
              <table className="tbl" style={{ minWidth:1300 }}>
                <thead>
                  <tr>
                    <th style={thStyle("skuVenta")} onClick={() => handleSort("skuVenta")}>SKU</th>
                    <th style={thStyle("nombre")} onClick={() => handleSort("nombre")}>Nombre</th>
                    <th style={thStyle("velTotal")} onClick={() => handleSort("velTotal")}>Vel/sem</th>
                    <th style={thStyle("velFull")} onClick={() => handleSort("velFull")}>V.Full</th>
                    <th style={thStyle("velFlex")} onClick={() => handleSort("velFlex")}>V.Flex</th>
                    <th style={thStyle("stockFull")} onClick={() => handleSort("stockFull")}>St.Full</th>
                    <th style={thStyle("stockBodega")} onClick={() => handleSort("stockBodega")}>St.Bod (compartido)</th>
                    <th style={thStyle("stockTotal")} onClick={() => handleSort("stockTotal")}>St.Total</th>
                    <th style={thStyle("cobFull")} onClick={() => handleSort("cobFull")}>Cob Full</th>
                    <th style={thStyle("cobBodega")} onClick={() => handleSort("cobBodega")}>Cob Bod</th>
                    <th style={thStyle("cobTotal")} onClick={() => handleSort("cobTotal")}>Cob Total</th>
                    <th style={thStyle("margenFlex")} onClick={() => handleSort("margenFlex")}>M.Flex</th>
                    <th style={thStyle("margenFull")} onClick={() => handleSort("margenFull")}>M.Full</th>
                    <th style={thStyle("mandarFull")} onClick={() => handleSort("mandarFull")}>→Full</th>
                    <th style={thStyle("pedir")} onClick={() => handleSort("pedir")}>Pedir</th>
                    <th style={thStyle("accion")} onClick={() => handleSort("accion")}>Acción</th>
                    <th style={{ whiteSpace:"nowrap" }}>Sin Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {filasVentaAgrupadas.map(grupo => (
                    <React.Fragment key={grupo.key}>
                      {/* Fila cabecera de grupo si hay SKU Origen compartido */}
                      {grupo.esGrupo && (
                        <tr style={{ background:"var(--bg3)", cursor:"pointer" }} onClick={() => toggleOrigenGroup(grupo.key)}>
                          <td colSpan={17} style={{ padding:"6px 12px", fontSize:11, fontWeight:700, color:"var(--cyan)", borderLeft:"3px solid var(--cyan)" }}>
                            <span style={{ transform: expandedOrigenGroup.has(grupo.key) ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block", marginRight:6, fontSize:9 }}>▶</span>
                            SKU Origen: {grupo.skuOrigen} — {skuTotal(grupo.skuOrigen)} uds en bodega — Demanda total: {fmtNum(grupo.filas.reduce((s, r) => s + r.velTotal * (getComponentesPorSkuVenta(r.skuVenta).find(c => c.skuOrigen === grupo.skuOrigen)?.unidades || 1), 0))}/sem — {grupo.filas.length} formatos de venta
                          </td>
                        </tr>
                      )}
                      {grupo.filas.map(r => (
                        <tr key={r.skuVenta} style={grupo.esGrupo ? { borderLeft:"3px solid var(--cyan)" } : undefined}>
                          <td className="mono" style={{ fontSize:11, fontWeight:600 }}>
                            {r.esCompartido && <span title={`Comparte stock con: ${r.otrosFormatos.join(", ")}`} style={{ color:"var(--cyan)", marginRight:4, cursor:"help" }}>🔗</span>}
                            <span onClick={() => setDetalleSkuVenta(r.skuVenta)} style={{ cursor:"pointer", borderBottom:"1px dashed var(--txt3)" }} title="Ver detalle de cálculo">{r.skuVenta}</span>
                          </td>
                          <td style={{ maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:11 }} title={r.nombre}>{r.nombre}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velTotal)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velFull)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velFlex)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{r.stockFull}</td>
                          <td className="mono" style={{ textAlign:"right" }}>
                            {r.sinMapeo ? (
                              <span title={`Sin mapeo: "${r.skuVenta}" no se encontró en el diccionario. Sincroniza el diccionario Google Sheet.`} style={{ cursor:"help", color:"var(--amber)" }}>
                                ? <span style={{ fontSize:9 }}>sin mapeo</span>
                              </span>
                            ) : r.esCompartido ? (
                              <span title={`Stock físico de ${r.skuOrigenPrincipal}: ${r.stockBodegaFisico} uds en bodega. Compartido con: ${r.otrosFormatos.join(", ")}`} style={{ cursor:"help" }}>
                                {r.stockBodega} <span style={{ color:"var(--cyan)", fontSize:9 }}>({r.formatosCompartidos}f)</span>
                              </span>
                            ) : (
                              r.stockBodega
                            )}
                          </td>
                          <td className="mono" style={{ textAlign:"right", fontWeight:600 }}>{r.stockTotal}</td>
                          <td className="mono" style={{ textAlign:"right", color: r.cobFull < config.puntoReorden ? "var(--red)" : r.cobFull > config.cobMaxima ? "var(--amber)" : undefined }}>{fmtNum(r.cobFull, 0)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.cobBodega, 0)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.cobTotal, 0)}</td>
                          <td className="mono" style={{ textAlign:"right", fontSize:11, color: r.sinCosto ? "var(--txt3)" : r.margenFlex !== null ? (r.margenFlex >= 0 ? "var(--green)" : "var(--red)") : "var(--txt3)" }}>
                            {r.sinCosto ? <span title="Sin costo en diccionario">⚠️</span> : r.margenFlex !== null ? `$${r.margenFlex.toLocaleString()}` : "-"}
                          </td>
                          <td className="mono" style={{ textAlign:"right", fontSize:11, color: r.sinCosto ? "var(--txt3)" : r.margenFull !== null ? (r.margenFull >= 0 ? "var(--green)" : "var(--red)") : "var(--txt3)" }}>
                            {r.sinCosto ? <span title="Sin costo en diccionario">⚠️</span> : r.margenFull !== null ? `$${r.margenFull.toLocaleString()}` : "-"}
                          </td>
                          <td className="mono" style={{ textAlign:"right", fontWeight:600, color: r.mandarFull > 0 ? "var(--blue)" : undefined }}>
                            {r.mandarFull > 0 ? r.mandarFull : "-"}
                            {r.esCompartido && alertasEnvioCompartido.has(r.skuVenta) && (
                              <span title="Stock compartido insuficiente para todos los formatos" style={{ color:"var(--red)", marginLeft:2, fontSize:9 }}>⚠</span>
                            )}
                          </td>
                          <td className="mono" style={{ textAlign:"right", fontWeight:600, color: r.pedir > 0 ? "var(--amber)" : undefined }}>
                            {sinStockProv.has(r.skuVenta) ? <span title="Sin stock proveedor" style={{ color:"var(--red)" }}>⚠ 0</span> : r.pedir > 0 ? r.pedir : "-"}
                          </td>
                          <td>{badge(r.accion)}</td>
                          <td style={{ textAlign:"center" }}>
                            <input type="checkbox" checked={sinStockProv.has(r.skuVenta)} onChange={() => toggleSinStock(r.skuVenta)}
                              style={{ accentColor:"var(--red)", cursor:"pointer" }} />
                          </td>
                        </tr>
                      ))}
                      {/* Resumen del grupo expandido */}
                      {grupo.esGrupo && expandedOrigenGroup.has(grupo.key) && (() => {
                        const stockBod = skuTotal(grupo.skuOrigen);
                        const demTotal = grupo.filas.reduce((s, r) => s + r.velTotal * (getComponentesPorSkuVenta(r.skuVenta).find(c => c.skuOrigen === grupo.skuOrigen)?.unidades || 1), 0);
                        const stockFullTotal = grupo.filas.reduce((s, r) => s + r.stockFull * (getComponentesPorSkuVenta(r.skuVenta).find(c => c.skuOrigen === grupo.skuOrigen)?.unidades || 1), 0);
                        const cobFisica = demTotal > 0 ? ((stockBod + stockFullTotal) / demTotal) * 7 : 999;
                        const pedirOrigen = resultado?.origenRows.find(o => o.skuOrigen === grupo.skuOrigen);
                        return (
                          <tr style={{ background:"var(--bg)", borderLeft:"3px solid var(--cyan)" }}>
                            <td colSpan={17} style={{ padding:"8px 16px", fontSize:11 }}>
                              <div style={{ display:"flex", gap:24, flexWrap:"wrap", alignItems:"center" }}>
                                <span>Cobertura total (físico): <span className="mono" style={{ fontWeight:700 }}>{fmtNum(cobFisica, 0)} días</span></span>
                                <span>Stock Full (equiv): <span className="mono" style={{ fontWeight:600 }}>{Math.round(stockFullTotal)} uds</span></span>
                                {pedirOrigen && pedirOrigen.pedirProveedor > 0 && (
                                  <span>Pedir al proveedor: <span className="mono" style={{ fontWeight:700, color:"var(--amber)" }}>{pedirOrigen.pedirProveedor} uds físicas</span></span>
                                )}
                                <span style={{ padding:"2px 8px", borderRadius:4, fontSize:10, fontWeight:700,
                                  background: cobFisica < 14 ? "var(--redBg)" : cobFisica < 30 ? "var(--amberBg)" : "var(--greenBg)",
                                  color: cobFisica < 14 ? "var(--red)" : cobFisica < 30 ? "var(--amber)" : "var(--green)",
                                }}>
                                  {cobFisica < 14 ? "URGENTE" : cobFisica < 30 ? "PLANIFICAR" : "OK"}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })()}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Tabla SKU Origen — Nivel 2: decisiones de compra y stock bodega */}
          {vistaOrigen && (
            <div style={{ overflowX:"auto", marginBottom:20 }}>
              <table className="tbl" style={{ minWidth:1100 }}>
                <thead>
                  <tr>
                    <th style={thStyle("skuOrigen")} onClick={() => handleSort("skuOrigen")}>SKU Origen</th>
                    <th style={thStyle("nombre")} onClick={() => handleSort("nombre")}>Nombre</th>
                    <th style={thStyle("velTotalFisica")} onClick={() => handleSort("velTotalFisica")}>Dem. Física/sem</th>
                    <th style={thStyle("stockBodega")} onClick={() => handleSort("stockBodega")}>St.Bodega</th>
                    <th style={thStyle("stockFullEquiv")} onClick={() => handleSort("stockFullEquiv")}>St.Full (equiv)</th>
                    <th style={{ ...thStyle("stockTotal"), cursor:"default" }}>St.Total</th>
                    <th style={thStyle("coberturaFisicaDias")} onClick={() => handleSort("coberturaFisicaDias")}>Cob. (días)</th>
                    <th style={thStyle("targetFisico")} onClick={() => handleSort("targetFisico")}>Target</th>
                    <th style={thStyle("pedirProveedor")} onClick={() => handleSort("pedirProveedor")}>Pedir Prov.</th>
                    <th>Formatos</th>
                    <th style={thStyle("accion")} onClick={() => handleSort("accion")}>Acción</th>
                    <th>Sin Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {filasOrigen.map(r => {
                    const isExpanded = expandedOrigenRow.has(r.skuOrigen);
                    const stockTotal = r.stockBodega + r.stockFullEquiv;
                    return (
                      <React.Fragment key={r.skuOrigen}>
                        <tr>
                          <td className="mono" style={{ fontSize:11, fontWeight:600 }}>
                            {r.esCompartido && <span style={{ color:"var(--cyan)", marginRight:4 }}>🔗</span>}
                            {r.skuOrigen}
                          </td>
                          <td style={{ maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:11 }} title={r.nombre}>{r.nombre}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velTotalFisica)}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{r.stockBodega}</td>
                          <td className="mono" style={{ textAlign:"right" }}>{r.stockFullEquiv}</td>
                          <td className="mono" style={{ textAlign:"right", fontWeight:600 }}>{stockTotal}</td>
                          <td className="mono" style={{ textAlign:"right", color: r.coberturaFisicaDias < config.puntoReorden ? "var(--red)" : r.coberturaFisicaDias > config.cobMaxima ? "var(--amber)" : undefined }}>
                            {fmtNum(r.coberturaFisicaDias, 0)}
                          </td>
                          <td className="mono" style={{ textAlign:"right" }}>{r.targetFisico}</td>
                          <td className="mono" style={{ textAlign:"right", fontWeight:600, color: r.pedirProveedor > 0 ? "var(--amber)" : undefined }}>
                            {sinStockProv.has(r.skuOrigen) ? <span title="Sin stock proveedor" style={{ color:"var(--red)" }}>⚠ 0</span> : r.pedirProveedor > 0 ? r.pedirProveedor : "-"}
                          </td>
                          <td style={{ textAlign:"center" }}>
                            {r.skusVentaAsociados.length > 0 && (
                              <button onClick={() => toggleOrigenRow(r.skuOrigen)} style={{ background:"none", border:"1px solid var(--bg4)", borderRadius:4, padding:"2px 8px", fontSize:10, color:"var(--cyan)", cursor:"pointer", fontWeight:600 }}>
                                {r.skusVentaAsociados.length} {r.esCompartido ? "comp." : "fmt"}
                                <span style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block", marginLeft:4, fontSize:8 }}>▶</span>
                              </button>
                            )}
                          </td>
                          <td>{badge(r.accion)}</td>
                          <td style={{ textAlign:"center" }}>
                            <input type="checkbox" checked={sinStockProv.has(r.skuOrigen)} onChange={() => toggleSinStock(r.skuOrigen)}
                              style={{ accentColor:"var(--red)", cursor:"pointer" }} />
                          </td>
                        </tr>
                        {/* Formatos de venta asociados (expandible) */}
                        {isExpanded && (
                          <tr>
                            <td colSpan={12} style={{ padding:"8px 16px", background:"var(--bg)", borderLeft:"3px solid var(--cyan)" }}>
                              <div style={{ fontSize:11, fontWeight:600, marginBottom:6, color:"var(--cyan)" }}>Formatos de venta asociados:</div>
                              <table style={{ width:"100%", fontSize:11, borderCollapse:"collapse" }}>
                                <thead>
                                  <tr style={{ borderBottom:"1px solid var(--bg4)" }}>
                                    <th style={{ textAlign:"left", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>SKU Venta</th>
                                    <th style={{ textAlign:"left", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>Nombre</th>
                                    <th style={{ textAlign:"right", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>Uds/pack</th>
                                    <th style={{ textAlign:"right", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>Vel/sem</th>
                                    <th style={{ textAlign:"right", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>Dem. física/sem</th>
                                    <th style={{ textAlign:"right", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>St.Full</th>
                                    <th style={{ textAlign:"right", padding:"2px 8px", fontSize:10, color:"var(--txt3)" }}>St.Full (equiv uds)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.skusVentaAsociados.map(a => (
                                    <tr key={a.skuVenta} style={{ borderBottom:"1px solid var(--bg3)" }}>
                                      <td className="mono" style={{ padding:"2px 8px", fontWeight:600 }}>{a.skuVenta}</td>
                                      <td style={{ padding:"2px 8px", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.nombre}</td>
                                      <td className="mono" style={{ textAlign:"right", padding:"2px 8px" }}>{a.unidades}</td>
                                      <td className="mono" style={{ textAlign:"right", padding:"2px 8px" }}>{fmtNum(a.velSemanal)}</td>
                                      <td className="mono" style={{ textAlign:"right", padding:"2px 8px", fontWeight:600 }}>{fmtNum(a.velSemanal * a.unidades)}</td>
                                      <td className="mono" style={{ textAlign:"right", padding:"2px 8px" }}>{a.stockFull}</td>
                                      <td className="mono" style={{ textAlign:"right", padding:"2px 8px" }}>{a.stockFull * a.unidades}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          </>}

          {/* === TAB: Envío a Full === */}
          {subTab === "envio" && <>
          {/* Lista: Envío a Full */}
          <div className="card" style={{ marginBottom:16 }}>
            <button onClick={() => setShowEnvioFull(!showEnvioFull)} style={{ background:"none", border:"none", color:"var(--txt)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%", padding:0, fontSize:14, fontWeight:600 }}>
              <span>
                <span style={{ transform: showEnvioFull ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block", marginRight:8 }}>▶</span>
                📦 Envío a Full ({envioEditMode ? envioFinal.length : envioDetalles.length} SKUs, {(envioEditMode ? envioFinal.reduce((s, r) => s + r.mandarFull, 0) : envioDetalles.reduce((s, r) => s + r.mandarFull, 0)).toLocaleString()} uds)
                {envioEditMode && <span style={{ marginLeft:8, fontSize:11, color:"var(--amber)", fontWeight:700 }}>— Editando</span>}
              </span>
              <span style={{ display:"flex", gap:6 }} onClick={e => e.stopPropagation()}>
                {!envioEditMode ? (
                  <>
                    <button onClick={enterEnvioEdit} disabled={!envioDetalles.length} style={{ padding:"4px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--amber)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                      Editar envio
                    </button>
                    <button onClick={() => crearPickingEnvioFull()} disabled={creandoPicking || !envioDetalles.length} style={{ padding:"4px 12px", borderRadius:6, background: pickingCreado ? "var(--greenBg)" : "var(--bg3)", border:`1px solid ${pickingCreado ? "var(--greenBd)" : "var(--bg4)"}`, color: pickingCreado ? "var(--green)" : "var(--green)", fontSize:11, fontWeight:600, cursor: creandoPicking ? "wait" : "pointer", opacity: creandoPicking ? 0.5 : 1 }}>
                      {creandoPicking ? "Creando..." : pickingCreado ? "Picking creado" : "Crear picking"}
                    </button>
                    <button onClick={() => exportEnvioFull()} style={{ padding:"4px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--cyan)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                      CSV
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={exitEnvioEdit} style={{ padding:"4px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--txt3)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                      Cancelar
                    </button>
                    <button onClick={guardarEnvioEdit} style={{ padding:"4px 12px", borderRadius:6, background: envioSaved ? "var(--greenBg)" : "var(--bg3)", border:`1px solid ${envioSaved ? "var(--greenBd)" : "var(--cyanBd)"}`, color: envioSaved ? "var(--green)" : "var(--cyan)", fontSize:11, fontWeight:600, cursor:"pointer", transition:"all 0.3s" }}>
                      {envioSaved ? "Guardado!" : "Guardar"}
                    </button>
                    <button onClick={() => crearPickingEnvioFull()} disabled={creandoPicking || !envioFinal.length} style={{ padding:"4px 12px", borderRadius:6, background:"var(--green)", border:"1px solid var(--green)", color:"#fff", fontSize:11, fontWeight:700, cursor: creandoPicking ? "wait" : "pointer" }}>
                      {creandoPicking ? "Creando..." : `Crear picking (${envioFinal.length} SKUs)`}
                    </button>
                  </>
                )}
              </span>
            </button>
            {pickingCreado && (
              <div style={{ padding:"8px 14px", marginTop:8, background:"var(--greenBg)", border:"1px solid var(--greenBd)", borderRadius:8, fontSize:11, color:"var(--green)" }}>
                Sesión de picking creada exitosamente. Los operadores pueden verla en /operador/picking.
              </div>
            )}

            {/* ===== EDIT MODE: tabla interactiva ===== */}
            {showEnvioFull && envioEditMode && (
              <div style={{ marginTop:12 }}>
                <div style={{ overflowX:"auto" }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>SKU Venta</th>
                        <th>Nombre</th>
                        <th>Tipo</th>
                        <th style={{ textAlign:"right" }}>Inner Pack</th>
                        <th style={{ textAlign:"right" }}>Stock Full</th>
                        <th style={{ textAlign:"right" }}>Stock Bodega</th>
                        <th style={{ textAlign:"center" }}>Enviar</th>
                        <th style={{ textAlign:"right" }}>Queda Bodega</th>
                        <th>Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Original items (active) */}
                      {envioDetalles.filter(d => !envioRemoved.has(d.skuVenta)).map(d => {
                        const qty = envioEditable.has(d.skuVenta) ? envioEditable.get(d.skuVenta)! : d.mandarFull;
                        const stockBodega = d.componentes.length > 0 ? d.componentes[0].stockTotal : 0;
                        const udsPerPack = d.componentes.length > 0 ? d.componentes[0].unidadesPorPack : 1;
                        const quedaBodega = stockBodega - (qty * udsPerPack);
                        const tipoBadge = d.tipo === "simple" ? "Simple" : d.tipo === "pack" ? "Pack" : "Combo";
                        const tipoColor = d.tipo === "simple" ? "var(--txt3)" : d.tipo === "pack" ? "var(--cyan)" : "var(--amber)";
                        const changed = envioEditable.has(d.skuVenta) && envioEditable.get(d.skuVenta) !== d.mandarFull;
                        return (
                          <tr key={d.skuVenta} style={{ background: changed ? "var(--amberBg)" : "transparent" }}>
                            <td className="mono" style={{ fontSize:11, fontWeight:700 }}>{d.skuVenta}</td>
                            <td style={{ fontSize:11, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.nombre}</td>
                            <td><span style={{ fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:4, color:tipoColor }}>{tipoBadge}</span></td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11 }}>{d.componentes.length > 0 && d.componentes[0].innerPack !== null ? <span style={{ fontWeight:600 }}>{d.componentes[0].innerPack}</span> : <span style={{ color:"var(--txt3)" }}>—</span>}</td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11 }}>{d.stockFull}</td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11 }}>{stockBodega}{udsPerPack > 1 && <span style={{ fontSize:9, color:"var(--txt3)" }}> ({Math.floor(stockBodega / udsPerPack)}pk)</span>}</td>
                            <td style={{ textAlign:"center" }}>
                              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
                                <button onClick={() => setEnvioQty(d.skuVenta, qty - 1)} style={{ width:26, height:26, borderRadius:4, background:"var(--bg3)", border:"1px solid var(--bg4)", fontSize:14, fontWeight:700, cursor:"pointer", color:"var(--txt)" }}>−</button>
                                <input type="number" value={qty} onChange={e => setEnvioQty(d.skuVenta, parseInt(e.target.value) || 0)}
                                  style={{ width:55, textAlign:"center", fontSize:13, fontWeight:700, padding:"3px 4px", borderRadius:4, border: changed ? "2px solid var(--amber)" : "1px solid var(--bg4)", background:"var(--bg)", color:"var(--txt1)" }} />
                                <button onClick={() => setEnvioQty(d.skuVenta, qty + 1)} style={{ width:26, height:26, borderRadius:4, background:"var(--bg3)", border:"1px solid var(--bg4)", fontSize:14, fontWeight:700, cursor:"pointer", color:"var(--txt)" }}>+</button>
                              </div>
                              {changed && <div style={{ fontSize:9, color:"var(--txt3)", marginTop:2 }}>orig: {d.mandarFull}</div>}
                            </td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11, fontWeight:700, color: quedaBodega < 0 ? "var(--red)" : quedaBodega === 0 ? "var(--amber)" : "var(--green)" }}>
                              {quedaBodega}{udsPerPack > 1 && <span style={{ fontSize:9, color:"var(--txt3)" }}> ({Math.floor(quedaBodega / udsPerPack)}pk)</span>}
                            </td>
                            <td>
                              <div style={{ display:"flex", gap:4 }}>
                                {changed && <button onClick={() => { const m = new Map(envioEditable); m.delete(d.skuVenta); setEnvioEditable(m); }} title="Restaurar original" style={{ padding:"3px 6px", borderRadius:4, background:"var(--bg3)", color:"var(--cyan)", fontSize:10, fontWeight:700, border:"1px solid var(--bg4)", cursor:"pointer" }}>↺</button>}
                                <button onClick={() => removeEnvioItem(d.skuVenta)} title="Quitar del envio" style={{ padding:"3px 6px", borderRadius:4, background:"var(--redBg)", color:"var(--red)", fontSize:10, fontWeight:700, border:"1px solid var(--redBd)", cursor:"pointer" }}>✕</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {/* Added items */}
                      {envioAdded.map(a => {
                        const qty = envioEditable.has(a.skuVenta) ? envioEditable.get(a.skuVenta)! : a.qty;
                        const mainComp = a.componentes[0];
                        const stockBodega = mainComp ? skuTotal(mainComp.skuOrigen) : 0;
                        const udsPerPack = mainComp?.unidadesPorPack || 1;
                        const quedaBodega = stockBodega - (qty * udsPerPack);
                        const tipoBadge = a.tipo === "simple" ? "Simple" : a.tipo === "pack" ? "Pack" : "Combo";
                        const tipoColor = a.tipo === "simple" ? "var(--txt3)" : a.tipo === "pack" ? "var(--cyan)" : "var(--amber)";
                        return (
                          <tr key={`add-${a.skuVenta}`} style={{ background:"var(--greenBg)" }}>
                            <td className="mono" style={{ fontSize:11, fontWeight:700 }}>
                              {a.skuVenta} <span style={{ fontSize:9, color:"var(--green)", fontWeight:600 }}>nuevo</span>
                            </td>
                            <td style={{ fontSize:11, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.nombre}</td>
                            <td><span style={{ fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:4, color:tipoColor }}>{tipoBadge}</span></td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11 }}>{mainComp && (() => { const store = getStore(); const ip = store.products[mainComp.skuOrigen]?.innerPack; return ip && ip > 1 ? <span style={{ fontWeight:600 }}>{ip}</span> : <span style={{ color:"var(--txt3)" }}>—</span>; })()}</td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11, color:"var(--txt3)" }}>—</td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11 }}>{stockBodega}</td>
                            <td style={{ textAlign:"center" }}>
                              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:4 }}>
                                <button onClick={() => { const isAdded = envioAdded.some(x => x.skuVenta === a.skuVenta); isAdded ? setAddedQty(a.skuVenta, qty - 1) : setEnvioQty(a.skuVenta, qty - 1); }} style={{ width:26, height:26, borderRadius:4, background:"var(--bg3)", border:"1px solid var(--bg4)", fontSize:14, fontWeight:700, cursor:"pointer", color:"var(--txt)" }}>−</button>
                                <input type="number" value={qty} onChange={e => { const v = parseInt(e.target.value) || 0; const isAdded = envioAdded.some(x => x.skuVenta === a.skuVenta); isAdded ? setAddedQty(a.skuVenta, v) : setEnvioQty(a.skuVenta, v); }}
                                  style={{ width:55, textAlign:"center", fontSize:13, fontWeight:700, padding:"3px 4px", borderRadius:4, border:"2px solid var(--green)", background:"var(--bg)", color:"var(--txt1)" }} />
                                <button onClick={() => { const isAdded = envioAdded.some(x => x.skuVenta === a.skuVenta); isAdded ? setAddedQty(a.skuVenta, qty + 1) : setEnvioQty(a.skuVenta, qty + 1); }} style={{ width:26, height:26, borderRadius:4, background:"var(--bg3)", border:"1px solid var(--bg4)", fontSize:14, fontWeight:700, cursor:"pointer", color:"var(--txt)" }}>+</button>
                              </div>
                            </td>
                            <td className="mono" style={{ textAlign:"right", fontSize:11, fontWeight:700, color: quedaBodega < 0 ? "var(--red)" : quedaBodega === 0 ? "var(--amber)" : "var(--green)" }}>
                              {quedaBodega}
                            </td>
                            <td>
                              <button onClick={() => removeEnvioItem(a.skuVenta)} title="Quitar" style={{ padding:"3px 6px", borderRadius:4, background:"var(--redBg)", color:"var(--red)", fontSize:10, fontWeight:700, border:"1px solid var(--redBd)", cursor:"pointer" }}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                      {/* Removed items (greyed out with restore) */}
                      {envioDetalles.filter(d => envioRemoved.has(d.skuVenta)).map(d => (
                        <tr key={`rm-${d.skuVenta}`} style={{ opacity:0.4 }}>
                          <td className="mono" style={{ fontSize:11, textDecoration:"line-through" }}>{d.skuVenta}</td>
                          <td style={{ fontSize:11, textDecoration:"line-through" }}>{d.nombre}</td>
                          <td colSpan={5} style={{ fontSize:11, color:"var(--red)", textAlign:"center" }}>Eliminado del envio</td>
                          <td colSpan={2}>
                            <button onClick={() => restoreEnvioItem(d.skuVenta)} style={{ padding:"3px 8px", borderRadius:4, background:"var(--bg3)", color:"var(--cyan)", fontSize:10, fontWeight:700, border:"1px solid var(--bg4)", cursor:"pointer" }}>Restaurar</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Add product */}
                <div style={{ marginTop:12, padding:"10px 14px", borderRadius:8, background:"var(--bg3)", border:"1px solid var(--bg4)" }}>
                  <div style={{ fontSize:11, fontWeight:600, color:"var(--txt3)", marginBottom:6 }}>Agregar producto al envio</div>
                  <div style={{ position:"relative" }}>
                    <input type="text" className="form-input" value={addEnvioSearch} onChange={e => setAddEnvioSearch(e.target.value)}
                      placeholder="Buscar por SKU venta, nombre o codigo ML..." style={{ fontSize:12 }} />
                    {addEnvioSearch.trim().length >= 2 && (() => {
                      const results = findSkuVenta(addEnvioSearch).filter(r =>
                        !envioDetalles.some(d => d.skuVenta === r.skuVenta && !envioRemoved.has(d.skuVenta)) &&
                        !envioAdded.some(a => a.skuVenta === r.skuVenta)
                      ).slice(0, 8);
                      return results.length > 0 ? (
                        <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"var(--bg2)", border:"1px solid var(--bg4)", borderRadius:6, zIndex:10, maxHeight:200, overflowY:"auto" }}>
                          {results.map(r => {
                            const stockBod = r.componentes.length > 0 ? skuTotal(r.componentes[0].skuOrigen) : skuTotal(r.skuVenta);
                            return (
                              <div key={r.skuVenta} onClick={() => addEnvioItem(r.skuVenta, r.nombre, r.componentes)}
                                style={{ padding:"8px 12px", cursor:"pointer", borderBottom:"1px solid var(--bg3)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <div>
                                  <span className="mono" style={{ fontWeight:700, fontSize:12 }}>{r.skuVenta}</span>
                                  <span style={{ fontSize:11, color:"var(--txt3)", marginLeft:8 }}>{r.nombre}</span>
                                  {r.componentes.length > 0 && r.componentes[0].unidades > 1 && <span style={{ fontSize:9, color:"var(--cyan)", marginLeft:6 }}>Pack x{r.componentes[0].unidades}</span>}
                                </div>
                                <span className="mono" style={{ fontSize:11, color: stockBod > 0 ? "var(--green)" : "var(--red)" }}>{stockBod} bod</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"var(--bg2)", border:"1px solid var(--bg4)", borderRadius:6, padding:12, textAlign:"center", fontSize:11, color:"var(--txt3)" }}>Sin resultados</div>
                      );
                    })()}
                  </div>
                </div>

                {/* Summary */}
                <div style={{ marginTop:10, display:"flex", gap:16, fontSize:11, color:"var(--txt3)", justifyContent:"flex-end" }}>
                  <span>Total: <strong style={{ color:"var(--txt)" }}>{envioFinal.length}</strong> SKUs</span>
                  <span>Unidades: <strong style={{ color:"var(--txt)" }}>{envioFinal.reduce((s, r) => s + r.mandarFull, 0).toLocaleString()}</strong></span>
                </div>
              </div>
            )}

            {/* ===== NORMAL VIEW: tabla estructurada ===== */}
            {showEnvioFull && !envioEditMode && (
              <div style={{ overflowX:"auto", marginTop:12 }}>
                <table className="tbl" style={{ minWidth:1100 }}>
                  <thead>
                    <tr>
                      <th style={{ width:30 }}></th>
                      <th>SKU Venta</th>
                      <th>Nombre</th>
                      <th>Tipo</th>
                      <th style={{ textAlign:"right" }}>Enviar</th>
                      <th style={{ textAlign:"right" }}>Uds Físicas</th>
                      <th style={{ textAlign:"right" }}>Inner Pack</th>
                      <th style={{ textAlign:"right" }}>Bultos</th>
                      <th style={{ textAlign:"right" }}>Sueltas</th>
                      <th style={{ textAlign:"right" }}>Stock Bod.</th>
                      <th>Ubicaciones</th>
                      <th style={{ textAlign:"center" }}>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {envioDetalles.map(d => {
                      const isExpanded = expandedEnvio.has(d.skuVenta);
                      const tipoBadge = d.tipo === "simple" ? "Simple" : d.tipo === "pack" ? "Pack" : "Combo";
                      const tipoColor = d.tipo === "simple" ? "var(--txt3)" : d.tipo === "pack" ? "var(--cyan)" : "var(--amber)";
                      const estadoIcon = d.estado === "listo" ? "✅" : d.estado === "armar" ? "⚙️" : "⚠️";
                      const estadoLabel = d.estado === "listo" ? "Listo" : d.estado === "armar" ? "Armar" : "Insuf.";
                      const estadoColor = d.estado === "insuficiente" ? "var(--red)" : d.estado === "armar" ? "var(--amber)" : "var(--green)";
                      const c0 = d.componentes[0];
                      const totalFisicas = d.componentes.reduce((s, c) => s + c.unidadesFisicas, 0);
                      const hasAlerta = alertasEnvioCompartido.has(d.skuVenta);
                      const hasRedondeo = d.redondeo && d.redondeo.direccion !== "sin_cambio";

                      return (
                        <React.Fragment key={d.skuVenta}>
                          {/* Fila principal */}
                          <tr style={{ cursor:"pointer", background: !c0?.alcanza ? "var(--redBg)" : hasAlerta ? "var(--amberBg)" : undefined }}
                            onClick={() => toggleEnvioExpand(d.skuVenta)}>
                            <td style={{ textAlign:"center", fontSize:10, color:"var(--txt3)" }}>
                              <span style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block" }}>▶</span>
                            </td>
                            <td className="mono" style={{ fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>{d.skuVenta}</td>
                            <td style={{ fontSize:11, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={d.nombre}>{d.nombre}</td>
                            <td><span style={{ fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:4, color:tipoColor, background:"var(--bg3)", border:`1px solid ${tipoColor}40` }}>{tipoBadge}</span></td>
                            <td className="mono" style={{ textAlign:"right", fontWeight:700, color:"var(--blue)" }}>
                              {d.mandarFull}
                              {hasRedondeo && (
                                <span style={{ fontSize:9, marginLeft:3, color: d.redondeo!.direccion === "arriba" ? "var(--green)" : "var(--amber)" }}>
                                  {d.redondeo!.direccion === "arriba" ? "▲" : "▼"}
                                </span>
                              )}
                            </td>
                            <td className="mono" style={{ textAlign:"right" }}>{d.tipo === "simple" ? totalFisicas : <span>{totalFisicas} <span style={{ fontSize:9, color:"var(--txt3)" }}>({d.mandarFull}×{c0?.unidadesPorPack})</span></span>}</td>
                            <td className="mono" style={{ textAlign:"right" }}>{c0?.innerPack ?? <span style={{ color:"var(--txt3)" }}>—</span>}</td>
                            <td className="mono" style={{ textAlign:"right" }}>{c0?.innerPack ? c0.bultosCompletos : <span style={{ color:"var(--txt3)" }}>—</span>}</td>
                            <td className="mono" style={{ textAlign:"right", color: c0?.sueltas ? "var(--amber)" : "var(--txt3)" }}>
                              {c0?.innerPack ? (c0.sueltas > 0 ? c0.sueltas : "0") : "—"}
                              {c0?.sueltas > 0 && c0?.innerPack && <span style={{ fontSize:9, color:"var(--amber)", marginLeft:2 }} title={`Faltan ${c0.faltanParaBulto} para bulto completo`}>⚠</span>}
                            </td>
                            <td className="mono" style={{ textAlign:"right", color: c0 && !c0.alcanza ? "var(--red)" : undefined }}>
                              {c0?.stockTotal ?? 0}
                            </td>
                            <td style={{ fontSize:10, whiteSpace:"nowrap" }}>
                              {c0?.posiciones.length ? c0.posiciones.map(p => <span key={p.pos} className="mono" style={{ marginRight:6 }}>{p.label || p.pos} <span style={{ color:"var(--txt3)" }}>({p.qty})</span></span>) : <span style={{ color:"var(--red)" }}>Sin stock</span>}
                            </td>
                            <td style={{ textAlign:"center" }}>
                              <span style={{ fontSize:10, fontWeight:700, color:estadoColor, whiteSpace:"nowrap" }}>{estadoIcon} {estadoLabel}</span>
                            </td>
                          </tr>

                          {/* Fila expandida — detalle */}
                          {isExpanded && (
                            <tr>
                              <td colSpan={12} style={{ padding:0, background:"var(--bg)" }}>
                                <div style={{ padding:"12px 16px", borderLeft:"3px solid var(--cyan)" }}>
                                  {/* Redondeo info */}
                                  {hasRedondeo && (
                                    <div style={{ display:"flex", gap:16, flexWrap:"wrap", alignItems:"center", padding:"6px 10px", marginBottom:8, borderRadius:6, fontSize:11, background: d.redondeo!.direccion === "arriba" ? "var(--greenBg)" : "var(--amberBg)", border:`1px solid ${d.redondeo!.direccion === "arriba" ? "var(--greenBd)" : "var(--amberBd)"}` }}>
                                      <span style={{ color:"var(--txt3)" }}>Original: <span className="mono" style={{ fontWeight:600 }}>{d.redondeo!.original}</span></span>
                                      <span style={{ color:"var(--txt3)" }}>Inner pack: <span className="mono" style={{ fontWeight:600 }}>{d.redondeo!.innerPack}</span></span>
                                      <span style={{ fontWeight:700, color: d.redondeo!.direccion === "arriba" ? "var(--green)" : "var(--amber)" }}>
                                        → {d.redondeo!.redondeado} uds ({c0?.innerPack ? Math.round(d.redondeo!.redondeado * (c0?.unidadesPorPack || 1) / d.redondeo!.innerPack) : "?"} bultos) {d.redondeo!.direccion === "arriba" ? "▲ arriba" : "▼ abajo"}
                                      </span>
                                      <span style={{ color:"var(--txt3)", fontSize:10 }}>Queda bodega: {Math.max(0, d.redondeo!.stockBodegaDespues)}</span>
                                    </div>
                                  )}

                                  {/* Alerta stock compartido */}
                                  {hasAlerta && (() => {
                                    const alerta = alertasEnvioCompartido.get(d.skuVenta)!;
                                    return (
                                      <div style={{ padding:"6px 10px", marginBottom:8, borderRadius:6, fontSize:11, background:"var(--amberBg)", border:"1px solid var(--amberBd)", color:"var(--amber)" }}>
                                        ⚠️ Stock compartido de <span className="mono" style={{ fontWeight:700 }}>{alerta.skuOrigen}</span>: necesita {alerta.totalFisico} uds, bodega tiene {alerta.stockBodega}. Priorizado: {alerta.priorizado}.
                                      </div>
                                    );
                                  })()}

                                  {/* Tabla de componentes */}
                                  {d.componentes.length > 0 && (
                                    <table style={{ width:"100%", fontSize:11, borderCollapse:"collapse" }}>
                                      <thead>
                                        <tr style={{ borderBottom:"1px solid var(--bg4)" }}>
                                          <th style={{ textAlign:"left", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>SKU Origen</th>
                                          <th style={{ textAlign:"left", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Nombre</th>
                                          <th style={{ textAlign:"right", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Uds/Pack</th>
                                          <th style={{ textAlign:"right", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Uds Físicas</th>
                                          <th style={{ textAlign:"right", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Bultos</th>
                                          <th style={{ textAlign:"right", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Sueltas</th>
                                          <th style={{ textAlign:"right", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Stock</th>
                                          <th style={{ textAlign:"left", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Ubicaciones</th>
                                          <th style={{ textAlign:"center", padding:"4px 8px", fontSize:10, color:"var(--txt3)" }}>Alcanza</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {d.componentes.map(c => (
                                          <tr key={c.skuOrigen} style={{ borderBottom:"1px solid var(--bg3)" }}>
                                            <td className="mono" style={{ padding:"4px 8px", fontWeight:600 }}>{c.skuOrigen}</td>
                                            <td style={{ padding:"4px 8px", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.nombreOrigen}</td>
                                            <td className="mono" style={{ padding:"4px 8px", textAlign:"right" }}>{c.unidadesPorPack}</td>
                                            <td className="mono" style={{ padding:"4px 8px", textAlign:"right", fontWeight:600 }}>{c.unidadesFisicas}</td>
                                            <td className="mono" style={{ padding:"4px 8px", textAlign:"right" }}>{c.innerPack ? `${c.bultosCompletos} (×${c.innerPack})` : "—"}</td>
                                            <td className="mono" style={{ padding:"4px 8px", textAlign:"right", color: c.sueltas > 0 ? "var(--amber)" : "var(--txt3)" }}>
                                              {c.innerPack ? c.sueltas : "—"}
                                              {c.sueltas > 0 && c.innerPack && <span style={{ fontSize:9, color:"var(--txt3)" }}> falta {c.faltanParaBulto}</span>}
                                            </td>
                                            <td className="mono" style={{ padding:"4px 8px", textAlign:"right", color: !c.alcanza ? "var(--red)" : undefined }}>{c.stockTotal}</td>
                                            <td style={{ padding:"4px 8px", fontSize:10 }}>
                                              {c.posiciones.length > 0
                                                ? c.posiciones.map(p => <span key={p.pos} className="mono" style={{ marginRight:6 }}>{p.label || p.pos} <span style={{ color:"var(--txt3)" }}>({p.qty})</span></span>)
                                                : <span style={{ color:"var(--red)" }}>Sin stock</span>}
                                            </td>
                                            <td style={{ padding:"4px 8px", textAlign:"center" }}>
                                              {c.alcanza ? <span style={{ color:"var(--green)" }}>✅</span> : <span style={{ color:"var(--red)" }} title={`Necesita ${c.unidadesFisicas}, tiene ${c.stockTotal}. Max: ${c.maxPacks} ${d.tipo === "pack" ? "packs" : d.tipo === "combo" ? "combos" : "uds"}`}>❌</span>}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}

                                  {/* Instrucciones logística */}
                                  {(d.tipo !== "simple" || d.componentes.some(c => !c.alcanza)) && (
                                    <div style={{ marginTop:8, padding:"6px 10px", borderRadius:6, background:"var(--bg3)", fontSize:11, color:"var(--txt2)" }}>
                                      {d.componentes.map((c, ci) => (
                                        <React.Fragment key={c.skuOrigen}>
                                          {d.tipo !== "simple" && (
                                            <>
                                              {c.innerPack !== null && c.bultosCompletos > 0 && (
                                                <div>→ Abrir {c.bultosCompletos} bulto{c.bultosCompletos !== 1 ? "s" : ""} de <span className="mono">{c.skuOrigen}</span> ({c.bultosCompletos * c.innerPack} uds)</div>
                                              )}
                                              {c.innerPack !== null && c.sueltas > 0 && (
                                                <div>→ Del {c.bultosCompletos + 1}° bulto tomar {c.sueltas} uds{c.innerPack - c.sueltas > 0 ? ` (quedan ${c.innerPack - c.sueltas} en bodega)` : ""}</div>
                                              )}
                                              {c.innerPack === null && (
                                                <div>→ Tomar {c.unidadesFisicas} uds de <span className="mono">{c.skuOrigen}</span></div>
                                              )}
                                              {d.tipo === "pack" && ci === 0 && (
                                                <div style={{ color:"var(--cyan)" }}>→ Armar {d.mandarFull} packs de {c.unidadesPorPack} uds → etiquetar como <span className="mono">{d.skuVenta}</span></div>
                                              )}
                                              {d.tipo === "combo" && ci === d.componentes.length - 1 && (
                                                <div style={{ color:"var(--cyan)" }}>→ Armar {d.mandarFull} combos ({d.componentes.map(cc => `${cc.unidadesPorPack}× ${cc.skuOrigen}`).join(" + ")}) → etiquetar como <span className="mono">{d.skuVenta}</span></div>
                                              )}
                                            </>
                                          )}
                                          {!c.alcanza && (
                                            <div style={{ color:"var(--red)", fontWeight:600 }}>
                                              ⚠ {c.skuOrigen}: necesita {c.unidadesFisicas}, tiene {c.stockTotal} — máx {c.maxPacks} {d.tipo === "pack" ? "packs" : d.tipo === "combo" ? "combos" : "uds"}
                                            </div>
                                          )}
                                        </React.Fragment>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          </>}

          {/* === TAB: Pedido a Proveedor === */}
          {subTab === "pedido" && <>
          {/* Lista: Pedido a proveedor */}
          <div className="card" style={{ marginBottom:16 }}>
            <button onClick={() => setShowPedidoProv(!showPedidoProv)} style={{ background:"none", border:"none", color:"var(--txt)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%", padding:0, fontSize:14, fontWeight:600 }}>
              <span>
                <span style={{ transform: showPedidoProv ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block", marginRight:8 }}>▶</span>
                🛒 Pedido a proveedor ({resultado.origenRows.filter(r => r.pedirProveedor > 0).length} SKUs, {resultado.origenRows.reduce((s, r) => s + r.pedirProveedor, 0).toLocaleString()} uds)
              </span>
              <button onClick={(e) => { e.stopPropagation(); exportPedidoProv(); }} style={{ padding:"4px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--cyan)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                Exportar CSV
              </button>
            </button>
            {showPedidoProv && (() => {
              const pedidoRows = resultado.origenRows.filter(r => r.pedirProveedor > 0 || (r.statusProveedor === "sin_stock" && r.velTotalFisica > 0)).sort((a, b) => b.pedirProveedor - a.pedirProveedor);
              const tieneProveedor = !!proveedor;
              const totalCostoPedido = tieneProveedor ? pedidoRows.reduce((s, r) => s + (r.costoTotalLinea || 0), 0) : 0;
              return (
              <div style={{ overflowX:"auto", marginTop:12 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>SKU Origen</th>
                      <th>Nombre</th>
                      <th>Uds a pedir</th>
                      {tieneProveedor && <th>Stock Prov.</th>}
                      {tieneProveedor && <th>Inner Pack</th>}
                      {tieneProveedor && <th>Bultos</th>}
                      {tieneProveedor && <th>Pedir Real</th>}
                      <th>Stock Bodega</th>
                      <th>Stock Full (equiv)</th>
                      <th>Vel/sem</th>
                      {tieneProveedor && <th>Costo Unit.</th>}
                      {tieneProveedor && <th>Costo Total</th>}
                      <th>Acción</th>
                      {tieneProveedor && <th>Proveedor</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pedidoRows.map(r => (
                      <tr key={r.skuOrigen}>
                        <td className="mono" style={{ fontSize:11, fontWeight:600 }}>{r.skuOrigen}</td>
                        <td style={{ fontSize:11 }}>{r.nombre}</td>
                        <td className="mono" style={{ textAlign:"right", fontWeight:700, color:"var(--amber)" }}>{r.pedirProveedor > 0 ? r.pedirProveedor : "-"}</td>
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right", color: r.statusProveedor === "sin_stock" ? "var(--red)" : r.statusProveedor === "otro_proveedor" ? "var(--txt3)" : undefined }}>
                            {r.statusProveedor === "otro_proveedor" ? "-" : r.stockProveedor ?? "-"}
                          </td>
                        )}
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right" }}>{r.innerPack ?? "-"}</td>
                        )}
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right" }}>{r.bultos != null ? r.bultos : "-"}</td>
                        )}
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right", fontWeight:700, color: r.pedirReal && r.pedirReal > 0 ? "var(--green)" : undefined }}>
                            {r.statusProveedor === "sin_stock" ? <span style={{ color:"var(--red)" }}>0</span> : r.pedirReal != null ? r.pedirReal : "-"}
                          </td>
                        )}
                        <td className="mono" style={{ textAlign:"right" }}>{r.stockBodega}</td>
                        <td className="mono" style={{ textAlign:"right" }}>{r.stockFullEquiv}</td>
                        <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velTotalFisica)}</td>
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right", fontSize:11 }}>
                            {r.costoProveedor != null ? (
                              <span>
                                ${r.costoProveedor.toLocaleString()}
                                {r.alertaCosto && (
                                  <span title={`WMS: $${r.alertaCosto.costoWMS.toLocaleString()} | Prov: $${r.alertaCosto.costoProveedor.toLocaleString()}`} style={{ color:"var(--red)", marginLeft:4 }}>⚠️</span>
                                )}
                              </span>
                            ) : "-"}
                          </td>
                        )}
                        {tieneProveedor && (
                          <td className="mono" style={{ textAlign:"right", fontSize:11, fontWeight:600 }}>
                            {r.costoTotalLinea != null && r.costoTotalLinea > 0 ? `$${r.costoTotalLinea.toLocaleString()}` : "-"}
                          </td>
                        )}
                        <td>{badge(r.accion)}</td>
                        {tieneProveedor && (
                          <td style={{ fontSize:10, whiteSpace:"nowrap" }}>
                            {r.statusProveedor === "sin_stock" ? (
                              <span style={{ color:"var(--red)" }}>⚠️ Sin stock{r.diasAgotamiento != null ? ` (${r.diasAgotamiento}d)` : ""}</span>
                            ) : r.statusProveedor === "otro_proveedor" ? (
                              <span style={{ color:"var(--blue)" }}>🔵 {r.nombreProveedor || "Otro prov."}</span>
                            ) : (
                              <span style={{ color:"var(--green)" }}>✓</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {tieneProveedor && totalCostoPedido > 0 && (
                  <div style={{ display:"flex", justifyContent:"flex-end", marginTop:12, padding:"8px 16px", background:"var(--bg3)", borderRadius:8, border:"1px solid var(--bg4)" }}>
                    <span style={{ fontSize:13, fontWeight:700 }}>Total pedido: <span className="mono" style={{ color:"var(--amber)", fontSize:15 }}>${totalCostoPedido.toLocaleString()}</span></span>
                  </div>
                )}
              </div>
              );
            })()}
          </div>
          </>}
        </>
      )}

      {/* ===== MODAL: Detalle de cálculo por SKU ===== */}
      {detalleSkuVenta && resultado && (() => {
        const row = resultado.ventaRows.find(r => r.skuVenta === detalleSkuVenta);
        if (!row || !row.calcLog) return null;
        const log = row.calcLog;
        return (
          <div onClick={() => setDetalleSkuVenta(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.7)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
            <div onClick={e => e.stopPropagation()} style={{ background:"var(--bg2)", border:"1px solid var(--bg4)", borderRadius:16, maxWidth:700, width:"100%", maxHeight:"85vh", overflow:"auto", padding:24 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                <div>
                  <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Detalle de cálculo</h3>
                  <div className="mono" style={{ fontSize:13, color:"var(--cyan)", marginTop:4 }}>{row.skuVenta}</div>
                  <div style={{ fontSize:12, color:"var(--txt3)", marginTop:2 }}>{row.nombre}</div>
                </div>
                <button onClick={() => setDetalleSkuVenta(null)} style={{ background:"var(--bg3)", border:"1px solid var(--bg4)", borderRadius:8, width:32, height:32, cursor:"pointer", color:"var(--txt)", fontSize:16, fontWeight:700 }}>✕</button>
              </div>

              {/* Resultado rápido */}
              <div style={{ display:"flex", gap:12, marginBottom:16, flexWrap:"wrap" }}>
                {[
                  { label: "Vel Total", val: `${row.velTotal.toFixed(1)}/sem`, color: "var(--txt)" },
                  { label: "St.Full", val: String(row.stockFull), color: "var(--txt)" },
                  { label: "St.Bod", val: String(row.stockBodega), color: "var(--txt)" },
                  { label: "Cob Full", val: `${row.cobFull}d`, color: row.cobFull < 14 ? "var(--red)" : row.cobFull > 60 ? "var(--amber)" : "var(--green)" },
                  { label: "→Full", val: String(row.mandarFull), color: row.mandarFull > 0 ? "var(--blue)" : "var(--txt3)" },
                  { label: "Pedir", val: String(row.pedir), color: row.pedir > 0 ? "var(--amber)" : "var(--txt3)" },
                ].map(k => (
                  <div key={k.label} style={{ background:"var(--bg3)", borderRadius:8, padding:"8px 14px", textAlign:"center", flex:"1 1 80px" }}>
                    <div className="mono" style={{ fontSize:15, fontWeight:700, color:k.color }}>{k.val}</div>
                    <div style={{ fontSize:10, color:"var(--txt3)", marginTop:2 }}>{k.label}</div>
                  </div>
                ))}
              </div>

              {/* Pasos del cálculo */}
              <table style={{ width:"100%", fontSize:12, borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ borderBottom:"2px solid var(--bg4)" }}>
                    <th style={{ textAlign:"left", padding:"6px 8px", fontSize:10, color:"var(--txt3)", fontWeight:600 }}>PASO</th>
                    <th style={{ textAlign:"left", padding:"6px 8px", fontSize:10, color:"var(--txt3)", fontWeight:600 }}>FÓRMULA</th>
                    <th style={{ textAlign:"right", padding:"6px 8px", fontSize:10, color:"var(--txt3)", fontWeight:600 }}>RESULTADO</th>
                  </tr>
                </thead>
                <tbody>
                  {log.pasos.map((paso, i) => (
                    <tr key={i} style={{ borderBottom:"1px solid var(--bg3)", background: i % 2 === 0 ? "transparent" : "var(--bg)" }}>
                      <td style={{ padding:"6px 8px", fontWeight:600, whiteSpace:"nowrap", color:"var(--txt2)" }}>{paso.label}</td>
                      <td className="mono" style={{ padding:"6px 8px", fontSize:11, color:"var(--txt3)", wordBreak:"break-word" }}>{paso.formula}</td>
                      <td className="mono" style={{ padding:"6px 8px", textAlign:"right", fontWeight:700, whiteSpace:"nowrap" }}>{paso.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Acción final */}
              <div style={{ marginTop:16, display:"flex", justifyContent:"center" }}>
                {badge(row.accion)}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
