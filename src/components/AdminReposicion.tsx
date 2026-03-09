"use client";
import { useState, useMemo, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import { skuTotal, getStore, getComponentesPorSkuVenta, getVentasPorSkuOrigen } from "@/lib/store";
import type { ComposicionVenta } from "@/lib/store";

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
}

interface ProveedorRaw {
  skuOrigen: string;
  nombre: string;
  innerPack: number;
  precioNeto: number;
  stock: number;
}

type ProveedorStatus = "ok" | "sin_stock" | "otro_proveedor";

type Accion = "SIN VENTA" | "MANDAR A FULL" | "AGOTADO PEDIR" | "URGENTE" | "PLANIFICAR" | "OK" | "EXCESO";

interface Config {
  cobObjetivo: number;
  puntoReorden: number;
  cobMaxima: number;
}

const DEFAULT_CONFIG: Config = { cobObjetivo: 45, puntoReorden: 14, cobMaxima: 60 };

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
    const sku = String(row[iSku] || "").trim();
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
    const skuVenta = String(row[0] || "").trim();
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

  // 4. Calcular filas por SKU Venta
  const ventaRows: SkuVentaRow[] = [];
  // Para acumular demanda física por SKU Origen
  const demandaFisicaPorOrigen = new Map<string, { velFull: number; velFlex: number; velTotal: number }>();
  const stockFullPorOrigen = new Map<string, number>();
  // Nombres por SKU Origen
  const nombreOrigen = new Map<string, string>();

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
    if (componentes.length > 0) {
      // Para packs/combos, el stock de bodega es el mínimo de (stock_origen / unidades)
      stockBodega = Math.min(...componentes.map(c => Math.floor(skuTotal(c.skuOrigen) / c.unidades)));
    } else {
      // SKU simple: SKU Venta = SKU Origen
      stockBodega = skuTotal(skuVenta);
    }

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

    // Target días: si margen Flex > Full → 30d, sino cobObjetivo (45d)
    const targetDias = (margenFlex !== null && margenFull !== null && margenFlex > margenFull) ? 30 : cobObjetivo;
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

    ventaRows.push({
      skuVenta, nombre, velTotal, velFull, velFlex,
      stockFull, stockBodega, stockTotal,
      cobFull: Math.round(cobFull), cobBodega: Math.round(cobBodega), cobTotal: Math.round(cobTotal),
      mandarFull: sinStockProv.has(skuVenta) ? mandarFull : mandarFull,
      pedir: sinStockProv.has(skuVenta) ? 0 : pedirVenta,
      accion,
      margenFlex, margenFull, costoProducto, sinCosto,
    });

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
      // SKU simple
      if (!demandaFisicaPorOrigen.has(skuVenta)) {
        demandaFisicaPorOrigen.set(skuVenta, { velFull: 0, velFlex: 0, velTotal: 0 });
        nombreOrigen.set(skuVenta, nombre);
      }
      const d = demandaFisicaPorOrigen.get(skuVenta)!;
      d.velFull += velFull;
      d.velFlex += velFlex;
      d.velTotal += velTotal;
      if (!stockFullPorOrigen.has(skuVenta)) stockFullPorOrigen.set(skuVenta, 0);
      stockFullPorOrigen.set(skuVenta, stockFullPorOrigen.get(skuVenta)! + stockFull);
    }
  }

  // 5. Filas por SKU Origen
  const origenRows: SkuOrigenRow[] = [];
  const origenEntries = Array.from(demandaFisicaPorOrigen.entries());
  for (let _j = 0; _j < origenEntries.length; _j++) {
    const [skuOrigen, dem] = origenEntries[_j];
    const stockBodega = skuTotal(skuOrigen);
    const stockFullEquiv = stockFullPorOrigen.get(skuOrigen) || 0;
    const targetFisico = dem.velTotal * cobObjetivo / 7;
    const pedirProveedor = Math.max(0, Math.ceil(targetFisico - (stockFullEquiv + stockBodega)));

    let accion: Accion;
    if (dem.velTotal === 0) accion = "SIN VENTA";
    else {
      const cobTotal = dem.velTotal > 0 ? ((stockFullEquiv + stockBodega) / dem.velTotal) * 7 : 999;
      if (stockBodega === 0 && stockFullEquiv === 0) accion = "AGOTADO PEDIR";
      else if (cobTotal < puntoReorden) accion = "URGENTE";
      else if (cobTotal < 30) accion = "PLANIFICAR";
      else if (cobTotal <= cobMaxima) accion = "OK";
      else accion = "EXCESO";
    }

    origenRows.push({
      skuOrigen,
      nombre: nombreOrigen.get(skuOrigen) || skuOrigen,
      velTotalFisica: dem.velTotal,
      stockBodega,
      demandaFisicaTotal: dem.velTotal,
      targetFisico: Math.ceil(targetFisico),
      pedirProveedor: sinStockProv.has(skuOrigen) ? 0 : pedirProveedor,
      stockFullEquiv: Math.round(stockFullEquiv),
      accion,
    });
  }

  // 6. Cruce con datos de proveedor
  if (proveedorData && proveedorData.length > 0) {
    const provMap = new Map<string, ProveedorRaw>();
    for (const p of proveedorData) provMap.set(p.skuOrigen, p);

    const store = getStore();
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
  const [ordenes, setOrdenes] = useState<OrdenRaw[] | null>(null);
  const [velocidades, setVelocidades] = useState<VelocidadRaw[] | null>(null);
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
  const [vistaOrigen, setVistaOrigen] = useState(false);
  const [fileNameOrdenes, setFileNameOrdenes] = useState("");
  const [fileNameVelocidad, setFileNameVelocidad] = useState("");
  const [proveedor, setProveedor] = useState<ProveedorRaw[] | null>(null);
  const [fileNameProveedor, setFileNameProveedor] = useState("");

  // Persistir sinStockProv en localStorage
  useEffect(() => {
    localStorage.setItem("banva_reposicion_sin_stock", JSON.stringify(Array.from(sinStockProv)));
  }, [sinStockProv]);

  const toggleSinStock = useCallback((sku: string) => {
    setSinStockProv(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }, []);

  // Parsear archivo de órdenes
  const handleOrdenes = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameOrdenes(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      setOrdenes(parseOrdenes(wb));
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Parsear archivo de velocidad
  const handleVelocidad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameVelocidad(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      setVelocidades(parseVelocidad(wb));
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Parsear archivo de proveedor
  const handleProveedor = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileNameProveedor(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      setProveedor(parseProveedor(wb));
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

  // Export envío a Full
  const exportEnvioFull = () => {
    if (!resultado) return;
    const rows = resultado.ventaRows.filter(r => r.mandarFull > 0).sort((a, b) => ACCION_ORDEN[a.accion] - ACCION_ORDEN[b.accion]);
    exportCSV(
      ["SKU Venta", "Nombre", "Uds a mandar", "Stock Bodega", "Stock Full", "Cob Full (días)"],
      rows.map(r => [r.skuVenta, r.nombre, String(r.mandarFull), String(r.stockBodega), String(r.stockFull), fmtNum(r.cobFull)]),
      `envio_full_${new Date().toISOString().slice(0,10)}.csv`,
    );
  };

  // Export pedido proveedor
  const exportPedidoProv = () => {
    if (!resultado) return;
    const tieneProveedor = !!proveedor;
    const rows = resultado.origenRows.filter(r => r.pedirProveedor > 0 || (r.statusProveedor === "sin_stock" && r.velTotalFisica > 0)).sort((a, b) => b.pedirProveedor - a.pedirProveedor);

    if (tieneProveedor) {
      const headers = ["SKU Origen", "Nombre", "Uds a pedir", "Bultos", "Inner Pack", "Pedir Real", "Costo Unitario", "Costo Total Línea", "Stock Proveedor", "Estado"];
      const dataRows = rows.map(r => {
        const estado = r.statusProveedor === "sin_stock" ? "Sin stock" : r.statusProveedor === "otro_proveedor" ? "Otro proveedor" : "OK";
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
        <div className="card" style={{ textAlign:"center", padding:20 }}>
          <div style={{ fontSize:24, marginBottom:8 }}>📋</div>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:4 }}>Archivo de Órdenes</div>
          <div style={{ fontSize:11, color:"var(--txt3)", marginBottom:12 }}>Export ProfitGuard — Ventas</div>
          <label style={{ display:"inline-block", padding:"8px 20px", borderRadius:8, background:"var(--bg3)", border:"1px solid var(--bg4)", cursor:"pointer", fontSize:12, fontWeight:600, color:"var(--cyan)" }}>
            {fileNameOrdenes || "Seleccionar archivo"}
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleOrdenes} style={{ display:"none" }} />
          </label>
          {ordenes && <div style={{ marginTop:8, fontSize:11, color:"var(--green)" }}>{ordenes.length} órdenes cargadas</div>}
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
          </div>

          {/* Tabla SKU Venta */}
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
                    <th style={thStyle("stockBodega")} onClick={() => handleSort("stockBodega")}>St.Bodega</th>
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
                  {filasVenta.map(r => (
                    <tr key={r.skuVenta}>
                      <td className="mono" style={{ fontSize:11, fontWeight:600 }}>{r.skuVenta}</td>
                      <td style={{ maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:11 }} title={r.nombre}>{r.nombre}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velTotal)}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velFull)}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velFlex)}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{r.stockFull}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{r.stockBodega}</td>
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
                      <td className="mono" style={{ textAlign:"right", fontWeight:600, color: r.mandarFull > 0 ? "var(--blue)" : undefined }}>{r.mandarFull > 0 ? r.mandarFull : "-"}</td>
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
                </tbody>
              </table>
            </div>
          )}

          {/* Tabla SKU Origen */}
          {vistaOrigen && (
            <div style={{ overflowX:"auto", marginBottom:20 }}>
              <table className="tbl" style={{ minWidth:900 }}>
                <thead>
                  <tr>
                    <th style={thStyle("skuOrigen")} onClick={() => handleSort("skuOrigen")}>SKU Origen</th>
                    <th style={thStyle("nombre")} onClick={() => handleSort("nombre")}>Nombre</th>
                    <th style={thStyle("velTotalFisica")} onClick={() => handleSort("velTotalFisica")}>Vel Física/sem</th>
                    <th style={thStyle("stockBodega")} onClick={() => handleSort("stockBodega")}>St.Bodega</th>
                    <th style={thStyle("stockFullEquiv")} onClick={() => handleSort("stockFullEquiv")}>St.Full (equiv)</th>
                    <th style={thStyle("targetFisico")} onClick={() => handleSort("targetFisico")}>Target</th>
                    <th style={thStyle("pedirProveedor")} onClick={() => handleSort("pedirProveedor")}>Pedir Prov.</th>
                    <th style={thStyle("accion")} onClick={() => handleSort("accion")}>Acción</th>
                    <th>Sin Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {filasOrigen.map(r => (
                    <tr key={r.skuOrigen}>
                      <td className="mono" style={{ fontSize:11, fontWeight:600 }}>{r.skuOrigen}</td>
                      <td style={{ maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontSize:11 }} title={r.nombre}>{r.nombre}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.velTotalFisica)}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{r.stockBodega}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{r.stockFullEquiv}</td>
                      <td className="mono" style={{ textAlign:"right" }}>{r.targetFisico}</td>
                      <td className="mono" style={{ textAlign:"right", fontWeight:600, color: r.pedirProveedor > 0 ? "var(--amber)" : undefined }}>
                        {sinStockProv.has(r.skuOrigen) ? <span title="Sin stock proveedor" style={{ color:"var(--red)" }}>⚠ 0</span> : r.pedirProveedor > 0 ? r.pedirProveedor : "-"}
                      </td>
                      <td>{badge(r.accion)}</td>
                      <td style={{ textAlign:"center" }}>
                        <input type="checkbox" checked={sinStockProv.has(r.skuOrigen)} onChange={() => toggleSinStock(r.skuOrigen)}
                          style={{ accentColor:"var(--red)", cursor:"pointer" }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Lista: Envío a Full */}
          <div className="card" style={{ marginBottom:16 }}>
            <button onClick={() => setShowEnvioFull(!showEnvioFull)} style={{ background:"none", border:"none", color:"var(--txt)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%", padding:0, fontSize:14, fontWeight:600 }}>
              <span>
                <span style={{ transform: showEnvioFull ? "rotate(90deg)" : "rotate(0)", transition:"transform 0.2s", display:"inline-block", marginRight:8 }}>▶</span>
                📦 Envío a Full ({resultado.ventaRows.filter(r => r.mandarFull > 0).length} SKUs, {resultado.ventaRows.reduce((s, r) => s + r.mandarFull, 0).toLocaleString()} uds)
              </span>
              <button onClick={(e) => { e.stopPropagation(); exportEnvioFull(); }} style={{ padding:"4px 12px", borderRadius:6, background:"var(--bg3)", border:"1px solid var(--bg4)", color:"var(--cyan)", fontSize:11, fontWeight:600, cursor:"pointer" }}>
                Exportar CSV
              </button>
            </button>
            {showEnvioFull && (
              <div style={{ overflowX:"auto", marginTop:12 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>SKU Venta</th>
                      <th>Nombre</th>
                      <th>Uds a mandar</th>
                      <th>Stock Bodega</th>
                      <th>Stock Full</th>
                      <th>Cob Full</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.ventaRows.filter(r => r.mandarFull > 0).sort((a, b) => ACCION_ORDEN[a.accion] - ACCION_ORDEN[b.accion]).map(r => (
                      <tr key={r.skuVenta}>
                        <td className="mono" style={{ fontSize:11, fontWeight:600 }}>{r.skuVenta}</td>
                        <td style={{ fontSize:11 }}>{r.nombre}</td>
                        <td className="mono" style={{ textAlign:"right", fontWeight:700, color:"var(--blue)" }}>{r.mandarFull}</td>
                        <td className="mono" style={{ textAlign:"right" }}>{r.stockBodega}</td>
                        <td className="mono" style={{ textAlign:"right" }}>{r.stockFull}</td>
                        <td className="mono" style={{ textAlign:"right" }}>{fmtNum(r.cobFull, 0)}d</td>
                        <td>{badge(r.accion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

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
                              <span style={{ color:"var(--blue)" }}>🔵 Otro prov.</span>
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
        </>
      )}
    </div>
  );
}
