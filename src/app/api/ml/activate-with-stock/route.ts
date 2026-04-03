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
    let sellerTypes = stockData.locations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
    let stockType: "selling_address" | "seller_warehouse";
    let locationsForPut = stockData.locations;

    if (sellerTypes.length > 0) {
      stockType = sellerTypes[0].type as "selling_address" | "seller_warehouse";
      steps.push(`Stock type: ${stockType}`);
    } else {
      // No seller locations in response — get them from another item that has them
      steps.push("No hay seller locations en este item, buscando de otro item...");
      const { data: otherItems } = await sb.from("ml_items_map")
        .select("user_product_id")
        .eq("activo", true)
        .not("user_product_id", "is", null)
        .neq("user_product_id", userProductId)
        .limit(10);

      let foundLocations: typeof stockData.locations | null = null;
      for (const other of (otherItems || [])) {
        const otherStock = await getDistributedStock(other.user_product_id);
        if (otherStock) {
          const otherSeller = otherStock.locations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
          if (otherSeller.length > 0) {
            foundLocations = otherStock.locations;
            steps.push(`Locations encontradas en ${other.user_product_id}: ${otherSeller.map(l => l.type).join(", ")}`);
            break;
          }
        }
      }

      if (!foundLocations) {
        return NextResponse.json({ error: `No se encontraron seller locations en ningún item`, steps }, { status: 502 });
      }

      sellerTypes = foundLocations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
      stockType = sellerTypes[0].type as "selling_address" | "seller_warehouse";
      // Merge: use found seller locations + current item's other locations
      locationsForPut = [...stockData.locations, ...sellerTypes];
      steps.push(`Usando stock type: ${stockType} (de otro item)`);
    }

    // Step 5: Push stock
    steps.push(`Enviando ${qty} unidades a ML (${stockType})...`);
    const pushResult = await updateFlexStock(userProductId, qty, stockData.version, stockType, locationsForPut, { sku });
    if (!pushResult.ok) {
      return NextResponse.json({ error: `Stock push falló: ${pushResult.error}`, steps }, { status: 502 });
    }
    steps.push("Stock enviado OK");

    // Step 6: Activate item with retries (ML needs time to process stock)
    let activateResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const waitSec = attempt * 3;
      steps.push(`Esperando ${waitSec}s para que ML procese el stock (intento ${attempt}/3)...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      steps.push("Activando publicación...");
      activateResult = await mlPut<{ id: string; status: string }>(`/items/${item_id}`, { status: "active" });
      if (activateResult) break;
    }
    if (!activateResult) {
      return NextResponse.json({
        error: "Stock enviado pero activación falló después de 3 intentos. ML puede necesitar más tiempo. Intenta activar manualmente en unos minutos.",
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
