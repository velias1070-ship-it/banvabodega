/**
 * Queries server-side a Supabase para el motor de inteligencia.
 * Reemplaza las funciones client-side de store.ts (skuTotal, getComponentesPorSkuVenta, etc.)
 * Solo se usa desde API routes (server-side).
 */
import { getServerSupabase } from "./supabase-server";

/* ───── Tipos de respuesta ───── */

export interface ProductoRow {
  sku: string;
  sku_venta: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  costo: number;
  precio: number;
  inner_pack: number | null;
  lead_time_dias: number;
  moq: number;
  estado_sku: string;
}

export interface ComposicionRow {
  sku_venta: string;
  sku_origen: string;
  unidades: number;
}

export interface OrdenHistoryRow {
  sku_venta: string;
  cantidad: number;
  canal: string;       // "Full" o "Flex"
  fecha: string;        // ISO date
  subtotal: number;
  comision_total: number;
  costo_envio: number;
  ingreso_envio: number;
  total: number;
}

export interface StockRow {
  sku: string;
  posicion_id: string;
  cantidad: number;
}

export interface ConteoRow {
  id: string;
  tipo: string;
  estado: string;
  lineas: unknown[];
  created_at: string;
}

export interface MovimientoRow {
  sku: string;
  tipo: string;
  razon: string;
  cantidad: number;
  created_at: string;
}

export interface EventoDemandaRow {
  id: string;
  nombre: string;
  fecha_inicio: string;
  fecha_fin: string;
  fecha_prep_desde: string;
  multiplicador: number;
  categorias: string[];
  activo: boolean;
}

export interface StockFullCacheRow {
  sku_venta: string;
  cantidad: number;
}

export interface StockSnapshotRow {
  fecha: string;
  sku_origen: string;
  en_quiebre_full: boolean;
}

export interface OrdenCompraLineaRow {
  orden_id: string;
  sku_origen: string;
  cantidad_pedida: number;
  cantidad_recibida: number;
  estado: string;
}

/* ───── Queries ───── */

/** Stock agrupado por SKU (equivale a skuTotal server-side) */
export async function queryStockPorSku(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("stock").select("sku, cantidad");
  const map = new Map<string, number>();
  for (const row of (data || [])) {
    map.set(row.sku, (map.get(row.sku) || 0) + (row.cantidad || 0));
  }
  return map;
}

/** Composición de venta completa */
export async function queryComposicion(): Promise<ComposicionRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const { data } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");
  return (data || []) as ComposicionRow[];
}

/** Productos activos */
export async function queryProductos(): Promise<ProductoRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const { data } = await sb.from("productos")
    .select("sku, sku_venta, nombre, categoria, proveedor, costo, precio, inner_pack, lead_time_dias, moq, estado_sku");
  return (data || []).map((p: Record<string, unknown>) => ({
    sku: p.sku as string,
    sku_venta: (p.sku_venta as string) || "",
    nombre: (p.nombre as string) || "",
    categoria: (p.categoria as string) || "",
    proveedor: (p.proveedor as string) || "",
    costo: (p.costo as number) || 0,
    precio: (p.precio as number) || 0,
    inner_pack: (p.inner_pack as number | null) ?? null,
    lead_time_dias: (p.lead_time_dias as number) || 7,
    moq: (p.moq as number) || 1,
    estado_sku: (p.estado_sku as string) || "activo",
  }));
}

/** Órdenes de orders_history (últimos N días, estado Pagada) */
export async function queryOrdenes(desdeDias: number = 60): Promise<OrdenHistoryRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString();
  const { data } = await sb.from("orders_history")
    .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
    .eq("estado", "Pagada")
    .gte("fecha", desde)
    .order("fecha", { ascending: false })
    .limit(50000);
  return (data || []) as OrdenHistoryRow[];
}

/** Eventos de demanda activos para una fecha */
export async function queryEventosActivos(hoy: string): Promise<EventoDemandaRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const { data } = await sb.from("eventos_demanda")
    .select("id, nombre, fecha_inicio, fecha_fin, fecha_prep_desde, multiplicador, categorias, activo")
    .eq("activo", true)
    .lte("fecha_prep_desde", hoy)
    .gte("fecha_fin", hoy);
  return (data || []) as EventoDemandaRow[];
}

/** Conteos cíclicos recientes */
export async function queryConteos(limiteMeses: number = 3): Promise<ConteoRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - limiteMeses * 30 * 86400000).toISOString();
  const { data } = await sb.from("conteos")
    .select("id, tipo, estado, lineas, created_at")
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(100);
  return (data || []) as ConteoRow[];
}

/** Movimientos recientes */
export async function queryMovimientos(desdeDias: number = 60): Promise<MovimientoRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString();
  const { data } = await sb.from("movimientos")
    .select("sku, tipo, razon, cantidad, created_at")
    .gte("created_at", desde)
    .order("created_at", { ascending: false })
    .limit(5000);
  return (data || []) as MovimientoRow[];
}

/** Stock Full cache (server-side) */
export async function queryStockFullCache(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("stock_full_cache").select("sku_venta, cantidad");
  const map = new Map<string, number>();
  for (const row of (data || [])) {
    map.set(row.sku_venta, row.cantidad || 0);
  }
  return map;
}

/** Detalle de stock Full: dañado, perdido, transferencia por SKU Venta */
export async function queryStockFullDetail(): Promise<Map<string, { sku_venta: string; stock_danado: number; stock_perdido: number; stock_transferencia: number }>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("stock_full_cache").select("sku_venta, stock_danado, stock_perdido, stock_transferencia");
  const map = new Map<string, { sku_venta: string; stock_danado: number; stock_perdido: number; stock_transferencia: number }>();
  for (const row of (data || [])) {
    const danado = row.stock_danado || 0;
    const perdido = row.stock_perdido || 0;
    const transferencia = row.stock_transferencia || 0;
    if (danado > 0 || perdido > 0 || transferencia > 0) {
      map.set(row.sku_venta, { sku_venta: row.sku_venta, stock_danado: danado, stock_perdido: perdido, stock_transferencia: transferencia });
    }
  }
  return map;
}

/** Velocidad promedio de ProfitGuard por SKU Venta */
export async function queryVelProfitguard(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("stock_full_cache").select("sku_venta, vel_promedio");
  const map = new Map<string, number>();
  for (const row of (data || [])) {
    if (row.vel_promedio > 0) map.set(row.sku_venta, row.vel_promedio);
  }
  return map;
}

/** Snapshots de stock para detección de quiebres (últimos N días) */
export async function queryStockSnapshots(desdeDias: number = 60): Promise<StockSnapshotRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString().slice(0, 10);
  const { data } = await sb.from("stock_snapshots")
    .select("fecha, sku_origen, en_quiebre_full")
    .gte("fecha", desde)
    .order("fecha", { ascending: true });
  return (data || []) as StockSnapshotRow[];
}

/** Líneas de órdenes de compra activas (stock en tránsito) */
export async function queryOrdenesCompraActivas(): Promise<OrdenCompraLineaRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const { data } = await sb.from("ordenes_compra_lineas")
    .select("orden_id, sku_origen, cantidad_pedida, cantidad_recibida, estado, ordenes_compra!inner(estado)")
    .in("ordenes_compra.estado", ["PENDIENTE", "EN_TRANSITO", "RECIBIDA_PARCIAL"]);
  return (data || []).map((r: Record<string, unknown>) => ({
    orden_id: r.orden_id as string,
    sku_origen: r.sku_origen as string,
    cantidad_pedida: r.cantidad_pedida as number,
    cantidad_recibida: (r.cantidad_recibida as number) || 0,
    estado: r.estado as string,
  }));
}

/** Datos previos de sku_intelligence para continuidad de quiebre prolongado */
export async function queryPrevIntelligence(): Promise<Map<string, {
  sku_origen: string;
  vel_pre_quiebre: number;
  dias_en_quiebre: number;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  vel_ponderada: number;
  abc: string;
  stock_full: number;
  tiene_stock_prov: boolean;
}>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("sku_intelligence")
    .select("sku_origen, vel_pre_quiebre, dias_en_quiebre, es_quiebre_proveedor, abc_pre_quiebre, vel_ponderada, abc, stock_full, tiene_stock_prov")
    .or("dias_en_quiebre.gt.0,vel_pre_quiebre.gt.0");
  const map = new Map<string, {
    sku_origen: string; vel_pre_quiebre: number; dias_en_quiebre: number;
    es_quiebre_proveedor: boolean; abc_pre_quiebre: string | null;
    vel_ponderada: number; abc: string; stock_full: number; tiene_stock_prov: boolean;
  }>();
  for (const row of (data || [])) {
    map.set(row.sku_origen, {
      sku_origen: row.sku_origen,
      vel_pre_quiebre: row.vel_pre_quiebre || 0,
      dias_en_quiebre: row.dias_en_quiebre || 0,
      es_quiebre_proveedor: row.es_quiebre_proveedor || false,
      abc_pre_quiebre: row.abc_pre_quiebre || null,
      vel_ponderada: row.vel_ponderada || 0,
      abc: row.abc || "C",
      stock_full: row.stock_full || 0,
      tiene_stock_prov: row.tiene_stock_prov ?? true,
    });
  }
  return map;
}

/* ───── Upserts ───── */

export interface SkuIntelligenceUpsert {
  sku_origen: string;
  [key: string]: unknown;
}

/** Upsert batch a sku_intelligence en chunks de 500 */
export async function upsertSkuIntelligence(rows: SkuIntelligenceUpsert[]): Promise<number> {
  const sb = getServerSupabase();
  if (!sb || rows.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from("sku_intelligence").upsert(chunk, { onConflict: "sku_origen" });
    if (error) console.error("[intelligence] upsert error:", error.message);
    else total += chunk.length;
  }
  return total;
}

/** Insertar snapshots diarios en sku_intelligence_history */
export async function insertHistorySnapshots(rows: Record<string, unknown>[]): Promise<number> {
  const sb = getServerSupabase();
  if (!sb || rows.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from("sku_intelligence_history")
      .upsert(chunk, { onConflict: "fecha,sku_origen" });
    if (error) console.error("[intelligence] history upsert error:", error.message);
    else total += chunk.length;
  }
  return total;
}

/** Insertar snapshots de stock diarios */
export async function upsertStockSnapshots(rows: Record<string, unknown>[]): Promise<void> {
  const sb = getServerSupabase();
  if (!sb || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sb.from("stock_snapshots").upsert(chunk, { onConflict: "fecha,sku_origen" });
  }
}
