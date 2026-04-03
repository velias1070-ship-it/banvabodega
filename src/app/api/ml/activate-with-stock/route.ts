import { NextRequest, NextResponse } from "next/server";
import { mlPut, getDistributedStock, updateFlexStock, getItemUserProductId, syncStockToML } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Sync stock to ML then activate an item — all server-side with detailed logging.
 * Uses the same stock calculation rules as /api/ml/stock-sync:
 *   - Resolves sku_origen via composicion_venta
 *   - Buffer: 2 (simple) or 4 (shared origen)
 *   - publicar = FLOOR((disponible_origen - buffer) / unidades_pack)
 *
 * POST body: { item_id: string, sku: string }
 */
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const steps: string[] = [];
  try {
    const { item_id, sku } = await req.json();
    if (!item_id || !sku) {
      return NextResponse.json({ error: "item_id and sku required" }, { status: 400 });
    }

    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "No database connection", steps }, { status: 500 });

    // Step 1: Get mapping
    steps.push(`Buscando mapping para ${item_id}`);
    const { data: mappings } = await sb.from("ml_items_map")
      .select("*").eq("item_id", item_id).limit(1);
    if (!mappings || mappings.length === 0) {
      return NextResponse.json({ error: `No existe mapping para item ${item_id}`, steps }, { status: 404 });
    }
    const map = mappings[0];
    steps.push(`Mapping: sku=${map.sku}, user_product_id=${map.user_product_id}`);

    // Step 2: Calculate stock using same rules as stock-sync
    steps.push("Calculando stock disponible...");
    const { data: composiciones } = await sb.from("composicion_venta")
      .select("sku_venta, sku_origen, unidades").eq("sku_venta", sku);
    const comp = (composiciones || [])[0] as { sku_origen: string; unidades: number } | undefined;
    const skuOrigen = comp?.sku_origen || (map as { sku_origen?: string }).sku_origen || sku;
    const unidadesPack = comp?.unidades || 1;

    // Check if shared origen (multiple sku_venta for same sku_origen)
    const { data: siblings } = await sb.from("composicion_venta")
      .select("sku_venta").eq("sku_origen", skuOrigen);
    const isShared = (siblings || []).length > 1;
    const buffer = isShared ? 4 : 2;

    // Get disponible from v_stock_disponible
    const { data: stockRow } = await sb.from("v_stock_disponible")
      .select("disponible").eq("sku", skuOrigen).maybeSingle();
    const disponibleOrigen = Math.max(0, (stockRow as { disponible: number } | null)?.disponible ?? 0);
    const available = Math.max(0, Math.floor((disponibleOrigen - buffer) / unidadesPack));

    steps.push(`sku_origen=${skuOrigen}, disponible=${disponibleOrigen}, buffer=${buffer}, pack=${unidadesPack} → publicar=${available}`);

    if (available <= 0) {
      return NextResponse.json({
        error: `Stock disponible insuficiente. Disponible origen: ${disponibleOrigen}, buffer: ${buffer}, pack: ${unidadesPack} → publicar: ${available}. Necesitas al menos ${buffer + unidadesPack} unidades de ${skuOrigen}.`,
        steps,
      }, { status: 400 });
    }

    // Step 3: Resolve user_product_id
    let userProductId = map.user_product_id;
    if (!userProductId) {
      steps.push("Resolviendo user_product_id...");
      userProductId = await getItemUserProductId(item_id);
      if (!userProductId) {
        return NextResponse.json({ error: `No se pudo resolver user_product_id para ${item_id}`, steps }, { status: 502 });
      }
      await sb.from("ml_items_map").update({ user_product_id: userProductId }).eq("item_id", item_id);
    }
    steps.push(`user_product_id=${userProductId}`);

    // Step 4: Get current distributed stock
    steps.push("Obteniendo stock distribuido...");
    const stockData = await getDistributedStock(userProductId);
    if (!stockData) {
      return NextResponse.json({ error: `No se pudo obtener stock distribuido para ${userProductId}`, steps }, { status: 502 });
    }
    steps.push(`version=${stockData.version}, locations=${JSON.stringify(stockData.locations.map(l => ({ type: l.type, qty: l.quantity })))}`);

    // Step 5: Determine stock type — find seller locations, borrowing from another item if needed
    let sellerLocs = stockData.locations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
    let stockType: "selling_address" | "seller_warehouse";
    let locationsForPut = stockData.locations;

    if (sellerLocs.length > 0) {
      stockType = sellerLocs[0].type as "selling_address" | "seller_warehouse";
    } else {
      steps.push("Sin seller locations, buscando de otro item...");
      const { data: otherItems } = await sb.from("ml_items_map")
        .select("user_product_id").eq("activo", true)
        .not("user_product_id", "is", null)
        .neq("user_product_id", userProductId).limit(10);

      let found = false;
      for (const other of (otherItems || [])) {
        const otherStock = await getDistributedStock(other.user_product_id);
        if (otherStock) {
          const otherSeller = otherStock.locations.filter(l => l.type === "selling_address" || l.type === "seller_warehouse");
          if (otherSeller.length > 0) {
            sellerLocs = otherSeller;
            locationsForPut = [...stockData.locations, ...otherSeller];
            steps.push(`Locations de ${other.user_product_id}: ${otherSeller[0].type}`);
            found = true;
            break;
          }
        }
      }
      if (!found) {
        return NextResponse.json({ error: "No se encontraron seller locations en ningún item", steps }, { status: 502 });
      }
      stockType = sellerLocs[0].type as "selling_address" | "seller_warehouse";
    }
    steps.push(`Stock type: ${stockType}`);

    // Step 6: Push stock
    steps.push(`Enviando ${available} uds a ML (${stockType})...`);
    const pushResult = await updateFlexStock(userProductId, available, stockData.version, stockType, locationsForPut, { sku, sku_origen: skuOrigen });
    if (!pushResult.ok) {
      return NextResponse.json({ error: `Stock push falló: ${pushResult.error}`, steps }, { status: 502 });
    }
    steps.push("Stock enviado OK");

    // Step 7: Activate with retries (ML needs time to process stock)
    let activateResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const waitSec = attempt * 3;
      steps.push(`Esperando ${waitSec}s (intento ${attempt}/3)...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      activateResult = await mlPut<{ id: string; status: string }>(`/items/${item_id}`, { status: "active" });
      if (activateResult) break;
    }
    if (!activateResult) {
      return NextResponse.json({
        error: "Stock enviado pero activación falló después de 3 intentos. Intenta activar manualmente en unos minutos.",
        steps, stock_synced: true,
      }, { status: 502 });
    }
    steps.push("Publicación activada OK");

    // Step 8: Update cache
    await sb.from("ml_items_map").update({
      status_ml: "active",
      stock_flex_cache: available,
      ultimo_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("item_id", item_id);

    return NextResponse.json({ ok: true, item_id, sku, stock_synced: available, status: "active", steps });
  } catch (err) {
    return NextResponse.json({ error: String(err), steps }, { status: 500 });
  }
}
