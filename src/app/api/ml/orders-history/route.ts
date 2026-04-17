import { NextRequest, NextResponse } from "next/server";
import { mlGet, getMLConfig } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300; // 5 min (Vercel Pro)
export const dynamic = "force-dynamic";

/* ───── Tipos ML API ───── */

interface MLSearchResult {
  results: MLOrderFull[];
  paging: { total: number; offset: number; limit: number };
}

interface MLOrderFull {
  id: number;
  date_created: string;
  date_closed: string;
  status: string;
  order_items: Array<{
    item: { id: string; title: string; seller_sku: string | null; variation_id?: number };
    quantity: number;
    unit_price: number;
    sale_fee: number;
  }>;
  shipping: { id: number; logistic_type?: string };
  shipping_cost: number | null;
  pack_id: number | null;
  buyer: { id: number; nickname: string; first_name?: string; last_name?: string };
  total_amount: number;
  currency_id: string;
  tags?: string[];
  mediations?: Array<{ id: number }>;
}

interface BillingOrderDetail {
  order_id: number;
  sale_fee?: { gross: number; net: number; rebate: number } | null;
  details?: Array<{
    charge_info?: { detail_amount: number; detail_sub_type: string; detail_type: string; transaction_detail: string; legal_document_number: string | null; legal_document_status: string | null; legal_document_status_description: string | null };
    discount_info?: { charge_amount_without_discount: number; discount_amount: number; discount_reason: string };
    sales_info?: Array<{ order_id: number; transaction_amount: number; sale_fee?: { gross: number; net: number; rebate: number } }>;
    shipping_info?: { shipping_id: string; pack_id?: string; receiver_shipping_cost: number };
    items_info?: Array<{ item_id: string; item_price: number; item_amount: number }>;
    marketplace_info?: { marketplace: string };
  }>;
}

interface BillingResponse {
  results: BillingOrderDetail[];
}

/* ───── Helpers ───── */

interface MappedOrder {
  order_id: string;
  order_number: string;
  fecha: string;
  cliente: string;
  razon_social: string;
  sku_venta: string;
  nombre_producto: string;
  cantidad: number;
  canal: string;
  precio_unitario: number;
  subtotal: number;
  comision_unitaria: number;
  comision_total: number;
  costo_envio: number;
  ingreso_envio: number;
  ingreso_adicional_tc: number;
  total: number;
  total_neto: number;
  logistic_type: string;
  estado: string;
  fuente: string;
  documento_tributario: string;
  estado_documento: string;
}

/** Convert any date string to Chile timezone (America/Santiago) */
function toChileISO(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString("sv-SE", { timeZone: "America/Santiago" }).replace(" ", "T");
  } catch {
    return dateStr;
  }
}

function mapCanal(logisticType: string | undefined): string {
  if (!logisticType) return "Flex";
  if (logisticType === "fulfillment" || logisticType === "xd_drop_off") return "Full";
  return "Flex";
}

function mapEstado(status: string): string {
  switch (status) {
    case "paid": return "Pagada";
    case "cancelled": return "Cancelada";
    default: return status;
  }
}

/** Fetch all paid orders in date range with pagination */
async function fetchOrdersInRange(sellerId: string, from: string, to: string): Promise<MLOrderFull[]> {
  // Chile uses -03:00 in summer (CLST) and -04:00 in winter (CLT)
  // Use -04:00 for "from" (starts earlier in UTC) and -03:00 for "to" (ends later in UTC)
  // Expand "from" by 1 day to catch orders created late prev day but closed (paid) on target day
  // The caller filters by date_closed in Chile timezone after fetching
  const expandedFrom = new Date(from + "T00:00:00-04:00");
  expandedFrom.setDate(expandedFrom.getDate() - 1);
  const expandedFromISO = expandedFrom.toISOString();
  const toISO = new Date(to + "T23:59:59-03:00").toISOString();

  const allOrders: MLOrderFull[] = [];
  let offset = 0;
  const limit = 50;
  const maxPages = 40; // Safety: max 2000 orders

  for (let page = 0; page < maxPages; page++) {
    // ML only supports filtering by date_created (not date_closed)
    // We expand the range by 1 day earlier to catch orders created late on prev day but closed on target day
    const url = `/orders/search?seller=${sellerId}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(expandedFromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=${limit}&offset=${offset}`;
    const result = await mlGet<MLSearchResult>(url);
    if (!result || !result.results || result.results.length === 0) break;

    allOrders.push(...result.results);
    offset += limit;
    if (offset >= result.paging.total) break;

    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  return allOrders;
}

/** Shipment costs from /shipments/{id}/costs */
interface ShipmentCosts {
  gross_amount: number;
  senders: Array<{
    user_id: number;
    cost: number;
    compensation: number;
    discounts: Array<{ rate: number; type: string; promoted_amount: number }>;
  }>;
  receiver?: {
    user_id: number;
    cost: number;
    discounts: Array<{ rate: number; type: string; promoted_amount: number }>;
  };
}

/** Tags on orders that indicate costs may have changed (claim, return, refund) */
const REFETCH_TAGS = new Set(["claim", "returned", "refund", "mediation"]);

/**
 * Fetch shipment costs with DB cache.
 * 1. Read cached costs from ml_shipments
 * 2. Only call /shipments/{id}/costs for uncached or stale shipments
 * 3. Save new costs to DB
 * Stale = order was cancelled, has claim/return tags, or shipment status changed
 */
async function fetchShipmentCostsWithCache(
  shippingIds: number[],
  orderTagsByShipment: Map<number, string[]>,
): Promise<Map<number, { senderCost: number; bonificacion: number }>> {
  const map = new Map<number, { senderCost: number; bonificacion: number }>();
  if (shippingIds.length === 0) return map;

  const sb = getServerSupabase();

  // 1. Read cached costs from DB
  const needsFetch: number[] = [];
  if (sb) {
    for (let i = 0; i < shippingIds.length; i += 500) {
      const chunk = shippingIds.slice(i, i + 500);
      const { data } = await sb.from("ml_shipments")
        .select("shipment_id, sender_cost, bonificacion, costs_cached_at, status")
        .in("shipment_id", chunk);
      if (data) {
        for (const row of data as { shipment_id: number; sender_cost: number | null; bonificacion: number | null; costs_cached_at: string | null; status: string }[]) {
          // Check if we need to re-fetch (no cache, or order has claim/return tags)
          const tags = orderTagsByShipment.get(row.shipment_id) || [];
          const hasRefetchTag = tags.some(t => REFETCH_TAGS.has(t));
          const isCancelled = row.status === "cancelled" || row.status === "not_delivered";

          if (row.costs_cached_at && row.sender_cost !== null && !hasRefetchTag && !isCancelled) {
            // Use cached value
            map.set(row.shipment_id, { senderCost: row.sender_cost, bonificacion: row.bonificacion || 0 });
          } else {
            needsFetch.push(row.shipment_id);
          }
        }
      }
    }
    // Also add any shipment IDs not found in DB at all
    for (const sid of shippingIds) {
      if (!map.has(sid) && !needsFetch.includes(sid)) needsFetch.push(sid);
    }
  } else {
    needsFetch.push(...shippingIds);
  }

  const cachedCount = map.size;
  console.log(`[ML Orders History] Costs: ${cachedCount} cached, ${needsFetch.length} to fetch from API`);

  // 2. Fetch uncached costs from ML API in parallel
  const BATCH = 10;
  const newCosts: Array<{ shipment_id: number; sender_cost: number; bonificacion: number }> = [];
  for (let i = 0; i < needsFetch.length; i += BATCH) {
    const batch = needsFetch.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sid) => {
      try {
        const costs = await mlGet<ShipmentCosts>(`/shipments/${sid}/costs`);
        if (costs) {
          const sender = costs.senders?.[0];
          const senderCost = Math.round(sender?.cost || 0);
          // Ingreso envío para el vendedor tiene 3 fuentes:
          //   1. sender.discounts → bonificación ML al vendedor
          //   2. receiver.discounts tipo "loyal" → ML compensa por envío gratis de lealtad
          //   3. receiver.cost → comprador pagó envío, ese dinero va al vendedor
          // NO incluir receiver.discounts tipo "ratio" (descuento interno ML al comprador)
          const senderBonif = sender?.discounts?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0;
          const receiverLoyalBonif = costs.receiver?.discounts
            ?.filter(d => d.type === "loyal")
            ?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0;
          const receiverPaidShipping = Math.round(costs.receiver?.cost || 0);
          const bonificacion = Math.round(senderBonif + receiverLoyalBonif + receiverPaidShipping);
          map.set(sid, { senderCost, bonificacion });
          newCosts.push({ shipment_id: sid, sender_cost: senderCost, bonificacion });
        }
      } catch { /* skip */ }
    }));
    if (i + BATCH < needsFetch.length) await new Promise(r => setTimeout(r, 150));
  }

  // 3. Save new costs to DB
  if (sb && newCosts.length > 0) {
    for (let i = 0; i < newCosts.length; i += 100) {
      const chunk = newCosts.slice(i, i + 100);
      for (const c of chunk) {
        void sb.from("ml_shipments").update({
          sender_cost: c.sender_cost,
          bonificacion: c.bonificacion,
          costs_cached_at: new Date().toISOString(),
        }).eq("shipment_id", c.shipment_id);
      }
    }
    console.log(`[ML Orders History] Saved ${newCosts.length} new costs to cache`);
  }

  return map;
}

/** Fetch billing details for a batch of order IDs (parallel, 3 concurrent) */
async function fetchBillingForOrders(orderIds: number[]): Promise<Map<number, BillingOrderDetail>> {
  const map = new Map<number, BillingOrderDetail>();
  if (orderIds.length === 0) return map;

  const batches: number[][] = [];
  for (let i = 0; i < orderIds.length; i += 20) {
    batches.push(orderIds.slice(i, i + 20));
  }

  // Process 3 batches in parallel
  for (let i = 0; i < batches.length; i += 3) {
    const group = batches.slice(i, i + 3);
    await Promise.all(group.map(async (batch) => {
      try {
        const result = await mlGet<BillingResponse>(
          `/billing/integration/group/ML/order/details?order_ids=${batch.join(",")}`
        );
        if (result?.results) {
          for (const detail of result.results) {
            if (detail.order_id) map.set(detail.order_id, detail);
          }
        }
      } catch (err) {
        console.warn(`[ML Orders History] Billing fetch failed for batch: ${err}`);
      }
    }));
    if (i + 3 < batches.length) await new Promise(r => setTimeout(r, 100));
  }

  return map;
}

/** Extract financial data from billing detail (matches ProfitGuard structure) */
function extractBillingData(billing: BillingOrderDetail | undefined) {
  const data = {
    costo_envio: 0,           // Net shipping cost (detail_amount, post-bonificación)
    ingreso_envio: 0,         // Bonificación de envío (discount_amount del CFF)
    ingreso_adicional_tc: 0,
    has_shipping_detail: false, // Whether billing had a CFF/CXD detail
  };

  if (!billing) return data;

  if (billing.details) {
    for (const detail of billing.details) {
      const subType = detail.charge_info?.detail_sub_type || "";
      const marketplace = detail.marketplace_info?.marketplace || "";

      // CFF / CXD = Cargo por envíos
      if (subType === "CFF" || subType === "CXD" || (marketplace === "SHIPPING" && detail.charge_info?.detail_type === "CHARGE")) {
        data.has_shipping_detail = true;
        data.costo_envio += Math.abs(detail.charge_info?.detail_amount || 0);

        // Bonificación = discount_amount (lo que ML descuenta del cargo de envío)
        if (detail.discount_info?.discount_amount) {
          data.ingreso_envio += Math.abs(detail.discount_info.discount_amount);
        }
      }
    }
  }

  return data;
}

/** Fetch all open claims/mediations to identify orders that should not count as sales */
async function fetchOpenClaimOrderIds(): Promise<Set<number>> {
  const claimOrderIds = new Set<number>();
  try {
    // status=opened catches both "claim" and "dispute" stages
    const result = await mlGet<{ paging: { total: number }; data: Array<{ resource_id: number; status: string }> }>(
      "/post-purchase/v1/claims/search?status=opened&limit=100"
    );
    if (result?.data) {
      for (const claim of result.data) {
        if (claim.resource_id) claimOrderIds.add(claim.resource_id);
      }
    }
    // Also fetch claims with status=closed that were resolved with refund (seller lost)
    const closedResult = await mlGet<{ paging: { total: number }; data: Array<{ resource_id: number; status: string; resolution: { reason: string } | null }> }>(
      "/post-purchase/v1/claims/search?status=closed&limit=100"
    );
    if (closedResult?.data) {
      for (const claim of closedResult.data) {
        // If resolution resulted in refund to buyer, exclude this order
        if (claim.resolution?.reason === "refunded" || claim.resolution?.reason === "buyer_refunded") {
          claimOrderIds.add(claim.resource_id);
        }
      }
    }
  } catch (err) {
    console.warn("[ML Orders History] Could not fetch claims:", err);
  }
  return claimOrderIds;
}

/* ───── Route Handler ───── */

export async function GET(req: NextRequest) {
  const config = await getMLConfig();
  if (!config || !config.seller_id) {
    return NextResponse.json({ error: "ML no configurado o sin seller_id" }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const debug = searchParams.get("debug") === "true";
  const tarifaFlex = parseInt(searchParams.get("tarifa_flex") || "3320") || 3320;

  if (!from || !to) {
    return NextResponse.json({ error: "Parámetros 'from' y 'to' son requeridos (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    // 1. Fetch all paid orders in range (ML may return edge-case orders from adjacent days due to timezone)
    console.log(`[ML Orders History] Fetching orders ${from} → ${to}`);
    const rawOrders = await fetchOrdersInRange(config.seller_id, from, to);

    // Filter by Chile date (using date_closed = when payment was accredited, matches ML panel)
    const orders = rawOrders.filter(o => {
      const chileDate = toChileISO(o.date_closed || o.date_created).slice(0, 10);
      return chileDate >= from && chileDate <= to;
    });
    console.log(`[ML Orders History] ${orders.length} orders in range (${rawOrders.length} from API, ${rawOrders.length - orders.length} filtered out by timezone)`);

    if (orders.length === 0) {
      return NextResponse.json({ ordenes: [], total: 0, total_raw: rawOrders.length });
    }

    // 2. Fetch open claims to identify orders in mediation
    console.log(`[ML Orders History] Fetching open claims`);
    const claimOrderIds = await fetchOpenClaimOrderIds();
    // Also check mediations array on each order
    for (const order of orders) {
      if (order.mediations && order.mediations.length > 0) {
        claimOrderIds.add(order.id);
      }
    }
    console.log(`[ML Orders History] ${claimOrderIds.size} orders in mediation/claims`);

    // 3. Fetch billing details
    const orderIds = orders.map(o => o.id);
    console.log(`[ML Orders History] Fetching billing for ${orderIds.length} orders`);
    const billingMap = await fetchBillingForOrders(orderIds);
    console.log(`[ML Orders History] Got billing for ${billingMap.size} orders`);

    // 3. Resolve logistic_type from ml_shipments + ML API for missing ones
    const shipmentLogisticMap = new Map<number, string>(); // shipping_id → logistic_type
    const allShippingIds = Array.from(new Set(orders.map(o => o.shipping?.id).filter(Boolean))) as number[];
    const sb = getServerSupabase();
    if (sb) {
      for (let i = 0; i < allShippingIds.length; i += 500) {
        const chunk = allShippingIds.slice(i, i + 500);
        const { data } = await sb.from("ml_shipments").select("shipment_id, logistic_type").in("shipment_id", chunk);
        if (data) {
          for (const row of data as { shipment_id: number; logistic_type: string }[]) {
            shipmentLogisticMap.set(row.shipment_id, row.logistic_type);
          }
        }
      }
    }
    // Fetch logistic_type from ML API for shipments not in DB
    const missingShipIds = allShippingIds.filter(id => !shipmentLogisticMap.has(id));
    if (missingShipIds.length > 0) {
      console.log(`[ML Orders History] Fetching logistic_type for ${missingShipIds.length} shipments from API`);
      for (let i = 0; i < missingShipIds.length; i += 10) {
        const batch = missingShipIds.slice(i, i + 10);
        await Promise.all(batch.map(async (sid) => {
          try {
            const ship = await mlGet<{ id: number; logistic_type?: string; logistic?: { type?: string } }>(`/shipments/${sid}`, { "x-format-new": "true" });
            const lt = ship?.logistic?.type || ship?.logistic_type;
            if (lt) {
              shipmentLogisticMap.set(sid, lt);
            }
          } catch { /* ignore */ }
        }));
        if (i + 10 < missingShipIds.length) await new Promise(r => setTimeout(r, 200));
      }
    }

    // 4. Fetch shipment costs (with DB cache) — only calls ML API for uncached shipments
    //    Re-fetches if order has claim/return/cancelled tags
    const orderTagsByShipment = new Map<number, string[]>();
    for (const order of orders) {
      const sid = order.shipping?.id;
      if (sid && order.tags) {
        const existing = orderTagsByShipment.get(sid) || [];
        orderTagsByShipment.set(sid, [...existing, ...order.tags]);
      }
    }
    console.log(`[ML Orders History] Fetching shipment costs for ${allShippingIds.length} shipments`);
    const shipmentCostsMap = await fetchShipmentCostsWithCache(allShippingIds, orderTagsByShipment);
    console.log(`[ML Orders History] Got costs for ${shipmentCostsMap.size} shipments`);

    // 5. Group orders by shipping_id to handle shared shipping costs
    //    Orders in same pack share shipping_id. Billing CFF only appears on one order.
    const shipGroups = new Map<string, MLOrderFull[]>();
    for (const order of orders) {
      if (!order.order_items || order.order_items.length === 0) continue;
      const key = order.shipping?.id ? String(order.shipping.id) : `solo_${order.id}`;
      const group = shipGroups.get(key) || [];
      group.push(order);
      shipGroups.set(key, group);
    }

    // 5b. Resolver tamaño canónico de cada pack vía /packs/{pack_id}.
    // Si este batch no incluye TODAS las órdenes de un pack, sin este lookup
    // el costo de envío se sobreestima (se asigna completo a las que están).
    const packSizeMap = new Map<string, number>();
    const packIds = new Set<number>();
    for (const o of orders) if (o.pack_id && o.pack_id !== o.id) packIds.add(o.pack_id);
    for (const pid of Array.from(packIds)) {
      try {
        const packInfo = await mlGet<{ orders?: Array<{ id: number }> }>(`/packs/${pid}`);
        const size = Array.isArray(packInfo?.orders) ? packInfo.orders.length : 0;
        if (size > 0) packSizeMap.set(String(pid), size);
      } catch { /* fallback al count local */ }
    }
    console.log(`[ML Orders History] ${packIds.size} packs consultados, ${packSizeMap.size} resueltos`);

    // 5. Map to MappedOrder format, prorate shipping across pack
    const ordenes: MappedOrder[] = [];
    const debugData: Array<{ order_id: number; billing: BillingOrderDetail | undefined; order: MLOrderFull }> = [];

    for (const [shipKey, packOrders] of Array.from(shipGroups.entries())) {
      // Count total items in pack for equal split
      const batchItemCount = packOrders.reduce((s, o) => s + o.order_items.length, 0);
      const canonicalPackId = packOrders.find(o => o.pack_id && o.pack_id !== o.id)?.pack_id;
      const canonicalPackSize = canonicalPackId ? packSizeMap.get(String(canonicalPackId)) : undefined;
      const packItemCount = canonicalPackSize || batchItemCount;

      // Resolve logistic_type for the shipment group
      const groupLogisticType = (() => {
        for (const o of packOrders) {
          const lt = o.shipping?.logistic_type || shipmentLogisticMap.get(o.shipping?.id);
          if (lt) return lt;
        }
        for (const o of packOrders) {
          const billing = billingMap.get(o.id);
          if (billing?.details?.[0]?.marketplace_info?.marketplace === "SHIPPING") return "self_service";
        }
        return "";
      })();

      // Get shipping costs: prefer /shipments/{id}/costs (has real sender cost + bonificación)
      const shippingId = packOrders[0]?.shipping?.id;
      const shipCosts = shippingId ? shipmentCostsMap.get(shippingId) : undefined;

      let packCostoEnvio = 0;
      let packBonificacion = 0;

      const isFlex = groupLogisticType === "self_service";

      if (isFlex) {
        // Flex: ML no cobra envío al seller. El costo es la tarifa fija del transportista.
        // /shipments/{id}/costs → sender.cost es referencia logística, NO se cobra.
        // Bonificación sí viene de /shipments/costs (sender.discounts)
        packCostoEnvio = tarifaFlex;
        packBonificacion = shipCosts ? Math.round(shipCosts.bonificacion) : 0;
      } else if (shipCosts) {
        // Full: ML cobra envío al seller via CFF/CXD. sender.cost = costo real.
        packCostoEnvio = Math.round(shipCosts.senderCost);
        packBonificacion = 0; // Full discounts are internal to ML
      } else {
        // Fallback to billing API for Full
        for (const order of packOrders) {
          const billing = billingMap.get(order.id);
          const billingData = extractBillingData(billing);
          if (billingData.has_shipping_detail) {
            packCostoEnvio += billingData.costo_envio;
          }
        }
      }

      for (const order of packOrders) {
        const logisticType = groupLogisticType;

        if (debug) {
          debugData.push({ order_id: order.id, billing: billingMap.get(order.id), order });
        }

        for (const item of order.order_items) {
          const skuVenta = (item.item.seller_sku || `ML-${item.item.id}`).toUpperCase();
          const itemSubtotal = item.unit_price * item.quantity;

          const comisionUnitaria = Math.round(item.sale_fee || 0);
          const comisionTotal = comisionUnitaria * item.quantity;

          // Shipping split equally across all items in the shipment group
          const costoEnvio = Math.round(packCostoEnvio / packItemCount);
          const bonificacion = Math.round(packBonificacion / packItemCount);

          const precioUnit = Math.round(item.unit_price);
          const subtotal = Math.round(itemSubtotal);
          const total = subtotal;
          // Neto = lo que recibimos: subtotal - comisión - envío + bonificación
          const totalNeto = subtotal - comisionTotal - costoEnvio + bonificacion;

          // Extract billing document info
          const billing = billingMap.get(order.id);
          const cvDetail = billing?.details?.find(d => d.charge_info?.detail_sub_type === "CV");
          const docNum = cvDetail?.charge_info?.legal_document_number || "";
          const docStatus = cvDetail?.charge_info?.legal_document_status_description || cvDetail?.charge_info?.legal_document_status || "";

          ordenes.push({
            order_id: String(order.id),
            order_number: String(order.pack_id || order.id),
            fecha: toChileISO(order.date_closed || order.date_created),
            cliente: [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(" ") || order.buyer?.nickname || "",
            razon_social: "",
            sku_venta: skuVenta,
            nombre_producto: item.item.title,
            cantidad: item.quantity,
            canal: mapCanal(logisticType),
            precio_unitario: precioUnit,
            subtotal,
            comision_unitaria: comisionUnitaria,
            comision_total: comisionTotal,
            costo_envio: costoEnvio,
            ingreso_envio: bonificacion,
            ingreso_adicional_tc: 0,
            total,
            total_neto: totalNeto,
            logistic_type: logisticType,
            estado: claimOrderIds.has(order.id) ? "En mediación" : mapEstado(order.status),
            fuente: "ml_directo",
            documento_tributario: docNum,
            estado_documento: docStatus,
          });
        }
      }
    }

    console.log(`[ML Orders History] ${ordenes.length} items mapped from ${orders.length} orders`);

    const response: Record<string, unknown> = {
      ordenes,
      total: ordenes.length,
      total_raw: orders.length,
      billing_coverage: `${billingMap.size}/${orders.length}`,
      tarifa_flex: tarifaFlex,
    };

    if (debug && debugData.length > 0) {
      const debugFilter = req.nextUrl.searchParams.get("debug_order");
      if (debugFilter) {
        response.debug = debugData.filter(d => String(d.order_id) === debugFilter);
      } else {
        response.debug = debugData.slice(0, 5);
      }
    }

    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    console.error("[ML Orders History] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
