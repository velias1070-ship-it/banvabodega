/**
 * Queries server-side a Supabase para el motor de inteligencia.
 * Reemplaza las funciones client-side de store.ts (skuTotal, getComponentesPorSkuVenta, etc.)
 * Solo se usa desde API routes (server-side).
 */
import { getServerSupabase } from "./supabase-server";

/* ───── Tipos de respuesta ───── */

export interface ProductoRow {
  sku: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  costo: number;
  costo_promedio: number;
  precio: number;
  inner_pack: number | null;
  lead_time_dias: number;
  moq: number;
  estado_sku: string;
  updated_at: string | null;
}

export interface ComposicionRow {
  sku_venta: string;
  sku_origen: string;
  unidades: number;
  tipo_relacion?: "componente" | "alternativo";
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
  /** v60 — paridad con Full. NULL en rows previas a la migracion. */
  en_quiebre_flex?: boolean;
}

export interface OrdenCompraLineaRow {
  orden_id: string;
  sku_origen: string;
  cantidad_pedida: number;
  cantidad_recibida: number;
  estado: string;
}

/* ───── Helpers ───── */

/** Paginar queries de Supabase (default 1000 por request).
 *
 * PR6a-bis: loggear errores silenciosos de supabase-js. Antes se ignoraba
 * `error` del response, causando que queries falladas devolvieran [] sin
 * aviso (caso real: `queryMovimientos` con `.order()+.range()` que Supabase
 * tira timeout y responde vacío). Ahora warneamos y seguimos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginatedSelect(query: () => any, pageSize = 1000): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await query().range(offset, offset + pageSize - 1);
    if (error) {
      console.error(`[paginatedSelect] error offset=${offset}: ${error.message} (code=${error.code ?? "n/a"})`);
      break;
    }
    if (!data || data.length === 0) break;
    result.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return result;
}

/* ───── Queries ───── */

/** Stock agrupado por SKU (equivale a skuTotal server-side) */
export async function queryStockPorSku(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const data = await paginatedSelect(() => sb.from("stock").select("sku, cantidad, qty_reserved"));
  const map = new Map<string, number>();
  for (const row of data) {
    const sku = row.sku as string;
    const disponible = ((row.cantidad as number) || 0) - ((row.qty_reserved as number) || 0);
    map.set(sku, (map.get(sku) || 0) + Math.max(0, disponible));
  }
  return map;
}

/** Composición de venta completa */
export async function queryComposicion(): Promise<ComposicionRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const data = await paginatedSelect(() => sb.from("composicion_venta").select("sku_venta, sku_origen, unidades, tipo_relacion"));
  return data as unknown as ComposicionRow[];
}

/** Productos activos */
export async function queryProductos(): Promise<ProductoRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const data = await paginatedSelect(() =>
    sb.from("productos").select("sku, nombre, categoria, proveedor, costo, costo_promedio, precio, inner_pack, lead_time_dias, moq, estado_sku, updated_at")
  );
  return data.map((p) => ({
    sku: p.sku as string,
    nombre: (p.nombre as string) || "",
    categoria: (p.categoria as string) || "",
    proveedor: (p.proveedor as string) || "",
    costo: (p.costo as number) || 0,
    costo_promedio: (p.costo_promedio as number) || 0,
    precio: (p.precio as number) || 0,
    inner_pack: (p.inner_pack as number | null) ?? null,
    lead_time_dias: (p.lead_time_dias as number) || 7,
    moq: (p.moq as number) || 1,
    estado_sku: (p.estado_sku as string) || "activo",
    updated_at: (p.updated_at as string) || null,
  }));
}

/** Órdenes de ventas_ml_cache (últimos N días, estado Pagada, no anuladas) — paginado.
 *  Migrado desde orders_history a ventas_ml_cache como fuente canónica: ventas_ml_cache
 *  se alimenta en vivo desde webhook ML (vs orders_history que depende del cron
 *  de ProfitGuard cada 5min con lag de consolidacion 1-2 dias). El sesgo medido
 *  en 7d era -22% (570 vs 728 ordenes) lo cual subestimaba vel_7d y distorsionaba
 *  reposicion y pct_full/pct_flex. */
export async function queryOrdenes(desdeDias: number = 60): Promise<OrdenHistoryRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString().slice(0, 10);
  const result: OrdenHistoryRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from("ventas_ml_cache")
      .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
      .eq("estado", "Pagada")
      .eq("anulada", false)
      .gte("fecha_date", desde)
      .order("fecha_date", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error(`[queryOrdenes] ventas_ml_cache query failed: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;
    result.push(...(data as OrdenHistoryRow[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return result;
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

/** Movimientos recientes — paginado.
 *
 * PR6a-bis: removimos `.order("created_at", { ascending: false })`. Combinar
 * order + range sobre `movimientos` (3k+ rows sin índice en created_at)
 * provocaba que Supabase respondiera vacío en producción, rompiendo
 * `ultimoMovPorSku` y dejando `dias_sin_movimiento` NULL para los 533.
 * El motor no necesita orden — recorre todo y computa max() en memoria.
 *
 * 2026-04-27: cutoff 60d era el techo efectivo de dias_sin_movimiento.
 * Manual BANVA_Pricing_Investigacion_Comparada:197 distingue ">90-180d
 * sin movimiento = slow; >180-365d = dead stock"; trigger de
 * reclasificación :235 dispara a >120d. Con cutoff 60d esos triggers
 * estaban virtualmente apagados. Subimos a 400d para cubrir el rango
 * dead stock + margen. La paginación absorbe el incremento de filas.
 */
export async function queryMovimientos(desdeDias: number = 400): Promise<MovimientoRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString();
  // PR6a-bis/3: quitamos `razon` del select — esa columna NO EXISTE en la
  // tabla (se llama `motivo`). El select antes tiraba "column does not exist"
  // y Supabase respondía error, pero paginatedSelect ignoraba error y
  // devolvía []. Causa raíz real del bug "dias_sin_movimiento NULL en 533".
  // El motor solo usa `sku` y `created_at` — el resto estaba de más.
  const data = await paginatedSelect(() =>
    sb.from("movimientos")
      .select("sku, created_at")
      .gte("created_at", desde)
  );
  return data as unknown as MovimientoRow[];
}

/** Stock Full cache (server-side) — paginado */
export async function queryStockFullCache(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const data = await paginatedSelect(() => sb.from("stock_full_cache").select("sku_venta, cantidad"));
  const map = new Map<string, number>();
  for (const row of data) {
    map.set(row.sku_venta as string, (row.cantidad as number) || 0);
  }
  return map;
}

/** Detalle de stock Full: dañado, perdido, transferencia por SKU Venta — paginado */
export async function queryStockFullDetail(): Promise<Map<string, { sku_venta: string; stock_danado: number; stock_perdido: number; stock_transferencia: number }>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const data = await paginatedSelect(() => sb.from("stock_full_cache").select("sku_venta, stock_danado, stock_perdido, stock_transferencia"));
  const map = new Map<string, { sku_venta: string; stock_danado: number; stock_perdido: number; stock_transferencia: number }>();
  for (const row of data) {
    const danado = (row.stock_danado as number) || 0;
    const perdido = (row.stock_perdido as number) || 0;
    const transferencia = (row.stock_transferencia as number) || 0;
    if (danado > 0 || perdido > 0 || transferencia > 0) {
      map.set(row.sku_venta as string, { sku_venta: row.sku_venta as string, stock_danado: danado, stock_perdido: perdido, stock_transferencia: transferencia });
    }
  }
  return map;
}

/** Snapshots de stock para detección de quiebres (últimos N días) — paginado */
export async function queryStockSnapshots(desdeDias: number = 60): Promise<StockSnapshotRow[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const desde = new Date(Date.now() - desdeDias * 86400000).toISOString().slice(0, 10);
  const data = await paginatedSelect(() =>
    sb.from("stock_snapshots")
      .select("fecha, sku_origen, en_quiebre_full, en_quiebre_flex")
      .gte("fecha", desde)
      .order("fecha", { ascending: true })
  );
  return data as unknown as StockSnapshotRow[];
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

/**
 * Suma uds por sku_origen de envíos a Full PENDIENTES (estado ABIERTA o EN_PROCESO).
 * Estas unidades están reservadas en bodega y a punto de irse a Full.
 * Se usan para reducir el `pedirFull` del proveedor: si ya van 8 en camino,
 * no necesitas pedir esas 8 al proveedor de nuevo. SOLO componentes ya pickeados
 * se excluyen porque su reserva ya se liberó al confirmar.
 */
export async function queryEnviosFullPendientes(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("picking_sessions")
    .select("id, lineas")
    .eq("tipo", "envio_full")
    .in("estado", ["ABIERTA", "EN_PROCESO"]);

  const map = new Map<string, number>();
  for (const sesion of (data || []) as { id: string; lineas: unknown[] | null }[]) {
    const lineas = (sesion.lineas || []) as Array<{
      componentes?: Array<{ skuOrigen?: string; unidades?: number; estado?: string }>;
    }>;
    for (const linea of lineas) {
      for (const comp of (linea.componentes || [])) {
        // Saltar componentes ya pickeados — su reserva en stock ya fue liberada
        if (comp.estado === "PICKEADO" || comp.estado === "OMITIDO") continue;
        const sku = comp.skuOrigen;
        const uds = comp.unidades || 0;
        if (!sku || uds <= 0) continue;
        map.set(sku, (map.get(sku) || 0) + uds);
      }
    }
  }
  return map;
}

/** Datos previos de sku_intelligence para continuidad de quiebre prolongado */
export async function queryPrevIntelligence(): Promise<Map<string, {
  sku_origen: string;
  vel_pre_quiebre: number;
  margen_unitario_pre_quiebre: number;
  dias_en_quiebre: number | null;
  /** PR5 — ancla temporal del quiebre previo. ISO YYYY-MM-DD UTC. */
  fecha_entrada_quiebre: string | null;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  vel_ponderada: number;
  abc: string;
  stock_full: number;
  tiene_stock_prov: boolean;
  // v60 — estado previo de quiebre Flex (paridad con Full)
  dias_en_quiebre_flex: number | null;
  fecha_entrada_quiebre_flex: string | null;
  vel_flex_pre_quiebre: number;
  vel_flex: number;
}>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  // Incluir dias_en_quiebre IS NULL + fecha_entrada_quiebre (PR5) + campos v60.
  const rows = await paginatedSelect(() =>
    sb.from("sku_intelligence")
      .select("sku_origen, vel_pre_quiebre, margen_unitario_pre_quiebre, dias_en_quiebre, fecha_entrada_quiebre, es_quiebre_proveedor, abc_pre_quiebre, vel_ponderada, abc, stock_full, tiene_stock_prov, dias_en_quiebre_flex, fecha_entrada_quiebre_flex, vel_flex_pre_quiebre, vel_flex")
      .or("dias_en_quiebre.gt.0,vel_pre_quiebre.gt.0,dias_en_quiebre.is.null,fecha_entrada_quiebre.not.is.null,dias_en_quiebre_flex.gt.0,vel_flex_pre_quiebre.gt.0,fecha_entrada_quiebre_flex.not.is.null")
  );
  const map = new Map<string, {
    sku_origen: string; vel_pre_quiebre: number; margen_unitario_pre_quiebre: number;
    dias_en_quiebre: number | null; fecha_entrada_quiebre: string | null;
    es_quiebre_proveedor: boolean; abc_pre_quiebre: string | null;
    vel_ponderada: number; abc: string; stock_full: number; tiene_stock_prov: boolean;
    dias_en_quiebre_flex: number | null; fecha_entrada_quiebre_flex: string | null;
    vel_flex_pre_quiebre: number; vel_flex: number;
  }>();
  for (const row of rows) {
    const diasRaw = row.dias_en_quiebre;
    const diasFlexRaw = row.dias_en_quiebre_flex;
    map.set(row.sku_origen as string, {
      sku_origen: row.sku_origen as string,
      vel_pre_quiebre: (row.vel_pre_quiebre as number) || 0,
      margen_unitario_pre_quiebre: (row.margen_unitario_pre_quiebre as number) || 0,
      dias_en_quiebre: diasRaw === null || diasRaw === undefined ? null : (diasRaw as number),
      fecha_entrada_quiebre: (row.fecha_entrada_quiebre as string | null) ?? null,
      es_quiebre_proveedor: (row.es_quiebre_proveedor as boolean) || false,
      abc_pre_quiebre: (row.abc_pre_quiebre as string) || null,
      vel_ponderada: (row.vel_ponderada as number) || 0,
      abc: (row.abc as string) || "C",
      stock_full: (row.stock_full as number) || 0,
      tiene_stock_prov: (row.tiene_stock_prov as boolean) ?? true,
      dias_en_quiebre_flex: diasFlexRaw === null || diasFlexRaw === undefined ? null : (diasFlexRaw as number),
      fecha_entrada_quiebre_flex: (row.fecha_entrada_quiebre_flex as string | null) ?? null,
      vel_flex_pre_quiebre: (row.vel_flex_pre_quiebre as number) || 0,
      vel_flex: (row.vel_flex as number) || 0,
    });
  }
  return map;
}

/** PR4 Fase 1 — flag es_estacional por SKU. Map<sku_origen (UPPER), true> para
 *  los marcados; los no marcados no están en el map. Separado de prevIntelligence
 *  porque aquél filtra a SKUs en quiebre; el flag aplica a cualquier SKU. */
export async function queryFlagEstacional(): Promise<Set<string>> {
  const sb = getServerSupabase();
  if (!sb) return new Set();
  const rows = await paginatedSelect(() =>
    sb.from("sku_intelligence").select("sku_origen").eq("es_estacional", true)
  );
  const out = new Set<string>();
  for (const r of rows) out.add((r.sku_origen as string).toUpperCase());
  return out;
}

/** Lead time por proveedor desde la tabla proveedores. Map<nombre, {...}> */
export async function queryProveedores(): Promise<Map<string, {
  lead_time_dias: number;
  lead_time_sigma_dias: number;
  lead_time_fuente: string;
  lead_time_muestras: number;
}>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("proveedores")
    .select("nombre, lead_time_dias, lead_time_sigma_dias, lead_time_fuente, lead_time_muestras")
    .eq("activo", true);
  const map = new Map<string, {
    lead_time_dias: number; lead_time_sigma_dias: number;
    lead_time_fuente: string; lead_time_muestras: number;
  }>();
  for (const row of (data || []) as Array<{
    nombre: string; lead_time_dias: number; lead_time_sigma_dias: number;
    lead_time_fuente: string; lead_time_muestras: number;
  }>) {
    map.set((row.nombre || "").trim(), {
      lead_time_dias: row.lead_time_dias || 5,
      lead_time_sigma_dias: row.lead_time_sigma_dias ?? 1.5,
      lead_time_fuente: row.lead_time_fuente || "fallback",
      lead_time_muestras: row.lead_time_muestras || 0,
    });
  }
  return map;
}

/** Calcula LT real promedio + sigma por proveedor desde OCs cerradas/recibidas.
 *  Usado por el cron actualizar-lead-times. Hoy probablemente devuelve Map vacío
 *  porque no hay OCs reales con fecha_recepcion poblada todavía.
 */
export async function queryLeadTimeReal(): Promise<Map<string, {
  lead_time_dias: number; lead_time_sigma_dias: number; muestras: number;
}>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("ordenes_compra")
    .select("proveedor, fecha_emision, fecha_recepcion")
    .in("estado", ["RECIBIDA", "CERRADA"])
    .not("fecha_recepcion", "is", null)
    .not("fecha_emision", "is", null);
  if (!data || data.length === 0) return new Map();

  // Agrupar dias_lt por proveedor
  const buckets = new Map<string, number[]>();
  for (const row of data as Array<{ proveedor: string; fecha_emision: string; fecha_recepcion: string }>) {
    if (!row.proveedor || !row.fecha_emision || !row.fecha_recepcion) continue;
    const dias = Math.round(
      (new Date(row.fecha_recepcion).getTime() - new Date(row.fecha_emision).getTime()) / 86400000
    );
    if (dias < 0 || dias > 365) continue; // descarta outliers absurdos
    const key = (row.proveedor || "").trim();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(dias);
  }

  const result = new Map<string, { lead_time_dias: number; lead_time_sigma_dias: number; muestras: number }>();
  buckets.forEach((dias, prov) => {
    if (dias.length < 1) return;
    const avg = dias.reduce((s: number, x: number) => s + x, 0) / dias.length;
    const variance = dias.length > 1
      ? dias.reduce((s: number, x: number) => s + Math.pow(x - avg, 2), 0) / (dias.length - 1)
      : Math.pow(0.30 * avg, 2);
    const sigma = Math.sqrt(variance);
    result.set(prov, {
      lead_time_dias: Math.round(avg * 10) / 10,
      lead_time_sigma_dias: Math.round(sigma * 10) / 10,
      muestras: dias.length,
    });
  });
  return result;
}

/** Margen bruto y unidades últimos N días por sku_origen, desde ventas_ml_cache.
 *  Usa composicion_venta para traducir sku_venta → sku_origen. Filtra:
 *   - tipo_relacion = 'componente' (evita doble-conteo de alternativas)
 *   - anulada = false
 *   - costo_fuente != 'sin_costo' (solo ventas con costo confiable)
 */
export async function queryMargenPorSku(diasAtras: number = 30): Promise<{
  margen: Map<string, number>;
  unidades: Map<string, number>;
}> {
  const sb = getServerSupabase();
  if (!sb) return { margen: new Map(), unidades: new Map() };

  const desde = new Date(Date.now() - diasAtras * 86400000).toISOString().slice(0, 10);

  // Regla 3 (inventory-policy.md): paginatedSelect propaga errores de supabase y
  // pagina sobre el cap de 1000 filas. Con `.select()` directo, BANVA pasa de 1000
  // ventas en 30d y truncaba silenciosamente el Pareto ABC.
  const ventas = await paginatedSelect(() =>
    sb.from("ventas_ml_cache")
      .select("sku_venta, margen, cantidad")
      .gte("fecha_date", desde)
      .eq("anulada", false)
      .neq("costo_fuente", "sin_costo")
  ) as Array<{ sku_venta: string; margen: number; cantidad: number }>;

  if (ventas.length === 0) {
    return { margen: new Map(), unidades: new Map() };
  }

  // Composición sku_venta → sku_origen (solo componentes, no alternativos).
  // unidades = multiplicador físico: 1 venta del listing pack consume N
  // unidades del sku_origen. Hasta 2026-04-26 este SELECT no traía la columna
  // y el código sumaba cantidad×1 — subreportaba SKUs físicos vendidos via
  // listings pack (X2, X4). Detectado en LICAAFVIS5746 (146→109 esperado),
  // TX2ALIMFP5070 (20→10), TXALMILLVIS46 (32→21).
  const comp = await paginatedSelect(() =>
    sb.from("composicion_venta")
      .select("sku_venta, sku_origen, unidades, tipo_relacion")
      .eq("tipo_relacion", "componente")
  ) as Array<{ sku_venta: string; sku_origen: string; unidades: number }>;

  const compMap = new Map<string, Array<{ sku_origen: string; unidades: number }>>();
  for (const c of comp) {
    const key = (c.sku_venta || "").toUpperCase();
    const arr = compMap.get(key) || [];
    arr.push({
      sku_origen: (c.sku_origen || "").toUpperCase(),
      unidades: (c.unidades as number) || 1,
    });
    compMap.set(key, arr);
  }

  const margen = new Map<string, number>();
  const unidades = new Map<string, number>();
  for (const v of ventas) {
    const orígenes = compMap.get((v.sku_venta || "").toUpperCase());
    // Atribuir a cada componente (un sku_venta puede tener múltiples componentes en un pack).
    // Para packs reales (unidades > 1), la atribución es 1:N — el margen va al componente
    // y las unidades físicas = v.cantidad × c.unidades (1 venta del pack consume N).
    if (orígenes && orígenes.length > 0) {
      for (const c of orígenes) {
        margen.set(c.sku_origen, (margen.get(c.sku_origen) || 0) + (v.margen || 0));
        unidades.set(
          c.sku_origen,
          (unidades.get(c.sku_origen) || 0) + ((v.cantidad || 0) * (c.unidades || 1))
        );
      }
    } else {
      // Fallback: sku_venta = sku_origen sin composicion (multiplicador asumido 1).
      const sku = (v.sku_venta || "").toUpperCase();
      margen.set(sku, (margen.get(sku) || 0) + (v.margen || 0));
      unidades.set(sku, (unidades.get(sku) || 0) + (v.cantidad || 0));
    }
  }

  return { margen, unidades };
}

/** Velocidad objetivo por SKU Origen */
export async function queryVelObjetivos(): Promise<Map<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const data = await paginatedSelect(() =>
    sb.from("sku_intelligence")
      .select("sku_origen, vel_objetivo")
      .gt("vel_objetivo", 0)
  );
  const map = new Map<string, number>();
  for (const row of data) {
    map.set(row.sku_origen as string, (row.vel_objetivo as number) || 0);
  }
  return map;
}

/** Config de targets ABC desde intel_config */
export async function queryIntelConfig(): Promise<{
  target_dias_a: number;
  target_dias_b: number;
  target_dias_c: number;
}> {
  const sb = getServerSupabase();
  if (!sb) return { target_dias_a: 42, target_dias_b: 28, target_dias_c: 14 };
  const { data } = await sb.from("intel_config")
    .select("target_dias_a, target_dias_b, target_dias_c")
    .eq("id", "main")
    .single();
  if (!data) return { target_dias_a: 42, target_dias_b: 28, target_dias_c: 14 };
  return {
    target_dias_a: (data.target_dias_a as number) || 42,
    target_dias_b: (data.target_dias_b as number) || 28,
    target_dias_c: (data.target_dias_c as number) || 14,
  };
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

/**
 * Primera venta histórica por sku_origen (PR3 Fase A — puerta TSB).
 *
 * Lee MIN(fecha_date) de ventas_ml_cache por sku_venta y expande a sku_origen
 * vía composicion_venta (mismo patrón que Paso 2 del motor, excluyendo
 * tipo_relacion='alternativo' para evitar doble mapeo). Query única, ~100ms
 * sobre 10k rows / 400 composiciones.
 *
 * Devuelve sku_origen (UPPER) → Date del primer registro de venta histórica
 * (no filtrado por anulada=false intencionalmente: si hubo intento de venta
 * en una fecha, esa fecha cuenta para "edad comercial" del SKU).
 */
export async function queryPrimeraVentaPorSkuOrigen(): Promise<Map<string, Date>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();

  const [primeraVentaRaw, composicionRaw] = await Promise.all([
    paginatedSelect(() => sb.from("ventas_ml_cache").select("sku_venta, fecha_date")),
    paginatedSelect(() => sb.from("composicion_venta").select("sku_venta, sku_origen, tipo_relacion")),
  ]);

  // Min por sku_venta.
  const minPorSkuVenta = new Map<string, Date>();
  for (const r of primeraVentaRaw) {
    const sv = (r.sku_venta as string | null)?.toUpperCase();
    const fecha = r.fecha_date as string | null;
    if (!sv || !fecha) continue;
    const d = new Date(fecha + "T00:00:00.000Z");
    if (Number.isNaN(d.getTime())) continue;
    const prev = minPorSkuVenta.get(sv);
    if (!prev || d < prev) minPorSkuVenta.set(sv, d);
  }

  // Expansión sku_venta → sku_origen (excluye alternativos).
  const minPorSkuOrigen = new Map<string, Date>();
  for (const c of composicionRaw) {
    if (c.tipo_relacion === "alternativo") continue;
    const sv = (c.sku_venta as string | null)?.toUpperCase();
    const so = (c.sku_origen as string | null)?.toUpperCase();
    if (!sv || !so) continue;
    const d = minPorSkuVenta.get(sv);
    if (!d) continue;
    const prev = minPorSkuOrigen.get(so);
    if (!prev || d < prev) minPorSkuOrigen.set(so, d);
  }
  return minPorSkuOrigen;
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

/* ───── Proveedor Catálogo (server-side) ───── */

export interface ProveedorCatalogoRow {
  sku_origen: string;
  proveedor: string;
  inner_pack: number;
  precio_neto: number;
  /** null = desconocido (nunca importado); 0 = explícitamente agotado; >0 = disponible */
  stock_disponible: number | null;
  updated_at: string;
}

/** Catálogo completo de proveedores — paginado */
export async function queryProveedorCatalogo(): Promise<Map<string, ProveedorCatalogoRow>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const data = await paginatedSelect(() =>
    sb.from("proveedor_catalogo").select("sku_origen, proveedor, inner_pack, precio_neto, stock_disponible, updated_at")
  );
  const map = new Map<string, ProveedorCatalogoRow>();
  for (const row of data) {
    const sku = (row.sku_origen as string).toUpperCase();
    // Si hay duplicados (múltiples proveedores), quedarse con el más reciente
    const existing = map.get(sku);
    if (!existing || (row.updated_at as string) > existing.updated_at) {
      const rawStock = row.stock_disponible;
      // Compat: migración v42 convierte -1 → NULL; aceptar ambos
      // mientras los imports legacy se propagan.
      const stockDisponible: number | null =
        rawStock == null || rawStock === -1 ? null : (rawStock as number);
      map.set(sku, {
        sku_origen: sku,
        proveedor: (row.proveedor as string) || "",
        inner_pack: (row.inner_pack as number) || 1,
        precio_neto: (row.precio_neto as number) || 0,
        stock_disponible: stockDisponible,
        updated_at: (row.updated_at as string) || "",
      });
    }
  }
  return map;
}

/** Fecha de última importación de proveedor */
export async function queryUltimaImportacionProveedor(): Promise<string | null> {
  const sb = getServerSupabase();
  if (!sb) return null;
  const { data } = await sb.from("proveedor_imports")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return null;
  return data[0].created_at as string;
}
