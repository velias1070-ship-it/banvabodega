import { NextResponse } from "next/server";
import { getFullStockForAllSkus } from "@/lib/ml";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/stock-full
 * Returns fulfillment (meli_facility) stock for all active SKUs in ml_items_map.
 * Response: { stock: Record<string, number> }
 */
export async function GET() {
  try {
    const stock = await getFullStockForAllSkus();
    return NextResponse.json({ stock });
  } catch (err) {
    console.error("[API stock-full] Error:", err);
    return NextResponse.json({ error: "fetch_failed" }, { status: 500 });
  }
}
