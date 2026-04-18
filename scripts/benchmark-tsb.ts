/**
 * benchmark-tsb — compara TSB vs SMA ponderado retroactivo sobre 4 lunes
 * evaluables y produce un veredicto objetivo para Fase C.
 *
 * 4 criterios duros — TSB se activa sólo si pasa LOS 4:
 *
 *   1. WMAPE mediano SMA vs TSB mejora ≥ 15 % absoluto sobre los SKUs Z maduros.
 *   2. Cero regresión en SKUs ESTRELLA o CASHCOW clasificados como Z (ningún
 *      SKU de esos cuadrantes puede empeorar WMAPE con TSB).
 *   3. Bias mediano TSB (normalizado por vel_ponderada) > −20 %.
 *   4. Sanity low-velocity: < 10 % del grupo puede tener `SMA<0.5 AND TSB>3`.
 *
 * Input:
 *   - 4 lunes evaluables: 2026-03-09, 2026-03-16, 2026-03-23, 2026-03-30.
 *   - SKUs Z maduros (xyz='Z' con primera_venta ≥ 60 días antes del lunes
 *     evaluado — se re-aplica la puerta por lunes, no una sola vez).
 *   - Historia de ventas hasta el lunes evaluado (sin filtrar por futuro).
 *   - `forecast_snapshots_semanales.vel_ponderada` como SMA persistido.
 *
 * Filtros:
 *   - `ventas_ml_cache.anulada=false`.
 *   - `composicion_venta` principales (no alternativos).
 *   - Semanas reconstruidas (`en_quiebre=NULL`) se INCLUYEN con disclaimer —
 *     la alternativa sería 0 pares evaluables.
 *   - Mínimo 2 semanas con venta real (actual > 0) para incluir el SKU.
 *   - Pares con actual=0 cuentan para "semanas evaluadas" pero no inflan WMAPE.
 *
 * Output: imprime 7 secciones y guarda reporte en
 *   docs/banva-bodega-tsb-benchmark-YYYY-MM-DD.md
 *
 * Uso:
 *   tsx scripts/benchmark-tsb.ts
 */

import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { calcularTSB } from "../src/lib/tsb";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

const MS_DIA = 86_400_000;
const LUNES_EVALUABLES = ["2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30"];
const MIN_SEMANAS_CON_VENTA = 2;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function paginatedSelect<T extends Record<string, unknown>>(
  tbl: string,
  cols: string,
  filters?: (q: ReturnType<typeof sb.from>) => ReturnType<typeof sb.from>,
): Promise<T[]> {
  const all: T[] = [];
  const size = 1000;
  let offset = 0;
  while (true) {
    let q = sb.from(tbl).select(cols).range(offset, offset + size - 1);
    if (filters) q = filters(q) as typeof q;
    const { data, error } = await q;
    if (error) throw new Error(`${tbl}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < size) break;
    offset += size;
  }
  return all;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number, d = 2): string {
  return n.toFixed(d);
}

// ─── Load data ──────────────────────────────────────────────────────────────

interface RawSku {
  sku_origen: string;
  nombre: string | null;
  abc: string;
  cuadrante: string;
  xyz: string;
  vel_ponderada: number | null;
}

async function main() {
  const ahora = new Date();
  console.log(`═══ BENCHMARK TSB RETROACTIVO ═══`);
  console.log(`Fecha: ${ahora.toISOString()}`);

  // 1) SKUs Z con vel > 0.
  const skus = await paginatedSelect<RawSku>(
    "sku_intelligence",
    "sku_origen, nombre, abc, cuadrante, xyz, vel_ponderada",
    (q) => (q.eq("xyz", "Z") as any).gt("vel_ponderada", 0), // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  // 2) Composiciones principales.
  type RawComp = { sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string | null };
  const comp = await paginatedSelect<RawComp>(
    "composicion_venta",
    "sku_venta, sku_origen, unidades, tipo_relacion",
  );
  const compByVenta = new Map<string, { so: string; u: number }[]>();
  for (const c of comp) {
    if (c.tipo_relacion === "alternativo") continue;
    const sv = c.sku_venta.toUpperCase();
    const so = c.sku_origen.toUpperCase();
    const u = Number(c.unidades) || 1;
    if (!compByVenta.has(sv)) compByVenta.set(sv, []);
    const arr = compByVenta.get(sv)!;
    if (!arr.some((e) => e.so === so)) arr.push({ so, u });
  }

  // 3) Ventas desde hace 200 días (cubre 60d warmup para el lunes más viejo +
  //    los 4 lunes + semana siguiente de cada uno).
  type RawVmc = { sku_venta: string; fecha_date: string | null; cantidad: number | null; anulada: boolean };
  const desdeVentas = "2025-09-09"; // > 180 días antes del 2026-03-09
  const vmc = await paginatedSelect<RawVmc>(
    "ventas_ml_cache",
    "sku_venta, fecha_date, cantidad, anulada",
    (q) => q.gte("fecha_date", desdeVentas).eq("anulada", false),
  );

  // Expand sku_venta → sku_origen + compute primera_venta por sku_origen.
  const ventasPorSku = new Map<string, { t: number; u: number }[]>();
  const primeraVentaPorSku = new Map<string, Date>();
  for (const v of vmc) {
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

  // 4) Forecasts SMA persistidos para los 4 lunes.
  type RawFs = { sku_origen: string; semana_inicio: string; vel_ponderada: number; en_quiebre: boolean | null };
  const fs = await paginatedSelect<RawFs>(
    "forecast_snapshots_semanales",
    "sku_origen, semana_inicio, vel_ponderada, en_quiebre",
    (q) => q.in("semana_inicio", LUNES_EVALUABLES),
  );
  const smaPorSkuLunes = new Map<string, Map<string, { vel: number; en_quiebre: boolean | null }>>();
  for (const r of fs) {
    const k = r.sku_origen;
    if (!smaPorSkuLunes.has(k)) smaPorSkuLunes.set(k, new Map());
    smaPorSkuLunes.get(k)!.set(r.semana_inicio, {
      vel: Number(r.vel_ponderada) || 0,
      en_quiebre: r.en_quiebre,
    });
  }

  // ─── Evaluate each (sku, lunes) par ────────────────────────────────────────

  interface Par {
    sku_origen: string;
    nombre: string | null;
    abc: string;
    cuadrante: string;
    vel_ponderada: number;
    lunes: string;
    sma: number;
    tsb: number;
    actual: number;
    err_sma: number;
    err_tsb: number;
    en_quiebre_nulo: boolean;
  }

  const pares: Par[] = [];
  const descartados = { por_puerta: 0, por_tsb_null: 0, por_sin_sma: 0 };

  for (const s of skus) {
    const sku = s.sku_origen.toUpperCase();
    const pv = primeraVentaPorSku.get(sku);
    const ventas = ventasPorSku.get(sku) || [];

    for (const lunesIso of LUNES_EVALUABLES) {
      const lunesMs = new Date(lunesIso + "T00:00:00.000Z").getTime();

      // Puerta anti-ramp-up: aplicada al lunes evaluado.
      if (!pv) { descartados.por_puerta++; continue; }
      const diasDesde = (lunesMs - pv.getTime()) / MS_DIA;
      if (diasDesde < 60) { descartados.por_puerta++; continue; }

      // Construir ventas_semana[9] terminando en el lunes (exclusive).
      // semIdx=0 es la semana [lunes-7d, lunes); semIdx=8 es [lunes-63d, lunes-56d).
      const ventasSemana = new Array(9).fill(0);
      for (const x of ventas) {
        const diffMs = lunesMs - x.t;
        if (diffMs < 0) continue; // futuro al lunes
        const semIdx = Math.floor(diffMs / (7 * MS_DIA));
        if (semIdx >= 0 && semIdx < 9) ventasSemana[semIdx] += x.u;
      }
      const ventasAsc = [...ventasSemana].reverse();
      const tsbRes = calcularTSB(ventasAsc);
      if (!tsbRes) { descartados.por_tsb_null++; continue; }

      // Actual: ventas de la semana [lunes, lunes+7d).
      let actual = 0;
      const finSemana = lunesMs + 7 * MS_DIA;
      for (const x of ventas) {
        if (x.t >= lunesMs && x.t < finSemana) actual += x.u;
      }

      // SMA persistido.
      const smaEntry = smaPorSkuLunes.get(sku)?.get(lunesIso);
      if (!smaEntry) { descartados.por_sin_sma++; continue; }

      pares.push({
        sku_origen: sku,
        nombre: s.nombre,
        abc: s.abc,
        cuadrante: s.cuadrante,
        vel_ponderada: Number(s.vel_ponderada) || 0,
        lunes: lunesIso,
        sma: smaEntry.vel,
        tsb: tsbRes.forecast,
        actual,
        err_sma: actual - smaEntry.vel,
        err_tsb: actual - tsbRes.forecast,
        en_quiebre_nulo: smaEntry.en_quiebre === null,
      });
    }
  }

  // ─── Aggregate per SKU ─────────────────────────────────────────────────────

  interface SkuMetrica {
    sku_origen: string;
    nombre: string | null;
    abc: string;
    cuadrante: string;
    vel_ponderada: number;
    n: number;
    semanas_con_venta: number;
    sum_actual: number;
    sum_abs_err_sma: number;
    sum_abs_err_tsb: number;
    sum_err_tsb: number;
    wmape_sma: number | null;
    wmape_tsb: number | null;
    bias_tsb: number; // bias absoluto
    bias_tsb_rel: number | null; // bias / vel_ponderada
    sma_ultimo: number;
    tsb_ultimo: number;
  }

  const porSku = new Map<string, Par[]>();
  for (const p of pares) {
    if (!porSku.has(p.sku_origen)) porSku.set(p.sku_origen, []);
    porSku.get(p.sku_origen)!.push(p);
  }

  const metricas: SkuMetrica[] = [];
  for (const [, ps] of porSku) {
    const semanasConVenta = ps.filter((p) => p.actual > 0).length;
    if (semanasConVenta < MIN_SEMANAS_CON_VENTA) continue;
    const sumActual = ps.reduce((s, p) => s + p.actual, 0);
    const sumAbsErrSma = ps.reduce((s, p) => s + Math.abs(p.err_sma), 0);
    const sumAbsErrTsb = ps.reduce((s, p) => s + Math.abs(p.err_tsb), 0);
    const sumErrTsb = ps.reduce((s, p) => s + p.err_tsb, 0);
    const vel = ps[0].vel_ponderada;
    const wmapeSma = sumActual > 0 ? sumAbsErrSma / sumActual : null;
    const wmapeTsb = sumActual > 0 ? sumAbsErrTsb / sumActual : null;
    const biasTsb = sumErrTsb / ps.length;
    const biasTsbRel = vel > 0 ? biasTsb / vel : null;
    // Último par ordenado por lunes.
    const psSorted = [...ps].sort((a, b) => (a.lunes < b.lunes ? 1 : -1));
    metricas.push({
      sku_origen: ps[0].sku_origen,
      nombre: ps[0].nombre,
      abc: ps[0].abc,
      cuadrante: ps[0].cuadrante,
      vel_ponderada: vel,
      n: ps.length,
      semanas_con_venta: semanasConVenta,
      sum_actual: sumActual,
      sum_abs_err_sma: sumAbsErrSma,
      sum_abs_err_tsb: sumAbsErrTsb,
      sum_err_tsb: sumErrTsb,
      wmape_sma: wmapeSma,
      wmape_tsb: wmapeTsb,
      bias_tsb: biasTsb,
      bias_tsb_rel: biasTsbRel,
      sma_ultimo: psSorted[0].sma,
      tsb_ultimo: psSorted[0].tsb,
    });
  }

  // ─── Criterios ─────────────────────────────────────────────────────────────

  const evaluables = metricas.filter((m) => m.wmape_sma !== null && m.wmape_tsb !== null);

  // Criterio 1: WMAPE mediano
  const wmapeSmaMed = median(evaluables.map((m) => m.wmape_sma as number));
  const wmapeTsbMed = median(evaluables.map((m) => m.wmape_tsb as number));
  const deltaMed = wmapeSmaMed - wmapeTsbMed;
  const crit1 = deltaMed >= 0.15;

  // Criterio 2: regresión en ESTRELLA/CASHCOW-Z
  const estrellaCashcow = evaluables.filter(
    (m) => m.cuadrante === "ESTRELLA" || m.cuadrante === "CASHCOW",
  );
  const regresiones = estrellaCashcow.filter(
    (m) => (m.wmape_tsb as number) > (m.wmape_sma as number),
  );
  const crit2 = regresiones.length === 0;

  // Criterio 3: bias mediano TSB (relativo a vel_ponderada)
  const biasRelativos = evaluables
    .filter((m) => m.bias_tsb_rel !== null)
    .map((m) => m.bias_tsb_rel as number);
  const biasMed = median(biasRelativos);
  const crit3 = biasMed > -0.20;

  // Criterio 4: SMA<0.5 y TSB>3
  const lowVelDisparatados = evaluables.filter(
    (m) => m.sma_ultimo < 0.5 && m.tsb_ultimo > 3,
  );
  const crit4Pct = evaluables.length > 0 ? lowVelDisparatados.length / evaluables.length : 0;
  const crit4 = crit4Pct < 0.10;

  const veredicto = crit1 && crit2 && crit3 && crit4;

  // ─── Breakdown by cuadrante ────────────────────────────────────────────────

  const cuadrantes = ["ESTRELLA", "CASHCOW", "VOLUMEN", "REVISAR"];
  interface PorCuad {
    cuad: string;
    n: number;
    wmape_sma: number;
    wmape_tsb: number;
    delta: number;
    gana: "TSB" | "SMA" | "—";
  }
  const porCuadrante: PorCuad[] = cuadrantes.map((c) => {
    const ms = evaluables.filter((m) => m.cuadrante === c);
    if (ms.length === 0) return { cuad: c, n: 0, wmape_sma: 0, wmape_tsb: 0, delta: 0, gana: "—" };
    const ws = median(ms.map((m) => m.wmape_sma as number));
    const wt = median(ms.map((m) => m.wmape_tsb as number));
    const d = ws - wt;
    return {
      cuad: c,
      n: ms.length,
      wmape_sma: ws,
      wmape_tsb: wt,
      delta: d,
      gana: Math.abs(d) < 0.01 ? "—" : d > 0 ? "TSB" : "SMA",
    };
  });

  // ─── Top 10 gana / pierde ──────────────────────────────────────────────────

  const conDelta = evaluables.map((m) => ({
    ...m,
    delta_wmape: (m.wmape_sma as number) - (m.wmape_tsb as number),
  }));
  const topGana = [...conDelta].sort((a, b) => b.delta_wmape - a.delta_wmape).slice(0, 10);
  const topPierde = [...conDelta].sort((a, b) => a.delta_wmape - b.delta_wmape).slice(0, 10);

  // ─── Histograma ────────────────────────────────────────────────────────────

  const buckets: { label: string; n: number }[] = [
    { label: "Δ ≤ −50%", n: 0 },
    { label: "−50% a −30%", n: 0 },
    { label: "−30% a −10%", n: 0 },
    { label: "−10% a +10%", n: 0 },
    { label: "+10% a +30%", n: 0 },
    { label: "+30% a +50%", n: 0 },
    { label: "Δ ≥ +50%", n: 0 },
  ];
  for (const m of conDelta) {
    const d = m.delta_wmape * 100;
    if (d < -50) buckets[0].n++;
    else if (d < -30) buckets[1].n++;
    else if (d < -10) buckets[2].n++;
    else if (d <= 10) buckets[3].n++;
    else if (d <= 30) buckets[4].n++;
    else if (d <= 50) buckets[5].n++;
    else buckets[6].n++;
  }

  // ─── Print output ──────────────────────────────────────────────────────────

  const lines: string[] = [];
  const out = (s: string) => { console.log(s); lines.push(s); };

  out(`SKUs evaluados: ${skus.length}`);
  out(`Lunes evaluados: ${LUNES_EVALUABLES.join(", ")}`);
  out(`Pares (SKU, lunes) totales: ${skus.length * LUNES_EVALUABLES.length}`);
  out(`Pares generados: ${pares.length}  (descartados: ${JSON.stringify(descartados)})`);
  out(`SKUs con ≥${MIN_SEMANAS_CON_VENTA} semanas con venta: ${metricas.length}`);
  out(`SKUs evaluables (WMAPE calculable): ${evaluables.length}`);
  const nNulo = pares.filter((p) => p.en_quiebre_nulo).length;
  out(`Pares con en_quiebre=NULL (reconstruidos PR1): ${nNulo}/${pares.length} — incluidos (todos son reconstruidos; el criterio "sólo en_quiebre=false" queda desactivado hasta tener datos reales)`);
  out(``);
  out(`═══ CRITERIOS ═══`);
  out(`Criterio 1: WMAPE mediano SMA=${fmtPct(wmapeSmaMed)} vs TSB=${fmtPct(wmapeTsbMed)} → Δ=${fmtPct(deltaMed)} [${crit1 ? "PASA" : "FALLA"}]`);
  out(`Criterio 2: Regresión en ESTRELLA/CASHCOW-Z: ${regresiones.length}/${estrellaCashcow.length} SKUs empeoran → [${crit2 ? "PASA" : "FALLA"}]`);
  out(`Criterio 3: Bias TSB mediano = ${fmtPct(biasMed)} de vel_ponderada → [${crit3 ? "PASA" : "FALLA"}]`);
  out(`Criterio 4: SKUs con SMA<0.5 y TSB>3: ${lowVelDisparatados.length}/${evaluables.length} (${fmtPct(crit4Pct)}) → [${crit4 ? "PASA" : "FALLA"}]`);
  out(``);
  out(`VEREDICTO: TSB ${veredicto ? "✅ PASA" : "❌ NO PASA"}`);
  const falladas: string[] = [];
  if (!crit1) falladas.push("#1 (mejora WMAPE insuficiente)");
  if (!crit2) falladas.push("#2 (regresiones en ESTRELLA/CASHCOW)");
  if (!crit3) falladas.push("#3 (bias negativo)");
  if (!crit4) falladas.push("#4 (disparate low-velocity)");
  if (falladas.length > 0) out(`  Falla(n): ${falladas.join(", ")}`);
  out(``);
  out(`═══ DESGLOSE POR CUADRANTE (solo Z) ═══`);
  out(`Cuadrante       n    SMA_wmape  TSB_wmape  Δ         Gana`);
  out(`─────────       ──   ─────────  ─────────  ────      ────`);
  for (const p of porCuadrante) {
    if (p.n === 0) {
      out(`${(p.cuad + "-Z").padEnd(16)}${String(p.n).padStart(3)}    —          —          —         —`);
      continue;
    }
    out(
      `${(p.cuad + "-Z").padEnd(16)}${String(p.n).padStart(3)}    ${fmtPct(p.wmape_sma).padStart(8)}   ${fmtPct(p.wmape_tsb).padStart(8)}   ${p.delta >= 0 ? "−" : "+"}${fmtPct(Math.abs(p.delta)).padStart(6)}   ${p.gana}`,
    );
  }
  out(``);
  out(`═══ TOP 10 TSB GANA (Δ WMAPE DESC) ═══`);
  out(`SKU                Nombre                           Cuadrante  n  SMA%   TSB%   Δ`);
  for (const m of topGana) {
    out(
      `${m.sku_origen.padEnd(18)} ${(m.nombre || "—").slice(0, 30).padEnd(30)}  ${m.cuadrante.padEnd(9)} ${String(m.n).padStart(1)}  ${fmtPct(m.wmape_sma as number).padStart(5)}  ${fmtPct(m.wmape_tsb as number).padStart(5)}  ${m.delta_wmape >= 0 ? "+" : ""}${fmtPct(m.delta_wmape)}`,
    );
  }
  out(``);
  out(`═══ TOP 10 TSB PIERDE (Δ WMAPE ASC) ═══`);
  out(`SKU                Nombre                           Cuadrante  n  SMA%   TSB%   Δ`);
  for (const m of topPierde) {
    out(
      `${m.sku_origen.padEnd(18)} ${(m.nombre || "—").slice(0, 30).padEnd(30)}  ${m.cuadrante.padEnd(9)} ${String(m.n).padStart(1)}  ${fmtPct(m.wmape_sma as number).padStart(5)}  ${fmtPct(m.wmape_tsb as number).padStart(5)}  ${m.delta_wmape >= 0 ? "+" : ""}${fmtPct(m.delta_wmape)}`,
    );
  }
  out(``);
  out(`═══ DISTRIBUCIÓN Δ (WMAPE_SMA − WMAPE_TSB) ═══`);
  const maxN = Math.max(...buckets.map((b) => b.n), 1);
  for (const b of buckets) {
    const barLen = Math.round((b.n / maxN) * 30);
    const bar = "█".repeat(barLen).padEnd(30);
    out(`${b.label.padEnd(14)} │ ${bar} (n=${b.n})`);
  }

  // ─── Recomendación textual ─────────────────────────────────────────────────

  let recomendacion = "";
  if (veredicto) {
    recomendacion = `✅ TSB pasó los 4 criterios. Recomendado activar como default para clase Z en Fase C. Revertir es simple: flag booleano ${'`'}usar_tsb${'`'} con default false.`;
  } else {
    const notas: string[] = [];
    if (!crit1) notas.push(`**Mejora WMAPE insuficiente (Δ=${fmtPct(deltaMed)}, necesita ≥15%)**: TSB no es suficientemente mejor que SMA en mediana. Probar ajustar grid α/β, o evaluar SBA.`);
    if (!crit2) notas.push(`**${regresiones.length} regresión(es) en ESTRELLA/CASHCOW-Z**: ${regresiones.map(r => r.sku_origen).join(", ")}. TSB empeora los SKUs que más importan. Revisar esos casos manualmente; probablemente sean lanzamientos que cumplieron 60d pero siguen en ramp-up. Posible: ampliar puerta a 90d.`);
    if (!crit3) notas.push(`**Bias negativo sistemático (${fmtPct(biasMed)} de vel)**: TSB subestima crónicamente. Causa probable: ceros en la historia pesan demasiado. Reducir β (probabilidad) a 0.05-0.1.`);
    if (!crit4) notas.push(`**${lowVelDisparatados.length} SKUs con SMA<0.5 y TSB>3 (${fmtPct(crit4Pct)})**: ruido low-velocity se lee como señal. Agregar filtro: si SMA<0.5 uds/sem, usar SMA aunque pase la puerta.`);
    recomendacion = `❌ TSB NO pasó. Mantener como columna informativa en shadow. Issues:\n\n${notas.map(n => `- ${n}`).join("\n")}`;
  }

  out(``);
  out(`═══ RECOMENDACIÓN PARA FASE C ═══`);
  out(recomendacion);

  // ─── Persist reporte a docs/ ───────────────────────────────────────────────

  const hoyIso = ahora.toISOString().slice(0, 10);
  const mdPath = join(__dirname, "..", "docs", `banva-bodega-tsb-benchmark-${hoyIso}.md`);
  const md = renderMd({
    generadoAt: ahora.toISOString(),
    skusEvaluados: skus.length,
    pares: pares.length,
    skusConVenta: metricas.length,
    evaluables: evaluables.length,
    enQuiebreNulo: nNulo,
    parestotal: pares.length,
    crit: { crit1, crit2, crit3, crit4, deltaMed, wmapeSmaMed, wmapeTsbMed, regresiones, biasMed, crit4Pct, lowVelDisparatados, estrellaCashcowN: estrellaCashcow.length },
    veredicto,
    porCuadrante,
    topGana,
    topPierde,
    buckets,
    recomendacion,
    tablaCompleta: metricas,
  });
  await writeFile(mdPath, md, "utf-8");
  out(``);
  out(`Reporte guardado: ${mdPath}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMd(d: any): string {
  const { generadoAt, skusEvaluados, pares, skusConVenta, evaluables, enQuiebreNulo, crit, veredicto, porCuadrante, topGana, topPierde, buckets, recomendacion, tablaCompleta } = d;
  return `# Benchmark TSB retroactivo — ${generadoAt.slice(0, 10)}

Generado: ${generadoAt}
Script: \`scripts/benchmark-tsb.ts\`

## Resumen

- SKUs Z maduros evaluados: **${skusEvaluados}**
- Pares (SKU, lunes): ${pares}
- SKUs con ≥2 semanas con venta: ${skusConVenta}
- SKUs con WMAPE calculable: **${evaluables}**
- Pares con \`en_quiebre=NULL\` (reconstruidos): ${enQuiebreNulo}/${pares} — incluidos (el criterio "sólo \`en_quiebre=false\`" queda desactivado hasta que haya datos reales post 2026-05-18).

## Criterios

| # | Criterio | Valor | Umbral | Veredicto |
|---|---|---|---|---|
| 1 | Δ WMAPE mediano (SMA − TSB) | ${fmtPct(crit.deltaMed)} (SMA=${fmtPct(crit.wmapeSmaMed)}, TSB=${fmtPct(crit.wmapeTsbMed)}) | ≥ 15 % | ${crit.crit1 ? "✅ PASA" : "❌ FALLA"} |
| 2 | Regresiones ESTRELLA/CASHCOW-Z | ${crit.regresiones.length} / ${crit.estrellaCashcowN} | 0 | ${crit.crit2 ? "✅ PASA" : "❌ FALLA"} |
| 3 | Bias TSB mediano / vel | ${fmtPct(crit.biasMed)} | > −20 % | ${crit.crit3 ? "✅ PASA" : "❌ FALLA"} |
| 4 | SMA<0.5 & TSB>3 | ${crit.lowVelDisparatados.length} / ${evaluables} (${fmtPct(crit.crit4Pct)}) | < 10 % | ${crit.crit4 ? "✅ PASA" : "❌ FALLA"} |

**Veredicto global: TSB ${veredicto ? "✅ PASA" : "❌ NO PASA"}**

## Desglose por cuadrante

| Cuadrante-Z | n | WMAPE SMA | WMAPE TSB | Δ | Gana |
|---|---:|---:|---:|---:|---|
${porCuadrante.map((p: any) => `| ${p.cuad}-Z | ${p.n} | ${p.n ? fmtPct(p.wmape_sma) : "—"} | ${p.n ? fmtPct(p.wmape_tsb) : "—"} | ${p.n ? (p.delta >= 0 ? "−" : "+") + fmtPct(Math.abs(p.delta)) : "—"} | ${p.gana} |`).join("\n")}

## Top 10 SKUs donde TSB **gana** más

| SKU | Nombre | Cuadrante | ABC | n | WMAPE SMA | WMAPE TSB | Δ |
|---|---|---|---|---:|---:|---:|---:|
${topGana.map((m: any) => `| ${m.sku_origen} | ${(m.nombre || "—").slice(0, 40)} | ${m.cuadrante} | ${m.abc} | ${m.n} | ${fmtPct(m.wmape_sma)} | ${fmtPct(m.wmape_tsb)} | ${m.delta_wmape >= 0 ? "+" : ""}${fmtPct(m.delta_wmape)} |`).join("\n")}

## Top 10 SKUs donde TSB **pierde** más

| SKU | Nombre | Cuadrante | ABC | n | WMAPE SMA | WMAPE TSB | Δ |
|---|---|---|---|---:|---:|---:|---:|
${topPierde.map((m: any) => `| ${m.sku_origen} | ${(m.nombre || "—").slice(0, 40)} | ${m.cuadrante} | ${m.abc} | ${m.n} | ${fmtPct(m.wmape_sma)} | ${fmtPct(m.wmape_tsb)} | ${m.delta_wmape >= 0 ? "+" : ""}${fmtPct(m.delta_wmape)} |`).join("\n")}

## Distribución Δ (WMAPE_SMA − WMAPE_TSB)

${buckets.map((b: any) => `- \`${b.label.padEnd(14)}\` n=${b.n}`).join("\n")}

## Recomendación

${recomendacion}

## Tabla completa — ${tablaCompleta.length} SKUs

| SKU | Nombre | Cuadrante | ABC | n | Σactual | WMAPE SMA | WMAPE TSB | Bias TSB | Bias/vel |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
${tablaCompleta.map((m: any) => `| ${m.sku_origen} | ${(m.nombre || "—").slice(0, 40)} | ${m.cuadrante} | ${m.abc} | ${m.n} | ${fmtNum(m.sum_actual, 0)} | ${m.wmape_sma !== null ? fmtPct(m.wmape_sma) : "—"} | ${m.wmape_tsb !== null ? fmtPct(m.wmape_tsb) : "—"} | ${fmtNum(m.bias_tsb)} | ${m.bias_tsb_rel !== null ? fmtPct(m.bias_tsb_rel) : "—"} |`).join("\n")}
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
