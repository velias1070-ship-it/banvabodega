import { NextRequest, NextResponse } from "next/server";
import { fetchAndProcessOrder, processShipment, mlGet, MLOrder, syncSingleFulfillmentStock } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

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

      // Invalidar cache de stock ML para los SKUs vendidos
      if (order?.order_items) {
        try {
          const sb = getServerSupabase();
          if (sb) {
            for (const item of order.order_items) {
              const itemId = item.item?.id;
              if (itemId) {
                // Decrementar stock_flex_cache por la cantidad vendida
                const { data: maps } = await sb.from("ml_items_map")
                  .select("id, stock_flex_cache")
                  .eq("item_id", itemId)
                  .eq("activo", true);
                for (const m of maps || []) {
                  const newCache = Math.max(0, (m.stock_flex_cache || 0) - (item.quantity || 1));
                  await sb.from("ml_items_map").update({
                    stock_flex_cache: newCache,
                    cache_updated_at: new Date().toISOString(),
                  }).eq("id", m.id);
                }
              }
            }
          }
        } catch (e) {
          console.warn("[ML Webhook] Error updating stock cache:", e);
        }
      }

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

    // Handle fulfillment stock changes
    if (topic === "marketplace_fbm_stock") {
      // resource puede ser /inventories/{INVENTORY_ID}/stock/fulfillment o similar
      const invMatch = resource?.match(/inventories\/([^/]+)/);
      const inventoryId = invMatch ? invMatch[1] : null;

      if (inventoryId) {
        console.log(`[ML Webhook] Fulfillment stock change for inventory ${inventoryId}`);
        const skuVenta = await syncSingleFulfillmentStock(inventoryId);

        // Disparar recálculo incremental si se actualizó un SKU
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
    // Return 200 anyway to prevent ML from retrying indefinitely
    return NextResponse.json({ status: "error", message: String(err) });
  }
}

// ML may send GET to verify the endpoint
export async function GET() {
  return NextResponse.json({ status: "ok", service: "banva-wms-ml-webhook" });
}
