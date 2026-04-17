// Supabase glue para forecast accuracy (PR1/3).
//
// Flujo:
//   1. snapshotSemanalActual(sb, fechaCorte):
//      Escribe una fila por SKU en forecast_snapshots_semanales con
//      origen='real' y la vel_* vigente en sku_intelligence.
//      Idempotente: usa ON CONFLICT DO NOTHING sobre (sku_origen, semana_inicio).
//
//   2. calcularYGuardarAccuracy(sb, fechaCorte):
//      Para cada SKU en batches, lee 12 semanas de snapshots + ventas reales
//      + flags en_quiebre, calcula métricas para ventanas 4/8/12 y hace upsert
//      en forecast_accuracy con calculado_at = now().

import { SupabaseClient } from "@supabase/supabase-js";
import { lunesIso, restarSemanas, ultimosNLunesCerrados } from "./dates";
import {
  calcularMetricas,
  type ForecastSemanal,
  type ActualSemanal,
  type MetricasForecast,
} from "./forecast-accuracy";

const BATCH = 100;

export interface ResultadoCorrida {
  skus_procesados: number;
  skus_confiables: Record<4 | 8 | 12, number>;
  tiempo_ms: number;
}

/**
 * Guarda snapshot semanal del forecast vigente en sku_intelligence.
 * Insertado con origen='real'. Idempotente: si ya existe (sku, semana), no hace nada.
 */
export async function snapshotSemanalActual(
  sb: SupabaseClient,
  fechaCorte: Date = new Date(),
): Promise<{ semana_inicio: string; filas_insertadas: number }> {
  const semana_inicio = lunesIso(fechaCorte);

  const { data: skus, error } = await sb
    .from("sku_intelligence")
    .select("sku_origen, vel_ponderada, vel_7d, vel_30d, vel_60d, abc, xyz");
  if (error) throw new Error(`sku_intelligence read failed: ${error.message}`);
  if (!skus || skus.length === 0) return { semana_inicio, filas_insertadas: 0 };

  // en_quiebre "real": leer stock_snapshots últimos 7 días y contar días en quiebre por SKU.
  const haceSieteDias = new Date(fechaCorte);
  haceSieteDias.setUTCDate(haceSieteDias.getUTCDate() - 7);
  const haceSieteIso = haceSieteDias.toISOString().slice(0, 10);

  const { data: snaps } = await sb
    .from("stock_snapshots")
    .select("sku_origen, fecha, en_quiebre_full")
    .gte("fecha", haceSieteIso)
    .lt("fecha", semana_inicio);

  const diasQuiebrePorSku = new Map<string, number>();
  for (const s of snaps || []) {
    if (s.en_quiebre_full) {
      diasQuiebrePorSku.set(s.sku_origen, (diasQuiebrePorSku.get(s.sku_origen) || 0) + 1);
    }
  }

  const filas = skus.map(s => ({
    sku_origen: s.sku_origen,
    semana_inicio,
    vel_ponderada: s.vel_ponderada ?? 0,
    vel_7d: s.vel_7d ?? 0,
    vel_30d: s.vel_30d ?? 0,
    vel_60d: s.vel_60d ?? 0,
    abc: s.abc,
    xyz: s.xyz,
    en_quiebre: (diasQuiebrePorSku.get(s.sku_origen) || 0) >= 3,
    origen: "real" as const,
  }));

  // Supabase no expone ON CONFLICT DO NOTHING directamente; emular con upsert + ignoreDuplicates.
  let insertadas = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const chunk = filas.slice(i, i + 500);
    const { error: upErr, count } = await sb
      .from("forecast_snapshots_semanales")
      .upsert(chunk, { onConflict: "sku_origen,semana_inicio", ignoreDuplicates: true, count: "exact" });
    if (upErr) throw new Error(`snapshot upsert failed: ${upErr.message}`);
    insertadas += count ?? 0;
  }

  return { semana_inicio, filas_insertadas: insertadas };
}

/**
 * Calcula accuracy por SKU para ventanas 4/8/12 y hace upsert en forecast_accuracy.
 * Lee hasta 12 lunes cerrados desde forecast_snapshots_semanales + ventas
 * agregadas desde ventas_ml_cache vía composicion_venta.
 */
export async function calcularYGuardarAccuracy(
  sb: SupabaseClient,
  fechaCorte: Date = new Date(),
): Promise<ResultadoCorrida> {
  const t0 = Date.now();
  const lunes12 = ultimosNLunesCerrados(fechaCorte, 12);         // ASC
  const lunesMasViejo = lunes12[0];
  const lunesMasNuevo = lunes12[lunes12.length - 1];
  const inicioVentana = lunesMasViejo;
  const finVentana = restarSemanas(lunesMasNuevo, -1); // domingo siguiente al último lunes cerrado

  // 1) SKUs a evaluar.
  const { data: skus, error: eSkus } = await sb
    .from("sku_intelligence")
    .select("sku_origen");
  if (eSkus) throw new Error(`sku_intelligence read failed: ${eSkus.message}`);
  const skuList = (skus || []).map(r => r.sku_origen as string);

  // 2) Mapa sku_venta → {sku_origen, unidades} (mismo que motor P2).
  //    Sólo componentes "principales" (no alternativos) para evitar doble contar.
  const { data: comp, error: eComp } = await sb
    .from("composicion_venta")
    .select("sku_venta, sku_origen, unidades, tipo_relacion");
  if (eComp) throw new Error(`composicion_venta read failed: ${eComp.message}`);
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

  // 3) Ventas de la ventana completa (12 semanas) agregadas a sku_origen por lunes ISO.
  //    Filtrar anulada=false y fecha_date IN [inicioVentana, finVentana].
  const { data: ventas, error: eVentas } = await sb
    .from("ventas_ml_cache")
    .select("sku_venta, fecha_date, cantidad, anulada")
    .gte("fecha_date", inicioVentana)
    .lte("fecha_date", finVentana)
    .eq("anulada", false);
  if (eVentas) throw new Error(`ventas_ml_cache read failed: ${eVentas.message}`);

  // Mapa sku_origen → Map<semana_inicio, uds_fisicas>
  const actualesPorSku = new Map<string, Map<string, number>>();
  for (const v of ventas || []) {
    const fd = v.fecha_date as string | null;
    if (!fd) continue;
    const semana = lunesIso(new Date(fd + "T00:00:00.000Z"));
    const comps = compByVenta.get(String(v.sku_venta).toUpperCase());
    if (!comps) continue;
    const qty = Number(v.cantidad) || 0;
    for (const c of comps) {
      if (!actualesPorSku.has(c.so)) actualesPorSku.set(c.so, new Map());
      const m = actualesPorSku.get(c.so)!;
      m.set(semana, (m.get(semana) || 0) + qty * c.u);
    }
  }

  // 4) Snapshots de las 12 semanas para TODOS los SKUs — una sola query paginada.
  const snapsMap = new Map<string, ForecastSemanal[]>(); // sku → [...snapshots]
  {
    const { data: snaps, error: eSnap } = await sb
      .from("forecast_snapshots_semanales")
      .select("sku_origen, semana_inicio, vel_ponderada, en_quiebre")
      .gte("semana_inicio", inicioVentana)
      .lte("semana_inicio", lunesMasNuevo);
    if (eSnap) throw new Error(`forecast_snapshots read failed: ${eSnap.message}`);
    for (const s of snaps || []) {
      const k = s.sku_origen as string;
      if (!snapsMap.has(k)) snapsMap.set(k, []);
      snapsMap.get(k)!.push({
        semana_inicio: s.semana_inicio,
        vel_ponderada: Number(s.vel_ponderada) || 0,
        en_quiebre: s.en_quiebre as boolean | null,
      });
    }
  }

  // 5) Calcular métricas por SKU y ventana, acumular filas.
  const filasAccuracy: Array<Record<string, unknown>> = [];
  const confiables: Record<4 | 8 | 12, number> = { 4: 0, 8: 0, 12: 0 };
  const calculadoAt = new Date().toISOString();

  for (const sku of skuList) {
    const forecasts = snapsMap.get(sku) || [];
    if (forecasts.length === 0) continue;
    const actualMap = actualesPorSku.get(sku) || new Map<string, number>();
    // Construir actuales siempre con TODAS las semanas de los forecasts
    // (incluso las que tienen 0 ventas).
    const actuales: ActualSemanal[] = forecasts.map(f => ({
      semana_inicio: f.semana_inicio,
      uds_fisicas: actualMap.get(f.semana_inicio) ?? 0,
    }));

    for (const ventana of [4, 8, 12] as const) {
      const m: MetricasForecast = calcularMetricas(forecasts, actuales, ventana);
      if (m.es_confiable) confiables[ventana]++;
      filasAccuracy.push({
        sku_origen: sku,
        ventana_semanas: ventana,
        calculado_at: calculadoAt,
        semanas_evaluadas: m.semanas_evaluadas,
        semanas_excluidas: m.semanas_excluidas,
        wmape: m.wmape,
        bias: m.bias,
        mad: m.mad,
        tracking_signal: m.tracking_signal,
        forecast_total: m.forecast_total,
        actual_total: m.actual_total,
        es_confiable: m.es_confiable,
      });
    }
  }

  // 6) Escribir en batches de 500 para no sobrepasar payload Supabase.
  for (let i = 0; i < filasAccuracy.length; i += 500) {
    const chunk = filasAccuracy.slice(i, i + 500);
    const { error: eUp } = await sb.from("forecast_accuracy").insert(chunk);
    if (eUp) throw new Error(`forecast_accuracy insert failed: ${eUp.message}`);
  }

  return {
    skus_procesados: skuList.length,
    skus_confiables: confiables,
    tiempo_ms: Date.now() - t0,
  };
}

// `BATCH` exportado para tests; hoy no se usa paginación de SKUs (todas las
// queries son por rango de fecha, no por lista de SKUs). Mantengo por si PR2
// necesita ajustar.
export { BATCH as BATCH_SIZE };

// ════════════════════════════════════════════════════════════════════════════
// PR2/3 — lectura agregada para el motor
// ════════════════════════════════════════════════════════════════════════════

export interface MetricaActual {
  wmape: number | null;
  bias: number | null;
  tracking_signal: number | null;
  semanas_evaluadas: number;
  es_confiable: boolean;
  calculado_at: string; // ISO
}

/**
 * Última fila de forecast_accuracy por SKU para una ventana fija.
 * Una sola query con DISTINCT ON — el motor la pide una vez y pasa el Map
 * al loop por SKU (no hay N+1). Si la tabla no existe o falla, el caller
 * debe atrapar el error y continuar sin estas métricas.
 */
export async function ultimasMetricasAccuracy(
  sb: SupabaseClient,
  ventana: 4 | 8 | 12,
): Promise<Map<string, MetricaActual>> {
  // DISTINCT ON no está expuesto por supabase-js — paginamos en memoria:
  // traemos todas las filas de esa ventana ORDER BY sku, calculado_at DESC
  // y nos quedamos con la primera por SKU.
  const out = new Map<string, MetricaActual>();
  const { data, error } = await sb
    .from("forecast_accuracy")
    .select("sku_origen, wmape, bias, tracking_signal, semanas_evaluadas, es_confiable, calculado_at")
    .eq("ventana_semanas", ventana)
    .order("sku_origen", { ascending: true })
    .order("calculado_at", { ascending: false });
  if (error) throw new Error(`ultimasMetricasAccuracy failed: ${error.message}`);
  for (const r of data || []) {
    if (out.has(r.sku_origen)) continue; // ya tenemos la más reciente para este SKU
    out.set(r.sku_origen, {
      wmape: r.wmape as number | null,
      bias: r.bias as number | null,
      tracking_signal: r.tracking_signal as number | null,
      semanas_evaluadas: (r.semanas_evaluadas as number) || 0,
      es_confiable: (r.es_confiable as boolean) || false,
      calculado_at: r.calculado_at as string,
    });
  }
  return out;
}
