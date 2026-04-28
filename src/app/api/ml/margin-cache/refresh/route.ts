import { NextRequest, NextResponse } from "next/server";
import { mlGet, logPriceChange } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";
import { calcularCostoEnvioML, columnaPorPrecio, tramoPorPeso } from "@/lib/ml-shipping";

export const maxDuration = 300;

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
  min_discounted_price?: number;
  max_discounted_price?: number;
  suggested_discounted_price?: number;
  start_date?: string;
  finish_date?: string;
  // Para promos donde ML obliga precio sin rango (UNHEALTHY_STOCK, SMART
  // candidate, PRE_NEGOTIATED), el precio NO viene en `price`. ML expresa
  // el descuento como porcentajes que tu (seller) y ML aportan. El precio
  // efectivo que tendrias que aceptar es:
  //   original_price × (1 - (seller_percentage + meli_percentage) / 100)
  meli_percentage?: number;
  seller_percentage?: number;
};

/**
 * Precio efectivo que ML obliga para una promo. Para promos con `price`
 * directo (LIGHTNING, DOD, SMART started) usa ese. Para promos donde ML
 * expresa el descuento como porcentajes (UNHEALTHY_STOCK candidate, SMART
 * candidate sin price), calcula original_price × (1 - %seller - %meli).
 *
 * Manual: feedback_ml_promos_precio_obligado.md (memoria persistente).
 */
function calcularPrecioFijoML(p: PromoInfo): number {
  if (p.price && p.price > 0) return Math.round(p.price);
  const sellerPct = p.seller_percentage || 0;
  const meliPct = p.meli_percentage || 0;
  const totalPct = sellerPct + meliPct;
  if (totalPct > 0 && p.original_price > 0) {
    return Math.round(p.original_price * (1 - totalPct / 100));
  }
  return 0;
}

type ShipFree = { coverage?: { all_country?: { list_cost: number; billable_weight: number } } };
type FeeInfo = { sale_fee_amount: number; sale_fee_details?: { percentage_fee: number } };

// POST /api/ml/margin-cache/refresh?offset=0&limit=20
// POST /api/ml/margin-cache/refresh?item_ids=MLC123,MLC456  ← refresh focalizado
// POST /api/ml/margin-cache/refresh?stale=true&limit=30     ← refresca los N mas viejos
// GET  /api/ml/margin-cache/refresh?stale=true&limit=30     ← idem (para Vercel crons)
//
// Procesa un chunk de items y actualiza ml_margin_cache. Para refresh completo,
// el cliente llama repetidamente avanzando el offset hasta processed >= total.
// Con item_ids procesa exactamente esos y devuelve done=true al final.
// Con stale=true ordena por synced_at ASC y procesa los mas viejos.
export async function GET(req: NextRequest) {
  return handleRefresh(req);
}
export async function POST(req: NextRequest) {
  return handleRefresh(req);
}

async function handleRefresh(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "15", 10), 30);
  const itemIdsFilter = url.searchParams.get("item_ids")?.split(",").map(s => s.trim()).filter(Boolean);
  const staleMode = url.searchParams.get("stale") === "true";

  // Modo stale: buscar los item_ids con synced_at mas antiguo en el cache
  // (incluyendo los que nunca se han sincronizado aun), limitado a N.
  let staleItemIds: string[] = [];
  if (staleMode) {
    // Items que existen en ml_items_map pero no estan en ml_margin_cache → prioridad
    const { data: allMap } = await sb
      .from("ml_items_map")
      .select("item_id")
      .eq("activo", true);
    const allMapIds = new Set((allMap || []).map((r: { item_id: string }) => r.item_id).filter(Boolean));

    const { data: cached } = await sb
      .from("ml_margin_cache")
      .select("item_id,synced_at")
      .order("synced_at", { ascending: true, nullsFirst: true });
    const cachedIds = new Set((cached || []).map((r: { item_id: string }) => r.item_id));

    // Items sin cache primero, luego los mas viejos
    const noCacheIds: string[] = Array.from(allMapIds).filter(id => !cachedIds.has(id));
    const oldestCachedIds = (cached || [])
      .filter((r: { item_id: string }) => allMapIds.has(r.item_id))
      .map((r: { item_id: string }) => r.item_id);
    staleItemIds = [...noCacheIds, ...oldestCachedIds].slice(0, limit);
  }

  // Traer items activos y deduplicar por item_id (ml_items_map puede tener
  // varias filas con el mismo item_id por variantes de color/talla). Si viene
  // el filtro item_ids, solo buscamos esos.
  let query = sb
    .from("ml_items_map")
    .select("sku,item_id,titulo,price,listing_type,category_id,status_ml")
    .eq("activo", true);
  const effectiveFilter = staleMode ? staleItemIds : itemIdsFilter;
  if (effectiveFilter && effectiveFilter.length > 0) {
    query = query.in("item_id", effectiveFilter);
  }
  const { data: allItems, error: eAll } = await query;
  if (eAll) return NextResponse.json({ error: eAll.message }, { status: 500 });

  const byId = new Map<string, MapRow>();
  for (const r of (allItems as MapRow[] | null) || []) {
    if (!r.item_id) continue;
    const existing = byId.get(r.item_id);
    if (!existing) {
      byId.set(r.item_id, r);
      continue;
    }
    const existingFb = existing.sku === existing.item_id;
    const rowFb = r.sku === r.item_id;
    if (existingFb && !rowFb) byId.set(r.item_id, r);
  }
  const unique = Array.from(byId.values()).sort((a, b) => a.item_id.localeCompare(b.item_id));
  const total = unique.length;
  // Cuando es refresh focalizado o stale, ignoramos offset/limit y procesamos todo
  const rows = (effectiveFilter && effectiveFilter.length > 0)
    ? unique
    : unique.slice(offset, offset + limit);

  if (rows.length === 0) {
    return NextResponse.json({ processed: offset, total, done: true });
  }

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

  // Stock por SKU origen (suma de todas las posiciones) — necesario para WAC
  // cuando hay múltiples alternativas en composicion_venta.
  const allOrigenes = new Set<string>();
  for (const sku of skuList) {
    const cs = compBySku[sku];
    if (cs) for (const c of cs) allOrigenes.add(c.sku_origen);
    else allOrigenes.add(sku);
  }
  const stockBySku: Record<string, number> = {};
  // Stock en ML Full (meli_facility) — ML usa este para el check LIGHTNING
  const stockFullBySku: Record<string, number> = {};
  if (allOrigenes.size > 0) {
    const origList = Array.from(allOrigenes);
    for (let i = 0; i < origList.length; i += 200) {
      const chunk = origList.slice(i, i + 200);
      const { data: sts } = await sb.from("stock").select("sku, cantidad").in("sku", chunk);
      for (const s of (sts || []) as Array<{ sku: string; cantidad: number }>) {
        stockBySku[s.sku] = (stockBySku[s.sku] || 0) + (s.cantidad || 0);
      }
    }
  }
  // Traer stock full por sku_venta (se mapea a sku_origen via composicion)
  if (skuList.length > 0) {
    for (let i = 0; i < skuList.length; i += 200) {
      const chunk = skuList.slice(i, i + 200);
      const { data: fs } = await sb.from("stock_full_cache").select("sku_venta, cantidad").in("sku_venta", chunk);
      for (const r of (fs || []) as Array<{ sku_venta: string; cantidad: number }>) {
        const comps = compBySku[r.sku_venta];
        const target = comps && comps.length === 1 ? comps[0].sku_origen : r.sku_venta;
        stockFullBySku[target] = (stockFullBySku[target] || 0) + (r.cantidad || 0);
      }
    }
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
    // IMPORTANTE: row.price (de ml_items_map) puede reflejar el precio CON
    // promo aplicada, no el precio lista real. Vamos a corregirlo mas abajo
    // con el original_price que viene en la respuesta de /seller-promotions.
    let priceList = row.price || 0;
    const listingType = row.listing_type || "gold_special";
    const categoryId = row.category_id || "";

    // Costo — dos casos:
    //
    // A) Composición "real" (1 fila con unidades>1 o varias con sku_origen distinto):
    //    - Si hay UNA sola fila: costo = costo_origen × unidades (pack sumativo)
    //    - Si hay VARIAS filas con el MISMO sku_origen: costo = costo × sum(unidades)
    //    - Si hay VARIAS filas con DISTINTOS sku_origen (alternativas OR):
    //        weighted average cost = Σ(costo_i × stock_i) / Σ(stock_i)
    //        fallback (sin stock en ninguna): promedio simple ponderado por unidades
    //
    // B) Sin composición: usa el costo del SKU directo.
    let costoNeto = costoBySku[row.sku] || 0;
    const comps = compBySku[row.sku];
    if (comps && comps.length > 0) {
      const origenesUnicos = new Set(comps.map(c => c.sku_origen));
      if (origenesUnicos.size === 1) {
        // Todas las filas refieren al mismo sku_origen: sumar unidades.
        const uniOrig = comps[0].sku_origen;
        const totalUnidades = comps.reduce((s, c) => s + c.unidades, 0);
        costoNeto = (costoBySku[uniOrig] || 0) * totalUnidades;
      } else {
        // Alternativas: weighted average cost ponderado por stock disponible.
        // Si una alternativa tiene unidades>1, su peso efectivo es stock_i × unidades_i.
        let numerador = 0;
        let denominador = 0;
        for (const c of comps) {
          const costoUnit = costoBySku[c.sku_origen] || 0;
          const stock = stockBySku[c.sku_origen] || 0;
          const peso = stock * c.unidades;
          numerador += costoUnit * peso;
          denominador += peso;
        }
        if (denominador > 0) {
          // Costo por "unidad efectiva" vendida. Si una alternativa se declara con
          // unidades>1, divimos el numerador por la unidades_efectivas equivalentes.
          // Para el caso estándar donde todas las alternativas tienen unidades=1,
          // esto se reduce al WAC clásico.
          costoNeto = Math.round(numerador / denominador);
        } else {
          // Fallback sin stock: promedio simple ponderado por unidades.
          let sumCostoU = 0;
          let sumU = 0;
          for (const c of comps) {
            sumCostoU += (costoBySku[c.sku_origen] || 0) * c.unidades;
            sumU += c.unidades;
          }
          costoNeto = sumU > 0 ? Math.round(sumCostoU / sumU) : 0;
        }
      }
    }
    costoNeto = Math.round(costoNeto);
    const costoBruto = Math.round(costoNeto * 1.19);

    // Stock total (bodega + ML Full). Para packs, usa el stock del sku_origen
    // unico si existe; de lo contrario asume stock por sku_venta directo.
    const stockOrig = (() => {
      const comps = compBySku[row.sku];
      if (comps && comps.length === 1) {
        const so = comps[0].sku_origen;
        return (stockBySku[so] || 0) + (stockFullBySku[so] || 0);
      }
      return (stockBySku[row.sku] || 0) + (stockFullBySku[row.sku] || 0);
    })();

    let pesoFacturable = 0;
    let logisticType: string | null = null;
    let comisionPct = 0;
    let precioVenta = priceList;
    let tienePromo = false;
    let promoType: string | null = null;
    let promoName: string | null = null;
    let promoPct: number | null = null;
    let promosPostulables: Array<{ name: string; type: string; id: string | null; min: number; max: number; suggested: number; precio_fijo_ml: number; start_date: string | null; finish_date: string | null }> = [];
    let syncError: string | null = null;
    // Flag de fetch de promos. Si es false (exception o null), NO confiamos en
    // los defaults precioVenta=priceList/tienePromo=false — conservamos lo que
    // habia en cache. Bug 2026-04-25: una falla transitoria del endpoint
    // /seller-promotions hacia oscilar precio_venta entre con-promo y sin-promo
    // y polucionaba ml_price_history con falsos sync_diff.
    let promosFetchOk = false;

    try {
      const sellerId = (await sb.from("ml_config").select("seller_id").eq("id", "main").limit(1)).data?.[0]?.seller_id;
      if (sellerId) {
        const [shipFreeRes, promosRes, feePctRes] = await Promise.allSettled([
          mlGet<ShipFree>(`/users/${sellerId}/shipping_options/free?item_id=${row.item_id}`),
          mlGet<PromoInfo[]>(`/seller-promotions/items/${row.item_id}?app_version=v2`),
          categoryId ? getFeePct(categoryId, listingType, priceList || 20000) : Promise.resolve(0),
        ]);
        const shipFree = shipFreeRes.status === "fulfilled" ? shipFreeRes.value : null;
        const promos = promosRes.status === "fulfilled" ? promosRes.value : null;
        const feePct = feePctRes.status === "fulfilled" ? feePctRes.value : 0;
        if (shipFreeRes.status === "rejected") {
          syncError = `shipFree: ${String(shipFreeRes.reason)}`;
        }
        if (promosRes.status === "rejected") {
          syncError = (syncError ? syncError + " | " : "") + `promos: ${String(promosRes.reason)}`;
        }
        if (feePctRes.status === "rejected") {
          syncError = (syncError ? syncError + " | " : "") + `feePct: ${String(feePctRes.reason)}`;
        }
        if (shipFree?.coverage?.all_country) {
          pesoFacturable = shipFree.coverage.all_country.billable_weight || 0;
        }
        comisionPct = feePct;
        if (Array.isArray(promos)) {
          promosFetchOk = true;
          // Antes de buscar la promo activa, corregir priceList usando el
          // original_price que ML reporta. Si el valor guardado en ml_items_map
          // venia con la promo aplicada, el original_price es el "lista real".
          const maxOriginal = Math.max(...promos.map(p => p.original_price || 0), 0);
          if (maxOriginal > priceList) {
            priceList = maxOriginal;
          }

          // Identificar la promo realmente aplicada:
          // ML aplica SIEMPRE el descuento que mas beneficia al comprador.
          // Cuando hay >=2 promos con status=started y price>0, la aplicada
          // es la de MENOR price_actual.
          //
          // Nota: NO se puede confiar en /items/{id}?price para identificar la
          // aplicada — ese endpoint devuelve el price base del seller, sin
          // considerar DEALs externos de ML (Dia de la Mama, Cyber Day) que
          // se aplican por encima sin modificar item.price.
          // Caso real TXV25QLBRBG25 (2026-04-24): item.price=24730 (Oferta Banva
          // Abril SELLER_CAMPAIGN) pero en la UI se muestra 24700 (Dia de la
          // Mama DEAL, aplicado encima). La aplicada real es Dia de la Mama.
          const activa = promos
            .filter(p => p.status === "started" && p.price > 0)
            .sort((a, b) => a.price - b.price)[0];
          if (activa) {
            tienePromo = true;
            precioVenta = activa.price;
            promoType = activa.type;
            promoName = activa.name || null;
            // Usar el precio original real (no row.price que puede estar contaminado)
            const listaReal = activa.original_price > 0 ? activa.original_price : priceList;
            if (listaReal > 0) {
              promoPct = Math.round(((listaReal - activa.price) / listaReal) * 100);
            }
            priceList = listaReal;
          }

          // Promos disponibles pero NO postuladas (candidate) — sirven para filtrar
          // "items que aun no estan en X pero podrian postular".
          // Ademas del nombre/tipo, se guarda el rango y el sugerido para que el
          // motor de auto-postulacion pueda evaluar sin llamar ML de nuevo.
          const seen = new Set<string>();
          for (const p of promos) {
            if (p.status !== "candidate") continue;
            const key = (p.id || "") + "::" + (p.type || "");
            if (seen.has(key)) continue;
            seen.add(key);
            promosPostulables.push({
              name: p.name || p.type || "Promoción",
              type: p.type || "",
              id: p.id || null,
              min: Math.round(p.min_discounted_price || 0),
              max: Math.round(p.max_discounted_price || 0),
              suggested: Math.round(p.suggested_discounted_price || 0),
              // Precio fijo obligado por ML. Maneja 2 casos:
              //   1. price directo (LIGHTNING/DOD/SMART started)
              //   2. seller_percentage + meli_percentage sobre original_price
              //      (UNHEALTHY_STOCK candidate, SMART candidate, PRE_NEGOTIATED)
              precio_fijo_ml: calcularPrecioFijoML(p),
              start_date: p.start_date || null,
              finish_date: p.finish_date || null,
            });
          }
        } else if (promosRes.status === "rejected" || promos === null) {
          // Promos fetch fallo: no confiamos en los defaults. Marcamos para que
          // el bloque de upsert preserve el valor previo de precio_venta y
          // promo_*. Sin esto, una falla transitoria del API ML pisa la cache
          // y dispara falsos sync_diff (Regla 1 inventory-policy: no centinelas;
          // promosFetchOk=false es el guard explicito).
          if (!syncError) syncError = "promos_fetch_failed_or_null";
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
      _promos_fetch_ok: promosFetchOk,
      item_id: row.item_id,
      sku: row.sku,
      titulo: row.titulo || "",
      category_id: categoryId || null,
      listing_type: listingType,
      logistic_type: logisticType,
      price_ml: Math.round(priceList),
      precio_venta: Math.round(precioVenta),
      tiene_promo: tienePromo,
      promo_type: promoType,
      promo_name: promoName,
      promo_pct: promoPct,
      promos_postulables: promosPostulables,
      status_ml: row.status_ml || null,
      stock_total: stockOrig,
      costo_neto: costoNeto,
      costo_bruto: costoBruto,
      peso_facturable: Math.round(pesoFacturable),
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

  // Dedupe defensivo final: garantizar item_id único en el batch
  const uniqueCacheRows = Array.from(
    new Map(cacheRows.map(r => [r.item_id as string, r])).values()
  );

  // Snapshot de precios previos para detectar cambios externos (promo aplicada
  // por ML, dynamic pricing, edicion manual desde web ML). Se loguean en
  // ml_price_history con fuente='sync_diff'. Precondicion del repricer
  // competitivo (BANVA_Pricing_Investigacion_Comparada §6.4).
  const itemIdsToCheck = uniqueCacheRows.map(r => r.item_id as string);
  const prevByItemId = new Map<string, { precio_venta: number | null; price_ml: number | null }>();
  const skuOrigenByItemId = new Map<string, string | null>();
  if (itemIdsToCheck.length > 0) {
    const [{ data: prevRows }, { data: mapRows }] = await Promise.all([
      sb.from("ml_margin_cache").select("item_id, precio_venta, price_ml").in("item_id", itemIdsToCheck),
      sb.from("ml_items_map").select("item_id, sku_origen").in("item_id", itemIdsToCheck),
    ]);
    for (const r of (prevRows || []) as { item_id: string; precio_venta: number | null; price_ml: number | null }[]) {
      prevByItemId.set(r.item_id, { precio_venta: r.precio_venta, price_ml: r.price_ml });
    }
    for (const r of (mapRows || []) as { item_id: string; sku_origen: string | null }[]) {
      if (!skuOrigenByItemId.has(r.item_id)) skuOrigenByItemId.set(r.item_id, r.sku_origen);
    }
  }

  const priceChangesDetected: Array<{ item_id: string; precio_anterior: number | null; precio_nuevo: number }> = [];
  let promos_fetch_skipped = 0;

  if (uniqueCacheRows.length > 0) {
    // Upsert 1 por 1 para evitar cualquier interacción extraña con la PK
    for (const cr of uniqueCacheRows) {
      const promosFetchOk = (cr as { _promos_fetch_ok?: boolean })._promos_fetch_ok === true;
      // Strip flag interno antes de upsertear (no es columna de la tabla)
      const crClean: Record<string, unknown> = { ...(cr as Record<string, unknown>) };
      delete crClean._promos_fetch_ok;
      // Si la fetch de promos fallo, NO sobrescribir precio_venta/promo_* en la
      // cache: una falla transitoria no debe destruir el snapshot anterior.
      // Construimos un payload reducido que conserva campos seguros y omite los
      // contaminados (Regla 5 inventory-policy: no sobrescribir fuente canonica
      // con datos derivados de respuesta parcial).
      let payload: Record<string, unknown> = crClean;
      if (!promosFetchOk) {
        promos_fetch_skipped += 1;
        payload = { ...crClean };
        delete payload.precio_venta;
        delete payload.tiene_promo;
        delete payload.promo_type;
        delete payload.promo_name;
        delete payload.promo_pct;
        delete payload.promos_postulables;
        delete payload.price_ml;
        delete payload.margen_clp;
        delete payload.margen_pct;
        delete payload.envio_clp;
        delete payload.zona;
      }
      const itemId = cr.item_id as string;
      const prev = prevByItemId.get(itemId);
      // Si promos fallo Y el item NO existe en cache aun, NO upsertear (no
      // queremos crear un row con datos parciales). Skip y log.
      if (!promosFetchOk && !prev) {
        console.warn(`[margin-cache] skip insert ${itemId}: promos fetch failed and no previous cache row`);
        continue;
      }
      const { error: upErr } = await sb.from("ml_margin_cache").upsert(payload, { onConflict: "item_id" });
      if (upErr) {
        return NextResponse.json({
          error: upErr.message,
          failed_item: itemId,
          processed: offset,
        }, { status: 500 });
      }
      // 2026-04-28: Sincronizar ml_items_map.price con el price_ml corregido
      // (lista real, viene de original_price de la promo activa). Fix caso
      // ALPCMPRSQ6012: items-sync persistió $19.787 (precio base API ML),
      // pero el lista real era $29.980. ml_items_map.price es leído por
      // varios lectores (item-update, scan-promos, promotions, investigate)
      // y debe reflejar el lista real, no el dato base API potencialmente
      // contaminado por DEALs externos.
      if (promosFetchOk && payload.price_ml) {
        const priceMl = Number(payload.price_ml);
        if (priceMl > 0) {
          const { error: mapErr } = await sb.from("ml_items_map")
            .update({ price: priceMl })
            .eq("item_id", itemId);
          if (mapErr) {
            console.error(`[margin-cache] sync ml_items_map.price ${itemId} failed: ${mapErr.message}`);
          }
        }
      }
      // Solo loguear sync_diff cuando confiamos en el dato. Un fetch fallido
      // de promos NO califica para detectar cambio de precio.
      if (!promosFetchOk) continue;
      const precioNuevo = Number(cr.precio_venta) || 0;
      const precioAnterior = prev?.precio_venta ?? null;
      if (precioNuevo > 0 && precioAnterior != null && precioAnterior !== precioNuevo) {
        priceChangesDetected.push({ item_id: itemId, precio_anterior: precioAnterior, precio_nuevo: precioNuevo });
        await logPriceChange({
          item_id: itemId,
          sku: (cr.sku as string) || null,
          sku_origen: skuOrigenByItemId.get(itemId) ?? null,
          precio: precioNuevo,
          precio_anterior: precioAnterior,
          precio_lista: Number(cr.price_ml) || null,
          promo_pct: (cr.promo_pct as number) ?? null,
          promo_name: (cr.promo_name as string) ?? null,
          fuente: "sync_diff",
          ejecutado_por: "cron_margin_cache",
          contexto: { tiene_promo: cr.tiene_promo === true, promo_type: cr.promo_type ?? null },
        });
      }
    }
  }

  const isFocused = !!(effectiveFilter && effectiveFilter.length > 0);
  const processed = isFocused ? rows.length : offset + rows.length;
  return NextResponse.json({
    processed,
    total: total || 0,
    chunk: rows.length,
    stale_mode: staleMode,
    done: isFocused ? true : processed >= (total || 0),
    price_changes_detected: priceChangesDetected.length,
    price_changes_sample: priceChangesDetected.slice(0, 5),
    promos_fetch_skipped,
  });
}
