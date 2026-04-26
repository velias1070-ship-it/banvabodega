import { NextRequest, NextResponse } from "next/server";
import { syncRecentOrders, syncHistoricalOrders, diagnoseMlConnection } from "@/lib/ml";
import { dispararTriggerServer } from "@/lib/agents-triggers-server";
import { getServerSupabase } from "@/lib/supabase-server";

const SYNC_SECRET = process.env.ML_SYNC_SECRET || "";

/**
 * Polling sync endpoint — fetches recent Flex orders from ML.
 * Called by Vercel Cron every minute, or manually from admin.
 * Protected by a secret header or query param.
 */

/**
 * Telemetría a ml_sync_health.ml_sync. Llamar en TODOS los return paths del cron
 * (success o error), no solo el happy path. Lección aprendida en P1.1: sin esto
 * los periodos sin actividad no actualizan last_success_at → falso positivo a los 30min.
 */
async function reportHealth(ok: boolean, errMsg?: string): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { last_attempt_at: now };
  if (ok) {
    updates.last_success_at = now;
    updates.last_error = null;
    updates.consecutive_failures = 0;
  } else {
    updates.last_error = (errMsg ?? "unknown").slice(0, 500);
  }
  await sb.from("ml_sync_health").update(updates).eq("job_name", "ml_sync");
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = SYNC_SECRET && querySecret === SYNC_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";

  if (!isVercelCron && !isManual && !isLocalDev && SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    console.log("[ML Sync] Starting polling sync...");
    const result = await syncRecentOrders();
    console.log(`[ML Sync] Done: ${result.total} orders found, ${result.new_orders} new items`);

    if (result.new_orders > 0) {
      dispararTriggerServer("ordenes_importadas", { cantidad_nuevas: result.new_orders }).catch(() => {});
    }

    await reportHealth(true);
    return NextResponse.json({
      status: "ok",
      total_orders: result.total,
      new_items: result.new_orders,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ML Sync] Error:", err);
    await reportHealth(false, String(err));
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST for manual trigger from admin — supports action + days params
export async function POST(req: NextRequest) {
  let body: { action?: string; days?: number } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const action = body.action || "sync";

  // Diagnose connection — NO reporta a ml_sync_health (no es ejecución del cron, es check manual)
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

      if (result.new_orders > 0) {
        dispararTriggerServer("ordenes_importadas", { cantidad_nuevas: result.new_orders }).catch(() => {});
      }

      await reportHealth(true);
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
      await reportHealth(false, String(err));
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  // Default: recent sync
  try {
    console.log("[ML Sync] Starting recent sync...");
    const result = await syncRecentOrders();

    if (result.new_orders > 0) {
      dispararTriggerServer("ordenes_importadas", { cantidad_nuevas: result.new_orders }).catch(() => {});
    }

    await reportHealth(true);
    return NextResponse.json({
      status: "ok",
      total_orders: result.total,
      new_items: result.new_orders,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[ML Sync] Error:", err);
    await reportHealth(false, String(err));
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
