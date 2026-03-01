import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { syncStockToML } from "@/lib/ml";

/**
 * Stock sync endpoint — pushes WMS stock to MercadoLibre.
 * Processes the stock_sync_queue: for each pending SKU, calculates
 * available stock (total - committed) and sends to ML.
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

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

    for (const sku of uniqueSkus) {
      try {
        // 2. Calculate total stock in WMS
        const { data: stockRows } = await sb.from("stock").select("cantidad").eq("sku", sku);
        const totalStock = (stockRows || []).reduce((s: number, r: { cantidad: number }) => s + r.cantidad, 0);

        // 3. Calculate committed stock (PENDIENTE + EN_PICKING pedidos)
        const { data: pedidos } = await sb.from("pedidos_flex")
          .select("cantidad")
          .eq("sku_venta", sku)
          .in("estado", ["PENDIENTE", "EN_PICKING"]);
        const committed = (pedidos || []).reduce((s: number, p: { cantidad: number }) => s + p.cantidad, 0);

        // 4. Available = total - committed
        const available = Math.max(0, totalStock - committed);

        // 5. Send to ML
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
