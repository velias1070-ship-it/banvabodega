/**
 * Backfill de ml_ads_daily_cache + ads_cost_asignado en ventas_ml_cache.
 *
 * Flujo:
 *   1) Lee distinct item_ids vendidos en ventas_ml_cache
 *   2) Para cada item, fetch /advertising/MLC/product_ads/ads/{item_id}
 *      con aggregation_type=DAILY para un rango amplio (últimos 90d)
 *   3) Upsertea cada row en ml_ads_daily_cache
 *   4) Recalcula ads_cost_asignado y margen_neto para cada venta usando el cache
 *
 * Uso: node scripts/backfill-ads-cache.mjs
 *
 * Requiere NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.local
 * y un access token válido en ml_config.id=main.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
  .split("\n")
  .filter(l => l && !l.startsWith("#") && l.includes("="))
  .reduce((acc, l) => {
    const i = l.indexOf("=");
    acc[l.slice(0, i)] = l.slice(i + 1).trim();
    return acc;
  }, {});

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const sb = createClient(SUPA_URL, SUPA_KEY);

const ML_API = "https://api.mercadolibre.com";
const SITE_ID = "MLC";
const IVA = 1.19;
const METRICS = "clicks,cost,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,units_quantity,organic_units_quantity,organic_units_amount,acos";

async function getAccessToken() {
  const { data } = await sb.from("ml_config").select("access_token").eq("id", "main").limit(1);
  if (!data?.[0]?.access_token) throw new Error("No access_token en ml_config");
  return data[0].access_token;
}

async function mlGetDailyAds(token, itemId, dateFrom, dateTo) {
  const url =
    `${ML_API}/advertising/${SITE_ID}/product_ads/ads/${itemId}` +
    `?date_from=${dateFrom}&date_to=${dateTo}&metrics=${METRICS}&aggregation_type=DAILY`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "api-version": "2" },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.results || [];
}

function r(n) { return Math.round(n || 0); }

async function main() {
  console.log("=== Backfill ads daily cache + ventas ===");

  const token = await getAccessToken();
  console.log("Token OK");

  // 1. Distinct item_ids con ventas en los últimos 89 días (ML rechaza >= 90d).
  const today = new Date();
  const d89 = new Date(today);
  d89.setDate(d89.getDate() - 89);
  const dateFrom = d89.toISOString().slice(0, 10);
  const dateTo = today.toISOString().slice(0, 10);

  // Necesitamos el item_id que está en ml_items_map
  const { data: imap } = await sb.from("ml_items_map").select("sku, item_id");
  const skuToItemId = new Map(imap.map(r => [r.sku, r.item_id]));
  console.log(`ml_items_map: ${imap.length} sku→item_id`);

  // Traer ventas en rango que tengan un item_id resoluble
  let allVentas = [];
  let offset = 0;
  while (true) {
    const { data } = await sb
      .from("ventas_ml_cache")
      .select("id, order_id, sku_venta, fecha_date, subtotal, total_neto, costo_producto, margen")
      .gte("fecha_date", dateFrom)
      .lte("fecha_date", dateTo)
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    allVentas.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Ventas 90d: ${allVentas.length}`);

  // Resolver item_id
  const ventasConItem = allVentas
    .map(v => ({ ...v, item_id: skuToItemId.get(v.sku_venta) || null }))
    .filter(v => v.item_id);
  console.log(`Ventas con item_id: ${ventasConItem.length}`);

  // Distinct item_ids
  const itemIds = Array.from(new Set(ventasConItem.map(v => v.item_id)));
  console.log(`Item_ids distintos a consultar: ${itemIds.length}`);

  // 2. Fetch daily por item (en ventana única de 90d)
  const cacheRows = [];
  let fetched = 0, fetchFails = 0;
  for (const itemId of itemIds) {
    try {
      const rows = await mlGetDailyAds(token, itemId, dateFrom, dateTo);
      for (const r of rows) {
        cacheRows.push({
          item_id: itemId,
          date: r.date,
          cost_neto: Math.round(r.cost || 0),
          clicks: r.clicks || 0,
          prints: r.prints || 0,
          direct_amount: Math.round(r.direct_amount || 0),
          direct_units: r.direct_units_quantity || 0,
          indirect_amount: Math.round(r.indirect_amount || 0),
          indirect_units: r.indirect_units_quantity || 0,
          organic_amount: Math.round(r.organic_units_amount || 0),
          organic_units: r.organic_units_quantity || 0,
          total_amount: Math.round(r.total_amount || 0),
          acos: r.acos || 0,
          synced_at: new Date().toISOString(),
        });
      }
      fetched++;
      if (fetched % 20 === 0) console.log(`  API: ${fetched}/${itemIds.length}`);
      await new Promise(r => setTimeout(r, 80)); // rate limit cortesía
    } catch (err) {
      fetchFails++;
      if (fetchFails <= 5) console.error(`  ✗ ${itemId}: ${err.message}`);
    }
  }
  console.log(`\nFetched ${fetched}/${itemIds.length} items, ${fetchFails} fails, ${cacheRows.length} daily rows`);

  // 3. Upsert cache en batches
  console.log("\nUpsert cache en batches de 500...");
  for (let i = 0; i < cacheRows.length; i += 500) {
    const chunk = cacheRows.slice(i, i + 500);
    const { error } = await sb.from("ml_ads_daily_cache").upsert(chunk, { onConflict: "item_id,date" });
    if (error) console.error(`  upsert batch ${i}: ${error.message}`);
  }
  console.log(`Cache upserted: ${cacheRows.length} rows`);

  // 4. Map para lookup rápido
  const byKey = new Map();
  for (const r of cacheRows) byKey.set(`${r.item_id}|${r.date}`, r);

  // 5. Calcular ads_cost_asignado + margen_neto para cada venta
  console.log(`\nCalculando ads + margen_neto para ${ventasConItem.length} ventas...`);
  const updates = [];
  const stats = { direct: 0, organic: 0, sin_datos: 0 };
  for (const v of ventasConItem) {
    const key = `${v.item_id}|${v.fecha_date}`;
    const row = byKey.get(key);
    let ads = 0;
    let atrib = "sin_datos";

    if (row && row.cost_neto > 0 && row.direct_amount > 0 && v.subtotal <= row.direct_amount) {
      const share = v.subtotal / row.direct_amount;
      ads = Math.round(row.cost_neto * IVA * share);
      atrib = "direct";
    } else if (row) {
      atrib = "organic";
    }
    stats[atrib]++;

    const margenBruto = v.margen ?? ((v.total_neto || 0) - (v.costo_producto || 0));
    const margenNeto = margenBruto - ads;
    const margenNetoPct =
      (v.subtotal || 0) > 0 ? Math.round((margenNeto / v.subtotal) * 10000) / 100 : 0;

    updates.push({
      id: v.id,
      ads_cost_asignado: ads,
      ads_atribucion: atrib,
      margen_neto: margenNeto,
      margen_neto_pct: margenNetoPct,
    });
  }
  console.log(`Distribución: direct=${stats.direct}  organic=${stats.organic}  sin_datos=${stats.sin_datos}`);

  // 6. Update ventas en batches
  console.log("\nActualizando ventas en batches...");
  let ok = 0, fail = 0;
  for (const u of updates) {
    const { error } = await sb
      .from("ventas_ml_cache")
      .update({
        ads_cost_asignado: u.ads_cost_asignado,
        ads_atribucion: u.ads_atribucion,
        margen_neto: u.margen_neto,
        margen_neto_pct: u.margen_neto_pct,
      })
      .eq("id", u.id);
    if (error) {
      fail++;
      if (fail <= 3) console.error(`  fail ${u.id}: ${error.message}`);
    } else {
      ok++;
      if (ok % 500 === 0) console.log(`  ${ok}/${updates.length}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`  Cache rows:      ${cacheRows.length}`);
  console.log(`  Ventas updated:  ${ok} (${fail} fails)`);
  console.log(`  Attribution:     direct=${stats.direct} organic=${stats.organic} sin_datos=${stats.sin_datos}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
