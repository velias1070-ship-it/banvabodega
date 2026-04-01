import { NextRequest, NextResponse } from "next/server";
import { mlPostDetailed } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * Add a variation to an existing ML item.
 * POST body: { item_id: string, sku?: string, variation: { attribute_combinations, price, available_quantity, picture_ids } }
 */
export async function POST(req: NextRequest) {
  try {
    const { item_id, sku, variation } = await req.json();
    if (!item_id || !variation) {
      return NextResponse.json({ error: "item_id and variation required" }, { status: 400 });
    }

    const { data, error, status } = await mlPostDetailed<{
      id: number;
      price: number;
      available_quantity: number;
      attribute_combinations: Array<{ name: string; value_name: string }>;
      picture_ids: string[];
    }>(`/items/${item_id}/variations`, variation);

    if (error || !data) {
      let parsedError: unknown = error;
      try { parsedError = JSON.parse(error || ""); } catch { /* keep as string */ }
      return NextResponse.json({ error: parsedError, status }, { status: status || 500 });
    }

    // Save to ml_items_map if sku provided
    const sb = getServerSupabase();
    if (sb && sku) {
      await sb.from("ml_items_map").upsert({
        sku: sku.toUpperCase().trim(),
        item_id,
        variation_id: data.id,
        available_quantity: data.available_quantity,
        price: data.price,
        activo: true,
        created_via: "publish",
        updated_at: new Date().toISOString(),
      }, { onConflict: "sku,item_id" });
    }

    return NextResponse.json({ variation: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
