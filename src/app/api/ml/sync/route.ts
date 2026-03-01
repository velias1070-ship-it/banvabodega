import { NextRequest, NextResponse } from "next/server";
import { syncRecentOrders } from "@/lib/ml";

const SYNC_SECRET = process.env.ML_SYNC_SECRET || "";

/**
 * Polling sync endpoint — fetches recent Flex orders from ML.
 * Called by Vercel Cron every 10 min, or manually from admin.
 * Protected by a secret header or query param.
 */
export async function GET(req: NextRequest) {
  // Verify authorization: cron jobs from Vercel include Authorization header
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = SYNC_SECRET && querySecret === SYNC_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";

  // Allow if: Vercel cron, manual with secret, local dev, or no secret configured
  if (!isVercelCron && !isManual && !isLocalDev && SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    console.log("[ML Sync] Starting polling sync...");
    const result = await syncRecentOrders();
    console.log(`[ML Sync] Done: ${result.total} orders found, ${result.new_orders} new items`);

    return NextResponse.json({
      status: "ok",
      total_orders: result.total,
      new_items: result.new_orders,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ML Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// Also support POST for manual trigger from admin
export async function POST(req: NextRequest) {
  return GET(req);
}
