import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { syncStockToML } from "@/lib/ml";

/**
 * Stock sync endpoint — pushes WMS stock to MercadoLibre using distributed stock API.
 * Uses PUT /user-products/$UP_ID/stock/type/selling_address with x-version header.
 * Processes the stock_sync_queue: for each pending SKU, reads
 * WMS stock and sends directly to ML.
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // Verificar autorización: cron de Vercel, dev local, o llamada interna desde admin
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const referer = req.headers.get("referer") || "";
  const isAdminCall = referer.includes("/admin");

  if (!isVercelCron && !isLocalDev && !isAdminCall) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // 1. Read the sync queue
    const { data: queue } = await sb.from("stock_sync_queue").select("sku").order("created_at");
    const skus = (queue || []).map((d: { sku: string }) => d.sku);

    if (skus.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, message: "queue empty" });
    }

    console.log(`[ML Stock Sync] Processing ${skus.length} SKUs`);
    const uniqueSkus = Array.from(new Set(skus));
    let synced = 0;
    const errors: string[] = [];

    for (let idx = 0; idx < uniqueSkus.length; idx++) {
      const sku = uniqueSkus[idx];
      // Throttle: wait 1s between SKUs to avoid ML rate limits
      if (idx > 0) await new Promise(r => setTimeout(r, 1000));
      try {
        // 2. Calculate total stock in WMS (= lo que se publica en ML)
        const { data: stockRows } = await sb.from("stock").select("cantidad").eq("sku", sku);
        const available = Math.max(0, (stockRows || []).reduce((s: number, r: { cantidad: number }) => s + r.cantidad, 0));

        // 5. Send to ML via distributed stock API
        const count = await syncStockToML(sku, available);
        if (count > 0) synced++;
      } catch (err) {
        errors.push(`${sku}: ${String(err)}`);
      }
    }

    // 6. Clear processed items from queue
    await sb.from("stock_sync_queue").delete().in("sku", uniqueSkus);

    console.log(`[ML Stock Sync] Done: ${synced}/${uniqueSkus.length} synced`);
    return NextResponse.json({
      status: "ok",
      synced,
      total: uniqueSkus.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[ML Stock Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
