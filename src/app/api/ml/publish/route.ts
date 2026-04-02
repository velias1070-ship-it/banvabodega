import { NextRequest, NextResponse } from "next/server";
import { mlPostDetailed, mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Create a new ML listing using /items/multiwarehouse (required for multi-warehouse sellers).
 * POST body: { sku?, family_name, category_id, price, condition, listing_type_id, pictures, attributes, channels?, available_quantity }
 *
 * Multi-warehouse sellers CANNOT use the classic /items endpoint with variations.
 * Each variant must be published as a separate item sharing the same family_name.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sku, ...itemBody } = body;

    // Force Chile defaults
    itemBody.currency_id = "CLP";
    if (!itemBody.buying_mode) itemBody.buying_mode = "buy_it_now";
    if (!itemBody.channels) itemBody.channels = ["marketplace"];

    // Remove variations if present — not allowed for multi-warehouse sellers
    delete itemBody.variations;

    // Build stock_locations from available_quantity
    const quantity = itemBody.available_quantity || 1;
    delete itemBody.available_quantity;

    // Get store locations from seller's existing items to reuse store_id/network_node_id
    const storeLocations = await getSellerStoreLocations();
    if (storeLocations.length > 0) {
      itemBody.stock_locations = storeLocations.map(loc => ({
        store_id: loc.store_id,
        network_node_id: loc.network_node_id,
        quantity,
      }));
    }

    const { data, error, status } = await mlPostDetailed<{
      id: string;
      title: string;
      family_name: string;
      permalink: string;
      thumbnail: string;
      price: number;
      status: string;
      category_id: string;
      listing_type_id: string;
      condition: string;
      available_quantity: number;
      user_product_id: string;
    }>("/items/multiwarehouse", itemBody);

    if (error || !data) {
      let parsedError: unknown = error;
      try { parsedError = JSON.parse(error || ""); } catch { /* keep as string */ }
      return NextResponse.json({ error: parsedError, status }, { status: status || 500 });
    }

    // Save to ml_items_map
    const sb = getServerSupabase();
    if (sb && sku) {
      await sb.from("ml_items_map").upsert({
        sku: sku.toUpperCase().trim(),
        item_id: data.id,
        variation_id: null,
        user_product_id: data.user_product_id || null,
        titulo: data.title,
        permalink: data.permalink,
        thumbnail: data.thumbnail,
        price: data.price,
        status_ml: data.status,
        category_id: data.category_id,
        listing_type: data.listing_type_id,
        condition: data.condition,
        available_quantity: data.available_quantity,
        activo: true,
        created_via: "publish",
        updated_at: new Date().toISOString(),
      }, { onConflict: "sku,item_id" });
    }

    return NextResponse.json({ item: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/** Get seller's warehouse locations from an existing user_product stock query */
async function getSellerStoreLocations(): Promise<Array<{ store_id: string; network_node_id: string }>> {
  const sb = getServerSupabase();
  if (!sb) return [];

  // Get a user_product_id from existing items to discover store locations
  const { data: items } = await sb.from("ml_items_map")
    .select("user_product_id")
    .eq("activo", true)
    .not("user_product_id", "is", null)
    .limit(1);

  if (!items || items.length === 0) return [];

  const upId = items[0].user_product_id;
  const stockResp = await mlGet<{ locations: Array<{ type: string; store_id?: string; network_node_id?: string }> }>(
    `/user-products/${upId}/stock`
  );

  if (!stockResp?.locations) return [];

  return stockResp.locations
    .filter(l => l.type === "seller_warehouse" && l.store_id && l.network_node_id)
    .map(l => ({ store_id: l.store_id!, network_node_id: l.network_node_id! }));
}
