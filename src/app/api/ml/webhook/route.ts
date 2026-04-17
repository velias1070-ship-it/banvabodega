import { NextRequest, NextResponse } from "next/server";
import { processShipment, mlGet, MLOrder, syncSingleFulfillmentStock } from "@/lib/ml";
import { upsertOrderToVentasCache, updateVentaEstado } from "@/lib/ventas-cache";
import { getBaseUrl } from "@/lib/base-url";
import { getServerSupabase } from "@/lib/supabase-server";

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

    // ─── Fulfillment Stock (Full) ───
    // Topics soportados: marketplace_fbm_stock (legacy) + stock-location (actual).
    // Ambos traen el inventory_id en el resource.
    if (topic === "marketplace_fbm_stock" || topic === "stock-location") {
      const invMatch = resource?.match(/inventories\/([^/]+)/) || resource?.match(/stock\/([^/]+)/);
      const inventoryId = invMatch ? invMatch[1] : null;

      if (inventoryId) {
        console.log(`[ML Webhook] Stock change (${topic}) for inventory ${inventoryId}`);
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

      await logWebhookFinish(logId, "ignored", startMs, { result: { reason: "no_inventory_id" } });
      return NextResponse.json({ status: "ignored", reason: "no_inventory_id" });
    }

    // ─── Items (cambio de publicación: precio, status, etc.) ───
    // Dispara re-sync del sku mapeado para mantener available_quantity fresco.
    if (topic === "items") {
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
            await logWebhookFinish(logId, "ok", startMs, { result: { item_id: itemId, sku, inventory_id: invId }, sku_afectado: sku, inventory_id: invId });
            return NextResponse.json({ status: "ok", item_id: itemId, sku });
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
  return NextResponse.json({ status: "ok", service: "banva-wms-ml-webhook", topics: ["orders_v2", "shipments", "claims", "marketplace_fbm_stock", "stock-location", "items"] });
}
