import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet } from "@/lib/ml";
import { updateVentaEstado } from "@/lib/ventas-cache";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Nightly reconciliation cron (4 AM Chile).
 * 1. Syncs all open claims → marks orders as "En mediación"
 * 2. Checks recently closed claims → marks as "Reembolsada" or restores to "Pagada"
 * 3. Checks cancelled orders in cache → updates status
 *
 * Fast: only 2-3 ML API calls (claims search), rest is DB updates.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const hasParams = req.nextUrl.searchParams.has("run");

  if (!isVercelCron && !isLocalDev && !hasParams) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const stats = { opened_claims: 0, closed_refunded: 0, closed_seller_won: 0, cancelled: 0, errors: 0 };

  try {
    // 1. Fetch all open claims
    console.log("[Ventas Reconcile] Fetching open claims");
    const openClaims = await mlGet<{ data: Array<{ resource_id: number; status: string }> }>(
      "/post-purchase/v1/claims/search?status=opened&limit=200"
    );
    const openOrderIds = new Set<number>();
    if (openClaims?.data) {
      for (const claim of openClaims.data) {
        if (claim.resource_id) {
          openOrderIds.add(claim.resource_id);
          const ok = await updateVentaEstado(claim.resource_id, "En mediación");
          if (ok) stats.opened_claims++;
        }
      }
    }
    console.log(`[Ventas Reconcile] ${stats.opened_claims} orders marked as En mediación`);

    // 2. Fetch recently closed claims (last 30 days)
    console.log("[Ventas Reconcile] Fetching closed claims");
    const closedClaims = await mlGet<{ data: Array<{ resource_id: number; status: string; resolution: { reason: string } | null }> }>(
      "/post-purchase/v1/claims/search?status=closed&limit=200"
    );
    if (closedClaims?.data) {
      for (const claim of closedClaims.data) {
        if (!claim.resource_id) continue;
        // Skip if this order also has an open claim (another item might still be in dispute)
        if (openOrderIds.has(claim.resource_id)) continue;

        if (claim.resolution?.reason === "refunded" || claim.resolution?.reason === "buyer_refunded") {
          const ok = await updateVentaEstado(claim.resource_id, "Reembolsada");
          if (ok) stats.closed_refunded++;
        } else {
          // Seller won — restore to Pagada
          const ok = await updateVentaEstado(claim.resource_id, "Pagada");
          if (ok) stats.closed_seller_won++;
        }
      }
    }
    console.log(`[Ventas Reconcile] ${stats.closed_refunded} refunded, ${stats.closed_seller_won} restored to Pagada`);

    // 3. Check for cancelled orders in cache that might still show as "Pagada"
    // (Orders can be cancelled without a claim — e.g., payment reversal)
    const { data: cachedPaid } = await sb.from("ventas_ml_cache")
      .select("order_id")
      .eq("estado", "Pagada")
      .order("fecha_date", { ascending: false })
      .limit(500);

    if (cachedPaid && cachedPaid.length > 0) {
      // Check a sample of recent orders for cancellation (max 50 to stay fast)
      const recentIds = Array.from(new Set((cachedPaid as { order_id: string }[]).map(r => r.order_id))).slice(0, 50);
      for (const oid of recentIds) {
        try {
          const order = await mlGet<{ id: number; status: string }>(`/orders/${oid}`);
          if (order && order.status === "cancelled") {
            await updateVentaEstado(order.id, "Cancelada");
            stats.cancelled++;
          }
        } catch { stats.errors++; }
      }
    }
    console.log(`[Ventas Reconcile] ${stats.cancelled} cancelled orders detected`);

    return NextResponse.json({ status: "ok", ...stats });
  } catch (err) {
    console.error("[Ventas Reconcile] Error:", err);
    return NextResponse.json({ error: String(err), stats }, { status: 500 });
  }
}
