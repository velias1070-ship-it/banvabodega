import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

interface MLItem {
  id: string;
  title: string;
  price: number;
  status: string;
  thumbnail: string;
  permalink: string;
  available_quantity: number;
  sold_quantity: number;
  listing_type_id: string;
  condition: string;
  category_id: string;
  tags?: string[];
  attributes?: Array<{ id: string; name: string; value_name: string | null }>;
  variations?: Array<{
    id: number;
    price: number;
    available_quantity: number;
    picture_ids: string[];
    attribute_combinations: Array<{ id: string; name: string; value_name: string }>;
  }>;
  pictures?: Array<{ id: string; url: string; secure_url: string }>;
}

/**
 * Fetch item details from ML API.
 * GET ?ids=MLC123,MLC456,MLC789  (max 20, fetched individually)
 * Also updates ml_items_map cache with fresh data.
 */
export async function GET(req: NextRequest) {
  try {
    const idsParam = new URL(req.url).searchParams.get("ids");
    if (!idsParam) {
      return NextResponse.json({ error: "ids required" }, { status: 400 });
    }

    const ids = idsParam.split(",").slice(0, 20);
    const results: Array<{ code: number; body: MLItem | null }> = [];

    // Fetch each item individually (mlGet handles auth + rate limiting)
    for (const id of ids) {
      const item = await mlGet<MLItem>(`/items/${id}`);
      if (item) {
        results.push({ code: 200, body: item });
      } else {
        results.push({ code: 404, body: null });
      }
    }

    // Update ml_items_map cache
    const sb = getServerSupabase();
    if (sb) {
      for (const wrapper of results) {
        if (wrapper.code === 200 && wrapper.body) {
          const item = wrapper.body;
          await sb.from("ml_items_map").update({
            titulo: item.title,
            price: item.price,
            status_ml: item.status,
            thumbnail: item.thumbnail,
            permalink: item.permalink,
            available_quantity: item.available_quantity,
            sold_quantity: item.sold_quantity,
            listing_type: item.listing_type_id,
            condition: item.condition,
            category_id: item.category_id,
            updated_at: new Date().toISOString(),
          }).eq("item_id", item.id);
        }
      }
    }

    return NextResponse.json({ items: results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
