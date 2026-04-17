import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet, getMLConfig } from "@/lib/ml";
import { preloadCostos, resolverCostoVenta, calcularMargenVenta } from "@/lib/costos";
import { decidirSnapshotCosto } from "@/lib/snapshot-costo";
import { preloadAdsForSales, resolverAdsVenta, calcularMargenNeto } from "@/lib/ads";

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
    // 1. Fetch orders from ML for ALL relevant statuses.
    // Bug fix: previously only fetched status=paid, losing cancelled/refunded
    // orders on re-sync (delete-then-insert wiped them permanently).
    // Also expand date_created range by -30 days to catch orders created in
    // a prior month but closed in the target month (cross-month gap).
    const STATUSES_TO_FETCH = ["paid", "cancelled", "partially_refunded"];
    const allOrders: MLOrder[] = [];
    const seenIds = new Set<number>();

    for (const mlStatus of STATUSES_TO_FETCH) {
      const cursor = new Date(fromDate + "T00:00:00");
      const end = new Date(toDate + "T00:00:00");

      while (cursor <= end) {
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + 14);
        const actualEnd = chunkEnd > end ? end : chunkEnd;

        // Expand date_created range: -30 days for paid (catches cross-month),
        // -1 day for cancelled/refunded (they close same day typically).
        const expandedFrom = new Date(cursor);
        expandedFrom.setDate(expandedFrom.getDate() - (mlStatus === "paid" ? 30 : 1));
        const fromISO = new Date(expandedFrom.toISOString().slice(0, 10) + "T00:00:00-04:00").toISOString();
        const toISO = new Date(actualEnd.toISOString().slice(0, 10) + "T23:59:59-03:00").toISOString();

        let offset = 0;
        let emptyRetries = 0;
        for (let page = 0; page < 40; page++) {
          const url = `/orders/search?seller=${config.seller_id}&order.status=${mlStatus}&sort=date_desc&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}`;
          const result = await mlGet<{ results: MLOrder[]; paging: { total: number } }>(url);
          if (!result?.results?.length) {
            emptyRetries++;
            if (emptyRetries >= 2) break;
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          emptyRetries = 0;
          for (const o of result.results) {
            if (!seenIds.has(o.id)) { seenIds.add(o.id); allOrders.push(o); }
          }
          offset += 50;
          if (offset >= result.paging.total) break;
          await new Promise(r => setTimeout(r, 150));
        }
        cursor.setDate(actualEnd.getDate() + 1);
      }
    }

    // 2. Filter by Chile date_closed (the actual report date)
    const orders = allOrders.filter(o => {
      const chileDate = toChileISO(o.date_closed || o.date_created).slice(0, 10);
      return chileDate >= fromDate && chileDate <= toDate;
    });
    const paidCount = orders.filter(o => o.status === "paid").length;
    const cancelledCount = orders.filter(o => o.status === "cancelled").length;
    const refundedCount = orders.filter(o => o.status === "partially_refunded").length;
    console.log(`[Ventas Sync] ${orders.length} orders (${allOrders.length} raw) — paid:${paidCount} cancelled:${cancelledCount} refunded:${refundedCount}`);

    if (orders.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, range: `${fromDate} → ${toDate}` });
    }

    // 3. Check OPEN claims — only orders with an open claim right now should
    // be "En mediación". Orders with order.mediations[] may have a historical
    // claim that already closed; those are NOT in mediation anymore.
    const claimOrderIds = new Set<number>();
    try {
      const claims = await mlGet<{ data: Array<{ resource_id: number }> }>("/post-purchase/v1/claims/search?status=opened&limit=200");
      if (claims?.data) for (const c of claims.data) claimOrderIds.add(c.resource_id);
    } catch { /* ignore */ }

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

    // 6b. Inmutabilidad contable: leer snapshots existentes en el rango ANTES de borrar.
    // Si una venta ya tenía costo_producto o ads_cost_asignado capturados, los preservamos.
    const { data: existingSnapshots } = await sb.from("ventas_ml_cache")
      .select("order_id, sku_venta, costo_producto, costo_fuente, margen, margen_pct, costo_snapshot_at, anulada, anulada_at, ads_cost_asignado, ads_atribucion, margen_neto, margen_neto_pct, costo_detalle")
      .gte("fecha_date", fromDate).lte("fecha_date", toDate);
    const snapshotByKey = new Map<string, {
      costo_producto: number | null;
      costo_fuente: string | null;
      margen: number | null;
      margen_pct: number | null;
      costo_snapshot_at: string | null;
      anulada: boolean;
      anulada_at: string | null;
      ads_cost_asignado: number | null;
      ads_atribucion: string | null;
      margen_neto: number | null;
      margen_neto_pct: number | null;
      costo_detalle: unknown | null;
    }>();
    for (const r of (existingSnapshots || [])) {
      snapshotByKey.set(`${r.order_id}|${(r.sku_venta || "").toUpperCase()}`, r);
    }
    const preload = await preloadCostos(sb);
    const snapshotAt = new Date().toISOString();

    // 6c. Preload de ads cache para todas las (sku, fecha) del rango
    const skuSet = new Set<string>();
    for (const o of orders) for (const it of (o.order_items || [])) {
      const sku = (it.item?.seller_sku || "").toUpperCase();
      if (sku) skuSet.add(sku);
    }
    const skuToItemId = new Map<string, string>();
    if (skuSet.size > 0) {
      const { data: imap } = await sb.from("ml_items_map").select("sku, item_id").in("sku", Array.from(skuSet));
      for (const m of (imap || []) as { sku: string; item_id: string }[]) skuToItemId.set(m.sku, m.item_id);
    }
    const adsPairs: Array<{ item_id: string; fecha_date: string }> = [];
    for (const o of orders) {
      const fd = toChileISO(o.date_closed || o.date_created).slice(0, 10);
      for (const it of (o.order_items || [])) {
        const sku = (it.item?.seller_sku || "").toUpperCase();
        const iid = skuToItemId.get(sku);
        if (iid) adsPairs.push({ item_id: iid, fecha_date: fd });
      }
    }
    const adsPreload = await preloadAdsForSales(sb, adsPairs);

    // 6d. Resolver tamaño real de cada pack vía /packs/{pack_id}.
    // Crítico: si una orden es parte de un pack con 2+ órdenes pero
    // solo una llegó en este batch de sync, sin este lookup el costo
    // de envío se asignaría completo a esa única orden → sobreestimación
    // sistemática. ML expone la lista canónica de órdenes del pack.
    const packSizeMap = new Map<string, number>();
    const packIds = new Set<number>();
    for (const o of orders) {
      if (o.pack_id && o.pack_id !== o.id) packIds.add(o.pack_id);
    }
    for (const pid of Array.from(packIds)) {
      try {
        const packInfo = await mlGet<{ orders?: Array<{ id: number }> }>(`/packs/${pid}`);
        const size = Array.isArray(packInfo?.orders) ? packInfo.orders.length : 0;
        if (size > 0) packSizeMap.set(String(pid), size);
      } catch { /* ignore, cae al fallback de este batch */ }
    }
    console.log(`[Ventas Sync] ${packIds.size} packs consultados, ${packSizeMap.size} resueltos`);

    // 7. Map to cache rows
    const rows: Array<Record<string, unknown>> = [];

    for (const [, packOrders] of Array.from(shipGroups.entries())) {
      const batchItemCount = packOrders.reduce((s, o) => s + (o.order_items?.length || 1), 0);
      // Si alguna orden del grupo tiene pack_id canónico y lo resolvimos,
      // usamos ese total. Sino fallback al count local del batch.
      const canonicalPackId = packOrders.find(o => o.pack_id && o.pack_id !== o.id)?.pack_id;
      const canonicalPackSize = canonicalPackId ? packSizeMap.get(String(canonicalPackId)) : undefined;
      const packItemCount = canonicalPackSize || batchItemCount;
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

          // Inmutabilidad: preservar snapshot si ya existía, sino resolver ahora.
          // Inmutabilidad: solo preservamos lo que viene de fuentes externas
          // (costo_producto, ads_cost_asignado). margen y margen_neto se
          // recalculan siempre porque dependen de total_neto (que puede
          // cambiar por re-balance de envío en packs compartidos).
          const snapshotKey = `${order.id}|${sku}`;
          const prev = snapshotByKey.get(snapshotKey);
          const resolved = resolverCostoVenta(sku, item.quantity, preload);
          const snapshot = decidirSnapshotCosto(
            prev,
            () => resolved,
            snapshotAt,
            { order_id: order.id, sku_venta: sku },
          );
          const costoProducto = snapshot.costo_producto;
          const costoFuente = snapshot.costo_fuente;
          const costoSnapshotAt = snapshot.costo_snapshot_at;
          const costoDetalle = snapshot.fromSnapshot ? (prev?.costo_detalle || null) : resolved.detalle;
          const mBruto = calcularMargenVenta(totalNeto, costoProducto, subtotal);
          const margenFinal = mBruto.margen;
          const margenPct = mBruto.margen_pct;

          let adsCostAsignado: number;
          let adsAtribucion: string;
          if (prev && prev.ads_cost_asignado != null) {
            adsCostAsignado = prev.ads_cost_asignado;
            adsAtribucion = prev.ads_atribucion || "sin_datos";
          } else {
            const fdate = toChileISO(order.date_closed || order.date_created).slice(0, 10);
            const itemId = skuToItemId.get(sku) || null;
            const ads = resolverAdsVenta(itemId, fdate, subtotal, adsPreload);
            adsCostAsignado = ads.ads_cost_asignado;
            adsAtribucion = ads.ads_atribucion;
          }
          const mnFinal = calcularMargenNeto(margenFinal, adsCostAsignado, subtotal);
          const margenNeto = mnFinal.margen_neto;
          const margenNetoPct = mnFinal.margen_neto_pct;

          // Estado: mapear desde ML status real + claims
          let estado: string;
          if (order.status === "cancelled") estado = "Cancelada";
          else if (order.status === "partially_refunded") estado = "Parcialmente reembolsada";
          else if (claimOrderIds.has(order.id)) estado = "En mediación";
          else estado = "Pagada";

          const esCancelOrRefund = order.status === "cancelled" || order.status === "partially_refunded";
          const anuladaVenta = esCancelOrRefund || (prev?.anulada === true);
          const anuladaAt = prev?.anulada_at || (esCancelOrRefund ? snapshotAt : null);

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
            costo_producto: costoProducto,
            costo_fuente: costoFuente,
            costo_snapshot_at: costoSnapshotAt,
            costo_detalle: costoDetalle,
            margen: margenFinal,
            margen_pct: margenPct,
            ads_cost_asignado: adsCostAsignado,
            ads_atribucion: adsAtribucion,
            margen_neto: margenNeto,
            margen_neto_pct: margenNetoPct,
            anulada: anuladaVenta,
            anulada_at: anuladaAt,
            logistic_type: lt,
            estado,
            documento_tributario: "",
            estado_documento: "",
            updated_at: snapshotAt,
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

    // 7. Delete ONLY rows for orders we're about to re-insert — NOT the entire range.
    // Bug fix: deleting the entire range wiped orders that ML didn't return
    // (status changed, API pagination gaps, transient failures), losing them permanently.
    const fetchedOrderIds = Array.from(new Set(uniqueRows.map(r => String(r.order_id))));
    for (let i = 0; i < fetchedOrderIds.length; i += 500) {
      const chunk = fetchedOrderIds.slice(i, i + 500);
      await sb.from("ventas_ml_cache").delete().in("order_id", chunk);
    }

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

    const cancelledCount2 = uniqueRows.filter(r => r.estado === "Cancelada").length;
    const refundedCount2 = uniqueRows.filter(r => r.estado === "Parcialmente reembolsada").length;
    const mediacionCount = uniqueRows.filter(r => r.estado === "En mediación").length;
    console.log(`[Ventas Sync] Done: ${upserted} rows (flex:${flexCount} full:${fullCount} cancelled:${cancelledCount2} refunded:${refundedCount2} mediacion:${mediacionCount} missing_lt:${missingLt})`);
    return NextResponse.json({
      status: "ok", synced: upserted, orders_filtered: orders.length, orders_raw: allOrders.length, rows: rows.length,
      flex: flexCount, full: fullCount, cancelled: cancelledCount2, partially_refunded: refundedCount2, en_mediacion: mediacionCount,
      missing_logistic: missingLt,
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
