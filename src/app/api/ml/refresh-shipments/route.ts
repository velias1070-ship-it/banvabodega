import { NextResponse } from "next/server";
import { refreshShipmentStatuses } from "@/lib/ml";

export async function POST() {
  try {
    const result = await refreshShipmentStatuses();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
