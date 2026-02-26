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

    // Flush stock (reconcile: set each sku+pos to exact value)
    const currentDBStock = await db.fetchStock();
    const dbStockMap = new Map(currentDBStock.map(s => [`${s.sku}|${s.posicion_id}`, s.cantidad]));
    
    // Set values from cache
    for (const [sku, posMap] of Object.entries(_cache.stock)) {
      for (const [posId, qty] of Object.entries(posMap)) {
        if (qty > 0) {
          const key = `${sku}|${posId}`;
          if (dbStockMap.get(key) !== qty) {
            await db.setStock(sku, posId, qty);
          }
          dbStockMap.delete(key);
        }
      }
    }
    // Delete stock that's in DB but not in cache
    Array.from(dbStockMap.entries()).forEach(([key]) => {
      const [sku, posId] = key.split("|");
      db.setStock(sku, posId, 0).catch(console.error);
    });
  } catch (err) {
    console.error("Flush to Supabase error:", err);
  }
}

export function resetStore() {
  _cache = { products: {}, positions: [], stock: {}, movements: [], movCounter: 0, composicion: [] };
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
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return Object.values(_cache.products).filter(p =>
    p.sku.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.mlCode.toLowerCase().includes(q)
  );
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

// ==================== ASYNC MUTATIONS ====================

// Record movement + update stock (writes to Supabase + cache)
export async function recordMovementAsync(m: Omit<Movement, "id">): Promise<Movement> {
  const mov: Movement = { ...m, id: "M" + Date.now() };

  // Update cache
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
  } else {
    _cache.stock[m.sku][m.pos] = Math.max(0, (_cache.stock[m.sku][m.pos] || 0) - m.qty);
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
  }
  _cache.movements.unshift(mov);

  // Write to Supabase
  if (isConfigured()) {
    const delta = m.type === "in" ? m.qty : -m.qty;
    await db.updateStock(m.sku, m.pos, delta);
    await db.insertMovimiento({
      tipo: m.type === "in" ? "entrada" : "salida",
      motivo: motivoToDB(m.reason, m.type),
      sku: m.sku, posicion_id: m.pos, cantidad: m.qty,
      operario: m.who, nota: m.note,
    });
  }
  return mov;
}

// Backward compat sync wrapper (fires async, returns immediately)
export function recordMovement(m: Omit<Movement, "id">): Movement {
  const mov: Movement = { ...m, id: "M" + Date.now() };
  if (!_cache.stock[m.sku]) _cache.stock[m.sku] = {};
  if (m.type === "in") {
    _cache.stock[m.sku][m.pos] = (_cache.stock[m.sku][m.pos] || 0) + m.qty;
  } else {
    _cache.stock[m.sku][m.pos] = Math.max(0, (_cache.stock[m.sku][m.pos] || 0) - m.qty);
    if (_cache.stock[m.sku][m.pos] === 0) delete _cache.stock[m.sku][m.pos];
  }
  _cache.movements.unshift(mov);

  // Fire & forget to Supabase
  if (isConfigured()) {
    const delta = m.type === "in" ? m.qty : -m.qty;
    db.updateStock(m.sku, m.pos, delta).catch(console.error);
    db.insertMovimiento({
      tipo: m.type === "in" ? "entrada" : "salida",
      motivo: motivoToDB(m.reason, m.type),
      sku: m.sku, posicion_id: m.pos, cantidad: m.qty,
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

  // Fetch current line to calculate new qty_ubicada
  const lineas = await db.fetchRecepcionLineas(recepcionId);
  const linea = lineas.find(l => l.id === lineaId);
  const newQtyUbicada = (linea?.qty_ubicada || 0) + qty;
  const qtyTotal = linea?.qty_recibida || linea?.qty_factura || 0;

  await db.updateRecepcionLinea(lineaId, {
    qty_ubicada: newQtyUbicada,
    estado: newQtyUbicada >= qtyTotal ? "UBICADA" : linea?.estado,
    operario_ubicacion: operario,
    ...(newQtyUbicada >= qtyTotal ? { ts_ubicacion: new Date().toISOString() } : {}),
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

// ==================== FORMAT HELPERS ====================
export function fmtDate(iso: string) { try { return new Date(iso).toLocaleDateString("es-CL"); } catch { return iso; } }
export function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
export function fmtMoney(n: number) { return "$" + n.toLocaleString("es-CL"); }

// ==================== LEGACY COMPAT ====================
export function nextMovId(): string { return "M" + Date.now(); }
export async function pullCloudState(): Promise<boolean> { return refreshStore(); }
export async function getCloudStatus(): Promise<string> { return isConfigured() ? "connected" : "not_configured"; }
