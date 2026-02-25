"use client";

// ==================== TYPES ====================
export interface Product {
  sku: string;
  name: string;
  mlCode: string;       // codigo ML de la etiqueta
  cat: string;
  prov: string;
  cost: number;
  price: number;
  reorder: number;
}

export interface Position {
  id: string;
  label: string;
  type: "pallet" | "shelf";
  active: boolean;
  // Map coordinates (grid units)
  mx?: number;
  my?: number;
  mw?: number;
  mh?: number;
  color?: string;
}

export interface MapObject {
  id: string;
  label: string;
  kind: "desk" | "door" | "wall" | "zone" | "label";
  mx: number;
  my: number;
  mw: number;
  mh: number;
  color: string;
  rotation?: number;
}

export interface MapConfig {
  gridW: number;  // warehouse width in grid units
  gridH: number;  // warehouse height in grid units
  objects: MapObject[];
}

export type InReason = "compra" | "devolucion" | "ajuste_entrada" | "transferencia_in";
export type OutReason = "venta_flex" | "envio_full" | "ajuste_salida" | "merma";
export type MovType = "in" | "out";

export interface Movement {
  id: string;
  ts: string;           // ISO timestamp
  type: MovType;
  reason: InReason | OutReason;
  sku: string;
  pos: string;          // position id
  qty: number;
  who: string;          // operator name
  note: string;         // optional note/reference
}

// stock[sku][positionId] = quantity
export type StockMap = Record<string, Record<string, number>>;

export interface StoreData {
  products: Record<string, Product>;
  positions: Position[];
  stock: StockMap;
  movements: Movement[];
  movCounter: number;
  mapConfig?: MapConfig;
}

// ==================== REASON LABELS ====================
export const IN_REASONS: Record<InReason, string> = {
  compra: "Compra de inventario",
  devolucion: "Devolución",
  ajuste_entrada: "Ajuste (+)",
  transferencia_in: "Transferencia entrada",
};

export const OUT_REASONS: Record<OutReason, string> = {
  venta_flex: "Venta Flex",
  envio_full: "Envío a ML Full",
  ajuste_salida: "Ajuste (-)",
  merma: "Merma / Pérdida",
};

export const DEFAULT_CATEGORIAS = ["Sábanas", "Toallas", "Quilts", "Almohadas", "Fundas", "Cuero", "Otros"];
export const DEFAULT_PROVEEDORES = ["Idetex", "Container", "Biblias", "Mates", "Delart", "Esperanza", "Otro"];

const CAT_KEY = "banva_categorias";
const PROV_KEY = "banva_proveedores";

export function getCategorias(): string[] {
  if (typeof window === "undefined") return DEFAULT_CATEGORIAS;
  try { const raw = localStorage.getItem(CAT_KEY); if (raw) return JSON.parse(raw); } catch {}
  return DEFAULT_CATEGORIAS;
}
export function saveCategorias(cats: string[]) {
  if (typeof window !== "undefined") localStorage.setItem(CAT_KEY, JSON.stringify(cats));
}
export function getProveedores(): string[] {
  if (typeof window === "undefined") return DEFAULT_PROVEEDORES;
  try { const raw = localStorage.getItem(PROV_KEY); if (raw) return JSON.parse(raw); } catch {}
  return DEFAULT_PROVEEDORES;
}
export function saveProveedores(provs: string[]) {
  if (typeof window !== "undefined") localStorage.setItem(PROV_KEY, JSON.stringify(provs));
}

// Keep backward-compatible exports
export const CATEGORIAS = DEFAULT_CATEGORIAS;
export const PROVEEDORES = DEFAULT_PROVEEDORES;

// ==================== DEFAULT DATA ====================
function defaultPositions(): Position[] {
  const pos: Position[] = [];
  for (let i = 1; i <= 15; i++) {
    pos.push({ id: String(i), label: `Posición ${i}`, type: "pallet", active: true });
  }
  // A few shelf positions
  for (let e = 1; e <= 2; e++) {
    for (let n = 1; n <= 3; n++) {
      pos.push({ id: `E${e}-${n}`, label: `Estante ${e} Nivel ${n}`, type: "shelf", active: true });
    }
  }
  return pos;
}

function defaultProducts(): Record<string, Product> {
  return {
    "TOA-042": { sku: "TOA-042", name: "Toalla Diseño 042", mlCode: "MLC-882734", cat: "Toallas", prov: "Container", cost: 5200, price: 14990, reorder: 30 },
    "SAB-001": { sku: "SAB-001", name: "Sábanas Diseño 001", mlCode: "MLC-991205", cat: "Sábanas", prov: "Idetex", cost: 8500, price: 24990, reorder: 25 },
    "QUI-003": { sku: "QUI-003", name: "Quilt Diseño 003", mlCode: "MLC-774521", cat: "Quilts", prov: "Idetex", cost: 12000, price: 34990, reorder: 20 },
    "ALM-004": { sku: "ALM-004", name: "Almohada Diseño 004", mlCode: "MLC-663418", cat: "Almohadas", prov: "Mates", cost: 3800, price: 9990, reorder: 40 },
  };
}

function defaultStock(): StockMap {
  return {
    "TOA-042": { "1": 25, "5": 30 },
    "SAB-001": { "2": 45 },
    "QUI-003": { "3": 30, "E1-2": 10 },
    "ALM-004": { "E1-1": 80 },
  };
}

function defaultMovements(): Movement[] {
  return [
    { id: "M001", ts: "2026-02-20T09:30:00", type: "in", reason: "compra", sku: "TOA-042", pos: "1", qty: 25, who: "Vicente", note: "Factura Container #412" },
    { id: "M002", ts: "2026-02-20T14:00:00", type: "out", reason: "envio_full", sku: "SAB-001", pos: "2", qty: 30, who: "Vicente", note: "Envío ML Full #88901" },
    { id: "M003", ts: "2026-02-21T10:15:00", type: "in", reason: "compra", sku: "ALM-004", pos: "E1-1", qty: 80, who: "Operario", note: "Factura Mates #413" },
    { id: "M004", ts: "2026-02-21T16:45:00", type: "out", reason: "venta_flex", sku: "QUI-003", pos: "3", qty: 2, who: "Sistema", note: "Orden ML #77234521" },
  ];
}

// ==================== GOOGLE SHEETS SYNC ====================
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRqskx-hK2bLc8vDOflxzx6dtyZZZm81c_pfLhSPz1KJL_FVTcGQjg75iftOyi-tU9hJGidJqu6jjtW/pub?gid=224135022&single=true&output=csv";
const SYNC_KEY = "banva_sheet_last_sync";
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

function parseCSVLine(line: string): string[] {
  const cells: string[] = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { cells.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  cells.push(current.trim());
  return cells;
}

export async function syncFromSheet(): Promise<{ added: number; updated: number; total: number }> {
  const result = { added: 0, updated: 0, total: 0 };
  try {
    const resp = await fetch(SHEET_CSV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    const lines = text.split("\n").map(l => l.replace(/\r/g, "").trim()).filter(l => l.length > 0);
    if (lines.length < 2) return result;

    // Skip header row
    const s = getStore();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const mlCode = (cols[0] || "").trim();
      const name = (cols[1] || "").trim();
      const sku = (cols[2] || "").trim().toUpperCase();
      if (!sku || !name) continue;

      result.total++;
      if (s.products[sku]) {
        // Update existing: sync name and mlCode from sheet, keep local cost/price/etc
        if (s.products[sku].name !== name || s.products[sku].mlCode !== mlCode) {
          s.products[sku].name = name;
          s.products[sku].mlCode = mlCode;
          result.updated++;
        }
      } else {
        // New product from sheet
        s.products[sku] = { sku, name, mlCode, cat: "Otros", prov: "Otro", cost: 0, price: 0, reorder: 20 };
        result.added++;
      }
    }
    saveStore();
    if (typeof window !== "undefined") {
      localStorage.setItem(SYNC_KEY, Date.now().toString());
    }
  } catch (err) {
    console.error("Sheet sync error:", err);
  }
  return result;
}

export function shouldSync(): boolean {
  if (typeof window === "undefined") return false;
  const last = localStorage.getItem(SYNC_KEY);
  if (!last) return true;
  return Date.now() - parseInt(last) > SYNC_INTERVAL;
}

export function getLastSyncTime(): string | null {
  if (typeof window === "undefined") return null;
  const last = localStorage.getItem(SYNC_KEY);
  if (!last) return null;
  try { return new Date(parseInt(last)).toLocaleString("es-CL"); } catch { return null; }
}

// ==================== STORE MANAGEMENT ====================
let _store: StoreData | null = null;
const STORE_KEY = "banva_wms";

export function getStore(): StoreData {
  if (_store) return _store;
  if (typeof window === "undefined") {
    return { products: defaultProducts(), positions: defaultPositions(), stock: defaultStock(), movements: defaultMovements(), movCounter: 5 };
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { _store = JSON.parse(raw); return _store!; }
  } catch {}
  _store = { products: defaultProducts(), positions: defaultPositions(), stock: defaultStock(), movements: defaultMovements(), movCounter: 5 };
  localStorage.setItem(STORE_KEY, JSON.stringify(_store));
  return _store;
}

export function saveStore(data?: Partial<StoreData>) {
  if (!_store) getStore();
  if (data) Object.assign(_store!, data);
  if (typeof window !== "undefined") {
    localStorage.setItem(STORE_KEY, JSON.stringify(_store));
  }
}

export function resetStore() {
  _store = { products: defaultProducts(), positions: defaultPositions(), stock: defaultStock(), movements: defaultMovements(), movCounter: 5 };
  if (typeof window !== "undefined") localStorage.setItem(STORE_KEY, JSON.stringify(_store));
}

// ==================== HELPERS ====================
export function nextMovId(): string {
  const s = getStore();
  s.movCounter++;
  saveStore();
  return "M" + String(s.movCounter).padStart(4, "0");
}

// Get total stock of a SKU across all positions
export function skuTotal(sku: string): number {
  const st = getStore().stock[sku];
  if (!st) return 0;
  return Object.values(st).reduce((a, b) => a + b, 0);
}

// Get all positions where a SKU has stock
export function skuPositions(sku: string): { pos: string; label: string; qty: number }[] {
  const s = getStore();
  const st = s.stock[sku];
  if (!st) return [];
  return Object.entries(st)
    .filter(([, q]) => q > 0)
    .map(([posId, qty]) => {
      const p = s.positions.find(p => p.id === posId);
      return { pos: posId, label: p ? p.label : `Pos ${posId}`, qty };
    })
    .sort((a, b) => b.qty - a.qty);
}

// Get contents of a position
export function posContents(posId: string): { sku: string; name: string; qty: number }[] {
  const s = getStore();
  const items: { sku: string; name: string; qty: number }[] = [];
  for (const [sku, posMap] of Object.entries(s.stock)) {
    if (posMap[posId] && posMap[posId] > 0) {
      const prod = s.products[sku];
      items.push({ sku, name: prod?.name || sku, qty: posMap[posId] });
    }
  }
  return items.sort((a, b) => b.qty - a.qty);
}

// Active positions only
export function activePositions(): Position[] {
  return getStore().positions.filter(p => p.active);
}

// Find product by SKU, mlCode, or partial name
export function findProduct(query: string): Product[] {
  const s = getStore();
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return Object.values(s.products).filter(p =>
    p.sku.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.mlCode.toLowerCase().includes(q)
  );
}

// Find position by ID or from QR data
export function findPosition(code: string): Position | null {
  const s = getStore();
  const clean = code.replace("BANVA-POS:", "").replace("BANVA-LOC:", "").trim();
  return s.positions.find(p => p.id === clean && p.active) || null;
}

// Record a movement and update stock
export function recordMovement(m: Omit<Movement, "id">): Movement {
  const s = getStore();
  const mov: Movement = { ...m, id: nextMovId() };

  // Update stock
  if (!s.stock[m.sku]) s.stock[m.sku] = {};
  if (m.type === "in") {
    s.stock[m.sku][m.pos] = (s.stock[m.sku][m.pos] || 0) + m.qty;
  } else {
    s.stock[m.sku][m.pos] = Math.max(0, (s.stock[m.sku][m.pos] || 0) - m.qty);
    if (s.stock[m.sku][m.pos] === 0) delete s.stock[m.sku][m.pos];
  }

  s.movements.unshift(mov);
  saveStore();
  return mov;
}

// Record bulk movements (for large shipments)
export function recordBulkMovements(items: { sku: string; pos: string; qty: number }[], type: MovType, reason: InReason | OutReason, who: string, note: string): number {
  const s = getStore();
  let count = 0;
  for (const item of items) {
    if (!item.sku || !item.pos || item.qty <= 0) continue;
    if (!s.stock[item.sku]) s.stock[item.sku] = {};
    if (type === "in") {
      s.stock[item.sku][item.pos] = (s.stock[item.sku][item.pos] || 0) + item.qty;
    } else {
      s.stock[item.sku][item.pos] = Math.max(0, (s.stock[item.sku][item.pos] || 0) - item.qty);
      if (s.stock[item.sku][item.pos] === 0) delete s.stock[item.sku][item.pos];
    }
    s.movements.unshift({
      id: nextMovId(), ts: new Date().toISOString(), type, reason,
      sku: item.sku, pos: item.pos, qty: item.qty, who, note
    });
    count++;
  }
  saveStore();
  return count;
}

// Format helpers
export function fmtDate(iso: string) { try { return new Date(iso).toLocaleDateString("es-CL"); } catch { return iso; } }
export function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; } }
export function fmtMoney(n: number) { return "$" + n.toLocaleString("es-CL"); }

// ==================== MAP CONFIG ====================
export function getMapConfig(): MapConfig {
  const s = getStore();
  if (s.mapConfig) return s.mapConfig;
  return { gridW: 20, gridH: 14, objects: [
    { id: "door1", label: "ENTRADA", kind: "door", mx: 0, my: 5, mw: 1, mh: 3, color: "#f59e0b" },
    { id: "desk1", label: "Escritorio", kind: "desk", mx: 1, my: 1, mw: 3, mh: 2, color: "#6366f1" },
  ]};
}

export function saveMapConfig(cfg: MapConfig) {
  const s = getStore();
  s.mapConfig = cfg;
  saveStore();
}

export function savePositionMap(posId: string, mx: number, my: number, mw: number, mh: number) {
  const s = getStore();
  const p = s.positions.find(x => x.id === posId);
  if (p) { p.mx = mx; p.my = my; p.mw = mw; p.mh = mh; saveStore(); }
}
