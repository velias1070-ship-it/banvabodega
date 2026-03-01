import { NextRequest, NextResponse } from "next/server";
import { fetchAndProcessOrder } from "@/lib/ml";

/**
 * MercadoLibre webhook endpoint.
 * ML sends POST notifications when orders are created/updated.
 * Must respond 200 quickly — ML retries on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // ML sends notifications with topic and resource
    const { topic, resource } = body;

    // Only process order notifications
    if (topic !== "orders_v2" && topic !== "orders") {
      return NextResponse.json({ status: "ignored", topic });
    }

    // Extract order ID from resource path: /orders/123456789
    const match = resource?.match(/\/orders\/(\d+)/);
    if (!match) {
      return NextResponse.json({ status: "ignored", reason: "no_order_id" });
    }

    const orderId = parseInt(match[1]);
    console.log(`[ML Webhook] Processing order ${orderId}`);

    const count = await fetchAndProcessOrder(orderId);
    console.log(`[ML Webhook] Order ${orderId}: ${count} items processed`);

    return NextResponse.json({ status: "ok", order_id: orderId, items: count });
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
