import { NextRequest, NextResponse } from "next/server";
import { mlPostDetailed } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Create a new ML listing.
 * POST body: ML item JSON (title, category_id, price, pictures, attributes, etc.)
 * Optional: sku field to link to WMS producto
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sku, ...itemBody } = body;

    // Force Chile defaults
    itemBody.currency_id = "CLP";
    if (!itemBody.buying_mode) itemBody.buying_mode = "buy_it_now";

    const { data, error, status } = await mlPostDetailed<{
      id: string;
      title: string;
      permalink: string;
      thumbnail: string;
      price: number;
      status: string;
      category_id: string;
      listing_type_id: string;
      condition: string;
      available_quantity: number;
      variations: Array<{ id: number; attribute_combinations: Array<{ name: string; value_name: string }> }>;
    }>("/items", itemBody);

    if (error || !data) {
      let parsedError: unknown = error;
      try { parsedError = JSON.parse(error || ""); } catch { /* keep as string */ }
      return NextResponse.json({ error: parsedError, status }, { status: status || 500 });
    }

    // Save to ml_items_map
    const sb = getServerSupabase();
    if (sb && sku) {
      const mapRow = {
        sku: sku.toUpperCase().trim(),
        item_id: data.id,
        variation_id: null as number | null,
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
      };

      // If item has variations, create one row per variation
      if (data.variations && data.variations.length > 0) {
        for (const v of data.variations) {
          await sb.from("ml_items_map").upsert(
            { ...mapRow, variation_id: v.id },
            { onConflict: "sku,item_id" }
          );
        }
      } else {
        await sb.from("ml_items_map").upsert(mapRow, { onConflict: "sku,item_id" });
      }
    }

    return NextResponse.json({ item: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
