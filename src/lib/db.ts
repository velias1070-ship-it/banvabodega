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
  inner_pack?: number | null;
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
  sku_venta: string | null;
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
  costo_neto?: number;
  iva?: number;
  costo_bruto?: number;
  factura_original?: FacturaOriginal | null;
}

export interface FacturaOriginal {
  lineas: { sku: string; nombre: string; cantidad: number; costo_unitario: number }[];
  neto: number;
  iva: number;
  bruto: number;
}

export interface DBRecepcionAjuste {
  id?: string;
  recepcion_id: string;
  tipo: string;
  sku_original?: string | null;
  sku_nuevo?: string | null;
  campo?: string | null;
  valor_anterior?: string | null;
  valor_nuevo?: string | null;
  motivo?: string | null;
  admin?: string | null;
  created_at?: string;
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
  bloqueado_por?: string | null;
  bloqueado_hasta?: string | null;
  etiqueta_impresa?: boolean;
  tiene_variantes?: boolean;
  sku_venta?: string;
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

export interface DBDiscrepanciaCosto {
  id?: string;
  recepcion_id: string;
  linea_id: string;
  sku: string;
  costo_diccionario: number;
  costo_factura: number;
  diferencia: number;
  porcentaje: number;
  estado: "PENDIENTE" | "APROBADO" | "RECHAZADO";
  resuelto_por?: string;
  resuelto_at?: string;
  notas?: string;
  created_at?: string;
}

export type DiscrepanciaQtyTipo = "FALTANTE" | "SOBRANTE" | "SKU_ERRONEO" | "NO_EN_FACTURA";
export type DiscrepanciaQtyEstado = "PENDIENTE" | "ACEPTADO" | "RECLAMADO" | "NOTA_CREDITO" | "DEVOLUCION" | "SUSTITUCION";

export interface DBDiscrepanciaQty {
  id?: string;
  recepcion_id: string;
  linea_id?: string;
  sku: string;
  tipo: DiscrepanciaQtyTipo;
  qty_factura: number;
  qty_recibida: number;
  diferencia: number;
  estado: DiscrepanciaQtyEstado;
  resuelto_por?: string;
  resuelto_at?: string;
  notas?: string;
  created_at?: string;
}

// ==================== PRODUCTOS ====================

// Strip auto-generated fields (created_at, updated_at) that Supabase rejects on upsert
function cleanProduct(p: DBProduct): DBProduct {
  return {
    sku: p.sku, sku_venta: p.sku_venta, codigo_ml: p.codigo_ml,
    nombre: p.nombre, categoria: p.categoria, proveedor: p.proveedor,
    costo: p.costo, precio: p.precio, reorder: p.reorder,
    requiere_etiqueta: p.requiere_etiqueta, tamano: p.tamano, color: p.color,
    inner_pack: p.inner_pack,
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

export async function updateStock(sku: string, posicion_id: string, delta: number, sku_venta?: string | null) {
  const sb = getSupabase(); if (!sb) return;
  const { error } = await sb.rpc("update_stock", { p_sku: sku, p_posicion: posicion_id, p_delta: delta, p_sku_venta: sku_venta ?? null });
  if (error) throw new Error(`updateStock failed for ${sku}: ${error.message}`);
}

export async function setStock(sku: string, posicion_id: string, cantidad: number, sku_venta?: string | null) {
  const sb = getSupabase(); if (!sb) return;
  const sv = sku_venta ?? null;
  if (cantidad <= 0) {
    let q = sb.from("stock").delete().eq("sku", sku).eq("posicion_id", posicion_id);
    if (sv) q = q.eq("sku_venta", sv); else q = q.is("sku_venta", null);
    await q;
  } else {
    await sb.from("stock").upsert(
      { sku, sku_venta: sv, posicion_id, cantidad, updated_at: new Date().toISOString() },
      { onConflict: "sku,sku_venta_key,posicion_id" }
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

export async function fetchAllMovimientos(): Promise<DBMovimiento[]> {
  const sb = getSupabase(); if (!sb) return [];
  const all: DBMovimiento[] = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data } = await sb.from("movimientos").select("*").order("created_at", { ascending: true }).range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export async function fetchMovimientosBySku(sku: string): Promise<DBMovimiento[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("movimientos").select("*").eq("sku", sku).order("created_at", { ascending: false });
  return data || [];
}

export async function fetchMovimientosByRecepcion(recepcionId: string): Promise<DBMovimiento[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("movimientos").select("*").eq("recepcion_id", recepcionId);
  return data || [];
}

export async function insertMovimiento(m: Omit<DBMovimiento, "id" | "created_at">) {
  const sb = getSupabase(); if (!sb) return;
  const { error } = await sb.from("movimientos").insert(m);
  if (error) throw new Error(`insertMovimiento failed for ${m.sku}: ${error.message}`);
}

export async function updateMovimiento(id: string, fields: Partial<DBMovimiento>) {
  const sb = getSupabase(); if (!sb) return;
  const { error } = await sb.from("movimientos").update(fields).eq("id", id);
  if (error) throw new Error(`updateMovimiento failed: ${error.message}`);
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

// ==================== DISCREPANCIAS DE COSTO ====================
export async function fetchDiscrepancias(recepcionId: string): Promise<DBDiscrepanciaCosto[]> {
  const sb = getSupabase(); if (!sb) return [];
  try {
    const { data } = await sb.from("discrepancias_costo").select("*")
      .eq("recepcion_id", recepcionId).order("created_at");
    return data || [];
  } catch { return []; }
}

export async function insertDiscrepancias(discs: Omit<DBDiscrepanciaCosto, "id" | "created_at">[]) {
  const sb = getSupabase(); if (!sb) return;
  if (discs.length === 0) return;
  try {
    const { error } = await sb.from("discrepancias_costo").insert(discs);
    if (error) console.error("insertDiscrepancias error:", error.message, discs);
  } catch (e) { console.error("insertDiscrepancias exception:", e); }
}

export async function updateDiscrepancia(id: string, fields: Partial<DBDiscrepanciaCosto>) {
  const sb = getSupabase(); if (!sb) return;
  try {
    const { error } = await sb.from("discrepancias_costo").update(fields).eq("id", id);
    if (error) console.error("updateDiscrepancia error:", error.message, { id, fields });
  } catch (e) { console.error("updateDiscrepancia exception:", e); }
}

export async function deleteDiscrepanciasPendientes(recepcionId: string) {
  const sb = getSupabase(); if (!sb) return;
  try {
    const { error } = await sb.from("discrepancias_costo").delete()
      .eq("recepcion_id", recepcionId).eq("estado", "PENDIENTE");
    if (error) console.error("deleteDiscrepanciasPendientes error:", error.message);
  } catch (e) { console.error("deleteDiscrepanciasPendientes exception:", e); }
}

export async function updateProductoCosto(sku: string, nuevoCosto: number) {
  const sb = getSupabase(); if (!sb) return;
  const { error } = await sb.from("productos").update({ costo: nuevoCosto }).eq("sku", sku);
  if (error) console.error("updateProductoCosto error:", error.message, { sku, nuevoCosto });
}

// ==================== DISCREPANCIAS DE CANTIDAD ====================

export async function fetchDiscrepanciasQty(recepcionId: string): Promise<DBDiscrepanciaQty[]> {
  const sb = getSupabase(); if (!sb) return [];
  try {
    const { data } = await sb.from("discrepancias_qty").select("*")
      .eq("recepcion_id", recepcionId).order("created_at");
    return data || [];
  } catch { return []; }
}

export async function insertDiscrepanciasQty(discs: Omit<DBDiscrepanciaQty, "id" | "created_at">[]) {
  const sb = getSupabase(); if (!sb) return;
  if (discs.length === 0) return;
  try {
    const { error } = await sb.from("discrepancias_qty").insert(discs);
    if (error) console.error("insertDiscrepanciasQty error:", error.message, discs);
  } catch (e) { console.error("insertDiscrepanciasQty exception:", e); }
}

export async function updateDiscrepanciaQty(id: string, fields: Partial<DBDiscrepanciaQty>) {
  const sb = getSupabase(); if (!sb) return;
  try {
    const { error } = await sb.from("discrepancias_qty").update(fields).eq("id", id);
    if (error) console.error("updateDiscrepanciaQty error:", error.message, { id, fields });
  } catch (e) { console.error("updateDiscrepanciaQty exception:", e); }
}

export async function deleteDiscrepanciasQtyPendientes(recepcionId: string) {
  const sb = getSupabase(); if (!sb) return;
  try {
    const { error } = await sb.from("discrepancias_qty").delete()
      .eq("recepcion_id", recepcionId).eq("estado", "PENDIENTE");
    if (error) console.error("deleteDiscrepanciasQtyPendientes error:", error.message);
  } catch (e) { console.error("deleteDiscrepanciasQtyPendientes exception:", e); }
}

// Fetch ALL lines from multiple receptions at once
export async function fetchLineasDeRecepciones(recIds: string[]): Promise<DBRecepcionLinea[]> {
  const sb = getSupabase(); if (!sb) return [];
  if (recIds.length === 0) return [];
  const { data } = await sb.from("recepcion_lineas").select("*")
    .in("recepcion_id", recIds).order("sku");
  return data || [];
}

// Try to lock a line for an operator — atomic via PostgreSQL RPC (SELECT FOR UPDATE)
// Returns true if locked successfully, false if someone else holds the lock
export async function bloquearLinea(lineaId: string, operario: string): Promise<boolean> {
  const sb = getSupabase(); if (!sb) return true;
  try {
    const { data, error } = await sb.rpc("bloquear_linea", {
      p_linea_id: lineaId,
      p_operario: operario,
      p_minutos: 15,
    });
    if (error) {
      // RPC doesn't exist yet (v6 not deployed) — fallback to old behavior
      console.warn("bloquear_linea RPC not available, falling back", error.message);
      return true;
    }
    return data === true;
  } catch { return true; }
}

// Renew an existing lock (extend 15 min)
export async function renovarBloqueo(lineaId: string, operario: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  try {
    const hasta = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await sb.from("recepcion_lineas")
      .update({ bloqueado_hasta: hasta })
      .eq("id", lineaId).eq("bloqueado_por", operario);
  } catch {}
}

// Release a lock — atomic via PostgreSQL RPC
export async function desbloquearLinea(lineaId: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  try {
    const { error } = await sb.rpc("desbloquear_linea", { p_linea_id: lineaId });
    if (error) {
      // Fallback if RPC not deployed yet
      await sb.from("recepcion_lineas")
        .update({ bloqueado_por: null, bloqueado_hasta: null })
        .eq("id", lineaId);
    }
  } catch {}
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
        // Use unit cost (unidades=1 row). If first row is a pack, cost will be corrected below.
        productMap.set(row.skuOrigen, {
          sku: row.skuOrigen,
          sku_venta: row.skuVenta, // will be overwritten below with all ventas
          codigo_ml: row.codigoMl, // will be overwritten below with all codes
          nombre: row.nombreOrigen,
          categoria: row.categoria,
          proveedor: row.proveedor,
          costo: row.unidades === 1 ? row.costo : (row.unidades > 0 ? Math.round(row.costo / row.unidades) : row.costo),
          precio: 0,
          reorder: 20,
          requiere_etiqueta: !!row.codigoMl,
          tamano: row.tamano,
          color: row.color,
        });
      } else if (row.unidades === 1) {
        // If we already created the product from a pack row, override with the unit cost
        productMap.get(row.skuOrigen)!.costo = row.costo;
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

export type PickingTipo = "flex" | "envio_full" | "reposicion";

export interface DBPickingSession {
  id?: string;
  fecha: string;
  estado: string;
  tipo?: PickingTipo;
  titulo?: string;
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

// Legacy type — only used for migrating old envio_full sessions
export interface PickingLineaFullLegacy {
  id: string;
  skuVenta: string;
  skuOrigen: string;
  tipo: "simple" | "pack" | "combo";
  unidadesFisicas: number;
  unidadesVenta: number;
  unidadesPorPack: number;
  posicion: string;
  posLabel: string;
  posicionOrden: number;
  instruccionArmado: string;
  estado: "PENDIENTE" | "PICKEADO";
  estadoArmado: "PENDIENTE" | "COMPLETADO";
  pickedAt: string | null;
  operario: string | null;
  stockDisponible: number;
  codigoMl: string;
  nombre: string;
}

export interface PickingLinea {
  id: string;
  skuVenta: string;
  qtyPedida: number;
  estado: "PENDIENTE" | "PICKEADO";
  componentes: PickingComponente[];
  // Campos adicionales para envio_full (opcionales, no rompen Flex)
  skuOrigen?: string;
  tipoFull?: "simple" | "pack" | "combo";
  qtyFisica?: number;
  qtyVenta?: number;
  unidadesPorPack?: number;
  posicionOrden?: number;
  instruccionArmado?: string | null;
  estadoArmado?: "PENDIENTE" | "COMPLETADO" | null;
  // Legacy — solo para migración de sesiones viejas
  lineasFull?: PickingLineaFullLegacy[];
}

export async function createPickingSession(session: Omit<DBPickingSession, "id" | "created_at">): Promise<string | null> {
  const sb = getSupabase(); if (!sb) return null;
  const payload: Record<string, unknown> = {
    fecha: session.fecha,
    estado: session.estado,
    lineas: session.lineas as unknown,
  };
  if (session.tipo) payload.tipo = session.tipo;
  if (session.titulo) payload.titulo = session.titulo;
  const { data, error } = await sb.from("picking_sessions").insert(payload).select("id").single();
  if (error) { console.error("createPickingSession error:", error); return null; }
  return data?.id || null;
}

/**
 * Migra sesiones envio_full con estructura legacy (una línea con lineasFull[])
 * al nuevo formato plano (múltiples PickingLinea con componentes[]).
 * Actualiza en DB si detecta formato viejo.
 */
function migrateFullSessionIfNeeded(session: DBPickingSession): DBPickingSession {
  if (session.tipo !== "envio_full") return session;
  // Detectar formato viejo: una sola línea con lineasFull
  if (session.lineas.length === 1 && session.lineas[0]?.lineasFull && session.lineas[0].lineasFull.length > 0) {
    const oldLineas = session.lineas[0].lineasFull;
    const newLineas: PickingLinea[] = oldLineas.map(lf => ({
      id: lf.id,
      skuVenta: lf.skuVenta,
      qtyPedida: lf.unidadesFisicas,
      estado: lf.estado,
      componentes: [{
        skuOrigen: lf.skuOrigen,
        codigoMl: lf.codigoMl || "",
        nombre: lf.nombre,
        unidades: lf.unidadesFisicas,
        posicion: lf.posicion,
        posLabel: lf.posLabel,
        stockDisponible: lf.stockDisponible,
        estado: lf.estado,
        pickedAt: lf.pickedAt,
        operario: lf.operario,
      }],
      skuOrigen: lf.skuOrigen,
      tipoFull: lf.tipo,
      qtyFisica: lf.unidadesFisicas,
      qtyVenta: lf.unidadesVenta,
      unidadesPorPack: lf.unidadesPorPack,
      posicionOrden: lf.posicionOrden,
      instruccionArmado: lf.instruccionArmado || null,
      estadoArmado: lf.tipo === "simple" ? null : lf.estadoArmado,
    }));
    session.lineas = newLineas;
    // Persist migrated structure in background (fire-and-forget)
    const sb = getSupabase();
    if (sb && session.id) {
      sb.from("picking_sessions").update({ lineas: newLineas as unknown }).eq("id", session.id).then(() => {
        console.log(`[Picking] Migrated legacy envio_full session ${session.id} to flat format`);
      });
    }
  }
  return session;
}

export async function getPickingSessionsByDate(fecha: string): Promise<DBPickingSession[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("picking_sessions").select("*").eq("fecha", fecha).order("created_at", { ascending: false });
  return (data || []).map(d => migrateFullSessionIfNeeded({ ...d, lineas: (d.lineas || []) as PickingLinea[], tipo: (d.tipo || "flex") as PickingTipo, titulo: d.titulo || undefined }));
}

export async function getActivePickingSessions(): Promise<DBPickingSession[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("picking_sessions").select("*").in("estado", ["ABIERTA", "EN_PROCESO"]).order("created_at", { ascending: false });
  return (data || []).map(d => migrateFullSessionIfNeeded({ ...d, lineas: (d.lineas || []) as PickingLinea[], tipo: (d.tipo || "flex") as PickingTipo, titulo: d.titulo || undefined }));
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
  is_flex: boolean;
  handling_limit: string | null; // ISO timestamp
  buffering_date: string | null;
  delivery_date: string | null;
  origin_type: string | null;
  store_id: number | null;       // origin shipping_address.id — bodega/tienda
  receiver_name: string | null;
  destination_city: string | null;
  is_fraud_risk: boolean;
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
 * Fetch ALL active shipments for the Flex dispatch view.
 * Includes: ready_to_ship (ready_to_print, printed), pending (buffered, ready_to_print),
 * and recently shipped (for reference). Excludes fulfillment.
 * Ordered by handling_limit ASC.
 */
export async function fetchActiveFlexShipments(storeId?: number | null): Promise<ShipmentWithItems[]> {
  const sb = getSupabase(); if (!sb) return [];

  // Fetch ready_to_ship + pending (not cancelled/delivered)
  let query = sb.from("ml_shipments").select("*")
    .neq("logistic_type", "fulfillment")
    .in("status", ["ready_to_ship", "pending"])
    .order("handling_limit", { ascending: true, nullsFirst: false });

  if (storeId) {
    query = query.eq("store_id", storeId);
  }

  const { data: shipments } = await query;
  if (!shipments || shipments.length === 0) return [];

  const shipmentIds = (shipments as DBMLShipment[]).map(s => s.shipment_id);
  // Fetch items in chunks (supabase IN limit)
  const allItems: DBMLShipmentItem[] = [];
  for (let i = 0; i < shipmentIds.length; i += 500) {
    const chunk = shipmentIds.slice(i, i + 500);
    const { data: items } = await sb.from("ml_shipment_items").select("*")
      .in("shipment_id", chunk);
    if (items) allItems.push(...(items as DBMLShipmentItem[]));
  }

  const itemsByShipment = new Map<number, DBMLShipmentItem[]>();
  for (const item of allItems) {
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

/** Construye mapeo seller_sku → SKU físico usando ml_shipment_items + ml_items_map */
export async function fetchSkuVentaToFisicoMap(): Promise<Record<string, string>> {
  const sb = getSupabase(); if (!sb) return {};
  // 1. Get item_id → physical sku from ml_items_map
  const { data: itemsMap } = await sb.from("ml_items_map").select("sku, item_id").eq("activo", true);
  if (!itemsMap || itemsMap.length === 0) return {};
  const itemToSku: Record<string, string> = {};
  for (const row of itemsMap) itemToSku[row.item_id] = row.sku;

  // 2. Get distinct seller_sku → item_id from ml_shipment_items
  const { data: shipItems } = await sb.from("ml_shipment_items").select("seller_sku, item_id");
  if (!shipItems || shipItems.length === 0) return {};

  const map: Record<string, string> = {};
  for (const si of shipItems) {
    const sellerSku = (si.seller_sku || "").trim();
    if (!sellerSku) continue;
    const fisico = itemToSku[si.item_id];
    if (!fisico || fisico === sellerSku) continue;
    // Guardar tanto el original como versiones upper/lower para match case-insensitive
    if (!map[sellerSku]) map[sellerSku] = fisico;
    const upper = sellerSku.toUpperCase();
    if (!map[upper]) map[upper] = fisico;
    const lower = sellerSku.toLowerCase();
    if (!map[lower]) map[lower] = fisico;
  }
  return map;
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

// ==================== CONCILIADOR — TIPOS ====================

export interface DBEmpresa {
  id?: string;
  rut: string;
  razon_social: string;
  created_at?: string;
}

export interface DBSyncLog {
  id?: string;
  empresa_id: string;
  periodo: string;
  tipo: "compras" | "ventas" | "mercadopago" | "banco_chile" | "santander_tc";
  registros: number;
  synced_at?: string;
}

export interface DBRcvCompra {
  id?: string;
  empresa_id: string;
  periodo: string;
  estado: string;
  tipo_doc: number;
  nro_doc: string | null;
  rut_proveedor: string | null;
  razon_social: string | null;
  fecha_docto: string | null;
  monto_exento: number;
  monto_neto: number;
  monto_iva: number;
  monto_total: number;
  fecha_recepcion: string | null;
  evento_receptor: string | null;
  created_at?: string;
}

export interface DBRcvVenta {
  id?: string;
  empresa_id: string;
  periodo: string;
  tipo_doc: string;
  nro: string | null;
  rut_emisor: string | null;
  folio: string | null;
  fecha_docto: string | null;
  monto_neto: number;
  monto_exento: number;
  monto_iva: number;
  monto_total: number;
  fecha_recepcion: string | null;
  evento_receptor: string | null;
  created_at?: string;
}

export interface DBMovimientoBanco {
  id?: string;
  empresa_id: string;
  banco: string;
  cuenta: string | null;
  fecha: string;
  descripcion: string | null;
  monto: number;
  saldo: number | null;
  referencia: string | null;
  origen: "csv" | "api" | "manual" | "scraper_bchile" | "scraper_santander";
  cuenta_bancaria_id?: string | null;
  estado_conciliacion?: string;
  categoria_cuenta_id?: string | null;
  referencia_unica?: string | null;
  created_at?: string;
}

export interface DBConciliacion {
  id?: string;
  empresa_id: string;
  movimiento_banco_id: string | null;
  rcv_compra_id: string | null;
  rcv_venta_id: string | null;
  confianza: number | null;
  estado: "pendiente" | "confirmado" | "rechazado";
  tipo_partida: string | null;
  metodo: string | null;
  notas: string | null;
  created_by: string | null;
  regla_id?: string | null;
  created_at?: string;
}

export interface DBAlerta {
  id?: string;
  empresa_id: string;
  tipo: string;
  titulo: string;
  descripcion: string | null;
  referencia_id: string | null;
  estado: "activa" | "vista" | "resuelta";
  prioridad: "alta" | "media" | "baja";
  created_at?: string;
}

export interface DBPeriodoConciliacion {
  id?: string;
  empresa_id: string;
  periodo: string;
  saldo_inicial_banco: number | null;
  saldo_final_banco: number | null;
  saldo_inicial_libro: number | null;
  saldo_final_libro: number | null;
  diferencia: number;
  estado: "abierto" | "en_proceso" | "cerrado";
  fecha_cierre: string | null;
  reporte_url: string | null;
  created_at?: string;
}

// ==================== FINANZAS v8 — INTERFACES NUEVAS ====================

export interface DBPlanCuentas {
  id?: string;
  codigo: string;
  nombre: string;
  tipo: "ingreso" | "costo" | "gasto_operacional" | "gasto_no_op";
  parent_id: string | null;
  nivel: number;
  es_hoja: boolean;
  activa: boolean;
  created_at?: string;
}

export interface DBReglaConciliacion {
  id?: string;
  nombre: string;
  activa: boolean;
  prioridad: number;
  condiciones: CondicionRegla[];
  accion_auto: boolean;
  confianza_minima: number;
  categoria_cuenta_id: string | null;
  stats_matches: number;
  created_at?: string;
}

// Estructura de cada condición dentro de una regla
export interface CondicionRegla {
  campo: "descripcion" | "monto" | "banco" | "referencia";
  operador: "contiene" | "no_contiene" | "igual" | "mayor_que" | "menor_que" | "entre";
  valor: string | number;
  valor2?: number; // Para operador "entre"
}

export interface DBConciliacionItem {
  id?: string;
  conciliacion_id: string;
  documento_tipo: "rcv_compra" | "rcv_venta" | "pasarela";
  documento_id: string;
  monto_aplicado: number;
  created_at?: string;
}

export interface DBPasarelaPago {
  id?: string;
  empresa_id: string;
  pasarela: string;
  fecha_operacion: string | null;
  fecha_liquidacion: string | null;
  referencia_externa: string | null;
  monto_bruto: number;
  comision: number;
  monto_neto: number;
  estado: string;
  orden_ml_id: string | null;
  conciliacion_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at?: string;
}

export interface DBCuentaBancaria {
  id?: string;
  empresa_id: string;
  banco: string;
  tipo_cuenta: string | null;
  numero_cuenta: string | null;
  alias: string | null;
  saldo_actual: number;
  moneda: string;
  activa: boolean;
  created_at?: string;
}

export interface DBPresupuesto {
  id?: string;
  empresa_id: string;
  anio: number;
  mes: number;
  categoria_cuenta_id: string;
  monto_presupuestado: number;
  created_at?: string;
}

export interface DBCobranzaAccion {
  id?: string;
  documento_id: string;
  tipo_accion: string;
  fecha: string;
  destinatario: string | null;
  contenido: string | null;
  resultado: string | null;
  proximo_seguimiento: string | null;
  created_at?: string;
}

// ==================== CONCILIADOR — EMPRESAS ====================

export async function fetchEmpresas(): Promise<DBEmpresa[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("empresas").select("*").order("razon_social");
  return (data || []) as DBEmpresa[];
}

export async function fetchEmpresaDefault(): Promise<DBEmpresa | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data, error } = await sb.from("empresas").select("*").limit(1);
  if (error) return null;
  return data && data.length > 0 ? (data[0] as DBEmpresa) : null;
}

// ==================== CONCILIADOR — SYNC LOG ====================

export async function fetchSyncLog(empresaId: string): Promise<DBSyncLog[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("sync_log").select("*").eq("empresa_id", empresaId).order("synced_at", { ascending: false });
  return (data || []) as DBSyncLog[];
}

// ==================== CONCILIADOR — RCV COMPRAS ====================

export async function fetchRcvCompras(empresaId: string, periodo?: string): Promise<DBRcvCompra[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("rcv_compras").select("*").eq("empresa_id", empresaId);
  if (periodo) q = q.eq("periodo", periodo);
  const { data } = await q.order("fecha_docto", { ascending: false });
  return (data || []) as DBRcvCompra[];
}

export async function upsertRcvCompras(items: DBRcvCompra[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < items.length; i += 500) {
    await sb.from("rcv_compras").upsert(items.slice(i, i + 500), { onConflict: "empresa_id,periodo,tipo_doc,nro_doc,rut_proveedor" });
  }
}

// ==================== CONCILIADOR — RCV VENTAS ====================

export async function fetchRcvVentas(empresaId: string, periodo?: string): Promise<DBRcvVenta[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("rcv_ventas").select("*").eq("empresa_id", empresaId);
  if (periodo) q = q.eq("periodo", periodo);
  const { data } = await q.order("fecha_docto", { ascending: false });
  return (data || []) as DBRcvVenta[];
}

export async function upsertRcvVentas(items: DBRcvVenta[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < items.length; i += 500) {
    await sb.from("rcv_ventas").upsert(items.slice(i, i + 500), { onConflict: "empresa_id,periodo,tipo_doc,folio" });
  }
}

// ==================== CONCILIADOR — MOVIMIENTOS BANCO ====================

export async function fetchMovimientosBanco(empresaId: string, opts?: { banco?: string; desde?: string; hasta?: string }): Promise<DBMovimientoBanco[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("movimientos_banco").select("*").eq("empresa_id", empresaId);
  if (opts?.banco) q = q.eq("banco", opts.banco);
  if (opts?.desde) q = q.gte("fecha", opts.desde);
  if (opts?.hasta) q = q.lte("fecha", opts.hasta);
  const { data } = await q.order("fecha", { ascending: false });
  return (data || []) as DBMovimientoBanco[];
}

export async function insertMovimientosBanco(items: DBMovimientoBanco[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < items.length; i += 500) {
    await sb.from("movimientos_banco").insert(items.slice(i, i + 500));
  }
}

export async function deleteMovimientosBancoByIds(ids: string[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("movimientos_banco").delete().in("id", ids);
}

// ==================== CONCILIADOR — CONCILIACIONES ====================

export async function fetchConciliaciones(empresaId: string, periodo?: string): Promise<DBConciliacion[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("conciliaciones").select("*").eq("empresa_id", empresaId);
  if (periodo) {
    // Filtrar por movimientos del periodo (via join o filtro post-fetch)
    // Por ahora retorna todas y se filtra en el frontend
  }
  const { data } = await q.order("created_at", { ascending: false });
  return (data || []) as DBConciliacion[];
}

export async function upsertConciliacion(c: DBConciliacion): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  if (c.id) {
    await sb.from("conciliaciones").update(c).eq("id", c.id);
  } else {
    await sb.from("conciliaciones").insert(c);
  }
}

export async function updateConciliacion(id: string, fields: Partial<DBConciliacion>): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("conciliaciones").update(fields).eq("id", id);
}

// ==================== CONCILIADOR — ALERTAS ====================

export async function fetchAlertas(empresaId: string, estado?: string): Promise<DBAlerta[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("alertas").select("*").eq("empresa_id", empresaId);
  if (estado) q = q.eq("estado", estado);
  const { data } = await q.order("created_at", { ascending: false });
  return (data || []) as DBAlerta[];
}

export async function insertAlerta(a: DBAlerta): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("alertas").insert(a);
}

export async function updateAlerta(id: string, fields: Partial<DBAlerta>): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("alertas").update(fields).eq("id", id);
}

// ==================== CONCILIADOR — PERÍODOS ====================

export async function fetchPeriodoConciliacion(empresaId: string, periodo: string): Promise<DBPeriodoConciliacion | null> {
  const sb = getSupabase(); if (!sb) return null;
  const { data } = await sb.from("periodos_conciliacion").select("*").eq("empresa_id", empresaId).eq("periodo", periodo).single();
  return (data as DBPeriodoConciliacion) || null;
}

export async function upsertPeriodoConciliacion(p: DBPeriodoConciliacion): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("periodos_conciliacion").upsert(p, { onConflict: "empresa_id,periodo" });
}

// ==================== FINANZAS v8 — PLAN DE CUENTAS ====================

// Obtener todo el plan de cuentas (árbol completo)
export async function fetchPlanCuentas(): Promise<DBPlanCuentas[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("plan_cuentas").select("*").order("codigo");
  return (data || []) as DBPlanCuentas[];
}

// Solo cuentas hoja (para asignar a transacciones)
export async function fetchPlanCuentasHojas(): Promise<DBPlanCuentas[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("plan_cuentas").select("*").eq("es_hoja", true).eq("activa", true).order("codigo");
  return (data || []) as DBPlanCuentas[];
}

export async function upsertPlanCuenta(c: DBPlanCuentas): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  if (c.id) {
    await sb.from("plan_cuentas").update(c).eq("id", c.id);
  } else {
    await sb.from("plan_cuentas").insert(c);
  }
}

export async function updatePlanCuenta(id: string, fields: Partial<DBPlanCuentas>): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("plan_cuentas").update(fields).eq("id", id);
}

// ==================== FINANZAS v8 — REGLAS CONCILIACIÓN ====================

export async function fetchReglasConciliacion(): Promise<DBReglaConciliacion[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("reglas_conciliacion").select("*").order("prioridad");
  return (data || []) as DBReglaConciliacion[];
}

export async function upsertRegla(r: DBReglaConciliacion): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  if (r.id) {
    await sb.from("reglas_conciliacion").update(r).eq("id", r.id);
  } else {
    await sb.from("reglas_conciliacion").insert(r);
  }
}

export async function deleteRegla(id: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("reglas_conciliacion").delete().eq("id", id);
}

// Incrementar contador de matches de una regla
export async function incrementReglaMatches(id: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  // Fetch actual, incrementar, update
  const { data } = await sb.from("reglas_conciliacion").select("stats_matches").eq("id", id).limit(1);
  if (data && data.length > 0) {
    const current = (data[0] as { stats_matches: number }).stats_matches || 0;
    await sb.from("reglas_conciliacion").update({ stats_matches: current + 1 }).eq("id", id);
  }
}

// ==================== FINANZAS v8 — CONCILIACIÓN ITEMS ====================

export async function fetchConciliacionItems(conciliacionId: string): Promise<DBConciliacionItem[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("conciliacion_items").select("*").eq("conciliacion_id", conciliacionId);
  return (data || []) as DBConciliacionItem[];
}

export async function insertConciliacionItems(items: DBConciliacionItem[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("conciliacion_items").insert(items);
}

// ==================== FINANZAS v8 — PASARELAS PAGO ====================

export async function fetchPasarelasPago(empresaId: string, opts?: { periodo?: string }): Promise<DBPasarelaPago[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("pasarelas_pago").select("*").eq("empresa_id", empresaId);
  if (opts?.periodo) {
    // Filtrar por año-mes de fecha_operacion
    const y = opts.periodo.slice(0, 4);
    const m = opts.periodo.slice(4, 6);
    q = q.gte("fecha_operacion", `${y}-${m}-01`).lte("fecha_operacion", `${y}-${m}-31`);
  }
  const { data } = await q.order("fecha_operacion", { ascending: false });
  return (data || []) as DBPasarelaPago[];
}

// ==================== FINANZAS v8 — CUENTAS BANCARIAS ====================

export async function fetchCuentasBancarias(empresaId: string): Promise<DBCuentaBancaria[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("cuentas_bancarias").select("*").eq("empresa_id", empresaId).order("banco");
  return (data || []) as DBCuentaBancaria[];
}

export async function upsertCuentaBancaria(c: DBCuentaBancaria): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  if (c.id) {
    await sb.from("cuentas_bancarias").update(c).eq("id", c.id);
  } else {
    await sb.from("cuentas_bancarias").insert(c);
  }
}

// ==================== FINANZAS v8 — PRESUPUESTO ====================

export async function fetchPresupuesto(empresaId: string, anio: number): Promise<DBPresupuesto[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("presupuesto").select("*").eq("empresa_id", empresaId).eq("anio", anio);
  return (data || []) as DBPresupuesto[];
}

export async function upsertPresupuesto(items: DBPresupuesto[]): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  for (let i = 0; i < items.length; i += 500) {
    await sb.from("presupuesto").upsert(items.slice(i, i + 500), { onConflict: "empresa_id,anio,mes,categoria_cuenta_id" });
  }
}

// ==================== FINANZAS v8 — COBRANZA ====================

export async function fetchCobranzaAcciones(documentoId: string): Promise<DBCobranzaAccion[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("cobranza_acciones").select("*").eq("documento_id", documentoId).order("fecha", { ascending: false });
  return (data || []) as DBCobranzaAccion[];
}

export async function insertCobranzaAccion(a: DBCobranzaAccion): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("cobranza_acciones").insert(a);
}

// ==================== FINANZAS v8 — ACTUALIZAR ESTADO CONCILIACIÓN MOV BANCO ====================

export async function updateMovimientoBanco(id: string, fields: Partial<DBMovimientoBanco>): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("movimientos_banco").update(fields).eq("id", id);
}

// Actualizar categoría de un movimiento banco
export async function categorizarMovimiento(id: string, categoriaId: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("movimientos_banco").update({ categoria_cuenta_id: categoriaId }).eq("id", id);
}

// Actualizar estado_pago de compra o venta
export async function updateEstadoPagoCompra(id: string, estado: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("rcv_compras").update({ estado_pago: estado }).eq("id", id);
}

export async function updateEstadoPagoVenta(id: string, estado: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("rcv_ventas").update({ estado_pago: estado }).eq("id", id);
}

// ==================== MP LIQUIDACIÓN DETALLE ====================

export interface DBMpLiquidacionDetalle {
  id?: string;
  empresa_id: string;
  factura_folio: string;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  fecha_operacion: string | null;
  tipo_documento: string | null;
  dte: number | null;
  folio_dte: string | null;
  venta_id: string | null;
  descripcion: string | null;
  cantidad: number;
  monto: number | null;
  iva: number | null;
  sku: string | null;
  codigo_producto: string | null;
  folio_asociado: string | null;
  tipo_devolucion: string | null;
  created_at?: string;
}

export async function fetchMpLiquidacion(empresaId: string, folio?: string): Promise<DBMpLiquidacionDetalle[]> {
  const sb = getSupabase(); if (!sb) return [];
  let q = sb.from("mp_liquidacion_detalle").select("*").eq("empresa_id", empresaId);
  if (folio) q = q.eq("factura_folio", folio);
  const { data } = await q.order("fecha_operacion", { ascending: false });
  return (data || []) as DBMpLiquidacionDetalle[];
}

export async function fetchMpLiquidacionFolios(empresaId: string): Promise<string[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("mp_liquidacion_detalle")
    .select("factura_folio")
    .eq("empresa_id", empresaId)
    .order("factura_folio", { ascending: false });
  // Extraer folios únicos
  const folios = new Set<string>();
  (data || []).forEach((r: { factura_folio: string }) => folios.add(r.factura_folio));
  return Array.from(folios);
}

export async function insertMpLiquidacion(items: DBMpLiquidacionDetalle[]): Promise<number> {
  const sb = getSupabase(); if (!sb) return 0;
  let total = 0;
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await sb.from("mp_liquidacion_detalle").insert(items.slice(i, i + 500));
    if (error) {
      console.error("Error insert mp_liquidacion_detalle:", error.message);
    } else {
      total += Math.min(500, items.length - i);
    }
  }
  return total;
}

export async function deleteMpLiquidacionByFolio(empresaId: string, folio: string): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("mp_liquidacion_detalle").delete().eq("empresa_id", empresaId).eq("factura_folio", folio);
}

// ==================== FEEDBACK AGENTES ====================

export interface DBFeedbackAgente {
  id?: string;
  empresa_id?: string;
  agente: string;
  accion_sugerida: Record<string, unknown> | null;
  accion_correcta: Record<string, unknown> | null;
  contexto: Record<string, unknown> | null;
  created_at?: string;
}

// Obtener feedback de un agente específico (para aprendizaje)
export async function fetchFeedbackByAgente(agente: string, limit: number = 50): Promise<DBFeedbackAgente[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("feedback_agentes").select("*")
    .eq("agente", agente)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []) as DBFeedbackAgente[];
}

// Insertar feedback de acción del usuario
export async function insertFeedback(f: DBFeedbackAgente): Promise<void> {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("feedback_agentes").insert(f);
}

// ==================== REPORTES — FACTURAS PENDIENTES ====================

// Facturas de venta pendientes de cobro (para flujo proyectado)
export async function fetchRcvVentasPendientes(empresaId: string): Promise<DBRcvVenta[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("rcv_ventas").select("*")
    .eq("empresa_id", empresaId)
    .or("estado_pago.eq.pendiente,estado_pago.is.null")
    .order("fecha_docto", { ascending: false });
  return (data || []) as DBRcvVenta[];
}

// Facturas de compra pendientes de pago (para flujo proyectado)
export async function fetchRcvComprasPendientes(empresaId: string): Promise<DBRcvCompra[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("rcv_compras").select("*")
    .eq("empresa_id", empresaId)
    .or("estado_pago.eq.pendiente,estado_pago.is.null")
    .order("fecha_docto", { ascending: false });
  return (data || []) as DBRcvCompra[];
}

// ==================== RECEPCION AJUSTES ====================
export async function fetchRecepcionAjustes(recepcionId: string): Promise<DBRecepcionAjuste[]> {
  const sb = getSupabase(); if (!sb) return [];
  const { data } = await sb.from("recepcion_ajustes").select("*")
    .eq("recepcion_id", recepcionId).order("created_at", { ascending: false });
  return data || [];
}

export async function insertRecepcionAjuste(ajuste: Omit<DBRecepcionAjuste, "id" | "created_at">) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepcion_ajustes").insert(ajuste);
}

export async function updateRecepcionFacturaOriginal(id: string, facturaOriginal: FacturaOriginal) {
  const sb = getSupabase(); if (!sb) return;
  await sb.from("recepciones").update({ factura_original: facturaOriginal as unknown as Record<string, unknown> }).eq("id", id);
}

