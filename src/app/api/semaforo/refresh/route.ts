import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  return isVercelCron || isLocalDev;
}

interface SemaforoConfig {
  cayo_factor_caida: number;
  cayo_vel_minima_base: number;
  despegando_factor_alza: number;
  despegando_vel_minima: number;
  quiebre_cobertura_dias: number;
  quiebre_vel_minima: number;
  estancado_vel_maxima: number;
  estancado_cobertura_minima: number;
  muerto_dias_sin_venta: number;
  holdout_porcentaje: number;
}

const DEFAULT_CONFIG: SemaforoConfig = {
  cayo_factor_caida: 0.6,
  cayo_vel_minima_base: 2,
  despegando_factor_alza: 1.4,
  despegando_vel_minima: 3,
  quiebre_cobertura_dias: 14,
  quiebre_vel_minima: 2,
  estancado_vel_maxima: 1,
  estancado_cobertura_minima: 56,
  muerto_dias_sin_venta: 60,
  holdout_porcentaje: 0.10,
};

type Cubeta = "holdout" | "muerto" | "ya_quebrado" | "quiebre_inminente" | "cayo" | "despegando" | "estancado" | "normal";

function calcularCubeta(
  row: { vel_7d: number; vel_30d: number; stock_total: number; cob_total: number; dias_sin_venta: number; es_holdout: boolean },
  cfg: SemaforoConfig
): Cubeta {
  if (row.es_holdout) return "holdout";
  if (row.dias_sin_venta > cfg.muerto_dias_sin_venta && row.stock_total > 0) return "muerto";
  if (row.stock_total === 0 && row.vel_30d > cfg.quiebre_vel_minima) return "ya_quebrado";
  if (row.stock_total > 0 && row.cob_total < cfg.quiebre_cobertura_dias && row.vel_30d > cfg.quiebre_vel_minima) return "quiebre_inminente";
  if (row.vel_7d < row.vel_30d * cfg.cayo_factor_caida
      && row.vel_30d > cfg.cayo_vel_minima_base
      && row.stock_total > 0
      && row.dias_sin_venta < 14) return "cayo";
  if (row.vel_7d > row.vel_30d * cfg.despegando_factor_alza
      && row.vel_7d > cfg.despegando_vel_minima) return "despegando";
  if (row.vel_30d < cfg.estancado_vel_maxima
      && row.cob_total > cfg.estancado_cobertura_minima
      && row.stock_total > 0) return "estancado";
  return "normal";
}

function calcularImpacto(
  cubeta: Cubeta,
  row: { vel_7d: number; vel_30d: number; margen_full_30d: number; stock_total: number; costo_promedio: number }
): number {
  const margen = row.margen_full_30d || 0;
  switch (cubeta) {
    case "cayo":
    case "ya_quebrado":
      return Math.max(0, (row.vel_30d - row.vel_7d)) * margen;
    case "despegando":
      return Math.max(0, (row.vel_7d - row.vel_30d)) * margen;
    case "quiebre_inminente":
      return row.vel_30d * margen;
    case "muerto":
    case "estancado":
      return row.stock_total * (row.costo_promedio || 0);
    default:
      return 0;
  }
}

function calcularAntiguedadMuerto(diasSinVenta: number): string | null {
  if (diasSinVenta <= 120) return "reciente";
  if (diasSinVenta <= 365) return "cronico";
  return "fosil";
}

/**
 * Markdown sugerido segun Regla 60/90/120/180 dias de los manuales.
 * Piso: nunca sugerir precio menor al costo salvo en liquidacion (>180d).
 * Precio 0 o costo invalido => no sugiere nada.
 */
function calcularMarkdown(
  cubeta: Cubeta,
  row: { dias_sin_venta: number; precio_actual: number; costo_promedio: number }
): { precio: number | null; motivo: string | null } {
  const { dias_sin_venta: d, precio_actual: precio, costo_promedio: costo } = row;
  if (!precio || precio <= 0) return { precio: null, motivo: null };
  if (cubeta !== "muerto" && cubeta !== "estancado") return { precio: null, motivo: null };
  if (d >= 999) return { precio: null, motivo: null }; // centinela: no confiable

  const piso = costo > 0 ? costo : 0;
  if (d > 180) {
    // Liquidacion: llevar a costo (puede quedar a costo exacto si precio*0.50 < costo)
    return { precio: Math.max(Math.round(precio * 0.50), piso), motivo: `liquidar_${d}d` };
  }
  if (d > 120) {
    return { precio: Math.max(Math.round(precio * 0.60), piso), motivo: `markdown_40_${d}d` };
  }
  if (d > 90) {
    return { precio: Math.max(Math.round(precio * 0.80), piso), motivo: `markdown_20_${d}d` };
  }
  if (d > 60) {
    return { precio: Math.max(Math.round(precio * 0.90), piso), motivo: `markdown_10_${d}d` };
  }
  return { precio: null, motivo: null };
}

/**
 * GET — Vercel Cron (lunes 6AM Chile)
 * POST — Manual trigger
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runRefresh(false);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isAuthorized(req)) {
    if (!body.manual) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runRefresh(body.force === true);
}

async function runRefresh(force = false) {
  const start = Date.now();
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  try {
    // 1. Check staleness of sku_intelligence
    const { data: staleCheck } = await sb
      .from("sku_intelligence")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);

    if (staleCheck?.[0]) {
      const lastUpdate = new Date(staleCheck[0].updated_at);
      const hoursAgo = (Date.now() - lastUpdate.getTime()) / 3600000;
      if (hoursAgo > 24 && !force) {
        // TODO: send Telegram alert
        console.error(`[semaforo] Intelligence stale: ${hoursAgo.toFixed(1)}h ago`);
        return NextResponse.json({
          error: "intelligence_stale",
          message: `sku_intelligence no se actualiza hace ${hoursAgo.toFixed(0)} horas. Semaforo no actualizado. Usa force:true para forzar.`,
          last_update: staleCheck[0].updated_at,
        }, { status: 503 });
      }
    }

    // 2. Load config
    const { data: configRows } = await sb.from("semaforo_config").select("key, value");
    const cfg = { ...DEFAULT_CONFIG };
    for (const row of configRows || []) {
      if (row.key in cfg) (cfg as Record<string, number>)[row.key] = Number(row.value);
    }

    // 3. Load sku_intelligence (atributos a nivel sku_origen compartidos entre pubs)
    const { data: intelRows, error: intelErr } = await sb
      .from("sku_intelligence")
      .select("sku_origen, nombre, vel_7d, vel_30d, vel_60d, vel_ponderada, margen_full_30d, margen_flex_30d, cuadrante, es_holdout, accion, alertas, dias_sin_stock_full, venta_perdida_pesos, ingreso_perdido, liquidacion_accion, liquidacion_descuento_sugerido, factor_rampup_aplicado, rampup_motivo, vel_pre_quiebre, dias_en_quiebre, abc_ingreso, tendencia_vel, tendencia_vel_pct");
    if (intelErr) throw new Error(`Intel query error: ${intelErr.message}`);
    const intelBySkuOrigen = new Map<string, Record<string, unknown>>();
    for (const si of intelRows || []) intelBySkuOrigen.set(si.sku_origen as string, si);

    // 4. Load ml_items_map activos (fila por publicacion ML)
    const { data: mlItems, error: mlErr } = await sb
      .from("ml_items_map")
      .select("item_id, sku, sku_venta, sku_origen, titulo, price, thumbnail, permalink, activo, sold_quantity, status_ml, stock_full_cache, stock_flex_cache")
      .eq("activo", true)
      .order("sold_quantity", { ascending: false, nullsFirst: false });
    if (mlErr) throw new Error(`ML items query error: ${mlErr.message}`);

    // Contar publicaciones por sku_origen (para badge "N pub")
    const mlCountsPorOrigen = new Map<string, number>();
    for (const m of mlItems || []) {
      const so = (m.sku_origen || m.sku) as string;
      if (so) mlCountsPorOrigen.set(so, (mlCountsPorOrigen.get(so) || 0) + 1);
    }

    // 4b. Stock bodega compartido por sku_origen
    const { data: stockRows } = await sb.from("stock").select("sku, cantidad");
    const stockBodegaMap = new Map<string, number>();
    for (const r of stockRows || []) {
      stockBodegaMap.set(r.sku, (stockBodegaMap.get(r.sku) || 0) + (r.cantidad || 0));
    }

    // 4c. Composicion: sku_venta -> { sku_origen, unidades_pack }
    const { data: compRows } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");
    const compBySkuVenta = new Map<string, { sku_origen: string; unidades: number }>();
    for (const c of compRows || []) {
      compBySkuVenta.set(c.sku_venta, {
        sku_origen: c.sku_origen,
        unidades: (c.unidades as number) || 1,
      });
    }

    // 5. Load costo_promedio from productos
    const { data: prodRows } = await sb.from("productos").select("sku, costo_promedio");
    const costoMap = new Map<string, number>();
    for (const p of prodRows || []) costoMap.set(p.sku, p.costo_promedio || 0);

    // 6. Traer todas las ordenes de los ultimos 60 dias paginadas — granularidad item_id
    // Agregaremos vel_7d/30d/60d y precio_promedio_30d por sku_venta (-> item_id)
    const now = new Date();
    const hace7d = now.getTime() - 7 * 86400000;
    const hace30d = now.getTime() - 30 * 86400000;
    const hace60d = now.getTime() - 60 * 86400000;
    const desdeISO = new Date(hace60d).toISOString();

    type VentasAgg = { uds7: number; uds30: number; uds60: number; revenue30: number; ventas30: number; ultFecha: number };
    const ventasPorSkuVenta = new Map<string, VentasAgg>();
    const ORDERS_PAGE = 1000;
    let ordOffset = 0;
    while (true) {
      const { data: ords, error: ordErr } = await sb
        .from("orders_history")
        .select("sku_venta, cantidad, subtotal, fecha")
        .eq("estado", "Pagada")
        .gte("fecha", desdeISO)
        .range(ordOffset, ordOffset + ORDERS_PAGE - 1);
      if (ordErr) {
        console.error("[semaforo] orders_history query error:", ordErr.message);
        break;
      }
      if (!ords || ords.length === 0) break;
      for (const o of ords) {
        const sv = o.sku_venta as string;
        if (!sv) continue;
        const t = new Date(o.fecha as string).getTime();
        const cant = (o.cantidad as number) || 0;
        const sub = (o.subtotal as number) || 0;
        const agg = ventasPorSkuVenta.get(sv) || { uds7: 0, uds30: 0, uds60: 0, revenue30: 0, ventas30: 0, ultFecha: 0 };
        if (t >= hace60d) agg.uds60 += cant;
        if (t >= hace30d) { agg.uds30 += cant; agg.revenue30 += sub; agg.ventas30 += 1; }
        if (t >= hace7d) agg.uds7 += cant;
        if (t > agg.ultFecha) agg.ultFecha = t;
        ventasPorSkuVenta.set(sv, agg);
      }
      if (ords.length < ORDERS_PAGE) break;
      ordOffset += ORDERS_PAGE;
    }

    // 7. Marketing/performance por item_id del ultimo mes (ml_snapshot_mensual)
    const periodoActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const periodoAnterior = (() => {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    })();
    const { data: snapRows } = await sb
      .from("ml_snapshot_mensual")
      .select("item_id, periodo, visitas, cvr, ads_activo, ads_cost, ads_roas, quality_score")
      .in("periodo", [periodoActual, periodoAnterior]);
    const snapBy: Record<string, Map<string, Record<string, unknown>>> = {
      [periodoActual]: new Map(), [periodoAnterior]: new Map(),
    };
    for (const s of snapRows || []) {
      snapBy[s.periodo as string]?.set(s.item_id as string, s);
    }

    const semana = getMonday(now);

    // 8. Build rows: UNA FILA POR sku_venta ACTIVO
    // Dedupe por sku_venta — puede haber multiples variation_id con mismo sku_venta,
    // nos quedamos con la de mayor sold_quantity (viene ordenado desc).
    const skuVentasProcesados = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (const m of mlItems || []) {
      const itemId = m.item_id as string;
      if (!itemId) continue;
      const skuVenta = (m.sku_venta || m.sku) as string;
      if (!skuVenta) continue;
      if (skuVentasProcesados.has(skuVenta)) continue;
      skuVentasProcesados.add(skuVenta);

      const comp = compBySkuVenta.get(skuVenta);
      const skuOrigen = comp?.sku_origen || (m.sku_origen as string) || skuVenta;
      const unidadesPack = comp?.unidades || 1;

      const si = intelBySkuOrigen.get(skuOrigen);
      const costo = costoMap.get(skuOrigen) || 0;

      // Velocidad propia del item (basada en sus ventas por sku_venta × pack)
      const v = ventasPorSkuVenta.get(skuVenta);
      const udsFis7 = (v?.uds7 || 0) * unidadesPack;
      const udsFis30 = (v?.uds30 || 0) * unidadesPack;
      const udsFis60 = (v?.uds60 || 0) * unidadesPack;
      const vel7d = udsFis7;
      const vel30d = udsFis30 / 4.285;
      const vel60d = udsFis60 / 8.57;
      const velPonderada = vel7d * 0.5 + vel30d * 0.3 + vel60d * 0.2;
      const precioProm30 = v && v.ventas30 > 0 ? Math.round(v.revenue30 / v.ventas30) : null;

      // Stock propio del item: Full + Flex de la pub; bodega es compartido
      const stockFull = (m.stock_full_cache as number) || 0;
      const stockFlex = (m.stock_flex_cache as number) || 0;
      const bodegaCompartido = stockBodegaMap.get(skuOrigen) || 0;
      // stock_total para cubeta: stock visible del item + bodega compartido (en uds fisicas)
      const stockVisibleItem = stockFull + stockFlex;
      const stockTotalItem = stockVisibleItem + bodegaCompartido;
      const cobTotal = velPonderada > 0 ? Math.round((stockTotalItem / (velPonderada / 7)) * 100) / 100 : 999;
      const cobFull = velPonderada > 0 ? Math.round((stockFull / (velPonderada / 7)) * 100) / 100 : 999;

      const diasSinVenta = v?.ultFecha
        ? Math.floor((now.getTime() - v.ultFecha) / 86400000)
        : 999;

      const cubeta = calcularCubeta({
        vel_7d: vel7d,
        vel_30d: vel30d,
        stock_total: stockTotalItem,
        cob_total: cobTotal,
        dias_sin_venta: diasSinVenta,
        es_holdout: (si?.es_holdout as boolean) || false,
      }, cfg);

      const margenFull30 = (si?.margen_full_30d as number) || 0;
      const impacto = calcularImpacto(cubeta, {
        vel_7d: vel7d,
        vel_30d: vel30d,
        margen_full_30d: margenFull30,
        stock_total: stockTotalItem,
        costo_promedio: costo,
      });

      const markdown = calcularMarkdown(cubeta, {
        dias_sin_venta: diasSinVenta,
        precio_actual: (m.price as number) || 0,
        costo_promedio: costo,
      });

      // Marketing del periodo actual
      const snapCur = snapBy[periodoActual]?.get(itemId);
      const snapPrev = snapBy[periodoAnterior]?.get(itemId);
      const visitas30 = (snapCur?.visitas as number) || (snapPrev?.visitas as number) || 0;
      const cvr30 = (snapCur?.cvr as number) || (snapPrev?.cvr as number) || 0;
      const adsActivo = (snapCur?.ads_activo as boolean) || false;
      const adsCost = (snapCur?.ads_cost as number) || 0;
      const adsRoas = (snapCur?.ads_roas as number) || 0;
      const qs = (snapCur?.quality_score as number) ?? null;

      rows.push({
        item_id: itemId,
        sku_venta: skuVenta,
        sku_origen: skuOrigen,
        nombre: (si?.nombre as string) || null,
        titulo: (m.titulo as string) || null,
        thumbnail: (m.thumbnail as string) || null,
        permalink: (m.permalink as string) || null,
        vel_7d: Math.round(vel7d * 100) / 100,
        vel_30d: Math.round(vel30d * 100) / 100,
        vel_60d: Math.round(vel60d * 100) / 100,
        vel_ponderada: Math.round(velPonderada * 100) / 100,
        unidades_pack: unidadesPack,
        stock_full: stockFull,
        stock_flex: stockFlex,
        stock_bodega_compartido: bodegaCompartido,
        stock_total: stockTotalItem,
        cob_total: cobTotal,
        cob_full: cobFull,
        dias_sin_venta: diasSinVenta,
        margen_full_30d: margenFull30,
        margen_flex_30d: (si?.margen_flex_30d as number) || 0,
        precio_actual: (m.price as number) || 0,
        precio_promedio_30d: precioProm30,
        costo_promedio: costo,
        cuadrante: (si?.cuadrante as string) || null,
        abc_ingreso: (si?.abc_ingreso as string) || null,
        cubeta,
        antiguedad_muerto_bucket: cubeta === "muerto" ? calcularAntiguedadMuerto(diasSinVenta) : null,
        es_holdout: (si?.es_holdout as boolean) || false,
        impacto_clp: Math.round(impacto),
        precio_markdown_sugerido: markdown.precio,
        markdown_motivo: markdown.motivo,
        // Bridge sku_intelligence (compartido entre pubs del mismo sku_origen)
        accion: (si?.accion as string) || null,
        alertas: (si?.alertas as unknown[]) || [],
        dias_sin_stock_full: (si?.dias_sin_stock_full as number) ?? null,
        venta_perdida_pesos: (si?.venta_perdida_pesos as number) || 0,
        ingreso_perdido: (si?.ingreso_perdido as number) || 0,
        liquidacion_accion: (si?.liquidacion_accion as string) || null,
        liquidacion_descuento_sugerido: (si?.liquidacion_descuento_sugerido as number) ?? null,
        factor_rampup_aplicado: (si?.factor_rampup_aplicado as number) ?? 1,
        rampup_motivo: (si?.rampup_motivo as string) || null,
        vel_pre_quiebre: (si?.vel_pre_quiebre as number) || 0,
        dias_en_quiebre: (si?.dias_en_quiebre as number) || 0,
        tendencia_vel: (si?.tendencia_vel as string) || null,
        tendencia_vel_pct: (si?.tendencia_vel_pct as number) || 0,
        // Marketing / performance propio de la publicacion
        visitas_30d: visitas30,
        cvr_30d: cvr30,
        ads_activo: adsActivo,
        ads_cost_30d: adsCost,
        ads_roas_30d: adsRoas,
        quality_score: qs,
        status_ml: (m.status_ml as string) || null,
        cantidad_publicaciones_ml: mlCountsPorOrigen.get(skuOrigen) || 1,
        semana_calculo: semana,
      });
    }

    // 8. Write to semaforo_semanal (delete current week + insert)
    await sb.from("semaforo_semanal").delete().eq("semana_calculo", semana);
    let insertedOK = 0;
    let insertErrors: string[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await sb.from("semaforo_semanal").insert(batch);
      if (error) {
        console.error("[semaforo] Insert error batch", i, ":", error.message);
        insertErrors.push(`batch@${i}: ${error.message}`);
      } else {
        insertedOK += batch.length;
      }
    }
    if (insertErrors.length > 0) {
      console.error("[semaforo] Insert errors summary:", insertErrors.join(" | "));
    }

    // 9. Build and save snapshot
    const counts: Record<string, number> = {};
    const impacts: Record<string, number> = {};
    for (const r of rows) {
      const c = r.cubeta as string;
      counts[c] = (counts[c] || 0) + 1;
      impacts[c] = (impacts[c] || 0) + (r.impacto_clp as number);
    }

    // Get previous week snapshot for deltas
    const prevSemana = new Date(semana);
    prevSemana.setDate(prevSemana.getDate() - 7);
    const prevStr = prevSemana.toISOString().slice(0, 10);
    const { data: prevSnap } = await sb
      .from("semaforo_snapshot_semanal")
      .select("*")
      .eq("semana", prevStr)
      .limit(1);

    // Weekly KPIs — agregan directo desde orders_history (fuente canónica).
    // Ventana: última semana completa [semana-7, semana).
    const weekStart = new Date(semana);
    weekStart.setDate(weekStart.getDate() - 7);
    const weekStartISO = weekStart.toISOString().slice(0, 10);

    let unidadesSemana = 0;
    let revenueSemana = 0;
    const KPI_PAGE = 1000;
    let kpiOffset = 0;
    while (true) {
      const { data: ordRows, error: ordErr } = await sb
        .from("orders_history")
        .select("cantidad, subtotal")
        .eq("estado", "Pagada")
        .gte("fecha", weekStartISO)
        .lt("fecha", semana)
        .range(kpiOffset, kpiOffset + KPI_PAGE - 1);
      if (ordErr) {
        console.error("[semaforo] orders_history KPI query error:", ordErr.message);
        break;
      }
      if (!ordRows || ordRows.length === 0) break;
      for (const o of ordRows) {
        unidadesSemana += (o.cantidad as number) || 0;
        revenueSemana += (o.subtotal as number) || 0;
      }
      if (ordRows.length < KPI_PAGE) break;
      kpiOffset += KPI_PAGE;
    }

    const prev = prevSnap?.[0];
    const deltaUnidades = prev?.unidades_semana && prev.unidades_semana > 0
      ? Math.round(((unidadesSemana - prev.unidades_semana) / prev.unidades_semana) * 1000) / 10
      : null;
    const deltaRevenue = prev?.revenue_semana && prev.revenue_semana > 0
      ? Math.round(((revenueSemana - prev.revenue_semana) / prev.revenue_semana) * 1000) / 10
      : null;

    await sb.from("semaforo_snapshot_semanal").upsert({
      semana,
      count_cayo: counts.cayo || 0,
      count_quiebre_inminente: counts.quiebre_inminente || 0,
      count_ya_quebrado: counts.ya_quebrado || 0,
      count_despegando: counts.despegando || 0,
      count_estancado: counts.estancado || 0,
      count_muerto: counts.muerto || 0,
      count_normal: counts.normal || 0,
      count_holdout: counts.holdout || 0,
      impacto_total_cayo: impacts.cayo || 0,
      impacto_total_quiebre: (impacts.quiebre_inminente || 0) + (impacts.ya_quebrado || 0),
      impacto_total_estancado: impacts.estancado || 0,
      impacto_total_muerto: impacts.muerto || 0,
      unidades_semana: unidadesSemana,
      revenue_semana: revenueSemana,
      delta_unidades_pct: deltaUnidades,
      delta_revenue_pct: deltaRevenue,
    }, { onConflict: "semana" });

    const elapsed = Date.now() - start;
    return NextResponse.json({
      status: "ok",
      semana,
      total_skus: rows.length,
      inserted_ok: insertedOK,
      insert_errors: insertErrors.length > 0 ? insertErrors : undefined,
      cubetas: counts,
      impactos: impacts,
      kpis: { unidades_semana: unidadesSemana, revenue_semana: revenueSemana },
      elapsed_ms: elapsed,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    });

  } catch (err) {
    console.error("[semaforo] Refresh error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function getMonday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return date.toISOString().slice(0, 10);
}
