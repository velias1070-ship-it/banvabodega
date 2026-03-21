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

/** Helper: fetch with automatic retry on 429 (rate limit). Short waits to stay within Vercel timeout. */
async function fetchWithRateLimit(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
  let resp = await fetch(url, init);
  for (let attempt = 1; attempt <= maxRetries && resp.status === 429; attempt++) {
    const retryAfter = resp.headers.get("retry-after");
    const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 5000) : attempt * 1000;
    console.warn(`[ML] 429 rate limit on ${init.method || "GET"} ${url.replace(ML_API, "")}, waiting ${waitMs}ms (retry ${attempt}/${maxRetries})`);
    await new Promise(r => setTimeout(r, waitMs));
    resp = await fetch(url, init);
  }
  return resp;
}

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
  tags?: string[];  // includes "fraud_risk_detected" if suspicious
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
  stock_flex_cache: number | null;
  stock_version: number | null;
  inventory_id: string | null;
  sku_venta: string | null;
  sku_origen: string | null;
  titulo: string | null;
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
  store_id?: string;
  network_node_id?: string;
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
    mode?: string;  // "me2" for Flex
    type?: string;  // "self_service" = Flex
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
      time_frame?: { from?: string; to?: string }; // delivery window hours
    };
    buffering?: {
      date?: string; // when label becomes available for printing
    };
  };
  shipping_option?: {
    estimated_handling_limit?: { date?: string | null };
    estimated_delivery_time?: { date?: string | null; handling?: number };
    estimated_delivery_final?: { date?: string | null };
    estimated_schedule_limit?: { date?: string | null };
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
 * Diagnóstico del estado del token para mostrar en UI
 */
export async function diagnoseToken(): Promise<string> {
  const sb = getServerSupabase();
  if (!sb) return "❌ No hay conexión a Supabase (getServerSupabase retornó null)";

  const { data: config, error } = await sb.from("ml_config").select("*").eq("id", "main").single();
  if (error || !config) return `❌ No hay registro en ml_config (${error?.message || "tabla vacía"})`;
  if (!config.access_token) return "❌ access_token está vacío en ml_config";
  if (!config.refresh_token) return "⚠️ refresh_token está vacío — no se puede refrescar el token expirado";
  if (!config.client_id) return "❌ client_id está vacío en ml_config";
  if (!config.client_secret) return "❌ client_secret está vacío en ml_config";

  const expiresAt = new Date(config.token_expires_at).getTime();
  const now = Date.now();
  const diffMin = Math.round((expiresAt - now) / 60000);

  if (now < expiresAt - 5 * 60 * 1000) {
    return `✅ Token válido (expira en ${diffMin} min)`;
  }

  return `⚠️ Token expirado hace ${-diffMin} min — se intentará refrescar automáticamente. Si falla, re-autorizar desde Config ML.`;
}

/**
 * Ensures we have a valid access token. Refreshes if expired.
 * Returns the valid access_token or null if refresh fails.
 * Uses a singleton promise to prevent race conditions when multiple
 * concurrent requests try to refresh at the same time.
 */
let _refreshPromise: Promise<string | null> | null = null;

export async function ensureValidToken(): Promise<string | null> {
  const config = await getMLConfig();
  if (!config || !config.access_token) return null;

  const expiresAt = new Date(config.token_expires_at).getTime();
  const now = Date.now();

  // Refresh 5 minutes before actual expiration for safety
  if (now < expiresAt - 5 * 60 * 1000) {
    return config.access_token;
  }

  // Si ya hay un refresh en curso, esperar a ese mismo
  if (_refreshPromise) {
    return _refreshPromise;
  }

  // Token expired or about to expire - refresh
  console.log("[ML] Token expired, refreshing...");
  _refreshPromise = (async () => {
    try {
      // Re-leer config por si otro proceso ya refrescó el token
      const freshConfig = await getMLConfig();
      if (freshConfig) {
        const freshExpiry = new Date(freshConfig.token_expires_at).getTime();
        if (Date.now() < freshExpiry - 5 * 60 * 1000) {
          console.log("[ML] Token already refreshed by another request");
          return freshConfig.access_token;
        }
      }

      const cfg = freshConfig || config;
      if (!cfg.client_id || !cfg.client_secret || !cfg.refresh_token) {
        console.error("[ML] Token refresh failed: missing credentials (client_id, client_secret, or refresh_token)");
        return null;
      }

      // Reintentar hasta 3 veces con backoff en caso de error de red
      let lastError = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(`${ML_API}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: cfg.client_id,
              client_secret: cfg.client_secret,
              refresh_token: cfg.refresh_token,
            }),
          });

          if (resp.ok) {
            const data = await resp.json();
            const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

            await saveMLConfig({
              access_token: data.access_token,
              refresh_token: data.refresh_token || cfg.refresh_token,
              token_expires_at: newExpiry,
            });

            console.log("[ML] Token refreshed successfully, expires:", newExpiry);
            return data.access_token;
          }

          lastError = await resp.text();
          // Si es error 4xx (credenciales inválidas), no reintentar
          if (resp.status >= 400 && resp.status < 500) {
            console.error(`[ML] Token refresh failed (${resp.status}):`, lastError);
            return null;
          }
          console.warn(`[ML] Token refresh attempt ${attempt + 1} failed (${resp.status}), retrying...`);
        } catch (fetchErr) {
          lastError = String(fetchErr);
          console.warn(`[ML] Token refresh attempt ${attempt + 1} network error:`, lastError);
        }
        // Backoff: 1s, 2s, 4s
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
      console.error("[ML] Token refresh failed after 3 attempts:", lastError);
      return null;
    } catch (err) {
      console.error("[ML] Token refresh error:", err);
      return null;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
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
    console.log("[ML] OAuth response keys:", Object.keys(data), "has refresh_token:", !!data.refresh_token, "user_id:", data.user_id);

    if (!data.refresh_token) {
      console.warn("[ML] ⚠️ OAuth response NO incluye refresh_token. El token expirará en ~6h sin posibilidad de renovar. Asegurarse de usar scope=offline_access en la URL de autorización.");
    }

    await saveMLConfig({
      access_token: data.access_token,
      refresh_token: data.refresh_token || "",
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      seller_id: String(data.user_id),
    });

    console.log("[ML] OAuth complete, seller_id:", data.user_id, "refresh_token saved:", !!data.refresh_token);
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

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });

  if (!resp.ok) {
    console.error(`[ML] GET ${path} failed:`, resp.status);
    return null;
  }

  return resp.json() as Promise<T>;
}

/** mlGet that also returns response headers (for x-version etc.) */
async function mlGetWithHeaders<T = unknown>(path: string): Promise<{ data: T; headers: Headers } | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error(`[ML] GET ${path} failed:`, resp.status);
    return null;
  }

  const data = await resp.json() as T;
  return { data, headers: resp.headers };
}

/** mlGet con info de error detallada para diagnóstico */
async function mlGetDiagnostic<T = unknown>(path: string): Promise<{ ok: true; data: T; headers: Headers } | { ok: false; status: number; body: string }> {
  const token = await ensureValidToken();
  if (!token) return { ok: false, status: 0, body: "No hay token válido (ensureValidToken retornó null)" };

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, body };
  }

  const data = await resp.json() as T;
  return { ok: true, data, headers: resp.headers };
}

/**
 * Make authenticated GET, return raw JSON (for debugging)
 */
export async function mlGetRaw(path: string): Promise<unknown | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`[ML] GET ${path} failed: ${resp.status} ${body.slice(0, 200)}`);
    return null;
  }

  return resp.json();
}

/**
 * Make authenticated PUT request to ML API
 */
export async function mlPut<T = unknown>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
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
    if (resp.status === 409) {
      throw new Error(`VERSION_CONFLICT: ${errText}`);
    }
    // Throw with status + body so callers can get the detail
    throw new Error(`ML_PUT_ERROR ${resp.status}: ${errText.slice(0, 300)}`);
  }

  return resp.json() as Promise<T>;
}

/**
 * Make authenticated POST request to ML API
 */
export async function mlPost<T = unknown>(path: string, body?: unknown): Promise<T | null> {
  const token = await ensureValidToken();
  if (!token) return null;

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
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

  const resp = await fetchWithRateLimit(`${ML_API}${path}`, {
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
  // Priority: lead_time > shipping_option.estimated_handling_limit > shipping_option.estimated_delivery_time
  let handlingLimitDate: string | null = null;
  if (shipment.lead_time?.estimated_handling_limit?.date) {
    handlingLimitDate = shipment.lead_time.estimated_handling_limit.date.slice(0, 10);
  } else if (shipment.shipping_option?.estimated_handling_limit?.date) {
    handlingLimitDate = shipment.shipping_option.estimated_handling_limit.date.slice(0, 10);
  } else if (shipment.shipping_option?.estimated_delivery_time?.date) {
    // Use delivery date as proxy — the shipment must be dispatched before delivery
    handlingLimitDate = shipment.shipping_option.estimated_delivery_time.date.slice(0, 10);
  }

  let deliveryDate: string | null = null;
  if (shipment.lead_time?.estimated_delivery_time?.date) {
    deliveryDate = shipment.lead_time.estimated_delivery_time.date.slice(0, 10);
  } else if (shipment.shipping_option?.estimated_delivery_final?.date) {
    deliveryDate = shipment.shipping_option.estimated_delivery_final.date.slice(0, 10);
  } else if (shipment.shipping_option?.estimated_delivery_time?.date) {
    deliveryDate = shipment.shipping_option.estimated_delivery_time.date.slice(0, 10);
  }

  return {
    logistic_type: logisticType,
    origin_type: originType,
    origin_address: originAddress,
    store_id: storeId,
    is_flex: logisticType === "self_service" && shipment.logistic?.mode === "me2",
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

  // 2. Fetch SLA (expected dispatch date — more reliable than lead_time for Flex)
  let slaDate: string | null = shipInfo.handling_limit_date;
  let slaStatus: string | null = null;
  try {
    const sla = await mlGet<{ expected_date?: string; status?: string }>(`/shipments/${shipmentId}/sla`);
    if (sla?.expected_date) {
      slaDate = sla.expected_date;
      slaStatus = sla.status || null;
    }
  } catch {
    // SLA endpoint may not be available for all shipment types — fallback to shipInfo
  }

  // 3. Check fraud risk on orders
  let isFraudRisk = false;
  for (const orderId of orderIds) {
    const order = await mlGet<MLOrder>(`/orders/${orderId}`);
    if (order?.tags?.includes("fraud_risk_detected")) {
      isFraudRisk = true;
      console.warn(`[ML] Order ${orderId} has fraud_risk_detected tag!`);
      break;
    }
  }

  // 4. Upsert ml_shipments
  const shipmentRow = {
    shipment_id: shipmentId,
    order_ids: orderIds,
    status: shipInfo.raw?.status || "unknown",
    substatus: shipInfo.raw?.substatus || null,
    logistic_type: shipInfo.logistic_type,
    is_flex: shipInfo.is_flex,
    handling_limit: slaDate || shipInfo.handling_limit_date || null,
    buffering_date: shipInfo.raw?.lead_time?.buffering?.date || null,
    delivery_date: shipInfo.delivery_date || null,
    origin_type: shipInfo.origin_type,
    store_id: shipInfo.store_id,
    receiver_name: shipInfo.raw?.destination?.receiver_name || null,
    destination_city: shipInfo.raw?.destination?.shipping_address?.city?.name || null,
    is_fraud_risk: isFraudRisk,
    updated_at: new Date().toISOString(),
  };

  const { error: shipErr } = await sb.from("ml_shipments").upsert(shipmentRow, {
    onConflict: "shipment_id",
  });
  if (shipErr) {
    console.error(`[ML] Upsert ml_shipments error for ${shipmentId}:`, shipErr.message);
    return { items: 0, shipInfo };
  }

  // 4. For each order, fetch order details and upsert items
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
  console.log(`[ML] Shipment ${shipmentId}: ${ltLabel}, ${totalItems} items, sla=${slaDate} (${slaStatus}), handling_limit=${shipInfo.handling_limit_date}`);

  return { items: totalItems, shipInfo };
}

/**
 * Process a single ML order: extract shipment_id, delegate to processShipment.
 * Data goes to ml_shipments + ml_shipment_items only.
 */
export async function processOrder(order: MLOrder, config: MLConfig): Promise<number> {
  if (order.status !== "paid") return 0;
  if (!order.shipping?.id) return 0;

  const { items: shipmentItems } = await processShipment(order.shipping.id, [order.id]);
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

  const entries = Array.from(shipmentMap.entries());
  for (const entry of entries) {
    const result = await processShipment(entry[0], entry[1]);
    if (result.items > 0) {
      processed++;
      items += result.items;
    } else {
      skipped++;
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
  const { data: stale } = await sb.from("ml_shipments").select("shipment_id,substatus")
    .eq("status", "ready_to_ship");

  if (!stale || stale.length === 0) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const row of stale as { shipment_id: number; substatus?: string }[]) {
    const shipment = await mlGet<{ id: number; status: string; substatus?: string }>(
      `/shipments/${row.shipment_id}`,
      { "x-format-new": "true" }
    );
    if (!shipment) continue;

    // Update if status changed OR substatus changed (e.g. ready_to_print → printed)
    const statusChanged = shipment.status && shipment.status !== "ready_to_ship";
    const substatusChanged = shipment.substatus && shipment.substatus !== row.substatus;
    if (statusChanged || substatusChanged) {
      await sb.from("ml_shipments").update({
        status: shipment.status,
        substatus: shipment.substatus || null,
        updated_at: new Date().toISOString(),
      }).eq("shipment_id", row.shipment_id);
      updated++;
      if (statusChanged) {
        console.log(`[ML] Shipment ${row.shipment_id}: ready_to_ship → ${shipment.status}`);
      }
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
  const result = await mlGetWithHeaders<{ locations?: StockLocation[] }>(`/user-products/${userProductId}/stock`);
  if (!result) return null;

  // ML returns version in x-version response header, not in JSON body
  const headerVersion = parseInt(result.headers.get("x-version") || "0", 10);

  return {
    user_product_id: userProductId,
    locations: result.data.locations || [],
    version: headerVersion,
  };
}

/** Versión con diagnóstico para stock-compare */
export async function getDistributedStockDiagnostic(userProductId: string): Promise<{ stock: StockResponse | null; error?: string }> {
  const result = await mlGetDiagnostic<{ locations?: StockLocation[] }>(`/user-products/${userProductId}/stock`);
  if (!result.ok) {
    return { stock: null, error: `HTTP ${result.status}: ${result.body.substring(0, 200)}` };
  }

  const headerVersion = parseInt(result.headers.get("x-version") || "0", 10);
  return {
    stock: {
      user_product_id: userProductId,
      locations: result.data.locations || [],
      version: headerVersion,
    },
  };
}

/**
 * Determine which stock location type the seller controls.
 * Priority: selling_address (Flex) > seller_warehouse (multi-origin) > null (Full-only)
 */
export function getSellerStockType(locations: StockLocation[]): "selling_address" | "seller_warehouse" | null {
  if (locations.some(l => l.type === "selling_address")) return "selling_address";
  if (locations.some(l => l.type === "seller_warehouse")) return "seller_warehouse";
  return null;
}

/**
 * Update seller-controlled stock using the distributed stock API.
 * Writes to selling_address or seller_warehouse depending on the product's locations.
 * Requires x-version header for optimistic concurrency.
 *
 * For selling_address: body = { quantity }
 * For seller_warehouse: body = { locations: [{ store_id, quantity }, ...] }
 */
export async function updateFlexStock(
  userProductId: string,
  quantity: number,
  version: number,
  stockType: "selling_address" | "seller_warehouse" = "selling_address",
  warehouseLocations: StockLocation[] = []
): Promise<{ ok: boolean; error?: string }> {
  // DESACTIVADO: No enviar stock a MercadoLibre
  console.warn(`[ML Stock] DESACTIVADO — updateFlexStock(${userProductId}, qty=${quantity}) bloqueado`);
  return { ok: false, error: "Sync a ML desactivado" };
  try {
    let body: unknown;
    if (stockType === "seller_warehouse") {
      // seller_warehouse requires locations array with store_id
      if (warehouseLocations.length === 0) {
        return { ok: false, error: "seller_warehouse requiere locations con store_id" };
      }
      // Deduplicate by network_node_id — ML rejects repeated network_node_id
      // Each location needs store_id + network_node_id per ML docs
      const seen = new Set<string>();
      const uniqueLocations: { store_id: string; network_node_id: string; quantity: number }[] = [];
      for (const l of warehouseLocations) {
        if (l.type !== "seller_warehouse" || !l.store_id || !l.network_node_id) continue;
        const nodeId = l.network_node_id as string;
        const storeId = l.store_id as string;
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          uniqueLocations.push({ store_id: storeId, network_node_id: nodeId, quantity });
        }
      }
      if (uniqueLocations.length === 0) {
        return { ok: false, error: "seller_warehouse locations sin network_node_id válido" };
      }
      body = { locations: uniqueLocations };
    } else {
      body = { quantity };
    }

    const result = await mlPut(
      `/user-products/${userProductId}/stock/type/${stockType}`,
      body,
      { "x-version": String(version) }
    );
    return result !== null ? { ok: true } : { ok: false, error: "ML respondió con error (ver logs del server)" };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("VERSION_CONFLICT")) {
      return { ok: false, error: "VERSION_CONFLICT" };
    }
    return { ok: false, error: msg };
  }
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
    if (availableQty === 0 && map.stock_flex_cache && map.stock_flex_cache > 10) {
      console.warn(`[ML Stock] Safety block: ${sku} → 0 (was ${map.stock_flex_cache}). Skipping.`);
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

      // 2b. Determine seller-controlled stock type
      const stockType = getSellerStockType(stockData.locations);
      if (!stockType) {
        console.warn(`[ML Stock] ${userProductId} has no seller-controlled location — Full-only item, skipping`);
        continue;
      }

      // 3. PUT with x-version header
      const result = await updateFlexStock(userProductId, availableQty, stockData.version, stockType, stockData.locations);

      if (result.ok) {
        await sb.from("ml_items_map").update({
          ultimo_sync: new Date().toISOString(),
          stock_flex_cache: availableQty,
          stock_version: stockData.version + 1,
        }).eq("id", map.id);
        synced++;
      } else if (result.error === "VERSION_CONFLICT") {
        // 409: version mismatch — retry up to 3 times with delay
        let retried = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.warn(`[ML Stock] Version conflict for ${sku}, retry ${attempt}/3...`);
          await new Promise(r => setTimeout(r, attempt * 500)); // 500ms, 1s, 1.5s
          const freshStock = await getDistributedStock(userProductId);
          if (!freshStock) break;
          const retryResult = await updateFlexStock(userProductId, availableQty, freshStock.version, stockType, freshStock.locations);
          if (retryResult.ok) {
            await sb.from("ml_items_map").update({
              ultimo_sync: new Date().toISOString(),
              stock_flex_cache: availableQty,
              stock_version: freshStock.version + 1,
            }).eq("id", map.id);
            synced++;
            retried = true;
            break;
          }
          if (retryResult.error !== "VERSION_CONFLICT") {
            console.error(`[ML Stock] Retry ${attempt} for ${sku} failed:`, retryResult.error);
            break;
          }
        }
        if (!retried) {
          console.error(`[ML Stock] All retries failed for ${sku} (VERSION_CONFLICT)`);
        }
      } else {
        console.error(`[ML Stock] Error syncing ${sku}:`, result.error);
      }
    } catch (err) {
      console.error(`[ML Stock] Error syncing ${sku}:`, err);
    }
  }

  return synced;
}

// ==================== STOCK FULL QUERY ====================

/**
 * Get fulfillment (Full) stock for all active SKUs in ml_items_map.
 * Queries the distributed stock API for each SKU and returns the
 * quantity at meli_facility locations.
 * Returns a map of SKU → stock quantity in Full.
 */
export async function getFullStockForAllSkus(): Promise<Record<string, number>> {
  const sb = getServerSupabase();
  if (!sb) return {};

  const { data: mappings } = await sb.from("ml_items_map")
    .select("sku, item_id, user_product_id")
    .eq("activo", true);

  if (!mappings || mappings.length === 0) return {};

  const result: Record<string, number> = {};

  for (const map of mappings as { sku: string; item_id: string; user_product_id: string | null }[]) {
    try {
      let userProductId = map.user_product_id;
      if (!userProductId) {
        userProductId = await getItemUserProductId(map.item_id);
        if (!userProductId) continue;
        // Save for future calls
        await sb.from("ml_items_map").update({ user_product_id: userProductId })
          .eq("item_id", map.item_id).eq("sku", map.sku);
      }

      const stockData = await getDistributedStock(userProductId);
      if (!stockData) continue;

      const fullQty = stockData.locations
        .filter(l => l.type === "meli_facility")
        .reduce((sum, l) => sum + l.quantity, 0);

      // Accumulate — a SKU may have multiple item_ids
      result[map.sku] = (result[map.sku] || 0) + fullQty;
    } catch (err) {
      console.error(`[ML StockFull] Error fetching stock for ${map.sku}:`, err);
    }
  }

  return result;
}

// ==================== FLEX MANAGEMENT ====================

/**
 * Get Flex subscription info for the seller.
 * GET /shipping/flex/sites/MLC/users/$USER_ID/subscriptions/v1
 */
export async function getFlexSubscription(): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlGet(`/flex/sites/${SITE_ID}/users/${config.seller_id}/subscriptions/v1`);
}

/**
 * Get Flex service configuration (delivery zones, capacity, etc.)
 */
export async function getFlexConfig(serviceId: string): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlGet(`/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configurations/delivery-ranges/v1`);
}

/**
 * Update Flex delivery configuration.
 * PUT /shipping/flex/sites/MLC/users/$USER_ID/services/$SERVICE_ID/configuration/delivery/custom/v3
 */
export async function updateFlexConfig(serviceId: string, configData: unknown): Promise<unknown> {
  const config = await getMLConfig();
  if (!config?.seller_id) return null;
  return mlPut(`/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configurations/delivery-ranges/v1`, configData);
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
  return mlPut(`/flex/sites/${SITE_ID}/users/${config.seller_id}/services/${serviceId}/configurations/holidays/v1`, holidays);
}

/**
 * Activate an item for Flex shipping.
 * POST /flex/sites/MLC/items/$ITEM_ID/v2
 */
export async function activateFlexItem(itemId: string): Promise<boolean> {
  // DESACTIVADO: No activar items en MercadoLibre
  console.warn(`[ML Flex] DESACTIVADO — activateFlexItem(${itemId}) bloqueado`);
  return false;
}

/**
 * Deactivate an item from Flex shipping.
 * DELETE /flex/sites/MLC/items/$ITEM_ID/v2
 */
export async function deactivateFlexItem(itemId: string): Promise<boolean> {
  // DESACTIVADO: No desactivar items en MercadoLibre
  console.warn(`[ML Flex] DESACTIVADO — deactivateFlexItem(${itemId}) bloqueado`);
  return false;
}

// ==================== SHIPPING LABELS ====================

/**
 * Get shipment live status from ML API.
 * Used for: label printing validation, verify-before-picking.
 * ready = can print label. ok_to_pick = safe to prepare.
 */
export async function getShipmentStatus(shippingId: number): Promise<{
  id: number;
  status: string;
  substatus: string | null;
  logistic_type: string;
  ready: boolean;    // can print label
  ok_to_pick: boolean; // safe to prepare (not cancelled/fraud)
  cancelled: boolean;
} | null> {
  const shipment = await mlGet<MLShipmentDetail>(
    `/shipments/${shippingId}`,
    { "x-format-new": "true" }
  );
  if (!shipment) return null;
  const logisticType = shipment.logistic?.type || shipment.logistic_type || "unknown";
  const isCancelled = shipment.status === "cancelled";
  return {
    id: shipment.id,
    status: shipment.status,
    substatus: shipment.substatus || null,
    logistic_type: logisticType,
    ready: shipment.status === "ready_to_ship",
    ok_to_pick: shipment.status === "ready_to_ship" && !isCancelled,
    cancelled: isCancelled,
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

// ==================== STOCK FULL SYNC (ML Fulfillment → WMS) ====================

interface MLMarketplaceItem {
  id: string;
  title: string;
  inventory_id?: string;
  available_quantity: number;
  sold_quantity: number;
  seller_custom_field?: string;
  user_product_id?: string;
  variations?: Array<{
    id: number;
    inventory_id?: string;
    available_quantity: number;
    sold_quantity: number;
    seller_custom_field?: string;
    user_product_id?: string;
  }>;
}

interface FulfillmentStockDetail {
  available_quantity: number;
  not_available_quantity: number;
  not_available_detail: {
    damaged: number;
    lost: number;
    in_transfer: number;
    not_supported: number;
    [key: string]: number;
  };
}

export interface SyncStockFullResult {
  ok: boolean;
  items_sincronizados: number;
  stock_actualizado: number;
  sin_inventory_id: number;
  errores: string[];
  tiempo_ms: number;
}

/**
 * Fetch seller items by status using scan pagination.
 */
async function fetchSellerItemsByStatus(sellerId: string, status: string): Promise<string[]> {
  const ids: string[] = [];
  const url = `/users/${sellerId}/items/search?search_type=scan&limit=100&status=${status}`;
  const resp = await mlGetRaw(url) as { results?: string[]; scroll_id?: string; paging?: { total: number } } | null;
  if (!resp?.results || resp.results.length === 0) return ids;

  ids.push(...resp.results);

  // Paginar con scroll_id
  let scrollId: string | null = resp.scroll_id || null;
  const total = resp.paging?.total || 0;
  while (scrollId && ids.length < total) {
    await delay(500);
    const sp = await mlGet<{ results: string[]; scroll_id?: string }>(
      `/users/${sellerId}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`
    );
    if (!sp || sp.results.length === 0) break;
    ids.push(...sp.results);
    scrollId = sp.scroll_id || null;
  }
  return ids;
}

/**
 * Fetch all seller item IDs across all statuses.
 */
async function fetchAllSellerItems(sellerId: string): Promise<string[]> {
  const allIds: string[] = [];
  const seen = new Set<string>();

  // Buscar items en todos los estados: active, paused, closed
  const statuses = ["active", "paused", "closed"];
  for (const status of statuses) {
    const statusIds = await fetchSellerItemsByStatus(sellerId, status);
    for (const id of statusIds) {
      if (!seen.has(id)) { seen.add(id); allIds.push(id); }
    }
    console.log(`[syncStockFull] status=${status}: ${statusIds.length} items (total acumulado: ${allIds.length})`);
  }

  if (allIds.length > 0) return allIds;

  // Fallback: probar sin filtro de status
  const urls = [
    `/users/${sellerId}/items/search?search_type=scan&limit=100`,
    `/users/${sellerId}/items/search?limit=50&offset=0`,
  ];

  for (const url of urls) {
    console.log(`[syncStockFull] Probando: GET ${url}`);
    const resp = await mlGetRaw(url);
    if (resp) {
      console.log(`[syncStockFull] Response: ${JSON.stringify(resp).slice(0, 500)}`);
      const data = resp as { results?: string[]; scroll_id?: string; paging?: { total: number } };
      if (data.results && data.results.length > 0) {
        allIds.push(...data.results);

        // Si fue scan, paginar con scroll_id
        if (url.includes("search_type=scan") && data.scroll_id && data.paging) {
          let scrollId: string | null = data.scroll_id;
          while (scrollId && allIds.length < data.paging.total) {
            await delay(500);
            const sp: { results: string[]; scroll_id?: string } | null = await mlGet(
              `/users/${sellerId}/items/search?search_type=scan&scroll_id=${scrollId}&limit=100`
            );
            if (!sp || sp.results.length === 0) break;
            allIds.push(...sp.results);
            scrollId = sp.scroll_id || null;
          }
        }
        // Si fue offset, paginar
        else if (data.paging && data.paging.total > allIds.length) {
          let offset = allIds.length;
          const baseUrl = url.replace(/offset=\d+/, "");
          while (offset < data.paging.total && offset < 1000) {
            await delay(500);
            const op: { results: string[]; paging: { total: number } } | null = await mlGet(
              `${baseUrl}offset=${offset}&limit=50`
            );
            if (!op || op.results.length === 0) break;
            allIds.push(...op.results);
            offset += op.results.length;
          }
        }

        console.log(`[syncStockFull] Éxito con ${url}: ${allIds.length} items totales`);
        return allIds;
      }
    } else {
      console.log(`[syncStockFull] ${url} devolvió null (error HTTP)`);
    }
  }

  console.log("[syncStockFull] Ningún endpoint devolvió items");
  return allIds;
}

/**
 * Fetch item details from marketplace API.
 */
async function fetchMarketplaceItem(itemId: string): Promise<MLMarketplaceItem | null> {
  return mlGet<MLMarketplaceItem>(`/items/${itemId}`);
}

/**
 * Fetch fulfillment stock detail for an inventory_id.
 */
async function fetchFulfillmentStock(inventoryId: string, sellerId: string): Promise<FulfillmentStockDetail | null> {
  return mlGet<FulfillmentStockDetail>(
    `/inventories/${inventoryId}/stock/fulfillment?seller_id=${sellerId}`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sincroniza stock Full desde ML API a stock_full_cache.
 * Flujo:
 * 1. Lista todos los items del seller
 * 2. Obtiene inventory_id de cada item/variación
 * 3. Mapea inventory_id → sku_venta via composicion_venta.codigo_ml
 * 4. Consulta stock fulfillment detallado
 * 5. Upsert en ml_items_map y stock_full_cache
 */
export async function syncStockFull(): Promise<SyncStockFullResult> {
  const start = Date.now();
  const errores: string[] = [];
  const sb = getServerSupabase();

  const config = await getMLConfig();
  if (!config?.seller_id || !sb) {
    return { ok: false, items_sincronizados: 0, stock_actualizado: 0, sin_inventory_id: 0, errores: ["No ML config o seller_id"], tiempo_ms: Date.now() - start };
  }

  // 1. Obtener mapeos para resolver SKU desde múltiples fuentes
  // a) composicion_venta.codigo_ml → sku_venta + sku_venta → sku_origen
  const { data: compData } = await sb.from("composicion_venta").select("codigo_ml, sku_venta, sku_origen");
  const codigoToSkuVenta = new Map<string, string>();
  const skuVentaToSkuOrigen = new Map<string, string>();
  for (const row of (compData || [])) {
    if (row.codigo_ml && row.sku_venta) {
      codigoToSkuVenta.set(row.codigo_ml.toUpperCase(), row.sku_venta);
    }
    if (row.sku_venta && row.sku_origen) {
      skuVentaToSkuOrigen.set(row.sku_venta.toUpperCase(), row.sku_origen);
    }
  }
  // b) productos.sku set for direct match against seller_custom_field
  const { data: prodData } = await sb.from("productos").select("sku, sku_venta");
  const knownSkus = new Set<string>();
  const skuVentaToSku = new Map<string, string>();
  for (const p of (prodData || [])) {
    if (p.sku) knownSkus.add(p.sku.toUpperCase());
    if (p.sku_venta) {
      // sku_venta can be comma-separated
      for (const sv of p.sku_venta.split(",")) {
        const trimmed = sv.trim().toUpperCase();
        if (trimmed) {
          knownSkus.add(trimmed);
          skuVentaToSku.set(trimmed, p.sku.toUpperCase());
        }
      }
    }
  }

  // 2. Listar todos los items del seller
  console.log(`[syncStockFull] Obteniendo items del seller ${config.seller_id}...`);
  console.log(`[syncStockFull] Mapeo composicion_venta: ${codigoToSkuVenta.size} codigo_ml, productos: ${knownSkus.size} SKUs conocidos`);
  const itemIds = await fetchAllSellerItems(config.seller_id);
  console.log(`[syncStockFull] ${itemIds.length} items encontrados${itemIds.length > 0 ? ` (primeros: ${itemIds.slice(0, 3).join(", ")})` : ""}`);

  // Helper: resolve sku_venta from multiple sources
  // Priority: 1) composicion_venta.codigo_ml, 2) seller_custom_field match, 3) null
  function resolveSkuVenta(inventoryId: string | null, sellerCustomField: string | null): string | null {
    // Try composicion_venta mapping first
    if (inventoryId) {
      const fromComp = codigoToSkuVenta.get(inventoryId.toUpperCase());
      if (fromComp) return fromComp;
    }
    // Try seller_custom_field — ML sellers often put the WMS SKU here
    if (sellerCustomField) {
      const scf = sellerCustomField.toUpperCase().trim();
      if (knownSkus.has(scf)) return scf;
      // Check if it maps through sku_venta → sku
      const mapped = skuVentaToSku.get(scf);
      if (mapped) return scf;
    }
    return null;
  }

  // 3. Procesar items en batches de 20
  const itemsMapRows: Array<{
    item_id: string;
    inventory_id: string | null;
    sku_venta: string | null;
    sku_origen: string | null;
    titulo: string;
    available_quantity: number;
    sold_quantity: number;
    variation_id: string | null;
    user_product_id: string | null;
  }> = [];

  let sinInventoryId = 0;

  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    const promises = batch.map(async (itemId) => {
      try {
        const item = await fetchMarketplaceItem(itemId);
        if (!item) {
          errores.push(`No se pudo obtener item ${itemId}`);
          return;
        }

        if (item.variations && item.variations.length > 0) {
          // Item con variaciones: cada variación tiene su inventory_id
          for (const v of item.variations) {
            const invId = v.inventory_id || null;
            const skuVenta = resolveSkuVenta(invId, v.seller_custom_field || null);
            const skuOrigen = skuVenta ? (skuVentaToSkuOrigen.get(skuVenta.toUpperCase()) || null) : null;
            if (!invId) sinInventoryId++;
            itemsMapRows.push({
              item_id: itemId,
              inventory_id: invId,
              sku_venta: skuVenta,
              sku_origen: skuOrigen,
              titulo: item.title,
              available_quantity: v.available_quantity || 0,
              sold_quantity: v.sold_quantity || 0,
              variation_id: String(v.id),
              user_product_id: v.user_product_id || item.user_product_id || null,
            });
          }
        } else {
          // Item sin variaciones
          const invId = item.inventory_id || null;
          const skuVenta = resolveSkuVenta(invId, item.seller_custom_field || null);
          const skuOrigen = skuVenta ? (skuVentaToSkuOrigen.get(skuVenta.toUpperCase()) || null) : null;
          if (!invId) sinInventoryId++;
          itemsMapRows.push({
            item_id: itemId,
            inventory_id: invId,
            sku_venta: skuVenta,
            sku_origen: skuOrigen,
            titulo: item.title,
            available_quantity: item.available_quantity || 0,
            sold_quantity: item.sold_quantity || 0,
            variation_id: null,
            user_product_id: item.user_product_id || null,
          });
        }
      } catch (err) {
        errores.push(`Error procesando ${itemId}: ${err}`);
      }
    });
    await Promise.all(promises);
    if (i + 20 < itemIds.length) await delay(100);
  }

  // 4. Obtener stock fulfillment detallado para items con inventory_id
  const inventoryIds = Array.from(new Set(itemsMapRows.filter(r => r.inventory_id).map(r => r.inventory_id!)));
  console.log(`[syncStockFull] ${inventoryIds.length} inventory_ids a consultar fulfillment`);

  // Mapeo inventory_id → fulfillment detail
  const fulfillmentMap = new Map<string, FulfillmentStockDetail>();

  for (let i = 0; i < inventoryIds.length; i += 20) {
    const batch = inventoryIds.slice(i, i + 20);
    const promises = batch.map(async (invId) => {
      try {
        const detail = await fetchFulfillmentStock(invId, config.seller_id);
        if (detail) {
          fulfillmentMap.set(invId.toUpperCase(), detail);
        }
      } catch (err) {
        errores.push(`Error fulfillment ${invId}: ${err}`);
      }
    });
    await Promise.all(promises);
    if (i + 20 < inventoryIds.length) await delay(100);
  }

  // 5. Upsert ml_items_map
  // Deduplicar por (sku, item_id) — para items con variaciones, múltiples variaciones
  // pueden resolver al mismo sku_venta, generando filas con la misma PK en el batch.
  // PostgreSQL no permite que un upsert toque la misma fila dos veces.
  // Preferimos la fila con inventory_id (variación real sobre padre).
  const mapped = itemsMapRows.filter(r => r.sku_venta);
  const unmapped = itemsMapRows.filter(r => !r.sku_venta);
  console.log(`[syncStockFull] ${mapped.length} items con SKU resuelto, ${unmapped.length} sin mapeo`);
  if (unmapped.length > 0) {
    console.log(`[syncStockFull] Items sin mapeo (primeros 10): ${unmapped.slice(0, 10).map(r => `${r.item_id}(scf=${r.titulo})`).join(", ")}`);
  }

  const mlItemsUpsert = itemsMapRows.map(r => ({
    sku: r.sku_venta || r.item_id,
    item_id: r.item_id,
    variation_id: r.variation_id ? parseInt(r.variation_id) : null,
    inventory_id: r.inventory_id,
    sku_venta: r.sku_venta,
    sku_origen: r.sku_origen,
    titulo: r.titulo,
    available_quantity: r.available_quantity,
    sold_quantity: r.sold_quantity,
    user_product_id: r.user_product_id,
    activo: true,
    updated_at: new Date().toISOString(),
  }));

  // Deduplicar por (sku, item_id) — múltiples variaciones pueden generar la misma PK.
  // Logear duplicados para diagnóstico.
  const dedupMap = new Map<string, typeof mlItemsUpsert[0]>();
  const duplicados: string[] = [];
  for (const row of mlItemsUpsert) {
    const key = `${row.sku}|${row.item_id}`;
    const existing = dedupMap.get(key);
    if (existing) {
      duplicados.push(`${key} (var_existente=${existing.variation_id}, var_nueva=${row.variation_id}, inv_existente=${existing.inventory_id}, inv_nueva=${row.inventory_id})`);
      // Preferir fila con inventory_id (variación real)
      if (!existing.inventory_id && row.inventory_id) {
        dedupMap.set(key, row);
      }
    } else {
      dedupMap.set(key, row);
    }
  }
  if (duplicados.length > 0) {
    console.log(`[syncStockFull] ${duplicados.length} filas duplicadas por (sku,item_id) eliminadas:`);
    for (const d of duplicados.slice(0, 20)) console.log(`  dup: ${d}`);
    if (duplicados.length > 20) console.log(`  ... y ${duplicados.length - 20} más`);
  }
  const dedupedUpsert = Array.from(dedupMap.values());

  // Upsert en chunks de 50 con fallback fila-por-fila si un chunk falla
  for (let i = 0; i < dedupedUpsert.length; i += 50) {
    const chunk = dedupedUpsert.slice(i, i + 50);
    const { error } = await sb.from("ml_items_map").upsert(chunk, { onConflict: "sku,item_id" });
    if (error) {
      console.log(`[syncStockFull] Chunk ${i}-${i + chunk.length} falló: ${error.message}. Fallback fila por fila...`);
      // Logear las claves del chunk para diagnóstico
      const chunkKeys = chunk.map(r => `${r.sku}|${r.item_id}|var=${r.variation_id}`);
      console.log(`[syncStockFull] Claves del chunk fallido: ${chunkKeys.join(", ")}`);
      // Fallback: insertar fila por fila
      for (const row of chunk) {
        const { error: rowErr } = await sb.from("ml_items_map").upsert(row, { onConflict: "sku,item_id" });
        if (rowErr) {
          errores.push(`Upsert ml_items_map fila sku=${row.sku} item=${row.item_id} var=${row.variation_id}: ${rowErr.message}`);
          console.log(`[syncStockFull] Fila falló: sku=${row.sku}, item_id=${row.item_id}, variation_id=${row.variation_id}, inv=${row.inventory_id} → ${rowErr.message}`);
        }
      }
    }
  }

  // 6. Obtener cantidad real desde API distribuida (fuente de verdad)
  // La API de fulfillment inventory puede dar valores incorrectos (doble conteo).
  // Usamos /user-products/{id}/stock → meli_facility como fuente de verdad para cantidad.
  // La fulfillment API solo se usa para detalle (dañado, perdido, transferencia).

  // 6a. Detalle de fulfillment por sku_venta (solo campos de detalle)
  const detailBySku = new Map<string, {
    stock_no_disponible: number;
    stock_danado: number;
    stock_perdido: number;
    stock_transferencia: number;
  }>();
  const countedInventoryPerSku = new Map<string, Set<string>>();

  for (const row of itemsMapRows) {
    if (!row.sku_venta || !row.inventory_id) continue;
    const invKey = row.inventory_id.toUpperCase();
    const detail = fulfillmentMap.get(invKey);
    if (!detail) continue;

    const counted = countedInventoryPerSku.get(row.sku_venta) || new Set();
    if (counted.has(invKey)) continue;
    counted.add(invKey);
    countedInventoryPerSku.set(row.sku_venta, counted);

    const existing = detailBySku.get(row.sku_venta) || {
      stock_no_disponible: 0, stock_danado: 0, stock_perdido: 0, stock_transferencia: 0,
    };

    const nad = detail.not_available_detail || {};
    existing.stock_no_disponible += detail.not_available_quantity || 0;
    existing.stock_danado += nad.damaged || 0;
    existing.stock_perdido += nad.lost || 0;
    existing.stock_transferencia += nad.in_transfer || 0;

    detailBySku.set(row.sku_venta, existing);
  }

  // 6b. Cantidad real desde API distribuida por user_product_id
  // Agrupar: sku_venta → user_product_id (deduplicado)
  const skuToUserProductIds = new Map<string, Set<string>>();
  for (const row of itemsMapRows) {
    if (!row.sku_venta || !row.user_product_id) continue;
    if (!skuToUserProductIds.has(row.sku_venta)) skuToUserProductIds.set(row.sku_venta, new Set());
    skuToUserProductIds.get(row.sku_venta)!.add(row.user_product_id);
  }

  const uniqueUserProductIds = new Set<string>();
  skuToUserProductIds.forEach(ids => ids.forEach(id => uniqueUserProductIds.add(id)));
  const upIds = Array.from(uniqueUserProductIds);
  console.log(`[syncStockFull] Consultando API distribuida para ${upIds.length} user_product_ids...`);

  // Consultar en batches de 10 con delay para evitar rate limiting
  const distributedResults = new Map<string, number>();
  for (let i = 0; i < upIds.length; i += 10) {
    const batch = upIds.slice(i, i + 10);
    const promises = batch.map(async (upId) => {
      try {
        const stockData = await getDistributedStock(upId);
        if (stockData) {
          const fullQty = stockData.locations
            .filter(l => l.type === "meli_facility")
            .reduce((sum, l) => sum + l.quantity, 0);
          distributedResults.set(upId, fullQty);
        }
      } catch (err) {
        errores.push(`Distributed stock ${upId}: ${err}`);
      }
    });
    await Promise.all(promises);
    if (i + 10 < upIds.length) await delay(300);
  }

  // Mapear user_product_id → sku_venta y sumar cantidades
  const stockBySku = new Map<string, number>();
  skuToUserProductIds.forEach((upIdSet, skuVenta) => {
    let total = 0;
    const counted = new Set<string>();
    Array.from(upIdSet).forEach(upId => {
      if (counted.has(upId)) return;
      counted.add(upId);
      total += distributedResults.get(upId) || 0;
    });
    stockBySku.set(skuVenta, total);
  });

  console.log(`[syncStockFull] ${stockBySku.size} SKUs con stock distribuido obtenido`);

  // 6c. Upsert stock_full_cache combinando cantidad distribuida + detalle fulfillment
  const allSkus = new Set([...Array.from(stockBySku.keys()), ...Array.from(detailBySku.keys())]);
  const stockUpsert = Array.from(allSkus).map(sku_venta => {
    const detail = detailBySku.get(sku_venta) || {
      stock_no_disponible: 0, stock_danado: 0, stock_perdido: 0, stock_transferencia: 0,
    };
    return {
      sku_venta,
      cantidad: stockBySku.get(sku_venta) || 0,
      stock_no_disponible: detail.stock_no_disponible,
      stock_danado: detail.stock_danado,
      stock_perdido: detail.stock_perdido,
      stock_transferencia: detail.stock_transferencia,
      fuente: "ml_distributed",
      updated_at: new Date().toISOString(),
    };
  });

  for (let i = 0; i < stockUpsert.length; i += 500) {
    const batch = stockUpsert.slice(i, i + 500);
    const { error } = await sb.from("stock_full_cache").upsert(batch, { onConflict: "sku_venta" });
    if (error) errores.push(`Upsert stock_full_cache error: ${error.message}`);
  }

  // 7. Pase final: actualizar SKUs que tienen user_product_id en ml_items_map
  //    pero no fueron encontrados por el flujo de listado del seller (resolveSkuVenta).
  //    Esto garantiza que TODOS los SKUs mapeados tengan su stock Full correcto.
  console.log("[syncStockFull] Pase final: verificando SKUs de ml_items_map...");
  const { data: allMappings } = await sb.from("ml_items_map")
    .select("sku, user_product_id")
    .eq("activo", true)
    .not("user_product_id", "is", null);

  let extraUpdated = 0;
  if (allMappings && allMappings.length > 0) {
    // Filtrar SKUs que NO fueron actualizados en este sync
    const skusYaActualizados = allSkus;
    const pendientes = (allMappings as { sku: string; user_product_id: string }[])
      .filter(m => !skusYaActualizados.has(m.sku));

    // Deduplicar por user_product_id
    const upIdToSkus = new Map<string, string[]>();
    for (const m of pendientes) {
      if (!upIdToSkus.has(m.user_product_id)) upIdToSkus.set(m.user_product_id, []);
      upIdToSkus.get(m.user_product_id)!.push(m.sku);
    }

    const pendUpIds = Array.from(upIdToSkus.keys());
    console.log(`[syncStockFull] ${pendUpIds.length} user_product_ids pendientes de actualizar`);

    for (let i = 0; i < pendUpIds.length; i += 10) {
      const batch = pendUpIds.slice(i, i + 10);
      const promises = batch.map(async (upId) => {
        try {
          const stockData = await getDistributedStock(upId);
          if (!stockData) return;
          const fullQty = stockData.locations
            .filter(l => l.type === "meli_facility")
            .reduce((sum, l) => sum + l.quantity, 0);
          const skus = upIdToSkus.get(upId) || [];
          for (const sku of skus) {
            await sb.from("stock_full_cache").upsert({
              sku_venta: sku,
              cantidad: fullQty,
              fuente: "ml_distributed",
              updated_at: new Date().toISOString(),
            }, { onConflict: "sku_venta" });
            extraUpdated++;
          }
        } catch (err) {
          errores.push(`Extra distributed ${upId}: ${err}`);
        }
      });
      await Promise.all(promises);
      if (i + 10 < pendUpIds.length) await delay(300);
    }
    if (extraUpdated > 0) {
      console.log(`[syncStockFull] ${extraUpdated} SKUs extra actualizados desde ml_items_map`);
    }
  }

  // 8. Limpiar entradas stale: SKUs en stock_full_cache que no fueron tocados en este sync
  //    tienen datos viejos (ej: de ProfitGuard). Poner cantidad=0 para los no actualizados.
  const skusActualizados = new Set<string>();
  allSkus.forEach(s => skusActualizados.add(s.toUpperCase()));
  if (allMappings) {
    for (const m of allMappings as { sku: string }[]) {
      skusActualizados.add(m.sku.toUpperCase());
    }
  }

  const { data: allCacheRows } = await sb.from("stock_full_cache")
    .select("sku_venta")
    .gt("cantidad", 0);

  if (allCacheRows && allCacheRows.length > 0) {
    const staleSkus = (allCacheRows as { sku_venta: string }[])
      .filter(r => !skusActualizados.has(r.sku_venta.toUpperCase()));

    if (staleSkus.length > 0) {
      console.log(`[syncStockFull] Limpiando ${staleSkus.length} entradas stale en stock_full_cache`);
      for (let i = 0; i < staleSkus.length; i += 500) {
        const batch = staleSkus.slice(i, i + 500).map(r => r.sku_venta);
        await sb.from("stock_full_cache")
          .update({ cantidad: 0, fuente: "ml_stale_cleanup", updated_at: new Date().toISOString() })
          .in("sku_venta", batch);
      }
    }
  }

  const result: SyncStockFullResult = {
    ok: errores.length === 0,
    items_sincronizados: itemsMapRows.length,
    stock_actualizado: allSkus.size + extraUpdated,
    sin_inventory_id: sinInventoryId,
    errores,
    tiempo_ms: Date.now() - start,
  };

  console.log(`[syncStockFull] Completado: ${result.items_sincronizados} items, ${result.stock_actualizado} SKUs actualizados, ${result.sin_inventory_id} sin inventory_id, ${result.errores.length} errores en ${result.tiempo_ms}ms`);
  return result;
}

/**
 * Actualiza stock Full para un inventory_id específico (llamado desde webhook).
 * Retorna el sku_venta actualizado o null si no se pudo mapear.
 */
export async function syncSingleFulfillmentStock(inventoryId: string): Promise<string | null> {
  const sb = getServerSupabase();
  const config = await getMLConfig();
  if (!config?.seller_id || !sb) return null;

  // Mapear inventory_id → sku_venta via composicion_venta
  const { data: compData } = await sb.from("composicion_venta")
    .select("sku_venta")
    .ilike("codigo_ml", inventoryId);

  if (!compData || compData.length === 0) {
    console.log(`[syncSingleFulfillmentStock] No se encontró mapeo para inventory_id ${inventoryId}`);
    return null;
  }

  const skuVenta = compData[0].sku_venta;

  // Obtener stock fulfillment
  const detail = await fetchFulfillmentStock(inventoryId, config.seller_id);
  if (!detail) {
    console.error(`[syncSingleFulfillmentStock] No se pudo obtener fulfillment para ${inventoryId}`);
    return null;
  }

  const nad = detail.not_available_detail || {};

  // Actualizar ml_items_map
  await sb.from("ml_items_map")
    .update({
      available_quantity: detail.available_quantity,
      updated_at: new Date().toISOString(),
    })
    .eq("inventory_id", inventoryId);

  // Upsert stock_full_cache
  // Si el SKU venta tiene múltiples inventory_ids, necesitamos sumar todos
  // Buscar todos los inventory_ids de este sku_venta
  const { data: allComp } = await sb.from("composicion_venta")
    .select("codigo_ml")
    .eq("sku_venta", skuVenta);

  let totalDisponible = 0;
  let totalNoDispo = 0;
  let totalDanado = 0;
  let totalPerdido = 0;
  let totalTransfer = 0;

  if (allComp && allComp.length > 1) {
    // Múltiples inventory_ids para este SKU venta — consultar todos
    for (const comp of allComp) {
      if (comp.codigo_ml.toUpperCase() === inventoryId.toUpperCase()) {
        // Este es el que ya tenemos
        totalDisponible += detail.available_quantity || 0;
        totalNoDispo += detail.not_available_quantity || 0;
        totalDanado += nad.damaged || 0;
        totalPerdido += nad.lost || 0;
        totalTransfer += nad.in_transfer || 0;
      } else {
        // Consultar los otros
        const otherDetail = await fetchFulfillmentStock(comp.codigo_ml, config.seller_id);
        if (otherDetail) {
          const oNad = otherDetail.not_available_detail || {};
          totalDisponible += otherDetail.available_quantity || 0;
          totalNoDispo += otherDetail.not_available_quantity || 0;
          totalDanado += oNad.damaged || 0;
          totalPerdido += oNad.lost || 0;
          totalTransfer += oNad.in_transfer || 0;
        }
      }
    }
  } else {
    totalDisponible = detail.available_quantity || 0;
    totalNoDispo = detail.not_available_quantity || 0;
    totalDanado = nad.damaged || 0;
    totalPerdido = nad.lost || 0;
    totalTransfer = nad.in_transfer || 0;
  }

  await sb.from("stock_full_cache").upsert({
    sku_venta: skuVenta,
    cantidad: totalDisponible,
    stock_no_disponible: totalNoDispo,
    stock_danado: totalDanado,
    stock_perdido: totalPerdido,
    stock_transferencia: totalTransfer,
    fuente: "ml_sync",
    updated_at: new Date().toISOString(),
  }, { onConflict: "sku_venta" });

  console.log(`[syncSingleFulfillmentStock] ${skuVenta}: ${totalDisponible} disponible, ${totalDanado} dañado, ${totalPerdido} perdido`);
  return skuVenta;
}

// ==================== OAUTH URL ====================

export function getOAuthUrl(clientId: string, redirectUri: string): string {
  return `${ML_AUTH}/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=offline_access`;
}
