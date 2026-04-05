import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet, getMLConfig } from "@/lib/ml";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Cron: sync ventas ML al cache (versión rápida).
 * Solo usa datos de /orders/search (sin billing ni shipment costs individuales).
 * El costo de envío se calcula con tarifa fija para Flex.
 * Bonificaciones se enriquecen en el endpoint orders-history bajo demanda.
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
  const hasParams = req.nextUrl.searchParams.has("full") || req.nextUrl.searchParams.has("from") || req.nextUrl.searchParams.has("days");

  if (!isVercelCron && !isLocalDev && !hasParams) {
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

  const todayChile = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const today = new Date(todayChile + "T12:00:00");
  let fromDate: string;
  let toDate: string;

  if (customFrom && customTo) {
    fromDate = customFrom;
    toDate = customTo;
  } else if (isFull) {
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    fromDate = lastMonthStart.toISOString().slice(0, 10);
    toDate = todayChile;
  } else {
    const from = new Date(today);
    from.setDate(from.getDate() - (daysParam - 1));
    fromDate = from.toISOString().slice(0, 10);
    toDate = todayChile;
  }

  console.log(`[Ventas Sync] ${fromDate} → ${toDate}`);

  try {
    // 1. Fetch orders from ML (fast — only /orders/search, no billing/costs)
    const allOrders: MLOrder[] = [];
    const cursor = new Date(fromDate + "T00:00:00");
    const end = new Date(toDate + "T00:00:00");

    while (cursor <= end) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + 14);
      const actualEnd = chunkEnd > end ? end : chunkEnd;

      const expandedFrom = new Date(cursor);
      expandedFrom.setDate(expandedFrom.getDate() - 1);
      const fromISO = new Date(expandedFrom.toISOString().slice(0, 10) + "T00:00:00-04:00").toISOString();
      const toISO = new Date(actualEnd.toISOString().slice(0, 10) + "T23:59:59-03:00").toISOString();

      let offset = 0;
      for (let page = 0; page < 40; page++) {
        const url = `/orders/search?seller=${config.seller_id}&order.status=paid&sort=date_desc&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}`;
        const result = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(url);
        if (!result?.results?.length) break;
        allOrders.push(...result.results);
        offset += 50;
        if (offset >= result.paging.total) break;
        await new Promise(r => setTimeout(r, 50));
      }
      cursor.setDate(actualEnd.getDate() + 1);
    }

    // 2. Filter by Chile date_closed
    const orders = allOrders.filter(o => {
      const chileDate = toChileISO(o.date_closed || o.date_created).slice(0, 10);
      return chileDate >= fromDate && chileDate <= toDate;
    });
    console.log(`[Ventas Sync] ${orders.length} orders (${allOrders.length} raw)`);

    if (orders.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, range: `${fromDate} → ${toDate}` });
    }

    // 3. Check claims (1 single API call)
    const claimOrderIds = new Set<number>();
    try {
      const claims = await mlGet<{ data: Array<{ resource_id: number }> }>("/post-purchase/v1/claims/search?status=opened&limit=100");
      if (claims?.data) for (const c of claims.data) claimOrderIds.add(c.resource_id);
    } catch { /* ignore */ }
    for (const o of orders) {
      if (o.mediations?.length) claimOrderIds.add(o.id);
    }

    // 4. Resolve logistic types + costs — DB cache first, then ML API for missing
    const shipIds = Array.from(new Set(orders.map(o => o.shipping?.id).filter(Boolean))) as number[];
    const logisticMap = new Map<number, string>();
    const costsCache = new Map<number, { sender_cost: number; sender_bonif: number; receiver_loyal: number; receiver_paid: number }>();

    // 4a. Read from ml_shipments DB cache (fast, no API calls)
    for (let i = 0; i < shipIds.length; i += 500) {
      const chunk = shipIds.slice(i, i + 500);
      const { data } = await sb.from("ml_shipments")
        .select("shipment_id, logistic_type, sender_cost, bonificacion, costs_cached_at")
        .in("shipment_id", chunk);
      if (data) {
        for (const r of data as { shipment_id: number; logistic_type: string; sender_cost: number | null; bonificacion: number | null; costs_cached_at: string | null }[]) {
          if (r.logistic_type) logisticMap.set(r.shipment_id, r.logistic_type);
        }
      }
    }
    // Also use logistic_type from order if available
    for (const o of orders) {
      if (o.shipping?.id && !logisticMap.has(o.shipping.id) && o.shipping.logistic_type) {
        logisticMap.set(o.shipping.id, o.shipping.logistic_type);
      }
    }

    // 4b. Fetch from ML API: logistic_type + costs in ONE step per shipment
    // Any shipment missing logistic_type OR costs needs API calls
    const needsFetch = shipIds.filter(id => !logisticMap.has(id) || !costsCache.has(id));
    console.log(`[Ventas Sync] ${shipIds.length} shipments: ${logisticMap.size} with logistic_type, ${needsFetch.length} need API fetch`);

    for (let i = 0; i < needsFetch.length; i += 10) {
      const batch = needsFetch.slice(i, i + 10);
      await Promise.all(batch.map(async (sid) => {
        // Fetch both /shipments/{id} and /shipments/{id}/costs in parallel
        const [shipDetail, shipCosts] = await Promise.all([
          !logisticMap.has(sid)
            ? mlGet<{ logistic_type?: string }>(`/shipments/${sid}`).catch(() => null)
            : Promise.resolve(null),
          !costsCache.has(sid)
            ? mlGet<{ senders: Array<{ cost: number; discounts: Array<{ type: string; promoted_amount: number }> }>; receiver?: { cost: number; discounts: Array<{ type: string; promoted_amount: number }> } }>(`/shipments/${sid}/costs`).catch(() => null)
            : Promise.resolve(null),
        ]);

        if (shipDetail?.logistic_type) {
          logisticMap.set(sid, shipDetail.logistic_type);
        }
        if (shipCosts) {
          const sender = shipCosts.senders?.[0];
          costsCache.set(sid, {
            sender_cost: Math.round(sender?.cost || 0),
            sender_bonif: Math.round(sender?.discounts?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0),
            receiver_loyal: Math.round(shipCosts.receiver?.discounts?.filter(d => d.type === "loyal")?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0),
            receiver_paid: Math.round(shipCosts.receiver?.cost || 0),
          });
        }
      }));
      if (i + 10 < needsFetch.length) await new Promise(r => setTimeout(r, 50));
    }
    console.log(`[Ventas Sync] After fetch: ${logisticMap.size} with logistic_type, ${costsCache.size} with costs`);

    // 6. Group orders by shipment for pack cost splitting
    const shipGroups = new Map<string, MLOrder[]>();
    for (const o of orders) {
      const key = o.shipping?.id ? String(o.shipping.id) : `solo_${o.id}`;
      const g = shipGroups.get(key) || [];
      g.push(o);
      shipGroups.set(key, g);
    }

    // 7. Map to cache rows
    const rows: Array<Record<string, unknown>> = [];

    for (const [, packOrders] of Array.from(shipGroups.entries())) {
      const packItemCount = packOrders.reduce((s, o) => s + (o.order_items?.length || 1), 0);
      const shipId = packOrders[0]?.shipping?.id;
      const lt = shipId ? logisticMap.get(shipId) || "" : "";
      const isFull = lt === "fulfillment" || lt === "xd_drop_off" || lt === "cross_docking" || lt === "drop_off";
      const isFlex = !isFull;
      const canal = isFull ? "Full" : "Flex";

      // Shipping costs — different rules per channel
      const costs = shipId ? costsCache.get(shipId) : undefined;
      let packCostoEnvio: number;
      let packBonificacion: number;
      if (isFull) {
        // Full: sender.cost ya es neto (post-descuento). No hay bonificación para el vendedor.
        packCostoEnvio = Math.round(costs?.sender_cost || 0);
        packBonificacion = 0;
      } else {
        // Flex: tarifa fija. Bonificación = sender.discounts + receiver.loyal + receiver.cost
        packCostoEnvio = tarifaFlex;
        packBonificacion = Math.round((costs?.sender_bonif || 0) + (costs?.receiver_loyal || 0) + (costs?.receiver_paid || 0));
      }

      for (const order of packOrders) {
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
            documento_tributario: "",
            estado_documento: "",
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    // 6. Deduplicate rows (same order_id + sku_venta can appear from overlapping chunks)
    const seen = new Set<string>();
    const uniqueRows = rows.filter(r => {
      const key = `${r.order_id}|${r.sku_venta}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 7. Delete existing rows in range, then insert fresh (upsert has issues with non-PK constraints)
    await sb.from("ventas_ml_cache").delete().gte("fecha_date", fromDate).lte("fecha_date", toDate);

    let upserted = 0;
    const upsertErrors: string[] = [];
    for (let i = 0; i < uniqueRows.length; i += 500) {
      const chunk = uniqueRows.slice(i, i + 500);
      const { error } = await sb.from("ventas_ml_cache").insert(chunk);
      if (error) upsertErrors.push(error.message);
      else upserted += chunk.length;
    }

    const flexCount = rows.filter(r => r.canal === "Flex").length;
    const fullCount = rows.filter(r => r.canal === "Full").length;
    const missingLt = shipIds.filter(id => !logisticMap.has(id)).length;
    console.log(`[Ventas Sync] Done: ${upserted} rows (flex:${flexCount} full:${fullCount} missing_lt:${missingLt})`);
    return NextResponse.json({
      status: "ok", synced: upserted, orders: orders.length, rows: rows.length,
      flex: flexCount, full: fullCount, missing_logistic: missingLt,
      claims: claimOrderIds.size, range: `${fromDate} → ${toDate}`,
      ...(upsertErrors.length > 0 ? { upsert_errors: upsertErrors } : {}),
    });
  } catch (err) {
    console.error("[Ventas Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

interface MLOrder {
  id: number;
  date_created: string;
  date_closed: string;
  status: string;
  order_items: Array<{ item: { id: string; title: string; seller_sku: string | null }; quantity: number; unit_price: number; sale_fee: number }>;
  shipping: { id: number; logistic_type?: string };
  pack_id: number | null;
  buyer: { id: number; nickname: string; first_name?: string; last_name?: string };
  total_amount: number;
  tags?: string[];
  mediations?: Array<{ id: number }>;
}

function toChileISO(dateStr: string): string {
  try { return new Date(dateStr).toLocaleString("sv-SE", { timeZone: "America/Santiago" }).replace(" ", "T"); }
  catch { return dateStr; }
}
