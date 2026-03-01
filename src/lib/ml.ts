/**
 * MercadoLibre API Integration Library
 * Handles: OAuth tokens, API calls, order processing, stock sync (distributed),
 *          Flex management, cutoff logic, shipping labels.
 * Site: MLC (Chile)
 */
import { getServerSupabase } from "./supabase-server";

const ML_API = "https://api.mercadolibre.com";
const ML_AUTH = "https://auth.mercadolibre.cl"; // Chile
const SITE_ID = "MLC";

// ==================== TYPES ====================

export interface MLConfig {
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

export interface MLOrder {
  id: number;
  date_created: string;
  status: string;
  order_items: Array<{
    item: { id: string; title: string; seller_sku: string | null; variation_id?: number };
    quantity: number;
    unit_price: number;
  }>;
  shipping: {
    id: number;
    logistic_type: string;
  };
  pack_id: number | null;
  buyer: { id: number; nickname: string };
}

export interface MLItemMap {
  id?: string;
  sku: string;
  item_id: string;
  variation_id: number | null;
  user_product_id: string | null;
  activo: boolean;
  ultimo_sync: string | null;
  ultimo_stock_enviado: number | null;
  stock_version: number | null;
}

export interface PedidoFlex {
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

interface StockLocation {
  type: "meli_facility" | "selling_address" | "seller_warehouse";
  quantity: number;
}

interface StockResponse {
  user_product_id: string;
  locations: StockLocation[];
  version: number;
}

/** Shipment detail from /shipments/$ID */
interface MLShipmentDetail {
  id: number;
  status: string;
  substatus?: string;
  logistic_type?: string;
  sender_id?: number;
  receiver_id?: number;
  site_id?: string;
  // From /shipments with x-format-new: true
  logistic?: {
    direction?: string;
    mode?: string;
    type?: string; // "self_service" = Flex
  };
  origin?: {
    type?: string; // "selling_address" | "seller_warehouse"
    sender_id?: number;
    shipping_address?: {
      id?: number; // store/warehouse id — maps to store_id filter
      address_line?: string;
      city?: { name?: string };
      state?: { name?: string };
    };
  };
  destination?: {
    shipping_address?: {
      address_line?: string;
      city?: { name?: string };
      state?: { name?: string };
    };
    receiver_name?: string;
  };
  lead_time?: {
    estimated_handling_limit?: {
      date?: string; // "2026-03-02T00:00:00.000-03:00" — deadline to dispatch
    };
    estimated_delivery_time?: {
      date?: string; // promised delivery to buyer
    };
    buffering?: {
      date?: string; // when label becomes available
    };
  };
}

// ==================== TOKEN MANAGEMENT ====================

export async function getMLConfig(): Promise<MLConfig | null> {
  const sb = getServerSupabase();
  if (!sb) return null;
  const { data } = await sb.from("ml_config").select("*").eq("id", "main").single();
  return data as MLConfig | null;
}

export async function saveMLConfig(updates: Partial<MLConfig>): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  await sb.from("ml_config").upsert({ id: "main", ...updates, updated_at: new Date().toISOString() }, { onConflict: "id" });
}

/**
 * Ensures we have a valid access token. Refreshes if expired.
 * Returns the valid access_token or null if refresh fails.
 */
export async function ensureValidToken(): Promise<string | null> {
  const config = await getMLConfig();
  if (!config || !config.access_token) return null;

  const expiresAt = new Date(config.token_expires_at).getTime();
  const now = Date.now();

  // Refresh 5 minutes before actual expiration for safety
  if (now < expiresAt - 5 * 60 * 1000) {
    return config.access_token;
  }

  // Token expired or about to expire - refresh
  console.log("[ML] Token expired, refreshing...");
  try {
    const resp = await fetch(`${ML_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: config.refresh_token,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error("[ML] Token refresh failed:", resp.status, err);
      return null;
    }

    const data = await resp.json();
    const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

    await saveMLConfig({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: newExpiry,
    });

    console.log("[ML] Token refreshed successfully, expires:", newExpiry);
    return data.access_token;
  } catch (err) {
    console.error("[ML] Token refresh error:", err);
    return null;
  }
}

/**
 * Exchange authorization code for tokens (OAuth callback)
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<boolean> {
  const config = await getMLConfig();
  if (!config) return false;

  try {
    const resp = await fetch(`${ML_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.client_id,
        client_secret: config.client_secret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!resp.ok) {
      console.error("[ML] Code exchange failed:", resp.status, await resp.text());
      return false;
    }

    const data = await resp.json();
    await saveMLConfig({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      seller_id: String(data.user_id),
    });

    console.log("[ML] OAuth complete, seller_id:", data.user_id);
    return true;
  } catch (err) {
    console.error("[ML] Code exchange error:", err);
    return false;
  }
}

// ==================== API CALLS ====================

/**
 * Make authenticated GET request to ML API
 */
export async function mlGet<T = unknown>(path: string, extraHeaders?: Record<string, string>): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });

  if (!resp.ok) {
    console.error(`[ML] GET ${path} failed:`, resp.status);
    return null;
  }

  return resp.json() as Promise<T>;
}

/**
 * Make authenticated PUT request to ML API
 */
export async function mlPut<T = unknown>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[ML] PUT ${path} failed:`, resp.status, errText);
    // Return status info for conflict handling
    if (resp.status === 409) {
      throw new Error(`VERSION_CONFLICT: ${errText}`);
    }
    return null;
  }

  return resp.json() as Promise<T>;
}

/**
 * Make authenticated POST request to ML API
 */
export async function mlPost<T = unknown>(path: string, body?: unknown): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    console.error(`[ML] POST ${path} failed:`, resp.status, await resp.text());
    return null;
  }

  return resp.json() as Promise<T>;
}

/**
 * Make authenticated DELETE request to ML API
 */
export async function mlDelete(path: string): Promise<boolean> {
  const token = await ensureValidToken();
  if (!token) return false;

  const resp = await fetch(`${ML_API}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error(`[ML] DELETE ${path} failed:`, resp.status, await resp.text());
    return false;
  }

  return true;
}

// ==================== SHIPMENT VERIFICATION ====================

/**
 * Get shipment details to determine the real logistic type.
 * Tries /shipments/$ID first (returns logistic_type at top level),
 * then enriches with /marketplace/shipments/$ID (x-format-new: true) for origin info.
 * Returns the logistic type and origin warehouse info.
 */
export interface ShipmentFlexInfo {
  logistic_type: string;
  origin_type: string | null;
  origin_address: string | null;
  store_id: number | null;            // origin shipping_address.id — bodega/tienda
  is_flex: boolean;
  handling_limit_date: string | null; // YYYY-MM-DD — deadline to dispatch
  delivery_date: string | null;       // YYYY-MM-DD — promised to buyer
  shipment_status: string | null;
  raw: MLShipmentDetail | null;
}

export async function getShipmentFlexInfo(shippingId: number): Promise<ShipmentFlexInfo> {
  const fallback: ShipmentFlexInfo = { logistic_type: "unknown", origin_type: null, origin_address: null, store_id: null, is_flex: false, handling_limit_date: null, delivery_date: null, shipment_status: null, raw: null };

  // Use x-format-new: true for richer data (logistic.type, origin, lead_time)
  const shipment = await mlGet<MLShipmentDetail>(
    `/shipments/${shippingId}`,
    { "x-format-new": "true" }
  );
  if (!shipment) return fallback;

  // Determine logistic type: prefer logistic.type (new format), fallback to logistic_type (old)
  const logisticType = shipment.logistic?.type || shipment.logistic_type || "unknown";

  const originType = shipment.origin?.type || null;
  const originAddr = shipment.origin?.shipping_address;
  const originAddress = originAddr
    ? [originAddr.address_line, originAddr.city?.name, originAddr.state?.name].filter(Boolean).join(", ")
    : null;
  const storeId = originAddr?.id || null;

  // Extract handling limit date (YYYY-MM-DD)
  let handlingLimitDate: string | null = null;
  if (shipment.lead_time?.estimated_handling_limit?.date) {
    handlingLimitDate = shipment.lead_time.estimated_handling_limit.date.slice(0, 10);
  }

  let deliveryDate: string | null = null;
  if (shipment.lead_time?.estimated_delivery_time?.date) {
    deliveryDate = shipment.lead_time.estimated_delivery_time.date.slice(0, 10);
  }

  return {
    logistic_type: logisticType,
    origin_type: originType,
    origin_address: originAddress,
    store_id: storeId,
    is_flex: logisticType === "self_service",
    handling_limit_date: handlingLimitDate,
    delivery_date: deliveryDate,
    shipment_status: shipment.status || null,
    raw: shipment,
  };
}

// ==================== CUTOFF LOGIC ====================

/**
 * Calculate fecha_armado based on sale date and cutoff hours.
 * Uses Chile timezone (America/Santiago).
 */
export function calcFechaArmado(fechaVenta: string | Date, horaCorteVL: number, horaCorteSab: number): string {
  const sale = new Date(fechaVenta);
  // Convert to Chile time
  const chileTime = new Date(sale.toLocaleString("en-US", { timeZone: "America/Santiago" }));
  const dayOfWeek = chileTime.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const hour = chileTime.getHours();

  let armadoDate = new Date(chileTime);
  armadoDate.setHours(0, 0, 0, 0);

  if (dayOfWeek === 0) {
    // Sunday → Monday
    armadoDate.setDate(armadoDate.getDate() + 1);
  } else if (dayOfWeek === 6) {
    // Saturday
    if (hour < horaCorteSab) {
      // Before cutoff → today
    } else {
      // After cutoff → Monday
      armadoDate.setDate(armadoDate.getDate() + 2);
    }
  } else {
    // Monday to Friday
    if (hour < horaCorteVL) {
      // Before cutoff → today
    } else {
      // After cutoff → next business day
      if (dayOfWeek === 5) {
        // Friday after cutoff → Monday
        armadoDate.setDate(armadoDate.getDate() + 3);
      } else {
        armadoDate.setDate(armadoDate.getDate() + 1);
      }
    }
  }

  return armadoDate.toISOString().slice(0, 10);
}

// ==================== SHIPMENT-CENTRIC ORDER PROCESSING ====================

/**
 * Process a single shipment: fetch details, verify it's not fulfillment,
 * get handling_limit + items, upsert to ml_shipments + ml_shipment_items.
 * Handles packs (multiple orders sharing one shipment).
 * Returns item count and the shipment info (for callers that need it).
 */
export async function processShipment(shipmentId: number, orderIds: number[]): Promise<{ items: number; shipInfo: ShipmentFlexInfo }> {
  const sb = getServerSupabase();
  if (!sb) return { items: 0, shipInfo: { logistic_type: "unknown", origin_type: null, origin_address: null, store_id: null, is_flex: false, handling_limit_date: null, delivery_date: null, shipment_status: null, raw: null } };

  // 1. Fetch shipment details (logistic type, handling_limit, origin, destination)
  const shipInfo = await getShipmentFlexInfo(shipmentId);

  // Skip fulfillment (ML handles it) and unknown
  if (shipInfo.logistic_type === "fulfillment" || shipInfo.logistic_type === "unknown") {
    return { items: 0, shipInfo };
  }

  // 2. Upsert ml_shipments
  const shipmentRow = {
    shipment_id: shipmentId,
    order_ids: orderIds,
    status: shipInfo.raw?.status || "unknown",
    substatus: shipInfo.raw?.substatus || null,
    logistic_type: shipInfo.logistic_type,
    handling_limit: shipInfo.raw?.lead_time?.estimated_handling_limit?.date || null,
    buffering_date: shipInfo.raw?.lead_time?.buffering?.date || null,
    delivery_date: shipInfo.raw?.lead_time?.estimated_delivery_time?.date || null,
    origin_type: shipInfo.origin_type,
    store_id: shipInfo.store_id,
    receiver_name: shipInfo.raw?.destination?.receiver_name || null,
    destination_city: shipInfo.raw?.destination?.shipping_address?.city?.name || null,
    updated_at: new Date().toISOString(),
  };

  const { error: shipErr } = await sb.from("ml_shipments").upsert(shipmentRow, {
    onConflict: "shipment_id",
  });
  if (shipErr) {
    console.error(`[ML] Upsert ml_shipments error for ${shipmentId}:`, shipErr.message);
    return { items: 0, shipInfo };
  }

  // 3. For each order, fetch order details and upsert items
  let totalItems = 0;
  for (const orderId of orderIds) {
    const order = await mlGet<MLOrder>(`/orders/${orderId}`);
    if (!order || !order.order_items) continue;

    for (const item of order.order_items) {
      const itemRow = {
        shipment_id: shipmentId,
        order_id: orderId,
        item_id: item.item.id,
        title: item.item.title,
        seller_sku: (item.item.seller_sku || `ML-${item.item.id}`).toUpperCase(),
        variation_id: item.item.variation_id || null,
        quantity: item.quantity,
      };

      const { error: itemErr } = await sb.from("ml_shipment_items").upsert(itemRow, {
        onConflict: "shipment_id,order_id,item_id",
      });
      if (itemErr) {
        console.error(`[ML] Upsert ml_shipment_items error:`, itemErr.message);
      } else {
        totalItems++;
      }
    }
  }

  const ltLabel = shipInfo.logistic_type === "self_service" ? "Flex"
    : shipInfo.logistic_type === "cross_docking" ? "Colecta"
    : shipInfo.logistic_type === "xd_drop_off" ? "Drop-off"
    : shipInfo.logistic_type;
  console.log(`[ML] Shipment ${shipmentId}: ${ltLabel}, ${totalItems} items, handling_limit=${shipInfo.handling_limit_date}`);

  return { items: totalItems, shipInfo };
}

/**
 * Process a single ML order: extract shipment_id, delegate to processShipment.
 * Also upserts to legacy pedidos_flex for backward compat.
 */
export async function processOrder(order: MLOrder, config: MLConfig): Promise<number> {
  if (order.status !== "paid") return 0;
  if (!order.shipping?.id) return 0;

  // Process via new shipment-centric system (returns shipInfo to avoid redundant API call)
  const { items: shipmentItems, shipInfo } = await processShipment(order.shipping.id, [order.id]);

  // Also upsert to legacy pedidos_flex for backward compat
  if (shipInfo.logistic_type !== "fulfillment" && shipInfo.logistic_type !== "unknown") {
    const sb = getServerSupabase();
    if (sb) {
      const fechaArmado = shipInfo.handling_limit_date
        || calcFechaArmado(order.date_created, config.hora_corte_lv, config.hora_corte_sab);

      for (const item of order.order_items) {
        const skuVenta = item.item.seller_sku || `ML-${item.item.id}`;
        await sb.from("pedidos_flex").upsert({
          order_id: order.id,
          fecha_venta: order.date_created,
          fecha_armado: fechaArmado,
          estado: "PENDIENTE",
          sku_venta: skuVenta.toUpperCase(),
          nombre_producto: item.item.title,
          cantidad: item.quantity,
          shipping_id: order.shipping.id,
          pack_id: order.pack_id,
          buyer_nickname: order.buyer?.nickname || "",
          raw_data: order,
          picking_session_id: null,
          etiqueta_url: null,
        }, { onConflict: "order_id,sku_venta" });
      }
    }
  }

  return shipmentItems;
}

/**
 * Fetch and process a single order by ID
 */
export async function fetchAndProcessOrder(orderId: number): Promise<number> {
  const config = await getMLConfig();
  if (!config) return 0;

  const order = await mlGet<MLOrder>(`/orders/${orderId}`);
  if (!order) return 0;

  return processOrder(order, config);
}

/**
 * Collect orders from search results, deduplicate by shipment_id,
 * and process each shipment once (handling packs correctly).
 */
async function processOrderBatch(orders: MLOrder[], config: MLConfig): Promise<{ processed: number; skipped: number; items: number }> {
  // Group orders by shipment_id (packs share the same shipment)
  const shipmentMap = new Map<number, number[]>(); // shipment_id → [order_id, ...]
  for (const order of orders) {
    if (order.status !== "paid" || !order.shipping?.id) continue;
    const sid = order.shipping.id;
    const existing = shipmentMap.get(sid) || [];
    if (!existing.includes(order.id)) existing.push(order.id);
    shipmentMap.set(sid, existing);
  }

  let processed = 0;
  let skipped = 0;
  let items = 0;

  // Process each shipment and collect shipInfo for legacy compat
  const shipInfoCache = new Map<number, ShipmentFlexInfo>();
  const entries = Array.from(shipmentMap.entries());
  for (const entry of entries) {
    const result = await processShipment(entry[0], entry[1]);
    shipInfoCache.set(entry[0], result.shipInfo);
    if (result.items > 0) {
      processed++;
      items += result.items;
    } else {
      skipped++;
    }
  }

  // Also process via legacy path for backward compat (reusing cached shipInfo)
  const sb = getServerSupabase();
  if (sb) {
    for (const order of orders) {
      if (order.status !== "paid" || !order.shipping?.id) continue;
      const shipInfo = shipInfoCache.get(order.shipping.id);
      if (shipInfo && shipInfo.logistic_type !== "fulfillment" && shipInfo.logistic_type !== "unknown") {
        const fechaArmado = shipInfo.handling_limit_date
          || calcFechaArmado(order.date_created, config.hora_corte_lv, config.hora_corte_sab);
        for (const item of order.order_items) {
          const skuVenta = item.item.seller_sku || `ML-${item.item.id}`;
          await sb.from("pedidos_flex").upsert({
            order_id: order.id, fecha_venta: order.date_created, fecha_armado: fechaArmado,
            estado: "PENDIENTE", sku_venta: skuVenta.toUpperCase(), nombre_producto: item.item.title,
            cantidad: item.quantity, shipping_id: order.shipping.id, pack_id: order.pack_id,
            buyer_nickname: order.buyer?.nickname || "", raw_data: order,
            picking_session_id: null, etiqueta_url: null,
          }, { onConflict: "order_id,sku_venta" });
        }
      }
    }
  }

  return { processed, skipped, items };
}

/**
 * Refresh status of shipments still marked as ready_to_ship in Supabase.
 * Queries the ML API for current status and updates the DB.
 * This cleans up shipments that were shipped/delivered but not updated.
 */
async function refreshShipmentStatuses(): Promise<{ checked: number; updated: number }> {
  const sb = getServerSupabase();
  if (!sb) return { checked: 0, updated: 0 };

  // Get all shipments still in ready_to_ship
  const { data: stale } = await sb.from("ml_shipments").select("shipment_id")
    .eq("status", "ready_to_ship");

  if (!stale || stale.length === 0) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const row of stale) {
    const shipment = await mlGet<{ id: number; status: string; substatus?: string }>(
      `/shipments/${row.shipment_id}`,
      { "x-format-new": "true" }
    );
    if (!shipment) continue;

    // Only update if status actually changed
    if (shipment.status && shipment.status !== "ready_to_ship") {
      await sb.from("ml_shipments").update({
        status: shipment.status,
        substatus: shipment.substatus || null,
        updated_at: new Date().toISOString(),
      }).eq("shipment_id", row.shipment_id);
      updated++;
      console.log(`[ML] Shipment ${row.shipment_id}: ready_to_ship → ${shipment.status}`);
    }
  }

  return { checked: stale.length, updated };
}

/**
 * Sync recent orders via search API (polling backup)
 */
export async function syncRecentOrders(): Promise<{ total: number; new_orders: number }> {
  const config = await getMLConfig();
  if (!config || !config.seller_id) return { total: 0, new_orders: 0 };

  // 1. Refresh status of existing shipments (clean up shipped/delivered)
  const refresh = await refreshShipmentStatuses();
  if (refresh.updated > 0) {
    console.log(`[ML Sync] Refreshed ${refresh.updated}/${refresh.checked} shipment statuses`);
  }

  // 2. Fetch new orders
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const searchUrl = `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${twoHoursAgo}`;

  const result = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(searchUrl);
  if (!result) return { total: 0, new_orders: 0 };

  const batch = await processOrderBatch(result.results, config);
  return { total: result.paging.total, new_orders: batch.items };
}

/**
 * Sync historical orders (past N days) with pagination.
 * Shipment-centric: deduplicates by shipment_id to handle packs.
 */
export async function syncHistoricalOrders(days: number = 7): Promise<{ total: number; new_orders: number; pages: number; shipments_processed: number; shipments_skipped: number }> {
  const config = await getMLConfig();
  if (!config || !config.seller_id) return { total: 0, new_orders: 0, pages: 0, shipments_processed: 0, shipments_skipped: 0 };

  // Refresh status of existing shipments first
  const refresh = await refreshShipmentStatuses();
  if (refresh.updated > 0) {
    console.log(`[ML Sync] Refreshed ${refresh.updated}/${refresh.checked} shipment statuses`);
  }

  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${dateFrom}&limit=50`;

  let totalOrders = 0;
  let totalItems = 0;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let pages = 0;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = `${baseUrl}&offset=${offset}`;
    const result = await mlGet<{ results: MLOrder[]; paging: { total: number; offset: number; limit: number } }>(url);
    if (!result || !result.results) break;

    pages++;
    totalOrders = result.paging.total;

    const batch = await processOrderBatch(result.results, config);
    totalProcessed += batch.processed;
    totalSkipped += batch.skipped;
    totalItems += batch.items;

    offset += result.results.length;
    hasMore = offset < result.paging.total && result.results.length > 0;
    if (pages >= 20) break;
  }

  return { total: totalOrders, new_orders: totalItems, pages, shipments_processed: totalProcessed, shipments_skipped: totalSkipped };
}

/**
 * Diagnose ML connection: token, seller info, subscriptions, recent orders.
 * Returns detailed diagnostic info.
 */
export async function diagnoseMlConnection(): Promise<{
  token_status: "valid" | "expired" | "missing" | "refresh_failed";
  token_expires_at: string | null;
  seller_id: string | null;
  seller_nickname: string | null;
  flex_subscription: { active: boolean; service_id: number | null } | null;
  recent_orders_total: number;
  recent_orders_flex: number;
  recent_orders_other: number;
  sample_orders: Array<{ id: number; date: string; logistic_type: string; status: string; items: number; shipping_id: number; origin_type: string | null; origin_address: string | null; handling_limit_date: string | null }>;
  shipment_sample: unknown | null;
  errors: string[];
}> {
  const errors: string[] = [];
  const result = {
    token_status: "missing" as "valid" | "expired" | "missing" | "refresh_failed",
    token_expires_at: null as string | null,
    seller_id: null as string | null,
    seller_nickname: null as string | null,
    flex_subscription: null as { active: boolean; service_id: number | null } | null,
    recent_orders_total: 0,
    recent_orders_flex: 0,
    recent_orders_other: 0,
    sample_orders: [] as Array<{ id: number; date: string; logistic_type: string; status: string; items: number; shipping_id: number; origin_type: string | null; origin_address: string | null; handling_limit_date: string | null }>,
    shipment_sample: null as unknown | null,
    errors,
  };

  // 1. Check config exists
  const config = await getMLConfig();
  if (!config || !config.access_token) {
    errors.push("No hay configuración ML o falta access_token");
    return result;
  }

  result.seller_id = config.seller_id;
  result.token_expires_at = config.token_expires_at;

  // 2. Check token validity
  const token = await ensureValidToken();
  if (!token) {
    result.token_status = "refresh_failed";
    errors.push("Token expirado y no se pudo refrescar. Re-vincular cuenta ML.");
    return result;
  }

  const expiresAt = new Date(config.token_expires_at).getTime();
  result.token_status = Date.now() < expiresAt ? "valid" : "valid"; // just refreshed

  // 3. Verify seller identity
  const me = await mlGet<{ id: number; nickname: string; site_id: string }>("/users/me");
  if (me) {
    result.seller_nickname = me.nickname;
    if (config.seller_id && String(me.id) !== config.seller_id) {
      errors.push(`Seller ID mismatch: config=${config.seller_id}, API=${me.id}`);
    }
  } else {
    errors.push("No se pudo obtener /users/me — posible problema de permisos");
  }

  // 4. Check Flex subscription
  if (config.seller_id) {
    const subs = await mlGet<{ subscriptions?: Array<{ service_id: number; status: string }> }>(
      `/shipping/flex/sites/${SITE_ID}/users/${config.seller_id}/subscriptions/v1`
    );
    if (subs?.subscriptions && subs.subscriptions.length > 0) {
      const activeSub = subs.subscriptions.find(s => s.status === "active");
      result.flex_subscription = {
        active: !!activeSub,
        service_id: activeSub?.service_id || subs.subscriptions[0]?.service_id || null,
      };
      if (!activeSub) {
        errors.push(`Suscripción Flex encontrada pero estado: ${subs.subscriptions[0]?.status} (no active)`);
      }
    } else {
      errors.push("No se encontró suscripción Flex activa para este seller");
      result.flex_subscription = { active: false, service_id: null };
    }
  }

  // 5. Search recent orders (last 7 days) to see what exists
  if (config.seller_id) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const ordersResp = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(
      `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${sevenDaysAgo}&limit=50`
    );

    if (ordersResp) {
      result.recent_orders_total = ordersResp.paging.total;

      // For each sample order, verify logistic type via shipment endpoint
      for (const order of ordersResp.results) {
        let lt = order.shipping?.logistic_type || "unknown";
        let originType: string | null = null;
        let originAddress: string | null = null;
        let handlingLimitDate: string | null = null;

        // For sample orders (first 10), verify via shipment endpoint
        if (result.sample_orders.length < 10 && order.shipping?.id) {
          const shipInfo = await getShipmentFlexInfo(order.shipping.id);
          lt = shipInfo.logistic_type;
          originType = shipInfo.origin_type;
          originAddress = shipInfo.origin_address;
          handlingLimitDate = shipInfo.handling_limit_date;

          // Save first shipment as sample
          if (!result.shipment_sample && shipInfo.raw) {
            result.shipment_sample = shipInfo.raw;
          }
        }

        if (lt === "self_service") {
          result.recent_orders_flex++;
        } else {
          result.recent_orders_other++;
        }

        // Add to sample (max 10)
        if (result.sample_orders.length < 10) {
          result.sample_orders.push({
            id: order.id,
            date: order.date_created,
            logistic_type: lt,
            status: order.status,
            items: order.order_items?.length || 0,
            shipping_id: order.shipping?.id || 0,
            origin_type: originType,
            origin_address: originAddress,
            handling_limit_date: handlingLimitDate,
          });
        }
      }

      if (result.recent_orders_flex === 0 && result.recent_orders_total > 0) {
        const types = Array.from(new Set(ordersResp.results.map(o => o.shipping?.logistic_type || "N/A")));
        errors.push(`Se encontraron ${result.recent_orders_total} órdenes pero NINGUNA es Flex (self_service) según /orders/search. Tipos en orders: ${types.join(", ")}. Verificamos via /shipments para confirmar.`);
      }
    } else {
      errors.push("No se pudo consultar /orders/search — verificar permisos de la app ML");
    }
  }

  return result;
}

// ==================== STOCK SYNC — Distributed Stock API ====================

/**
 * Get the user_product_id for an item from ML API.
 * The user_product_id is needed for the distributed stock endpoints.
 */
export async function getItemUserProductId(itemId: string): Promise<string | null> {
  const item = await mlGet<{ user_product_id?: string }>(`/items/${itemId}?attributes=user_product_id`);
  return item?.user_product_id || null;
}

/**
 * Get current stock from the distributed stock API.
 * Returns locations with quantities and the version for optimistic concurrency.
 */
export async function getDistributedStock(userProductId: string): Promise<StockResponse | null> {
  const data = await mlGet<StockResponse>(`/user-products/${userProductId}/stock`);
  if (!data) return null;

  // Extract version from response
  return {
    user_product_id: userProductId,
    locations: data.locations || [],
    version: data.version || 0,
  };
}

/**
 * Update Flex stock (selling_address) using the distributed stock API.
 * Requires x-version header for optimistic concurrency.
 * Returns true on success, throws on version conflict (409).
 */
export async function updateFlexStock(
  userProductId: string,
  quantity: number,
  version: number
): Promise<boolean> {
  const result = await mlPut(
    `/user-products/${userProductId}/stock/type/selling_address`,
    { quantity },
    { "x-version": String(version) }
  );
  return result !== null;
}

/**
 * Sync stock for a single SKU to all its ML items.
 * Uses the distributed stock API with versioning.
 * Returns number of successful updates.
 */
export async function syncStockToML(sku: string, availableQty: number): Promise<number> {
  const sb = getServerSupabase();
  if (!sb) return 0;

  const { data: mappings } = await sb.from("ml_items_map")
    .select("*")
    .eq("sku", sku)
    .eq("activo", true);

  if (!mappings || mappings.length === 0) return 0;

  let synced = 0;

  for (const map of mappings as MLItemMap[]) {
    // Safety: if stock is 0 but last sent was >10, skip auto-sync (needs manual review)
    if (availableQty === 0 && map.ultimo_stock_enviado && map.ultimo_stock_enviado > 10) {
      console.warn(`[ML Stock] Safety block: ${sku} → 0 (was ${map.ultimo_stock_enviado}). Skipping.`);
      continue;
    }

    try {
      // 1. Resolve user_product_id if we don't have it yet
      let userProductId = map.user_product_id;
      if (!userProductId) {
        userProductId = await getItemUserProductId(map.item_id);
        if (!userProductId) {
          console.error(`[ML Stock] Cannot resolve user_product_id for item ${map.item_id}`);
          continue;
        }
        // Save it for future calls
        await sb.from("ml_items_map").update({ user_product_id: userProductId }).eq("id", map.id);
      }

      // 2. GET current stock to obtain version
      const stockData = await getDistributedStock(userProductId);
      if (!stockData) {
        console.error(`[ML Stock] Cannot read stock for ${userProductId}`);
        continue;
      }

      // 3. PUT with x-version header
      const success = await updateFlexStock(userProductId, availableQty, stockData.version);

      if (success) {
        await sb.from("ml_items_map").update({
          ultimo_sync: new Date().toISOString(),
          ultimo_stock_enviado: availableQty,
          stock_version: stockData.version + 1,
        }).eq("id", map.id);
        synced++;
      }
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("VERSION_CONFLICT")) {
        // 409: version mismatch — retry once with fresh version
        console.warn(`[ML Stock] Version conflict for ${sku}, retrying...`);
        try {
          const userProductId = map.user_product_id!;
          const freshStock = await getDistributedStock(userProductId);
          if (freshStock) {
            const retrySuccess = await updateFlexStock(userProductId, availableQty, freshStock.version);
            if (retrySuccess) {
              await sb.from("ml_items_map").update({
                ultimo_sync: new Date().toISOString(),
                ultimo_stock_enviado: availableQty,
                stock_version: freshStock.version + 1,
              }).eq("id", map.id);
              synced++;
            }
          }
        } catch (retryErr) {
          console.error(`[ML Stock] Retry also failed for ${sku}:`, retryErr);
        }
      } else {
        console.error(`[ML Stock] Error syncing ${sku}:`, err);
      }
    }
  }

  return synced;
}

// ==================== FLEX MANAGEMENT ====================

/**
 * Get Flex subscription info for the seller.
 * GET /shipping/flex/sites/MLC/users/$USER_ID/subscriptions/v1
 */
export async function getFlexSubscription(): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlGet(`/shipping/flex/sites/${SITE_ID}/users/${config.seller_id}/subscriptions/v1`);
}

/**
 * Get Flex service configuration (delivery zones, capacity, etc.)
 */
export async function getFlexConfig(serviceId: string): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlGet(`/shipping/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configuration/delivery/custom/v3`);
}

/**
 * Update Flex delivery configuration.
 * PUT /shipping/flex/sites/MLC/users/$USER_ID/services/$SERVICE_ID/configuration/delivery/custom/v3
 */
export async function updateFlexConfig(serviceId: string, configData: unknown): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlPut(
    `/shipping/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configuration/delivery/custom/v3`,
    configData
  );
}

/**
 * Get Flex holidays (days when Flex is paused).
 * GET /flex/sites/MLC/users/$USER_ID/services/$SERVICE_ID/configurations/holidays/v1
 */
export async function getFlexHolidays(serviceId: string): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlGet(`/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configurations/holidays/v1`);
}

/**
 * Update Flex holidays.
 * PUT /flex/sites/MLC/users/$USER_ID/services/$SERVICE_ID/configurations/holidays/v1
 */
export async function updateFlexHolidays(serviceId: string, holidays: unknown): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlPut(
    `/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configurations/holidays/v1`,
    holidays
  );
}

/**
 * Activate an item for Flex shipping.
 * POST /flex/sites/MLC/items/$ITEM_ID/v2
 */
export async function activateFlexItem(itemId: string): Promise<boolean> {
  const result = await mlPost(`/flex/sites/${SITE_ID}/items/${itemId}/v2`);
  return result !== null;
}

/**
 * Deactivate an item from Flex shipping.
 * DELETE /flex/sites/MLC/items/$ITEM_ID/v2
 */
export async function deactivateFlexItem(itemId: string): Promise<boolean> {
  return mlDelete(`/flex/sites/${SITE_ID}/items/${itemId}/v2`);
}

// ==================== SHIPPING LABELS ====================

/**
 * Get shipment details to verify status before printing labels.
 * The shipment must be in ready_to_ship/ready_to_print with logistic_type: self_service.
 */
export async function getShipmentStatus(shippingId: number): Promise<{
  id: number;
  status: string;
  logistic_type: string;
  ready: boolean;
} | null> {
  const data = await mlGet<{ id: number; status: string; logistic_type: string }>(`/shipments/${shippingId}`);
  if (!data) return null;
  return {
    id: data.id,
    status: data.status,
    logistic_type: data.logistic_type,
    ready: (data.status === "ready_to_ship" || data.status === "ready_to_print") &&
           data.logistic_type === "self_service",
  };
}

/**
 * Download shipping labels PDF for multiple shipment IDs.
 * ML allows up to 50 IDs per request.
 */
export async function getShippingLabelsPdf(shippingIds: number[]): Promise<ArrayBuffer | null> {
  const token = await ensureValidToken();
  if (!token || shippingIds.length === 0) return null;

  const ids = shippingIds.slice(0, 50).join(",");
  const resp = await fetch(`${ML_API}/shipment_labels?shipment_ids=${ids}&response_type=pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error("[ML] Labels PDF download failed:", resp.status);
    return null;
  }

  return resp.arrayBuffer();
}

/**
 * Download shipping labels in ZPL format (for Zebra thermal printers).
 * ML allows up to 50 IDs per request.
 */
export async function getShippingLabelsZpl(shippingIds: number[]): Promise<string | null> {
  const token = await ensureValidToken();
  if (!token || shippingIds.length === 0) return null;

  const ids = shippingIds.slice(0, 50).join(",");
  const resp = await fetch(`${ML_API}/shipment_labels?shipment_ids=${ids}&response_type=zpl2`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error("[ML] Labels ZPL download failed:", resp.status);
    return null;
  }

  return resp.text();
}

// ==================== OAUTH URL ====================

export function getOAuthUrl(clientId: string, redirectUri: string): string {
  return `${ML_AUTH}/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}
