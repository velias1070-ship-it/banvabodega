import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;

interface PromoInfo {
  id?: string;
  type: string;
  name?: string;
  status: string;
  price: number;
  original_price: number;
  meli_percentage?: number;
  seller_percentage?: number;
  start_date?: string;
  finish_date?: string;
}

interface ItemPromoResult {
  item_id: string;
  sku: string;
  titulo: string;
  price_ml: number;
  costo_neto: number;
  costo_bruto: number;
  comision_ml: number;
  costo_envio: number;
  listing_type: string;
  category_id: string;
  promotions: PromoInfo[];
}

/**
 * GET /api/ml/promotions?item_ids=MLC123,MLC456
 * Trae promociones disponibles + costos para calcular márgenes.
 *
 * POST /api/ml/promotions
 * Body: { item_id, action: "create_discount" | "delete", deal_price?, start_date?, finish_date? }
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const itemIds = new URL(req.url).searchParams.get("item_ids")?.split(",").slice(0, 30) || [];
  if (itemIds.length === 0) return NextResponse.json({ error: "item_ids required" }, { status: 400 });

  const results: ItemPromoResult[] = [];

  // Obtener datos de ml_items_map + productos para costos
  for (const itemId of itemIds) {
    const { data: maps } = await sb.from("ml_items_map")
      .select("sku, item_id, titulo, price, sku_origen, listing_type, category_id")
      .eq("item_id", itemId)
      .limit(1);

    const map = maps?.[0];
    if (!map) continue;

    // Costo del producto
    const skuCosto = map.sku_origen || map.sku;
    const { data: prods } = await sb.from("productos")
      .select("costo, costo_promedio")
      .eq("sku", skuCosto)
      .limit(1);

    const { data: comp } = await sb.from("composicion_venta")
      .select("sku_origen, unidades")
      .eq("sku_venta", map.sku);

    let costoNeto = prods?.[0]?.costo_promedio || prods?.[0]?.costo || 0;
    if (comp && comp.length > 0) {
      let totalCosto = 0;
      for (const c of comp) {
        const { data: cp } = await sb.from("productos")
          .select("costo, costo_promedio")
          .eq("sku", c.sku_origen)
          .limit(1);
        totalCosto += ((cp?.[0]?.costo_promedio || cp?.[0]?.costo || 0)) * c.unidades;
      }
      if (totalCosto > 0) costoNeto = totalCosto;
    }

    // Comisión ML via API listing_prices
    let comisionMl = 0;
    const price = map.price || 0;
    const listingType = map.listing_type || "gold_special";
    const categoryId = map.category_id || "";
    if (price > 0 && categoryId) {
      try {
        const fees = await mlGet<{ sale_fee_amount: number }>(`/sites/MLC/listing_prices?price=${price}&listing_type_id=${listingType}&category_id=${categoryId}`);
        comisionMl = fees?.sale_fee_amount || 0;
      } catch { /* ignore */ }
    }

    // Costo envío promedio de ventas recientes del SKU
    let costoEnvio = 0;
    const { data: recentOrders } = await sb.from("orders_history")
      .select("costo_envio")
      .eq("sku_venta", map.sku)
      .order("fecha", { ascending: false })
      .limit(10);
    if (recentOrders && recentOrders.length > 0) {
      const envios = recentOrders.filter((o: { costo_envio: number }) => o.costo_envio > 0);
      if (envios.length > 0) {
        costoEnvio = Math.round(envios.reduce((s: number, o: { costo_envio: number }) => s + o.costo_envio, 0) / envios.length);
      }
    }

    // Promociones de ML
    let promotions: PromoInfo[] = [];
    try {
      const promos = await mlGet<PromoInfo[]>(`/seller-promotions/items/${itemId}?app_version=v2`);
      if (promos && Array.isArray(promos)) promotions = promos;
    } catch { /* ignore */ }

    results.push({
      item_id: itemId,
      sku: map.sku,
      titulo: map.titulo || "",
      price_ml: price,
      costo_neto: costoNeto,
      costo_bruto: Math.round(costoNeto * 1.19),
      comision_ml: comisionMl,
      costo_envio: costoEnvio,
      listing_type: listingType,
      category_id: categoryId,
      promotions,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  return NextResponse.json({ items: results });
}

export async function POST(req: NextRequest) {
  try {
    const { item_id, action, deal_price, start_date, finish_date } = await req.json();
    if (!item_id || !action) {
      return NextResponse.json({ error: "item_id y action requeridos" }, { status: 400 });
    }

    if (action === "create_discount") {
      if (!deal_price || !start_date || !finish_date) {
        return NextResponse.json({ error: "deal_price, start_date, finish_date requeridos" }, { status: 400 });
      }
      const result = await mlGet<unknown>(
        `/seller-promotions/items/${item_id}?app_version=v2`
      );
      // POST to create discount
      const resp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify({
          promotion_type: "PRICE_DISCOUNT",
          deal_price: deal_price,
          start_date,
          finish_date,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return NextResponse.json({ error: data.message || "Error ML", detail: data }, { status: resp.status });
      return NextResponse.json({ ok: true, result: data });
    }

    if (action === "delete") {
      const resp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${await getToken()}` },
      });
      const data = await resp.json();
      return NextResponse.json({ ok: resp.ok, result: data });
    }

    return NextResponse.json({ error: "action inválida" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function getToken(): Promise<string> {
  const sb = getServerSupabase();
  if (!sb) return "";
  const { data } = await sb.from("ml_config").select("access_token").eq("id", "main").limit(1);
  return data?.[0]?.access_token || "";
}
