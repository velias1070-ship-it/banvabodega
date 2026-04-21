/**
 * backfill-columna-zombi-stock-full — PR6b-pivot-I.
 *
 * Baja a 0 la columna `ml_items_map.stock_full_cache` en los SKUs donde la
 * tabla canónica `stock_full_cache` dice cantidad=0 (o no existe fila) pero
 * la columna sigue con valor > 0 (zombi heredado antes del fix del
 * stale_cleanup).
 *
 * Criterio:
 *   mim.stock_full_cache > 0
 *   AND (sfc.cantidad IS NULL OR sfc.cantidad = 0)
 *
 * Solo toca la columna zombi (no toca la tabla ni datos de sku_intelligence).
 * Deja rastro en audit_log con motivo 'manual_cleanup_pr6b_pivot_I_columna_zombi'.
 *
 * Uso:
 *   tsx scripts/backfill-columna-zombi-stock-full.ts --dry-run
 *   tsx scripts/backfill-columna-zombi-stock-full.ts --apply
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

interface MimRow { id: string; sku: string; sku_venta: string | null; stock_full_cache: number | null }
interface SfcRow { sku_venta: string; cantidad: number }

async function main() {
  console.log(`backfill-columna-zombi-stock-full @ ${new Date().toISOString()} mode=${mode}`);

  // 1. Leer TODOS los mim rows activos con columna > 0
  const { data: mimRows, error: mimErr } = await sb.from("ml_items_map")
    .select("id, sku, sku_venta, stock_full_cache")
    .eq("activo", true)
    .gt("stock_full_cache", 0);
  if (mimErr) throw new Error(`ml_items_map select: ${mimErr.message}`);

  const rows = (mimRows || []) as MimRow[];
  if (rows.length === 0) {
    console.log("No hay filas con stock_full_cache>0. Nada para hacer.");
    return;
  }
  console.log(`Candidatos (mim.stock_full_cache > 0): ${rows.length}`);

  // 2. Leer tabla canónica para esos sku_venta
  const skuVentas = Array.from(new Set(rows.map(r => r.sku_venta || r.sku).filter(Boolean)));
  const sfcByKey = new Map<string, number>();
  for (let i = 0; i < skuVentas.length; i += 500) {
    const batch = skuVentas.slice(i, i + 500);
    const { data, error } = await sb.from("stock_full_cache")
      .select("sku_venta, cantidad")
      .in("sku_venta", batch);
    if (error) throw new Error(`stock_full_cache select chunk=${i}: ${error.message}`);
    for (const r of (data || []) as SfcRow[]) sfcByKey.set(r.sku_venta, r.cantidad);
  }

  // 3. Identificar zombis: col>0 pero tabla=0 (o sin fila)
  const zombis = rows.filter(r => {
    const key = r.sku_venta || r.sku;
    const tabla = sfcByKey.get(key) ?? 0;
    return tabla === 0;
  });

  console.log(`Zombis a limpiar (col>0 && tabla=0): ${zombis.length}`);
  for (const z of zombis.slice(0, 30)) {
    console.log(`  ${z.sku} / ${z.sku_venta || "(sin sku_venta)"} — col=${z.stock_full_cache}`);
  }
  if (zombis.length > 30) console.log(`  ... +${zombis.length - 30} más`);

  if (mode === "dry-run") {
    console.log("dry-run: no se ejecuta update. Usar --apply para confirmar.");
    return;
  }

  // 4. Apply: update en chunks
  const ids = zombis.map(z => z.id);
  let updated = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { error } = await sb.from("ml_items_map")
      .update({ stock_full_cache: 0, cache_updated_at: new Date().toISOString() })
      .in("id", batch);
    if (error) {
      console.error(`update chunk=${i}: ${error.message}`);
      continue;
    }
    updated += batch.length;
  }
  console.log(`Aplicado: ${updated}/${zombis.length} filas actualizadas`);

  // 5. Audit trail
  await sb.from("audit_log").insert({
    accion: "stock_sync:manual_cleanup_pr6b_pivot_I_columna_zombi",
    params: {
      motivo: "manual_cleanup_pr6b_pivot_I_columna_zombi",
      candidatos: rows.length,
      zombis: zombis.length,
      updated,
      sample: zombis.slice(0, 10).map(z => ({ sku: z.sku, col: z.stock_full_cache })),
    },
  });
  console.log("audit_log escrito.");
}

main().catch(err => { console.error(err); process.exit(1); });
