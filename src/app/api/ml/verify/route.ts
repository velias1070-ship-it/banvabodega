import { NextRequest, NextResponse } from "next/server";
import { getShipmentStatus } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Verify shipment status live from ML API before the operator starts picking.
 * Also updates the local DB if the status changed (e.g. cancelled).
 * POST body: { shipment_id: number }
 */
export async function POST(req: NextRequest) {
  try {
    const { shipment_id } = await req.json();
    if (!shipment_id) {
      return NextResponse.json({ error: "shipment_id required" }, { status: 400 });
    }

    const live = await getShipmentStatus(shipment_id);
    if (!live) {
      return NextResponse.json({ error: "Could not fetch shipment from ML" }, { status: 502 });
    }

    // Update local DB if status changed
    const sb = getServerSupabase();
    if (sb) {
      await sb.from("ml_shipments").update({
        status: live.status,
        substatus: live.substatus,
        updated_at: new Date().toISOString(),
      }).eq("shipment_id", shipment_id);
    }

    return NextResponse.json({
      shipment_id,
      status: live.status,
      substatus: live.substatus,
      ok_to_pick: live.ok_to_pick,
      cancelled: live.cancelled,
      ready_to_print: live.ready && live.substatus === "ready_to_print",
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
