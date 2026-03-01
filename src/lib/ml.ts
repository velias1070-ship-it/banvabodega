/**
 * MercadoLibre API Integration Library
 * Handles: OAuth tokens, API calls, order processing, stock sync, cutoff logic
 */
import { getServerSupabase } from "./supabase-server";

const ML_API = "https://api.mercadolibre.com";
const ML_AUTH = "https://auth.mercadolibre.cl"; // Chile

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
export async function mlGet<T = unknown>(path: string): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
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
export async function mlPut<T = unknown>(path: string, body: unknown): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetch(`${ML_API}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error(`[ML] PUT ${path} failed:`, resp.status, await resp.text());
    return null;
  }

  return resp.json() as Promise<T>;
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

// ==================== ORDER PROCESSING ====================

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

/**
 * Process a single ML order: validate it's Flex, extract items, upsert to DB.
 * Returns number of items upserted.
 */
export async function processOrder(order: MLOrder, config: MLConfig): Promise<number> {
  // Only process Flex (self_service) orders
  if (order.shipping?.logistic_type !== "self_service") return 0;
  // Only process paid orders
  if (order.status !== "paid") return 0;

  const sb = getServerSupabase();
  if (!sb) return 0;

  const fechaArmado = calcFechaArmado(order.date_created, config.hora_corte_lv, config.hora_corte_sab);
  let count = 0;

  for (const item of order.order_items) {
    const skuVenta = item.item.seller_sku || `ML-${item.item.id}`;
    const pedido: Omit<PedidoFlex, "id" | "created_at"> = {
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
    };

    // Upsert by order_id + sku_venta (a cart can have multiple items)
    const { error } = await sb.from("pedidos_flex").upsert(pedido, {
      onConflict: "order_id,sku_venta",
    });

    if (error) {
      console.error("[ML] Upsert pedido error:", error.message);
    } else {
      count++;
    }
  }

  return count;
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
 * Sync recent orders via search API (polling backup)
 */
export async function syncRecentOrders(): Promise<{ total: number; new_orders: number }> {
  const config = await getMLConfig();
  if (!config || !config.seller_id) return { total: 0, new_orders: 0 };

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const searchUrl = `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${twoHoursAgo}`;

  const result = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(searchUrl);
  if (!result) return { total: 0, new_orders: 0 };

  let newOrders = 0;
  for (const order of result.results) {
    const count = await processOrder(order, config);
    newOrders += count;
  }

  return { total: result.paging.total, new_orders: newOrders };
}

// ==================== STOCK SYNC (Phase 2) ====================

export interface MLItemMap {
  id?: string;
  sku: string;
  item_id: string;
  variation_id: number | null;
  activo: boolean;
  ultimo_sync: string | null;
  ultimo_stock_enviado: number | null;
}

/**
 * Sync stock for a single SKU to all its ML items.
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

  // Safety: if stock is 0 but last sent was >10, skip auto-sync (needs manual review)
  for (const map of mappings) {
    if (availableQty === 0 && map.ultimo_stock_enviado && map.ultimo_stock_enviado > 10) {
      console.warn(`[ML Stock] Safety block: ${sku} → 0 (was ${map.ultimo_stock_enviado}). Skipping.`);
      continue;
    }

    let success: unknown;
    if (map.variation_id) {
      success = await mlPut(`/items/${map.item_id}/variations/${map.variation_id}`, {
        available_quantity: availableQty,
      });
    } else {
      success = await mlPut(`/items/${map.item_id}/stock`, {
        available_quantity: availableQty,
      });
    }

    if (success) {
      await sb.from("ml_items_map").update({
        ultimo_sync: new Date().toISOString(),
        ultimo_stock_enviado: availableQty,
      }).eq("id", map.id);
    }
  }

  return mappings.length;
}

// ==================== SHIPPING LABELS (Phase 3) ====================

/**
 * Download shipping labels PDF for multiple shipment IDs.
 * Returns the PDF as a Blob/ArrayBuffer URL or null.
 */
export async function getShippingLabelsPdf(shippingIds: number[]): Promise<ArrayBuffer | null> {
  const token = await ensureValidToken();
  if (!token || shippingIds.length === 0) return null;

  // ML allows up to 50 IDs per request
  const ids = shippingIds.slice(0, 50).join(",");
  const resp = await fetch(`${ML_API}/shipment_labels?shipment_ids=${ids}&response_type=pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error("[ML] Labels download failed:", resp.status);
    return null;
  }

  return resp.arrayBuffer();
}

// ==================== OAUTH URL ====================

export function getOAuthUrl(clientId: string, redirectUri: string): string {
  return `${ML_AUTH}/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}
