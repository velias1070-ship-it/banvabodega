import { NextRequest, NextResponse } from "next/server";
import { syncRecentOrders, syncHistoricalOrders, diagnoseMlConnection } from "@/lib/ml";

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

// POST for manual trigger from admin — supports action + days params
export async function POST(req: NextRequest) {
  let body: { action?: string; days?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const action = body.action || "sync";

  // Diagnose connection
  if (action === "diagnose") {
    try {
      console.log("[ML Sync] Running diagnostics...");
      const diag = await diagnoseMlConnection();
      return NextResponse.json({ status: "ok", action: "diagnose", ...diag });
    } catch (err) {
      console.error("[ML Sync] Diagnose error:", err);
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Historical sync (with days param)
  const days = body.days || 0;
  if (days > 0) {
    try {
      console.log(`[ML Sync] Starting historical sync (${days} days)...`);
      const result = await syncHistoricalOrders(days);
      console.log(`[ML Sync] Historical done: ${result.total} total, ${result.shipments_processed} shipments, ${result.new_orders} items`);

      return NextResponse.json({
        status: "ok",
        total_orders: result.total,
        new_items: result.new_orders,
        shipments_processed: result.shipments_processed,
        shipments_skipped: result.shipments_skipped,
        pages: result.pages,
        days,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[ML Sync] Historical sync error:", err);
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Default: recent sync (2 hours)
  try {
    console.log("[ML Sync] Starting recent sync...");
    const result = await syncRecentOrders();
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
