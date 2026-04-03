import { NextRequest, NextResponse } from "next/server";
import { mlGet, mlPut, getDistributedStock, updateFlexStock, getItemUserProductId } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Sync stock to ML then activate an item — all server-side with detailed logging.
 * POST body: { item_id: string, sku: string, quantity: number }
 */
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const steps: string[] = [];
  try {
    const { item_id, sku, quantity } = await req.json();
    if (!item_id || !sku) {
      return NextResponse.json({ error: "item_id and sku required" }, { status: 400 });
    }

    const qty = Math.max(quantity || 1, 1);
    const sb = getServerSupabase();

    // Step 1: Get mapping from ml_items_map
    steps.push(`Buscando mapping para SKU ${sku}`);
    if (!sb) return NextResponse.json({ error: "No database connection", steps }, { status: 500 });

    const { data: mappings } = await sb.from("ml_items_map")
      .select("*")
      .eq("item_id", item_id)
      .limit(1);

    if (!mappings || mappings.length === 0) {
      return NextResponse.json({ error: `No existe mapping para item ${item_id} en ml_items_map`, steps }, { status: 404 });
    }
    const map = mappings[0];
    steps.push(`Mapping encontrado: user_product_id=${map.user_product_id}`);

    // Step 2: Resolve user_product_id
    let userProductId = map.user_product_id;
    if (!userProductId) {
      steps.push("Resolviendo user_product_id desde ML API...");
      userProductId = await getItemUserProductId(item_id);
      if (!userProductId) {
        return NextResponse.json({ error: `No se pudo resolver user_product_id para ${item_id}`, steps }, { status: 502 });
      }
      await sb.from("ml_items_map").update({ user_product_id: userProductId }).eq("item_id", item_id);
      steps.push(`user_product_id resuelto: ${userProductId}`);
    }

    // Step 3: Get current distributed stock + version
    steps.push("Obteniendo stock distribuido actual...");
    const stockData = await getDistributedStock(userProductId);
    if (!stockData) {
      return NextResponse.json({ error: `No se pudo obtener stock distribuido para ${userProductId}. Token puede estar expirado.`, steps }, { status: 502 });
    }
    steps.push(`Stock actual: version=${stockData.version}, locations=${JSON.stringify(stockData.locations.map(l => ({ type: l.type, qty: l.quantity })))}`);

    // Step 4: Determine stock type
    const sellerTypes = stockData.locations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
    if (sellerTypes.length === 0) {
      return NextResponse.json({ error: `No hay stock type controlable (selling_address/seller_warehouse) para ${userProductId}`, steps }, { status: 502 });
    }
    const stockType = sellerTypes[0].type as "selling_address" | "seller_warehouse";
    steps.push(`Stock type: ${stockType}`);

    // Step 5: Push stock
    steps.push(`Enviando ${qty} unidades a ML...`);
    const pushResult = await updateFlexStock(userProductId, qty, stockData.version, stockType, stockData.locations, { sku });
    if (!pushResult.ok) {
      return NextResponse.json({ error: `Stock push falló: ${pushResult.error}`, steps }, { status: 502 });
    }
    steps.push("Stock enviado OK");

    // Step 6: Activate item
    steps.push("Activando publicación...");
    const activateResult = await mlPut<{ id: string; status: string }>(`/items/${item_id}`, { status: "active" });
    if (!activateResult) {
      return NextResponse.json({
        error: "Stock enviado pero activación falló. ML puede necesitar unos segundos. Intenta de nuevo.",
        steps,
        stock_synced: true,
      }, { status: 502 });
    }
    steps.push("Publicación activada OK");

    // Step 7: Update local cache
    await sb.from("ml_items_map").update({
      status_ml: "active",
      stock_flex_cache: qty,
      ultimo_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("item_id", item_id);

    return NextResponse.json({ ok: true, item_id, sku, stock_synced: qty, status: "active", steps });
  } catch (err) {
    return NextResponse.json({ error: String(err), steps }, { status: 500 });
  }
}
