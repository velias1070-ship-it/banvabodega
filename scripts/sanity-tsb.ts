/**
 * sanity-tsb — corre el cálculo TSB offline contra los datos actuales de
 * Supabase para validar el módulo sin depender de la migración v53.
 *
 * NO escribe nada a la DB. Sólo imprime:
 *   - Cuántos Z con vel_ponderada > 0 quedan dentro del régimen TSB vs SMA.
 *   - Histograma de diferencia absoluta |tsb - sma| como % de sma.
 *   - Top 5 SKUs donde TSB difiere más (para inspección manual).
 *
 * Uso:
 *   tsx scripts/sanity-tsb.ts
 *
 * Requisitos:
 *   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY en el entorno.
 */

import { createClient } from "@supabase/supabase-js";
import { calcularTSB, seleccionarModeloZ } from "../src/lib/tsb";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

const MS_DIA = 86_400_000;

async function paginatedSelect<T>(build: (offset: number, limit: number) => Promise<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const all: T[] = [];
  const size = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await build(offset, size);
    if (error) throw new Error(String(error));
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < size) break;
    offset += size;
  }
  return all;
}

async function main() {
  const hoy = new Date();
  console.log(`sanity-tsb @ ${hoy.toISOString()}`);

  // 1) SKUs Z con vel_ponderada > 0.
  const { data: skusZ, error: eZ } = await sb
    .from("sku_intelligence")
    .select("sku_origen, nombre, abc, cuadrante, xyz, vel_ponderada")
    .eq("xyz", "Z")
    .gt("vel_ponderada", 0);
  if (eZ) throw new Error(eZ.message);
  const zRows = skusZ || [];
  console.log(`SKUs Z con vel>0: ${zRows.length}`);

  // 2) Composicion_venta (principales) + primera venta por sku_venta.
  const [comp, vmc] = await Promise.all([
    paginatedSelect<{ sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string | null }>((o, l) =>
      sb.from("composicion_venta")
        .select("sku_venta, sku_origen, unidades, tipo_relacion")
        .range(o, o + l - 1)
        .returns<{ sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string | null }[]>() as unknown as Promise<{ data: { sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string | null }[] | null; error: unknown }>,
    ),
    paginatedSelect<{ sku_venta: string; fecha_date: string | null; cantidad: number | null; anulada: boolean }>((o, l) =>
      sb.from("ventas_ml_cache")
        .select("sku_venta, fecha_date, cantidad, anulada")
        .gte("fecha_date", "2026-01-01")
        .range(o, o + l - 1)
        .returns<{ sku_venta: string; fecha_date: string | null; cantidad: number | null; anulada: boolean }[]>() as unknown as Promise<{ data: { sku_venta: string; fecha_date: string | null; cantidad: number | null; anulada: boolean }[] | null; error: unknown }>,
    ),
  ]);
  console.log(`Composiciones: ${comp.length}, Ventas: ${vmc.length}`);

  // Mapa sku_venta UPPER → [{so, u}], excluyendo alternativos.
  const compByVenta = new Map<string, { so: string; u: number }[]>();
  for (const c of comp) {
    if (c.tipo_relacion === "alternativo") continue;
    const sv = c.sku_venta.toUpperCase();
    const so = c.sku_origen.toUpperCase();
    const u = Number(c.unidades) || 1;
    if (!compByVenta.has(sv)) compByVenta.set(sv, []);
    const arr = compByVenta.get(sv)!;
    if (!arr.some(e => e.so === so)) arr.push({ so, u });
  }

  // Ventas expandidas a sku_origen + primera venta absoluta.
  const ventasPorSku = new Map<string, { t: number; u: number }[]>();
  const primeraVentaPorSku = new Map<string, Date>();
  for (const v of vmc) {
    if (v.anulada) continue;
    if (!v.fecha_date) continue;
    const comps = compByVenta.get(v.sku_venta.toUpperCase());
    if (!comps) continue;
    const d = new Date(v.fecha_date + "T00:00:00.000Z");
    const qty = Number(v.cantidad) || 0;
    for (const c of comps) {
      if (!ventasPorSku.has(c.so)) ventasPorSku.set(c.so, []);
      ventasPorSku.get(c.so)!.push({ t: d.getTime(), u: qty * c.u });
      const prev = primeraVentaPorSku.get(c.so);
      if (!prev || d < prev) primeraVentaPorSku.set(c.so, d);
    }
  }

  // 3) Para cada SKU Z, armar ventas_semana[9] terminando HOY y correr TSB si corresponde.
  let enTSB = 0, enSMA = 0;
  const diferencias: { sku: string; nombre: string | null; abc: string; cuad: string; sma: number; tsb: number; delta_pct: number; z: number; p: number }[] = [];

  for (const z of zRows) {
    const sku = String(z.sku_origen).toUpperCase();
    const pv = primeraVentaPorSku.get(sku) ?? null;
    const modelo = seleccionarModeloZ({ primera_venta: pv, xyz: "Z" }, hoy);
    if (modelo === "sma_ponderado") { enSMA++; continue; }
    enTSB++;

    const ventas = ventasPorSku.get(sku) || [];
    const hoyMs = hoy.getTime();
    const ventasSemana = new Array(9).fill(0);
    for (const x of ventas) {
      const dias = (hoyMs - x.t) / MS_DIA;
      if (dias < 0 || dias > 63) continue;
      const semIdx = Math.floor(dias / 7);
      if (semIdx >= 0 && semIdx < 9) ventasSemana[semIdx] += x.u;
    }
    // TSB espera ASC (vieja → nueva); ventasSemana[0] = más reciente.
    const ventasAsc = [...ventasSemana].reverse();
    const tsb = calcularTSB(ventasAsc);
    if (!tsb) continue;

    const sma = Number(z.vel_ponderada);
    const deltaPct = sma > 0 ? ((tsb.forecast - sma) / sma) * 100 : (tsb.forecast === 0 ? 0 : 999);
    diferencias.push({
      sku,
      nombre: z.nombre as string | null,
      abc: z.abc as string,
      cuad: z.cuadrante as string,
      sma,
      tsb: tsb.forecast,
      delta_pct: deltaPct,
      z: tsb.z_final,
      p: tsb.p_final,
    });
  }

  console.log(`\nRégimen:`);
  console.log(`  sma_ponderado : ${enSMA}  (bajo puerta 60d o sin primera_venta)`);
  console.log(`  tsb           : ${enTSB}  (maduros)`);

  // Histograma de |delta_pct|.
  const bandas = [
    { label: "|δ| ≤ 5%",   test: (d: number) => Math.abs(d) <= 5 },
    { label: "5-20%",      test: (d: number) => Math.abs(d) > 5 && Math.abs(d) <= 20 },
    { label: "20-50%",     test: (d: number) => Math.abs(d) > 20 && Math.abs(d) <= 50 },
    { label: "50-100%",    test: (d: number) => Math.abs(d) > 50 && Math.abs(d) <= 100 },
    { label: "> 100%",     test: (d: number) => Math.abs(d) > 100 },
  ];
  console.log(`\nDistribución |delta TSB vs SMA|:`);
  for (const b of bandas) {
    const n = diferencias.filter(d => b.test(d.delta_pct)).length;
    console.log(`  ${b.label.padEnd(12)} ${String(n).padStart(4)} SKUs`);
  }
  const diferencias20 = diferencias.filter(d => Math.abs(d.delta_pct) > 20);
  console.log(`\nTotal con |δ| > 20%: ${diferencias20.length} / ${diferencias.length}`);

  // Top 5 por delta_pct absoluto.
  const top5 = [...diferencias].sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct)).slice(0, 5);
  console.log(`\nTop 5 SKUs con mayor diferencia TSB vs SMA:`);
  for (const d of top5) {
    const arrow = d.delta_pct >= 0 ? "↑" : "↓";
    console.log(
      `  ${d.sku.padEnd(18)} ${(d.nombre || "—").slice(0, 30).padEnd(30)} ` +
      `${d.cuad.padEnd(9)} ${d.abc}  ` +
      `SMA=${d.sma.toFixed(2).padStart(6)} TSB=${d.tsb.toFixed(2).padStart(6)} ` +
      `${arrow}${Math.abs(d.delta_pct).toFixed(0)}%  (z=${d.z.toFixed(2)} p=${d.p.toFixed(2)})`,
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
