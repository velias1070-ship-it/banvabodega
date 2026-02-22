"use client";

export interface SKUData {
  d: string;
  cat: string;
  prov: string;
  cost: number;
  price: number;
  locs: Record<string, number>;
  transit: number;
  full: number;
  reorder: number;
  sales30: number;
  mlCode?: string;
}

export interface Movement {
  id: string;
  ts: string;
  type: "in" | "out-full" | "out-flex" | "adjust";
  sku: string;
  loc: string;
  qty: number;
  who: string;
  ref: string;
}

export interface CycleCount {
  date: string;
  sku: string;
  loc: string;
  expected: number;
  counted: number;
  diff: number;
}

export interface StoreData {
  db: Record<string, SKUData>;
  movements: Movement[];
  cycleCounts: CycleCount[];
  movCounter: number;
}

const PROVEEDORES = ["Idetex", "Container", "Biblias", "Mates", "Delart", "Esperanza"];
const CATEGORIAS = ["Sábanas", "Toallas", "Quilts", "Almohadas", "Fundas", "Cuero"];

// Pallet positions (floor): P-01 to P-20
// Shelf positions: E-01-1 to E-04-3 (4 shelving units, 3 levels each)
const LOCS: string[] = [];
for (let i = 1; i <= 20; i++) LOCS.push(`P-${String(i).padStart(2,"0")}`);
for (let e = 1; e <= 4; e++) for (let n = 1; n <= 3; n++) LOCS.push(`E-${String(e).padStart(2,"0")}-${n}`);

// Location type helpers
function isPallet(loc: string) { return loc.startsWith("P-"); }
function isShelf(loc: string) { return loc.startsWith("E-"); }

const DEFAULT_DB: Record<string, SKUData> = {
  "TOA-0042": { d: "Toalla Diseño 042", cat: "Toallas", prov: "Container", cost: 5200, price: 14990, locs: { "P-01": 25, "P-08": 30 }, transit: 15, full: 85, reorder: 30, sales30: 42 },
  "SAB-0001": { d: "Sábanas Diseño 001", cat: "Sábanas", prov: "Idetex", cost: 8500, price: 24990, locs: { "P-02": 45 }, transit: 0, full: 120, reorder: 25, sales30: 38 },
  "QUI-0003": { d: "Quilt Diseño 003", cat: "Quilts", prov: "Idetex", cost: 12000, price: 34990, locs: { "P-03": 30 }, transit: 15, full: 60, reorder: 20, sales30: 22 },
  "ALM-0004": { d: "Almohada Diseño 004", cat: "Almohadas", prov: "Mates", cost: 3800, price: 9990, locs: { "E-01-1": 80 }, transit: 0, full: 45, reorder: 40, sales30: 55 },
  "FUN-0005": { d: "Fundas Diseño 005", cat: "Fundas", prov: "Biblias", cost: 2200, price: 6990, locs: { "P-05": 60, "E-02-1": 40 }, transit: 20, full: 150, reorder: 35, sales30: 48 },
  "CUE-0006": { d: "Cuero Diseño 006", cat: "Cuero", prov: "Esperanza", cost: 18000, price: 49990, locs: { "E-01-3": 15 }, transit: 0, full: 22, reorder: 10, sales30: 8 },
  "TOA-0015": { d: "Toalla Diseño 015", cat: "Toallas", prov: "Container", cost: 4800, price: 12990, locs: { "P-10": 35 }, transit: 10, full: 70, reorder: 25, sales30: 30 },
  "SAB-0022": { d: "Sábanas Diseño 022", cat: "Sábanas", prov: "Idetex", cost: 9200, price: 27990, locs: { "P-06": 20 }, transit: 5, full: 95, reorder: 20, sales30: 28 },
};

const DEFAULT_MOVEMENTS: Movement[] = [
  { id: "M001", ts: "2026-02-20T09:30:00", type: "in", sku: "TOA-0042", loc: "P-01", qty: 25, who: "Vicente", ref: "FAC-2026-0412" },
  { id: "M002", ts: "2026-02-20T14:00:00", type: "out-full", sku: "SAB-0001", loc: "P-02", qty: 30, who: "Vicente", ref: "ENV-ML-88901" },
  { id: "M003", ts: "2026-02-21T10:15:00", type: "in", sku: "ALM-0004", loc: "E-01-1", qty: 80, who: "Operario 1", ref: "FAC-2026-0413" },
  { id: "M004", ts: "2026-02-21T16:45:00", type: "out-flex", sku: "QUI-0003", loc: "P-03", qty: 2, who: "Sistema", ref: "ML-ORD-77234521" },
  { id: "M005", ts: "2026-02-22T09:00:00", type: "out-full", sku: "FUN-0005", loc: "P-05", qty: 50, who: "Vicente", ref: "ENV-ML-88920" },
];

const DEFAULT_COUNTS: CycleCount[] = [
  { date: "2026-02-20", sku: "TOA-0042", loc: "P-01", expected: 25, counted: 25, diff: 0 },
  { date: "2026-02-20", sku: "SAB-0001", loc: "P-02", expected: 47, counted: 45, diff: -2 },
  { date: "2026-02-21", sku: "ALM-0004", loc: "E-01-1", expected: 80, counted: 80, diff: 0 },
];

function loadStore(): StoreData {
  if (typeof window === "undefined") return { db: DEFAULT_DB, movements: DEFAULT_MOVEMENTS, cycleCounts: DEFAULT_COUNTS, movCounter: 6 };
  try {
    const raw = localStorage.getItem("banva_store");
    if (raw) return JSON.parse(raw);
  } catch {}
  return { db: DEFAULT_DB, movements: DEFAULT_MOVEMENTS, cycleCounts: DEFAULT_COUNTS, movCounter: 6 };
}

function saveStore(data: StoreData) {
  if (typeof window !== "undefined") localStorage.setItem("banva_store", JSON.stringify(data));
}

// Singleton store
let _store: StoreData | null = null;
export function getStore(): StoreData {
  if (!_store) _store = loadStore();
  return _store;
}
export function updateStore(patch: Partial<StoreData>) {
  _store = { ...getStore(), ...patch };
  saveStore(_store);
}
export function resetStore() {
  _store = { db: DEFAULT_DB, movements: DEFAULT_MOVEMENTS, cycleCounts: DEFAULT_COUNTS, movCounter: 6 };
  saveStore(_store);
}

// Helpers
export function getSkuBodTotal(db: Record<string, SKUData>, sku: string) {
  return Object.values(db[sku]?.locs || {}).reduce((a, b) => a + b, 0);
}
export function getSkuTotal(db: Record<string, SKUData>, sku: string) {
  const d = db[sku]; if (!d) return 0;
  return getSkuBodTotal(db, sku) + d.transit + d.full;
}
export function getLocItems(db: Record<string, SKUData>, loc: string) {
  return Object.entries(db).filter(([, v]) => (v.locs[loc] || 0) > 0).map(([s, v]) => ({ sku: s, qty: v.locs[loc], desc: v.d }));
}
export function getStockStatus(db: Record<string, SKUData>, sku: string) {
  const t = getSkuTotal(db, sku), r = db[sku]?.reorder || 0;
  if (t <= 0) return { label: "SIN STOCK", color: "#ef4444" };
  if (t <= r) return { label: "CRÍTICO", color: "#ef4444" };
  if (t <= r * 1.5) return { label: "BAJO", color: "#f59e0b" };
  return { label: "OK", color: "#10b981" };
}
export function getABC(db: Record<string, SKUData>, sku: string) {
  const sales = db[sku]?.sales30 || 0;
  const all = Object.values(db).map(v => v.sales30).sort((a, b) => b - a);
  const p80 = all[Math.floor(all.length * 0.2)] || 0;
  const p50 = all[Math.floor(all.length * 0.5)] || 0;
  if (sales >= p80) return "A"; if (sales >= p50) return "B"; return "C";
}
export function nextMovId(store: StoreData) {
  const id = "M" + String(store.movCounter).padStart(3, "0");
  store.movCounter++;
  return id;
}
export function fmtMoney(n: number) { return "$" + n.toLocaleString("es-CL"); }
export function fmtDate(s: string) { return new Date(s).toLocaleDateString("es-CL"); }
export function fmtTime(s: string) { return new Date(s).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }); }
export { PROVEEDORES, CATEGORIAS, LOCS, isPallet, isShelf };
