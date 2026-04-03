import { NextRequest, NextResponse } from "next/server";
import { syncStockToML, mlPut } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Sync stock to ML then activate an item — all server-side in sequence.
 * POST body: { item_id: string, sku: string, quantity: number }
 */
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { item_id, sku, quantity } = await req.json();
    if (!item_id || !sku) {
      return NextResponse.json({ error: "item_id and sku required" }, { status: 400 });
    }

    const qty = quantity || 1;

    // Step 1: Sync stock directly to ML
    console.log(`[Activate] Syncing stock for ${sku}: ${qty} units`);
    const synced = await syncStockToML(sku, qty);
    if (synced === 0) {
      return NextResponse.json({
        error: `Stock sync falló para ${sku}. Puede que no tenga user_product_id o el mapping no exista en ml_items_map.`,
        step: "stock_sync",
      }, { status: 502 });
    }
    console.log(`[Activate] Stock synced: ${synced} items updated`);

    // Step 2: Activate item
    console.log(`[Activate] Activating ${item_id}`);
    const result = await mlPut<{ id: string; status: string }>(`/items/${item_id}`, { status: "active" });
    if (!result) {
      return NextResponse.json({
        error: `Stock enviado (${qty} uds) pero la activación falló. ML puede necesitar unos segundos para procesar el stock. Intenta activar manualmente en unos segundos.`,
        step: "activate",
        stock_synced: true,
      }, { status: 502 });
    }

    // Step 3: Update local cache
    const sb = getServerSupabase();
    if (sb) {
      await sb.from("ml_items_map").update({
        status_ml: "active",
        updated_at: new Date().toISOString(),
      }).eq("item_id", item_id);
    }

    return NextResponse.json({
      ok: true,
      item_id,
      sku,
      stock_synced: qty,
      status: "active",
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
