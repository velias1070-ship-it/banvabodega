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
  tamano: string;
  color: string;
}

export interface DBComposicionVenta {
  id?: string;
  sku_venta: string;
  codigo_ml: string;
  sku_origen: string;
  unidades: number;
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
  estado: "CREADA" | "EN_PROCESO" | "COMPLETADA" | "CERRADA" | "ANULADA" | "PAUSADA";
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

// Strip auto-generated fields (created_at, updated_at) that Supabase rejects on upsert
function cleanProduct(p: DBProduct): DBProduct {
  return {
    sku: p.sku, sku_venta: p.sku_venta, codigo_ml: p.codigo_ml,
    nombre: p.nombre, categoria: p.categoria, proveedor: p.proveedor,
    costo: p.costo, precio: p.precio, reorder: p.reorder,
    requiere_etiqueta: p.requiere_etiqueta, tamano: p.tamano, color: p.color,
  };
}

export async function fetchProductos(): Promise<DBProduct[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("productos").select("*").order("sku");
  return data || [];
}

export async function upsertProducto(p: DBProduct) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("productos").upsert(cleanProduct(p), { onConflict: "sku" });
}

export async function upsertProductos(prods: DBProduct[]) {
  const sb = getSupabase(); if (!sb) return;
  // Batch in chunks of 500
  for (let i = 0; i < prods.length; i += 500) {
    await sb.from("productos").upsert(prods.slice(i, i + 500).map(cleanProduct), { onConflict: "sku" });
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

export async function deleteRecepcionLinea(id: string) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepcion_lineas").delete().eq("id", id);
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

// ==================== COMPOSICION VENTA (PACKS/COMBOS) ====================
export async function fetchComposicionVenta(): Promise<DBComposicionVenta[]> {
  const sb = getSupabase(); if (!sb) { console.error("[composicion] no supabase client"); return []; }
  const { data, error } = await sb.from("composicion_venta").select("*");
  if (error) console.error("[composicion] fetch error:", error.message, error.code, error.details);
  console.log("[composicion] fetched rows:", data?.length ?? 0);
  return data || [];
}

export async function upsertComposicionVenta(items: DBComposicionVenta[]) {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < items.length; i += 500) {
    const batch = items.slice(i, i + 500);
    const { error } = await sb.from("composicion_venta").upsert(batch, { onConflict: "sku_venta,sku_origen" });
    if (error) console.error(`[composicion] upsert error (batch ${i}-${i + batch.length}):`, error.message, error.code, error.details);
    else console.log(`[composicion] upserted batch ${i}-${i + batch.length} OK`);
  }
}

export async function clearComposicionVenta() {
  const sb = getSupabase(); if (!sb) return;
  const { error } = await sb.from("composicion_venta").delete().neq("sku_venta", "");
  if (error) console.error("[composicion] clear error:", error.message, error.code, error.details);
  else console.log("[composicion] cleared OK");
}

// Dado un código ML, ¿qué SKUs físicos necesito? (para ventas)
export async function getComponentesVenta(codigoMl: string): Promise<DBComposicionVenta[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("composicion_venta").select("*").eq("codigo_ml", codigoMl);
  return data || [];
}

// Dado un SKU venta, ¿qué SKUs físicos necesito?
export async function getComponentesPorSkuVenta(skuVenta: string): Promise<DBComposicionVenta[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("composicion_venta").select("*").eq("sku_venta", skuVenta);
  return data || [];
}

// ==================== SYNC DICCIONARIO FROM SHEET ====================
// Sheet columns: SKU Venta | CODIGO ML | Nombre Origen | Proveedor | Sku Origen | Unidades | Tamaño | Color | Categoria | Largo | Alto | Ancho | Peso (kg) | Costo
const DICT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQZxKcXM-OaJ5_B-lEM87PPy9B4675FRFLfpWtL-ZhTqpalZNqODq18XFY2C4txj7fXc5n1jYZSTWrJ/pub?gid=348421726&single=true&output=csv";

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

export async function syncDiccionarioFromSheet(): Promise<{
  productos: { added: number; updated: number; total: number };
  composicion: { total: number };
}> {
  const result = {
    productos: { added: 0, updated: 0, total: 0 },
    composicion: { total: 0 },
  };

  try {
    const resp = await fetch(DICT_CSV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    const lines = text.split("\n").map(l => l.replace(/\r/g, "").trim()).filter(l => l.length > 0);
    if (lines.length < 2) return result;

    // Parse all rows
    const rows: Array<{
      skuVenta: string; codigoMl: string; nombreOrigen: string;
      proveedor: string; skuOrigen: string; unidades: number;
      tamano: string; color: string; categoria: string; costo: number;
    }> = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      const skuVenta = (cols[0] || "").trim().toUpperCase();
      const codigoMl = (cols[1] || "").trim();
      const nombreOrigen = (cols[2] || "").trim();
      const proveedor = (cols[3] || "").trim();
      const skuOrigen = (cols[4] || "").trim().toUpperCase();
      const unidades = parseInt(cols[5] || "1") || 1;
      const tamano = (cols[6] || "").trim();
      const color = (cols[7] || "").trim();
      const categoria = (cols[8] || "").trim() || "Otros";
      const costo = parseFloat(cols[13] || "0") || 0;

      if (!skuOrigen || !nombreOrigen) continue;
      rows.push({ skuVenta, codigoMl, nombreOrigen, proveedor, skuOrigen, unidades, tamano, color, categoria, costo });
    }

    // 1) Build unique productos (keyed by SKU Origen = producto físico)
    // A single SKU Origen can appear in MULTIPLE rows with different SKU Venta
    // (e.g., same product sold as single unit AND as pack of 2)
    const productMap = new Map<string, DBProduct>();
    const skuVentasByOrigen = new Map<string, Set<string>>();
    const codigosMlByOrigen = new Map<string, Set<string>>();

    for (const row of rows) {
      // Track all SKU Ventas and Codigos ML for this SKU Origen
      if (!skuVentasByOrigen.has(row.skuOrigen)) skuVentasByOrigen.set(row.skuOrigen, new Set());
      if (!codigosMlByOrigen.has(row.skuOrigen)) codigosMlByOrigen.set(row.skuOrigen, new Set());
      if (row.skuVenta) skuVentasByOrigen.get(row.skuOrigen)!.add(row.skuVenta);
      if (row.codigoMl) codigosMlByOrigen.get(row.skuOrigen)!.add(row.codigoMl);

      if (!productMap.has(row.skuOrigen)) {
        productMap.set(row.skuOrigen, {
          sku: row.skuOrigen,
          sku_venta: row.skuVenta, // will be overwritten below with all ventas
          codigo_ml: row.codigoMl, // will be overwritten below with all codes
          nombre: row.nombreOrigen,
          categoria: row.categoria,
          proveedor: row.proveedor,
          costo: row.costo,
          precio: 0,
          reorder: 20,
          requiere_etiqueta: !!row.codigoMl,
          tamano: row.tamano,
          color: row.color,
        });
      }
    }

    // Now set sku_venta and codigo_ml with ALL values for each product
    productMap.forEach((prod, skuOrigen) => {
      const ventas = skuVentasByOrigen.get(skuOrigen);
      const codigos = codigosMlByOrigen.get(skuOrigen);
      prod.sku_venta = ventas ? Array.from(ventas).join(",") : "";
      prod.codigo_ml = codigos ? Array.from(codigos).join(",") : "";
      prod.requiere_etiqueta = !!prod.codigo_ml;
    });

    // Fetch existing to detect added vs updated
    const existing = await fetchProductos();
    const existingMap = new Map(existing.map(p => [p.sku, p]));

    const toUpsert: DBProduct[] = [];
    productMap.forEach((prod, sku) => {
      const ex = existingMap.get(sku);
      if (ex) {
        // Update if anything changed (preserve price/reorder set by admin)
        if (ex.nombre !== prod.nombre || ex.proveedor !== prod.proveedor ||
            ex.categoria !== prod.categoria || ex.tamano !== prod.tamano ||
            ex.color !== prod.color || ex.costo !== prod.costo ||
            ex.codigo_ml !== prod.codigo_ml || ex.sku_venta !== prod.sku_venta ||
            ex.requiere_etiqueta !== prod.requiere_etiqueta) {
          toUpsert.push({
            ...ex,
            nombre: prod.nombre,
            proveedor: prod.proveedor,
            categoria: prod.categoria,
            costo: prod.costo,
            tamano: prod.tamano,
            color: prod.color,
            codigo_ml: prod.codigo_ml,
            sku_venta: prod.sku_venta,
            requiere_etiqueta: prod.requiere_etiqueta,
          });
          result.productos.updated++;
        }
      } else {
        toUpsert.push(prod);
        result.productos.added++;
      }
      result.productos.total++;
    });

    if (toUpsert.length > 0) await upsertProductos(toUpsert);

    // 2) Build composicion_venta (packs/combos)
    // Clear old and re-insert (simpler than diffing)
    await clearComposicionVenta();

    // Deduplicate by (sku_venta, sku_origen) — CSV may have duplicate rows
    const composicionMap = new Map<string, DBComposicionVenta>();
    for (const row of rows) {
      if (!row.skuVenta) continue;
      const key = `${row.skuVenta}|${row.skuOrigen}`;
      composicionMap.set(key, {
        sku_venta: row.skuVenta,
        codigo_ml: row.codigoMl,
        sku_origen: row.skuOrigen,
        unidades: row.unidades,
      });
    }
    const composicionItems = Array.from(composicionMap.values());

    if (composicionItems.length > 0) {
      await upsertComposicionVenta(composicionItems);
    }
    result.composicion.total = composicionItems.length;

  } catch (err) {
    console.error("Diccionario sync error:", err);
  }
  return result;
}

// Legacy: keep old sync as alias that calls new one
export async function syncProductosFromSheet(): Promise<{ added: number; updated: number; total: number }> {
  const result = await syncDiccionarioFromSheet();
  return result.productos;
}

// Import stock from Sheet (keep for backward compat, uses old sheet)
const STOCK_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRqskx-hK2bLc8vDOflxzx6dtyZZZm81c_pfLhSPz1KJL_FVTcGQjg75iftOyi-tU9hJGidJqu6jjtW/pub?gid=224135022&single=true&output=csv";

export async function importStockFromSheet(): Promise<{ imported: number; totalUnits: number }> {
  const result = { imported: 0, totalUnits: 0 };
  try {
    const resp = await fetch(STOCK_CSV_URL, { cache: "no-store" });
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
          reorder: 20, requiere_etiqueta: true, tamano: "", color: "",
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

// ==================== PICKING SESSIONS ====================

export interface DBPickingSession {
  id?: string;
  fecha: string;
  estado: string;
  lineas: PickingLinea[];
  created_at?: string;
  completed_at?: string | null;
}

export interface PickingComponente {
  skuOrigen: string;
  codigoMl: string;
  nombre: string;
  unidades: number;
  posicion: string;
  posLabel: string;
  stockDisponible: number;
  estado: "PENDIENTE" | "PICKEADO";
  pickedAt: string | null;
  operario: string | null;
}

export interface PickingLinea {
  id: string;
  skuVenta: string;
  qtyPedida: number;
  estado: "PENDIENTE" | "PICKEADO";
  componentes: PickingComponente[];
}

export async function createPickingSession(session: Omit<DBPickingSession, "id" | "created_at">): Promise<string | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data, error } = await sb.from("picking_sessions").insert({
    fecha: session.fecha,
    estado: session.estado,
    lineas: session.lineas as unknown,
  }).select("id").single();
  if (error) { console.error("createPickingSession error:", error); return null; }
  return data?.id || null;
}

export async function getPickingSessionsByDate(fecha: string): Promise<DBPickingSession[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("picking_sessions").select("*").eq("fecha", fecha).order("created_at", { ascending: false });
  return (data || []).map(d => ({ ...d, lineas: (d.lineas || []) as PickingLinea[] }));
}

export async function getActivePickingSessions(): Promise<DBPickingSession[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("picking_sessions").select("*").in("estado", ["ABIERTA", "EN_PROCESO"]).order("created_at", { ascending: false });
  return (data || []).map(d => ({ ...d, lineas: (d.lineas || []) as PickingLinea[] }));
}

export async function updatePickingSession(id: string, updates: Partial<DBPickingSession>): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const payload: Record<string, unknown> = {};
  if (updates.estado !== undefined) payload.estado = updates.estado;
  if (updates.lineas !== undefined) payload.lineas = updates.lineas as unknown;
  if (updates.completed_at !== undefined) payload.completed_at = updates.completed_at;
  const { error } = await sb.from("picking_sessions").update(payload).eq("id", id);
  if (error) { console.error("updatePickingSession error:", error); return false; }
  return true;
}

export async function deletePickingSession(id: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("picking_sessions").delete().eq("id", id);
  return !error;
}

// ==================== CONTEOS CÍCLICOS ====================

export interface ConteoLinea {
  posicion_id: string;
  posicion_label: string;
  sku: string;
  nombre: string;
  stock_sistema: number;
  stock_contado: number;
  operario: string;
  timestamp: string;
  estado: "PENDIENTE" | "CONTADO" | "VERIFICADO" | "AJUSTADO";
  es_inesperado: boolean;
}

export interface DBConteo {
  id?: string;
  fecha: string;
  tipo: "por_posicion" | "por_sku";
  estado: "ABIERTA" | "EN_PROCESO" | "REVISION" | "CERRADA";
  lineas: ConteoLinea[];
  posiciones: string[];
  posiciones_contadas: string[];
  created_at?: string;
  created_by: string;
  closed_at?: string | null;
  closed_by?: string | null;
}

export async function createConteo(conteo: Omit<DBConteo, "id" | "created_at">): Promise<string | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data, error } = await sb.from("conteos").insert({
    fecha: conteo.fecha,
    tipo: conteo.tipo,
    estado: conteo.estado,
    lineas: conteo.lineas as unknown,
    posiciones: conteo.posiciones,
    posiciones_contadas: conteo.posiciones_contadas,
    created_by: conteo.created_by,
  }).select("id").single();
  if (error) { console.error("createConteo error:", error); return null; }
  return data?.id || null;
}

export async function fetchConteos(): Promise<DBConteo[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("conteos").select("*").order("created_at", { ascending: false });
  return (data || []).map(d => ({
    ...d,
    lineas: (d.lineas || []) as ConteoLinea[],
    posiciones: (d.posiciones || []) as string[],
    posiciones_contadas: (d.posiciones_contadas || []) as string[],
  }));
}

export async function fetchActiveConteos(): Promise<DBConteo[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("conteos").select("*")
    .in("estado", ["ABIERTA", "EN_PROCESO"])
    .order("created_at", { ascending: false });
  return (data || []).map(d => ({
    ...d,
    lineas: (d.lineas || []) as ConteoLinea[],
    posiciones: (d.posiciones || []) as string[],
    posiciones_contadas: (d.posiciones_contadas || []) as string[],
  }));
}

export async function updateConteo(id: string, updates: Partial<DBConteo>): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const payload: Record<string, unknown> = {};
  if (updates.estado !== undefined) payload.estado = updates.estado;
  if (updates.lineas !== undefined) payload.lineas = updates.lineas as unknown;
  if (updates.posiciones_contadas !== undefined) payload.posiciones_contadas = updates.posiciones_contadas;
  if (updates.closed_at !== undefined) payload.closed_at = updates.closed_at;
  if (updates.closed_by !== undefined) payload.closed_by = updates.closed_by;
  const { error } = await sb.from("conteos").update(payload).eq("id", id);
  if (error) { console.error("updateConteo error:", error); return false; }
  return true;
}

export async function deleteConteo(id: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("conteos").delete().eq("id", id);
  return !error;
}

// ==================== PEDIDOS FLEX (ML Integration) ====================

export interface DBPedidoFlex {
  id?: string;
  order_id: number;
  fecha_venta: string;
  fecha_armado: string;
  estado: "PENDIENTE" | "EN_PICKING" | "DESPACHADO";
  sku_venta: string;
  nombre_producto: string;
  cantidad: number;
  shipping_id: number;
  pack_id: number | null;
  buyer_nickname: string;
  raw_data: unknown;
  picking_session_id: string | null;
  etiqueta_url: string | null;
  created_at?: string;
}

/**
 * Fetch pedidos for a given date.
 * Shows: all pending/picking orders with handling_limit <= fecha (including overdue)
 *      + dispatched orders for that exact date.
 */
export async function fetchPedidosFlex(fecha: string): Promise<DBPedidoFlex[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("pedidos_flex").select("*")
    .or(`and(fecha_armado.lte.${fecha},estado.neq.DESPACHADO),and(fecha_armado.eq.${fecha},estado.eq.DESPACHADO)`)
    .order("fecha_armado", { ascending: true })
    .order("fecha_venta", { ascending: true });
  return (data || []) as DBPedidoFlex[];
}

export async function fetchAllPedidosFlex(limit = 100): Promise<DBPedidoFlex[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("pedidos_flex").select("*")
    .order("fecha_venta", { ascending: false })
    .limit(limit);
  return (data || []) as DBPedidoFlex[];
}

export async function fetchPedidosFlexByEstado(fecha: string, estado: string): Promise<DBPedidoFlex[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("pedidos_flex").select("*")
    .eq("fecha_armado", fecha)
    .eq("estado", estado)
    .order("fecha_venta", { ascending: true });
  return (data || []) as DBPedidoFlex[];
}

export async function updatePedidosFlex(ids: string[], updates: Partial<DBPedidoFlex>): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("pedidos_flex").update(updates).in("id", ids);
  return !error;
}

export async function updatePedidosFlexByPickingSession(sessionId: string, estado: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("pedidos_flex").update({ estado }).eq("picking_session_id", sessionId);
  return !error;
}

// ==================== ML SHIPMENTS (new shipment-centric model) ====================

export interface DBMLShipment {
  shipment_id: number;
  order_ids: number[];
  status: string;
  substatus: string | null;
  logistic_type: string;
  handling_limit: string | null; // ISO timestamp
  buffering_date: string | null;
  delivery_date: string | null;
  origin_type: string | null;
  store_id: number | null;       // origin shipping_address.id — bodega/tienda
  receiver_name: string | null;
  destination_city: string | null;
  updated_at: string;
}

export interface DBMLShipmentItem {
  id?: number;
  shipment_id: number;
  order_id: number;
  item_id: string;
  title: string;
  seller_sku: string;
  variation_id: number | null;
  quantity: number;
}

export interface ShipmentWithItems extends DBMLShipment {
  items: DBMLShipmentItem[];
}

/**
 * Fetch shipments the operator needs to prepare.
 * Query: status = ready_to_ship AND substatus IN (ready_to_print, printed)
 *        AND logistic_type != fulfillment.
 * No date filter — UI groups by day (atrasados, hoy, mañana, etc.).
 * Ordered by handling_limit ASC (overdue first).
 */
export async function fetchShipmentsToArm(_fecha: string, storeId?: number | null): Promise<ShipmentWithItems[]> {
  const sb = getSupabase(); if (!sb) return [];

  let query = sb.from("ml_shipments").select("*")
    .neq("logistic_type", "fulfillment")
    .eq("status", "ready_to_ship")
    .in("substatus", ["ready_to_print", "printed"])
    .order("handling_limit", { ascending: true });

  if (storeId) {
    query = query.eq("store_id", storeId);
  }

  const { data: shipments } = await query;

  if (!shipments || shipments.length === 0) return [];

  // Fetch all items for these shipments
  const shipmentIds = (shipments as DBMLShipment[]).map(s => s.shipment_id);
  const { data: items } = await sb.from("ml_shipment_items").select("*")
    .in("shipment_id", shipmentIds);

  const itemsByShipment = new Map<number, DBMLShipmentItem[]>();
  for (const item of (items || []) as DBMLShipmentItem[]) {
    const arr = itemsByShipment.get(item.shipment_id) || [];
    arr.push(item);
    itemsByShipment.set(item.shipment_id, arr);
  }

  return (shipments as DBMLShipment[]).map(s => ({
    ...s,
    items: itemsByShipment.get(s.shipment_id) || [],
  }));
}

/**
 * Fetch all shipments (no date filter, for "Ver todos" mode).
 */
export async function fetchAllShipments(limit = 100, storeId?: number | null): Promise<ShipmentWithItems[]> {
  const sb = getSupabase(); if (!sb) return [];

  let query = sb.from("ml_shipments").select("*")
    .neq("logistic_type", "fulfillment")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (storeId) {
    query = query.eq("store_id", storeId);
  }

  const { data: shipments } = await query;

  if (!shipments || shipments.length === 0) return [];

  const shipmentIds = (shipments as DBMLShipment[]).map(s => s.shipment_id);
  const { data: items } = await sb.from("ml_shipment_items").select("*")
    .in("shipment_id", shipmentIds);

  const itemsByShipment = new Map<number, DBMLShipmentItem[]>();
  for (const item of (items || []) as DBMLShipmentItem[]) {
    const arr = itemsByShipment.get(item.shipment_id) || [];
    arr.push(item);
    itemsByShipment.set(item.shipment_id, arr);
  }

  return (shipments as DBMLShipment[]).map(s => ({
    ...s,
    items: itemsByShipment.get(s.shipment_id) || [],
  }));
}

/**
 * Fetch distinct store_ids from ml_shipments for the store filter dropdown.
 */
export async function fetchStoreIds(): Promise<{ store_id: number; count: number }[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("ml_shipments").select("store_id")
    .neq("logistic_type", "fulfillment")
    .not("store_id", "is", null);
  if (!data) return [];
  const counts = new Map<number, number>();
  for (const row of data as { store_id: number }[]) {
    counts.set(row.store_id, (counts.get(row.store_id) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([store_id, count]) => ({ store_id, count }));
}

// ==================== ML CONFIG (client-side read for admin UI) ====================

export interface DBMLConfig {
  id: string;
  seller_id: string;
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  webhook_secret: string | null;
  hora_corte_lv: number;
  hora_corte_sab: number;
  updated_at: string;
}

export async function fetchMLConfig(): Promise<DBMLConfig | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.from("ml_config").select("*").eq("id", "main").single();
  return data as DBMLConfig | null;
}

export async function upsertMLConfig(config: Partial<DBMLConfig>): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("ml_config").upsert(
    { id: "main", ...config, updated_at: new Date().toISOString() },
    { onConflict: "id" }
  );
  return !error;
}

// ==================== ML ITEMS MAP (Stock sync Phase 2) ====================

export interface DBMLItemMap {
  id?: string;
  sku: string;
  item_id: string;
  variation_id: number | null;
  activo: boolean;
  ultimo_sync: string | null;
  ultimo_stock_enviado: number | null;
}

export async function fetchMLItemsMap(): Promise<DBMLItemMap[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("ml_items_map").select("*").eq("activo", true).order("sku");
  return (data || []) as DBMLItemMap[];
}

export async function upsertMLItemMap(item: DBMLItemMap): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return false;
  const { error } = await sb.from("ml_items_map").upsert(item, { onConflict: "sku,item_id" });
  return !error;
}

// ==================== STOCK SYNC QUEUE ====================

export async function getStockSyncQueue(): Promise<string[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("stock_sync_queue").select("sku").order("created_at");
  return (data || []).map((d: { sku: string }) => d.sku);
}

export async function addToStockSyncQueue(skus: string[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  const rows = skus.map(sku => ({ sku, created_at: new Date().toISOString() }));
  await sb.from("stock_sync_queue").upsert(rows, { onConflict: "sku" });
}

export async function clearStockSyncQueue(skus: string[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("stock_sync_queue").delete().in("sku", skus);
}

