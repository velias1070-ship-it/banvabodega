import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { ensureValidToken } from "@/lib/ml";

/**
 * Busca productos en composicion_venta que tengan codigo_ml pero no estén
 * en ml_items_map. Para cada uno, busca el item en ML por inventory_id
 * y lo vincula automáticamente.
 *
 * Se llama después del sync del diccionario (Sheet) para vincular productos nuevos.
 */
export async function POST() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const token = await ensureValidToken();
    if (!token) return NextResponse.json({ error: "no_ml_token" }, { status: 500 });

    // 1. Get seller_id
    const { data: cfg } = await sb.from("ml_config").select("seller_id").eq("id", "main").single();
    if (!cfg?.seller_id) return NextResponse.json({ error: "no_seller_id" }, { status: 500 });

    // 2. Get composicion_venta entries with codigo_ml
    const { data: comp } = await sb.from("composicion_venta").select("sku_venta, sku_origen, codigo_ml").neq("codigo_ml", "");
    if (!comp || comp.length === 0) return NextResponse.json({ linked: 0, message: "No composicion entries" });

    // 3. Get existing ml_items_map inventory_ids and skus
    const { data: existing } = await sb.from("ml_items_map").select("inventory_id, sku");
    const mappedInvIds = new Set((existing || []).map(e => (e.inventory_id || "").toUpperCase()));
    const mappedSkus = new Set((existing || []).map(e => (e.sku || "").toUpperCase()));

    // 4. Find missing
    const missing = comp.filter(c => {
      const codigoMl = (c.codigo_ml || "").toUpperCase();
      const skuVenta = (c.sku_venta || "").toUpperCase();
      return codigoMl && !mappedInvIds.has(codigoMl) && !mappedSkus.has(skuVenta);
    });

    if (missing.length === 0) return NextResponse.json({ linked: 0, message: "Todos vinculados" });

    // 5. Get all active/paused items from seller (paginated)
    const itemInvMap = new Map<string, { item_id: string; user_product_id: string | null; title: string; available_quantity: number; variation_id: number | null }>();
    const missingInvIds = new Set(missing.map(m => (m.codigo_ml || "").toUpperCase()));
    let offset = 0;
    let total = 0;

    while (true) {
      const searchRes = await fetch(
        `https://api.mercadolibre.com/users/${cfg.seller_id}/items/search?limit=50&offset=${offset}&status=active,paused`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const searchData = await searchRes.json();
      if (!searchData.results || searchData.results.length === 0) break;
      total = searchData.paging?.total || 0;

      // Fetch each item to get inventory_id
      for (const itemId of searchData.results) {
        // Skip if we already found all missing
        if (itemInvMap.size >= missingInvIds.size) break;

        const itemRes = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const item = await itemRes.json();
        if (!item.id) continue;

        // Check main inventory_id
        if (item.inventory_id && missingInvIds.has(item.inventory_id.toUpperCase())) {
          itemInvMap.set(item.inventory_id.toUpperCase(), {
            item_id: item.id,
            user_product_id: item.user_product_id || null,
            title: (item.title || "").substring(0, 100),
            available_quantity: item.available_quantity || 0,
            variation_id: null,
          });
        }
        // Check variations
        if (item.variations) {
          for (const v of item.variations) {
            if (v.inventory_id && missingInvIds.has(v.inventory_id.toUpperCase())) {
              itemInvMap.set(v.inventory_id.toUpperCase(), {
                item_id: item.id,
                user_product_id: item.user_product_id || null,
                title: (item.title || "").substring(0, 100),
                available_quantity: v.available_quantity || 0,
                variation_id: v.id || null,
              });
            }
          }
        }
      }

      offset += 50;
      if (offset >= total || itemInvMap.size >= missingInvIds.size) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // 6. Insert found items into ml_items_map
    const toInsert = [];
    const notFound = [];
    for (const m of missing) {
      const invId = (m.codigo_ml || "").toUpperCase();
      const found = itemInvMap.get(invId);
      if (found) {
        toInsert.push({
          sku: m.sku_venta,
          item_id: found.item_id,
          inventory_id: m.codigo_ml,
          sku_venta: m.sku_venta,
          sku_origen: m.sku_origen,
          titulo: found.title,
          available_quantity: found.available_quantity,
          user_product_id: found.user_product_id,
          variation_id: found.variation_id,
          activo: true,
          updated_at: new Date().toISOString(),
        });
      } else {
        notFound.push({ sku: m.sku_venta, codigo_ml: m.codigo_ml });
      }
    }

    if (toInsert.length > 0) {
      const { error } = await sb.from("ml_items_map").upsert(toInsert, { onConflict: "sku,item_id" });
      if (error) {
        console.error("[link-missing] Upsert error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      linked: toInsert.length,
      not_found: notFound.length,
      items_searched: Math.min(offset, total),
      details: {
        linked: toInsert.map(r => ({ sku: r.sku, item_id: r.item_id })),
        not_found: notFound,
      },
    });
  } catch (err) {
    console.error("[link-missing] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
