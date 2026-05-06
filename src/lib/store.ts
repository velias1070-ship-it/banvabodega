"use client";
import * as db from "./db";
import { isConfigured, getSupabase } from "./supabase";
import { preloadCostos, resolverCostoVenta, calcularMargenVenta } from "./costos";
import { calcularMargenNeto } from "./ads";
import { dentroDeTolerancia, type ABCClase } from "./config-costos";
export { isConfigured as isSupabaseConfigured } from "./supabase";

// ==================== TYPES (backward compatible) ====================
export interface Product {
  sku: string;
  name: string;
  cat: string;
  prov: string;
  cost: number;
  costAvg: number;
  price: number;
  reorder: number;
  requiresLabel?: boolean;
  tamano?: string;
  color?: string;
  innerPack?: number | null;
  estadoSku?: string | null;
}

export interface ComposicionVenta {
  skuVenta: string;
  codigoMl: string;
  skuOrigen: string;
  unidades: number;
  tipoRelacion: "componente" | "alternativo";
  notaOperativa?: string | null;
}

export interface Position {
  id: string;
  label: string;
  type: "pallet" | "shelf";
  active: boolean;
  mx?: number; my?: number; mw?: number; mh?: number;
  color?: string;
}

export interface MapObject {
  id: string; label: string;
  kind: "desk" | "door" | "wall" | "zone" | "label";
  mx: number; my: number; mw: number; mh: number;
  color: string; rotation?: number;
}

export interface MapConfig {
  gridW: number; gridH: number; objects: MapObject[];
}

export type InReason = "compra" | "devolucion" | "ajuste_entrada" | "transferencia_in" | "ajuste_conteo";
export type OutReason = "venta_flex" | "envio_full" | "ajuste_salida" | "merma" | "ajuste_conteo";
export type MovType = "in" | "out";

export interface Movement {
  id: string; ts: string; type: MovType;
  reason: InReason | OutReason;
  sku: string; pos: string; qty: number;
  who: string; note: string;
  skuVenta?: string | null;
}

export type StockMap = Record<string, Record<string, number>>;

// Stock detallado: sku → sku_venta (o "__SIN_ETIQUETAR__") → posicion → qty
export type StockDetalleMap = Record<string, Record<string, Record<string, number>>>;
export const SIN_ETIQUETAR = "__SIN_ETIQUETAR__";

export interface StoreData {
  products: Record<string, Product>;
  positions: Position[];
  stock: StockMap;
  stockDetalle: StockDetalleMap;
  movements: Movement[];
  movCounter: number;
  mapConfig?: MapConfig;
  composicion: ComposicionVenta[];
  skuVentaToFisico: Record<string, string>;
  // Indice derivado de composicion: sku_origen → [codigo_ml, ...]
  // Reemplaza al campo legacy productos.codigo_ml. Se reconstruye junto a composicion.
  codigosMlPorSkuOrigen: Record<string, string[]>;
}

function buildCodigosMlIndex(composicion: ComposicionVenta[]): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const c of composicion) {
    if (!c.codigoMl) continue;
    const so = c.skuOrigen.toUpperCase();
    if (!idx[so]) idx[so] = [];
    if (!idx[so].includes(c.codigoMl)) idx[so].push(c.codigoMl);
  }
  return idx;
}

/** Devuelve los inventory_id (codigos ML) asociados a un sku_origen via composicion_venta. */
export function getCodigosMlBySkuOrigen(skuOrigen: string): string[] {
  return _cache.codigosMlPorSkuOrigen[skuOrigen.toUpperCase()] || [];
}

/** Devuelve el primer codigo ML (preferencia: composicion trivial sku_venta=sku_origen). */
export function getCodigoMlPrimario(skuOrigen: string): string {
  const so = skuOrigen.toUpperCase();
  // Buscar primero la composicion trivial
  const trivial = _cache.composicion.find(c => c.skuOrigen.toUpperCase() === so && c.skuVenta.toUpperCase() === so);
  if (trivial?.codigoMl) return trivial.codigoMl;
  // Fallback: cualquier composicion del SKU
  return (_cache.codigosMlPorSkuOrigen[so] || [])[0] || "";
}

// ==================== CONSTANTS ====================
export const IN_REASONS: Record<InReason, string> = {
  compra: "Compra de inventario", devolucion: "Devolución",
  ajuste_entrada: "Ajuste (+)", transferencia_in: "Transferencia entrada",
  ajuste_conteo: "Ajuste conteo cíclico",
};
export const OUT_REASONS: Record<OutReason, string> = {
  venta_flex: "Venta Flex", envio_full: "Envío a ML Full",
  ajuste_salida: "Ajuste (-)", merma: "Merma / Pérdida",
  ajuste_conteo: "Ajuste conteo cíclico",
};

// Categorías y proveedores — localStorage para config de UI
const DEFAULT_CATEGORIAS = ["Sábanas", "Toallas", "Quilts", "Almohadas", "Fundas", "Cuero", "Otros"];
const DEFAULT_PROVEEDORES = ["Idetex", "Container", "Biblias", "Mates", "Delart", "Esperanza", "Otro"];

export function getCategorias(): string[] {
  if (typeof window === "undefined") return DEFAULT_CATEGORIAS;
  try { const r = localStorage.getItem("banva_categorias"); if (r) return JSON.parse(r); } catch {}
  return DEFAULT_CATEGORIAS;
}
export function saveCategorias(cats: string[]) {
  if (typeof window !== "undefined") localStorage.setItem("banva_categorias", JSON.stringify(cats));
}
export function getProveedores(): string[] {
  if (typeof window === "undefined") return DEFAULT_PROVEEDORES;
  try { const r = localStorage.getItem("banva_proveedores"); if (r) return JSON.parse(r); } catch {}
  return DEFAULT_PROVEEDORES;
}
export function saveProveedores(provs: string[]) {
  if (typeof window !== "undefined") localStorage.setItem("banva_proveedores", JSON.stringify(provs));
}

// ==================== CACHE ====================
let _cache: StoreData = {
  products: {}, positions: [], stock: {}, stockDetalle: {}, movements: [], movCounter: 0, composicion: [], skuVentaToFisico: {}, codigosMlPorSkuOrigen: {},
};
let _initialized = false;
let _loading = false;

// ==================== INIT (call on mount) ====================
export async function initStore(): Promise<void> {
  if (_initialized || _loading) return;
  if (!isConfigured()) { _initialized = true; return; }
  _loading = true;
  try {
    const [prods, poss, stocks, movs, mapCfg, compVenta, skuVentaToFisico] = await Promise.all([
      db.fetchProductos(),
      db.fetchPosiciones(),
      db.fetchStock(),
      db.fetchMovimientos(500),
      db.fetchMapConfig(),
      db.fetchComposicionVenta(),
      db.fetchSkuVentaToFisicoMap(),
    ]);

    // Products → Record<sku, Product>
    const products: Record<string, Product> = {};
    for (const p of prods) {
      products[p.sku] = {
        sku: p.sku, name: p.nombre,
        cat: p.categoria, prov: p.proveedor, cost: p.costo, costAvg: p.costo_promedio || p.costo || 0,
        price: p.precio, reorder: p.reorder,
        requiresLabel: p.requiere_etiqueta,
        tamano: p.tamano || "", color: p.color || "",
        innerPack: p.inner_pack,
        estadoSku: p.estado_sku ?? null,
      };
    }

    // Positions
    const positions: Position[] = poss.map(p => ({
      id: p.id, label: p.label, type: p.tipo as "pallet" | "shelf",
      active: p.activa, mx: p.mx, my: p.my, mw: p.mw, mh: p.mh, color: p.color,
    }));

    // Stock → StockMap (agregado por sku) + StockDetalleMap (por sku+sku_venta)
    const stock: StockMap = {};
    const stockDetalle: StockDetalleMap = {};
    for (const s of stocks) {
      if (!stock[s.sku]) stock[s.sku] = {};
      stock[s.sku][s.posicion_id] = (stock[s.sku][s.posicion_id] || 0) + s.cantidad;
      // Detalle por sku_venta
      const sv = s.sku_venta || SIN_ETIQUETAR;
      if (!stockDetalle[s.sku]) stockDetalle[s.sku] = {};
      if (!stockDetalle[s.sku][sv]) stockDetalle[s.sku][sv] = {};
      stockDetalle[s.sku][sv][s.posicion_id] = s.cantidad;
    }

    // Movements
    const movements: Movement[] = movs.map(m => ({
      id: m.id || "", ts: m.created_at || "", type: m.tipo === "entrada" ? "in" as const : "out" as const,
      reason: mapMotivo(m.motivo), sku: m.sku, pos: m.posicion_id,
      qty: m.cantidad, who: m.operario, note: m.nota,
    }));

    // Map config
    let mapConfig: MapConfig | undefined;
    if (mapCfg) {
      mapConfig = {
        gridW: mapCfg.grid_w, gridH: mapCfg.grid_h,
        objects: (mapCfg.config as MapObject[]) || [],
      };
    }

    // Composicion venta
    const composicion: ComposicionVenta[] = compVenta.map(c => ({
      skuVenta: c.sku_venta, codigoMl: c.codigo_ml,
      skuOrigen: c.sku_origen, unidades: c.unidades,
      tipoRelacion: c.tipo_relacion || "componente",
      notaOperativa: c.nota_operativa || null,
    }));

    _cache = { products, positions, stock, stockDetalle, movements, movCounter: movements.length, mapConfig, composicion, skuVentaToFisico, codigosMlPorSkuOrigen: buildCodigosMlIndex(composicion) };
    _initialized = true;
  } catch (err) {
    console.error("initStore error:", err);
    _initialized = true;
  }
  _loading = false;
}

// Refresh cache from DB (for polling)
export async function refreshStore(): Promise<boolean> {
  if (!isConfigured()) return false;
  const prev = _initialized;
  _initialized = false;
  _loading = false;
  await initStore();
  return prev; // true if was already initialized (i.e. this is a refresh)
}

function mapMotivo(motivo: string): InReason | OutReason {
  const map: Record<string, InReason | OutReason> = {
    recepcion: "compra", compra: "compra", devolucion: "devolucion",
    ajuste_entrada: "ajuste_entrada", carga_inicial: "ajuste_entrada",
    transferencia_in: "transferencia_in", transferencia_out: "ajuste_salida",
    venta_flex: "venta_flex", envio_full: "envio_full",
    ajuste_salida: "ajuste_salida", merma: "merma", ajuste: "ajuste_entrada",
    ajuste_conteo: "ajuste_conteo",
  };
  return map[motivo] || "ajuste_entrada";
}

function motivoToDB(reason: InReason | OutReason, type: MovType): string {
  if (reason === "compra") return "recepcion";
  return reason;
}

// ==================== SYNC READ (from cache) ====================
export function getStore(): StoreData {
  return _cache;
}

export function isStoreReady(): boolean {
  return _initialized;
}

export function saveStore(_data?: Partial<StoreData>) {
  if (_data) Object.assign(_cache, _data);
  // Debounced flush to Supabase
  scheduleFlush();
}

let _flushTimer: ReturnType<typeof setTimeout> | null = null;

let _movIdCounter = 0;
function uniqueMovId(): string {
  return `M${Date.now()}-${++_movIdCounter}`;
}

function scheduleFlush() {
  if (!isConfigured()) return;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flushToSupabase, 500);
}

async function flushToSupabase() {
  try {
    // Flush products
    const dbProds: db.DBProduct[] = Object.values(_cache.products).map(p => ({
      sku: p.sku, nombre: p.name,
      categoria: p.cat, proveedor: p.prov, costo: p.cost, costo_promedio: p.costAvg, precio: p.price,
      reorder: p.reorder, requiere_etiqueta: p.requiresLabel !== false,
      tamano: p.tamano || "", color: p.color || "",
      inner_pack: p.innerPack ?? null,
      estado_sku: p.estadoSku ?? null,
    }));
    if (dbProds.length > 0) await db.upsertProductos(dbProds);

    // Flush positions
    for (const p of _cache.positions) {
      await db.upsertPosicion({
        id: p.id, label: p.label, tipo: p.type, activa: p.active,
        mx: p.mx || 0, my: p.my || 0, mw: p.mw || 2, mh: p.mh || 2, color: p.color || "#3b82f6",
      });
    }

    // Stock is managed exclusively via delta-based operations (recordMovement/ubicarLinea)
    // to avoid race conditions with concurrent updates. No stock reconciliation here.
  } catch (err) {
    console.error("Flush to Supabase error:", err);
  }
}

export function resetStore() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  _cache = { products: {}, positions: [], stock: {}, stockDetalle: {}, movements: [], movCounter: 0, composicion: [], skuVentaToFisico: {}, codigosMlPorSkuOrigen: {} };
  _initialized = false;
}

// ==================== STOCK HELPERS (sync, from cache) ====================
export function skuTotal(sku: string): number {
  const st = _cache.stock[sku];
  if (!st) return 0;
  return Object.values(st).reduce((a, b) => a + b, 0);
}

export function skuPositions(sku: string): { pos: string; label: string; qty: number }[] {
  const st = _cache.stock[sku];
  if (!st) return [];
  return Object.entries(st)
    .filter(([, q]) => q > 0)
    .map(([posId, qty]) => {
      const p = _cache.positions.find(p => p.id === posId);
      return { pos: posId, label: p ? p.label : `Pos ${posId}`, qty };
    })
    .sort((a, b) => b.qty - a.qty);
}

// Detalle de stock por sku_venta para un SKU origen
export function skuStockDetalle(sku: string): { skuVenta: string; pos: string; label: string; qty: number }[] {
  const detail = _cache.stockDetalle[sku];
  if (!detail) return [];
  const result: { skuVenta: string; pos: string; label: string; qty: number }[] = [];
  for (const [sv, posMap] of Object.entries(detail)) {
    for (const [posId, qty] of Object.entries(posMap)) {
      if (qty <= 0) continue;
      const p = _cache.positions.find(p => p.id === posId);
      result.push({ skuVenta: sv, pos: posId, label: p ? p.label : `Pos ${posId}`, qty });
    }
  }
  return result.sort((a, b) => a.skuVenta.localeCompare(b.skuVenta) || b.qty - a.qty);
}

export function posContents(posId: string): { sku: string; name: string; qty: number }[] {
  const items: { sku: string; name: string; qty: number }[] = [];
  for (const [sku, posMap] of Object.entries(_cache.stock)) {
    if (posMap[posId] && posMap[posId] > 0) {
      const prod = _cache.products[sku];
      items.push({ sku, name: prod?.name || sku, qty: posMap[posId] });
    }
  }
  return items.sort((a, b) => b.qty - a.qty);
}

export function activePositions(): Position[] {
  return _cache.positions.filter(p => p.active);
}

export function findProduct(query: string): Product[] {
  const raw = query.trim();
  if (!raw) return [];

  // Normalize: strip accents, lowercase
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = normalize(raw).split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  // Quick check: if query is an exact SKU venta in composicion_venta, return its SKU origen directly
  if (words.length === 1) {
    const qUpper = raw.toUpperCase();
    const comps = _cache.composicion.filter(c => c.skuVenta.toUpperCase() === qUpper);
    if (comps.length > 0) {
      const seen = new Set<string>();
      const results: Product[] = [];
      for (const c of comps) {
        const p = _cache.products[c.skuOrigen];
        if (p && !seen.has(p.sku)) {
          seen.add(p.sku);
          results.push(p);
        }
      }
      if (results.length > 0) return results;
    }
  }
  
  const scored: { p: Product; score: number }[] = [];
  
  for (const p of Object.values(_cache.products)) {
    const skuN = normalize(p.sku);
    const nameN = normalize(p.name);
    const mlN = normalize(getCodigosMlBySkuOrigen(p.sku).join(","));
    const catN = normalize(p.cat || "");
    const provN = normalize(p.prov || "");
    const haystack = `${skuN} ${nameN} ${mlN} ${catN} ${provN}`;

    let score = 0;
    let allMatch = true;

    for (const w of words) {
      // Exact SKU match = high score
      if (skuN === w) { score += 100; continue; }
      // SKU starts with word
      if (skuN.startsWith(w)) { score += 50; continue; }
      // SKU contains
      if (skuN.includes(w)) { score += 30; continue; }
      // ML code match
      if (mlN && mlN.includes(w)) { score += 40; continue; }
      // Name contains word
      if (nameN.includes(w)) { score += 20; continue; }
      // Any field contains
      if (haystack.includes(w)) { score += 10; continue; }
      // Fuzzy: check if word is close to any token in haystack (1 char tolerance)
      const tokens = haystack.split(/[\s\-_]+/);
      let fuzzyMatch = false;
      for (const tok of tokens) {
        if (tok.length >= 3 && w.length >= 3) {
          // Simple fuzzy: allow 1 char difference for words >= 3 chars
          if (Math.abs(tok.length - w.length) <= 1) {
            let diff = 0;
            const minLen = Math.min(tok.length, w.length);
            for (let i = 0; i < minLen; i++) {
              if (tok[i] !== w[i]) diff++;
            }
            diff += Math.abs(tok.length - w.length);
            if (diff <= 1) { score += 5; fuzzyMatch = true; break; }
          }
          // Substring containment (at least 70% of word found)
          const minSubLen = Math.ceil(w.length * 0.7);
          for (let start = 0; start <= w.length - minSubLen; start++) {
            const sub = w.slice(start, start + minSubLen);
            if (tok.includes(sub)) { score += 3; fuzzyMatch = true; break; }
          }
          if (fuzzyMatch) break;
        }
      }
      if (!fuzzyMatch) { allMatch = false; break; }
    }
    
    if (allMatch && score > 0) {
      scored.push({ p, score });
    }
  }
  
  return scored.sort((a, b) => b.score - a.score).map(x => x.p);
}

export function findPosition(code: string): Position | null {
  const clean = code.replace("BANVA-POS:", "").replace("BANVA-LOC:", "").trim();
  return _cache.positions.find(p => p.id === clean && p.active) || null;
}

// ==================== COMPOSICION VENTA HELPERS ====================

// Dado un código ML, retorna los componentes físicos del pack/combo
export function getComponentesPorML(codigoMl: string): ComposicionVenta[] {
  return _cache.composicion.filter(c => c.codigoMl === codigoMl);
}

// Dado un SKU Venta, retorna los componentes físicos
export function getComponentesPorSkuVenta(skuVenta: string): ComposicionVenta[] {
  const svUpper = skuVenta.toUpperCase();
  return _cache.composicion.filter(c => c.skuVenta === skuVenta || c.skuVenta.toUpperCase() === svUpper);
}

// Dado un SKU Origen (físico), en qué packs/ventas participa
export function getVentasPorSkuOrigen(skuOrigen: string): ComposicionVenta[] {
  return _cache.composicion.filter(c => c.skuOrigen === skuOrigen);
}

// Obtener notas operativas para un SKU Venta (puede haber varias si es combo)
export function getNotasOperativas(skuVenta: string): string[] {
  const svUpper = skuVenta.toUpperCase();
  const notas = _cache.composicion
    .filter(c => (c.skuVenta === skuVenta || c.skuVenta.toUpperCase() === svUpper) && c.notaOperativa)
    .map(c => c.notaOperativa!);
  return Array.from(new Set(notas));
}

// Dado un SKU Venta, busca el SKU físico en la tabla de productos (para productos simples sin composicion_venta)
export function getSkuFisicoPorSkuVenta(skuVenta: string): string | null {
  const svUpper = skuVenta.toUpperCase();
  // 1. Buscar en stockDetalle: si algún SKU físico tiene stock etiquetado con este skuVenta
  for (const [sku, svMap] of Object.entries(_cache.stockDetalle)) {
    if (svMap[skuVenta] || svMap[svUpper]) return sku;
  }
  // 2. Buscar en mapeo ML: seller_sku → SKU físico (via ml_shipment_items + ml_items_map)
  const fromML = _cache.skuVentaToFisico[skuVenta]
    || _cache.skuVentaToFisico[svUpper]
    || _cache.skuVentaToFisico[skuVenta.toLowerCase()];
  if (fromML) return fromML;
  return null;
}

// Todos los SKUs de venta únicos
export function getSkusVenta(): { skuVenta: string; codigoMl: string; componentes: ComposicionVenta[] }[] {
  const map = new Map<string, ComposicionVenta[]>();
  for (const c of _cache.composicion) {
    if (!map.has(c.skuVenta)) map.set(c.skuVenta, []);
    map.get(c.skuVenta)!.push(c);
  }
  return Array.from(map.entries()).map(([skuVenta, comps]) => ({
    skuVenta, codigoMl: comps[0]?.codigoMl || "", componentes: comps,
  }));
}

// Buscar SKUs de venta por nombre o código (para agregar pedidos fácilmente)
export function findSkuVenta(query: string): { skuVenta: string; codigoMl: string; nombre: string; componentes: ComposicionVenta[] }[] {
  const raw = query.trim();
  if (!raw) return [];

  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = normalize(raw).split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  const allSkusVenta = getSkusVenta();
  const scored: { item: { skuVenta: string; codigoMl: string; nombre: string; componentes: ComposicionVenta[] }; score: number }[] = [];

  for (const sv of allSkusVenta) {
    // Build a descriptive name from components (include units if >1)
    const compNames = sv.componentes.map(c => {
      const prod = _cache.products[c.skuOrigen];
      const name = prod?.name || c.skuOrigen;
      return c.unidades > 1 ? `${name} x${c.unidades}` : name;
    });
    const nombre = compNames.join(" + ");

    const skuN = normalize(sv.skuVenta);
    const mlN = normalize(sv.codigoMl || "");
    const nameN = normalize(nombre);
    const haystack = `${skuN} ${mlN} ${nameN}`;

    let score = 0;
    let allMatch = true;

    for (const w of words) {
      if (skuN === w) { score += 100; continue; }
      if (skuN.startsWith(w)) { score += 50; continue; }
      if (skuN.includes(w)) { score += 30; continue; }
      if (mlN && mlN.includes(w)) { score += 40; continue; }
      if (nameN.includes(w)) { score += 20; continue; }
      if (haystack.includes(w)) { score += 10; continue; }
      allMatch = false;
      break;
    }

    if (allMatch && score > 0) {
      scored.push({ item: { ...sv, nombre }, score });
    }
  }

  // Also search products that might be sold directly (not in composicion_venta)
  for (const p of Object.values(_cache.products)) {
    // Skip if already covered by composicion_venta
    if (allSkusVenta.some(sv => sv.skuVenta === p.sku)) continue;

    const skuN = normalize(p.sku);
    const nameN = normalize(p.name);
    const codigos = getCodigosMlBySkuOrigen(p.sku);
    const codigoPrimario = codigos[0] || "";
    const mlN = normalize(codigos.join(","));
    const haystack = `${skuN} ${nameN} ${mlN}`;

    let score = 0;
    let allMatch = true;

    for (const w of words) {
      if (skuN === w) { score += 100; continue; }
      if (skuN.startsWith(w)) { score += 50; continue; }
      if (skuN.includes(w)) { score += 30; continue; }
      if (mlN && mlN.includes(w)) { score += 40; continue; }
      if (nameN.includes(w)) { score += 20; continue; }
      if (haystack.includes(w)) { score += 10; continue; }
      allMatch = false;
      break;
    }

    if (allMatch && score > 0) {
      scored.push({
        item: {
          skuVenta: p.sku,
          codigoMl: codigoPrimario,
          nombre: p.name,
          componentes: [{ skuVenta: p.sku, codigoMl: codigoPrimario, skuOrigen: p.sku, unidades: 1, tipoRelacion: "componente" as const }],
        },
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 20).map(x => x.item);
}

// ==================== ASYNC MUTATIONS ====================

// Auto-etiquetar: si un SKU origen tiene exactamente 1 sku_venta en composicion, retornarlo.
// Si tiene más de uno, retorna null (queda "sin etiquetar").
function resolveAutoSkuVenta(sku: string): string | null {
  const ventas = _cache.composicion.filter(c => c.skuOrigen === sku);
  // Obtener SKUs de venta únicos
  const uniqueSkuVenta = new Set(ventas.map(v => v.skuVenta));
  if (uniqueSkuVenta.size === 1) return ventas[0].skuVenta;
  return null;
}

// Resolve sku_venta variants to decrement for an outbound movement.
// Returns array of { skuVenta, qty } to decrement from each variant.
// When stock has sku_venta assigned, we must pass it to updateStock so the RPC
// matches the correct row (unique key includes sku_venta_key).
function resolveSkuVentaForOut(sku: string, pos: string, totalQty: number): { skuVenta: string | null; qty: number }[] {
  const detalleByVariant = _cache.stockDetalle[sku];
  if (!detalleByVariant) return [{ skuVenta: null, qty: totalQty }];

  // Collect all variants that have stock in this position
  const variants: { skuVenta: string | null; available: number }[] = [];
  for (const [sv, positions] of Object.entries(detalleByVariant)) {
    const available = positions[pos] || 0;
    if (available > 0) {
      variants.push({ skuVenta: sv === SIN_ETIQUETAR ? null : sv, available });
    }
  }

  if (variants.length === 0) return [{ skuVenta: null, qty: totalQty }];

  // Distribute qty across variants (take from each until fulfilled)
  const result: { skuVenta: string | null; qty: number }[] = [];
  let remaining = totalQty;
  for (const v of variants) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, v.available);
    result.push({ skuVenta: v.skuVenta, qty: take });
    remaining -= take;
  }
  return result;
}

// Update stockDetalle cache after a movement
function updateStockDetalleCache(sku: string, pos: string, skuVenta: string | null, delta: number) {
  const sv = skuVenta || SIN_ETIQUETAR;
  if (!_cache.stockDetalle[sku]) _cache.stockDetalle[sku] = {};
  if (!_cache.stockDetalle[sku][sv]) _cache.stockDetalle[sku][sv] = {};
  _cache.stockDetalle[sku][sv][pos] = (_cache.stockDetalle[sku][sv][pos] || 0) + delta;
  if (_cache.stockDetalle[sku][sv][pos] <= 0) {
    delete _cache.stockDetalle[sku][sv][pos];
    if (Object.keys(_cache.stockDetalle[sku][sv]).length === 0) delete _cache.stockDetalle[sku][sv];
  }
}

// Record movement + update stock (writes to Supabase + cache)
export async function recordMovementAsync(m: Omit<Movement, "id">): Promise<Movement> {
  const mov: Movement = { ...m, id: uniqueMovId() };

  // Update cache (clamp "out" to prevent negative stock)
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  let actualQty = m.qty;
  // Usar skuVenta explícito si viene, sino auto-etiquetar si tiene exactamente 1 sku_venta
  const resolvedSkuVenta = m.type === "in" ? (m.skuVenta || resolveAutoSkuVenta(m.sku)) : null;

  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
    updateStockDetalleCache(m.sku, m.pos, resolvedSkuVenta, m.qty);
  } else {
    const prev = _cache.stock[m.sku][m.pos] || 0;
    actualQty = Math.min(m.qty, prev);
    _cache.stock[m.sku][m.pos] = prev - actualQty;
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
  }
  mov.qty = actualQty;
  _cache.movements.unshift(mov);

  // Write to Supabase — atómico (stock + movimiento en una transacción)
  if (isConfigured()) {
    if (m.type === "in") {
      await db.registrarMovimientoStock({
        sku: m.sku, posicion: m.pos, delta: actualQty, tipo: "entrada",
        sku_venta: resolvedSkuVenta, motivo: motivoToDB(m.reason, m.type),
        operario: m.who, nota: m.note,
      });
    } else {
      // Resolve which sku_venta variants to decrement — each gets its own movement
      const chunks = resolveSkuVentaForOut(m.sku, m.pos, actualQty);
      for (const chunk of chunks) {
        await db.registrarMovimientoStock({
          sku: m.sku, posicion: m.pos, delta: -chunk.qty, tipo: "salida",
          sku_venta: chunk.skuVenta, motivo: motivoToDB(m.reason, m.type),
          operario: m.who, nota: m.note,
        });
        updateStockDetalleCache(m.sku, m.pos, chunk.skuVenta, -chunk.qty);
      }
    }
    // Queue SKU for ML stock sync (fire & forget)
    db.enqueueAndSync([m.sku]);
  }
  return mov;
}

export async function updateMovementNote(id: string, note: string) {
  const mov = _cache.movements.find(m => m.id === id);
  if (mov) mov.note = note;
  if (isConfigured()) {
    await db.updateMovimiento(id, { nota: note });
  }
}

// Backward compat sync wrapper (fires async, returns immediately)
export function recordMovement(m: Omit<Movement, "id">): Movement {
  const mov: Movement = { ...m, id: uniqueMovId() };
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  let actualQty = m.qty;

  // Usar skuVenta explícito si viene, sino auto-etiquetar si tiene exactamente 1 sku_venta
  const resolvedSkuVenta = m.type === "in" ? (m.skuVenta || resolveAutoSkuVenta(m.sku)) : null;

  // For outbound, resolve sku_venta variants BEFORE updating cache
  let outChunks: { skuVenta: string | null; qty: number }[] = [];
  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
    updateStockDetalleCache(m.sku, m.pos, resolvedSkuVenta, m.qty);
  } else {
    const prev = _cache.stock[m.sku][m.pos] || 0;
    actualQty = Math.min(m.qty, prev);
    outChunks = resolveSkuVentaForOut(m.sku, m.pos, actualQty);
    _cache.stock[m.sku][m.pos] = prev - actualQty;
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
    // Update detalle cache for each variant
    for (const chunk of outChunks) {
      updateStockDetalleCache(m.sku, m.pos, chunk.skuVenta, -chunk.qty);
    }
  }
  mov.qty = actualQty;
  _cache.movements.unshift(mov);

  // Fire to Supabase — atómico con cache rollback on failure
  if (isConfigured()) {
    if (m.type === "in") {
      db.registrarMovimientoStock({
        sku: m.sku, posicion: m.pos, delta: actualQty, tipo: "entrada",
        sku_venta: resolvedSkuVenta, motivo: motivoToDB(m.reason, m.type),
        operario: m.who, nota: m.note,
      }).catch((err) => {
        console.error("registrarMovimientoStock failed, reverting cache:", err);
        if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
        _cache.stock[m.sku][m.pos] = Math.max(0, (_cache.stock[m.sku][m.pos] || 0) - actualQty);
        if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
        updateStockDetalleCache(m.sku, m.pos, resolvedSkuVenta, -actualQty);
      });
    } else {
      // Fire each variant as its own atomic movement
      for (const chunk of outChunks) {
        db.registrarMovimientoStock({
          sku: m.sku, posicion: m.pos, delta: -chunk.qty, tipo: "salida",
          sku_venta: chunk.skuVenta, motivo: motivoToDB(m.reason, m.type),
          operario: m.who, nota: m.note,
        }).catch((err) => {
          console.error("registrarMovimientoStock failed, reverting cache:", err);
          if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
          _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + chunk.qty;
          updateStockDetalleCache(m.sku, m.pos, chunk.skuVenta, chunk.qty);
        });
      }
    }
    // Queue SKU for ML stock sync
    db.enqueueAndSync([m.sku]);
  }
  return mov;
}

export function recordBulkMovements(
  items: { sku: string; pos: string; qty: number }[],
  type: MovType, reason: InReason | OutReason, who: string, note: string
): number {
  let count = 0;
  for (const item of items) {
    if (!item.sku || !item.pos || item.qty <= 0) continue;
    recordMovement({
      ts: new Date().toISOString(), type, reason,
      sku: item.sku, pos: item.pos, qty: item.qty, who, note,
    });
    count++;
  }
  return count;
}

// Product CRUD (async)
export async function saveProductAsync(p: Product) {
  _cache.products[p.sku] = p;
  if (isConfigured()) {
    await db.upsertProducto({
      sku: p.sku, nombre: p.name,
      categoria: p.cat, proveedor: p.prov, costo: p.cost, costo_promedio: p.costAvg, precio: p.price,
      reorder: p.reorder, requiere_etiqueta: p.requiresLabel !== false,
      tamano: p.tamano || "", color: p.color || "",
      inner_pack: p.innerPack ?? null,
    });
  }
}

export async function deleteProductAsync(sku: string) {
  const hasStock = skuTotal(sku) > 0;
  if (hasStock) {
    delete _cache.stock[sku];
    if (isConfigured()) await db.deleteStockBySku(sku);
  }
  delete _cache.products[sku];
  if (isConfigured()) await db.deleteProducto(sku);
}

// Position CRUD (async)
export async function savePosAsync(p: Position) {
  const idx = _cache.positions.findIndex(x => x.id === p.id);
  if (idx >= 0) _cache.positions[idx] = p; else _cache.positions.push(p);
  if (isConfigured()) {
    await db.upsertPosicion({
      id: p.id, label: p.label, tipo: p.type, activa: p.active,
      mx: p.mx || 0, my: p.my || 0, mw: p.mw || 2, mh: p.mh || 2, color: p.color || "#3b82f6",
    });
  }
}

export async function deletePosAsync(id: string) {
  _cache.positions = _cache.positions.filter(p => p.id !== id);
  if (isConfigured()) await db.deletePosicion(id);
}

// ==================== MAP CONFIG ====================
export function getMapConfig(): MapConfig {
  if (_cache.mapConfig) return _cache.mapConfig;
  return { gridW: 20, gridH: 14, objects: [
    { id: "door1", label: "ENTRADA", kind: "door", mx: 0, my: 5, mw: 1, mh: 3, color: "#f59e0b" },
    { id: "desk1", label: "Escritorio", kind: "desk", mx: 1, my: 1, mw: 3, mh: 2, color: "#6366f1" },
  ]};
}

export function saveMapConfig(cfg: MapConfig) {
  _cache.mapConfig = cfg;
  if (isConfigured()) {
    db.saveMapConfigDB({
      id: "main", config: cfg.objects as unknown[],
      grid_w: cfg.gridW, grid_h: cfg.gridH,
    }).catch(console.error);
  }
}

export function savePositionMap(posId: string, mx: number, my: number, mw: number, mh: number) {
  const p = _cache.positions.find(x => x.id === posId);
  if (p) {
    p.mx = mx; p.my = my; p.mw = mw; p.mh = mh;
    if (isConfigured()) {
      db.updatePosicion(posId, { mx, my, mw, mh }).catch(console.error);
    }
  }
}

// ==================== SHEET SYNC ====================
export async function syncFromSheet(): Promise<{ added: number; updated: number; total: number; composicionTotal: number }> {
  const result = await db.syncDiccionarioFromSheet();

  // Refresh products in cache
  const prods = await db.fetchProductos();
  _cache.products = {};
  for (const p of prods) {
    _cache.products[p.sku] = {
      sku: p.sku, name: p.nombre,
      cat: p.categoria, prov: p.proveedor, cost: p.costo, costAvg: p.costo_promedio || p.costo || 0,
      price: p.precio, reorder: p.reorder,
      requiresLabel: p.requiere_etiqueta,
      tamano: p.tamano || "", color: p.color || "",
    };
  }

  // Refresh composicion cache
  const compVenta = await db.fetchComposicionVenta();
  _cache.composicion = compVenta.map(c => ({
    skuVenta: c.sku_venta, codigoMl: c.codigo_ml,
    skuOrigen: c.sku_origen, unidades: c.unidades,
    tipoRelacion: c.tipo_relacion || "componente",
    notaOperativa: c.nota_operativa || null,
  }));
  _cache.codigosMlPorSkuOrigen = buildCodigosMlIndex(_cache.composicion);

  console.log(`[sync] composicion from CSV: ${result.composicion.total}, from DB: ${compVenta.length}, cache: ${_cache.composicion.length}`);

  if (typeof window !== "undefined") {
    localStorage.setItem("banva_sheet_last_sync", Date.now().toString());
  }
  // Trigger: proveedor cargado (diccionario de productos actualizado)
  import("./agents-triggers").then(m => m.dispararTrigger("proveedor_cargado")).catch(() => {});
  // Auto-vincular productos nuevos en ml_items_map (fire & forget)
  fetch("/api/ml/link-missing", { method: "POST" }).catch(() => {});
  return { ...result.productos, composicionTotal: result.composicion.total };
}

export function shouldSync(): boolean {
  if (typeof window === "undefined") return false;
  const last = localStorage.getItem("banva_sheet_last_sync");
  if (!last) return true;
  return Date.now() - parseInt(last) > 5 * 60 * 1000;
}

export function getLastSyncTime(): string | null {
  if (typeof window === "undefined") return null;
  const last = localStorage.getItem("banva_sheet_last_sync");
  if (!last) return null;
  try { return new Date(parseInt(last)).toLocaleString("es-CL"); } catch { return null; }
}

// ==================== STOCK IMPORT ====================
export function wasStockImported(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("banva_stock_imported") === "1";
}

export async function importStockFromSheet(): Promise<{ imported: number; skipped: number; totalUnits: number }> {
  const result = await db.importStockFromSheet();
  if (typeof window !== "undefined") localStorage.setItem("banva_stock_imported", "1");
  // Refresh stock cache
  const stocks = await db.fetchStock();
  _cache.stock = {};
  _cache.stockDetalle = {};
  for (const s of stocks) {
    if (!_cache.stock[s.sku]) _cache.stock[s.sku] = {};
    _cache.stock[s.sku][s.posicion_id] = (_cache.stock[s.sku][s.posicion_id] || 0) + s.cantidad;
    const sv = s.sku_venta || SIN_ETIQUETAR;
    if (!_cache.stockDetalle[s.sku]) _cache.stockDetalle[s.sku] = {};
    if (!_cache.stockDetalle[s.sku][sv]) _cache.stockDetalle[s.sku][sv] = {};
    _cache.stockDetalle[s.sku][sv][s.posicion_id] = s.cantidad;
  }
  return { ...result, skipped: 0 };
}

export function getUnassignedStock(): { sku: string; name: string; qty: number }[] {
  const items: { sku: string; name: string; qty: number }[] = [];
  for (const [sku, posMap] of Object.entries(_cache.stock)) {
    const qty = posMap["SIN_ASIGNAR"] || 0;
    if (qty > 0) {
      const prod = _cache.products[sku];
      items.push({ sku, name: prod?.name || sku, qty });
    }
  }
  return items.sort((a, b) => b.qty - a.qty);
}

export function assignPosition(sku: string, targetPos: string, qty: number): boolean {
  if (!_cache.stock[sku]?.["SIN_ASIGNAR"] || _cache.stock[sku]["SIN_ASIGNAR"] < qty) return false;

  // Auto-etiquetar al asignar posición
  const autoSv = resolveAutoSkuVenta(sku);

  // Update cache synchronously
  _cache.stock[sku]["SIN_ASIGNAR"] -= qty;
  if (_cache.stock[sku]["SIN_ASIGNAR"] <= 0) delete _cache.stock[sku]["SIN_ASIGNAR"];
  if (!_cache.stock[sku][targetPos]) _cache.stock[sku][targetPos] = 0;
  _cache.stock[sku][targetPos] += qty;
  // Update detalle cache
  updateStockDetalleCache(sku, "SIN_ASIGNAR", null, -qty);
  updateStockDetalleCache(sku, targetPos, autoSv, qty);

  // Fire & forget to Supabase — 2 movimientos atómicos (salida + entrada)
  if (isConfigured()) {
    (async () => {
      await db.registrarMovimientoStock({
        sku, posicion: "SIN_ASIGNAR", delta: -qty, tipo: "transferencia",
        motivo: "transferencia_out", operario: "Admin",
        nota: "Asignación → " + targetPos,
      });
      await db.registrarMovimientoStock({
        sku, posicion: targetPos, delta: qty, tipo: "transferencia",
        sku_venta: autoSv, motivo: "transferencia_in", operario: "Admin",
        nota: "Asignación ← SIN_ASIGNAR" + (autoSv ? ` [${autoSv}]` : ""),
      });
    })().catch(console.error);
  }
  db.enqueueAndSync([sku]);
  return true;
}

// ==================== RECEPCIONES (NEW) ====================
export type { DBRecepcion, DBRecepcionLinea, DBOperario } from "./db";

export async function getRecepciones() { return db.fetchRecepciones(); }
export async function getRecepcionesActivas() { return db.fetchRecepcionesActivas(); }
export async function getRecepcionLineas(recId: string) { return db.fetchRecepcionLineas(recId); }

export async function crearRecepcion(folio: string, proveedor: string, imagenUrl: string, lineas: { sku: string; codigoML: string; nombre: string; cantidad: number; costo: number; requiereEtiqueta: boolean }[], costos?: { costo_neto?: number; iva?: number; costo_bruto?: number }): Promise<string | null> {
  // Calcular factura_original snapshot antes de insertar
  const netoCalc = lineas.reduce((s, l) => s + l.cantidad * l.costo, 0);
  const facturaOriginal: db.FacturaOriginal = {
    lineas: lineas.map(l => ({ sku: l.sku, nombre: l.nombre, cantidad: l.cantidad, costo_unitario: l.costo })),
    neto: costos?.costo_neto || netoCalc,
    iva: costos?.iva || Math.round(netoCalc * 0.19),
    bruto: costos?.costo_bruto || Math.round(netoCalc * 1.19),
  };

  const id = await db.insertRecepcion({
    folio, proveedor, imagen_url: imagenUrl, estado: "CREADA",
    notas: "", created_by: "admin",
    ...(costos || {}),
    factura_original: facturaOriginal,
  });
  if (!id) return null;

  const dbLineas = lineas.map(l => {
    // Auto-asignar sku_venta desde composicion_venta
    const autoFormato = _resolverFormatoVenta(l.sku);
    return {
      recepcion_id: id, sku: l.sku, codigo_ml: l.codigoML,
      nombre: l.nombre, qty_factura: l.cantidad, qty_recibida: 0,
      qty_etiquetada: 0, qty_ubicada: 0, estado: "PENDIENTE" as const,
      requiere_etiqueta: autoFormato ? true : l.requiereEtiqueta,
      costo_unitario: l.costo,
      sku_venta: autoFormato || undefined,
      notas: "", operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "",
    };
  });
  await db.insertRecepcionLineas(dbLineas);
  return id;
}

// Resuelve automáticamente el formato de venta para un SKU origen.
// Solo auto-etiqueta cuando hay exactamente 1 sku_venta único.
// Si hay múltiples (p.ej. X1 + X2), retorna null para que el admin decida
// al momento de picking — un SKU físico con formato individual + pack no
// debe pre-comprometerse a uno u otro hasta saber qué se está vendiendo.
function _resolverFormatoVenta(sku: string): string | null {
  const ventas = getVentasPorSkuOrigen(sku);
  if (ventas.length === 0) return null;
  const uniqueVentas = ventas.filter((v, i, a) => a.findIndex(x => x.skuVenta === v.skuVenta) === i);
  if (uniqueVentas.length === 1) return uniqueVentas[0].skuVenta;
  return null;
}

export async function actualizarRecepcion(id: string, fields: Partial<db.DBRecepcion>) {
  await db.updateRecepcion(id, fields);
}

export async function actualizarLineaRecepcion(id: string, fields: Partial<db.DBRecepcionLinea>) {
  await db.updateRecepcionLinea(id, fields);
}

/**
 * Sincroniza el costo_unitario de los movimientos de entrada existentes de
 * una recepción para un SKU dado, y recalcula productos.costo_promedio como
 * promedio ponderado real sobre todas las entradas con costo del SKU.
 *
 * Usar cuando se edita el costo de una línea ya ubicada (factura original
 * corregida a posteriori), para que la cache de costo promedio y el audit
 * trail de movimientos reflejen el costo correcto.
 */
/**
 * Sincronizar costo unitario de movimientos de una recepción + recalcular WAC (Chunk 3).
 *
 * Usado cuando el admin edita el costo unitario de una línea de recepción.
 * El recálculo del WAC delega en recalcular_wac_running (canónico v102).
 */
export async function sincronizarCostoMovimientosRecepcion(
  skuOrigen: string,
  recepcionId: string,
  nuevoCostoUnitario: number,
) {
  const sb = db.getSupabase();
  if (!sb) return;
  const skuUp = (skuOrigen || "").toUpperCase().trim();
  if (!skuUp || !recepcionId) return;

  // 1. Update movimientos de entrada de esta recepción+sku con el nuevo costo
  await sb.from("movimientos").update({ costo_unitario: nuevoCostoUnitario })
    .eq("recepcion_id", recepcionId)
    .eq("sku", skuUp)
    .eq("tipo", "entrada");

  // 2. Delegar recálculo WAC al canónico (NIC 2 stock_total + fallback opción C)
  const { data: wacData, error: wacErr } = await sb.rpc("recalcular_wac_running", { p_sku: skuUp });
  if (wacErr) console.error(`[sincronizarCostoMovimientosRecepcion] recalcular_wac_running: ${wacErr.message}`);
  const nuevoPromedio = (wacData as number | null) ?? 0;
  if (_cache.products[skuUp]) _cache.products[skuUp].costAvg = nuevoPromedio;

  await db.auditLog("sincronizarCostoMovimientosRecepcion", {
    entidad: "recepcion", entidad_id: recepcionId, operario: "admin",
    params: { sku: skuUp, nuevoCostoUnitario },
    resultado: { movs_actualizados: true, wac_post: nuevoPromedio },
  });
}

/**
 * @deprecated Eliminado en Chunk 3 (2026-05-05). Sustituido por:
 *   aprobarNuevoCosto(discId, sku, costo, { esPuntual: false }) — para
 *   aprobaciones que cambian el catálogo + recompute ventas_ml_cache.
 *
 * Tipo conservado solo para typecheck transitorio en UI legacy.
 * Eliminar cuando AdminDiscrepancias migre a flujo v2.
 */
export interface CongelarCostoPreview {
  discrepanciaId: string;
  sku: string;
  recepcionId: string;
  costoAplicar: number;
  costoFacturaActual: number;
  wacAnterior: number;
  wacSimulado: number;
  cutoff: string;
  ventasAfectadas: number;
  margenDelta: number;
  detalles: Array<{
    order_id: string;
    sku_venta: string;
    fecha: string;
    costo_anterior: number;
    costo_nuevo: number;
    margen_anterior: number;
    margen_nuevo: number;
    margen_neto_anterior: number;
    margen_neto_nuevo: number;
  }>;
}

/**
 * @deprecated Eliminado en Chunk 3 (2026-05-05). Stub solo para compatibilidad
 * de typecheck con UI legacy. Llamarla tira error explícito.
 * Migración: aprobarNuevoCosto(discId, sku, costo, { esPuntual: false }).
 */
export async function congelarCostoDiscrepancia(
  _discrepanciaId: string,
  _costoAplicar: number | null,
  _dryRun: boolean,
): Promise<CongelarCostoPreview> {
  throw new Error(
    "congelarCostoDiscrepancia fue eliminado en Chunk 3. Usar aprobarNuevoCosto(discId, sku, costo, { esPuntual: false }).",
  );
}

// Reset línea a PENDIENTE — revierte stock si ya fue ubicada
export async function resetearLineaRecepcion(lineaId: string, recepcionId: string) {
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const linea = lineas.find(l => l.id === lineaId);
  if (!linea) return;

  // Si tiene stock ubicado, revertirlo
  const qtyUbicada = linea.qty_ubicada || 0;
  if (qtyUbicada > 0 && isConfigured()) {
    // Buscar en qué posiciones se ubicó (desde movimientos)
    const movimientos = await db.fetchMovimientosByRecepcion(recepcionId);
    const movsLinea = movimientos.filter(m => m.sku === linea.sku && m.tipo === "entrada" && m.motivo === "recepcion");

    for (const mov of movsLinea) {
      await db.registrarMovimientoStock({
        sku: linea.sku, posicion: mov.posicion_id, delta: -mov.cantidad, tipo: "salida",
        motivo: "reset_linea", operario: "admin", recepcion_id: recepcionId,
        nota: `Reset línea: revertir ${mov.cantidad} uds de ${mov.posicion_id}`,
      });
    }

    // Update cache
    if (_cache.stock[linea.sku]) {
      for (const mov of movsLinea) {
        if (_cache.stock[linea.sku][mov.posicion_id]) {
          _cache.stock[linea.sku][mov.posicion_id] = Math.max(0, _cache.stock[linea.sku][mov.posicion_id] - mov.cantidad);
          if (_cache.stock[linea.sku][mov.posicion_id] === 0) delete _cache.stock[linea.sku][mov.posicion_id];
        }
      }
    }
  }

  // Limpiar la línea
  await db.updateRecepcionLinea(lineaId, {
    estado: "PENDIENTE", qty_recibida: 0, qty_etiquetada: 0, qty_ubicada: 0,
    operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "",
    ts_conteo: undefined, ts_etiquetado: undefined, ts_ubicacion: undefined,
  });

  await db.auditLog("resetearLinea", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario: "admin",
    params: { sku: linea.sku, recepcionId, qtyUbicadaRevertida: qtyUbicada },
  });
}

// Contar línea: operario confirma cantidad de esta caja (acumulativo)
export async function contarLinea(lineaId: string, qtyCaja: number, operario: string, recepcionId: string) {
  // Fetch current line to accumulate
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const linea = lineas.find(l => l.id === lineaId);
  const prevRecibida = linea?.qty_recibida || 0;
  const newQtyRecibida = prevRecibida + qtyCaja;
  await db.updateRecepcionLinea(lineaId, {
    qty_recibida: newQtyRecibida, estado: "CONTADA",
    operario_conteo: operario, ts_conteo: new Date().toISOString(),
  });
  await db.auditLog("contarLinea", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario,
    params: { sku: linea?.sku, recepcionId, qtyCaja },
    resultado: { prevRecibida, newQtyRecibida },
  });
}

// Etiquetar línea: operario marca unidades etiquetadas
export async function etiquetarLinea(lineaId: string, qtyEtiquetada: number, operario: string, totalLinea: number) {
  const estado = qtyEtiquetada >= totalLinea ? "ETIQUETADA" : "EN_ETIQUETADO";
  await db.updateRecepcionLinea(lineaId, {
    qty_etiquetada: qtyEtiquetada, estado,
    operario_etiquetado: operario,
    ...(estado === "ETIQUETADA" ? { ts_etiquetado: new Date().toISOString() } : {}),
  });
  await db.auditLog("etiquetarLinea", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario,
    params: { qtyEtiquetada, totalLinea, estado },
  });
}

// Ubicar línea: operario pone en posición → stock entra al WMS
export async function ubicarLinea(lineaId: string, sku: string, posicionId: string, qty: number, operario: string, recepcionId: string, opts?: { skuVenta?: string | null; folio?: string; proveedor?: string }) {
  // Si no viene skuVenta explícito, auto-etiquetar si el SKU tiene exactamente 1 formato de venta
  const skuVenta = opts?.skuVenta ?? resolveAutoSkuVenta(sku);
  // Build nota with invoice info
  let nota = "Recepción - ubicación en bodega";
  if (opts?.folio) {
    nota = `Recepción - Factura #${opts.folio}`;
    if (opts?.proveedor) nota += ` - ${opts.proveedor}`;
  }
  if (skuVenta) nota += ` [${skuVenta}]`;

  // Audit: log the call params BEFORE doing anything
  await db.auditLog("ubicarLinea", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario,
    params: { sku, posicionId, qty, recepcionId, skuVenta, folio: opts?.folio },
  });

  // Leer costo unitario de la línea de recepción
  let costoUnitario: number | null = null;
  try {
    const lineasCosto = await db.fetchRecepcionLineas(recepcionId);
    const lineaData = lineasCosto.find(l => l.id === lineaId);
    if (lineaData?.costo_unitario) costoUnitario = lineaData.costo_unitario;
  } catch { /* si falla, seguimos sin costo */ }

  // Update stock + movimiento + costo promedio atómicamente — if fails, do NOT update the line
  if (isConfigured()) {
    try {
      await db.registrarMovimientoStock({
        sku, posicion: posicionId, delta: qty, tipo: "entrada",
        sku_venta: skuVenta, motivo: "recepcion",
        operario, nota, recepcion_id: recepcionId,
        costo_unitario: costoUnitario,
      });
      db.enqueueAndSync([sku]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.auditLog("ubicarLinea:error", {
        entidad: "recepcion_linea", entidad_id: lineaId, operario,
        params: { sku, posicionId, qty }, error: msg,
      });
      throw new Error(`Error al registrar stock de ${sku}: ${msg}. La linea NO fue marcada como ubicada.`);
    }
  }

  // Update cache (aggregated) — ANTES de recalcular costAvg
  const stockAntes = skuTotal(sku);
  if (!_cache.stock[sku]) _cache.stock[sku] = {};
  _cache.stock[sku][posicionId] = (_cache.stock[sku][posicionId] || 0) + qty;

  // Actualizar costo promedio en cache
  if (costoUnitario && _cache.products[sku]) {
    const p = _cache.products[sku];
    if (stockAntes <= 0) {
      p.costAvg = costoUnitario;
    } else {
      p.costAvg = Math.round(((stockAntes * p.costAvg) + (qty * costoUnitario)) / (stockAntes + qty) * 100) / 100;
    }
  }
  // Update detailed cache
  const sv = skuVenta || SIN_ETIQUETAR;
  if (!_cache.stockDetalle[sku]) _cache.stockDetalle[sku] = {};
  if (!_cache.stockDetalle[sku][sv]) _cache.stockDetalle[sku][sv] = {};
  _cache.stockDetalle[sku][sv][posicionId] = (_cache.stockDetalle[sku][sv][posicionId] || 0) + qty;

  // Derive qty_ubicada from movimientos (single source of truth)
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const linea = lineas.find(l => l.id === lineaId);
  if (!linea) return;
  const prevQtyUbicada = linea.qty_ubicada || 0;
  const sb = db.getSupabase();
  const { data: calcResult } = sb
    ? await sb.rpc("calcular_qty_ubicada", { p_recepcion_id: recepcionId, p_sku: sku })
    : { data: null };
  const newQtyUbicada = (calcResult as number) ?? (prevQtyUbicada + qty);
  const qtyTotal = linea.qty_recibida || linea.qty_factura || 0;

  const allLocated = newQtyUbicada >= qtyTotal && qtyTotal > 0;
  let nextEstado = linea.estado;
  const extraFields: Partial<db.DBRecepcionLinea> = {};

  if (allLocated) {
    nextEstado = "UBICADA";
    extraFields.ts_ubicacion = new Date().toISOString();
  }

  await db.updateRecepcionLinea(lineaId, {
    qty_ubicada: newQtyUbicada,
    estado: nextEstado,
    operario_ubicacion: operario,
    ...extraFields,
  });

  // Audit: log result with before/after + derivation method
  await db.auditLog("ubicarLinea:ok", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario,
    resultado: { sku, posicionId, qty, prevQtyUbicada, newQtyUbicada, qtyTotal, estado: nextEstado, derivado: calcResult !== null },
  });

  // Auto-add to envio_full if this SKU is in envio_full_pendiente
  if (isConfigured()) {
    try {
      const pendientes = await db.fetchEnvioFullPendiente();
      const match = pendientes.find(p => p.sku === sku && p.cantidad_agregada < p.cantidad);
      if (match && match.picking_session_id) {
        // Find the active picking session first so the session is the source of truth
        const sessions = await db.getActivePickingSessions();
        const session = sessions.find(s => s.id === match.picking_session_id);
        if (session && session.tipo === "envio_full") {
          // Count units of this sku already present in the session (manual adds + previous auto-adds)
          const yaEnSesion = session.lineas.reduce((sum, l) => {
            const comp = l.componentes[0];
            if (!comp) return sum;
            if (comp.skuOrigen === sku || l.skuVenta === sku) return sum + (l.qtyPedida || comp.unidades || 0);
            return sum;
          }, 0);
          const falta = Math.max(0, match.cantidad - yaEnSesion);
          const agregar = Math.min(falta, qty);
          if (agregar > 0) {
            const nextId = `FA${String(session.lineas.length + 1).padStart(3, "0")}`;
            const skuVentaLine = match.sku_venta || sku;
            const newLinea: db.PickingLinea = {
              id: nextId,
              skuVenta: skuVentaLine,
              qtyPedida: agregar,
              estado: "PENDIENTE" as const,
              componentes: [{
                skuOrigen: sku,
                codigoMl: "",
                nombre: _cache.products[sku]?.name || sku,
                unidades: agregar,
                posicion: posicionId,
                posLabel: posicionId,
                stockDisponible: qty,
                estado: "PENDIENTE" as const,
                pickedAt: null,
                operario: null,
              }],
              skuOrigen: sku,
              tipoFull: "simple" as const,
              qtyFisica: agregar,
              qtyVenta: agregar,
              unidadesPorPack: 1,
            };

            // Add line atomically — append the new linea without clobbering concurrent writes
            await db.agregarLineaPicking(session.id!, newLinea);

            // Reserve stock
            await db.reservarStock(sku, agregar);

            // Sync cola so cantidad_agregada reflects reality (yaEnSesion + agregar)
            await db.updateEnvioFullPendiente(match.id!, { cantidad_agregada: yaEnSesion + agregar });

            await db.auditLog("envioFullPendiente:auto_add", {
              entidad: "picking_session", entidad_id: session.id!, operario,
              resultado: { sku, posicionId, qty: agregar, lineaId: nextId, skuVenta: skuVentaLine, pendienteId: match.id, yaEnSesion, falta },
            });
          }
        }
      }
    } catch (e) {
      // Non-blocking — if auto-add fails, stock is still in bodega
      console.error("[envioFullPendiente] auto-add failed:", e);
    }
  }
}

// Recalculate qty_ubicada from movimientos for all lines in a reception
export async function recalcularQtyUbicadaRecepcion(recepcionId: string): Promise<{ sku: string; antes: number; despues: number }[]> {
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const sb = db.getSupabase();
  if (!sb) return [];
  const cambios: { sku: string; antes: number; despues: number }[] = [];
  for (const l of lineas) {
    const { data: calc } = await sb.rpc("calcular_qty_ubicada", { p_recepcion_id: recepcionId, p_sku: l.sku });
    const real = (calc as number) ?? 0;
    const actual = l.qty_ubicada || 0;
    if (real !== actual) {
      await db.updateRecepcionLinea(l.id!, { qty_ubicada: real });
      cambios.push({ sku: l.sku, antes: actual, despues: real });
    }
  }
  return cambios;
}

// ==================== REASIGNAR FORMATO DE VENTA ====================
// Mueve stock de sku_venta=NULL (sin etiquetar) a un sku_venta específico
export async function reasignarFormato(
  sku: string,
  posicionId: string,
  qty: number,
  nuevoSkuVenta: string,
) {
  if (qty <= 0) return;
  if (!isConfigured()) throw new Error("Supabase no configurado");

  // 2 movimientos atómicos: salida sin etiquetar + entrada con nuevo formato.
  // Tipo restringido por movimientos_tipo_check a entrada|salida|transferencia.
  await db.registrarMovimientoStock({
    sku, posicion: posicionId, delta: -qty, tipo: "salida",
    sku_venta: null, motivo: "reasignacion_formato", operario: "admin",
    nota: `Reasignación formato: Sin etiquetar → ${nuevoSkuVenta} (${qty} uds) [salida]`,
  });
  await db.registrarMovimientoStock({
    sku, posicion: posicionId, delta: qty, tipo: "entrada",
    sku_venta: nuevoSkuVenta, motivo: "reasignacion_formato", operario: "admin",
    nota: `Reasignación formato: Sin etiquetar → ${nuevoSkuVenta} (${qty} uds) [entrada]`,
  });

  // Actualizar cache
  const sinEt = SIN_ETIQUETAR;
  if (_cache.stockDetalle[sku]?.[sinEt]?.[posicionId]) {
    _cache.stockDetalle[sku][sinEt][posicionId] = Math.max(0, _cache.stockDetalle[sku][sinEt][posicionId] - qty);
    if (_cache.stockDetalle[sku][sinEt][posicionId] <= 0) delete _cache.stockDetalle[sku][sinEt][posicionId];
  }
  if (!_cache.stockDetalle[sku]) _cache.stockDetalle[sku] = {};
  if (!_cache.stockDetalle[sku][nuevoSkuVenta]) _cache.stockDetalle[sku][nuevoSkuVenta] = {};
  _cache.stockDetalle[sku][nuevoSkuVenta][posicionId] = (_cache.stockDetalle[sku][nuevoSkuVenta][posicionId] || 0) + qty;
  // stock agregado no cambia (misma posición, mismo SKU, solo cambia sku_venta)
}

// ==================== EDITAR STOCK POR VARIANTE ====================
// Permite al admin editar la cantidad de una variante de sku_venta en una posición
export async function editarStockVariante(
  sku: string,
  posicionId: string,
  skuVenta: string | null,
  nuevaCantidad: number,
) {
  if (!isConfigured()) throw new Error("Supabase no configurado");
  if (nuevaCantidad < 0) throw new Error("La cantidad no puede ser negativa");

  const sv = skuVenta || SIN_ETIQUETAR;
  const actual = _cache.stockDetalle[sku]?.[sv]?.[posicionId] || 0;
  const delta = nuevaCantidad - actual;
  if (delta === 0) return;

  // Actualizar stock + registrar movimiento atómicamente
  const etiqueta = skuVenta || "Sin etiquetar";
  await db.registrarMovimientoStock({
    sku, posicion: posicionId, delta, tipo: delta > 0 ? "entrada" : "salida",
    sku_venta: skuVenta, motivo: delta > 0 ? "ajuste_entrada" : "ajuste_salida",
    operario: "admin",
    nota: `Ajuste manual variante [${etiqueta}]: ${actual} → ${nuevaCantidad}`,
  });

  // Actualizar cache stockDetalle
  if (!_cache.stockDetalle[sku]) _cache.stockDetalle[sku] = {};
  if (!_cache.stockDetalle[sku][sv]) _cache.stockDetalle[sku][sv] = {};
  if (nuevaCantidad <= 0) {
    delete _cache.stockDetalle[sku][sv][posicionId];
    if (Object.keys(_cache.stockDetalle[sku][sv]).length === 0) delete _cache.stockDetalle[sku][sv];
  } else {
    _cache.stockDetalle[sku][sv][posicionId] = nuevaCantidad;
  }

  // Actualizar cache stock agregado
  if (!_cache.stock[sku]) _cache.stock[sku] = {};
  _cache.stock[sku][posicionId] = (_cache.stock[sku][posicionId] || 0) + delta;
  if (_cache.stock[sku][posicionId] <= 0) delete _cache.stock[sku][posicionId];

  // Queue sync
  db.enqueueAndSync([sku]);
}

// ==================== ADMIN LINE ADJUSTMENT ====================
// When admin edits qty_ubicada, adjust stock + create adjustment movement
export async function ajustarLineaAdmin(
  lineaId: string,
  recepcionId: string,
  sku: string,
  oldQtyUbicada: number,
  newQtyUbicada: number,
) {
  const delta = newQtyUbicada - oldQtyUbicada;
  if (delta === 0) return;

  await db.auditLog("ajustarLineaAdmin", {
    entidad: "recepcion_linea", entidad_id: lineaId, operario: "admin",
    params: { sku, recepcionId, oldQtyUbicada, newQtyUbicada, delta },
  });

  // Find the position used in the original movements for this SKU+recepcion
  const movimientos = await db.fetchMovimientosByRecepcion(recepcionId);
  const movsLinea = movimientos.filter(m => m.sku === sku && m.tipo === "entrada" && m.motivo === "recepcion");
  // Use the last known position, or SIN_ASIGNAR as fallback
  const posicion = movsLinea.length > 0 ? movsLinea[movsLinea.length - 1].posicion_id : "SIN_ASIGNAR";

  // Auto-etiquetar si delta positivo (entrada)
  const autoSv = delta > 0 ? resolveAutoSkuVenta(sku) : null;

  // Adjust stock + movimiento atómicamente
  await db.registrarMovimientoStock({
    sku, posicion, delta, tipo: delta > 0 ? "entrada" : "salida",
    sku_venta: autoSv, motivo: "recepcion",
    operario: "admin", recepcion_id: recepcionId,
    nota: `Ajuste admin: ${oldQtyUbicada} → ${newQtyUbicada} (${delta > 0 ? "+" : ""}${delta})` + (autoSv ? ` [${autoSv}]` : ""),
  });
  db.enqueueAndSync([sku]);

  // Re-derive qty_ubicada from movimientos and update the line
  const sb = db.getSupabase();
  if (sb) {
    const { data: calcResult } = await sb.rpc("calcular_qty_ubicada", { p_recepcion_id: recepcionId, p_sku: sku });
    if (calcResult !== null) {
      await db.updateRecepcionLinea(lineaId, { qty_ubicada: calcResult as number });
    }
  }

  // Update cache
  if (!_cache.stock[sku]) _cache.stock[sku] = {};
  _cache.stock[sku][posicion] = (_cache.stock[sku][posicion] || 0) + delta;
  updateStockDetalleCache(sku, posicion, autoSv, delta);
}

// ==================== AUDIT & REPAIR ====================
export interface AuditResult {
  linea_id: string;
  sku: string;
  nombre: string;
  qty_ubicada: number;
  estado: string;
  movimientos_encontrados: number;
  stock_actual: number;
  problema: string;
  reparado: boolean;
  detalle: string;
}

export async function auditarRecepcion(recepcionId: string): Promise<AuditResult[]> {
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const movimientos = await db.fetchMovimientosByRecepcion(recepcionId);
  const stockAll = await db.fetchStock();
  const productos = await db.fetchProductos();
  const productoSet = new Set(productos.map(p => p.sku));

  const results: AuditResult[] = [];

  for (const l of lineas) {
    // Only audit lines that claim to have ubicada qty
    if ((l.qty_ubicada || 0) === 0) continue;

    const movsLinea = movimientos.filter(m => m.sku === l.sku && m.tipo === "entrada" && m.motivo === "recepcion");
    const totalMovido = movsLinea.reduce((sum, m) => sum + m.cantidad, 0);
    const stockLinea = stockAll.filter(s => s.sku === l.sku).reduce((sum, s) => sum + s.cantidad, 0);
    const existeProducto = productoSet.has(l.sku);

    let problema = "";
    if (!existeProducto) {
      problema = "SKU no existe en tabla productos (FK violation)";
    } else if (totalMovido === 0) {
      problema = "Sin movimientos de entrada registrados";
    } else if (totalMovido < l.qty_ubicada) {
      problema = `Movimientos parciales: ${totalMovido} de ${l.qty_ubicada}`;
    } else if (stockLinea === 0 && l.qty_ubicada > 0) {
      problema = "Movimientos OK pero stock es 0";
    }

    if (problema) {
      results.push({
        linea_id: l.id!,
        sku: l.sku,
        nombre: l.nombre,
        qty_ubicada: l.qty_ubicada || 0,
        estado: l.estado,
        movimientos_encontrados: totalMovido,
        stock_actual: stockLinea,
        problema,
        reparado: false,
        detalle: "",
      });
    }
  }

  return results;
}

export async function repararRecepcion(recepcionId: string, posicionDestino: string): Promise<AuditResult[]> {
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const movimientos = await db.fetchMovimientosByRecepcion(recepcionId);
  const stockAll = await db.fetchStock();
  const productos = await db.fetchProductos();
  const productoSet = new Set(productos.map(p => p.sku));

  const results: AuditResult[] = [];

  for (const l of lineas) {
    if ((l.qty_ubicada || 0) === 0) continue;

    const movsLinea = movimientos.filter(m => m.sku === l.sku && m.tipo === "entrada" && m.motivo === "recepcion");
    const totalMovido = movsLinea.reduce((sum, m) => sum + m.cantidad, 0);
    const stockLinea = stockAll.filter(s => s.sku === l.sku).reduce((sum, s) => sum + s.cantidad, 0);
    const existeProducto = productoSet.has(l.sku);

    const faltante = (l.qty_ubicada || 0) - totalMovido;

    if (faltante <= 0 && stockLinea > 0) continue; // OK

    const result: AuditResult = {
      linea_id: l.id!,
      sku: l.sku,
      nombre: l.nombre,
      qty_ubicada: l.qty_ubicada || 0,
      estado: l.estado,
      movimientos_encontrados: totalMovido,
      stock_actual: stockLinea,
      problema: "",
      reparado: false,
      detalle: "",
    };

    // Step 1: Create product if missing
    if (!existeProducto) {
      try {
        await db.upsertProducto({ sku: l.sku, nombre: l.nombre, categoria: "Otros", proveedor: "Otro", costo: l.costo_unitario || 0, costo_promedio: l.costo_unitario || 0, precio: 0, reorder: 20, requiere_etiqueta: true, tamano: "", color: "" });
        result.detalle += `Producto ${l.sku} creado. `;
      } catch (e: unknown) {
        result.problema = `No se pudo crear producto: ${e instanceof Error ? e.message : e}`;
        results.push(result);
        continue;
      }
    }

    // Step 2: Register missing stock + movimiento atómicamente
    if (faltante > 0) {
      try {
        await db.registrarMovimientoStock({
          sku: l.sku, posicion: posicionDestino, delta: faltante, tipo: "entrada",
          motivo: "recepcion", recepcion_id: recepcionId,
          operario: l.operario_ubicacion || "admin-reparacion",
          nota: `Reparacion automatica — faltaban ${faltante} uds sin registrar`,
        });
        result.detalle += `Stock +${faltante} y movimiento registrados en ${posicionDestino}. `;
      } catch (e: unknown) {
        result.problema = `Error reparación: ${e instanceof Error ? e.message : e}`;
        results.push(result);
        continue;
      }
    } else if (stockLinea === 0 && totalMovido > 0) {
      // Movements exist but stock is 0 — re-register stock with adjustment movement
      try {
        await db.registrarMovimientoStock({
          sku: l.sku, posicion: posicionDestino, delta: l.qty_ubicada || 0, tipo: "entrada",
          motivo: "reparacion_stock", recepcion_id: recepcionId,
          operario: l.operario_ubicacion || "admin-reparacion",
          nota: `Reparación: stock era 0 pero movimientos OK — re-registrado ${l.qty_ubicada} uds`,
        });
        result.detalle += `Stock re-registrado +${l.qty_ubicada} en ${posicionDestino}. `;
      } catch (e: unknown) {
        result.problema = `Error re-stock: ${e instanceof Error ? e.message : e}`;
        results.push(result);
        continue;
      }
    }

    // Update cache
    if (!_cache.stock[l.sku]) _cache.stock[l.sku] = {};
    _cache.stock[l.sku][posicionDestino] = (_cache.stock[l.sku][posicionDestino] || 0) + faltante;

    result.reparado = true;
    if (!result.problema) result.problema = faltante > 0 ? `Faltaban ${faltante} uds sin registrar` : "Stock en 0 con movimientos OK";
    results.push(result);
  }

  // Sync repaired SKUs to ML
  const repairedSkus = Array.from(new Set(results.filter(r => r.reparado).map(r => r.sku)));
  if (repairedSkus.length > 0) db.enqueueAndSync(repairedSkus);

  return results;
}

// ==================== RECONCILIACIÓN DE STOCK ====================

export interface StockDiscrepancia {
  sku: string;
  posicion: string;
  stockActual: number;
  stockEsperado: number;
  diferencia: number; // positive = falta stock, negative = sobra stock
  nombre?: string;
}

/**
 * Compara stock actual vs suma neta de movimientos.
 * Los movimientos son la fuente de verdad.
 *
 * Maneja CSV import (reemplazo): cuando se detecta un reemplazo,
 * se resetea el stock esperado del SKU y solo se cuentan movimientos
 * desde ese punto. Los movimientos "reset stock" se ignoran
 * (pueden no haberse persistido correctamente).
 */
export async function reconciliarStock(): Promise<StockDiscrepancia[]> {
  const movimientos = await db.fetchAllMovimientos();
  const stockRows = await db.fetchStock();
  const productos = await db.fetchProductos();
  const prodMap = new Map(productos.map(p => [p.sku, p.nombre]));

  // Expected stock per (sku, posicion) from movements
  // Process chronologically (fetchAllMovimientos returns ascending order)
  const expected: Record<string, number> = {};
  const lastReemplazoTs: Record<string, number> = {}; // sku → timestamp ms

  for (const m of movimientos) {
    // Skip "reset stock" outflows — part of CSV replace, may not persist fully
    if (m.nota?.includes("reset stock")) continue;

    // CSV reemplazo = full stock reset for this SKU
    if (m.nota?.includes("(reemplazo)")) {
      const ts = new Date(m.created_at || "").getTime();
      const lastTs = lastReemplazoTs[m.sku] || 0;

      if (ts - lastTs > 60000) {
        // New reemplazo batch (>60s since last) → reset ALL expected for this SKU
        const prefix = m.sku + "|";
        for (const key of Object.keys(expected)) {
          if (key.startsWith(prefix)) {
            delete expected[key];
          }
        }
      }
      lastReemplazoTs[m.sku] = ts;
    }

    const key = `${m.sku}|${m.posicion_id}`;
    const delta = m.tipo === "entrada" ? m.cantidad : -m.cantidad;
    expected[key] = (expected[key] || 0) + delta;
  }

  // Actual stock per (sku, posicion) — aggregated across sku_venta variants
  const actual: Record<string, number> = {};
  for (const s of stockRows) {
    const key = `${s.sku}|${s.posicion_id}`;
    actual[key] = (actual[key] || 0) + s.cantidad;
  }

  const allKeys = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)]));
  const discrepancias: StockDiscrepancia[] = [];

  for (const key of allKeys) {
    const [sku, posicion] = key.split("|");
    const esp = Math.max(0, expected[key] || 0);
    const act = actual[key] || 0;
    if (esp !== act) {
      discrepancias.push({
        sku, posicion, stockActual: act, stockEsperado: esp,
        diferencia: esp - act, nombre: prodMap.get(sku) || sku,
      });
    }
  }

  return discrepancias.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
}

/**
 * Corrige el stock para que coincida con los movimientos.
 * NO crea movimientos correctivos (para evitar loops).
 * Usa update_stock RPC con el delta necesario por variante de sku_venta.
 */
export async function aplicarReconciliacion(discrepancias: StockDiscrepancia[]): Promise<{ fixed: number; errors: string[] }> {
  let fixed = 0;
  const errors: string[] = [];
  const stockRows = await db.fetchStock();

  for (const d of discrepancias) {
    try {
      if (d.diferencia < 0) {
        // Stock sobra → reducir. Distribuir reducción entre variantes sku_venta
        const rows = stockRows
          .filter(s => s.sku === d.sku && s.posicion_id === d.posicion && s.cantidad > 0)
          .sort((a, b) => {
            // Reducir primero sin etiquetar, luego los más grandes
            if (!a.sku_venta && b.sku_venta) return -1;
            if (a.sku_venta && !b.sku_venta) return 1;
            return b.cantidad - a.cantidad;
          });

        let remaining = Math.abs(d.diferencia);
        for (const row of rows) {
          if (remaining <= 0) break;
          const reduce = Math.min(remaining, row.cantidad);
          await db.registrarMovimientoStock({
            sku: d.sku, posicion: d.posicion, delta: -reduce, tipo: "salida",
            sku_venta: row.sku_venta ?? null, motivo: "reconciliacion",
            operario: "admin",
            nota: `Reconciliación: stock sobra ${Math.abs(d.diferencia)} uds (variante ${row.sku_venta || "sin etiquetar"}: -${reduce})`,
          });
          remaining -= reduce;
        }
      } else {
        // Stock falta → agregar con auto-etiquetado si tiene 1 solo sku_venta
        const autoSv = resolveAutoSkuVenta(d.sku);
        await db.registrarMovimientoStock({
          sku: d.sku, posicion: d.posicion, delta: d.diferencia, tipo: d.diferencia > 0 ? "entrada" : "salida",
          sku_venta: autoSv, motivo: "reconciliacion",
          operario: "admin",
          nota: `Reconciliación: stock falta ${d.diferencia} uds`,
        });
      }

      // Update cache
      if (!_cache.stock[d.sku]) _cache.stock[d.sku] = {};
      _cache.stock[d.sku][d.posicion] = Math.max(0, (d.stockActual || 0) + d.diferencia);
      if (_cache.stock[d.sku][d.posicion] === 0) delete _cache.stock[d.sku][d.posicion];

      fixed++;
    } catch (e) {
      errors.push(`${d.sku}@${d.posicion}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Sync all affected SKUs to ML
  const affectedSkus = Array.from(new Set(discrepancias.map(d => d.sku)));
  if (affectedSkus.length > 0) db.enqueueAndSync(affectedSkus);

  return { fixed, errors };
}

// Upload factura image
export async function uploadFacturaImage(base64: string, folio: string): Promise<string> {
  return db.uploadFacturaImage(base64, folio);
}

// Operarios
export async function getOperarios() { return db.fetchOperarios(); }
export async function loginOperario(id: string, pin: string) { return db.loginOperario(id, pin); }
export async function guardarOperario(o: db.DBOperario) { return db.upsertOperario(o); }

// ==================== PICKING FLEX ====================
export type { PickingLinea, PickingComponente, PickingLineaFullLegacy, PickingTipo, DBPickingSession } from "./db";

// Build picking session from pasted orders
export function buildPickingLineas(orders: { skuVenta: string; qty: number; orderIds?: number[]; shipmentIds?: number[] }[]): { lineas: db.PickingLinea[]; errors: string[] } {
  const lineas: db.PickingLinea[] = [];
  const errors: string[] = [];

  for (let i = 0; i < orders.length; i++) {
    const { skuVenta, qty, orderIds, shipmentIds } = orders[i];
    const lineasAntes = lineas.length;
    const compsAll = getComponentesPorSkuVenta(skuVenta);
    let comps = compsAll.filter(c => c.tipoRelacion !== "alternativo");
    let alternativos = compsAll.filter(c => c.tipoRelacion === "alternativo");

    // Fix: si hay un componente cuyo skuOrigen === skuVenta con unidades=1,
    // los demás componentes con unidades=1 son alternativos (no un combo real)
    if (comps.length > 1) {
      const principal = comps.find(c => c.skuOrigen === skuVenta || c.skuOrigen === skuVenta.toUpperCase());
      if (principal && principal.unidades === 1) {
        const otros = comps.filter(c => c !== principal && c.unidades === principal.unidades);
        if (otros.length > 0) {
          comps = [principal];
          alternativos = [...alternativos, ...otros];
        }
      }
    }

    if (comps.length === 0) {
      // Try finding by SKU directly (maybe it's a simple product, not a pack)
      const prod = _cache.products[skuVenta];
      if (prod) {
        // Usar _planificarFuentes para incluir alternativos
        const altSkus = alternativos.map(a => a.skuOrigen);
        const fuentes = _planificarFuentes(skuVenta, altSkus, qty);

        for (const fuente of fuentes) {
          const fProd = _cache.products[fuente.sku] || prod;
          let restanteFuente = fuente.qty;
          const posiciones = fuente.positions.filter(p => p.qty > 0);

          if (posiciones.length === 0 || restanteFuente <= 0) {
            if (fuente.qty > 0) {
              lineas.push({
                id: `P${String(lineas.length + 1).padStart(3, "0")}`,
                skuVenta, qtyPedida: fuente.qty, estado: "PENDIENTE",
                componentes: [{
                  skuOrigen: fuente.sku, codigoMl: getCodigoMlPrimario(fuente.sku), nombre: fProd.name,
                  unidades: fuente.qty, posicion: "?", posLabel: "Sin posición", stockDisponible: 0,
                  estado: "PENDIENTE", pickedAt: null, operario: null,
                }],
              });
            }
          } else {
            for (const posInfo of posiciones) {
              if (restanteFuente <= 0) break;
              const tomar = Math.min(posInfo.qty, restanteFuente);
              lineas.push({
                id: `P${String(lineas.length + 1).padStart(3, "0")}`,
                skuVenta, qtyPedida: tomar, estado: "PENDIENTE",
                componentes: [{
                  skuOrigen: fuente.sku, codigoMl: getCodigoMlPrimario(fuente.sku), nombre: fProd.name,
                  unidades: tomar, posicion: posInfo.pos, posLabel: posInfo.label, stockDisponible: posInfo.qty,
                  estado: "PENDIENTE", pickedAt: null, operario: null,
                }],
              });
              restanteFuente -= tomar;
            }
          }
        }

        // Verificar stock total (principal + alternativos)
        const totalDisponible = fuentes.reduce((s, f) => s + f.stockTotal, 0);
        if (totalDisponible < qty) {
          const detalle = fuentes.map(f => `${f.sku}(${f.stockTotal})`).join("+");
          errors.push(`⚠️ ${skuVenta}: necesitas ${qty}, disponible ${totalDisponible} en ${detalle || "ninguna posición"}`);
        }
      } else {
        errors.push(`Línea ${i + 1}: SKU Venta "${skuVenta}" no encontrado en diccionario`);
      }
      continue;
    }

    // Decompose into physical components (con soporte para alternativos)
    for (const comp of comps) {
      const totalNeeded = comp.unidades * qty;
      const altSkus = alternativos.filter(a => a.unidades === comp.unidades).map(a => a.skuOrigen);
      const fuentes = _planificarFuentes(comp.skuOrigen, altSkus, totalNeeded);

      for (const fuente of fuentes) {
        const prod = _cache.products[fuente.sku];
        // Multi-posición: generar una línea por cada posición necesaria
        let restanteFuente = fuente.qty;
        const posiciones = fuente.positions.filter(p => p.qty > 0);

        if (posiciones.length === 0 || restanteFuente <= 0) {
          lineas.push({
            id: `P${String(lineas.length + 1).padStart(3, "0")}`,
            skuVenta, qtyPedida: fuente.qty, estado: "PENDIENTE",
            componentes: [{
              skuOrigen: fuente.sku, codigoMl: comp.codigoMl || getCodigoMlPrimario(fuente.sku),
              nombre: prod?.name || fuente.sku, unidades: fuente.qty,
              posicion: "?", posLabel: "Sin posición", stockDisponible: 0,
              estado: "PENDIENTE", pickedAt: null, operario: null,
            }],
          });
        } else {
          for (const posInfo of posiciones) {
            if (restanteFuente <= 0) break;
            const tomar = Math.min(posInfo.qty, restanteFuente);
            lineas.push({
              id: `P${String(lineas.length + 1).padStart(3, "0")}`,
              skuVenta, qtyPedida: tomar, estado: "PENDIENTE",
              componentes: [{
                skuOrigen: fuente.sku, codigoMl: comp.codigoMl || getCodigoMlPrimario(fuente.sku),
                nombre: prod?.name || fuente.sku, unidades: tomar,
                posicion: posInfo.pos, posLabel: posInfo.label, stockDisponible: posInfo.qty,
                estado: "PENDIENTE", pickedAt: null, operario: null,
              }],
            });
            restanteFuente -= tomar;
          }
        }
      }

      // Verificar stock total (principal + alternativos)
      const totalDisponible = fuentes.reduce((s, f) => s + f.stockTotal, 0);
      if (totalDisponible < totalNeeded) {
        const detalle = fuentes.map(f => `${f.sku}(${f.stockTotal})`).join("+");
        errors.push(`⚠️ ${comp.skuOrigen}: necesitas ${totalNeeded}, disponible ${totalDisponible} en ${detalle || "ninguna posición"}`);
      }
    }

    // Asignar orderIds/shipmentIds a las líneas generadas para este pedido
    if (orderIds || shipmentIds) {
      for (let j = lineasAntes; j < lineas.length; j++) {
        if (orderIds) lineas[j].orderIds = orderIds;
        if (shipmentIds) lineas[j].shipmentIds = shipmentIds;
      }
    }
  }

  return { lineas, errors };
}

// Check if a code matches any value in a comma-separated field
function matchesAnyCode(field: string | undefined, code: string): boolean {
  if (!field) return false;
  return field.toUpperCase().split(",").some(c => c.trim() === code);
}

// Verify a scanned code against expected component
export function verificarScanPicking(scannedCode: string, componente: db.PickingComponente, skuVenta?: string): boolean {
  const code = scannedCode.trim().toUpperCase();
  if (!code) return false;

  // 1. Direct SKU origen match
  if (componente.skuOrigen.toUpperCase() === code) return true;

  // 2. Codigo ML of the composicion entry
  if (componente.codigoMl && matchesAnyCode(componente.codigoMl, code)) return true;

  // 3. SKU Venta match (the "Cod. Universal" on the label)
  if (skuVenta && skuVenta.toUpperCase() === code) return true;

  // 4. Check ALL composicion entries for this skuOrigen — any codigoMl match
  const ventas = getVentasPorSkuOrigen(componente.skuOrigen);
  for (const v of ventas) {
    if (v.codigoMl && v.codigoMl.toUpperCase() === code) return true;
    if (v.skuVenta && v.skuVenta.toUpperCase() === code) return true;
  }

  return false;
}

// Get all active picking sessions
export async function getActivePickings(): Promise<db.DBPickingSession[]> {
  return db.getActivePickingSessions();
}

// Get sessions by date
export async function getPickingsByDate(fecha: string): Promise<db.DBPickingSession[]> {
  return db.getPickingSessionsByDate(fecha);
}

// Aggregate and reserve stock for picking lines (by SKU to avoid multiple reserves)
// Create picking session (reservations are computed by reconciliar_reservas, not managed here)
export async function crearPickingSession(fecha: string, lineas: db.PickingLinea[], tipo?: db.PickingTipo, titulo?: string): Promise<string | null> {
  const resolvedTipo = tipo || "flex";
  const id = await db.createPickingSession({ fecha, estado: "ABIERTA", lineas, tipo: resolvedTipo, titulo });
  return id;
}

/**
 * Sync Flex picking session for today.
 * Auto-creates or updates a picking session from today's shipments (DESPACHAR_HOY + ATRASADO).
 * Called after each ML sync to keep the picking list up to date.
 * Uses a concurrency lock to prevent duplicate session creation from parallel calls.
 */
let _syncFlexLock: Promise<{ created: boolean; updated: boolean; total: number }> | null = null;
export function syncFlexPickingSession(): Promise<{ created: boolean; updated: boolean; total: number }> {
  if (_syncFlexLock) return _syncFlexLock;
  _syncFlexLock = _syncFlexPickingSessionImpl().finally(() => { _syncFlexLock = null; });
  return _syncFlexLock;
}
async function _syncFlexPickingSessionImpl(): Promise<{ created: boolean; updated: boolean; total: number }> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Santiago" }); // YYYY-MM-DD Chile

  // 1. Get active shipments
  const shipments = await db.fetchActiveFlexShipments();

  // 2. Filter to today + overdue (all go into today's session)
  const todayShipments = shipments.filter(s => {
    if (s.status === "pending" && s.substatus === "buffered") return false;
    if (s.substatus !== "ready_to_print" && s.substatus !== "printed") return false;
    if (!s.handling_limit) return true; // no date = assume today
    const limitDay = new Date(s.handling_limit).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
    return limitDay <= today; // today + overdue — all must be dispatched today
  });

  if (todayShipments.length === 0) return { created: false, updated: false, total: 0 };

  // 3. Build picking lines from shipment items
  const orders: { skuVenta: string; qty: number; shipmentId: number }[] = [];
  for (const s of todayShipments) {
    for (const item of s.items) {
      // seller_sku is the SKU venta from the ML item
      const sku = item.seller_sku || item.item_id;
      orders.push({ skuVenta: sku, qty: item.quantity, shipmentId: s.shipment_id });
    }
  }

  const { lineas } = buildPickingLineas(orders.map(o => ({ skuVenta: o.skuVenta, qty: o.qty, shipmentIds: [o.shipmentId] })));
  if (lineas.length === 0) return { created: false, updated: false, total: 0 };

  // 4. Single session per day — find or create, reopen if needed
  const todaySessions = await db.getPickingSessionsByDate(today);
  const flexSessions = todaySessions.filter(s => s.tipo === "flex");

  // If multiple flex sessions exist (race condition), pick the one with most progress
  // and delete the empty duplicates
  let flexSession: db.DBPickingSession | undefined;
  if (flexSessions.length > 1) {
    // Prefer: EN_PROCESO/COMPLETADA with picked lines > ABIERTA with 0 picked
    flexSessions.sort((a, b) => {
      const aPicked = a.lineas.filter(l => l.estado === "PICKEADO").length;
      const bPicked = b.lineas.filter(l => l.estado === "PICKEADO").length;
      if (aPicked !== bPicked) return bPicked - aPicked; // more picked first
      return b.lineas.length - a.lineas.length; // more lines first
    });
    flexSession = flexSessions[0];
    // Delete duplicates (the ones with no progress)
    for (let i = 1; i < flexSessions.length; i++) {
      const dup = flexSessions[i];
      const dupPicked = dup.lineas.filter(l => l.estado === "PICKEADO").length;
      if (dupPicked === 0 && dup.id) {
        await db.deletePickingSession(dup.id);
        void db.auditLog("syncFlex:delete_duplicate", { entidad: "picking_session", entidad_id: dup.id, params: { reason: "race_condition_duplicate", lineas: dup.lineas.length } });
      }
    }
  } else {
    flexSession = flexSessions[0];
  }

  if (!flexSession) {
    // No session at all — create fresh
    // NOTE: No reservar aquí — el webhook ML ya reservó al procesar el shipment
    await db.createPickingSession({
      fecha: today, estado: "ABIERTA", lineas,
      tipo: "flex", titulo: `Flex ${today}`,
    });
    return { created: true, updated: false, total: lineas.length };
  }

  // Session exists — find shipments already in session vs new ones
  const existingShipIds = new Set<number>();
  for (const l of flexSession.lineas) {
    for (const sid of (l.shipmentIds || [])) existingShipIds.add(sid);
  }

  // Active shipment IDs from ML (the ones that SHOULD be in the session)
  const activeShipIds = new Set<number>();
  for (const s of todayShipments) activeShipIds.add(s.shipment_id);

  // 1. Remove PENDIENTE lines whose shipments are no longer active (hidden/cancelled/shipped)
  //    Keep PICKEADO lines (already done, represent actual stock movements)
  const keptLineas = flexSession.lineas.filter(l => {
    if (l.estado === "PICKEADO") return true; // keep all picked lines
    const lineShipIds = l.shipmentIds || [];
    if (lineShipIds.length === 0) return true; // no shipment ref, can't validate
    // Keep only if at least one shipmentId is still active
    return lineShipIds.some(sid => activeShipIds.has(sid));
  });
  const removedCount = flexSession.lineas.length - keptLineas.length;

  // 2. Add lines for shipments NOT already in the session (preserves correct shipmentIds)
  const keptShipIds = new Set<number>();
  for (const l of keptLineas) {
    for (const sid of (l.shipmentIds || [])) keptShipIds.add(sid);
  }
  const newLineas: typeof lineas = [];
  for (const l of lineas) {
    const lineShipIds = l.shipmentIds || [];
    const isNew = lineShipIds.length === 0 || lineShipIds.some(sid => !keptShipIds.has(sid));
    if (isNew) {
      newLineas.push(l);
    }
  }

  if (newLineas.length === 0 && removedCount === 0) {
    return { created: false, updated: false, total: flexSession.lineas.length };
  }

  // Re-number new lines to avoid ID collisions
  const existingIds = new Set(keptLineas.map(l => l.id));
  let nextNum = keptLineas.length + 1;
  for (const nl of newLineas) {
    let newId = `P${String(nextNum).padStart(3, "0")}`;
    while (existingIds.has(newId)) { nextNum++; newId = `P${String(nextNum).padStart(3, "0")}`; }
    nl.id = newId;
    existingIds.add(newId);
    nextNum++;
  }

  // Merge and reopen if completed
  const merged = [...keptLineas, ...newLineas];
  const newEstado = flexSession.estado === "COMPLETADA" ? "EN_PROCESO" : flexSession.estado;
  await db.updatePickingSession(flexSession.id!, { lineas: merged, estado: newEstado });
  // NOTE: No reservar aquí — el webhook ML ya reservó al procesar el shipment
  return { created: false, updated: true, total: merged.length };

}

// Update picking session
export async function actualizarPicking(id: string, updates: Partial<db.DBPickingSession>): Promise<boolean> {
  return db.updatePickingSession(id, updates);
}

// Delete picking session — if envio_full, reconcile + sync ML
export async function eliminarPicking(id: string): Promise<boolean> {
  const sessions = await db.getActivePickingSessions();
  const session = sessions.find(s => s.id === id);
  const result = await db.deletePickingSession(id);
  if (result && session?.tipo === "envio_full") {
    const skus = session.lineas
      .filter(l => l.estado === "PENDIENTE")
      .map(l => l.componentes[0]?.skuOrigen)
      .filter(Boolean);
    if (skus.length > 0) {
      const sb = db.getSupabase();
      if (sb) { try { await sb.rpc("reconciliar_reservas"); } catch {} }
      db.enqueueAndSync(skus);
    }
  }
  return result;
}

// Duplicar picking envio_full en nueva sesion con stock/posiciones actuales.
// Toma los SKU venta + qtyVenta del original, recalcula componentes y posiciones
// usando stock actual (buildPickingLineasFull). El original queda intacto.
// Util para reactivar envios anulados/completados cuando queremos volver a mandar.
export async function duplicarPicking(id: string): Promise<{ newId: string | null; errors: string[] }> {
  const errors: string[] = [];
  // Fetch the source session (any state) by ID — use raw DB fetch, not active-only
  const sb = db.getSupabase();
  if (!sb) return { newId: null, errors: ["No DB"] };
  const { data } = await sb.from("picking_sessions").select("*").eq("id", id).limit(1);
  const source = (data || [])[0] as db.DBPickingSession | undefined;
  if (!source) return { newId: null, errors: [`Sesion ${id} no existe`] };
  if (source.tipo !== "envio_full") {
    return { newId: null, errors: ["Solo se puede duplicar envios a Full"] };
  }

  // Extraer SKU venta + componentes del original.
  // Agrupar por skuVenta: si varias lineas apuntan al mismo skuVenta (multi-posicion),
  // consolidar qty.
  interface EnvioInput {
    skuVenta: string;
    nombre: string;
    mandarFull: number;
    tipo: "simple" | "pack" | "combo";
    componentes: {
      skuOrigen: string;
      nombreOrigen: string;
      unidadesPorPack: number;
      unidadesFisicas: number;
      alternativos?: string[];
    }[];
  }
  // En multi-posicion, las lineas comparten skuVenta y qtyVenta es el TOTAL
  // repetido en cada linea (no dividido). componentes.unidades SI se divide
  // entre posiciones. Agrupar correctamente:
  //   - mandarFull = qtyVenta del PRIMERO (no sumar entre lineas del mismo skuVenta)
  //   - componentes.unidadesFisicas = SUMA de unidades de todas las lineas del mismo skuVenta+skuOrigen
  //   - unidadesPorPack = totalUnidadesComponente / mandarFull (ratio real)
  const envioMap = new Map<string, EnvioInput>();
  for (const l of source.lineas) {
    const skuVenta = l.skuVenta;
    const tipoFull = (l.tipoFull as "simple" | "pack" | "combo" | undefined) || "simple";
    const qtyVenta = l.qtyVenta || l.qtyPedida || 0;
    if (qtyVenta <= 0) continue;
    if (!envioMap.has(skuVenta)) {
      envioMap.set(skuVenta, {
        skuVenta,
        nombre: (l.componentes?.[0]?.nombre) || skuVenta,
        mandarFull: qtyVenta,  // qtyVenta ya es el total, no se acumula
        tipo: tipoFull,
        componentes: [],  // se llena abajo
      });
    }
    const existing = envioMap.get(skuVenta)!;
    // Acumular uds fisicas por componente (estas si se reparten entre posiciones)
    for (const c of (l.componentes || [])) {
      const prev = existing.componentes.find(cc => cc.skuOrigen === c.skuOrigen);
      if (prev) {
        prev.unidadesFisicas += c.unidades || 0;
      } else {
        existing.componentes.push({
          skuOrigen: c.skuOrigen,
          nombreOrigen: c.nombre || c.skuOrigen,
          unidadesPorPack: 0, // placeholder, se calcula al final
          unidadesFisicas: c.unidades || 0,
          alternativos: [],
        });
      }
    }
  }
  // Recalcular unidadesPorPack: ratio real con las uds totales acumuladas
  for (const envio of Array.from(envioMap.values())) {
    for (const c of envio.componentes) {
      c.unidadesPorPack = envio.mandarFull > 0
        ? Math.round(c.unidadesFisicas / envio.mandarFull)
        : 1;
      if (c.unidadesPorPack < 1) c.unidadesPorPack = 1; // fallback seguro
    }
  }

  if (envioMap.size === 0) {
    return { newId: null, errors: ["Sesion original sin lineas validas"] };
  }

  // Reconstruir lineas con stock/posiciones actuales
  const { lineas: nuevasLineas, errors: buildErrors } = buildPickingLineasFull(
    Array.from(envioMap.values())
  );
  errors.push(...buildErrors);

  if (nuevasLineas.length === 0) {
    return { newId: null, errors: [...errors, "No hay stock para ningun SKU del envio original"] };
  }

  const fecha = new Date().toISOString().slice(0, 10);
  const titulo = `Duplicado de ${id.slice(0, 8)}`;
  const newId = await crearPickingSession(fecha, nuevasLineas, "envio_full", titulo);

  if (newId) {
    // Encolar SKUs para re-sincronizar ML (las reservas se activan en el proximo ciclo)
    const skus = Array.from(envioMap.keys());
    if (skus.length > 0) db.enqueueAndSync(skus);

    // Generar snapshot en envios_full_historial para que el duplicado aparezca
    // en el historial con totales calculados (evita huerfanos como el bug
    // detectado 2026-04-24). Tambien redirige snapshot anterior si existia
    // apuntando al picking original, para no dejar 2 entradas del mismo envio.
    try {
      const totalSkus = envioMap.size;
      const totalUdsVenta = Array.from(envioMap.values()).reduce((s, e) => s + e.mandarFull, 0);
      const totalUdsFisicas = Array.from(envioMap.values()).reduce(
        (s, e) => s + e.componentes.reduce((s2, c) => s2 + c.unidadesFisicas, 0),
        0
      );
      // Bultos: estimar usando inner_pack del sku_origen principal (si existe)
      let totalBultos = 0;
      for (const e of Array.from(envioMap.values())) {
        for (const c of e.componentes) {
          const prod = _cache.products[c.skuOrigen];
          const ip = prod?.innerPack && prod.innerPack > 1 ? prod.innerPack : 1;
          totalBultos += Math.ceil(c.unidadesFisicas / ip);
        }
      }

      const sb = db.getSupabase();
      if (sb) {
        // Si el picking original tenia snapshot, redirigirlo al duplicado
        // (en vez de crear uno nuevo). Evita que 2 filas del historial
        // apunten a versiones distintas del mismo envio logico.
        const { data: existing } = await sb.from("envios_full_historial")
          .select("id").eq("picking_session_id", id).limit(1);
        if (existing && existing.length > 0) {
          await sb.from("envios_full_historial")
            .update({ picking_session_id: newId })
            .eq("id", (existing[0] as { id: string }).id);
        } else {
          // Sin snapshot previo: crear uno nuevo con los totales calculados
          await sb.from("envios_full_historial").insert({
            picking_session_id: newId,
            fecha,
            total_skus: totalSkus,
            total_uds_venta: totalUdsVenta,
            total_uds_fisicas: totalUdsFisicas,
            total_bultos: totalBultos,
            evento_activo: null,
            multiplicador_evento: 1.0,
          });
        }
      }
    } catch (e) {
      console.error("[duplicarPicking] Error guardando snapshot:", e);
      // no bloqueante: el picking ya fue creado, el snapshot es informativo
    }
  }

  return { newId, errors };
}

// Anular picking session — mantiene registro historico (estado=ANULADA).
// Diferente de eliminarPicking que hace DELETE. Usar cuando:
//   - hubo picking parcial y no queremos revertir automatico (quedan OUTs
//     registrados que pueden servir de auditoria)
//   - el negocio requiere trazabilidad de envios decididos pero no hechos
//   - se quiere poder reabrir el caso despues (revisar quien/cuando anulo)
// getActivePickingSessions filtra por ABIERTA/EN_PROCESO, ANULADA no aparece
// en listas activas. queryEnviosFullPendientes del motor tambien lo ignora.
export async function anularPicking(id: string, motivo?: string): Promise<boolean> {
  const sessions = await db.getActivePickingSessions();
  const session = sessions.find(s => s.id === id);
  if (!session) return false;

  const ok = await db.updatePickingSession(id, {
    estado: "ANULADA",
  } as Partial<db.DBPickingSession>);
  if (!ok) return false;

  // Si es envio_full, liberar reservas y re-sincronizar SKUs pendientes a ML
  if (session.tipo === "envio_full") {
    const skus = session.lineas
      .filter(l => l.estado === "PENDIENTE")
      .map(l => l.componentes[0]?.skuOrigen)
      .filter(Boolean);
    if (skus.length > 0) {
      const sb = db.getSupabase();
      if (sb) { try { await sb.rpc("reconciliar_reservas"); } catch {} }
      db.enqueueAndSync(skus);
    }
  }

  // Audit log para trazabilidad
  const sb = db.getSupabase();
  if (sb) {
    void sb.from("audit_log").insert({
      accion: "picking:anular",
      entidad: "picking_sessions",
      entidad_id: id,
      params: { tipo: session.tipo, lineas: session.lineas.length, motivo: motivo || null },
      operario: "admin",
    });
  }
  return true;
}

// ==================== RUTA INTELIGENTE (SERPENTINA) ====================

interface PosConCoords {
  id: string;
  label: string;
  mx: number;
  my: number;
}

/**
 * Calcula la ruta de picking usando método serpentina:
 * 1. Agrupar posiciones por pasillo (misma coordenada X o prefijo)
 * 2. Ordenar pasillos izquierda → derecha (X ascendente)
 * 3. Alternar dirección Y dentro de cada pasillo (zigzag)
 * Fallback a orden alfabético si no hay coordenadas.
 */
export function calcularRutaPicking(posicionIds: string[]): string[] {
  if (posicionIds.length === 0) return [];

  const posMap = new Map<string, Position>();
  for (const p of _cache.positions) posMap.set(p.id, p);

  // Separar posiciones con y sin coordenadas
  const conCoords: PosConCoords[] = [];
  const sinCoords: string[] = [];

  for (const pid of posicionIds) {
    const p = posMap.get(pid);
    if (p && p.mx !== undefined && p.my !== undefined) {
      conCoords.push({ id: p.id, label: p.label, mx: p.mx, my: p.my });
    } else {
      sinCoords.push(pid);
    }
  }

  if (conCoords.length === 0) {
    // Sin coordenadas: fallback alfabético
    return [...posicionIds].sort();
  }

  // Agrupar por pasillo (misma coordenada X)
  const pasillos = new Map<number, PosConCoords[]>();
  for (const p of conCoords) {
    if (!pasillos.has(p.mx)) pasillos.set(p.mx, []);
    pasillos.get(p.mx)!.push(p);
  }

  // Ordenar pasillos izquierda → derecha
  const pasillosOrdenados = Array.from(pasillos.entries()).sort((a, b) => a[0] - b[0]);

  const resultado: string[] = [];
  let direccionAbajo = true; // primer pasillo: Y ascendente (arriba → abajo)

  for (const [, posiciones] of pasillosOrdenados) {
    posiciones.sort((a, b) => direccionAbajo ? a.my - b.my : b.my - a.my);
    for (const p of posiciones) resultado.push(p.id);
    direccionAbajo = !direccionAbajo; // alternar dirección
  }

  // Agregar posiciones sin coordenadas al final, ordenadas alfabéticamente
  sinCoords.sort();
  resultado.push(...sinCoords);

  return resultado;
}

/**
 * Agrupa líneas de picking por posición para que el operador no tenga que
 * ir dos veces al mismo lugar.
 */
export function agruparPorPosicion<T extends { posicion: string }>(lineas: T[]): Map<string, T[]> {
  const grupos = new Map<string, T[]>();
  for (const l of lineas) {
    if (!grupos.has(l.posicion)) grupos.set(l.posicion, []);
    grupos.get(l.posicion)!.push(l);
  }
  return grupos;
}

/**
 * Planifica las fuentes de stock para un componente, usando alternativos si el principal no alcanza.
 * Retorna una o más fuentes con la cantidad a tomar de cada una.
 */
function _planificarFuentes(
  skuPrincipal: string,
  alternativos: string[],
  cantidadNecesaria: number,
): { sku: string; qty: number; positions: { pos: string; label: string; qty: number }[]; stockTotal: number }[] {
  const fuentes: { sku: string; qty: number; positions: { pos: string; label: string; qty: number }[]; stockTotal: number }[] = [];
  let restante = cantidadNecesaria;

  // 1. Primero del principal
  const posPrincipal = skuPositions(skuPrincipal);
  const stockPrincipal = posPrincipal.reduce((s, p) => s + p.qty, 0);
  const tomarPrincipal = Math.min(stockPrincipal, restante);
  if (tomarPrincipal > 0) {
    fuentes.push({ sku: skuPrincipal, qty: tomarPrincipal, positions: posPrincipal, stockTotal: stockPrincipal });
    restante -= tomarPrincipal;
  } else {
    fuentes.push({ sku: skuPrincipal, qty: 0, positions: posPrincipal, stockTotal: stockPrincipal });
  }

  // 2. Si no alcanza, completar con alternativos
  if (restante > 0 && alternativos.length > 0) {
    for (const altSku of alternativos) {
      if (restante <= 0) break;
      const posAlt = skuPositions(altSku);
      const stockAlt = posAlt.reduce((s, p) => s + p.qty, 0);
      const tomarAlt = Math.min(stockAlt, restante);
      if (tomarAlt > 0) {
        fuentes.push({ sku: altSku, qty: tomarAlt, positions: posAlt, stockTotal: stockAlt });
        restante -= tomarAlt;
      }
    }
  }

  // Si principal tenía 0, no generar línea vacía — solo incluir fuentes con qty > 0
  // Pero si ninguna tiene stock, mantener la primera para que aparezca el error
  const conStock = fuentes.filter(f => f.qty > 0);
  return conStock.length > 0 ? conStock : [fuentes[0]];
}

/**
 * Genera líneas de picking para envío a Full desde los datos de Reposición.
 * Cada SKU a pickear genera su propia PickingLinea con componentes[],
 * usando la misma estructura que Flex para que las vistas funcionen sin bifurcación.
 * Se ordenan por ruta inteligente (serpentina).
 */
export function buildPickingLineasFull(
  envios: {
    skuVenta: string;
    nombre: string;
    mandarFull: number;
    tipo: "simple" | "pack" | "combo";
    componentes: {
      skuOrigen: string;
      nombreOrigen: string;
      unidadesPorPack: number;
      unidadesFisicas: number;
      alternativos?: string[];
    }[];
  }[]
): { lineas: db.PickingLinea[]; errors: string[] } {
  const errors: string[] = [];
  const lineas: db.PickingLinea[] = [];
  let idx = 0;

  for (const envio of envios) {
    for (const comp of envio.componentes) {
      // Construir plan de picking: principal + alternativos si no alcanza
      const fuentes = _planificarFuentes(comp.skuOrigen, comp.alternativos || [], comp.unidadesFisicas);

      // Instrucción de armado
      let instruccion: string | null = null;
      if (envio.tipo === "pack") {
        instruccion = `Armar ${envio.mandarFull} packs de ${comp.unidadesPorPack} uds. Etiquetar como ${envio.skuVenta}`;
      } else if (envio.tipo === "combo") {
        instruccion = `Armar ${envio.mandarFull} combos. Etiquetar como ${envio.skuVenta}`;
      }

      for (const fuente of fuentes) {
        const prod = _cache.products[fuente.sku];

        // Multi-posición: generar una línea por cada posición necesaria
        let restanteFuente = fuente.qty;
        const posiciones = fuente.positions.filter(p => p.qty > 0);

        if (posiciones.length === 0 || restanteFuente <= 0) {
          // Sin stock o sin posiciones — generar línea con posición "?"
          idx++;
          lineas.push({
            id: `F${String(idx).padStart(3, "0")}`,
            skuVenta: envio.skuVenta,
            qtyPedida: fuente.qty,
            estado: "PENDIENTE",
            componentes: [{
              skuOrigen: fuente.sku,
              codigoMl: getCodigoMlPrimario(fuente.sku),
              nombre: prod?.name || fuente.sku,
              unidades: fuente.qty,
              posicion: "?",
              posLabel: "Sin posición",
              stockDisponible: 0,
              estado: "PENDIENTE",
              pickedAt: null,
              operario: null,
            }],
            skuOrigen: fuente.sku,
            tipoFull: envio.tipo,
            qtyFisica: fuente.qty,
            qtyVenta: envio.mandarFull,
            unidadesPorPack: comp.unidadesPorPack,
            posicionOrden: 0,
            instruccionArmado: instruccion,
            estadoArmado: envio.tipo === "simple" ? null : "PENDIENTE",
          });
        } else {
          for (const posInfo of posiciones) {
            if (restanteFuente <= 0) break;
            const tomar = Math.min(posInfo.qty, restanteFuente);
            idx++;
            lineas.push({
              id: `F${String(idx).padStart(3, "0")}`,
              skuVenta: envio.skuVenta,
              qtyPedida: tomar,
              estado: "PENDIENTE",
              componentes: [{
                skuOrigen: fuente.sku,
                codigoMl: getCodigoMlPrimario(fuente.sku),
                nombre: prod?.name || fuente.sku,
                unidades: tomar,
                posicion: posInfo.pos,
                posLabel: posInfo.label,
                stockDisponible: posInfo.qty,
                estado: "PENDIENTE",
                pickedAt: null,
                operario: null,
              }],
              skuOrigen: fuente.sku,
              tipoFull: envio.tipo,
              qtyFisica: tomar,
              qtyVenta: envio.mandarFull,
              unidadesPorPack: comp.unidadesPorPack,
              posicionOrden: 0,
              instruccionArmado: instruccion,
              estadoArmado: envio.tipo === "simple" ? null : "PENDIENTE",
            });
            restanteFuente -= tomar;
          }
        }
      }

      // Verificar stock total (principal + alternativos)
      const totalDisponible = fuentes.reduce((s, f) => s + f.stockTotal, 0);
      if (totalDisponible < comp.unidadesFisicas) {
        const detalle = fuentes.map(f => `${f.sku}(${f.stockTotal})`).join("+");
        errors.push(`⚠️ ${comp.skuOrigen}: necesitas ${comp.unidadesFisicas}, disponible ${totalDisponible} en ${detalle || "ninguna posición"}`);
      }
    }
  }

  // Calcular ruta inteligente
  const posicionesUnicas = Array.from(new Set(lineas.map(l => l.componentes[0]?.posicion).filter(p => p && p !== "?")));
  const rutaOrdenada = calcularRutaPicking(posicionesUnicas as string[]);
  const ordenMap = new Map<string, number>();
  rutaOrdenada.forEach((pos, i) => ordenMap.set(pos, i));

  // Asignar orden y reordenar
  for (const l of lineas) {
    l.posicionOrden = ordenMap.get(l.componentes[0]?.posicion || "") ?? 999;
  }
  lineas.sort((a, b) => (a.posicionOrden ?? 999) - (b.posicionOrden ?? 999) || (a.skuOrigen || "").localeCompare(b.skuOrigen || ""));

  return { lineas, errors };
}

// Mark component as picked + decrement stock
export async function pickearComponente(
  sessionId: string, lineaId: string, compIdx: number, operario: string,
  _session: db.DBPickingSession, skuVenta?: string,
  scanned?: { mode: "scanned" | "manual"; codigo?: string }
): Promise<boolean> {
  await db.auditLog("pickearComponente", {
    entidad: "picking_session", entidad_id: sessionId, operario,
    params: { lineaId, compIdx, skuVenta, tipo: _session.tipo, scanMode: scanned?.mode || "manual", scanCodigo: scanned?.codigo || null },
  });

  // Read fresh session from DB to avoid stale state overwrites
  const sessions = await db.getActivePickingSessions();
  const freshSession = sessions.find(s => s.id === sessionId);
  if (!freshSession) {
    console.warn("[Picking] Could not read fresh session, using FALLBACK");
    await db.auditLog("pickearComponente:fallback", {
      entidad: "picking_session", entidad_id: sessionId, operario,
      params: { lineaId, compIdx, reason: "fresh_session_not_found" },
    });
    return pickearComponenteFallback(sessionId, lineaId, compIdx, operario, _session);
  }


  // Find linea: use explicit skuVenta if provided (handles duplicate IDs)
  const targetSku = skuVenta || _session.lineas.find(l => l.id === lineaId)?.skuVenta;
  let linea = freshSession.lineas.find(l => l.skuVenta === targetSku && l.estado !== "PICKEADO")
    || freshSession.lineas.find(l => l.id === lineaId && l.skuVenta === targetSku)
    || freshSession.lineas.find(l => l.id === lineaId);
  if (!linea) {
    console.error(`[Picking] Could not find linea ${lineaId} — using FALLBACK`);
    return pickearComponenteFallback(sessionId, lineaId, compIdx, operario, _session);
  }
  const comp = linea.componentes[compIdx];
  if (!comp || comp.estado === "PICKEADO") return false;

  // Mark as picked FIRST, save session, THEN move stock
  comp.estado = "PICKEADO";
  comp.pickedAt = new Date().toISOString();
  comp.operario = operario;
  // Tracking de scan: "scanned" si verificó código de barras, "manual" si confirmó sin escanear
  (comp as unknown as Record<string, unknown>).scanMode = scanned?.mode || "manual";
  if (scanned?.codigo) (comp as unknown as Record<string, unknown>).scanCodigo = scanned.codigo;

  const lineaAllPicked = linea.componentes.every(c => c.estado === "PICKEADO");
  if (lineaAllPicked) {
    linea.estado = "PICKEADO";
  }

  const patch: Partial<db.PickingLinea> = {
    componentes: linea.componentes,
    estado: linea.estado,
  };
  const patched = await db.patchLineaPicking(sessionId, linea.id, patch);
  if (!patched) {
    console.error(`[Picking] patchLineaPicking failed for ${linea.id}, using FALLBACK`);
    return pickearComponenteFallback(sessionId, lineaId, compIdx, operario, _session);
  }

  // Probable done: if every other line in the fresh snapshot was already PICKEADO
  // and this one just finished, the session is likely complete. getActivePickingSessions
  // only returns ABIERTA/EN_PROCESO — if it's gone, the RPC marked it COMPLETADA.
  let allDone = false;
  if (lineaAllPicked && freshSession.lineas.every(l => l.id === linea.id || l.estado === "PICKEADO")) {
    const after = await db.getActivePickingSessions();
    allDone = !after.some(s => s.id === sessionId);
  }

  // Deduct stock — reservations are computed by reconciliar_reservas(), not managed here
  if (isConfigured()) {
    const orderLabel = linea.orderIds?.length ? ` OC:${linea.orderIds.join(",")}` : "";
    const shipLabel = linea.shipmentIds?.length ? ` Envío:${linea.shipmentIds.join(",")}` : "";
    const sessionLabel = freshSession.titulo || `Sesión ${sessionId.slice(0, 8)}`;
    await db.registrarMovimientoStock({
      sku: comp.skuOrigen, posicion: comp.posicion && comp.posicion !== "?" ? comp.posicion : "SIN_ASIGNAR",
      delta: -comp.unidades, tipo: "salida",
      motivo: "venta_flex", operario,
      nota: `Picking Flex: ${linea.skuVenta} ×${linea.qtyPedida}${orderLabel}${shipLabel} — ${sessionLabel}`,
      idempotency_key: `flex-pick-${sessionId}-${linea.id}-${compIdx}`,
    });
    // Mark shipment items as stock_deducted FIRST, then reconcile, THEN sync ML
    // Order matters: sync must see updated disponible (after reservation is released)
    const sb = db.getSupabase();
    if (sb) {
      if (linea.shipmentIds?.length) {
        for (const shipId of linea.shipmentIds) {
          await sb.from("ml_shipment_items")
            .update({ stock_deducted: true })
            .eq("shipment_id", shipId)
            .eq("seller_sku", linea.skuVenta);
        }
      } else {
        // Fallback: mark oldest pending shipment item for this SKU
        const { data: pending } = await sb.from("ml_shipment_items")
          .select("shipment_id")
          .eq("seller_sku", linea.skuVenta)
          .eq("stock_deducted", false)
          .limit(1);
        if (pending && pending.length > 0) {
          await sb.from("ml_shipment_items")
            .update({ stock_deducted: true })
            .eq("shipment_id", pending[0].shipment_id)
            .eq("seller_sku", linea.skuVenta);
        }
      }
      // Reconcile reservations — releases qty_reserved so disponible is correct
      try { await sb.rpc("reconciliar_reservas"); } catch { /* no bloquear */ }
    }
    // NOW sync to ML with correct disponible
    db.enqueueAndSync([comp.skuOrigen]);
  }

  await db.auditLog("pickearComponente:ok", {
    entidad: "picking_session", entidad_id: sessionId, operario,
    resultado: { lineaId, compIdx, sku: comp.skuOrigen, qty: comp.unidades, posicion: comp.posicion, skuVenta: linea.skuVenta, allDone, shipmentIds: linea.shipmentIds, scanMode: scanned?.mode || "manual", scanCodigo: scanned?.codigo || null },
  });

  if (allDone && sessionId) {
    import("./agents-triggers").then(m => m.dispararTrigger("picking_completado", { session_id: sessionId, tipo: "flex" })).catch(() => {});
  }

  return true;
}

// Fallback for when DB read fails
async function pickearComponenteFallback(
  sessionId: string, lineaId: string, compIdx: number, operario: string,
  session: db.DBPickingSession
): Promise<boolean> {
  const linea = session.lineas.find(l => l.id === lineaId);
  if (!linea) return false;
  const comp = linea.componentes[compIdx];
  if (!comp || comp.estado === "PICKEADO") return false;
  if (isConfigured()) {
    await db.registrarMovimientoStock({
      sku: comp.skuOrigen, posicion: comp.posicion && comp.posicion !== "?" ? comp.posicion : "SIN_ASIGNAR",
      delta: -comp.unidades, tipo: "salida",
      motivo: "venta_flex", operario,
      nota: `Picking Flex: ${linea.skuVenta} ×${comp.unidades} — ${session.titulo || `Sesión ${sessionId.slice(0, 8)}`} [fallback]`,
      idempotency_key: `flex-pick-${sessionId}-${lineaId}-${compIdx}`,
    });
  }
  comp.estado = "PICKEADO";
  comp.pickedAt = new Date().toISOString();
  comp.operario = operario;
  if (linea.componentes.every(c => c.estado === "PICKEADO")) linea.estado = "PICKEADO";
  const allDone = session.lineas.every(l => l.estado === "PICKEADO");
  await db.updatePickingSession(sessionId, {
    lineas: session.lineas,
    estado: allDone ? "COMPLETADA" : "EN_PROCESO",
    ...(allDone ? { completed_at: new Date().toISOString() } : {}),
  });
  db.enqueueAndSync([comp.skuOrigen]);
  return true;
}

// Revertir un componente pickeado — devuelve stock a la posición original
export async function despickearComponente(
  sessionId: string, lineaId: string, compIdx: number, operario: string,
  session: db.DBPickingSession
): Promise<boolean> {
  // Fresh read to avoid clobbering concurrent writes to the same session
  const sessions = await db.getActivePickingSessions();
  const freshSession = sessions.find(s => s.id === sessionId) || session;
  const linea = freshSession.lineas.find(l => l.id === lineaId);
  if (!linea) return false;
  const comp = linea.componentes[compIdx];
  if (!comp || comp.estado !== "PICKEADO") return false;

  // Revert: re-enter stock (reservations are computed by reconciliar_reservas)
  if (isConfigured()) {
    const pos = comp.posicion;
    await db.registrarMovimientoStock({
      sku: comp.skuOrigen, posicion: pos && pos !== "?" ? pos : "SIN_ASIGNAR",
      delta: comp.unidades, tipo: "entrada",
      motivo: "despick", operario,
      nota: `Reversión picking: ${linea.skuVenta} ×${comp.unidades} (despick)`,
      idempotency_key: `despick-${sessionId}-${lineaId}-${compIdx}-${Date.now()}`,
    });
  }

  // Revertir estado del componente
  comp.estado = "PENDIENTE";
  comp.pickedAt = null;
  comp.operario = null;

  // Revertir estado de la línea
  linea.estado = "PENDIENTE";
  linea.estadoArmado = null;

  // Patch solo esta línea — la RPC recalcula estado de sesión (EN_PROCESO porque ahora hay pendientes)
  await db.patchLineaPicking(sessionId, linea.id, {
    componentes: linea.componentes,
    estado: "PENDIENTE",
    estadoArmado: null,
  });
  db.enqueueAndSync([comp.skuOrigen]);

  return true;
}

// Pick a component in envio_full session + decrement stock
// Uses same structure as Flex: each line has componentes[0]
export async function pickearLineaFull(
  sessionId: string, lineaId: string, operario: string,
  _session: db.DBPickingSession, skuVenta?: string, cantidadReal?: number,
  scanned?: { mode: "scanned" | "manual"; codigo?: string }
): Promise<boolean> {
  await db.auditLog("pickearLineaFull", {
    entidad: "picking_session", entidad_id: sessionId, operario,
    params: { lineaId, skuVenta, cantidadReal, scanMode: scanned?.mode || "manual", scanCodigo: scanned?.codigo || null },
  });

  // Read fresh session from DB to avoid stale state overwrites
  const sessions = await db.getActivePickingSessions();
  const freshSession = sessions.find(s => s.id === sessionId);
  if (!freshSession) {
    console.warn("[Picking Full] Could not read fresh session, using passed reference");
    // Fallback to passed session
    const linea = _session.lineas.find(l => l.id === lineaId);
    if (!linea) return false;
    const comp = linea.componentes[0];
    if (!comp || comp.estado === "PICKEADO") return false;
    if (isConfigured()) {
      await db.liberarReserva({
        sku: comp.skuOrigen, cantidad: comp.unidades, descontar: false,
        motivo: "envio_full", operario,
        idempotency_key_prefix: `full-pick-${sessionId}-${lineaId}`,
      }).catch(() => {});
      await db.registrarMovimientoStock({
        sku: comp.skuOrigen, posicion: comp.posicion && comp.posicion !== "?" ? comp.posicion : "SIN_ASIGNAR",
        delta: -comp.unidades, tipo: "salida",
        motivo: "envio_full", operario,
        nota: `Envío Full: ${linea.skuVenta} (${comp.unidades} uds) — ${_session.titulo || `Sesión ${sessionId.slice(0, 8)}`} [fallback]`,
        idempotency_key: `full-pick-${sessionId}-${lineaId}`,
      });
    }
    comp.estado = "PICKEADO"; comp.pickedAt = new Date().toISOString(); comp.operario = operario; linea.estado = "PICKEADO";
    await db.updatePickingSession(sessionId, { lineas: _session.lineas, estado: _session.lineas.every(l => l.estado === "PICKEADO") ? "COMPLETADA" : "EN_PROCESO" });
    db.enqueueAndSync([comp.skuOrigen]);
    return true;
  }

  // Find linea by ID + skuVenta (handles duplicate IDs)
  const targetSku = skuVenta || _session.lineas.find(l => l.id === lineaId)?.skuVenta;
  let linea = freshSession.lineas.find(l => l.skuVenta === targetSku && l.estado !== "PICKEADO")
    || freshSession.lineas.find(l => l.id === lineaId && l.skuVenta === targetSku)
    || freshSession.lineas.find(l => l.id === lineaId);
  if (!linea) return false;
  const comp = linea.componentes[0];
  if (!comp || comp.estado === "PICKEADO") return false;

  // If cantidadReal provided and different from requested, update the line
  if (cantidadReal !== undefined && cantidadReal < comp.unidades) {
    comp.unidades = cantidadReal;
    linea.qtyFisica = cantidadReal;
    linea.qtyPedida = cantidadReal;
  }

  // Mark as picked FIRST, then save to DB, then decrement stock
  // This ensures the session update happens before stock movement
  comp.estado = "PICKEADO";
  comp.pickedAt = new Date().toISOString();
  comp.operario = operario;
  (comp as unknown as Record<string, unknown>).scanMode = scanned?.mode || "manual";
  if (scanned?.codigo) (comp as unknown as Record<string, unknown>).scanCodigo = scanned.codigo;
  linea.estado = "PICKEADO";

  const patch: Partial<db.PickingLinea> = {
    componentes: linea.componentes,
    estado: "PICKEADO",
  };
  if (cantidadReal !== undefined && cantidadReal < (linea.qtyPedida ?? comp.unidades)) {
    patch.qtyPedida = linea.qtyPedida;
    patch.qtyFisica = linea.qtyFisica;
  }
  const patched = await db.patchLineaPicking(sessionId, linea.id, patch);
  if (!patched) {
    console.error(`[Picking Full] patchLineaPicking failed for ${linea.id}`);
    await db.auditLog("pickearLineaFull:patch_error", {
      entidad: "picking_session", entidad_id: sessionId, operario,
      params: { lineaId: linea.id, sku: comp.skuOrigen },
    }).catch(() => {});
    return false;
  }

  // Probable done detection: if every other line in fresh snapshot was already
  // PICKEADO+armado, this pick likely completed the session.
  let sessionDone = false;
  const prevAllPickedExceptMe = freshSession.lineas.every(l => l.id === linea.id || l.estado === "PICKEADO");
  const prevAllArmadoExceptMe = freshSession.lineas.every(l => l.id === linea.id || !l.estadoArmado || l.estadoArmado === "COMPLETADO");
  if (prevAllPickedExceptMe && prevAllArmadoExceptMe) {
    const after = await db.getActivePickingSessions();
    sessionDone = !after.some(s => s.id === sessionId);
  }

  // Deduct stock fire & forget — don't block UI, session is already saved as PICKEADO
  if (isConfigured()) {
    const skuOrigen = comp.skuOrigen;
    const unidades = comp.unidades;
    const posicion = comp.posicion && comp.posicion !== "?" ? comp.posicion : "SIN_ASIGNAR";
    const skuVentaLabel = linea.skuVenta;
    (async () => {
      try {
        // Release reservation WITHOUT stock deduction (just free the reservation)
        await db.liberarReserva({
          sku: skuOrigen, cantidad: unidades, descontar: false,
          motivo: "envio_full", operario,
          idempotency_key_prefix: `full-pick-${sessionId}-${linea.id}`,
        }).catch(() => {}); // Ignore if no reservation exists
        // Always register the stock movement separately (single source of truth)
        const movId = await db.registrarMovimientoStock({
          sku: skuOrigen, posicion, delta: -unidades, tipo: "salida",
          motivo: "envio_full", operario,
          nota: `Envío Full: ${skuVentaLabel} (${unidades} uds) — ${freshSession.titulo || `Sesión ${sessionId.slice(0, 8)}`}`,
          idempotency_key: `full-pick-${sessionId}-${linea.id}`,
        });
        // Chunk 3: registrar tránsito Full (bodega → ML facility) hasta que se reconcilie
        // contra stock_full_cache. Esto cierra el gap de "stock invisible en tránsito".
        try {
          const sb2 = db.getSupabase();
          if (sb2) {
            const { error: tErr } = await sb2.from("stock_en_transito_full").insert({
              sku_origen: skuOrigen,
              cantidad: unidades,
              fecha_salida_bodega: new Date().toISOString(),
              movimiento_salida_id: movId || null,
              estado: "EN_TRANSITO",
              notas: `picking ${sessionId.slice(0, 8)} → ${skuVentaLabel}`,
            });
            if (tErr) console.error(`[pickearLineaFull] insert transito: ${tErr.message}`);
          }
        } catch (eT) {
          console.error("[pickearLineaFull] transito insert error:", eT);
        }
        await db.auditLog("pickearLineaFull:ok", {
          entidad: "picking_session", entidad_id: sessionId, operario,
          resultado: { lineaId, sku: skuOrigen, qty: unidades, posicion, skuVenta: skuVentaLabel, sessionDone },
        });
        // Sync stock to ML immediately after deduction
        db.enqueueAndSync([skuOrigen]);
      } catch (e) {
        console.error("[Picking Full] Stock deduction failed:", e);
        await db.auditLog("pickearLineaFull:stock_error", {
          entidad: "picking_session", entidad_id: sessionId, operario,
          params: { sku: skuOrigen, qty: unidades, posicion },
          error: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
      }
    })().catch(console.error);
  }

  if (sessionDone) {
    import("./agents-triggers").then(m => m.dispararTrigger("picking_completado", { session_id: sessionId, tipo: "envio_full" })).catch(() => {});
  }

  return true;
}

// Guardar info de bultos en una línea de picking
export async function guardarBultosLinea(
  sessionId: string, lineaId: string,
  bultos: number, bultoCompartido: string | null,
  _session: db.DBPickingSession
): Promise<boolean> {
  // Patch atómico: solo los campos de bultos. La RPC preserva estado/componentes
  // y no los reescribe con un snapshot potencialmente viejo.
  return db.patchLineaPicking(sessionId, lineaId, {
    bultos,
    bultoCompartido,
  });
}

// Mark armado as completed for a line in envio_full session
export async function marcarArmadoFull(
  sessionId: string, lineaId: string, operario: string,
  _session: db.DBPickingSession
): Promise<boolean> {
  // Read fresh solo para el probable-done check. El patch es atómico.
  const sessions = await db.getActivePickingSessions();
  const freshSession = sessions.find(s => s.id === sessionId) || _session;
  const linea = freshSession.lineas.find(l => l.id === lineaId);
  if (!linea || linea.estadoArmado === "COMPLETADO") return false;

  const patched = await db.patchLineaPicking(sessionId, lineaId, {
    estadoArmado: "COMPLETADO",
  });
  if (!patched) return false;

  // Probable done: si antes todo estaba pickeado y todo menos esta línea estaba armado,
  // este armado probablemente cerró la sesión.
  let sessionDone = false;
  const prevAllPicked = freshSession.lineas.every(l => l.estado === "PICKEADO");
  const prevAllArmadoExceptMe = freshSession.lineas.every(l => l.id === lineaId || !l.estadoArmado || l.estadoArmado === "COMPLETADO");
  if (prevAllPicked && prevAllArmadoExceptMe) {
    const after = await db.getActivePickingSessions();
    sessionDone = !after.some(s => s.id === sessionId);
  }

  if (sessionDone) {
    import("./agents-triggers").then(m => m.dispararTrigger("picking_completado", { session_id: sessionId, tipo: "envio_full" })).catch(() => {});
  }

  return true;
}

// ==================== RECEPCION ADMIN (metadata, anular, pausar, asignar) ====================

export interface RecepcionMeta {
  notas: string;
  asignados: string[];
  motivo_anulacion?: string;
}

export function parseRecepcionMeta(notasField: string): RecepcionMeta {
  if (!notasField) return { notas: "", asignados: [] };
  try {
    const parsed = JSON.parse(notasField);
    if (parsed && typeof parsed === "object" && "notas" in parsed) {
      return { notas: parsed.notas || "", asignados: parsed.asignados || [], motivo_anulacion: parsed.motivo_anulacion || "" };
    }
  } catch { /* not JSON, legacy plain text */ }
  return { notas: notasField, asignados: [] };
}

export function encodeRecepcionMeta(meta: RecepcionMeta): string {
  return JSON.stringify({ notas: meta.notas, asignados: meta.asignados, ...(meta.motivo_anulacion ? { motivo_anulacion: meta.motivo_anulacion } : {}) });
}

export async function anularRecepcion(id: string, motivo: string) {
  const recs = await db.fetchRecepciones();
  const rec = recs.find(r => r.id === id);
  const meta = parseRecepcionMeta(rec?.notas || "");
  meta.motivo_anulacion = motivo;
  await db.updateRecepcion(id, { estado: "ANULADA" as db.DBRecepcion["estado"], notas: encodeRecepcionMeta(meta) });

  // Auto-rechazar discrepancias de costo pendientes de esta recepción.
  // No tiene sentido revisarlas si la recepción ya no existe.
  const sb = getSupabase();
  if (sb) {
    try {
      await sb.from("discrepancias_costo")
        .update({
          estado: "RECHAZADO",
          resuelto_por: "sistema",
          resuelto_at: new Date().toISOString(),
          notas: `Auto-rechazada: recepción anulada. Motivo: ${motivo}`,
        })
        .eq("recepcion_id", id)
        .eq("estado", "PENDIENTE");
    } catch (e) {
      console.warn("[anularRecepcion] No se pudieron auto-rechazar discrepancias:", e);
    }
  }
}

export async function pausarRecepcion(id: string) {
  await db.updateRecepcion(id, { estado: "PAUSADA" as db.DBRecepcion["estado"] });
}

export async function reactivarRecepcion(id: string) {
  await db.updateRecepcion(id, { estado: "CREADA" });
}

export interface IntegrityError {
  sku: string;
  tipo: "mov_vs_ubicada" | "ubicada_vs_recibida";
  esperado: number;
  actual: number;
  diferencia: number;
}

// Verify integrity of a reception: movimientos match qty_ubicada, qty_ubicada match qty_recibida
export async function verificarIntegridadRecepcion(recepcionId: string): Promise<IntegrityError[]> {
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const sb = db.getSupabase();
  const errores: IntegrityError[] = [];
  for (const l of lineas) {
    if ((l.qty_ubicada || 0) === 0 && (l.qty_recibida || 0) === 0) continue;
    // Check movimientos vs qty_ubicada
    if (sb) {
      const { data: calc } = await sb.rpc("calcular_qty_ubicada", { p_recepcion_id: recepcionId, p_sku: l.sku });
      const movTotal = (calc as number) ?? 0;
      const ubicada = l.qty_ubicada || 0;
      if (movTotal !== ubicada) {
        errores.push({ sku: l.sku, tipo: "mov_vs_ubicada", esperado: ubicada, actual: movTotal, diferencia: movTotal - ubicada });
      }
    }
    // Check qty_ubicada vs qty_recibida (warning, not blocking — there may be resolved discrepancies)
    const recibida = l.qty_recibida || 0;
    const ubicada = l.qty_ubicada || 0;
    if (recibida > 0 && ubicada !== recibida) {
      errores.push({ sku: l.sku, tipo: "ubicada_vs_recibida", esperado: recibida, actual: ubicada, diferencia: ubicada - recibida });
    }
  }
  return errores;
}

export async function cerrarRecepcion(id: string): Promise<{ ok: boolean; pendientes?: number; pendientesQty?: number; integridad?: IntegrityError[] }> {
  // 1. First recalculate qty_ubicada from movimientos to fix any drift
  await recalcularQtyUbicadaRecepcion(id);

  // 2. Verify integrity
  const integridad = await verificarIntegridadRecepcion(id);
  const erroresCriticos = integridad.filter(e => e.tipo === "mov_vs_ubicada");
  if (erroresCriticos.length > 0) {
    // Block close — movimientos don't match qty_ubicada (shouldn't happen after recalc, but safety net)
    return { ok: false, integridad: erroresCriticos };
  }

  // 3. Asegurar que las discrepancias existen antes de chequearlas.
  //    detectarDiscrepancias/Qty hacen early-return si ya existen filas,
  //    así que es idempotente y seguro llamarlas al cierre. Sin esto, si
  //    nadie abrió el detalle en el admin, las filas nunca existen y el
  //    cierre pasa silencioso con el WAC contaminado.
  const lineasActuales = await db.fetchRecepcionLineas(id);
  await detectarDiscrepancias(id, lineasActuales);
  await detectarDiscrepanciasQty(id, lineasActuales);

  // 4. Check discrepancies
  const [discs, discsQty] = await Promise.all([
    db.fetchDiscrepancias(id),
    db.fetchDiscrepanciasQty(id),
  ]);
  const pendientes = discs.filter(d => d.estado === "PENDIENTE").length;
  const pendientesQty = discsQty.filter(d => d.estado === "PENDIENTE").length;
  if (pendientes > 0 || pendientesQty > 0) return { ok: false, pendientes, pendientesQty };

  // 4. All good — close
  await db.updateRecepcion(id, { estado: "CERRADA" });
  await db.auditLog("cerrarRecepcion:ok", {
    entidad: "recepcion", entidad_id: id,
    resultado: { integridad_warnings: integridad.filter(e => e.tipo === "ubicada_vs_recibida").length },
  });
  import("./agents-triggers").then(m => m.dispararTrigger("recepcion_cerrada", { recepcion_id: id })).catch(() => {});
  return { ok: true };
}

export async function asignarOperariosRecepcion(id: string, operarios: string[], currentNotas: string) {
  const meta = parseRecepcionMeta(currentNotas);
  meta.asignados = operarios;
  await db.updateRecepcion(id, { notas: encodeRecepcionMeta(meta) });
}

export async function getRecepcionesParaOperario(operarioNombre: string) {
  const recs = await db.fetchRecepcionesActivas();
  return recs.filter(rec => {
    const { asignados } = parseRecepcionMeta(rec.notas || "");
    if (asignados.length === 0) return true;
    return asignados.some(a => a.toLowerCase() === operarioNombre.toLowerCase());
  });
}

export async function eliminarLineaRecepcion(lineaId: string) {
  await db.deleteRecepcionLinea(lineaId);
}

// Fetch all lines from multiple receptions (unified view)
export async function getLineasDeRecepciones(recIds: string[]) { return db.fetchLineasDeRecepciones(recIds); }

// Lock/unlock lines
export async function bloquearLinea(lineaId: string, operario: string) { return db.bloquearLinea(lineaId, operario); }
export async function renovarBloqueo(lineaId: string, operario: string) { return db.renovarBloqueo(lineaId, operario); }
export async function desbloquearLinea(lineaId: string) { return db.desbloquearLinea(lineaId); }

// Check if a line is locked by someone else
export function isLineaBloqueada(linea: db.DBRecepcionLinea, operario: string): { blocked: boolean; by: string } {
  if (!linea.bloqueado_por) return { blocked: false, by: "" };
  if (linea.bloqueado_por === operario) return { blocked: false, by: "" };
  if (linea.bloqueado_hasta && new Date(linea.bloqueado_hasta) < new Date()) return { blocked: false, by: "" };
  return { blocked: true, by: linea.bloqueado_por };
}

export async function agregarLineaRecepcion(recepcionId: string, linea: { sku: string; codigoML: string; nombre: string; cantidad: number; costo: number; requiereEtiqueta: boolean }) {
  const autoFormato = _resolverFormatoVenta(linea.sku);
  await db.insertRecepcionLineas([{
    recepcion_id: recepcionId, sku: linea.sku, codigo_ml: linea.codigoML,
    nombre: linea.nombre, qty_factura: linea.cantidad, qty_recibida: 0,
    qty_etiquetada: 0, qty_ubicada: 0, estado: "PENDIENTE" as const,
    requiere_etiqueta: autoFormato ? true : linea.requiereEtiqueta,
    costo_unitario: linea.costo,
    sku_venta: autoFormato || undefined,
    notas: "", operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "",
  }]);
}

// ==================== RECEPCION AJUSTES ====================

export async function getRecepcionAjustes(recId: string) { return db.fetchRecepcionAjustes(recId); }

export async function registrarAjuste(ajuste: Omit<db.DBRecepcionAjuste, "id" | "created_at">) {
  await db.insertRecepcionAjuste(ajuste);
}

/** Backfill factura_original para recepciones viejas que no lo tienen */
export async function backfillFacturaOriginal(recepcionId: string, lineas: db.DBRecepcionLinea[], rec: db.DBRecepcion): Promise<db.FacturaOriginal> {
  const snapshot: db.FacturaOriginal = {
    lineas: lineas.map(l => ({ sku: l.sku, nombre: l.nombre, cantidad: l.qty_factura, costo_unitario: l.costo_unitario || 0 })),
    neto: rec.costo_neto || lineas.reduce((s, l) => s + l.qty_factura * (l.costo_unitario || 0), 0),
    iva: rec.iva || Math.round((rec.costo_neto || lineas.reduce((s, l) => s + l.qty_factura * (l.costo_unitario || 0), 0)) * 0.19),
    bruto: rec.costo_bruto || Math.round((rec.costo_neto || lineas.reduce((s, l) => s + l.qty_factura * (l.costo_unitario || 0), 0)) * 1.19),
  };
  await db.updateRecepcionFacturaOriginal(recepcionId, snapshot);
  return snapshot;
}

// ==================== DISCREPANCIAS DE COSTO ====================

/**
 * Detección de discrepancias de costo (Chunk 3, plan §2.1).
 *
 * - Comparación: factura vs proveedor_catalogo.precio_neto WHERE es_principal=true.
 * - Tolerancia ABC: A=$1, B=2%, C=5% (config-costos.ts).
 * - Sin early-return: re-detecta líneas nuevas aunque la recepción ya tenga
 *   discrepancias previas (las PENDIENTE existentes se preservan vía linea_id check).
 * - Caso A7 (auto-poblar catálogo): si NO hay catálogo principal, o el precio_neto
 *   es 0 (zombie), upserta el catálogo con el costo_facturado y NO crea disc.
 *   La primera factura se vuelve la fuente de verdad para ese SKU/proveedor.
 */
export async function detectarDiscrepancias(recepcionId: string, lineas: db.DBRecepcionLinea[]): Promise<db.DBDiscrepanciaCosto[]> {
  const sb = getSupabase();
  if (!sb) return db.fetchDiscrepancias(recepcionId);

  const existentes = await db.fetchDiscrepancias(recepcionId);
  // Indexar por linea_id para evitar duplicar disc cuando se vuelve a llamar
  const existentesPorLinea = new Set(existentes.map(d => d.linea_id).filter(Boolean));

  // Lookup: ABC por SKU
  const skus = Array.from(new Set(lineas.map(l => (l.sku || "").toUpperCase()).filter(Boolean)));
  let abcPorSku = new Map<string, ABCClase>();
  if (skus.length > 0) {
    const { data: intelRows } = await sb.from("sku_intelligence")
      .select("sku_origen, abc")
      .in("sku_origen", skus);
    abcPorSku = new Map(((intelRows || []) as Array<{ sku_origen: string; abc: string | null }>)
      .map(r => [r.sku_origen.toUpperCase(), (r.abc || "C") as ABCClase]));
  }

  // Lookup: catálogo principal por SKU
  let catalogoPorSku = new Map<string, { precio: number; provId: string | null; provNombre: string | null }>();
  if (skus.length > 0) {
    const { data: catRows } = await sb.from("proveedor_catalogo")
      .select("sku_origen, precio_neto, proveedor_id, proveedor")
      .eq("es_principal", true)
      .in("sku_origen", skus);
    catalogoPorSku = new Map(((catRows || []) as Array<{ sku_origen: string; precio_neto: number; proveedor_id: string | null; proveedor: string | null }>)
      .map(r => [r.sku_origen.toUpperCase(), { precio: r.precio_neto || 0, provId: r.proveedor_id, provNombre: r.proveedor }]));
  }

  // Recepción → proveedor para auto-poblar catálogo en caso A7
  const { data: recRow } = await sb.from("recepciones")
    .select("proveedor, proveedor_id").eq("id", recepcionId).single();
  const recProveedor = (recRow as { proveedor: string | null; proveedor_id: string | null } | null);

  const nuevas: Omit<db.DBDiscrepanciaCosto, "id" | "created_at">[] = [];
  for (const l of lineas) {
    if (!l.id || existentesPorLinea.has(l.id)) continue; // skip líneas que ya tienen disc
    const skuUp = (l.sku || "").toUpperCase();
    if (!skuUp) continue;

    const costoFact = l.costo_unitario || 0;
    if (costoFact <= 0) continue;

    const cat = catalogoPorSku.get(skuUp);
    const precioCatalogo = cat?.precio || 0;

    // Caso A7: sin catálogo o catálogo zombie → auto-poblar y NO crear disc
    if (precioCatalogo <= 0) {
      const proveedor = cat?.provNombre || recProveedor?.proveedor || null;
      if (proveedor) {
        const upsert: Record<string, unknown> = {
          proveedor,
          sku_origen: skuUp,
          precio_neto: costoFact,
          es_principal: true,
          updated_at: new Date().toISOString(),
          updated_by: "auto-primera-factura",
          motivo_ultimo_cambio: `auto-creado-primera-factura folio recepcion ${recepcionId.slice(0, 8)}`,
        };
        if (cat?.provId || recProveedor?.proveedor_id) {
          upsert.proveedor_id = cat?.provId || recProveedor?.proveedor_id;
        }
        const { error: upErr } = await sb.from("proveedor_catalogo")
          .upsert(upsert, { onConflict: "proveedor,sku_origen" });
        if (upErr) console.error(`[detectarDiscrepancias:A7] upsert ${proveedor}/${skuUp}: ${upErr.message}`);
      }
      continue;
    }

    // Caso normal: comparar factura vs catálogo con tolerancia ABC
    const abc = abcPorSku.get(skuUp);
    if (dentroDeTolerancia(precioCatalogo, costoFact, abc)) continue;

    const diff = costoFact - precioCatalogo;
    const pct = Math.round((diff / precioCatalogo) * 1000) / 10;
    nuevas.push({
      recepcion_id: recepcionId, linea_id: l.id, sku: skuUp,
      costo_diccionario: precioCatalogo, costo_factura: costoFact,
      diferencia: diff, porcentaje: pct, estado: "PENDIENTE",
    });
  }
  if (nuevas.length > 0) {
    await db.insertDiscrepancias(nuevas);
    import("./agents-triggers").then(m => m.dispararTrigger("discrepancia_costo_detectada", {
      recepcion_id: recepcionId, cantidad: nuevas.length,
      skus: nuevas.map(n => n.sku),
    })).catch(() => {});
  }
  return db.fetchDiscrepancias(recepcionId);
}

export async function getDiscrepancias(recepcionId: string): Promise<db.DBDiscrepanciaCosto[]> {
  return db.fetchDiscrepancias(recepcionId);
}

export async function recalcularDiscrepancias(recepcionId: string, lineas: db.DBRecepcionLinea[]): Promise<db.DBDiscrepanciaCosto[]> {
  // Delete existing PENDIENTE discrepancies and re-detect
  await db.deleteDiscrepanciasPendientes(recepcionId);
  return detectarDiscrepancias(recepcionId, lineas);
}

/**
 * Detección "preview" de discrepancia para una línea individual al momento
 * de ubicar (Chunk 5, plan §6.1). NO crea disc — solo informa al UI si
 * debe mostrar el modal o auto-popular catálogo (caso A7).
 */
export interface DiscrepanciaLineaPreview {
  /** true si la diferencia entre factura y catálogo supera la tolerancia ABC */
  fueraTolerancia: boolean;
  /** true si no hay catálogo principal con precio>0 (auto-popular antes de ubicar) */
  casoA7: boolean;
  precioAcordado: number;
  costoFacturado: number;
  abc: ABCClase;
  /** Proveedor de la recepción (para auto-popular catálogo en caso A7) */
  proveedorRecepcion: string | null;
  proveedorIdRecepcion: string | null;
}

export async function detectarDiscrepanciaLinea(
  sku: string, costoFacturado: number, recepcionId: string,
): Promise<DiscrepanciaLineaPreview> {
  const sb = getSupabase();
  const skuUp = (sku || "").toUpperCase().trim();
  const base: DiscrepanciaLineaPreview = {
    fueraTolerancia: false, casoA7: false,
    precioAcordado: 0, costoFacturado: costoFacturado || 0,
    abc: null,
    proveedorRecepcion: null, proveedorIdRecepcion: null,
  };
  if (!sb || !skuUp || costoFacturado <= 0) return base;

  const [{ data: catRow }, { data: intelRow }, { data: recRow }] = await Promise.all([
    sb.from("proveedor_catalogo")
      .select("precio_neto").eq("sku_origen", skuUp).eq("es_principal", true).maybeSingle(),
    sb.from("sku_intelligence").select("abc").eq("sku_origen", skuUp).maybeSingle(),
    sb.from("recepciones").select("proveedor, proveedor_id").eq("id", recepcionId).maybeSingle(),
  ]);

  const precio = (catRow as { precio_neto: number } | null)?.precio_neto || 0;
  const abc = ((intelRow as { abc: string | null } | null)?.abc || null) as ABCClase;
  const rec = recRow as { proveedor: string | null; proveedor_id: string | null } | null;

  base.precioAcordado = precio;
  base.abc = abc;
  base.proveedorRecepcion = rec?.proveedor || null;
  base.proveedorIdRecepcion = rec?.proveedor_id || null;

  if (precio <= 0) {
    base.casoA7 = true;
    return base;
  }
  base.fueraTolerancia = !dentroDeTolerancia(precio, costoFacturado, abc);
  return base;
}

/**
 * Normaliza nombre de proveedor para match flexible: uppercase, sin
 * sufijos legales (S.A./SPA/LTDA/LIMITADA/SRL/EIRL), sin signos de
 * puntuación, espacios colapsados.
 *
 * Usado por alimentarCatalogoProveedor y autoPopularCatalogoCasoA7
 * para el path de match "fuzzy" cuando no hay proveedor_id.
 */
function normalizarProveedor(s: string | null | undefined): string {
  return (s || "").toUpperCase().trim()
    .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
    .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Auto-popula proveedor_catalogo con el costo facturado en caso A7
 * (SKU sin catálogo previo o con precio_neto=0 zombie). Llamar antes
 * de ubicar para que la línea quede con catálogo válido.
 *
 * Match prioritario por proveedor_id (FK) para evitar filas huérfanas
 * por desnormalización (mismo bug que alimentarCatalogoProveedor).
 */
export async function autoPopularCatalogoCasoA7(
  sku: string, costoFacturado: number, recepcionId: string,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const skuUp = (sku || "").toUpperCase().trim();
  if (!skuUp || !costoFacturado || costoFacturado <= 0) return;
  const { data: recRow } = await sb.from("recepciones")
    .select("proveedor, proveedor_id").eq("id", recepcionId).maybeSingle();
  const rec = recRow as { proveedor: string | null; proveedor_id: string | null } | null;
  const proveedor = rec?.proveedor;
  if (!proveedor) return;
  const proveedorIdRec = rec?.proveedor_id || null;

  const fields: Record<string, unknown> = {
    precio_neto: costoFacturado,
    es_principal: true,
    updated_at: new Date().toISOString(),
    updated_by: "auto-primera-factura",
    motivo_ultimo_cambio: `auto-primera-factura recepcion ${recepcionId.slice(0, 8)}`,
  };

  // 1. Match por proveedor_id si lo tenemos
  if (proveedorIdRec) {
    const { data: byFK } = await sb.from("proveedor_catalogo")
      .select("id").eq("sku_origen", skuUp).eq("proveedor_id", proveedorIdRec).maybeSingle();
    if (byFK) {
      await sb.from("proveedor_catalogo")
        .update(fields).eq("id", (byFK as { id: string }).id);
      return;
    }
  }

  // 2. Match por proveedor texto exacto
  const { data: byString } = await sb.from("proveedor_catalogo")
    .select("id, proveedor_id").eq("sku_origen", skuUp).eq("proveedor", proveedor).maybeSingle();
  if (byString) {
    const updates = { ...fields };
    const existing = byString as { id: string; proveedor_id: string | null };
    if (proveedorIdRec && !existing.proveedor_id) updates.proveedor_id = proveedorIdRec;
    await sb.from("proveedor_catalogo").update(updates).eq("id", existing.id);
    return;
  }

  // 2.5. Match por proveedor normalizado contra todas las filas del SKU
  const { data: candidatos } = await sb.from("proveedor_catalogo")
    .select("id, proveedor, proveedor_id").eq("sku_origen", skuUp);
  const candList = (candidatos || []) as Array<{ id: string; proveedor: string; proveedor_id: string | null }>;
  const recNorm = normalizarProveedor(proveedor);
  const fuzzy = candList.find(c => normalizarProveedor(c.proveedor) === recNorm);
  if (fuzzy) {
    const updates = { ...fields };
    if (proveedorIdRec && !fuzzy.proveedor_id) updates.proveedor_id = proveedorIdRec;
    await sb.from("proveedor_catalogo").update(updates).eq("id", fuzzy.id);
    return;
  }

  // 3. No hay row para este (sku, proveedor): INSERT como nuevo principal
  const insertRow: Record<string, unknown> = {
    proveedor, sku_origen: skuUp, ...fields,
  };
  if (proveedorIdRec) insertRow.proveedor_id = proveedorIdRec;
  await sb.from("proveedor_catalogo").insert(insertRow);
}

/**
 * Crea una discrepancia PENDIENTE asociada a una línea, antes de invocar
 * registrar_movimiento_stock. La RPC v37 detectará la disc y aplicará
 * el precio_acordado del catálogo en lugar del costo facturado.
 *
 * Devuelve el id de la disc creada (o existente si ya había una para esa línea).
 */
export async function crearDiscrepanciaPendienteParaUbicar(opts: {
  lineaId: string;
  sku: string;
  costoFacturado: number;
  precioAcordado: number;
  recepcionId: string;
}): Promise<string> {
  const sb = getSupabase();
  if (!sb) throw new Error("Sin conexión a Supabase");
  const skuUp = (opts.sku || "").toUpperCase().trim();
  // Ya hay disc para esta línea? evitar duplicar
  const existentes = await db.fetchDiscrepancias(opts.recepcionId);
  const existing = existentes.find(d => d.linea_id === opts.lineaId);
  if (existing && existing.id) return existing.id;

  const diff = opts.costoFacturado - opts.precioAcordado;
  const pct = opts.precioAcordado > 0
    ? Math.round((diff / opts.precioAcordado) * 1000) / 10
    : 0;
  const { data, error } = await sb.from("discrepancias_costo").insert({
    recepcion_id: opts.recepcionId,
    linea_id: opts.lineaId,
    sku: skuUp,
    costo_diccionario: opts.precioAcordado,
    costo_factura: opts.costoFacturado,
    diferencia: diff,
    porcentaje: pct,
    estado: "PENDIENTE",
  }).select("id").single();
  if (error) throw new Error(`crearDiscrepanciaPendienteParaUbicar: ${error.message}`);
  const created = data as { id?: string } | null;
  if (!created?.id) throw new Error("crearDiscrepanciaPendienteParaUbicar: insert no devolvió id");
  return created.id;
}

/**
 * Estimación pre-aprobación de impacto: cuántas ventas se recomputarán y
 * delta agregado de costo (Chunk 6, modal Aprobar con preview).
 *
 * Estimación lineal: por cada venta posterior a la recepción, compara el
 * `costo_producto` snapshotteado con el `nuevoCosto` (para SKU origen
 * directo; para packs aplica `unidades` × delta).
 *
 * No persiste nada — solo lectura.
 */
export async function calcularPreviewImpactoAprobacion(opts: {
  discId: string;
  nuevoCosto: number;
}): Promise<{
  ventasAfectadas: number;
  costoTotalDelta: number; // suma de (nuevoCosto - costoActual) * unidades sobre todas las ventas
  cutoffISO: string | null;
}> {
  const sb = getSupabase();
  if (!sb) return { ventasAfectadas: 0, costoTotalDelta: 0, cutoffISO: null };

  const { data: discRow } = await sb.from("discrepancias_costo")
    .select("recepcion_id, sku").eq("id", opts.discId).maybeSingle();
  const disc = discRow as { recepcion_id: string; sku: string } | null;
  if (!disc) return { ventasAfectadas: 0, costoTotalDelta: 0, cutoffISO: null };

  const skuUp = (disc.sku || "").toUpperCase();
  const { data: recRow } = await sb.from("recepciones")
    .select("created_at").eq("id", disc.recepcion_id).maybeSingle();
  const cutoff = (recRow as { created_at: string } | null)?.created_at;
  if (!cutoff) return { ventasAfectadas: 0, costoTotalDelta: 0, cutoffISO: null };

  // SKUs de venta que pueden involucrar este SKU origen (directo + packs)
  const { data: compRows } = await sb.from("composicion_venta")
    .select("sku_venta, sku_origen, unidades").eq("sku_origen", skuUp);
  const comps = (compRows || []) as Array<{ sku_venta: string; sku_origen: string; unidades: number }>;
  const skuVentas = new Set<string>([skuUp, ...comps.map(c => (c.sku_venta || "").toUpperCase())]);
  const unidadesPorVenta = new Map<string, number>();
  unidadesPorVenta.set(skuUp, 1);
  for (const c of comps) unidadesPorVenta.set(c.sku_venta.toUpperCase(), c.unidades || 1);

  if (skuVentas.size === 0) return { ventasAfectadas: 0, costoTotalDelta: 0, cutoffISO: cutoff };

  const { data: ventasRaw } = await sb.from("ventas_ml_cache")
    .select("order_id, sku_venta, cantidad, costo_producto")
    .in("sku_venta", Array.from(skuVentas))
    .gte("fecha", cutoff)
    .eq("anulada", false);
  const ventas = (ventasRaw || []) as Array<{ order_id: string; sku_venta: string; cantidad: number; costo_producto: number | null }>;

  let totalDelta = 0;
  for (const v of ventas) {
    const factorUnidades = unidadesPorVenta.get((v.sku_venta || "").toUpperCase()) || 1;
    const costoNuevoLinea = opts.nuevoCosto * factorUnidades * (v.cantidad || 0);
    const costoActualLinea = (v.costo_producto || 0) * (v.cantidad || 0);
    totalDelta += (costoNuevoLinea - costoActualLinea);
  }
  return {
    ventasAfectadas: ventas.length,
    costoTotalDelta: totalDelta,
    cutoffISO: cutoff,
  };
}

/**
 * Notifica a Vicente cuando una línea no se puede ubicar porque le falta
 * info de costo (sin catálogo y sin costo facturado). Caso D del nuevo
 * Chunk 5: el operador no decide, solo se entera y avisa.
 */
export async function notificarFaltaCostoEnLinea(opts: {
  sku: string; recepcionId: string; folio: string; operario: string;
}): Promise<void> {
  const lines = [
    "⚠️ Falta costo en línea de recepción",
    `SKU: ${opts.sku}`,
    `Recepción: ${opts.folio}`,
    `Operario: ${opts.operario}`,
    "Acción: completar costo en /admin/recepciones para que pueda ubicarse.",
  ];
  try {
    const mod = await import("./notifications");
    await mod.enqueueNotification("whatsapp", "56991655931@s.whatsapp.net", {
      text: lines.join("\n"),
    });
  } catch (e) {
    console.error("[notificarFaltaCostoEnLinea] notify error:", e);
  }
}

/**
 * Alimenta proveedor_catalogo con el costo aprobado de una discrepancia (Chunk 3).
 *
 * Estrategia de match (en orden de prioridad para evitar filas huérfanas):
 *   1. Match por (proveedor_id, sku_origen) — FK canónico, sobrevive a la
 *      desnormalización del string `proveedor` ("Idetex" vs "IDETEX S.A.").
 *   2. Match por (proveedor texto exacto, sku_origen) — para recepciones
 *      legacy sin FK. Si la recepción aporta proveedor_id, lo backfilea.
 *   3. Si no hay match: INSERT. es_principal=true solo si no existe ningún
 *      principal para este SKU (de cualquier proveedor).
 *
 * Bug histórico (2026-05-06): el upsert con onConflict (proveedor, sku_origen)
 * creaba fila huérfana cuando recepciones.proveedor='IDETEX S.A.' (raw del
 * DTE) no matcheaba con proveedor_catalogo.proveedor='Idetex' (canónico).
 */
async function alimentarCatalogoProveedor(
  discId: string, sku: string, nuevoCosto: number, motivo: string, operario: string,
): Promise<void> {
  if (!nuevoCosto || nuevoCosto <= 0) return;
  const sb = getSupabase();
  if (!sb) return;
  try {
    const { data: disc } = await sb.from("discrepancias_costo")
      .select("recepcion_id").eq("id", discId).single();
    const recepcionId = (disc as { recepcion_id: string } | null)?.recepcion_id;
    if (!recepcionId) return;
    const { data: rec } = await sb.from("recepciones")
      .select("proveedor, proveedor_id").eq("id", recepcionId).single();
    const recProv = (rec as { proveedor: string | null; proveedor_id: string | null } | null);
    const proveedorRaw = recProv?.proveedor;
    if (!proveedorRaw) return;
    const proveedorIdRec = recProv?.proveedor_id || null;

    const fields: Record<string, unknown> = {
      precio_neto: nuevoCosto,
      updated_at: new Date().toISOString(),
      updated_by: operario,
      motivo_ultimo_cambio: motivo,
    };

    // 1. Match canónico por proveedor_id si lo tenemos
    if (proveedorIdRec) {
      const { data: byFK } = await sb.from("proveedor_catalogo")
        .select("id, es_principal")
        .eq("sku_origen", sku)
        .eq("proveedor_id", proveedorIdRec)
        .maybeSingle();
      if (byFK) {
        const { error } = await sb.from("proveedor_catalogo")
          .update(fields).eq("id", (byFK as { id: string }).id);
        if (error) console.error(`[alimentarCatalogoProveedor] update by FK ${proveedorIdRec}/${sku}: ${error.message}`);
        return;
      }
    }

    // 2. Match por (proveedor texto exacto, sku_origen)
    const { data: byString } = await sb.from("proveedor_catalogo")
      .select("id, proveedor_id")
      .eq("sku_origen", sku)
      .eq("proveedor", proveedorRaw)
      .maybeSingle();
    if (byString) {
      const updates = { ...fields };
      const existing = byString as { id: string; proveedor_id: string | null };
      if (proveedorIdRec && !existing.proveedor_id) {
        updates.proveedor_id = proveedorIdRec;
      }
      const { error } = await sb.from("proveedor_catalogo")
        .update(updates).eq("id", existing.id);
      if (error) console.error(`[alimentarCatalogoProveedor] update by string ${proveedorRaw}/${sku}: ${error.message}`);
      return;
    }

    // 2.5. Match por proveedor NORMALIZADO contra todas las filas del SKU.
    // Cubre el caso real: rec.proveedor='IDETEX S.A.' (raw DTE) vs
    // catálogo.proveedor='Idetex' (canonicalizado). Mismo proveedor real.
    const { data: candidatos } = await sb.from("proveedor_catalogo")
      .select("id, proveedor, proveedor_id").eq("sku_origen", sku);
    const candList = (candidatos || []) as Array<{ id: string; proveedor: string; proveedor_id: string | null }>;
    const recNorm = normalizarProveedor(proveedorRaw);
    const fuzzy = candList.find(c => normalizarProveedor(c.proveedor) === recNorm);
    if (fuzzy) {
      const updates = { ...fields };
      if (proveedorIdRec && !fuzzy.proveedor_id) updates.proveedor_id = proveedorIdRec;
      const { error } = await sb.from("proveedor_catalogo")
        .update(updates).eq("id", fuzzy.id);
      if (error) console.error(`[alimentarCatalogoProveedor] update fuzzy ${proveedorRaw}≈${fuzzy.proveedor}/${sku}: ${error.message}`);
      return;
    }

    // 3. No hay row para este (sku, proveedor): INSERT
    const { data: existingPrincipal } = await sb.from("proveedor_catalogo")
      .select("id").eq("sku_origen", sku).eq("es_principal", true).maybeSingle();
    const seraPrincipal = !existingPrincipal;

    const insertRow: Record<string, unknown> = {
      proveedor: proveedorRaw,
      sku_origen: sku,
      ...fields,
      es_principal: seraPrincipal,
    };
    if (proveedorIdRec) insertRow.proveedor_id = proveedorIdRec;

    const { error } = await sb.from("proveedor_catalogo").insert(insertRow);
    if (error) console.error(`[alimentarCatalogoProveedor] insert ${proveedorRaw}/${sku}: ${error.message}`);
  } catch (e) {
    console.error("[alimentarCatalogoProveedor] error:", e);
  }
}

/**
 * Aprobar nuevo costo de discrepancia (Chunk 3, plan §2.1, §6.2).
 *
 * Pasos:
 *  1. Snapshot del precio anterior del catálogo (para revertirAprobacion).
 *  2. UPDATE movimientos.costo_unitario para esta recepción+sku.
 *  3. recalcular_wac_running(sku) → productos.costo_promedio (canónico v102).
 *  4. Si !esPuntual: UPSERT proveedor_catalogo.precio_neto con motivo+updated_by.
 *  5. Recompute ventas_ml_cache para órdenes posteriores a la recepción.
 *  6. UPDATE discrepancias_costo: estado=APROBADO + es_puntual + snapshot.
 *  7. audit_log accion='costo_aprobado_v2'.
 */
export async function aprobarNuevoCosto(
  discId: string,
  sku: string,
  nuevoCosto: number,
  opciones?: { esPuntual?: boolean; notas?: string; operario?: string },
): Promise<{ dbOk: boolean; sheetResult?: Record<string, unknown>; wac_nuevo?: number; precio_anterior_snapshot: number }> {
  if (!nuevoCosto || nuevoCosto <= 0) throw new Error("nuevoCosto debe ser > 0");
  const sb = getSupabase();
  if (!sb) throw new Error("Sin conexión a Supabase");

  const skuUp = (sku || "").toUpperCase().trim();
  const esPuntual = !!opciones?.esPuntual;
  const operario = opciones?.operario || "admin";
  const notas = opciones?.notas;

  // Discrepancia → recepción
  const { data: discRow } = await sb.from("discrepancias_costo")
    .select("recepcion_id, linea_id, costo_diccionario, costo_factura").eq("id", discId).single();
  const disc = discRow as { recepcion_id: string; linea_id: string; costo_diccionario: number; costo_factura: number } | null;
  if (!disc) throw new Error(`Discrepancia ${discId} no encontrada`);

  // 1. Snapshot del catálogo principal antes de tocarlo
  const { data: catRow } = await sb.from("proveedor_catalogo")
    .select("precio_neto").eq("sku_origen", skuUp).eq("es_principal", true).maybeSingle();
  const precio_anterior_snapshot = (catRow as { precio_neto: number } | null)?.precio_neto || 0;

  // 2. UPDATE movimientos.costo_unitario para esta recepción+sku
  const { error: movErr } = await sb.from("movimientos")
    .update({ costo_unitario: nuevoCosto })
    .eq("recepcion_id", disc.recepcion_id)
    .eq("sku", skuUp)
    .eq("tipo", "entrada");
  if (movErr) console.error(`[aprobarNuevoCosto] update movimientos: ${movErr.message}`);

  // 2b. UPDATE recepcion_lineas.costo_unitario al costo aprobado (Chunk 7 fix UX 2026-05-06).
  // El snapshot del costo factura original vive en recepciones.factura_original
  // (no se rompe). Esto sincroniza la "Factura Ajustada (Real)" con el costo
  // que terminamos aplicando.
  const { error: lineaErr } = await sb.from("recepcion_lineas")
    .update({ costo_unitario: nuevoCosto })
    .eq("id", disc.linea_id);
  if (lineaErr) console.error(`[aprobarNuevoCosto] update recepcion_lineas: ${lineaErr.message}`);

  // 3. recalcular_wac_running canónico (NIC 2 stock_total + fallback opción C)
  const { data: wacData, error: wacErr } = await sb.rpc("recalcular_wac_running", { p_sku: skuUp });
  if (wacErr) console.error(`[aprobarNuevoCosto] recalcular_wac_running: ${wacErr.message}`);
  const wac_nuevo = (wacData as number | null) ?? null;
  if (_cache.products[skuUp]) _cache.products[skuUp].costAvg = wac_nuevo || _cache.products[skuUp].costAvg;

  // 4. Alimentar catálogo (solo si NO es puntual)
  if (!esPuntual) {
    const motivoCat = `aprobacion_disc_${discId.slice(0, 8)}: factura ${nuevoCosto} aceptada`;
    await alimentarCatalogoProveedor(discId, skuUp, nuevoCosto, motivoCat, operario);
  }

  // 5. Recompute ventas_ml_cache para órdenes posteriores a la recepción
  await recomputarVentasPosterioresRecepcion(disc.recepcion_id, skuUp, "aprobacion_disc");

  // 6. Claim contra proveedor (Chunk 7 LITE, v103).
  // Si nuevoCosto < costo_factura → quedó claim implícito por la diferencia.
  // IMPORTANTE: usar qty_factura (no qty_recibida). La NC del proveedor
  // cubre sobrecargo de uds facturadas. Si recibiste uds extras (sobrante),
  // esas se reclaman vía factura adicional separada (panel "Documentos
  // asociados" lo trackea como bloque distinto).
  let claimMonto: number | null = null;
  let claimEstado: "ESPERANDO_NC" | null = null;
  if (nuevoCosto < disc.costo_factura) {
    const { data: lineaRow } = await sb.from("recepcion_lineas")
      .select("qty_factura").eq("id", disc.linea_id).maybeSingle();
    const qty = (lineaRow as { qty_factura: number } | null)?.qty_factura || 0;
    if (qty > 0) {
      claimMonto = Math.round((disc.costo_factura - nuevoCosto) * qty);
      claimEstado = "ESPERANDO_NC";
    }
  }

  // 7. UPDATE discrepancia con estado, es_puntual, snapshot y claim
  const updateDisc: Record<string, unknown> = {
    estado: "APROBADO",
    resuelto_por: operario,
    resuelto_at: new Date().toISOString(),
    es_puntual: esPuntual,
    precio_anterior_snapshot,
  };
  if (notas) updateDisc.notas = notas;
  if (claimMonto !== null) {
    updateDisc.claim_monto_pendiente = claimMonto;
    updateDisc.claim_estado = claimEstado;
  }
  await db.updateDiscrepancia(discId, updateDisc);

  // 8. Audit log
  await sb.from("audit_log").insert({
    accion: "costo_aprobado_v2",
    entidad: "discrepancias_costo",
    entidad_id: discId,
    operario,
    params: { sku: skuUp, nuevo_costo: nuevoCosto, es_puntual: esPuntual, recepcion_id: disc.recepcion_id },
    resultado: { precio_anterior_snapshot, wac_nuevo, catalogo_actualizado: !esPuntual, claim_monto: claimMonto, claim_estado: claimEstado },
  });

  // Trigger
  import("./agents-triggers").then(m => m.dispararTrigger("costo_aprobado", {
    sku: skuUp, costo_anterior: precio_anterior_snapshot, costo_nuevo: nuevoCosto, es_puntual: esPuntual,
  })).catch(() => {});

  // Update Google Sheet (all rows for this SKU origen)
  const ventasDelSku = _cache.composicion.filter(c => c.skuOrigen === skuUp);
  const filas = ventasDelSku.map(v => ({ skuVenta: v.skuVenta, unidades: v.unidades }));
  try {
    const res = await fetch("/api/sheet/update-cost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: skuUp, nuevoCosto, filas }),
    });
    const data = await res.json();
    return { dbOk: true, sheetResult: data, wac_nuevo: wac_nuevo ?? undefined, precio_anterior_snapshot };
  } catch (e: unknown) {
    return {
      dbOk: true,
      sheetResult: { error: e instanceof Error ? e.message : "fetch failed" },
      wac_nuevo: wac_nuevo ?? undefined, precio_anterior_snapshot,
    };
  }
}

/**
 * @deprecated Eliminado en Chunk 3 (2026-05-05). Estado PENDIENTE_NC ya no existe.
 * Migración:
 *   - Si proveedor confirmó NC pero no llegó: usar aprobarNuevoCosto con
 *     esPuntual=true y `costoEsperado`. La NC posterior se reconcilia desde
 *     /api/sii (no requiere flujo aparte).
 *   - Si querés revertir después: revertirAprobacion(discId, motivo).
 */
export async function marcarPendienteNC(
  _discId: string,
  _sku: string,
  _costoEsperado: number,
  _notas: string,
): Promise<{ ok: boolean; wac_anterior: number; wac_nuevo: number }> {
  throw new Error(
    "marcarPendienteNC fue eliminado en Chunk 3. Usar aprobarNuevoCosto(..., { esPuntual: true, notas }).",
  );
}

/** Sub-acción de RECHAZAR (plan §6.2.1). */
export type RechazarSubAccion = "corregir_factura" | "anular_linea" | "cerrar_dejando_basura";

/**
 * Rechazar discrepancia (Chunk 3, plan §6.2.1).
 *
 * Tres sub-acciones (todas marcan disc=RECHAZADO + auditan):
 *  - corregir_factura: el operador edita la línea con el costo correcto;
 *    después se relanza detectarDiscrepancias y la línea queda sin disc.
 *    NO toca movimientos (eso lo hace la edición de línea).
 *  - anular_linea: marca la línea como anulada (qty_factura = 0); el WAC se
 *    recalcula sin esa entrada. Caller debe haber actualizado la línea.
 *  - cerrar_dejando_basura: registra que el WAC quedará contaminado a propósito
 *    (caso degenerado, dejamos auditoría).
 */
export async function rechazarNuevoCosto(
  discId: string,
  notas?: string,
  subAccion?: RechazarSubAccion,
  operario: string = "admin",
) {
  const sb = getSupabase();
  if (!sb) throw new Error("Sin conexión a Supabase");
  await db.updateDiscrepancia(discId, {
    estado: "RECHAZADO", resuelto_por: operario, resuelto_at: new Date().toISOString(),
    notas: notas || "Rechazado - error de proveedor",
  });
  await sb.from("audit_log").insert({
    accion: "costo_rechazado_v2",
    entidad: "discrepancias_costo",
    entidad_id: discId,
    operario,
    params: { sub_accion: subAccion || "sin_subaccion", notas },
    resultado: { estado: "RECHAZADO" },
  });
}

/**
 * Revertir aprobación de discrepancia (Chunk 3, plan §6.2.2).
 *
 * Restaura el precio_neto del catálogo al snapshot tomado al aprobar,
 * recalcula WAC y deja la discrepancia en estado PENDIENTE para nueva resolución.
 * Solo aplica si la disc está en APROBADO y tiene snapshot.
 */
export async function revertirAprobacion(
  discId: string,
  motivo: string,
  operario: string = "admin",
): Promise<{ ok: boolean; precio_restaurado: number; wac_post: number | null }> {
  if (!motivo || motivo.trim().length === 0) {
    throw new Error("El motivo de revertir es obligatorio");
  }
  const sb = getSupabase();
  if (!sb) throw new Error("Sin conexión a Supabase");

  const { data: discRow } = await sb.from("discrepancias_costo")
    .select("estado, sku, recepcion_id, linea_id, es_puntual, precio_anterior_snapshot, costo_factura")
    .eq("id", discId).single();
  const disc = discRow as {
    estado: string; sku: string; recepcion_id: string; linea_id: string;
    es_puntual: boolean | null; precio_anterior_snapshot: number | null;
    costo_factura: number;
  } | null;
  if (!disc) throw new Error(`Discrepancia ${discId} no encontrada`);
  if (disc.estado !== "APROBADO") throw new Error(`Solo se puede revertir disc APROBADO, estado actual: ${disc.estado}`);

  const skuUp = (disc.sku || "").toUpperCase();

  // 1. Restaurar catálogo solo si NO fue puntual y hay snapshot
  if (!disc.es_puntual && (disc.precio_anterior_snapshot ?? 0) > 0) {
    const precio = disc.precio_anterior_snapshot as number;
    const { error } = await sb.from("proveedor_catalogo")
      .update({
        precio_neto: precio,
        updated_at: new Date().toISOString(),
        updated_by: operario,
        motivo_ultimo_cambio: `revertir_disc_${discId.slice(0, 8)}: ${motivo}`,
      })
      .eq("sku_origen", skuUp).eq("es_principal", true);
    if (error) console.error(`[revertirAprobacion] update catalogo: ${error.message}`);
  }

  // 2. Restaurar costo_unitario en movimientos al precio del catálogo (si existe)
  const precioObjetivo = disc.precio_anterior_snapshot ?? 0;
  if (precioObjetivo > 0) {
    await sb.from("movimientos")
      .update({ costo_unitario: precioObjetivo })
      .eq("recepcion_id", disc.recepcion_id).eq("sku", skuUp).eq("tipo", "entrada");
  }

  // 2b. Restaurar recepcion_lineas.costo_unitario al costo factura original
  // (lo que estaba antes de la aprobación). El snapshot factura_original
  // de recepciones se mantiene independiente.
  await sb.from("recepcion_lineas")
    .update({ costo_unitario: disc.costo_factura })
    .eq("id", disc.linea_id);

  // 3. Recalcular WAC + ventas posteriores
  const { data: wacData } = await sb.rpc("recalcular_wac_running", { p_sku: skuUp });
  const wac_post = (wacData as number | null) ?? null;
  if (_cache.products[skuUp] && wac_post != null) _cache.products[skuUp].costAvg = wac_post;
  await recomputarVentasPosterioresRecepcion(disc.recepcion_id, skuUp, "revertir_disc");

  // 4. Volver disc a PENDIENTE limpiando snapshot, resolución y claim (v103)
  await db.updateDiscrepancia(discId, {
    estado: "PENDIENTE",
    revertido_at: new Date().toISOString(),
    revertido_por: operario,
    notas: `Revertido: ${motivo}`,
    claim_monto_pendiente: null,
    claim_estado: null,
    claim_resuelto_por_nc_id: null,
  });

  // 5. Audit
  await sb.from("audit_log").insert({
    accion: "costo_revertido_v2",
    entidad: "discrepancias_costo",
    entidad_id: discId,
    operario,
    params: { sku: skuUp, motivo, precio_restaurado: precioObjetivo },
    resultado: { wac_post, ok: true },
  });

  return { ok: true, precio_restaurado: precioObjetivo, wac_post };
}

/**
 * Recompute ventas_ml_cache para órdenes posteriores a una recepción
 * después de un cambio de costo (aprobación, reverso, sincronización).
 * Compartido entre aprobarNuevoCosto, revertirAprobacion y sincronización.
 */
async function recomputarVentasPosterioresRecepcion(
  recepcionId: string, skuOrigen: string, motivoFuente: string,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { data: recRow } = await sb.from("recepciones")
    .select("created_at").eq("id", recepcionId).single();
  const cutoff = (recRow as { created_at: string } | null)?.created_at;
  if (!cutoff) return;

  const skuUp = (skuOrigen || "").toUpperCase();
  const { data: compRows } = await sb.from("composicion_venta")
    .select("sku_venta").eq("sku_origen", skuUp);
  const skuVentas = new Set<string>([
    skuUp,
    ...((compRows || []) as Array<{ sku_venta: string }>).map(c => (c.sku_venta || "").toUpperCase()),
  ]);
  if (skuVentas.size === 0) return;

  const preload = await preloadCostos(sb);

  const { data: ventasRaw } = await sb.from("ventas_ml_cache")
    .select("order_id, sku_venta, cantidad, fecha, subtotal, total_neto, ads_cost_asignado")
    .in("sku_venta", Array.from(skuVentas))
    .gte("fecha", cutoff)
    .eq("anulada", false);
  const ventas = (ventasRaw || []) as Array<{
    order_id: string; sku_venta: string; cantidad: number; fecha: string;
    subtotal: number; total_neto: number; ads_cost_asignado: number;
  }>;

  const snapshotAt = new Date().toISOString();
  for (const v of ventas) {
    const resolved = resolverCostoVenta(v.sku_venta, v.cantidad, preload);
    const mBruto = calcularMargenVenta(v.total_neto, resolved.costo_producto, v.subtotal);
    const mn = calcularMargenNeto(mBruto.margen, v.ads_cost_asignado || 0, v.subtotal);
    const { error } = await sb.from("ventas_ml_cache").update({
      costo_producto: resolved.costo_producto,
      costo_fuente: motivoFuente,
      costo_snapshot_at: snapshotAt,
      costo_detalle: resolved.detalle,
      margen: mBruto.margen, margen_pct: mBruto.margen_pct,
      margen_neto: mn.margen_neto, margen_neto_pct: mn.margen_neto_pct,
      updated_at: snapshotAt,
    }).eq("order_id", v.order_id).eq("sku_venta", v.sku_venta);
    if (error) console.error(`[recomputarVentas] ${v.order_id}/${v.sku_venta}: ${error.message}`);
  }
}

export function tieneDiscrepanciasPendientes(discs: db.DBDiscrepanciaCosto[]): boolean {
  return discs.some(d => d.estado === "PENDIENTE");
}

// ==================== DISCREPANCIAS DE CANTIDAD ====================

export type { DBDiscrepanciaQty, DiscrepanciaQtyTipo, DiscrepanciaQtyEstado } from "./db";

const DISC_QTY_RESOLUCIONES: Record<db.DiscrepanciaQtyTipo, { valor: db.DiscrepanciaQtyEstado; label: string }[]> = {
  FALTANTE: [
    { valor: "ACEPTADO", label: "Aceptar faltante" },
    { valor: "RECLAMADO", label: "Reclamar al proveedor" },
    { valor: "NOTA_CREDITO", label: "Solicitar nota de crédito" },
  ],
  SOBRANTE: [
    { valor: "ACEPTADO", label: "Aceptar sobrante" },
    { valor: "DEVOLUCION", label: "Devolver al proveedor" },
  ],
  SKU_ERRONEO: [
    { valor: "ACEPTADO", label: "Aceptar como sustituto" },
    { valor: "DEVOLUCION", label: "Devolver al proveedor" },
  ],
  NO_EN_FACTURA: [
    { valor: "ACEPTADO", label: "Aceptar producto extra" },
    { valor: "DEVOLUCION", label: "Devolver al proveedor" },
    { valor: "SUSTITUCION", label: "Producto sustituido" },
  ],
};

export function getResolucionesQty(tipo: db.DiscrepanciaQtyTipo) {
  return DISC_QTY_RESOLUCIONES[tipo] || [];
}

export async function detectarDiscrepanciasQty(recepcionId: string, lineas?: db.DBRecepcionLinea[]): Promise<db.DBDiscrepanciaQty[]> {
  // Always read fresh lines from DB — never rely on potentially stale passed data
  const freshLineas = lineas && lineas.length > 0 ? lineas : await db.fetchRecepcionLineas(recepcionId);

  // Return resolved discrepancies as-is, only re-evaluate pending ones
  const existentes = await db.fetchDiscrepanciasQty(recepcionId);
  const resueltas = existentes.filter(d => d.estado !== "PENDIENTE");

  // Delete stale pending discrepancies — we'll re-detect from current state
  if (existentes.some(d => d.estado === "PENDIENTE")) {
    await db.deleteDiscrepanciasQtyPendientes(recepcionId);
  }

  const nuevas: Omit<db.DBDiscrepanciaQty, "id" | "created_at">[] = [];
  for (const l of freshLineas) {
    const qf = l.qty_factura || 0;
    const qr = l.qty_recibida || 0;

    // Skip lines that haven't been fully counted yet
    const ESTADOS_CONTADOS = ["CONTADA", "EN_ETIQUETADO", "ETIQUETADA", "UBICADA"];
    if (!ESTADOS_CONTADOS.includes(l.estado)) continue;

    // Skip if there's already a resolved discrepancy for this line
    if (resueltas.some(d => d.linea_id === l.id)) continue;

    if (qf === 0 && qr > 0) {
      nuevas.push({
        recepcion_id: recepcionId, linea_id: l.id, sku: l.sku,
        tipo: "NO_EN_FACTURA", qty_factura: qf, qty_recibida: qr,
        diferencia: qr, estado: "PENDIENTE",
      });
    } else if (qr < qf) {
      nuevas.push({
        recepcion_id: recepcionId, linea_id: l.id, sku: l.sku,
        tipo: "FALTANTE", qty_factura: qf, qty_recibida: qr,
        diferencia: qr - qf, estado: "PENDIENTE",
      });
    } else if (qr > qf) {
      nuevas.push({
        recepcion_id: recepcionId, linea_id: l.id, sku: l.sku,
        tipo: "SOBRANTE", qty_factura: qf, qty_recibida: qr,
        diferencia: qr - qf, estado: "PENDIENTE",
      });
    }
  }

  if (nuevas.length > 0) await db.insertDiscrepanciasQty(nuevas);
  return db.fetchDiscrepanciasQty(recepcionId);
}

export async function getDiscrepanciasQty(recepcionId: string): Promise<db.DBDiscrepanciaQty[]> {
  // Always re-detect to get fresh values
  return detectarDiscrepanciasQty(recepcionId);
}

export async function recalcularDiscrepanciasQty(recepcionId: string, lineas?: db.DBRecepcionLinea[]): Promise<db.DBDiscrepanciaQty[]> {
  await db.deleteDiscrepanciasQtyPendientes(recepcionId);
  return detectarDiscrepanciasQty(recepcionId, lineas);
}

export async function resolverDiscrepanciaQty(
  discId: string, estado: db.DiscrepanciaQtyEstado, notas?: string,
  discInfo?: { linea_id: string; recepcion_id: string; qty_recibida: number; tipo: string }
) {
  await db.updateDiscrepanciaQty(discId, {
    estado,
    resuelto_por: "admin",
    resuelto_at: new Date().toISOString(),
    notas: notas || "",
  });

  // For FALTANTE resolved as NOTA_CREDITO or ACEPTADO: adjust qty_factura to qty_recibida
  if ((estado === "NOTA_CREDITO" || estado === "ACEPTADO") && discInfo && discInfo.tipo === "FALTANTE" && discInfo.linea_id) {
    await db.updateRecepcionLinea(discInfo.linea_id, { qty_factura: discInfo.qty_recibida });
  }

  // For RECLAMADO on FALTANTE: reopen the line so operador can receive the missing units later
  if (estado === "RECLAMADO" && discInfo && discInfo.tipo === "FALTANTE" && discInfo.linea_id) {
    await db.updateRecepcionLinea(discInfo.linea_id, { estado: "PENDIENTE" as db.DBRecepcionLinea["estado"] });
  }

  // After any resolution, check if all discrepancies are fully resolved → auto-close recepcion
  // RECLAMADO = waiting for supplier, does NOT count as fully resolved
  const ESTADOS_DEFINITIVOS: db.DiscrepanciaQtyEstado[] = ["ACEPTADO", "NOTA_CREDITO", "DEVOLUCION", "SUSTITUCION"];
  if (discInfo?.recepcion_id) {
    const [lineas, discsQty, discsCosto] = await Promise.all([
      db.fetchRecepcionLineas(discInfo.recepcion_id),
      db.fetchDiscrepanciasQty(discInfo.recepcion_id),
      db.fetchDiscrepancias(discInfo.recepcion_id),
    ]);
    const allUbicadas = lineas.every(l => l.estado === "UBICADA" || (l.qty_ubicada || 0) >= l.qty_factura);
    const sinPendientesQty = discsQty.every(d => ESTADOS_DEFINITIVOS.includes(d.estado as db.DiscrepanciaQtyEstado));
    const sinPendientesCosto = discsCosto.every(d => d.estado !== "PENDIENTE");
    if (allUbicadas && sinPendientesQty && sinPendientesCosto) {
      await db.updateRecepcion(discInfo.recepcion_id, { estado: "COMPLETADA", completed_at: new Date().toISOString() });
    }
  }
}

export async function crearDiscrepanciaQtyManual(
  recepcionId: string,
  sku: string,
  tipo: db.DiscrepanciaQtyTipo,
  qtyFactura: number,
  qtyRecibida: number,
  notas: string,
): Promise<void> {
  await db.insertDiscrepanciasQty([{
    recepcion_id: recepcionId, sku,
    tipo, qty_factura: qtyFactura, qty_recibida: qtyRecibida,
    diferencia: qtyRecibida - qtyFactura, estado: "PENDIENTE",
    notas,
  }]);
}

export function tieneDiscrepanciasQtyPendientes(discs: db.DBDiscrepanciaQty[]): boolean {
  return discs.some(d => d.estado === "PENDIENTE");
}

// ==================== SUSTITUCIÓN DE PRODUCTO ====================

export interface SustitucionResult {
  lineaOriginal: db.DBRecepcionLinea;
  lineaSustituta: db.DBRecepcionLinea;
  discrepancias: db.DBDiscrepanciaQty[];
  discrepanciasCosto: db.DBDiscrepanciaCosto[];
}

/**
 * Maneja sustitución de producto en recepción:
 * - Proveedor envió producto diferente al facturado
 * - Actualiza línea original (qty_recibida=0)
 * - Crea nueva línea para el producto que realmente llegó
 * - Genera discrepancias vinculadas (FALTANTE + NO_EN_FACTURA) y las resuelve como SUSTITUCION
 * - Maneja costos: la línea sustituta usa el costo de factura (lo que se pagó)
 */
export async function sustituirProducto(
  recepcionId: string,
  lineaOriginalId: string,
  productoSustituto: { sku: string; nombre: string; codigoML: string; requiereEtiqueta: boolean; costoDiccionario: number },
  cantidadRecibida: number,
  usarCostoFactura: boolean,
): Promise<SustitucionResult> {
  // 1. Obtener línea original
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const original = lineas.find(l => l.id === lineaOriginalId);
  if (!original) throw new Error("Línea original no encontrada");

  const costoOriginal = original.costo_unitario || 0;
  const costoSustituto = usarCostoFactura ? costoOriginal : productoSustituto.costoDiccionario;
  const ts = new Date().toISOString();
  const notaBase = `Sustitución: ${original.sku} → ${productoSustituto.sku} (${cantidadRecibida} uds)`;

  // 2. Actualizar línea original: qty_recibida = 0
  await db.updateRecepcionLinea(lineaOriginalId, {
    qty_recibida: 0,
    qty_etiquetada: 0,
    qty_ubicada: 0,
    notas: `${original.notas ? original.notas + " | " : ""}${notaBase} — No llegó este producto`,
  });

  // 3. Si la línea original ya tenía stock ubicado, revertirlo
  if ((original.qty_ubicada || 0) > 0) {
    // Esto es por si ya se había ubicado antes de detectar la sustitución
    // (como el caso descrito: qty_ubicada=40 pero era otro producto)
    await ajustarLineaAdmin(lineaOriginalId, recepcionId, original.sku, original.qty_ubicada || 0, 0);
  }

  // 4. Crear nueva línea para producto sustituto
  const autoFormato = _resolverFormatoVenta(productoSustituto.sku);
  await db.insertRecepcionLineas([{
    recepcion_id: recepcionId,
    sku: productoSustituto.sku,
    codigo_ml: productoSustituto.codigoML,
    nombre: productoSustituto.nombre,
    qty_factura: 0,
    qty_recibida: cantidadRecibida,
    qty_etiquetada: 0,
    qty_ubicada: 0,
    estado: "CONTADA" as const,
    requiere_etiqueta: autoFormato ? true : productoSustituto.requiereEtiqueta,
    costo_unitario: costoSustituto,
    sku_venta: autoFormato || undefined,
    notas: `${notaBase} — Costo ${usarCostoFactura ? "de factura" : "de diccionario"}: ${costoSustituto}`,
    operario_conteo: "admin",
    operario_etiquetado: "",
    operario_ubicacion: "",
  }]);

  // 5. Borrar discrepancias pendientes y regenerar
  await db.deleteDiscrepanciasQtyPendientes(recepcionId);
  await db.deleteDiscrepanciasPendientes(recepcionId);

  const updatedLineas = await db.fetchRecepcionLineas(recepcionId);

  // 6. Detectar discrepancias de cantidad (generará FALTANTE para original, NO_EN_FACTURA para sustituto)
  const dq = await detectarDiscrepanciasQty(recepcionId, updatedLineas);

  // 7. Auto-resolver las discrepancias de la sustitución como SUSTITUCION
  const discOriginal = dq.find(d => d.sku === original.sku && d.tipo === "FALTANTE" && d.estado === "PENDIENTE");
  const discSustituto = dq.find(d => d.sku === productoSustituto.sku && d.tipo === "NO_EN_FACTURA" && d.estado === "PENDIENTE");

  if (discOriginal) {
    await db.updateDiscrepanciaQty(discOriginal.id!, {
      estado: "SUSTITUCION",
      resuelto_por: "admin",
      resuelto_at: ts,
      notas: `Sustituido por ${productoSustituto.sku} (${cantidadRecibida} uds)`,
    });
  }
  if (discSustituto) {
    await db.updateDiscrepanciaQty(discSustituto.id!, {
      estado: "SUSTITUCION",
      resuelto_por: "admin",
      resuelto_at: ts,
      notas: `Sustituyó a ${original.sku} — Costo unitario: ${costoSustituto}`,
    });
  }

  // 8. Detectar discrepancias de costo
  const dc = await detectarDiscrepancias(recepcionId, updatedLineas);

  // 9. Re-fetch todo actualizado
  const finalLineas = await db.fetchRecepcionLineas(recepcionId);
  const lineaOrig = finalLineas.find(l => l.id === lineaOriginalId)!;
  const lineaSust = finalLineas.find(l => l.sku === productoSustituto.sku && l.recepcion_id === recepcionId && l.qty_factura === 0)!;
  const finalDq = await db.fetchDiscrepanciasQty(recepcionId);
  const finalDc = await db.fetchDiscrepancias(recepcionId);

  return {
    lineaOriginal: lineaOrig,
    lineaSustituta: lineaSust,
    discrepancias: finalDq,
    discrepanciasCosto: finalDc,
  };
}

// ==================== FORMAT HELPERS ====================
export function fmtDate(iso: string) { try { return new Date(iso).toLocaleDateString("es-CL"); } catch { return iso; } }
export function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
export function fmtMoney(n: number) { return "$" + n.toLocaleString("es-CL"); }

// ==================== LEGACY COMPAT ====================
export function nextMovId(): string { return uniqueMovId(); }
export async function pullCloudState(): Promise<boolean> { return refreshStore(); }
export async function getCloudStatus(): Promise<string> { return isConfigured() ? "connected" : "not_configured"; }
