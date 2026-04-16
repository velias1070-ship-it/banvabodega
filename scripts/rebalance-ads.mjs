/**
 * Recalcula ads_cost_asignado con pro-rata correcto:
 *   ads_por_venta = (cost_neto × 1.19) × (subtotal / Σ subtotal_sku_dia)
 *
 * La suma total de ads para un (item_id, día) cierra exactamente con
 * cost_neto × 1.19 del día. Respeta pro-rata por valor de venta.
 *
 * Ventas sin entry en ml_ads_daily_cache o con cost_neto=0 → ads=0, organic.
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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const IVA = 1.19;

async function main() {
  console.log("=== Rebalance ads_cost_asignado (pro-rata por subtotal) ===");

  // 1. Traer sku → item_id
  const { data: imap } = await sb.from("ml_items_map").select("sku, item_id");
  const skuToItem = new Map(imap.map(r => [r.sku, r.item_id]));
  console.log(`ml_items_map: ${imap.length}`);

  // 2. Traer TODAS las ventas con costo_producto no null (paginado)
  const all = [];
  let offset = 0;
  while (true) {
    const { data } = await sb
      .from("ventas_ml_cache")
      .select("id, sku_venta, fecha_date, subtotal, margen")
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Ventas totales: ${all.length}`);

  // 3. Traer TODO el cache diario
  const cache = [];
  let off2 = 0;
  while (true) {
    const { data } = await sb
      .from("ml_ads_daily_cache")
      .select("item_id, date, cost_neto")
      .range(off2, off2 + 999);
    if (!data || data.length === 0) break;
    cache.push(...data);
    if (data.length < 1000) break;
    off2 += 1000;
  }
  const cacheMap = new Map();
  for (const c of cache) cacheMap.set(`${c.item_id}|${c.date}`, c.cost_neto);
  console.log(`Cache daily rows: ${cache.length}`);

  // 4. Agrupar ventas por (item_id, fecha_date)
  const groups = new Map(); // key = item_id|date → [ventas]
  const sinItemId = [];
  for (const v of all) {
    const itemId = skuToItem.get(v.sku_venta);
    if (!itemId) {
      sinItemId.push(v);
      continue;
    }
    const key = `${itemId}|${v.fecha_date}`;
    const g = groups.get(key) || [];
    g.push(v);
    groups.set(key, g);
  }
  console.log(`Grupos (item_id × día): ${groups.size}`);
  console.log(`Ventas sin item_id en ml_items_map: ${sinItemId.length}`);

  // 5. Recalcular ads por grupo
  const updates = [];
  let statsDirect = 0, statsOrganic = 0, statsSinDatos = 0;

  for (const [key, ventas] of groups.entries()) {
    const costNeto = cacheMap.get(key);
    if (costNeto == null) {
      // No hay data del ad ese día — todas organic con $0
      for (const v of ventas) {
        updates.push({ id: v.id, ads_cost_asignado: 0, ads_atribucion: "sin_datos", margen_neto: v.margen ?? 0, subtotal: v.subtotal });
        statsSinDatos++;
      }
      continue;
    }
    if (costNeto <= 0) {
      for (const v of ventas) {
        updates.push({ id: v.id, ads_cost_asignado: 0, ads_atribucion: "organic", margen_neto: v.margen ?? 0, subtotal: v.subtotal });
        statsOrganic++;
      }
      continue;
    }
    const costConIva = Math.round(costNeto * IVA);
    const totalSub = ventas.reduce((s, v) => s + (v.subtotal || 0), 0);
    if (totalSub <= 0) continue;

    for (const v of ventas) {
      const share = (v.subtotal || 0) / totalSub;
      const ads = Math.round(costConIva * share);
      updates.push({
        id: v.id,
        ads_cost_asignado: ads,
        ads_atribucion: "direct",
        margen_neto: (v.margen ?? 0) - ads,
        subtotal: v.subtotal,
      });
      statsDirect++;
    }
  }
  // Las ventas sin item_id → organic con 0
  for (const v of sinItemId) {
    updates.push({ id: v.id, ads_cost_asignado: 0, ads_atribucion: "sin_datos", margen_neto: v.margen ?? 0, subtotal: v.subtotal });
    statsSinDatos++;
  }

  console.log(`\nDistribución:`);
  console.log(`  direct: ${statsDirect}`);
  console.log(`  organic: ${statsOrganic}`);
  console.log(`  sin_datos: ${statsSinDatos}`);

  // 6. Aplicar updates con pool concurrente + timeout + retry
  console.log(`\nUpdating ${updates.length} ventas (concurrent pool)...`);
  let ok = 0, fail = 0;
  const CONCURRENCY = 15;
  const TIMEOUT_MS = 10000;

  async function doUpdate(u) {
    const sub = u.subtotal || 0;
    const mn = u.margen_neto;
    const mnPct = sub > 0 ? Math.round((mn / sub) * 10000) / 100 : 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const { error } = await sb.from("ventas_ml_cache").update({
          ads_cost_asignado: u.ads_cost_asignado,
          ads_atribucion: u.ads_atribucion,
          margen_neto: mn,
          margen_neto_pct: mnPct,
        }).eq("id", u.id).abortSignal(controller.signal);
        clearTimeout(timeout);
        if (error) { if (attempt === 2) return { ok: false, err: error.message }; continue; }
        return { ok: true };
      } catch (e) {
        clearTimeout(timeout);
        if (attempt === 2) return { ok: false, err: e.message };
      }
    }
    return { ok: false, err: "retries exhausted" };
  }

  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const batch = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(doUpdate));
    for (const r of results) {
      if (r.ok) ok++;
      else { fail++; if (fail <= 5) console.error(`  fail: ${r.err}`); }
    }
    if ((i + CONCURRENCY) % 300 === 0 || i + CONCURRENCY >= updates.length) {
      console.log(`  ${Math.min(i + CONCURRENCY, updates.length)}/${updates.length}`);
    }
  }

  console.log(`\n=== DONE: ${ok} updated, ${fail} failed ===`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
