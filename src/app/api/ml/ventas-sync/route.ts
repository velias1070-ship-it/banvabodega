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

    // 4. Resolve logistic types from DB cache (fast, no ML API calls)
    const shipIds = Array.from(new Set(orders.map(o => o.shipping?.id).filter(Boolean))) as number[];
    const logisticMap = new Map<number, string>();
    for (let i = 0; i < shipIds.length; i += 500) {
      const chunk = shipIds.slice(i, i + 500);
      const { data } = await sb.from("ml_shipments").select("shipment_id, logistic_type").in("shipment_id", chunk);
      if (data) for (const r of data as { shipment_id: number; logistic_type: string }[]) logisticMap.set(r.shipment_id, r.logistic_type);
    }
    // For orders without cached logistic_type, use the one from the order itself
    for (const o of orders) {
      if (o.shipping?.id && !logisticMap.has(o.shipping.id) && o.shipping.logistic_type) {
        logisticMap.set(o.shipping.id, o.shipping.logistic_type);
      }
    }

    // 5. Map to cache rows (fast — use sale_fee from order, tarifa fija for shipping)
    const rows: Array<Record<string, unknown>> = [];

    for (const order of orders) {
      const shipId = order.shipping?.id;
      const lt = shipId ? logisticMap.get(shipId) || "" : "";
      const isFlex = lt === "self_service" || lt === "";
      const canal = isFlex ? "Flex" : "Full";
      const itemCount = order.order_items?.length || 1;
      const costoEnvioPorItem = Math.round(tarifaFlex / itemCount);

      for (const item of (order.order_items || [])) {
        const sku = (item.item?.seller_sku || `ML-${item.item?.id}`).toUpperCase();
        const subtotal = Math.round(item.unit_price * item.quantity);
        const comisionUnit = Math.round(item.sale_fee || 0);
        const comisionTotal = comisionUnit * item.quantity;
        const totalNeto = subtotal - comisionTotal - costoEnvioPorItem;

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
          costo_envio: costoEnvioPorItem,
          ingreso_envio: 0,
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

    // 6. Upsert to DB
    let upserted = 0;
    const upsertErrors: string[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from("ventas_ml_cache").upsert(chunk, { onConflict: "order_id,sku_venta" });
      if (error) upsertErrors.push(error.message);
      else upserted += chunk.length;
    }

    console.log(`[Ventas Sync] Done: ${upserted} rows`);
    return NextResponse.json({
      status: "ok", synced: upserted, orders: orders.length, rows: rows.length,
      claims: claimOrderIds.size, range: `${fromDate} → ${toDate}`,
      ...(upsertErrors.length > 0 ? { upsert_errors: upsertErrors } : {}),
      ...(rows.length > 0 && upserted === 0 ? { sample_row: rows[0] } : {}),
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
