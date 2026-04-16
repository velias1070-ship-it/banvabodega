import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet, getMLConfig } from "@/lib/ml";
import { updateVentaEstado } from "@/lib/ventas-cache";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Reconciliation cron (8 AM Chile daily).
 * 1. Open claims → "En mediación"
 * 2. Closed claims → "Reembolsada" or restore to "Pagada"
 * 3. Cancelled orders (last 30 days) → "Cancelada"
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

  const config = await getMLConfig();
  if (!config?.seller_id) return NextResponse.json({ error: "ML no configurado" }, { status: 500 });

  const stats = { opened_claims: 0, closed_refunded: 0, closed_seller_won: 0, cancelled: 0, errors: 0 };

  try {
    // 1. Open claims → "En mediación"
    const openOrderIds = new Set<number>();
    try {
      const openClaims = await mlGet<{ data: Array<{ resource_id: number }> }>(
        "/post-purchase/v1/claims/search?status=opened&limit=200"
      );
      if (openClaims?.data) {
        for (const claim of openClaims.data) {
          if (claim.resource_id) {
            openOrderIds.add(claim.resource_id);
            const ok = await updateVentaEstado(claim.resource_id, "En mediación");
            if (ok) stats.opened_claims++;
          }
        }
      }
    } catch { stats.errors++; }

    // 2. Closed claims → "Reembolsada" or restore "Pagada"
    // Paginar porque si hay más de 200 claims cerrados acumulados, los de meses
    // anteriores quedaban fuera y las órdenes se quedaban trabadas en "En mediación".
    try {
      let offset = 0;
      const MAX_PAGES = 20; // hasta 4000 claims cerrados — cubre ~6 meses típicos
      for (let page = 0; page < MAX_PAGES; page++) {
        const closedClaims = await mlGet<{ data: Array<{ resource_id: number; resolution: { reason: string } | null }>; paging?: { total: number } }>(
          `/post-purchase/v1/claims/search?status=closed&limit=200&offset=${offset}`
        );
        const data = closedClaims?.data || [];
        if (data.length === 0) break;
        for (const claim of data) {
          if (!claim.resource_id || openOrderIds.has(claim.resource_id)) continue;
          if (claim.resolution?.reason === "refunded" || claim.resolution?.reason === "buyer_refunded") {
            const ok = await updateVentaEstado(claim.resource_id, "Reembolsada");
            if (ok) stats.closed_refunded++;
          } else {
            const ok = await updateVentaEstado(claim.resource_id, "Pagada");
            if (ok) stats.closed_seller_won++;
          }
        }
        offset += 200;
        if (closedClaims?.paging?.total && offset >= closedClaims.paging.total) break;
        await new Promise(r => setTimeout(r, 100));
      }
    } catch { stats.errors++; }

    // 3. Cancelled + partially_refunded orders — last 30 days
    let partiallyRefunded = 0;
    for (const mlStatus of ["cancelled", "partially_refunded"] as const) {
      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const fromISO = thirtyDaysAgo.toISOString();

        let offset = 0;
        for (let page = 0; page < 20; page++) {
          const url = `/orders/search?seller=${config.seller_id}&order.status=${mlStatus}&sort=date_desc&order.date_created.from=${encodeURIComponent(fromISO)}&limit=50&offset=${offset}`;
          const result = await mlGet<{ results: Array<{ id: number }>; paging: { total: number } }>(url);
          if (!result?.results?.length) break;

          for (const order of result.results) {
            const estado = mlStatus === "partially_refunded" ? "Parcialmente reembolsada" : "Cancelada";
            const ok = await updateVentaEstado(order.id, estado);
            if (ok) {
              if (mlStatus === "cancelled") stats.cancelled++;
              else partiallyRefunded++;
            }
          }

          offset += 50;
          if (offset >= result.paging.total) break;
          await new Promise(r => setTimeout(r, 100));
        }
      } catch { stats.errors++; }
    }

    console.log(`[Ventas Reconcile] claims:${stats.opened_claims} refunded:${stats.closed_refunded} seller_won:${stats.closed_seller_won} cancelled:${stats.cancelled} partially_refunded:${partiallyRefunded}`);
    return NextResponse.json({ status: "ok", ...stats, partially_refunded: partiallyRefunded });
  } catch (err) {
    return NextResponse.json({ error: String(err), stats }, { status: 500 });
  }
}
