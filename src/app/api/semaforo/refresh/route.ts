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

    // 3. Load sku_intelligence (active SKUs)
    const { data: intelRows, error: intelErr } = await sb
      .from("sku_intelligence")
      .select("sku_origen, nombre, vel_7d, vel_30d, vel_60d, vel_ponderada, stock_total, stock_full, stock_bodega, cob_total, cob_full, pct_full, margen_full_30d, margen_flex_30d, cuadrante, es_holdout")
      .or("vel_ponderada.gt.0,stock_total.gt.0");

    if (intelErr) throw new Error(`Intel query error: ${intelErr.message}`);
    if (!intelRows || intelRows.length === 0) {
      return NextResponse.json({ error: "no data in sku_intelligence" }, { status: 500 });
    }

    // 4. Load ml_items_map for price, thumbnail, permalink, item_id
    const { data: mlItems } = await sb
      .from("ml_items_map")
      .select("sku_origen, item_id, price, thumbnail, permalink, activo, sold_quantity");

    // Build map: sku_origen -> best item (most sold, active preferred)
    const mlMap = new Map<string, { item_id: string; price: number; thumbnail: string; permalink: string; count: number }>();
    const mlCounts = new Map<string, number>();
    for (const m of mlItems || []) {
      if (!m.sku_origen) continue;
      mlCounts.set(m.sku_origen, (mlCounts.get(m.sku_origen) || 0) + 1);
      const existing = mlMap.get(m.sku_origen);
      if (!existing || (m.activo && (!existing || (m.sold_quantity || 0) > 0))) {
        mlMap.set(m.sku_origen, {
          item_id: m.item_id,
          price: m.price || 0,
          thumbnail: m.thumbnail || "",
          permalink: m.permalink || "",
          count: 0,
        });
      }
    }

    // 4b. Load LIVE stock from source tables (not intelligence snapshot)
    // Bodega stock
    const { data: stockRows } = await sb.from("stock").select("sku, cantidad");
    const stockBodegaMap = new Map<string, number>();
    for (const r of stockRows || []) {
      stockBodegaMap.set(r.sku, (stockBodegaMap.get(r.sku) || 0) + (r.cantidad || 0));
    }
    // Full stock from stock_full_cache (synced from ML API)
    const { data: fullRows } = await sb.from("stock_full_cache").select("sku_venta, cantidad");
    // Map sku_venta -> sku_origen for Full stock
    const { data: compForStock } = await sb.from("composicion_venta").select("sku_venta, sku_origen");
    const svToSoStock = new Map<string, string>();
    for (const c of compForStock || []) svToSoStock.set(c.sku_venta, c.sku_origen);
    const stockFullMap = new Map<string, number>();
    for (const r of fullRows || []) {
      const so = svToSoStock.get(r.sku_venta) || r.sku_venta;
      stockFullMap.set(so, (stockFullMap.get(so) || 0) + (r.cantidad || 0));
    }

    // 5. Load costo_promedio from productos
    const { data: prodRows } = await sb.from("productos").select("sku, costo_promedio");
    const costoMap = new Map<string, number>();
    for (const p of prodRows || []) {
      costoMap.set(p.sku, p.costo_promedio || 0);
    }

    // 6. Calculate dias_sin_venta from orders_history
    const { data: lastSales } = await sb
      .from("orders_history")
      .select("sku_venta, fecha")
      .order("fecha", { ascending: false });

    // Map sku_venta -> sku_origen via composicion_venta
    const { data: compRows } = await sb.from("composicion_venta").select("sku_venta, sku_origen");
    const svToSo = new Map<string, string>();
    for (const c of compRows || []) svToSo.set(c.sku_venta, c.sku_origen);

    const lastSaleMap = new Map<string, string>();
    for (const o of lastSales || []) {
      const so = svToSo.get(o.sku_venta) || o.sku_venta;
      if (!lastSaleMap.has(so)) lastSaleMap.set(so, o.fecha);
    }

    const now = new Date();
    const semana = getMonday(now);

    // 7. Build semaforo rows (stock from LIVE sources, velocity from intelligence)
    const rows: Array<Record<string, unknown>> = [];
    for (const si of intelRows) {
      const ml = mlMap.get(si.sku_origen);
      const costo = costoMap.get(si.sku_origen) || 0;
      const lastSale = lastSaleMap.get(si.sku_origen);
      const diasSinVenta = lastSale
        ? Math.floor((now.getTime() - new Date(lastSale).getTime()) / 86400000)
        : 999;

      // LIVE stock (not intelligence snapshot)
      const liveBodega = stockBodegaMap.get(si.sku_origen) || 0;
      const liveFull = stockFullMap.get(si.sku_origen) || 0;
      const liveTotal = liveBodega + liveFull;
      // Recalculate cobertura with live stock
      const velSemanal = si.vel_ponderada || 0;
      const liveCobTotal = velSemanal > 0 ? Math.round((liveTotal / (velSemanal / 7)) * 100) / 100 : 999;
      const liveCobFull = (si.vel_ponderada || 0) > 0 && (si.pct_full || 0) > 0
        ? Math.round((liveFull / ((si.vel_ponderada * (si.pct_full || 1)) / 7)) * 100) / 100
        : 999;

      const cubeta = calcularCubeta({
        vel_7d: si.vel_7d || 0,
        vel_30d: si.vel_30d || 0,
        stock_total: liveTotal,
        cob_total: liveCobTotal,
        dias_sin_venta: diasSinVenta,
        es_holdout: si.es_holdout || false,
      }, cfg);

      const impacto = calcularImpacto(cubeta, {
        vel_7d: si.vel_7d || 0,
        vel_30d: si.vel_30d || 0,
        margen_full_30d: si.margen_full_30d || 0,
        stock_total: liveTotal,
        costo_promedio: costo,
      });

      rows.push({
        sku_origen: si.sku_origen,
        nombre: si.nombre,
        item_id: ml?.item_id || null,
        thumbnail: ml?.thumbnail || null,
        permalink: ml?.permalink || null,
        vel_7d: si.vel_7d || 0,
        vel_30d: si.vel_30d || 0,
        vel_60d: si.vel_60d || 0,
        vel_ponderada: si.vel_ponderada || 0,
        stock_total: liveTotal,
        stock_full: liveFull,
        stock_bodega: liveBodega,
        cob_total: liveCobTotal,
        cob_full: liveCobFull,
        dias_sin_venta: diasSinVenta,
        margen_full_30d: si.margen_full_30d || 0,
        margen_flex_30d: si.margen_flex_30d || 0,
        cuadrante: si.cuadrante,
        precio_actual: ml?.price || 0,
        costo_promedio: costo,
        cantidad_publicaciones_ml: mlCounts.get(si.sku_origen) || 0,
        cubeta,
        antiguedad_muerto_bucket: cubeta === "muerto" ? calcularAntiguedadMuerto(diasSinVenta) : null,
        impacto_clp: Math.round(impacto),
        es_holdout: si.es_holdout || false,
        semana_calculo: semana,
      });
    }

    // 8. Write to semaforo_semanal (delete current week + insert)
    await sb.from("semaforo_semanal").delete().eq("semana_calculo", semana);
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("semaforo_semanal").insert(rows.slice(i, i + 500));
      if (error) console.error("[semaforo] Insert error:", error.message);
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

    // Weekly KPIs from ml_velocidad_semanal
    const weekStart = new Date(semana);
    weekStart.setDate(weekStart.getDate() - 7);
    const { data: velRows } = await sb
      .from("ml_velocidad_semanal")
      .select("unidades, ingreso")
      .gte("semana_inicio", weekStart.toISOString().slice(0, 10))
      .lt("semana_inicio", semana);

    const unidadesSemana = (velRows || []).reduce((s, r) => s + (r.unidades || 0), 0);
    const revenueSemana = (velRows || []).reduce((s, r) => s + (r.ingreso || 0), 0);

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
