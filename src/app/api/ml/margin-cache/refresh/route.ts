import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";
import { calcularCostoEnvioML, columnaPorPrecio, tramoPorPeso } from "@/lib/ml-shipping";

export const maxDuration = 60;

type MapRow = {
  sku: string;
  item_id: string;
  titulo: string | null;
  price: number | null;
  listing_type: string | null;
  category_id: string | null;
  status_ml: string | null;
};

type PromoInfo = {
  id?: string;
  type: string;
  name?: string;
  status: string;
  price: number;
  original_price: number;
};

type ShipFree = { coverage?: { all_country?: { list_cost: number; billable_weight: number } } };
type FeeInfo = { sale_fee_amount: number; sale_fee_details?: { percentage_fee: number } };

// POST /api/ml/margin-cache/refresh?offset=0&limit=20
// Procesa un chunk de items y actualiza ml_margin_cache. Para refresh completo,
// el cliente llama repetidamente avanzando el offset hasta processed >= total.
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "15", 10), 30);

  // Total (para el progreso)
  const { count: total } = await sb
    .from("ml_items_map")
    .select("*", { count: "exact", head: true })
    .eq("activo", true);

  // Chunk de items a procesar
  const { data: items, error: eItems } = await sb
    .from("ml_items_map")
    .select("sku,item_id,titulo,price,listing_type,category_id,status_ml")
    .eq("activo", true)
    .order("item_id")
    .range(offset, offset + limit - 1);

  if (eItems) return NextResponse.json({ error: eItems.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json({ processed: offset, total: total || 0, done: true });
  }

  const rows = items as MapRow[];

  // Pre-calcular costos por SKU (incluyendo composicion_venta)
  const skuList = Array.from(new Set(rows.map(r => r.sku)));
  const { data: prods } = await sb
    .from("productos")
    .select("sku, costo, costo_promedio");
  const costoBySku: Record<string, number> = {};
  for (const p of prods || []) {
    costoBySku[p.sku] = p.costo_promedio || p.costo || 0;
  }

  const { data: comps } = await sb
    .from("composicion_venta")
    .select("sku_venta, sku_origen, unidades")
    .in("sku_venta", skuList);
  const compBySku: Record<string, Array<{ sku_origen: string; unidades: number }>> = {};
  for (const c of comps || []) {
    if (!compBySku[c.sku_venta]) compBySku[c.sku_venta] = [];
    compBySku[c.sku_venta].push({ sku_origen: c.sku_origen, unidades: c.unidades });
  }

  // Cache de comisión por (category_id, listing_type) para evitar llamadas repetidas
  const feePctCache = new Map<string, number>();
  async function getFeePct(categoryId: string, listingType: string, refPrice: number): Promise<number> {
    const key = `${categoryId}::${listingType}`;
    if (feePctCache.has(key)) return feePctCache.get(key)!;
    try {
      const r = await mlGet<FeeInfo>(
        `/sites/MLC/listing_prices?price=${refPrice}&listing_type_id=${listingType}&category_id=${categoryId}`
      );
      const pct = r?.sale_fee_details?.percentage_fee || 0;
      feePctCache.set(key, pct);
      return pct;
    } catch {
      return 0;
    }
  }

  // Procesar cada item (2 llamadas ML: shipping + promos, con commission cacheada)
  const cacheRows: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const priceList = row.price || 0;
    const listingType = row.listing_type || "gold_special";
    const categoryId = row.category_id || "";

    // Costo (incluye composición)
    let costoNeto = costoBySku[row.sku] || 0;
    if (compBySku[row.sku]) {
      let total = 0;
      for (const c of compBySku[row.sku]) {
        total += (costoBySku[c.sku_origen] || 0) * c.unidades;
      }
      if (total > 0) costoNeto = total;
    }
    const costoBruto = Math.round(costoNeto * 1.19);

    let pesoFacturable = 0;
    let logisticType: string | null = null;
    let comisionPct = 0;
    let precioVenta = priceList;
    let tienePromo = false;
    let promoType: string | null = null;
    let promoPct: number | null = null;
    let syncError: string | null = null;

    try {
      const sellerId = (await sb.from("ml_config").select("seller_id").eq("id", "main").limit(1)).data?.[0]?.seller_id;
      if (sellerId) {
        const [shipFree, promos, feePct] = await Promise.all([
          mlGet<ShipFree>(`/users/${sellerId}/shipping_options/free?item_id=${row.item_id}`),
          mlGet<PromoInfo[]>(`/seller-promotions/items/${row.item_id}?app_version=v2`),
          categoryId ? getFeePct(categoryId, listingType, priceList || 20000) : Promise.resolve(0),
        ]);
        if (shipFree?.coverage?.all_country) {
          pesoFacturable = shipFree.coverage.all_country.billable_weight || 0;
        }
        comisionPct = feePct;
        if (Array.isArray(promos)) {
          const activa = promos
            .filter(p => p.status === "started" && p.price > 0)
            .sort((a, b) => a.price - b.price)[0];
          if (activa) {
            tienePromo = true;
            precioVenta = activa.price;
            promoType = activa.type;
            if (priceList > 0) {
              promoPct = Math.round(((priceList - activa.price) / priceList) * 100);
            }
          }
        }
      }
    } catch (e) {
      syncError = e instanceof Error ? e.message : "unknown";
    }

    const envio = calcularCostoEnvioML(pesoFacturable, precioVenta);
    const comisionClp = Math.round(precioVenta * (comisionPct / 100));
    const margen = precioVenta - comisionClp - envio - costoBruto;
    const margenPct = precioVenta > 0 ? (margen / precioVenta) * 100 : 0;
    const zona = columnaPorPrecio(precioVenta);
    const tramo = tramoPorPeso(pesoFacturable);

    cacheRows.push({
      item_id: row.item_id,
      sku: row.sku,
      titulo: row.titulo || "",
      category_id: categoryId || null,
      listing_type: listingType,
      logistic_type: logisticType,
      price_ml: priceList,
      precio_venta: precioVenta,
      tiene_promo: tienePromo,
      promo_type: promoType,
      promo_pct: promoPct,
      costo_neto: costoNeto,
      costo_bruto: costoBruto,
      peso_facturable: pesoFacturable,
      tramo_label: tramo.label,
      comision_pct: comisionPct,
      comision_clp: comisionClp,
      envio_clp: envio,
      margen_clp: margen,
      margen_pct: Number(margenPct.toFixed(2)),
      zona,
      synced_at: new Date().toISOString(),
      sync_error: syncError,
    });
  }

  if (cacheRows.length > 0) {
    const { error: upErr } = await sb.from("ml_margin_cache").upsert(cacheRows, { onConflict: "item_id" });
    if (upErr) return NextResponse.json({ error: upErr.message, processed: offset }, { status: 500 });
  }

  const processed = offset + rows.length;
  return NextResponse.json({
    processed,
    total: total || 0,
    chunk: rows.length,
    done: processed >= (total || 0),
  });
}
