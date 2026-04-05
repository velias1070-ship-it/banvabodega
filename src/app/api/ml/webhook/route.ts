import { NextRequest, NextResponse } from "next/server";
import { processShipment, mlGet, MLOrder, syncSingleFulfillmentStock } from "@/lib/ml";
import { upsertOrderToVentasCache, updateVentaEstado } from "@/lib/ventas-cache";

/**
 * MercadoLibre webhook endpoint.
 * Handles: orders_v2, shipments, marketplace_fbm_stock, claims.
 * Must respond 200 quickly — ML retries on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { topic, resource } = body;

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
        return NextResponse.json({ status: "ok", shipment_id: shipmentId, items: result.items });
      }

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

      return NextResponse.json({ status: "ok", claim_id: claimId });
    }

    // ─── Fulfillment Stock ───
    if (topic === "marketplace_fbm_stock") {
      const invMatch = resource?.match(/inventories\/([^/]+)/);
      const inventoryId = invMatch ? invMatch[1] : null;

      if (inventoryId) {
        console.log(`[ML Webhook] Fulfillment stock change for inventory ${inventoryId}`);
        const skuVenta = await syncSingleFulfillmentStock(inventoryId);

        if (skuVenta) {
          try {
            const baseUrl = process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : "http://localhost:3000";
            fetch(`${baseUrl}/api/intelligence/recalcular`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ full: false, skus: [skuVenta] }),
            }).catch(() => {});
          } catch { /* fire and forget */ }
        }

        return NextResponse.json({ status: "ok", inventory_id: inventoryId, sku_venta: skuVenta });
      }

      return NextResponse.json({ status: "ignored", reason: "no_inventory_id" });
    }

    return NextResponse.json({ status: "ignored", topic });
  } catch (err) {
    console.error("[ML Webhook] Error:", err);
    return NextResponse.json({ status: "error", message: String(err) });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", service: "banva-wms-ml-webhook", topics: ["orders_v2", "shipments", "claims", "marketplace_fbm_stock"] });
}
