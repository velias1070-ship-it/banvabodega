"use client";
import { getSupabase } from "./supabase";

// ==================== TYPES ====================
export interface DBProduct {
  id?: string;
  sku: string;
  sku_venta: string;
  codigo_ml: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  costo: number;
  precio: number;
  reorder: number;
  requiere_etiqueta: boolean;
}

export interface DBPosition {
  id: string;
  label: string;
  tipo: "pallet" | "shelf";
  activa: boolean;
  mx: number;
  my: number;
  mw: number;
  mh: number;
  color: string;
}

export interface DBStock {
  id?: string;
  sku: string;
  posicion_id: string;
  cantidad: number;
}

export interface DBMovimiento {
  id?: string;
  tipo: "entrada" | "salida" | "transferencia";
  motivo: string;
  sku: string;
  posicion_id: string;
  cantidad: number;
  recepcion_id?: string;
  operario: string;
  nota: string;
  created_at?: string;
}

export interface DBRecepcion {
  id?: string;
  folio: string;
  proveedor: string;
  imagen_url: string;
  estado: "CREADA" | "EN_PROCESO" | "COMPLETADA" | "CERRADA";
  notas: string;
  created_at?: string;
  created_by: string;
  completed_at?: string;
}

export interface DBRecepcionLinea {
  id?: string;
  recepcion_id: string;
  sku: string;
  codigo_ml: string;
  nombre: string;
  qty_factura: number;
  qty_recibida: number;
  qty_etiquetada: number;
  qty_ubicada: number;
  estado: "PENDIENTE" | "CONTADA" | "EN_ETIQUETADO" | "ETIQUETADA" | "UBICADA";
  requiere_etiqueta: boolean;
  costo_unitario: number;
  notas: string;
  operario_conteo: string;
  operario_etiquetado: string;
  operario_ubicacion: string;
  ts_conteo?: string;
  ts_etiquetado?: string;
  ts_ubicacion?: string;
}

export interface DBMapConfig {
  id: string;
  config: unknown[];
  grid_w: number;
  grid_h: number;
}

export interface DBOperario {
  id: string;
  nombre: string;
  pin: string;
  activo: boolean;
  rol: "operario" | "admin";
}

// ==================== PRODUCTOS ====================
export async function fetchProductos(): Promise<DBProduct[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("productos").select("*").order("sku");
  return data || [];
}

export async function upsertProducto(p: DBProduct) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("productos").upsert(p, { onConflict: "sku" });
}

export async function upsertProductos(prods: DBProduct[]) {
  const sb = getSupabase(); if (!sb) return;
  // Batch in chunks of 500
  for (let i = 0; i < prods.length; i += 500) {
    await sb.from("productos").upsert(prods.slice(i, i + 500), { onConflict: "sku" });
  }
}

export async function deleteProducto(sku: string) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("productos").delete().eq("sku", sku);
}

// ==================== POSICIONES ====================
export async function fetchPosiciones(): Promise<DBPosition[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("posiciones").select("*").order("id");
  return data || [];
}

export async function upsertPosicion(p: DBPosition) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("posiciones").upsert(p, { onConflict: "id" });
}

export async function updatePosicion(id: string, fields: Partial<DBPosition>) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("posiciones").update(fields).eq("id", id);
}

export async function deletePosicion(id: string) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("posiciones").delete().eq("id", id);
}

// ==================== STOCK ====================
export async function fetchStock(): Promise<DBStock[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("stock").select("*");
  return data || [];
}

export async function updateStock(sku: string, posicion_id: string, delta: number) {
  const sb = getSupabase(); if (!sb) return;
  await sb.rpc("update_stock", { p_sku: sku, p_posicion: posicion_id, p_delta: delta });
}

export async function setStock(sku: string, posicion_id: string, cantidad: number) {
  const sb = getSupabase(); if (!sb) return;
  if (cantidad <= 0) {
    await sb.from("stock").delete().eq("sku", sku).eq("posicion_id", posicion_id);
  } else {
    await sb.from("stock").upsert(
      { sku, posicion_id, cantidad, updated_at: new Date().toISOString() },
      { onConflict: "sku,posicion_id" }
    );
  }
}

export async function deleteStockBySku(sku: string) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("stock").delete().eq("sku", sku);
}

// ==================== MOVIMIENTOS ====================
export async function fetchMovimientos(limit = 200): Promise<DBMovimiento[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("movimientos").select("*").order("created_at", { ascending: false }).limit(limit);
  return data || [];
}

export async function insertMovimiento(m: Omit<DBMovimiento, "id" | "created_at">) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("movimientos").insert(m);
}

// ==================== RECEPCIONES ====================
export async function fetchRecepciones(): Promise<DBRecepcion[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("recepciones").select("*").order("created_at", { ascending: false });
  return data || [];
}

export async function fetchRecepcionesActivas(): Promise<DBRecepcion[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("recepciones").select("*")
    .in("estado", ["CREADA", "EN_PROCESO"])
    .order("created_at", { ascending: false });
  return data || [];
}

export async function insertRecepcion(r: Omit<DBRecepcion, "id" | "created_at">): Promise<string | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.from("recepciones").insert(r).select("id").single();
  return data?.id || null;
}

export async function updateRecepcion(id: string, fields: Partial<DBRecepcion>) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepciones").update(fields).eq("id", id);
}

// ==================== RECEPCION LINEAS ====================
export async function fetchRecepcionLineas(recepcionId: string): Promise<DBRecepcionLinea[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("recepcion_lineas").select("*")
    .eq("recepcion_id", recepcionId).order("sku");
  return data || [];
}

export async function insertRecepcionLineas(lineas: Omit<DBRecepcionLinea, "id">[]) {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < lineas.length; i += 500) {
    await sb.from("recepcion_lineas").insert(lineas.slice(i, i + 500));
  }
}

export async function updateRecepcionLinea(id: string, fields: Partial<DBRecepcionLinea>) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepcion_lineas").update(fields).eq("id", id);
}

// ==================== OPERARIOS ====================
export async function fetchOperarios(): Promise<DBOperario[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("operarios").select("*").eq("activo", true).order("nombre");
  return data || [];
}

export async function upsertOperario(o: DBOperario) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("operarios").upsert(o, { onConflict: "id" });
}

export async function loginOperario(id: string, pin: string): Promise<DBOperario | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.from("operarios").select("*")
    .eq("id", id).eq("pin", pin).eq("activo", true).single();
  return data || null;
}

// ==================== MAPA ====================
export async function fetchMapConfig(): Promise<DBMapConfig | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.from("mapa_config").select("*").eq("id", "main").single();
  return data || null;
}

export async function saveMapConfigDB(cfg: DBMapConfig) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("mapa_config").upsert({ ...cfg, id: "main", updated_at: new Date().toISOString() }, { onConflict: "id" });
}

// ==================== UPLOAD IMAGEN FACTURA ====================
export async function uploadFacturaImage(base64: string, folio: string): Promise<string> {
  const sb = getSupabase(); if (!sb) return "";
  try {
    // Convert base64 to blob
    const byteString = atob(base64.split(",")[1] || base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    const blob = new Blob([ab], { type: "image/jpeg" });

    const path = `facturas/${folio}_${Date.now()}.jpg`;
    const { error } = await sb.storage.from("banva").upload(path, blob, { upsert: true });
    if (error) { console.error("Upload error:", error); return ""; }
    
    const { data } = sb.storage.from("banva").getPublicUrl(path);
    return data?.publicUrl || "";
  } catch (err) {
    console.error("Upload failed:", err);
    return "";
  }
}

// ==================== SYNC PRODUCTOS FROM SHEET ====================
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRqskx-hK2bLc8vDOflxzx6dtyZZZm81c_pfLhSPz1KJL_FVTcGQjg75iftOyi-tU9hJGidJqu6jjtW/pub?gid=224135022&single=true&output=csv";

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

export async function syncProductosFromSheet(): Promise<{ added: number; updated: number; total: number }> {
  const result = { added: 0, updated: 0, total: 0 };
  try {
    const resp = await fetch(SHEET_CSV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    const lines = text.split("\n").map(l => l.replace(/\r/g, "").trim()).filter(l => l.length > 0);
    if (lines.length < 2) return result;

    // Fetch existing products to detect new vs update
    const existing = await fetchProductos();
    const existingMap = new Map(existing.map(p => [p.sku, p]));

    const toUpsert: DBProduct[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const mlCode = (cols[0] || "").trim();
      const name = (cols[1] || "").trim();
      const sku = (cols[2] || "").trim().toUpperCase();
      if (!sku || !name) continue;
      result.total++;

      const ex = existingMap.get(sku);
      if (ex) {
        if (ex.nombre !== name || ex.codigo_ml !== mlCode) {
          toUpsert.push({ ...ex, nombre: name, codigo_ml: mlCode });
          result.updated++;
        }
      } else {
        toUpsert.push({
          sku, sku_venta: "", codigo_ml: mlCode, nombre: name,
          categoria: "Otros", proveedor: "Otro", costo: 0, precio: 0,
          reorder: 20, requiere_etiqueta: true,
        });
        result.added++;
      }
    }

    if (toUpsert.length > 0) await upsertProductos(toUpsert);
  } catch (err) {
    console.error("Sheet sync error:", err);
  }
  return result;
}

// Import stock from Sheet column K (one-time)
export async function importStockFromSheet(): Promise<{ imported: number; totalUnits: number }> {
  const result = { imported: 0, totalUnits: 0 };
  try {
    const resp = await fetch(SHEET_CSV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    const lines = text.split("\n").map(l => l.replace(/\r/g, "").trim()).filter(l => l.length > 0);
    if (lines.length < 2) return result;

    // Clear existing SIN_ASIGNAR stock
    const sb = getSupabase(); if (!sb) return result;
    await sb.from("stock").delete().eq("posicion_id", "SIN_ASIGNAR");

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const sku = (cols[2] || "").trim().toUpperCase();
      if (!sku) continue;
      const rawQty = (cols[10] || "").replace(/[^0-9]/g, "");
      const qty = parseInt(rawQty) || 0;
      if (qty <= 0) continue;

      // Ensure product exists
      const nombre = (cols[1] || "").trim();
      const mlCode = (cols[0] || "").trim();
      if (nombre) {
        await upsertProducto({
          sku, sku_venta: "", codigo_ml: mlCode, nombre,
          categoria: "Otros", proveedor: "Otro", costo: 0, precio: 0,
          reorder: 20, requiere_etiqueta: true,
        });
      }

      await setStock(sku, "SIN_ASIGNAR", qty);
      await insertMovimiento({
        tipo: "entrada", motivo: "carga_inicial", sku,
        posicion_id: "SIN_ASIGNAR", cantidad: qty,
        operario: "Sistema", nota: "Importación desde Google Sheet",
      });

      result.imported++;
      result.totalUnits += qty;
    }
  } catch (err) {
    console.error("Stock import error:", err);
  }
  return result;
}
