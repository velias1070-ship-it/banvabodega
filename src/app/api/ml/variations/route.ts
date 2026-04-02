import { NextRequest, NextResponse } from "next/server";
import { mlPostDetailed, mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Add a "variation" to an existing ML item (multi-warehouse model).
 * In this model, variations are separate items sharing the same family_name.
 *
 * POST body: {
 *   item_id: string,           // existing item to clone family_name from
 *   sku?: string,              // WMS SKU to link
 *   family_name?: string,      // override family_name (optional, auto-detected from item_id)
 *   category_id?: string,      // override (auto-detected from item_id)
 *   price: number,
 *   available_quantity: number,
 *   condition?: string,
 *   listing_type_id?: string,
 *   pictures: [{source: string}],
 *   attributes: [{id, value_name}],
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { item_id, sku, ...newItemBody } = body;

    if (!item_id) {
      return NextResponse.json({ error: "item_id required (reference item to clone family_name from)" }, { status: 400 });
    }

    // Fetch reference item to get family_name, category, listing_type
    const refItem = await mlGet<{
      id: string;
      family_name: string;
      category_id: string;
      listing_type_id: string;
      condition: string;
      shipping: unknown;
    }>(`/items/${item_id}`);

    if (!refItem) {
      return NextResponse.json({ error: `Could not fetch reference item ${item_id}` }, { status: 502 });
    }

    // Build the new item using reference item defaults + overrides
    const itemBody: Record<string, unknown> = {
      family_name: newItemBody.family_name || refItem.family_name,
      category_id: newItemBody.category_id || refItem.category_id,
      listing_type_id: newItemBody.listing_type_id || refItem.listing_type_id,
      condition: newItemBody.condition || refItem.condition,
      price: newItemBody.price,
      currency_id: "CLP",
      buying_mode: "buy_it_now",
      channels: ["marketplace"],
      pictures: newItemBody.pictures || [],
      attributes: newItemBody.attributes || [],
      shipping: newItemBody.shipping || refItem.shipping,
    };

    // Stock locations
    const quantity = newItemBody.available_quantity || 1;
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

    return NextResponse.json({ variation: data, note: "Published as separate item with same family_name" });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function getSellerStoreLocations(): Promise<Array<{ store_id: string; network_node_id: string }>> {
  const sb = getServerSupabase();
  if (!sb) return [];

  const { data: items } = await sb.from("ml_items_map")
    .select("user_product_id")
    .eq("activo", true)
    .not("user_product_id", "is", null)
    .limit(1);

  if (!items || items.length === 0) return [];

  const stockResp = await mlGet<{ locations: Array<{ type: string; store_id?: string; network_node_id?: string }> }>(
    `/user-products/${items[0].user_product_id}/stock`
  );

  if (!stockResp?.locations) return [];

  return stockResp.locations
    .filter(l => l.type === "seller_warehouse" && l.store_id && l.network_node_id)
    .map(l => ({ store_id: l.store_id!, network_node_id: l.network_node_id! }));
}
