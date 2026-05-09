import { NextRequest, NextResponse } from "next/server";
import { processShipment, mlGet, MLOrder, syncSingleFulfillmentStock, syncStockByUserProductId } from "@/lib/ml";
import { upsertOrderToVentasCache, updateVentaEstado } from "@/lib/ventas-cache";
import { getBaseUrl } from "@/lib/base-url";
import { getServerSupabase } from "@/lib/supabase-server";

// Forzar ejecución dinámica — Next.js NO debe cachear lecturas de ml_config
// (token_expires_at se actualiza por refresh, una cache stale rompe el handler).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * MercadoLibre webhook endpoint.
 * Handles: orders_v2, shipments, marketplace_fbm_stock, claims, stock-location, items.
 * Must respond 200 quickly — ML retries on failure.
 *
 * Todo intento queda registrado en ml_webhook_log para auditoría + detección
 * de drift (si un topic deja de llegar, la tabla lo muestra).
 */
async function logWebhookStart(topic: string, resource: string | null): Promise<string | null> {
  try {
    const sb = getServerSupabase();
    if (!sb) return null;
    const { data } = await sb.from("ml_webhook_log")
      .insert({ topic, resource, status: "received" })
      .select("id").single();
    return data?.id || null;
  } catch { return null; }
}

async function logWebhookFinish(id: string | null, status: "ok"|"ignored"|"error", startMs: number, extras: { result?: unknown; error?: string; sku_afectado?: string | null; inventory_id?: string | null } = {}): Promise<void> {
  if (!id) return;
  try {
    const sb = getServerSupabase();
    if (!sb) return;
    await sb.from("ml_webhook_log").update({
      status,
      processed_at: new Date().toISOString(),
      latency_ms: Date.now() - startMs,
      result: extras.result ?? null,
      error: extras.error ?? null,
      sku_afectado: extras.sku_afectado ?? null,
      inventory_id: extras.inventory_id ?? null,
    }).eq("id", id);
  } catch { /* no bloquear respuesta al webhook */ }
}

export async function POST(req: NextRequest) {
  const startMs = Date.now();
  let logId: string | null = null;
  try {
    const body = await req.json();
    const { topic, resource } = body;
    logId = await logWebhookStart(topic, resource);

    // ─── Orders ───
    if (topic === "orders_v2" || topic === "orders") {
      const match = resource?.match(/\/orders\/(\d+)/);
      if (!match) return NextResponse.json({ status: "ignored", reason: "no_order_id" });

      const orderId = parseInt(match[1]);
      console.log(`[ML Webhook] Processing order ${orderId}`);

      const order = await mlGet<MLOrder>(`/orders/${orderId}`);
      if (!order) return NextResponse.json({ status: "ok", order_id: orderId, note: "order_fetch_failed" });

      // Process shipment (existing logic)
      if (order.shipping?.id) {
        const orderIds = [orderId];
        if (order.pack_id) {
          const pack = await mlGet<{ orders?: Array<{ id: number }> }>(`/packs/${order.pack_id}`);
          if (pack?.orders) {
            for (const po of pack.orders) {
              if (!orderIds.includes(po.id)) orderIds.push(po.id);
            }
          }
        }
        const result = await processShipment(order.shipping.id, orderIds);
        console.log(`[ML Webhook] Shipment ${order.shipping.id}: ${result.items} items processed`);
      }

      // Upsert to ventas_ml_cache (event-driven, real-time)
      if (order.status === "paid") {
        // Resolve logistic_type
        let logisticType: string = order.shipping?.logistic_type || "";
        if (!logisticType && order.shipping?.id) {
          const ship = await mlGet<{ logistic_type?: string; logistic?: { type?: string } }>(`/shipments/${order.shipping.id}`, { "x-format-new": "true" });
          logisticType = ship?.logistic?.type || ship?.logistic_type || "";
        }
        const hasMediation = order.mediations && order.mediations.length > 0;
        await upsertOrderToVentasCache(order as unknown as Parameters<typeof upsertOrderToVentasCache>[0], {
          logisticType,
          estado: hasMediation ? "En mediación" : "Pagada",
        });
        console.log(`[ML Webhook] Order ${orderId} upserted to ventas_ml_cache`);
      } else if (order.status === "cancelled") {
        await updateVentaEstado(orderId, "Cancelada");
        console.log(`[ML Webhook] Order ${orderId} marked as Cancelada`);
      }

      await logWebhookFinish(logId, "ok", startMs, { result: { order_id: orderId } });
      return NextResponse.json({ status: "ok", order_id: orderId });
    }

    // ─── Shipments ───
    if (topic === "shipments") {
      const match = resource?.match(/\/shipments\/(\d+)/);
      if (!match) return NextResponse.json({ status: "ignored", reason: "no_shipment_id" });

      const shipmentId = parseInt(match[1]);
      console.log(`[ML Webhook] Processing shipment ${shipmentId}`);

      const shipItems = await mlGet<Array<{ order_id: number }>>(`/shipments/${shipmentId}/items`);
      const orderIds = shipItems ? Array.from(new Set(shipItems.map(i => i.order_id))) : [];

      if (orderIds.length > 0) {
        const result = await processShipment(shipmentId, orderIds);
        console.log(`[ML Webhook] Shipment ${shipmentId}: ${result.items} items processed`);
        await logWebhookFinish(logId, "ok", startMs, { result: { shipment_id: shipmentId, items: result.items } });
        return NextResponse.json({ status: "ok", shipment_id: shipmentId, items: result.items });
      }

      await logWebhookFinish(logId, "ok", startMs, { result: { shipment_id: shipmentId, items: 0 } });
      return NextResponse.json({ status: "ok", shipment_id: shipmentId, items: 0 });
    }

    // ─── Claims / Mediations ───
    if (topic === "claims") {
      const match = resource?.match(/\/claims\/(\d+)/);
      if (!match) return NextResponse.json({ status: "ignored", reason: "no_claim_id" });

      const claimId = parseInt(match[1]);
      console.log(`[ML Webhook] Processing claim ${claimId}`);

      // Fetch claim detail to get order_id and status
      const claim = await mlGet<{
        id: number;
        resource_id: number;
        status: string;
        stage: string;
        resolution: { reason: string } | null;
      }>(`/post-purchase/v1/claims/${claimId}`);

      if (claim?.resource_id) {
        if (claim.status === "opened") {
          // Claim abierto → marcar como "En mediación"
          await updateVentaEstado(claim.resource_id, "En mediación");
          console.log(`[ML Webhook] Order ${claim.resource_id} → En mediación (claim ${claimId})`);
        } else if (claim.status === "closed") {
          if (claim.resolution?.reason === "refunded" || claim.resolution?.reason === "buyer_refunded") {
            // Resuelto con reembolso → marcar como "Reembolsada"
            await updateVentaEstado(claim.resource_id, "Reembolsada");
            console.log(`[ML Webhook] Order ${claim.resource_id} → Reembolsada (claim ${claimId})`);
          } else {
            // Resuelto a favor del vendedor → volver a "Pagada"
            await updateVentaEstado(claim.resource_id, "Pagada");
            console.log(`[ML Webhook] Order ${claim.resource_id} → Pagada (claim ${claimId} closed, seller won)`);
          }
        }
      }

      await logWebhookFinish(logId, "ok", startMs, { result: { claim_id: claimId } });
      return NextResponse.json({ status: "ok", claim_id: claimId });
    }

    // ─── Stock Full ───
    // Topics y formatos reales en ML (verificado contra /applications/:id +
    // docs oficiales de notificaciones):
    //   - stock-locations / stock-location
    //     resource: /user-products/{USER_PRODUCT_ID}/stock
    //     → syncStockByUserProductId
    //   - fbm_stock_operations
    //     resource: /stock/fulfillment/operations/{OP_ID}
    //     → el endpoint de la operación devuelve el inventory_id afectado.
    //     Por ahora logueamos; el cron cada 30min reconcilia estos casos.
    //   - marketplace_fbm_stock (legacy)
    //     resource: /inventories/{INV_ID}
    //     → syncSingleFulfillmentStock
    if (topic === "stock-locations" || topic === "stock-location") {
      const upMatch = resource?.match(/user-products\/([^/]+)\/stock/);
      const userProductId = upMatch ? upMatch[1] : null;
      if (userProductId) {
        console.log(`[ML Webhook] Stock change for user_product ${userProductId}`);
        const skuVenta = await syncStockByUserProductId(userProductId);
        if (skuVenta) {
          try {
            const baseUrl = getBaseUrl();
            fetch(`${baseUrl}/api/intelligence/recalcular`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ full: false, skus: [skuVenta] }),
            }).catch(() => {});
          } catch { /* fire and forget */ }
        }
        await logWebhookFinish(logId, "ok", startMs, { result: { user_product_id: userProductId, sku_venta: skuVenta }, sku_afectado: skuVenta });
        return NextResponse.json({ status: "ok", user_product_id: userProductId, sku_venta: skuVenta });
      }
      await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "no_user_product_id", resource } });
      return NextResponse.json({ status: "ignored", reason: "no_user_product_id" });
    }

    if (topic === "marketplace_fbm_stock") {
      const invMatch = resource?.match(/inventories\/([^/]+)/);
      const inventoryId = invMatch ? invMatch[1] : null;
      if (inventoryId) {
        console.log(`[ML Webhook] Stock change (legacy) for inventory ${inventoryId}`);
        const skuVenta = await syncSingleFulfillmentStock(inventoryId);
        if (skuVenta) {
          try {
            const baseUrl = getBaseUrl();
            fetch(`${baseUrl}/api/intelligence/recalcular`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ full: false, skus: [skuVenta] }),
            }).catch(() => {});
          } catch { /* fire and forget */ }
        }
        await logWebhookFinish(logId, "ok", startMs, { result: { inventory_id: inventoryId, sku_venta: skuVenta }, sku_afectado: skuVenta, inventory_id: inventoryId });
        return NextResponse.json({ status: "ok", inventory_id: inventoryId, sku_venta: skuVenta });
      }
      await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "no_inventory_id", resource } });
      return NextResponse.json({ status: "ignored", reason: "no_inventory_id" });
    }

    if (topic === "fbm_stock_operations") {
      // Real-time stock update. ML emite este webhook ~2-40s después de cada
      // operación de stock en Full (INBOUND_RECEPTION, SALE_CONFIRMATION,
      // ADJUSTMENT, QUARANTINE_*, LOST_REFUND, TRANSFER_*, WITHDRAWAL_*).
      // El cron syncStockFull cada 30min queda como safety net.
      const opMatch = resource?.match(/operations\/([^/]+)/);
      const operationId = opMatch ? opMatch[1] : null;
      if (!operationId) {
        await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "no_operation_id", resource } });
        return NextResponse.json({ status: "ignored", reason: "no_operation_id" });
      }

      // Bypass del cliente Supabase JS: Next.js cachea sus respuestas a pesar
      // del `cache: "no-store"` global, y el handler veía token_expires_at +
      // mapeos stale. Hacemos PostgREST directo con fetch + cache: "no-store".
      const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
      const sbKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
      const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` } as Record<string, string>;
      const sbFetch = (path: string, init: RequestInit = {}) =>
        fetch(`${sbUrl}/rest/v1${path}`, {
          ...init,
          headers: { ...sbHeaders, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
          cache: "no-store",
        });

      // Tomar seller_id + access_token desde ml_config (lectura fresca).
      const cfgResp = await sbFetch(`/ml_config?id=eq.main&select=seller_id,access_token,token_expires_at`);
      const cfgRows = (await cfgResp.json()) as Array<{ seller_id: string; access_token: string; token_expires_at: string }>;
      const cfg = cfgRows?.[0];
      const sellerId = cfg?.seller_id;
      const accessToken = cfg?.access_token;
      if (!sellerId || !accessToken) {
        await logWebhookFinish(logId, "error", startMs, { error: "no_credentials" });
        return NextResponse.json({ status: "error", message: "no_credentials" });
      }

      // 1) Detalle de la operación desde ML.
      type FbmOp = {
        id: string | number;
        type: string;
        date_created: string;
        inventory_id: string;
        detail: { available_quantity: number };
        result: { total: number; available_quantity?: number; not_available_quantity?: number };
        external_references?: Array<{ type: string; value: string }>;
      };
      const opUrl = `https://api.mercadolibre.com/stock/fulfillment/operations/${operationId}?seller_id=${sellerId}`;
      const opResp = await fetch(opUrl, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
      if (!opResp.ok) {
        const errBody = await opResp.text().then(t => t.slice(0, 200));
        await logWebhookFinish(logId, "error", startMs, { error: `ml_get_operation_failed status=${opResp.status}`, result: { operation_id: operationId, body: errBody } });
        return NextResponse.json({ status: "error", message: "ml_get_operation_failed", ml_status: opResp.status });
      }
      const op = await opResp.json() as FbmOp;

      // 2) Mapear inventory_id → sku_venta (lectura fresca via PostgREST).
      const mResp = await sbFetch(`/ml_items_map?inventory_id=eq.${encodeURIComponent(op.inventory_id)}&select=sku,sku_venta,sku_origen&limit=1`);
      const mRows = (await mResp.json()) as Array<{ sku?: string; sku_venta?: string; sku_origen?: string }>;
      const skuVenta = mRows?.[0]?.sku_venta;
      const skuOrigen = mRows?.[0]?.sku_origen || mRows?.[0]?.sku;
      if (!skuVenta) {
        await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "inventory_not_mapped", inventory_id: op.inventory_id, operation_id: operationId }, inventory_id: op.inventory_id });
        return NextResponse.json({ status: "ignored", reason: "inventory_not_mapped" });
      }

      // 3) Actualizar stock_full_cache (canónica) — UPSERT por sku_venta.
      const totalAfter = Number(op.result?.total ?? 0);
      const nowIso = new Date().toISOString();
      const sfcResp = await sbFetch(`/stock_full_cache?on_conflict=sku_venta`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ sku_venta: skuVenta, cantidad: totalAfter, updated_at: nowIso, fuente: "webhook_fbm_realtime" }),
      });
      const sfcOk = sfcResp.ok;

      // 4) Espejear en ml_items_map (legacy, deprecated v58 pero aún consumida).
      const mimResp = await sbFetch(`/ml_items_map?inventory_id=eq.${encodeURIComponent(op.inventory_id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ stock_full_cache: totalAfter, cache_updated_at: nowIso }),
      });
      const mimOk = mimResp.ok;

      if (!sfcOk || !mimOk) {
        const sfcErr = sfcOk ? "" : await sfcResp.text().then(t => t.slice(0, 150));
        const mimErr = mimOk ? "" : await mimResp.text().then(t => t.slice(0, 150));
        await logWebhookFinish(logId, "error", startMs, {
          error: `sfc=${sfcErr || "ok"} mim=${mimErr || "ok"}`,
          result: { operation_id: operationId, sku_venta: skuVenta, total_after: totalAfter },
          sku_afectado: skuVenta,
          inventory_id: op.inventory_id,
        });
        return NextResponse.json({ status: "error", message: "update_failed", sfc: sfcErr, mim: mimErr });
      }

      // 5) Recálculo del motor para ese SKU (fire-and-forget). El recálculo es
      // por SKU (no full) — barato. Si fallan no bloquear el webhook.
      try {
        const baseUrl = getBaseUrl();
        fetch(`${baseUrl}/api/intelligence/recalcular`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: false, skus: [skuOrigen || skuVenta] }),
        }).catch(() => {});
      } catch { /* fire-and-forget */ }

      await logWebhookFinish(logId, "ok", startMs, {
        result: {
          operation_id: operationId,
          op_type: op.type,
          inventory_id: op.inventory_id,
          delta: op.detail?.available_quantity,
          total_after: totalAfter,
          ext_ref: op.external_references?.[0],
        },
        sku_afectado: skuVenta,
        inventory_id: op.inventory_id,
      });
      return NextResponse.json({
        status: "ok",
        processed: true,
        operation_id: operationId,
        type: op.type,
        sku_venta: skuVenta,
        total_after: totalAfter,
      });
    }

    // ─── Items y cambios de precio ───
    // Topics: items, items_prices. Ambos apuntan a /items/MLC...
    // - items: re-sync stock fulfillment del SKU mapeado.
    // - items_prices: ADEMÁS dispara refresh focal de margin-cache para
    //   capturar el cambio de precio inmediato en ml_price_history (sin
    //   esperar al cron de cada 2 min). Latencia ML→history pasa de ~25 min
    //   a segundos.
    if (topic === "items" || topic === "items_prices") {
      const itemMatch = resource?.match(/items\/([A-Z0-9]+)/);
      const itemId = itemMatch ? itemMatch[1] : null;
      if (itemId) {
        try {
          const sb = getServerSupabase();
          if (sb) {
            const { data } = await sb.from("ml_items_map").select("sku, inventory_id").eq("item_id", itemId).limit(1);
            const invId = data?.[0]?.inventory_id;
            const sku = data?.[0]?.sku;
            if (invId) await syncSingleFulfillmentStock(invId);

            // Fire-and-forget refresh focal (solo en items_prices).
            // No await: el webhook debe responder a ML <5s. El refresh
            // ejecuta async y graba en ml_price_history si detecta cambio.
            let refreshTriggered = false;
            if (topic === "items_prices") {
              const refreshUrl = `${req.nextUrl.origin}/api/ml/margin-cache/refresh?item_ids=${encodeURIComponent(itemId)}`;
              fetch(refreshUrl, { method: "POST" }).catch(err => {
                console.error(`[ML Webhook] refresh focal failed for ${itemId}: ${String(err)}`);
              });
              refreshTriggered = true;
            }

            await logWebhookFinish(logId, "ok", startMs, { result: { item_id: itemId, sku, inventory_id: invId, refresh_triggered: refreshTriggered }, sku_afectado: sku, inventory_id: invId });
            return NextResponse.json({ status: "ok", item_id: itemId, sku, refresh_triggered: refreshTriggered });
          }
        } catch (err) {
          await logWebhookFinish(logId, "error", startMs, { error: String(err) });
          return NextResponse.json({ status: "error", item_id: itemId, message: String(err) });
        }
      }
      await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "no_item_id" } });
      return NextResponse.json({ status: "ignored", reason: "no_item_id" });
    }

    await logWebhookFinish(logId, "ignored", startMs, { result: { topic } });
    return NextResponse.json({ status: "ignored", topic });
  } catch (err) {
    console.error("[ML Webhook] Error:", err);
    await logWebhookFinish(logId, "error", startMs, { error: String(err) });
    return NextResponse.json({ status: "error", message: String(err) });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", service: "banva-wms-ml-webhook", topics: ["orders_v2", "shipments", "claims", "stock-locations", "fbm_stock_operations", "marketplace_fbm_stock", "items", "items_prices"] });
}
