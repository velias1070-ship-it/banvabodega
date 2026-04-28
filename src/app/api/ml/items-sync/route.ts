import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface MLItemMultiget {
  code: number;
  body: {
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
    date_created?: string;
    start_time?: string;
  } | null;
}

/**
 * Cron: sync all active items from ML to ml_items_map cache.
 * Uses multiget /items?ids=... (20 per call) for speed.
 * Updates: titulo, price, status_ml, thumbnail, permalink, available_quantity, sold_quantity.
 *
 * Runs every 30 min to keep Publicaciones section live.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const hasParams = req.nextUrl.searchParams.has("run");

  if (!isVercelCron && !isLocalDev && !hasParams) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    // 1. Get all unique item_ids from ml_items_map
    const { data: items } = await sb.from("ml_items_map")
      .select("item_id")
      .eq("activo", true);

    if (!items || items.length === 0) {
      return NextResponse.json({ status: "ok", updated: 0, message: "no active items" });
    }

    const uniqueIds = Array.from(new Set((items as { item_id: string }[]).map(i => i.item_id)));
    console.log(`[Items Sync] ${uniqueIds.length} unique items to refresh`);

    // 2. Fetch in batches of 20 using multiget
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < uniqueIds.length; i += 20) {
      const batch = uniqueIds.slice(i, i + 20);

      // Try multiget first
      const multiResult = await mlGet<MLItemMultiget[]>(`/items?ids=${batch.join(",")}`);

      if (multiResult && Array.isArray(multiResult)) {
        // Multiget worked
        for (const wrapper of multiResult) {
          if (wrapper.code === 200 && wrapper.body) {
            const item = wrapper.body;
            // Caso real ALPCMPRSQ6012 (28-abr-2026): API /items devuelve
            // item.price=19787 (precio base del seller, valor histórico),
            // pero el listing real ML tenía price_ml=29980 + Día de la Mama
            // -40% efectivo=17980. Para DEALs externos de ML, item.price
            // queda contaminado por valores antiguos. Preferir original_price
            // si es mayor (refleja el lista real cuando hay promo seller).
            // El precio efectivo "real" se calcula en margin-cache/refresh.
            const itemAny = item as { price: number; original_price?: number | null };
            const priceWrite = Math.max(itemAny.price || 0, itemAny.original_price || 0);
            const { error } = await sb.from("ml_items_map").update({
              titulo: item.title,
              price: priceWrite,
              status_ml: item.status,
              thumbnail: item.thumbnail,
              permalink: item.permalink,
              available_quantity: item.available_quantity,
              sold_quantity: item.sold_quantity,
              listing_type: item.listing_type_id,
              condition: item.condition,
              category_id: item.category_id,
              date_created_ml: item.date_created || null,
              start_time_ml: item.start_time || null,
              updated_at: new Date().toISOString(),
            }).eq("item_id", item.id);
            if (!error) updated++;
            else failed++;
          }
        }
      } else {
        // Multiget failed — fallback to individual fetches
        for (const id of batch) {
          try {
            const item = await mlGet<MLItemMultiget["body"]>(`/items/${id}`);
            if (item) {
              const itemAny = item as { price: number; original_price?: number | null };
              const priceWrite = Math.max(itemAny.price || 0, itemAny.original_price || 0);
              await sb.from("ml_items_map").update({
                titulo: item.title,
                price: priceWrite,
                status_ml: item.status,
                thumbnail: item.thumbnail,
                permalink: item.permalink,
                available_quantity: item.available_quantity,
                sold_quantity: item.sold_quantity,
                listing_type: item.listing_type_id,
                condition: item.condition,
                category_id: item.category_id,
                date_created_ml: item.date_created || null,
                start_time_ml: item.start_time || null,
                updated_at: new Date().toISOString(),
              }).eq("item_id", item.id);
              updated++;
            } else { failed++; }
          } catch { failed++; }
        }
      }

      // Small delay between batches
      if (i + 20 < uniqueIds.length) await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[Items Sync] Done: ${updated} updated, ${failed} failed`);
    return NextResponse.json({ status: "ok", total: uniqueIds.length, updated, failed });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
