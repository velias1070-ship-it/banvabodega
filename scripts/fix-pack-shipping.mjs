/**
 * Fix histórico: re-balancear costo_envio en packs con múltiples órdenes.
 *
 * Flujo:
 *   1) Encuentra order_numbers con >1 order_id distinto (packs).
 *   2) Por cada pack: estima el costo real del envío del pack.
 *      - Para cada order_id del pack: costo_envio × count_rows_del_order_id
 *      - Todos deberían dar el mismo packCostoEnvio (modulo redondeo).
 *   3) Divide packCostoEnvio por el total de rows del pack (= total items).
 *   4) Update cada row con el nuevo costo_envio + recalcula totales.
 *
 * Uso: node scripts/fix-pack-shipping.mjs
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

async function main() {
  console.log("=== Fix pack shipping (re-balance costo_envio) ===");

  // 1. Traer TODAS las ventas (paginado)
  const all = [];
  let offset = 0;
  while (true) {
    const { data } = await sb
      .from("ventas_ml_cache")
      .select("id, order_id, order_number, fecha_date, sku_venta, cantidad, subtotal, comision_total, costo_envio, ingreso_envio, costo_producto, ads_cost_asignado")
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Total filas: ${all.length}`);

  // 2. Agrupar por order_number
  const byOrderNumber = new Map();
  for (const r of all) {
    const k = r.order_number || r.order_id;
    const g = byOrderNumber.get(k) || [];
    g.push(r);
    byOrderNumber.set(k, g);
  }

  // 3. Packs: order_numbers con >1 order_id distinto
  const packs = [];
  for (const [on, rows] of byOrderNumber.entries()) {
    const distinctOrderIds = new Set(rows.map(r => r.order_id));
    if (distinctOrderIds.size > 1) packs.push({ order_number: on, rows });
  }
  console.log(`Packs con múltiples órdenes: ${packs.length}`);

  // 4. Por cada pack, calcular pack_costo y re-balancear
  let totalUpdated = 0;
  let toReport = [];
  for (const pack of packs) {
    // Estimar packCostoEnvio: costo_envio × count_rows_del_order_id, debe ser igual para todas
    const byOrder = new Map();
    for (const r of pack.rows) {
      const g = byOrder.get(r.order_id) || [];
      g.push(r);
      byOrder.set(r.order_id, g);
    }

    // Calcular estimate por cada orden: costo_envio (de cualquier row) × count de esa orden
    const estimates = [];
    for (const [, orderRows] of byOrder.entries()) {
      const env = orderRows[0].costo_envio || 0;
      const count = orderRows.length; // items en esta orden
      estimates.push(env * count);
    }
    // Usar MAX para ser conservador (si hubo inconsistencia, tomamos el más alto)
    const packCostoEnvio = Math.max(...estimates);
    const packItemCount = pack.rows.length;
    const newCostoEnvio = Math.round(packCostoEnvio / packItemCount);

    // Si no cambia nada (ya estaba bien), saltar
    if (pack.rows.every(r => r.costo_envio === newCostoEnvio)) continue;

    // Mismo para ingreso_envio si lo tenía mal (cuando hay bonificación Flex)
    const ingEstimates = [];
    for (const [, orderRows] of byOrder.entries()) {
      const env = orderRows[0].ingreso_envio || 0;
      ingEstimates.push(env * orderRows.length);
    }
    const packIngresoEnvio = Math.max(...ingEstimates);
    const newIngresoEnvio = Math.round(packIngresoEnvio / packItemCount);

    if (toReport.length < 5) {
      toReport.push({
        order_number: pack.order_number,
        rows: pack.rows.length,
        estimatedPackEnvio: packCostoEnvio,
        oldPerRow: pack.rows[0].costo_envio,
        newPerRow: newCostoEnvio,
      });
    }

    // Update cada row
    for (const r of pack.rows) {
      const sub = r.subtotal || 0;
      const com = r.comision_total || 0;
      const cp = r.costo_producto || 0;
      const ads = r.ads_cost_asignado || 0;
      const newTotalNeto = sub - com - newCostoEnvio + newIngresoEnvio;
      const newMargen = newTotalNeto - cp;
      const newMargenPct = sub > 0 ? Math.round((newMargen / sub) * 10000) / 100 : 0;
      const newMargenNeto = newMargen - ads;
      const newMargenNetoPct = sub > 0 ? Math.round((newMargenNeto / sub) * 10000) / 100 : 0;

      const { error } = await sb.from("ventas_ml_cache").update({
        costo_envio: newCostoEnvio,
        ingreso_envio: newIngresoEnvio,
        total_neto: newTotalNeto,
        margen: newMargen,
        margen_pct: newMargenPct,
        margen_neto: newMargenNeto,
        margen_neto_pct: newMargenNetoPct,
      }).eq("id", r.id);
      if (!error) totalUpdated++;
      else console.error(`  fail ${r.id}: ${error.message}`);
    }
  }

  console.log(`\nPacks corregidos (ejemplos primeros 5):`);
  for (const r of toReport) {
    console.log(`  ${r.order_number}  rows=${r.rows}  pack_env=${r.estimatedPackEnvio}  ${r.oldPerRow}→${r.newPerRow}`);
  }
  console.log(`\n=== DONE ===`);
  console.log(`  Packs encontrados:     ${packs.length}`);
  console.log(`  Filas actualizadas:    ${totalUpdated}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
