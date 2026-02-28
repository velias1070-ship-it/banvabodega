"use client";
import * as db from "./db";
import { isConfigured } from "./supabase";
export { isConfigured as isSupabaseConfigured } from "./supabase";

// ==================== TYPES (backward compatible) ====================
export interface Product {
  sku: string;
  name: string;
  mlCode: string;
  cat: string;
  prov: string;
  cost: number;
  price: number;
  reorder: number;
  requiresLabel?: boolean;
  tamano?: string;
  color?: string;
}

export interface ComposicionVenta {
  skuVenta: string;
  codigoMl: string;
  skuOrigen: string;
  unidades: number;
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

export type InReason = "compra" | "devolucion" | "ajuste_entrada" | "transferencia_in";
export type OutReason = "venta_flex" | "envio_full" | "ajuste_salida" | "merma";
export type MovType = "in" | "out";

export interface Movement {
  id: string; ts: string; type: MovType;
  reason: InReason | OutReason;
  sku: string; pos: string; qty: number;
  who: string; note: string;
}

export type StockMap = Record<string, Record<string, number>>;

export interface StoreData {
  products: Record<string, Product>;
  positions: Position[];
  stock: StockMap;
  movements: Movement[];
  movCounter: number;
  mapConfig?: MapConfig;
  composicion: ComposicionVenta[];
}

// ==================== CONSTANTS ====================
export const IN_REASONS: Record<InReason, string> = {
  compra: "Compra de inventario", devolucion: "Devolución",
  ajuste_entrada: "Ajuste (+)", transferencia_in: "Transferencia entrada",
};
export const OUT_REASONS: Record<OutReason, string> = {
  venta_flex: "Venta Flex", envio_full: "Envío a ML Full",
  ajuste_salida: "Ajuste (-)", merma: "Merma / Pérdida",
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
  products: {}, positions: [], stock: {}, movements: [], movCounter: 0, composicion: [],
};
let _initialized = false;
let _loading = false;

// ==================== INIT (call on mount) ====================
export async function initStore(): Promise<void> {
  if (_initialized || _loading) return;
  if (!isConfigured()) { _initialized = true; return; }
  _loading = true;
  try {
    const [prods, poss, stocks, movs, mapCfg, compVenta] = await Promise.all([
      db.fetchProductos(),
      db.fetchPosiciones(),
      db.fetchStock(),
      db.fetchMovimientos(500),
      db.fetchMapConfig(),
      db.fetchComposicionVenta(),
    ]);

    // Products → Record<sku, Product>
    const products: Record<string, Product> = {};
    for (const p of prods) {
      products[p.sku] = {
        sku: p.sku, name: p.nombre, mlCode: p.codigo_ml,
        cat: p.categoria, prov: p.proveedor, cost: p.costo,
        price: p.precio, reorder: p.reorder,
        requiresLabel: p.requiere_etiqueta,
        tamano: p.tamano || "", color: p.color || "",
      };
    }

    // Positions
    const positions: Position[] = poss.map(p => ({
      id: p.id, label: p.label, type: p.tipo as "pallet" | "shelf",
      active: p.activa, mx: p.mx, my: p.my, mw: p.mw, mh: p.mh, color: p.color,
    }));

    // Stock → StockMap
    const stock: StockMap = {};
    for (const s of stocks) {
      if (!stock[s.sku]) stock[s.sku] = {};
      stock[s.sku][s.posicion_id] = s.cantidad;
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
    }));

    _cache = { products, positions, stock, movements, movCounter: movements.length, mapConfig, composicion };
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
      sku: p.sku, sku_venta: "", codigo_ml: p.mlCode, nombre: p.name,
      categoria: p.cat, proveedor: p.prov, costo: p.cost, precio: p.price,
      reorder: p.reorder, requiere_etiqueta: p.requiresLabel !== false,
      tamano: p.tamano || "", color: p.color || "",
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
  _cache = { products: {}, positions: [], stock: {}, movements: [], movCounter: 0, composicion: [] };
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
  
  const scored: { p: Product; score: number }[] = [];
  
  for (const p of Object.values(_cache.products)) {
    const skuN = normalize(p.sku);
    const nameN = normalize(p.name);
    const mlN = normalize(p.mlCode || "");
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
  return _cache.composicion.filter(c => c.skuVenta === skuVenta);
}

// Dado un SKU Origen (físico), en qué packs/ventas participa
export function getVentasPorSkuOrigen(skuOrigen: string): ComposicionVenta[] {
  return _cache.composicion.filter(c => c.skuOrigen === skuOrigen);
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
    const mlN = normalize(p.mlCode || "");
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
          codigoMl: p.mlCode || "",
          nombre: p.name,
          componentes: [{ skuVenta: p.sku, codigoMl: p.mlCode || "", skuOrigen: p.sku, unidades: 1 }],
        },
        score,
      });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, 20).map(x => x.item);
}

// ==================== ASYNC MUTATIONS ====================

// Record movement + update stock (writes to Supabase + cache)
export async function recordMovementAsync(m: Omit<Movement, "id">): Promise<Movement> {
  const mov: Movement = { ...m, id: uniqueMovId() };

  // Update cache (clamp "out" to prevent negative stock)
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  let actualQty = m.qty;
  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
  } else {
    const prev = _cache.stock[m.sku][m.pos] || 0;
    actualQty = Math.min(m.qty, prev);
    _cache.stock[m.sku][m.pos] = prev - actualQty;
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
  }
  mov.qty = actualQty;
  _cache.movements.unshift(mov);

  // Write to Supabase
  if (isConfigured()) {
    const delta = m.type === "in" ? actualQty : -actualQty;
    await db.updateStock(m.sku, m.pos, delta);
    await db.insertMovimiento({
      tipo: m.type === "in" ? "entrada" : "salida",
      motivo: motivoToDB(m.reason, m.type),
      sku: m.sku, posicion_id: m.pos, cantidad: actualQty,
      operario: m.who, nota: m.note,
    });
  }
  return mov;
}

// Backward compat sync wrapper (fires async, returns immediately)
export function recordMovement(m: Omit<Movement, "id">): Movement {
  const mov: Movement = { ...m, id: uniqueMovId() };
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  let actualQty = m.qty;
  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
  } else {
    const prev = _cache.stock[m.sku][m.pos] || 0;
    actualQty = Math.min(m.qty, prev);
    _cache.stock[m.sku][m.pos] = prev - actualQty;
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
  }
  mov.qty = actualQty;
  _cache.movements.unshift(mov);

  // Fire to Supabase with cache rollback on failure
  if (isConfigured()) {
    const delta = m.type === "in" ? actualQty : -actualQty;
    db.updateStock(m.sku, m.pos, delta).catch((err) => {
      console.error("Stock update failed, reverting cache:", err);
      if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
      if (m.type === "in") {
        _cache.stock[m.sku][m.pos] = Math.max(0, (_cache.stock[m.sku][m.pos] || 0) - actualQty);
        if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
      } else {
        _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + actualQty;
      }
    });
    db.insertMovimiento({
      tipo: m.type === "in" ? "entrada" : "salida",
      motivo: motivoToDB(m.reason, m.type),
      sku: m.sku, posicion_id: m.pos, cantidad: actualQty,
      operario: m.who, nota: m.note,
    }).catch(console.error);
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
      sku: p.sku, sku_venta: "", codigo_ml: p.mlCode, nombre: p.name,
      categoria: p.cat, proveedor: p.prov, costo: p.cost, precio: p.price,
      reorder: p.reorder, requiere_etiqueta: p.requiresLabel !== false,
      tamano: p.tamano || "", color: p.color || "",
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
export async function syncFromSheet(): Promise<{ added: number; updated: number; total: number }> {
  const result = await db.syncDiccionarioFromSheet();
  
  // Refresh products in cache
  const prods = await db.fetchProductos();
  _cache.products = {};
  for (const p of prods) {
    _cache.products[p.sku] = {
      sku: p.sku, name: p.nombre, mlCode: p.codigo_ml,
      cat: p.categoria, prov: p.proveedor, cost: p.costo,
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
  }));

  if (typeof window !== "undefined") {
    localStorage.setItem("banva_sheet_last_sync", Date.now().toString());
  }
  return result.productos;
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
  for (const s of stocks) {
    if (!_cache.stock[s.sku]) _cache.stock[s.sku] = {};
    _cache.stock[s.sku][s.posicion_id] = s.cantidad;
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

  // Update cache synchronously
  _cache.stock[sku]["SIN_ASIGNAR"] -= qty;
  if (_cache.stock[sku]["SIN_ASIGNAR"] <= 0) delete _cache.stock[sku]["SIN_ASIGNAR"];
  if (!_cache.stock[sku][targetPos]) _cache.stock[sku][targetPos] = 0;
  _cache.stock[sku][targetPos] += qty;

  // Fire & forget to Supabase
  if (isConfigured()) {
    (async () => {
      await db.updateStock(sku, "SIN_ASIGNAR", -qty);
      await db.updateStock(sku, targetPos, qty);
      await db.insertMovimiento({
        tipo: "salida", motivo: "transferencia_out", sku,
        posicion_id: "SIN_ASIGNAR", cantidad: qty,
        operario: "Admin", nota: "Asignación → " + targetPos,
      });
      await db.insertMovimiento({
        tipo: "entrada", motivo: "transferencia_in", sku,
        posicion_id: targetPos, cantidad: qty,
        operario: "Admin", nota: "Asignación ← SIN_ASIGNAR",
      });
    })().catch(console.error);
  }
  return true;
}

// ==================== RECEPCIONES (NEW) ====================
export type { DBRecepcion, DBRecepcionLinea, DBOperario } from "./db";

export async function getRecepciones() { return db.fetchRecepciones(); }
export async function getRecepcionesActivas() { return db.fetchRecepcionesActivas(); }
export async function getRecepcionLineas(recId: string) { return db.fetchRecepcionLineas(recId); }

export async function crearRecepcion(folio: string, proveedor: string, imagenUrl: string, lineas: { sku: string; codigoML: string; nombre: string; cantidad: number; costo: number; requiereEtiqueta: boolean }[]): Promise<string | null> {
  const id = await db.insertRecepcion({
    folio, proveedor, imagen_url: imagenUrl, estado: "CREADA",
    notas: "", created_by: "admin",
  });
  if (!id) return null;

  const dbLineas = lineas.map(l => ({
    recepcion_id: id, sku: l.sku, codigo_ml: l.codigoML,
    nombre: l.nombre, qty_factura: l.cantidad, qty_recibida: 0,
    qty_etiquetada: 0, qty_ubicada: 0, estado: "PENDIENTE" as const,
    requiere_etiqueta: l.requiereEtiqueta, costo_unitario: l.costo,
    notas: "", operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "",
  }));
  await db.insertRecepcionLineas(dbLineas);
  return id;
}

export async function actualizarRecepcion(id: string, fields: Partial<db.DBRecepcion>) {
  await db.updateRecepcion(id, fields);
}

export async function actualizarLineaRecepcion(id: string, fields: Partial<db.DBRecepcionLinea>) {
  await db.updateRecepcionLinea(id, fields);
}

// Contar línea: operario confirma cantidad real
export async function contarLinea(lineaId: string, qtyReal: number, operario: string) {
  await db.updateRecepcionLinea(lineaId, {
    qty_recibida: qtyReal, estado: "CONTADA",
    operario_conteo: operario, ts_conteo: new Date().toISOString(),
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
}

// Ubicar línea: operario pone en posición → stock entra al WMS
export async function ubicarLinea(lineaId: string, sku: string, posicionId: string, qty: number, operario: string, recepcionId: string) {
  // Update stock
  if (isConfigured()) {
    await db.updateStock(sku, posicionId, qty);
    await db.insertMovimiento({
      tipo: "entrada", motivo: "recepcion", sku, posicion_id: posicionId,
      cantidad: qty, recepcion_id: recepcionId, operario, nota: "Recepción - ubicación en bodega",
    });
  }

  // Update cache
  if (!_cache.stock[sku]) _cache.stock[sku] = {};
  _cache.stock[sku][posicionId] = (_cache.stock[sku][posicionId] || 0) + qty;

  // Fetch current line to calculate new qty_ubicada (read closest to write to minimize race window)
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const linea = lineas.find(l => l.id === lineaId);
  if (!linea) return;
  const newQtyUbicada = (linea.qty_ubicada || 0) + qty;
  const qtyTotal = (linea.qty_recibida ?? linea.qty_factura) ?? 0;

  await db.updateRecepcionLinea(lineaId, {
    qty_ubicada: newQtyUbicada,
    estado: newQtyUbicada >= qtyTotal && qtyTotal > 0 ? "UBICADA" : linea.estado,
    operario_ubicacion: operario,
    ...(newQtyUbicada >= qtyTotal && qtyTotal > 0 ? { ts_ubicacion: new Date().toISOString() } : {}),
  });
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
export type { PickingLinea, PickingComponente, DBPickingSession } from "./db";

// Build picking session from pasted orders
export function buildPickingLineas(orders: { skuVenta: string; qty: number }[]): { lineas: db.PickingLinea[]; errors: string[] } {
  const lineas: db.PickingLinea[] = [];
  const errors: string[] = [];

  for (let i = 0; i < orders.length; i++) {
    const { skuVenta, qty } = orders[i];
    const comps = getComponentesPorSkuVenta(skuVenta);
    
    if (comps.length === 0) {
      // Try finding by SKU directly (maybe it's a simple product, not a pack)
      const prod = _cache.products[skuVenta];
      if (prod) {
        // It's a product used directly as SKU Venta
        const positions = skuPositions(skuVenta);
        const bestPos = positions.length > 0 ? positions[0] : null;
        lineas.push({
          id: `P${String(i + 1).padStart(3, "0")}`,
          skuVenta,
          qtyPedida: qty,
          estado: "PENDIENTE",
          componentes: [{
            skuOrigen: skuVenta,
            codigoMl: prod.mlCode || "",
            nombre: prod.name,
            unidades: qty,
            posicion: bestPos?.pos || "?",
            posLabel: bestPos?.label || "Sin posición",
            stockDisponible: bestPos?.qty || 0,
            estado: "PENDIENTE",
            pickedAt: null,
            operario: null,
          }],
        });
      } else {
        errors.push(`Línea ${i + 1}: SKU Venta "${skuVenta}" no encontrado en diccionario`);
      }
      continue;
    }

    // Decompose into physical components
    const componentes: db.PickingComponente[] = [];
    for (const comp of comps) {
      const prod = _cache.products[comp.skuOrigen];
      const totalNeeded = comp.unidades * qty;
      const positions = skuPositions(comp.skuOrigen);
      const bestPos = positions.length > 0 ? positions[0] : null;

      componentes.push({
        skuOrigen: comp.skuOrigen,
        codigoMl: comp.codigoMl || prod?.mlCode || "",
        nombre: prod?.name || comp.skuOrigen,
        unidades: totalNeeded,
        posicion: bestPos?.pos || "?",
        posLabel: bestPos?.label || "Sin posición",
        stockDisponible: bestPos?.qty || 0,
        estado: "PENDIENTE",
        pickedAt: null,
        operario: null,
      });

      if (!bestPos || bestPos.qty < totalNeeded) {
        errors.push(`⚠️ ${comp.skuOrigen}: necesitas ${totalNeeded}, disponible ${bestPos?.qty || 0} en ${bestPos?.pos || "ninguna posición"}`);
      }
    }

    lineas.push({
      id: `P${String(i + 1).padStart(3, "0")}`,
      skuVenta,
      qtyPedida: qty,
      estado: "PENDIENTE",
      componentes,
    });
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

  // 3. Product's ML codes (may be comma-separated: "ML1,ML2")
  const prod = _cache.products[componente.skuOrigen];
  if (prod?.mlCode && matchesAnyCode(prod.mlCode, code)) return true;

  // 4. SKU Venta match (the "Cod. Universal" on the label)
  if (skuVenta && skuVenta.toUpperCase() === code) return true;

  // 5. Check ALL composicion entries for this skuOrigen — any codigoMl match
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

// Create picking session
export async function crearPickingSession(fecha: string, lineas: db.PickingLinea[]): Promise<string | null> {
  return db.createPickingSession({ fecha, estado: "ABIERTA", lineas });
}

// Update picking session
export async function actualizarPicking(id: string, updates: Partial<db.DBPickingSession>): Promise<boolean> {
  return db.updatePickingSession(id, updates);
}

// Delete picking session  
export async function eliminarPicking(id: string): Promise<boolean> {
  return db.deletePickingSession(id);
}

// Mark component as picked + decrement stock
export async function pickearComponente(
  sessionId: string, lineaId: string, compIdx: number, operario: string,
  session: db.DBPickingSession
): Promise<boolean> {
  const linea = session.lineas.find(l => l.id === lineaId);
  if (!linea) return false;
  const comp = linea.componentes[compIdx];
  if (!comp || comp.estado === "PICKEADO") return false;

  // Decrement stock from the suggested position
  const pos = comp.posicion;
  if (pos && pos !== "?") {
    recordMovement({
      ts: new Date().toISOString(), type: "out", reason: "venta_flex" as OutReason,
      sku: comp.skuOrigen, pos, qty: comp.unidades,
      who: operario, note: `Picking Flex: ${linea.skuVenta} ×${linea.qtyPedida}`,
    });
  }

  // Update session data
  comp.estado = "PICKEADO";
  comp.pickedAt = new Date().toISOString();
  comp.operario = operario;

  // Check if all components of this line are picked
  if (linea.componentes.every(c => c.estado === "PICKEADO")) {
    linea.estado = "PICKEADO";
  }

  // Check if all lines are picked
  const allDone = session.lineas.every(l => l.estado === "PICKEADO");

  await db.updatePickingSession(sessionId, {
    lineas: session.lineas,
    estado: allDone ? "COMPLETADA" : "EN_PROCESO",
    ...(allDone ? { completed_at: new Date().toISOString() } : {}),
  });

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
}

export async function pausarRecepcion(id: string) {
  await db.updateRecepcion(id, { estado: "PAUSADA" as db.DBRecepcion["estado"] });
}

export async function reactivarRecepcion(id: string) {
  await db.updateRecepcion(id, { estado: "CREADA" });
}

export async function cerrarRecepcion(id: string) {
  await db.updateRecepcion(id, { estado: "CERRADA" });
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

export async function agregarLineaRecepcion(recepcionId: string, linea: { sku: string; codigoML: string; nombre: string; cantidad: number; costo: number; requiereEtiqueta: boolean }) {
  await db.insertRecepcionLineas([{
    recepcion_id: recepcionId, sku: linea.sku, codigo_ml: linea.codigoML,
    nombre: linea.nombre, qty_factura: linea.cantidad, qty_recibida: 0,
    qty_etiquetada: 0, qty_ubicada: 0, estado: "PENDIENTE" as const,
    requiere_etiqueta: linea.requiereEtiqueta, costo_unitario: linea.costo,
    notas: "", operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "",
  }]);
}

// ==================== FORMAT HELPERS ====================
export function fmtDate(iso: string) { try { return new Date(iso).toLocaleDateString("es-CL"); } catch { return iso; } }
export function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
export function fmtMoney(n: number) { return "$" + n.toLocaleString("es-CL"); }

// ==================== LEGACY COMPAT ====================
export function nextMovId(): string { return uniqueMovId(); }
export async function pullCloudState(): Promise<boolean> { return refreshStore(); }
export async function getCloudStatus(): Promise<string> { return isConfigured() ? "connected" : "not_configured"; }
