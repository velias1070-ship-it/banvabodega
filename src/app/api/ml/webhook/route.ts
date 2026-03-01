import { NextRequest, NextResponse } from "next/server";
import { fetchAndProcessOrder, processShipment, mlGet, MLOrder } from "@/lib/ml";

/**
 * MercadoLibre webhook endpoint.
 * Handles both orders_v2 and shipments topic notifications.
 * Must respond 200 quickly — ML retries on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { topic, resource } = body;

    // Handle order notifications
    if (topic === "orders_v2" || topic === "orders") {
      const match = resource?.match(/\/orders\/(\d+)/);
      if (!match) {
        return NextResponse.json({ status: "ignored", reason: "no_order_id" });
      }

      const orderId = parseInt(match[1]);
      console.log(`[ML Webhook] Processing order ${orderId}`);

      // Fetch order to get shipment_id
      const order = await mlGet<MLOrder>(`/orders/${orderId}`);
      if (order?.shipping?.id) {
        // Process via shipment-centric path
        const orderIds = [orderId];
        // If pack, fetch pack to get all order IDs sharing this shipment
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

      // Also process via legacy path
      const count = await fetchAndProcessOrder(orderId);
      console.log(`[ML Webhook] Order ${orderId}: ${count} legacy items processed`);

      return NextResponse.json({ status: "ok", order_id: orderId });
    }

    // Handle shipment notifications
    if (topic === "shipments") {
      const match = resource?.match(/\/shipments\/(\d+)/);
      if (!match) {
        return NextResponse.json({ status: "ignored", reason: "no_shipment_id" });
      }

      const shipmentId = parseInt(match[1]);
      console.log(`[ML Webhook] Processing shipment ${shipmentId}`);

      // Fetch shipment items to get order IDs
      const shipItems = await mlGet<Array<{ order_id: number }>>(`/shipments/${shipmentId}/items`);
      const orderIds = shipItems ? Array.from(new Set(shipItems.map(i => i.order_id))) : [];

      if (orderIds.length > 0) {
        const result = await processShipment(shipmentId, orderIds);
        console.log(`[ML Webhook] Shipment ${shipmentId}: ${result.items} items processed`);
        return NextResponse.json({ status: "ok", shipment_id: shipmentId, items: result.items });
      }

      return NextResponse.json({ status: "ok", shipment_id: shipmentId, items: 0 });
    }

    return NextResponse.json({ status: "ignored", topic });
  } catch (err) {
    console.error("[ML Webhook] Error:", err);
    // Return 200 anyway to prevent ML from retrying indefinitely
    return NextResponse.json({ status: "error", message: String(err) });
  }
}

// ML may send GET to verify the endpoint
export async function GET() {
  return NextResponse.json({ status: "ok", service: "banva-wms-ml-webhook" });
}
