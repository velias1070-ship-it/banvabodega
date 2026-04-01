/**
 * Sistema de Métricas Mensuales MercadoLibre
 * Recopila datos de 11 endpoints ML API, agrega por SKU/mes,
 * almacena en Supabase para análisis histórico y priorización.
 *
 * State machine con 8 fases, cada una < 5 min (maxDuration=300).
 * Self-chaining: un cron invocation ejecuta múltiples fases.
 */
import { getServerSupabase } from "./supabase-server";
import { mlGet, getMLConfig } from "./ml";
import type { MLConfig } from "./ml";

const SITE_ID = "MLC";
const BATCH_VISITS = 50;
const UPSERT_CHUNK = 500;
const SAVE_PROGRESS_EVERY = 50;
const DELAY_BETWEEN_REQUESTS_MS = 300; // ~200 req/min safe

// ==================== TYPES ====================

interface SyncEstado {
  id: string;
  periodo: string;
  fase: string;
  items_procesados: number;
  items_total: number;
  ultimo_item_idx: number;
  error_msg: string | null;
  iniciado_at: string | null;
  actualizado_at: string;
  completado_at: string | null;
}

interface ItemMap {
  item_id: string;
  sku_venta: string | null;
  sku_origen: string | null;
  titulo: string | null;
}

type PrioridadMetrica =
  | "PAUSAR_ADS"
  | "REPONER_STOCK"
  | "OPT_FICHA_URGENTE"
  | "OPT_FICHA"
  | "PROTEGER_STOCK"
  | "PROTEGER_WINNER"
  | "MONITOREAR";

// ML API response types
interface VisitasItem {
  item_id: string;
  total_visits: number;
}

interface PerformanceBucket {
  key: string;
  status: string;
  score?: number;
  variables?: Array<{
    key: string;
    status: string;
    rules?: Array<{ key: string; status: string; progress?: number; wordings?: { title?: string; link?: string } }>;
  }>;
}

interface PerformanceResponse {
  score?: number;
  level?: string;
  level_wording?: string;
  buckets?: PerformanceBucket[];
}

interface ReviewsResponse {
  rating_average: number;
  paging: { total: number };
  reviews?: Array<{ date_created: string }>;
}

interface QuestionsResponse {
  total: number;
  questions: Array<{ status: string }>;
}

interface AdsCampaign {
  id: number;
  name: string;
  status: string;
  budget?: number;
  strategy?: string;
  acos_target?: number;
  roas_target?: number;
  metrics?: Record<string, number>;
}

interface AdsAd {
  item_id: string;
  campaign_id: number;
  status: string;
  title?: string;
  metrics?: Record<string, number>;
}

interface ReputationResponse {
  seller_reputation?: {
    level_id?: string;
    power_seller_status?: string;
    transactions?: {
      completed?: number;
      canceled?: number;
      ratings?: { positive?: number; negative?: number };
    };
    metrics?: Array<{ type: string; value: number }>;
  };
}

// ==================== FASES ====================

const FASES_ORDEN = [
  "visits", "quality", "reviews", "questions", "ads", "reputation", "aggregate", "done",
] as const;

function siguienteFase(faseActual: string): string {
  const idx = FASES_ORDEN.indexOf(faseActual as typeof FASES_ORDEN[number]);
  if (idx < 0 || idx >= FASES_ORDEN.length - 1) return "done";
  return FASES_ORDEN[idx + 1];
}

// ==================== STATE MANAGEMENT ====================

export async function getSyncEstado(): Promise<SyncEstado | null> {
  const sb = getServerSupabase();
  if (!sb) { console.error("[ml-metrics] getSyncEstado: no supabase client"); return null; }
  try {
    const { data, error } = await sb.from("ml_sync_estado").select("*").eq("id", "metrics").limit(1);
    if (error) { console.error("[ml-metrics] getSyncEstado error:", error.message); return null; }
    return (data && data.length > 0 ? data[0] : null) as SyncEstado | null;
  } catch (err) {
    console.error("[ml-metrics] getSyncEstado exception:", err);
    return null;
  }
}

async function updateSyncEstado(updates: Partial<SyncEstado>): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) { console.error("[ml-metrics] updateSyncEstado: no supabase client"); return; }
  try {
    // Remove undefined values that could cause issues
    const clean: Record<string, unknown> = { actualizado_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) clean[k] = v;
    }
    const { error } = await sb.from("ml_sync_estado").update(clean).eq("id", "metrics");
    if (error) console.error("[ml-metrics] updateSyncEstado error:", error.message, error.details, error.hint);
  } catch (err) {
    console.error("[ml-metrics] updateSyncEstado exception:", err);
  }
}

export async function iniciarSync(periodo: string): Promise<SyncEstado | null> {
  const items = await getActiveItemIds();
  const estado: Partial<SyncEstado> = {
    periodo,
    fase: FASES_ORDEN[0],
    items_procesados: 0,
    items_total: items.length,
    ultimo_item_idx: 0,
    error_msg: null,
    iniciado_at: new Date().toISOString(),
    completado_at: null,
  };
  await updateSyncEstado(estado);

  // Pre-crear filas en ml_snapshot_mensual para todos los items
  const sb = getServerSupabase();
  if (sb) {
    const skuMap = await getItemSkuMap();
    const rows = items.map(item_id => {
      const info = skuMap.get(item_id);
      return {
        periodo,
        item_id,
        sku_venta: info?.sku_venta || null,
        sku_origen: info?.sku_origen || null,
        titulo: info?.titulo || null,
      };
    });
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const { error } = await sb.from("ml_snapshot_mensual")
        .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "periodo,item_id" });
      if (error) console.error("[ml-metrics] pre-insert error:", error.message);
    }
  }

  return getSyncEstado();
}

// ==================== HELPERS ====================

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getActiveItemIds(): Promise<string[]> {
  const sb = getServerSupabase();
  if (!sb) return [];
  const { data } = await sb.from("ml_items_map")
    .select("item_id")
    .eq("activo", true);
  if (!data) return [];
  // Deduplicate item_ids (multiple SKUs can map to same item)
  const unique = Array.from(new Set(data.map((r: { item_id: string }) => r.item_id)));
  return unique;
}

async function getItemSkuMap(): Promise<Map<string, ItemMap>> {
  const sb = getServerSupabase();
  if (!sb) return new Map();
  const { data } = await sb.from("ml_items_map")
    .select("item_id, sku_venta, sku_origen, titulo")
    .eq("activo", true);
  if (!data) return new Map();
  const map = new Map<string, ItemMap>();
  for (const r of data) {
    // Keep first mapping per item_id (primary)
    if (!map.has(r.item_id)) {
      map.set(r.item_id, r as ItemMap);
    }
  }
  return map;
}

async function batchUpdateSnapshot(
  periodo: string,
  updates: Array<{ item_id: string; [key: string]: unknown }>
): Promise<number> {
  const sb = getServerSupabase();
  if (!sb || updates.length === 0) return 0;
  let total = 0;
  const rows = updates.map(u => ({ ...u, periodo }));
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await sb.from("ml_snapshot_mensual")
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "periodo,item_id" });
    if (error) console.error("[ml-metrics] batchUpdate error:", error.message);
    else total += rows.slice(i, i + UPSERT_CHUNK).length;
  }
  return total;
}

// ==================== PHASE: VISITS ====================

async function faseVisitas(estado: SyncEstado, itemIds: string[]): Promise<number> {
  const updates: Array<{ item_id: string; visitas: number }> = [];

  for (let i = 0; i < itemIds.length; i += BATCH_VISITS) {
    const batch = itemIds.slice(i, i + BATCH_VISITS);
    const ids = batch.join(",");
    const dateFrom = `${estado.periodo}-01T00:00:00.000-04:00`;
    const dateTo = lastDayOfMonth(estado.periodo) + "T23:59:59.999-04:00";

    const resp = await mlGet<Record<string, unknown>>(
      `/items/visits?ids=${ids}&date_from=${dateFrom}&date_to=${dateTo}`
    );

    if (resp && typeof resp === "object") {
      // Response is keyed by item_id: { "MLC123": 500, "MLC456": 300 }
      for (const [itemId, visits] of Object.entries(resp)) {
        if (typeof visits === "number") {
          updates.push({ item_id: itemId, visitas: visits });
        }
      }
    }
    await delay(DELAY_BETWEEN_REQUESTS_MS);
  }

  await batchUpdateSnapshot(estado.periodo, updates);
  return updates.length;
}

// ==================== PHASE: QUALITY ====================

async function faseQuality(estado: SyncEstado, itemIds: string[]): Promise<number> {
  const updates: Array<{ item_id: string; quality_score: number | null; quality_level: string | null; performance_data: unknown }> = [];
  const startIdx = estado.ultimo_item_idx;

  for (let i = startIdx; i < itemIds.length; i++) {
    const itemId = itemIds[i];

    // Try /health first (newer), fallback to /performance
    let resp = await mlGet<PerformanceResponse>(`/items/${itemId}/health`);
    if (!resp) {
      resp = await mlGet<PerformanceResponse>(`/items/${itemId}/performance`);
    }

    if (resp) {
      updates.push({
        item_id: itemId,
        quality_score: resp.score ?? null,
        quality_level: resp.level ?? resp.level_wording ?? null,
        performance_data: resp.buckets ? JSON.stringify(resp.buckets) : null,
      });
    }

    if ((i + 1) % SAVE_PROGRESS_EVERY === 0) {
      await batchUpdateSnapshot(estado.periodo, updates);
      updates.length = 0;
      await updateSyncEstado({ ultimo_item_idx: i + 1, items_procesados: i + 1 });
    }

    await delay(DELAY_BETWEEN_REQUESTS_MS);
  }

  if (updates.length > 0) {
    await batchUpdateSnapshot(estado.periodo, updates);
  }
  return itemIds.length - startIdx;
}

// ==================== PHASE: REVIEWS ====================

async function faseReviews(estado: SyncEstado, itemIds: string[]): Promise<number> {
  const updates: Array<{ item_id: string; reviews_promedio: number | null; reviews_total: number; reviews_nuevas: number }> = [];
  const startIdx = estado.ultimo_item_idx;
  const monthStart = new Date(`${estado.periodo}-01`);

  for (let i = startIdx; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const resp = await mlGet<ReviewsResponse>(`/reviews/item/${itemId}`);

    if (resp) {
      let nuevas = 0;
      if (resp.reviews) {
        nuevas = resp.reviews.filter(r => new Date(r.date_created) >= monthStart).length;
      }
      updates.push({
        item_id: itemId,
        reviews_promedio: resp.rating_average ?? null,
        reviews_total: resp.paging?.total ?? 0,
        reviews_nuevas: nuevas,
      });
    }

    if ((i + 1) % SAVE_PROGRESS_EVERY === 0) {
      await batchUpdateSnapshot(estado.periodo, updates);
      updates.length = 0;
      await updateSyncEstado({ ultimo_item_idx: i + 1, items_procesados: i + 1 });
    }

    await delay(DELAY_BETWEEN_REQUESTS_MS);
  }

  if (updates.length > 0) {
    await batchUpdateSnapshot(estado.periodo, updates);
  }
  return itemIds.length - startIdx;
}

// ==================== PHASE: QUESTIONS ====================

async function faseQuestions(estado: SyncEstado, itemIds: string[]): Promise<number> {
  const updates: Array<{ item_id: string; preguntas_total: number; preguntas_sin_responder: number }> = [];
  const startIdx = estado.ultimo_item_idx;

  for (let i = startIdx; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const resp = await mlGet<QuestionsResponse>(
      `/questions/search?item=${itemId}&sort_fields=date_created&sort_types=DESC&limit=50`
    );

    if (resp) {
      const sinResponder = resp.questions?.filter(q => q.status === "UNANSWERED").length ?? 0;
      updates.push({
        item_id: itemId,
        preguntas_total: resp.total ?? 0,
        preguntas_sin_responder: sinResponder,
      });
    }

    if ((i + 1) % SAVE_PROGRESS_EVERY === 0) {
      await batchUpdateSnapshot(estado.periodo, updates);
      updates.length = 0;
      await updateSyncEstado({ ultimo_item_idx: i + 1, items_procesados: i + 1 });
    }

    await delay(DELAY_BETWEEN_REQUESTS_MS);
  }

  if (updates.length > 0) {
    await batchUpdateSnapshot(estado.periodo, updates);
  }
  return itemIds.length - startIdx;
}

// ==================== PHASE: ADS ====================

async function faseAds(estado: SyncEstado, config: MLConfig & { advertiser_id?: string }): Promise<number> {
  const advertiserId = config.advertiser_id;
  if (!advertiserId) {
    console.log("[ml-metrics] No advertiser_id configured, skipping ads phase");
    return 0;
  }

  const dateFrom = `${estado.periodo}-01`;
  const dateTo = lastDayOfMonth(estado.periodo);
  const metricsParam = [
    "clicks", "prints", "ctr", "cost", "cpc", "acos", "roas", "cvr", "sov",
    "impression_share", "top_impression_share",
    "lost_impression_share_by_budget", "lost_impression_share_by_ad_rank",
    "acos_benchmark", "direct_amount", "indirect_amount", "total_amount",
    "direct_units_quantity", "indirect_units_quantity", "units_quantity",
    "organic_units_quantity", "organic_units_amount",
  ].join(",");

  // 1. Get campaigns
  const campaignsResp = await mlGet<{ results?: AdsCampaign[] }>(
    `/marketplace/advertising/${SITE_ID}/advertisers/${advertiserId}/product_ads/campaigns/search` +
    `?metrics_summary=true&metrics=${metricsParam}&date_from=${dateFrom}&date_to=${dateTo}`,
    { "api-version": "2" }
  );

  const campaigns = campaignsResp?.results ?? [];
  if (campaigns.length === 0) return 0;

  // 2. Get ads per campaign
  const allUpdates: Array<{ item_id: string; [key: string]: unknown }> = [];

  for (const camp of campaigns) {
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const adsResp = await mlGet<{ results?: AdsAd[] }>(
        `/marketplace/advertising/${SITE_ID}/advertisers/${advertiserId}/product_ads/ads` +
        `?campaign_id=${camp.id}&metrics=${metricsParam}` +
        `&date_from=${dateFrom}&date_to=${dateTo}&offset=${offset}&limit=${limit}`,
        { "api-version": "2" }
      );

      const ads = adsResp?.results ?? [];
      for (const ad of ads) {
        const m = ad.metrics || {};
        allUpdates.push({
          item_id: ad.item_id,
          ads_activo: ad.status === "active",
          ads_campaign_id: String(ad.campaign_id),
          ads_campaign_name: camp.name,
          ads_status: ad.status,
          ads_daily_budget: camp.budget ?? 0,
          ads_strategy: camp.strategy ?? null,
          ads_clicks: m.clicks ?? 0,
          ads_prints: m.prints ?? 0,
          ads_cost: m.cost ?? 0,
          ads_cpc: m.cpc ?? 0,
          ads_ctr: m.ctr ?? 0,
          ads_cvr: m.cvr ?? 0,
          ads_acos: m.acos ?? 0,
          ads_roas: m.roas ?? 0,
          ads_sov: m.sov ?? 0,
          ads_impression_share: m.impression_share ?? 0,
          ads_top_impression_share: m.top_impression_share ?? 0,
          ads_lost_by_budget: m.lost_impression_share_by_budget ?? 0,
          ads_lost_by_rank: m.lost_impression_share_by_ad_rank ?? 0,
          ads_acos_benchmark: m.acos_benchmark ?? 0,
          ads_direct_amount: m.direct_amount ?? 0,
          ads_indirect_amount: m.indirect_amount ?? 0,
          ads_total_amount: m.total_amount ?? 0,
          ads_direct_units: m.direct_units_quantity ?? 0,
          ads_indirect_units: m.indirect_units_quantity ?? 0,
          ads_total_units: m.units_quantity ?? 0,
          ads_organic_units: m.organic_units_quantity ?? 0,
          ads_organic_amount: m.organic_units_amount ?? 0,
        });
      }

      hasMore = ads.length === limit;
      offset += limit;
      await delay(DELAY_BETWEEN_REQUESTS_MS);
    }
  }

  await batchUpdateSnapshot(estado.periodo, allUpdates);
  return allUpdates.length;
}

// ==================== PHASE: REPUTATION ====================

async function faseReputation(estado: SyncEstado, config: MLConfig): Promise<number> {
  const resp = await mlGet<ReputationResponse>(`/users/${config.seller_id}`);
  if (!resp?.seller_reputation) return 0;

  const rep = resp.seller_reputation;
  const metricsArr = Array.isArray(rep.metrics) ? rep.metrics : [];
  const metricsMap = new Map(metricsArr.map(m => [m.type, m.value]));

  const sb = getServerSupabase();
  if (!sb) return 0;

  const { error } = await sb.from("ml_resumen_mensual").upsert({
    periodo: estado.periodo,
    reputacion_level: rep.level_id ?? null,
    reputacion_power_seller: rep.power_seller_status ?? null,
    reputacion_completadas: rep.transactions?.completed ?? 0,
    reputacion_canceladas: rep.transactions?.canceled ?? 0,
    reputacion_pct_positivas: rep.transactions?.ratings?.positive ?? 0,
    reputacion_pct_negativas: rep.transactions?.ratings?.negative ?? 0,
    reputacion_reclamos: metricsMap.get("claims") ?? 0,
    reputacion_demoras: metricsMap.get("delayed_handling_time") ?? 0,
    reputacion_cancelaciones: metricsMap.get("cancellations") ?? 0,
  }, { onConflict: "periodo" });

  if (error) console.error("[ml-metrics] reputation upsert error:", error.message);
  return 1;
}

// ==================== PHASE: AGGREGATE ====================

async function faseAggregate(estado: SyncEstado): Promise<number> {
  const sb = getServerSupabase();
  if (!sb) return 0;

  const periodo = estado.periodo;
  const dateFrom = `${periodo}-01`;
  const dateTo = lastDayOfMonth(periodo);

  // 1. Aggregate orders_history by sku_venta
  const { data: ordenes } = await sb.from("orders_history")
    .select("sku_venta, cantidad, canal, subtotal, comision_total, costo_envio, ingreso_envio, total, fecha")
    .eq("estado", "Pagada")
    .gte("fecha", dateFrom)
    .lte("fecha", dateTo + "T23:59:59.999Z");

  // Group by sku_venta
  const ventasPorSku = new Map<string, {
    unidades: number; ingreso_bruto: number; comisiones: number;
    costo_envio: number; ingreso_envio: number; envios_full: number; envios_flex: number;
  }>();

  for (const o of ordenes || []) {
    const sku = o.sku_venta as string;
    if (!sku) continue;
    const prev = ventasPorSku.get(sku) || {
      unidades: 0, ingreso_bruto: 0, comisiones: 0,
      costo_envio: 0, ingreso_envio: 0, envios_full: 0, envios_flex: 0,
    };
    prev.unidades += (o.cantidad as number) || 0;
    prev.ingreso_bruto += (o.subtotal as number) || 0;
    prev.comisiones += Math.abs((o.comision_total as number) || 0);
    prev.costo_envio += Math.abs((o.costo_envio as number) || 0);
    prev.ingreso_envio += (o.ingreso_envio as number) || 0;
    const canal = (o.canal as string) || "";
    if (canal.toLowerCase().includes("full")) prev.envios_full++;
    else prev.envios_flex++;
    ventasPorSku.set(sku, prev);
  }

  // 2. Get current sku_intelligence data
  const { data: intelRows } = await sb.from("sku_intelligence")
    .select("sku_origen, vel_ponderada, stock_total, cob_total, margen_full_30d, margen_flex_30d, abc, cuadrante");

  const intelMap = new Map<string, Record<string, unknown>>();
  for (const r of intelRows || []) {
    intelMap.set(r.sku_origen as string, r);
  }

  // 3. Load snapshot rows to merge
  const { data: snapshots } = await sb.from("ml_snapshot_mensual")
    .select("*")
    .eq("periodo", periodo);

  // 4. Build updates with sales data + priorities
  const updates: Array<{ item_id: string; [key: string]: unknown }> = [];
  const categoriasMap = new Map<string, string>(); // sku_origen → categoria

  // Load producto categories
  const { data: productos } = await sb.from("productos")
    .select("sku, categoria");
  for (const p of productos || []) {
    categoriasMap.set(p.sku as string, (p.categoria as string) || "Otros");
  }

  for (const snap of snapshots || []) {
    const skuVenta = snap.sku_venta as string;
    const skuOrigen = snap.sku_origen as string;
    const ventas = ventasPorSku.get(skuVenta);
    const intel = intelMap.get(skuOrigen);

    const unidades = ventas?.unidades ?? 0;
    const visitas = (snap.visitas as number) || 0;
    const cvr = visitas > 0 ? Math.round((unidades / visitas) * 10000) / 100 : 0;
    const ingresoBruto = ventas?.ingreso_bruto ?? 0;
    const comisiones = ventas?.comisiones ?? 0;
    const costoEnvio = ventas?.costo_envio ?? 0;
    const ingresoEnvio = ventas?.ingreso_envio ?? 0;
    const ingresoNeto = ingresoBruto - comisiones - costoEnvio + ingresoEnvio;

    const velSemanal = (intel?.vel_ponderada as number) ?? 0;
    const stockCierre = (intel?.stock_total as number) ?? null;
    const cobertura = (intel?.cob_total as number) ?? null;
    const margen30 = ((intel?.margen_full_30d as number) ?? 0) || ((intel?.margen_flex_30d as number) ?? 0);
    const abc = (intel?.abc as string) ?? null;
    const cuadrante = (intel?.cuadrante as string) ?? null;

    const costoEnvioPromedio = unidades > 0 ? Math.round(costoEnvio / unidades) : 0;

    const prioridad = calcularPrioridad({
      ads_activo: (snap.ads_activo as boolean) || false,
      ads_cost: (snap.ads_cost as number) || 0,
      cvr,
      margen_unitario: margen30,
      stock_al_cierre: stockCierre ?? 0,
      reviews_promedio: (snap.reviews_promedio as number) ?? null,
      unidades_vendidas: unidades,
      visitas,
      vel_semanal: velSemanal,
      cobertura_dias: cobertura ?? 999,
    });

    updates.push({
      item_id: snap.item_id as string,
      unidades_vendidas: unidades,
      ingreso_bruto: ingresoBruto,
      comisiones,
      costo_envio_total: costoEnvio,
      ingreso_envio_total: ingresoEnvio,
      ingreso_neto: ingresoNeto,
      cvr,
      envios_full: ventas?.envios_full ?? 0,
      envios_flex: ventas?.envios_flex ?? 0,
      costo_envio_promedio: costoEnvioPromedio,
      vel_semanal: velSemanal,
      stock_al_cierre: stockCierre,
      cobertura_dias: cobertura,
      margen_unitario: margen30,
      abc,
      cuadrante,
      prioridad,
    });
  }

  await batchUpdateSnapshot(periodo, updates);

  // 5. Compute weekly velocity
  await computeVelocidadSemanal(periodo, ordenes || []);

  // 6. Compute benchmarks
  await computeBenchmarks(periodo, snapshots || [], categoriasMap);

  // 7. Compute resumen mensual
  await computeResumenMensual(periodo);

  return updates.length;
}

// ==================== PRIORITY CALCULATION ====================

function calcularPrioridad(row: {
  ads_activo: boolean;
  ads_cost: number;
  cvr: number;
  margen_unitario: number;
  stock_al_cierre: number;
  reviews_promedio: number | null;
  unidades_vendidas: number;
  visitas: number;
  vel_semanal: number;
  cobertura_dias: number;
}): PrioridadMetrica {
  // 1. PAUSAR_ADS: ads activos + (margen < 0 OR CVR < 1%) y tiene inversión
  if (row.ads_activo && row.ads_cost > 0 && (row.margen_unitario < 0 || row.cvr < 1)) {
    return "PAUSAR_ADS";
  }

  // 2. REPONER_STOCK: sin stock + tenía demanda
  if (row.stock_al_cierre === 0 && row.vel_semanal > 2) {
    return "REPONER_STOCK";
  }

  // 3. OPT_FICHA_URGENTE: >500 visitas + CVR < 2%
  if (row.visitas > 500 && row.cvr < 2) {
    return "OPT_FICHA_URGENTE";
  }

  // 4. OPT_FICHA: >200 visitas + CVR < 3%
  if (row.visitas > 200 && row.cvr < 3) {
    return "OPT_FICHA";
  }

  // 5. PROTEGER_STOCK: cobertura < 14 días + vel alta
  if (row.cobertura_dias < 14 && row.vel_semanal > 3 && row.stock_al_cierre > 0) {
    return "PROTEGER_STOCK";
  }

  // 6. PROTEGER_WINNER: margen > 0 + CVR > 5% + stock OK
  if (row.margen_unitario > 0 && row.cvr > 5 && row.stock_al_cierre > 0) {
    return "PROTEGER_WINNER";
  }

  // 7. MONITOREAR: todo lo demás
  return "MONITOREAR";
}

// ==================== AGGREGATION HELPERS ====================

async function computeVelocidadSemanal(
  periodo: string,
  ordenes: Record<string, unknown>[]
): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;

  // Get sku_venta → item_id map
  const { data: mapData } = await sb.from("ml_items_map")
    .select("item_id, sku_venta")
    .eq("activo", true);
  const skuToItem = new Map<string, string>();
  for (const r of mapData || []) {
    if (r.sku_venta) skuToItem.set(r.sku_venta as string, r.item_id as string);
  }

  // Group orders by week + sku_venta
  const weeklyData = new Map<string, { item_id: string; sku_venta: string; unidades: number; ingreso: number }>();

  for (const o of ordenes) {
    const fecha = new Date(o.fecha as string);
    const monday = getMonday(fecha);
    const key = `${skuToItem.get(o.sku_venta as string) || "unknown"}_${monday}`;
    const prev = weeklyData.get(key) || {
      item_id: skuToItem.get(o.sku_venta as string) || "",
      sku_venta: (o.sku_venta as string) || "",
      unidades: 0,
      ingreso: 0,
    };
    prev.unidades += (o.cantidad as number) || 0;
    prev.ingreso += (o.subtotal as number) || 0;
    weeklyData.set(key, prev);
  }

  // Extract semana_inicio from keys
  const rowsWithDate: Array<Record<string, unknown>> = [];
  weeklyData.forEach((val, key) => {
    if (!val.item_id) return;
    const semana = key.split("_").pop()!;
    rowsWithDate.push({
      item_id: val.item_id,
      sku_venta: val.sku_venta,
      semana_inicio: semana,
      unidades: val.unidades,
      ingreso: val.ingreso,
    });
  });

  for (let i = 0; i < rowsWithDate.length; i += UPSERT_CHUNK) {
    const { error } = await sb.from("ml_velocidad_semanal")
      .upsert(rowsWithDate.slice(i, i + UPSERT_CHUNK), { onConflict: "item_id,semana_inicio" });
    if (error) console.error("[ml-metrics] vel semanal upsert error:", error.message);
  }
}

async function computeBenchmarks(
  periodo: string,
  snapshots: Record<string, unknown>[],
  categoriasMap: Map<string, string>
): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;

  const porCategoria = new Map<string, {
    count: number; sumVisitas: number; sumCvr: number; sumUnidades: number;
    sumIngreso: number; sumReview: number; reviewCount: number;
    sumQuality: number; qualityCount: number; conAds: number;
  }>();

  for (const s of snapshots) {
    const cat = categoriasMap.get(s.sku_origen as string) || "Otros";
    const prev = porCategoria.get(cat) || {
      count: 0, sumVisitas: 0, sumCvr: 0, sumUnidades: 0, sumIngreso: 0,
      sumReview: 0, reviewCount: 0, sumQuality: 0, qualityCount: 0, conAds: 0,
    };
    prev.count++;
    prev.sumVisitas += (s.visitas as number) || 0;
    prev.sumCvr += (s.cvr as number) || 0;
    prev.sumUnidades += (s.unidades_vendidas as number) || 0;
    prev.sumIngreso += (s.ingreso_neto as number) || 0;
    if (s.reviews_promedio != null) {
      prev.sumReview += s.reviews_promedio as number;
      prev.reviewCount++;
    }
    if (s.quality_score != null) {
      prev.sumQuality += s.quality_score as number;
      prev.qualityCount++;
    }
    if (s.ads_activo) prev.conAds++;
    porCategoria.set(cat, prev);
  }

  const rows = Array.from(porCategoria.entries()).map(([cat, d]) => ({
    periodo,
    categoria: cat,
    items_count: d.count,
    avg_visitas: d.count > 0 ? Math.round(d.sumVisitas / d.count) : 0,
    avg_cvr: d.count > 0 ? Math.round(d.sumCvr / d.count * 100) / 100 : 0,
    avg_unidades: d.count > 0 ? Math.round(d.sumUnidades / d.count * 10) / 10 : 0,
    avg_ingreso: d.count > 0 ? Math.round(d.sumIngreso / d.count) : 0,
    avg_review_score: d.reviewCount > 0 ? Math.round(d.sumReview / d.reviewCount * 100) / 100 : null,
    avg_quality_score: d.qualityCount > 0 ? Math.round(d.sumQuality / d.qualityCount * 10) / 10 : null,
    pct_con_ads: d.count > 0 ? Math.round(d.conAds / d.count * 10000) / 100 : 0,
  }));

  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await sb.from("ml_benchmarks")
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "periodo,categoria" });
    if (error) console.error("[ml-metrics] benchmarks upsert error:", error.message);
  }
}

async function computeResumenMensual(periodo: string): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;

  const { data: snaps } = await sb.from("ml_snapshot_mensual")
    .select("*")
    .eq("periodo", periodo);

  if (!snaps || snaps.length === 0) return;

  let visitasTotal = 0, unidadesTotal = 0, ingresoBrutoTotal = 0, ingresoNetoTotal = 0;
  let comisionesTotal = 0, costoEnvioTotal = 0;
  let sumCvr = 0, cvrCount = 0, sumReview = 0, reviewCount = 0, sumQuality = 0, qualityCount = 0;
  let conAds = 0, sinStock = 0, adsInversion = 0, adsIngresos = 0;
  let activos = 0, inactivos = 0;
  const priCount: Record<string, number> = {};

  for (const s of snaps) {
    visitasTotal += (s.visitas as number) || 0;
    unidadesTotal += (s.unidades_vendidas as number) || 0;
    ingresoBrutoTotal += (s.ingreso_bruto as number) || 0;
    ingresoNetoTotal += (s.ingreso_neto as number) || 0;
    comisionesTotal += (s.comisiones as number) || 0;
    costoEnvioTotal += (s.costo_envio_total as number) || 0;

    if ((s.visitas as number) > 0) {
      sumCvr += (s.cvr as number) || 0;
      cvrCount++;
    }
    if (s.reviews_promedio != null) {
      sumReview += s.reviews_promedio as number;
      reviewCount++;
    }
    if (s.quality_score != null) {
      sumQuality += s.quality_score as number;
      qualityCount++;
    }
    if (s.ads_activo) {
      conAds++;
      adsInversion += (s.ads_cost as number) || 0;
      adsIngresos += (s.ads_total_amount as number) || 0;
    }
    if ((s.stock_al_cierre as number) === 0 && (s.vel_semanal as number) > 0) sinStock++;

    if ((s.unidades_vendidas as number) > 0 || (s.visitas as number) > 0) activos++;
    else inactivos++;

    const pri = (s.prioridad as string) || "MONITOREAR";
    priCount[pri] = (priCount[pri] || 0) + 1;
  }

  const { error } = await sb.from("ml_resumen_mensual").upsert({
    periodo,
    items_activos: activos,
    items_inactivos: inactivos,
    visitas_total: visitasTotal,
    unidades_total: unidadesTotal,
    ingreso_bruto_total: ingresoBrutoTotal,
    ingreso_neto_total: ingresoNetoTotal,
    comisiones_total: comisionesTotal,
    costo_envio_total: costoEnvioTotal,
    cvr_promedio: cvrCount > 0 ? Math.round(sumCvr / cvrCount * 100) / 100 : 0,
    review_promedio: reviewCount > 0 ? Math.round(sumReview / reviewCount * 100) / 100 : null,
    quality_promedio: qualityCount > 0 ? Math.round(sumQuality / qualityCount * 10) / 10 : null,
    items_con_ads: conAds,
    ads_inversion_total: adsInversion,
    ads_ingresos_total: adsIngresos,
    items_sin_stock: sinStock,
    pri_pausar_ads: priCount["PAUSAR_ADS"] ?? 0,
    pri_reponer_stock: priCount["REPONER_STOCK"] ?? 0,
    pri_opt_ficha_urgente: priCount["OPT_FICHA_URGENTE"] ?? 0,
    pri_opt_ficha: priCount["OPT_FICHA"] ?? 0,
    pri_proteger_stock: priCount["PROTEGER_STOCK"] ?? 0,
    pri_proteger_winner: priCount["PROTEGER_WINNER"] ?? 0,
    pri_monitorear: priCount["MONITOREAR"] ?? 0,
  }, { onConflict: "periodo" });

  if (error) console.error("[ml-metrics] resumen upsert error:", error.message);
}

// ==================== MAIN EXECUTOR ====================

export async function ejecutarFase(estado: SyncEstado): Promise<{
  ok: boolean;
  fase_completada: string;
  items_procesados: number;
  error?: string;
}> {
  const fase = estado.fase;
  if (fase === "idle" || fase === "done" || fase === "error") {
    return { ok: false, fase_completada: fase, items_procesados: 0, error: "No active sync" };
  }

  const config = await getMLConfig();
  if (!config) {
    await updateSyncEstado({ fase: "error", error_msg: "No ML config found" });
    return { ok: false, fase_completada: fase, items_procesados: 0, error: "No ML config" };
  }

  const itemIds = await getActiveItemIds();
  let procesados = 0;

  try {
    console.log(`[ml-metrics] Starting phase: ${fase} (${itemIds.length} items, idx=${estado.ultimo_item_idx})`);

    switch (fase) {
      case "visits":
        procesados = await faseVisitas(estado, itemIds);
        break;
      case "quality":
        procesados = await faseQuality(estado, itemIds);
        break;
      case "reviews":
        procesados = await faseReviews(estado, itemIds);
        break;
      case "questions":
        procesados = await faseQuestions(estado, itemIds);
        break;
      case "ads":
        procesados = await faseAds(estado, config as MLConfig & { advertiser_id?: string });
        break;
      case "reputation":
        procesados = await faseReputation(estado, config);
        break;
      case "aggregate":
        procesados = await faseAggregate(estado);
        break;
      default:
        break;
    }

    const nextFase = siguienteFase(fase);
    await updateSyncEstado({
      fase: nextFase,
      ultimo_item_idx: 0,
      items_procesados: procesados,
      completado_at: nextFase === "done" ? new Date().toISOString() : undefined,
    });

    console.log(`[ml-metrics] Phase ${fase} done (${procesados} items). Next: ${nextFase}`);
    return { ok: true, fase_completada: fase, items_procesados: procesados };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ml-metrics] Phase ${fase} error:`, msg);
    await updateSyncEstado({ fase: "error", error_msg: `${fase}: ${msg}` });
    return { ok: false, fase_completada: fase, items_procesados: procesados, error: msg };
  }
}

/**
 * Self-chaining executor: runs phases sequentially until timeout approaches.
 * Called by the API route cron handler.
 */
export async function ejecutarSyncCompleto(maxMs: number = 240_000): Promise<{
  fases_completadas: string[];
  estado_final: string;
  error?: string;
}> {
  const startTime = Date.now();
  const fasesCompletadas: string[] = [];

  let estado = await getSyncEstado();
  if (!estado || estado.fase === "idle" || estado.fase === "done") {
    return { fases_completadas: [], estado_final: estado?.fase ?? "idle" };
  }

  while (estado && estado.fase !== "idle" && estado.fase !== "done" && estado.fase !== "error") {
    const elapsed = Date.now() - startTime;
    if (elapsed > maxMs) {
      console.log(`[ml-metrics] Time limit reached (${elapsed}ms), pausing after ${fasesCompletadas.length} phases`);
      break;
    }

    const result = await ejecutarFase(estado);
    fasesCompletadas.push(result.fase_completada);

    if (!result.ok) {
      return { fases_completadas: fasesCompletadas, estado_final: "error", error: result.error };
    }

    estado = await getSyncEstado();
  }

  return {
    fases_completadas: fasesCompletadas,
    estado_final: estado?.fase ?? "unknown",
  };
}

// ==================== DATE UTILS ====================

function lastDayOfMonth(periodo: string): string {
  const [year, month] = periodo.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return `${periodo}-${String(lastDay).padStart(2, "0")}`;
}

function getMonday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return date.toISOString().split("T")[0];
}

/**
 * Get the previous month period string (YYYY-MM) for auto-start on day 1-3.
 */
export function getPreviousMonthPeriod(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}
