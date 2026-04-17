/**
 * backfill-forecast-snapshots — reconstruye forecast_snapshots_semanales
 * de hasta 12 semanas para atrás.
 *
 * Estrategia híbrida (opción C del plan PR1/3):
 *   - Para cada lunes L entre hace-12-semanas y el último lunes cerrado:
 *       · Si hay entry en sku_intelligence_history del día L para el SKU → usarla
 *         con origen='real' (vel_* tal como estaba ese día).
 *       · Si no hay entry (caso por defecto: history sólo tiene 2 días de profundidad):
 *         reconstruir vel_7d / vel_30d / vel_60d / vel_ponderada desde
 *         ventas_ml_cache + composicion_venta aplicando las mismas fórmulas
 *         que el motor P2 (intelligence.ts:769-776). Marcar origen='reconstruido'
 *         y en_quiebre=NULL (stock_snapshots no tiene historia suficiente).
 *
 * Uso:
 *   tsx scripts/backfill-forecast-snapshots.ts
 *
 * Requisitos:
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY en el entorno.
 */

import { createClient } from "@supabase/supabase-js";
import { lunesIso, restarSemanas, ultimosNLunesCerrados } from "../src/lib/dates";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

async function main() {
  const hoy = new Date();
  const lunes = ultimosNLunesCerrados(hoy, 12);
  console.log(`Backfill: ${lunes.length} lunes, de ${lunes[0]} a ${lunes[lunes.length - 1]}`);

  // 1) SKUs a reconstruir.
  const { data: skus, error: eS } = await sb.from("sku_intelligence").select("sku_origen, abc, xyz");
  if (eS) throw new Error(eS.message);
  const skuRows = skus || [];
  console.log(`SKUs: ${skuRows.length}`);

  // 2) History disponible (detectar origen='real' cuando aplique).
  const { data: hist } = await sb
    .from("sku_intelligence_history")
    .select("sku_origen, fecha, vel_ponderada, vel_7d, vel_30d, vel_60d, abc, xyz")
    .gte("fecha", lunes[0])
    .lte("fecha", lunes[lunes.length - 1]);
  const histMap = new Map<string, Record<string, unknown>>();
  for (const h of hist || []) histMap.set(`${h.sku_origen}:${h.fecha}`, h);

  // 3) Composición sku_venta → [{sku_origen, unidades}] (principales, no alternativos).
  const { data: comp } = await sb
    .from("composicion_venta")
    .select("sku_venta, sku_origen, unidades, tipo_relacion");
  const compByVenta = new Map<string, { so: string; u: number }[]>();
  for (const c of comp || []) {
    if (c.tipo_relacion === "alternativo") continue;
    const k = String(c.sku_venta).toUpperCase();
    const so = String(c.sku_origen).toUpperCase();
    const u = Number(c.unidades) || 1;
    if (!compByVenta.has(k)) compByVenta.set(k, []);
    const arr = compByVenta.get(k)!;
    if (!arr.some(e => e.so === so)) arr.push({ so, u });
  }

  // 4) Ventas desde hace 12+9 semanas (necesarias para calcular vel_60d del lunes más viejo).
  const inicioFetch = restarSemanas(lunes[0], 9); // 60 días ≈ 8.6 semanas, redondeo al alza
  const { data: ventas } = await sb
    .from("ventas_ml_cache")
    .select("sku_venta, fecha_date, cantidad, anulada")
    .gte("fecha_date", inicioFetch)
    .eq("anulada", false);

  // Mapa sku_origen → [{fecha_ms, uds_fisicas}]
  const ventasPorSku = new Map<string, { t: number; u: number }[]>();
  for (const v of ventas || []) {
    if (!v.fecha_date) continue;
    const t = new Date(v.fecha_date + "T00:00:00.000Z").getTime();
    const comps = compByVenta.get(String(v.sku_venta).toUpperCase());
    if (!comps) continue;
    const qty = Number(v.cantidad) || 0;
    for (const c of comps) {
      if (!ventasPorSku.has(c.so)) ventasPorSku.set(c.so, []);
      ventasPorSku.get(c.so)!.push({ t, u: qty * c.u });
    }
  }

  // 5) Construir filas para cada (sku, lunes).
  const filas: Array<Record<string, unknown>> = [];
  let realCount = 0;
  let reconstruidoCount = 0;

  for (const sku of skuRows) {
    const sko = String(sku.sku_origen);
    const v = ventasPorSku.get(sko) || [];

    for (const L of lunes) {
      const histKey = `${sko}:${L}`;
      const h = histMap.get(histKey);

      if (h) {
        filas.push({
          sku_origen: sko,
          semana_inicio: L,
          vel_ponderada: Number(h.vel_ponderada ?? 0),
          vel_7d: Number(h.vel_7d ?? 0),
          vel_30d: Number(h.vel_30d ?? 0),
          vel_60d: Number(h.vel_60d ?? 0),
          abc: h.abc ?? sku.abc,
          xyz: h.xyz ?? sku.xyz,
          en_quiebre: null, // sin stock_snapshots históricos, null incluso para origen=real-pasado
          origen: "real",
        });
        realCount++;
      } else {
        // Reconstruir con ventanas terminando EN EL DOMINGO anterior al lunes L
        // (es decir, el "as of" del snapshot es el mismo lunes L a las 00:00 UTC).
        const asOfMs = new Date(L + "T00:00:00.000Z").getTime();
        const MS_DIA = 86_400_000;

        let ord7 = 0;
        let ord30 = 0;
        let ord60 = 0;
        for (const x of v) {
          const dias = (asOfMs - x.t) / MS_DIA;
          if (dias < 0) continue; // ventas futuras al L
          if (dias <= 7) ord7 += x.u;
          if (dias <= 30) ord30 += x.u;
          if (dias <= 60) ord60 += x.u;
        }
        const vel7d = ord7; // 7d = 1 semana
        const vel30d = ord30 / 4.3;
        const vel60d = ord60 / 8.6;
        const velPond = 0.5 * vel7d + 0.3 * vel30d + 0.2 * vel60d;

        filas.push({
          sku_origen: sko,
          semana_inicio: L,
          vel_ponderada: velPond,
          vel_7d: vel7d,
          vel_30d: vel30d,
          vel_60d: vel60d,
          abc: sku.abc,
          xyz: sku.xyz,
          en_quiebre: null,
          origen: "reconstruido",
        });
        reconstruidoCount++;
      }
    }
  }

  // 6) Upsert en batches (ignoreDuplicates para ser idempotente si se corre 2 veces).
  let insertadas = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const chunk = filas.slice(i, i + 500);
    const { error, count } = await sb
      .from("forecast_snapshots_semanales")
      .upsert(chunk, { onConflict: "sku_origen,semana_inicio", ignoreDuplicates: true, count: "exact" });
    if (error) throw new Error(error.message);
    insertadas += count ?? 0;
  }

  console.log(`\nBackfill listo:`);
  console.log(`  lunes cubiertos     : ${lunes.length}`);
  console.log(`  SKUs                : ${skuRows.length}`);
  console.log(`  filas candidatas    : ${filas.length}`);
  console.log(`  origen=real         : ${realCount}`);
  console.log(`  origen=reconstruido : ${reconstruidoCount}`);
  console.log(`  filas insertadas    : ${insertadas}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
