import { NextRequest, NextResponse } from "next/server";
import {
  getFlexSubscription,
  getFlexConfig,
  updateFlexConfig,
  getFlexHolidays,
  updateFlexHolidays,
  activateFlexItem,
  deactivateFlexItem,
  getShipmentStatus,
} from "@/lib/ml";

/**
 * Flex management endpoint.
 * Handles subscription info, holidays, item activation, shipment status.
 *
 * POST body: { action, ...params }
 *   - action: "subscription" → get Flex subscription info
 *   - action: "config" → get delivery config (requires service_id)
 *   - action: "update_config" → update delivery config (requires service_id, config)
 *   - action: "holidays" → get holidays (requires service_id)
 *   - action: "update_holidays" → update holidays (requires service_id, holidays)
 *   - action: "activate_item" → activate item for Flex (requires item_id)
 *   - action: "deactivate_item" → deactivate item from Flex (requires item_id)
 *   - action: "shipment_status" → check shipment status (requires shipping_id)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "subscription": {
        const data = await getFlexSubscription();
        return NextResponse.json({ status: "ok", data });
      }

      case "config": {
        const { service_id } = body;
        if (!service_id) return NextResponse.json({ error: "service_id required" }, { status: 400 });
        const data = await getFlexConfig(service_id);
        return NextResponse.json({ status: "ok", data });
      }

      case "update_config": {
        const { service_id, config } = body;
        if (!service_id || !config) return NextResponse.json({ error: "service_id and config required" }, { status: 400 });
        const data = await updateFlexConfig(service_id, config);
        return NextResponse.json({ status: "ok", data });
      }

      case "holidays": {
        const { service_id } = body;
        if (!service_id) return NextResponse.json({ error: "service_id required" }, { status: 400 });
        const data = await getFlexHolidays(service_id);
        return NextResponse.json({ status: "ok", data });
      }

      case "update_holidays": {
        const { service_id, holidays } = body;
        if (!service_id || !holidays) return NextResponse.json({ error: "service_id and holidays required" }, { status: 400 });
        const data = await updateFlexHolidays(service_id, holidays);
        return NextResponse.json({ status: "ok", data });
      }

      case "activate_item": {
        const { item_id } = body;
        if (!item_id) return NextResponse.json({ error: "item_id required" }, { status: 400 });
        const success = await activateFlexItem(item_id);
        return NextResponse.json({ status: success ? "ok" : "error", item_id });
      }

      case "deactivate_item": {
        const { item_id } = body;
        if (!item_id) return NextResponse.json({ error: "item_id required" }, { status: 400 });
        const success = await deactivateFlexItem(item_id);
        return NextResponse.json({ status: success ? "ok" : "error", item_id });
      }

      case "shipment_status": {
        const { shipping_id } = body;
        if (!shipping_id) return NextResponse.json({ error: "shipping_id required" }, { status: 400 });
        const data = await getShipmentStatus(shipping_id);
        return NextResponse.json({ status: "ok", data });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error("[ML Flex] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
