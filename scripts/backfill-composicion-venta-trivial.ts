/**
 * backfill-composicion-venta-trivial — PR6c one-time.
 *
 * Inserta fila trivial (sku_venta=X, sku_origen=X, unidades=1,
 * tipo_relacion='componente') en composicion_venta para cada SKU de
 * ml_items_map.activo=true que:
 *   1. tiene fila en productos (sku válido, no ghost)
 *   2. tiene sku_venta === sku (composición trivial, no pack)
 *   3. NO tiene fila previa en composicion_venta como sku_origen
 *
 * Complementa al autoheal inline del paso 5b de syncStockFull, que solo
 * cubría SKUs en la corrida actual. Ver docs/banva-bodega-inteligencia.md §11.
 *
 * Uso:
 *   tsx scripts/backfill-composicion-venta-trivial.ts --dry-run
 *   tsx scripts/backfill-composicion-venta-trivial.ts --apply
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);
const mode = process.argv.includes("--apply") ? "apply" : "dry-run";

interface MimRow { sku: string; sku_venta: string | null; status_ml: string | null }

async function main() {
  console.log(`backfill-composicion-venta-trivial @ ${new Date().toISOString()} mode=${mode}`);

  const { data: mimRows, error: mimErr } = await sb.from("ml_items_map")
    .select("sku, sku_venta, status_ml")
    .eq("activo", true)
    .in("status_ml", ["active", "paused"]);
  if (mimErr) throw new Error(`ml_items_map select: ${mimErr.message}`);

  const skusActivos = Array.from(new Set(
    (mimRows as MimRow[] || [])
      .filter(r => r.sku && r.sku_venta && r.sku === r.sku_venta)
      .map(r => r.sku),
  ));
  console.log(`ml_items_map.activo con sku=sku_venta: ${skusActivos.length}`);

  if (skusActivos.length === 0) return;

  const { data: prodRows, error: prodErr } = await sb.from("productos")
    .select("sku").in("sku", skusActivos);
  if (prodErr) throw new Error(`productos select: ${prodErr.message}`);
  const conProducto = new Set((prodRows || []).map(p => p.sku));
  const sinProducto = skusActivos.filter(s => !conProducto.has(s));
  console.log(`  Con producto válido: ${conProducto.size}`);
  console.log(`  Sin producto (skip — ghost): ${sinProducto.length}`);

  const { data: compRows, error: compErr } = await sb.from("composicion_venta")
    .select("sku_origen").in("sku_origen", skusActivos);
  if (compErr) throw new Error(`composicion_venta select: ${compErr.message}`);
  const conCompo = new Set((compRows || []).map(c => c.sku_origen));

  const aInsertar = skusActivos
    .filter(s => conProducto.has(s) && !conCompo.has(s))
    .map(s => ({ sku_venta: s, sku_origen: s, unidades: 1, tipo_relacion: "componente" }));

  console.log(`Candidatos INSERT trivial: ${aInsertar.length}`);
  for (const r of aInsertar.slice(0, 40)) {
    console.log(`  ${r.sku_origen}`);
  }
  if (aInsertar.length > 40) console.log(`  ... +${aInsertar.length - 40} más`);

  if (mode === "dry-run") {
    console.log("dry-run: no se ejecuta insert. Usar --apply para confirmar.");
    return;
  }

  if (aInsertar.length === 0) {
    console.log("Nada para insertar. Fin.");
    return;
  }

  // Upsert con onConflict="sku_venta,sku_origen" (constraint
  // composicion_venta_sku_venta_sku_origen_key) — inmune a race con el
  // cron sync-stock-full autoheal extendido corriendo en paralelo.
  const { error: insErr, count } = await sb.from("composicion_venta")
    .upsert(aInsertar, { onConflict: "sku_venta,sku_origen", count: "exact" });
  if (insErr) {
    console.error(`upsert error: ${insErr.message}`);
    process.exit(1);
  }
  const inserted = count ?? aInsertar.length;
  console.log(`Aplicado: ${inserted} filas upserted`);

  await sb.from("audit_log").insert({
    accion: "composicion_venta:backfill_composicion_trivial_pr6c",
    params: {
      motivo: "backfill_composicion_trivial_pr6c",
      skus_activos: skusActivos.length,
      con_producto: conProducto.size,
      sin_producto: sinProducto.length,
      ya_con_compo: conCompo.size,
      inserted,
      sample: aInsertar.slice(0, 15).map(r => r.sku_origen),
    },
  });
  console.log("audit_log escrito.");
}

main().catch(err => { console.error(err); process.exit(1); });
