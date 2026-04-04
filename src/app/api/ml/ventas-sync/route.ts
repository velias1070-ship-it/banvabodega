import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet, getMLConfig } from "@/lib/ml";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Cron: sync ventas ML al cache.
 * Llama directamente a ML API (no HTTP a sí mismo) y guarda en ventas_ml_cache.
 *
 * GET (cron)         — últimos 3 días
 * GET ?days=N        — últimos N días
 * GET ?full=1        — mes actual + anterior
 * GET ?from=X&to=Y   — rango personalizado
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const referer = req.headers.get("referer") || "";
  const isAdminCall = referer.includes("/admin");
  const hasParams = req.nextUrl.searchParams.has("full") || req.nextUrl.searchParams.has("from") || req.nextUrl.searchParams.has("days");

  if (!isVercelCron && !isLocalDev && !isAdminCall && !hasParams) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const config = await getMLConfig();
  if (!config?.seller_id) return NextResponse.json({ error: "ML no configurado" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const isFull = searchParams.get("full") === "1";
  const daysParam = parseInt(searchParams.get("days") || "3") || 3;
  const customFrom = searchParams.get("from");
  const customTo = searchParams.get("to");
  const tarifaFlex = parseInt(searchParams.get("tarifa_flex") || "3320") || 3320;

  const today = new Date();
  let fromDate: string;
  let toDate: string;

  if (customFrom && customTo) {
    fromDate = customFrom;
    toDate = customTo;
  } else if (isFull) {
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    fromDate = lastMonthStart.toISOString().slice(0, 10);
    toDate = today.toISOString().slice(0, 10);
  } else {
    const from = new Date(today);
    from.setDate(from.getDate() - (daysParam - 1));
    fromDate = from.toISOString().slice(0, 10);
    toDate = today.toISOString().slice(0, 10);
  }

  console.log(`[Ventas Sync] Syncing ${fromDate} → ${toDate}`);

  try {
    // 1. Fetch orders from ML API in 15-day chunks
    const allOrders: MLOrder[] = [];
    const cursor = new Date(fromDate + "T00:00:00");
    const end = new Date(toDate + "T00:00:00");

    while (cursor <= end) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + 14);
      const actualEnd = chunkEnd > end ? end : chunkEnd;
      const cf = cursor.toISOString().slice(0, 10);
      const ct = actualEnd.toISOString().slice(0, 10);

      // Expand range by 1 day to catch timezone edge cases
      const expandedFrom = new Date(cf + "T00:00:00-04:00");
      expandedFrom.setDate(expandedFrom.getDate() - 1);
      const fromISO = expandedFrom.toISOString();
      const toISO = new Date(ct + "T23:59:59-03:00").toISOString();

      let offset = 0;
      for (let page = 0; page < 40; page++) {
        const url = `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}`;
        const result = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(url);
        if (!result?.results?.length) break;
        allOrders.push(...result.results);
        offset += 50;
        if (offset >= result.paging.total) break;
        await new Promise(r => setTimeout(r, 100));
      }

      cursor.setDate(actualEnd.getDate() + 1);
    }

    // 2. Filter by Chile date_closed
    const orders = allOrders.filter(o => {
      const chileDate = toChileISO(o.date_closed || o.date_created).slice(0, 10);
      return chileDate >= fromDate && chileDate <= toDate;
    });
    console.log(`[Ventas Sync] ${orders.length} orders in range (${allOrders.length} raw)`);

    if (orders.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, range: `${fromDate} → ${toDate}` });
    }

    // 3. Fetch open claims
    const claimOrderIds = new Set<number>();
    try {
      const claims = await mlGet<{ data: Array<{ resource_id: number }> }>("/post-purchase/v1/claims/search?status=opened&limit=100");
      if (claims?.data) for (const c of claims.data) claimOrderIds.add(c.resource_id);
    } catch { /* ignore */ }
    for (const o of orders) {
      if (o.mediations?.length) claimOrderIds.add(o.id);
    }

    // 4. Fetch shipment costs (batch)
    const shippingIds = Array.from(new Set(orders.map(o => o.shipping?.id).filter(Boolean))) as number[];
    const shipCostsMap = new Map<number, { senderCost: number; receiverCost: number; senderBonif: number; receiverLoyalBonif: number }>();

    for (let i = 0; i < shippingIds.length; i += 10) {
      const batch = shippingIds.slice(i, i + 10);
      await Promise.all(batch.map(async (sid) => {
        try {
          const costs = await mlGet<{ senders: Array<{ cost: number; discounts: Array<{ type: string; promoted_amount: number }> }>; receiver?: { cost: number; discounts: Array<{ type: string; promoted_amount: number }> } }>(`/shipments/${sid}/costs`);
          if (costs) {
            const sender = costs.senders?.[0];
            shipCostsMap.set(sid, {
              senderCost: Math.round(sender?.cost || 0),
              receiverCost: Math.round(costs.receiver?.cost || 0),
              senderBonif: sender?.discounts?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0,
              receiverLoyalBonif: costs.receiver?.discounts?.filter(d => d.type === "loyal")?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0,
            });
          }
        } catch { /* skip */ }
      }));
      if (i + 10 < shippingIds.length) await new Promise(r => setTimeout(r, 150));
    }

    // 5. Resolve logistic types
    const logisticMap = new Map<number, string>();
    const missingLogistic: number[] = [];
    for (const sid of shippingIds) {
      // Check DB cache first
      const { data } = await sb.from("ml_shipments").select("logistic_type").eq("shipment_id", sid).maybeSingle();
      if (data?.logistic_type) logisticMap.set(sid, data.logistic_type);
      else missingLogistic.push(sid);
    }
    for (let i = 0; i < missingLogistic.length; i += 10) {
      const batch = missingLogistic.slice(i, i + 10);
      await Promise.all(batch.map(async (sid) => {
        try {
          const ship = await mlGet<{ logistic_type?: string; logistic?: { type?: string } }>(`/shipments/${sid}`, { "x-format-new": "true" });
          const lt = ship?.logistic?.type || ship?.logistic_type;
          if (lt) logisticMap.set(sid, lt);
        } catch { /* skip */ }
      }));
    }

    // 6. Fetch billing
    const billingMap = new Map<number, { docNum: string; docStatus: string }>();
    const orderIds = orders.map(o => o.id);
    for (let i = 0; i < orderIds.length; i += 20) {
      const batch = orderIds.slice(i, i + 20);
      try {
        const result = await mlGet<{ results: Array<{ order_id: number; details?: Array<{ charge_info?: { legal_document_number: string | null; legal_document_status_description: string | null; detail_sub_type: string } }> }> }>(`/billing/integration/group/ML/order/details?order_ids=${batch.join(",")}`);
        if (result?.results) {
          for (const r of result.results) {
            const cv = r.details?.find(d => d.charge_info?.detail_sub_type === "CV");
            billingMap.set(r.order_id, {
              docNum: cv?.charge_info?.legal_document_number || "",
              docStatus: cv?.charge_info?.legal_document_status_description || "",
            });
          }
        }
      } catch { /* skip */ }
    }

    // 7. Map to cache rows
    const rows: Array<Record<string, unknown>> = [];
    // Group by shipping for pack handling
    const shipGroups = new Map<string, MLOrder[]>();
    for (const o of orders) {
      const key = o.shipping?.id ? String(o.shipping.id) : `solo_${o.id}`;
      const g = shipGroups.get(key) || [];
      g.push(o);
      shipGroups.set(key, g);
    }

    for (const [, packOrders] of Array.from(shipGroups.entries())) {
      const packItemCount = packOrders.reduce((s, o) => s + (o.order_items?.length || 1), 0);
      const shipId = packOrders[0]?.shipping?.id;
      const lt = shipId ? logisticMap.get(shipId) || "" : "";
      const isFlex = lt === "self_service";
      const canal = isFlex ? "Flex" : (lt === "fulfillment" || lt === "xd_drop_off" ? "Full" : "Flex");

      const costs = shipId ? shipCostsMap.get(shipId) : undefined;
      const packCostoEnvio = isFlex ? tarifaFlex : Math.round(costs?.senderCost || 0);
      const packBonificacion = Math.round((costs?.senderBonif || 0) + (costs?.receiverLoyalBonif || 0) + (costs?.receiverCost || 0));

      for (const order of packOrders) {
        const billing = billingMap.get(order.id);
        for (const item of (order.order_items || [])) {
          const sku = (item.item?.seller_sku || `ML-${item.item?.id}`).toUpperCase();
          const subtotal = Math.round(item.unit_price * item.quantity);
          const comisionUnit = Math.round(item.sale_fee || 0);
          const comisionTotal = comisionUnit * item.quantity;
          const costoEnvio = Math.round(packCostoEnvio / packItemCount);
          const bonificacion = Math.round(packBonificacion / packItemCount);
          const totalNeto = subtotal - comisionTotal - costoEnvio + bonificacion;

          rows.push({
            order_id: String(order.id),
            order_number: String(order.pack_id || order.id),
            fecha: toChileISO(order.date_closed || order.date_created),
            fecha_date: toChileISO(order.date_closed || order.date_created).slice(0, 10),
            cliente: [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(" ") || order.buyer?.nickname || "",
            razon_social: "",
            sku_venta: sku,
            nombre_producto: item.item?.title || "",
            cantidad: item.quantity,
            canal,
            precio_unitario: Math.round(item.unit_price),
            subtotal,
            comision_unitaria: comisionUnit,
            comision_total: comisionTotal,
            costo_envio: costoEnvio,
            ingreso_envio: bonificacion,
            ingreso_adicional_tc: 0,
            total: subtotal,
            total_neto: totalNeto,
            logistic_type: lt,
            estado: claimOrderIds.has(order.id) ? "En mediación" : "Pagada",
            documento_tributario: billing?.docNum || "",
            estado_documento: billing?.docStatus || "",
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    // 8. Upsert to DB
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from("ventas_ml_cache").upsert(chunk, { onConflict: "order_id,sku_venta" });
      if (error) console.warn(`[Ventas Sync] Upsert error:`, error.message);
      else upserted += chunk.length;
    }

    console.log(`[Ventas Sync] Done: ${upserted} rows for ${fromDate} → ${toDate}`);
    return NextResponse.json({ status: "ok", synced: upserted, total_orders: orders.length, claims: claimOrderIds.size, range: `${fromDate} → ${toDate}` });
  } catch (err) {
    console.error("[Ventas Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ───── Types ───── */

interface MLOrder {
  id: number;
  date_created: string;
  date_closed: string;
  status: string;
  order_items: Array<{
    item: { id: string; title: string; seller_sku: string | null };
    quantity: number;
    unit_price: number;
    sale_fee: number;
  }>;
  shipping: { id: number; logistic_type?: string };
  pack_id: number | null;
  buyer: { id: number; nickname: string; first_name?: string; last_name?: string };
  total_amount: number;
  tags?: string[];
  mediations?: Array<{ id: number }>;
}

function toChileISO(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString("sv-SE", { timeZone: "America/Santiago" }).replace(" ", "T");
  } catch {
    return dateStr;
  }
}
