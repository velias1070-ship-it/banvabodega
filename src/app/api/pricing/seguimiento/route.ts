/**
 * /api/pricing/seguimiento — estado de cada SKU con cambio de precio reciente.
 *
 * Manuales:
 *   - Op_Limpieza:521 KPI #3 Sell-through 14d/30d (uds_post / stock_al_inicio_md)
 *   - Op_Limpieza:522 KPI #4 Velocity Lift (vel_post_14d / vel_pre_14d, target ≥1.5×)
 *   - Op_Limpieza:498 ventana credibilidad MLC 30d (no subir post-MD)
 *   - Op_Limpieza:402 pausar profundización si lift ≥2×
 *   - Comparada:285 regla 30-day rolling (Buy Box suppression)
 *   - Engines:411 input_snapshot en pricing_decision_log para auditoría
 *
 * Sin tabla nueva: deriva al vuelo de
 *   ml_price_history (eventos colapsados via collapseSwapBlips)
 *   ventas_ml_cache  (uds pre/post)
 *   ml_margin_cache  (stock al T0 aproximado: stock_actual + uds_post)
 *
 * Read-only: NO aplica nada.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { collapseSwapBlips, type PriceHistoryRow } from "@/lib/pricing";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const VENTANA_EVAL_DIAS = 30;   // bloqueo subir post-MD (Op_Limpieza:498)
const VENTANA_LIFT_DIAS = 14;   // ventana medición lift (Op_Limpieza:522)
const MIN_DELTA_PCT_BAJADA = -5; // bajadas significativas

type Estado = "en_eval" | "exitoso" | "marginal" | "sin_lift" | "indeterminado" | "expirado";

interface SeguimientoRow {
  sku: string;
  titulo: string | null;
  cuadrante: string | null;
  abc: string | null;
  precio_pre: number;
  precio_post: number;
  delta_pct: number;
  fuente_cambio: string;
  ejecutado_por: string | null;
  t0: string;
  dias_desde_md: number;
  dias_restantes_lift: number;     // hasta cierre ventana 14d
  dias_restantes_eval: number;     // hasta cierre ventana 30d
  uds_pre_14d: number;
  uds_post_actuales: number;       // uds vendidas desde T0 hasta hoy
  uds_post_14d: number | null;     // proyección lineal a 14d (null si <2d)
  vel_pre: number;                 // uds/dia 14d antes
  vel_post: number | null;         // uds/dia desde T0 hasta hoy (null si dias=0)
  lift: number | null;             // vel_post / vel_pre
  stock_al_t0: number;
  stock_actual: number;
  sell_through: number | null;     // uds_post / stock_al_t0
  estado: Estado;
  recomendacion: string;
  margen_pct_actual: number | null;
}

export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const sp = req.nextUrl.searchParams;
  const skuFilter = sp.get("sku")?.toUpperCase().trim();
  const estadoFilter = sp.get("estado") as Estado | null;
  const incluirExpirados = sp.get("incluir_expirados") === "1";

  const hoy = Date.now();
  const sinceVentanaEval = new Date(hoy - VENTANA_EVAL_DIAS * 86400000).toISOString();
  const sinceLargo = new Date(hoy - 2 * VENTANA_LIFT_DIAS * 86400000).toISOString(); // 28d para tener pre completo

  // 1. Eventos de bajada en ventana de evaluación, colapsando blips de promo-swap.
  let phQuery = sb.from("ml_price_history")
    .select("item_id, sku, sku_origen, precio, precio_anterior, delta_pct, fuente, ejecutado_por, detected_at")
    .gte("detected_at", sinceLargo);
  if (skuFilter) phQuery = phQuery.eq("sku", skuFilter);
  const { data: priceHistRaw, error: phErr } = await phQuery;
  if (phErr) {
    console.error(`[seguimiento] ml_price_history query failed: ${phErr.message}`);
    return NextResponse.json({ error: phErr.message }, { status: 500 });
  }
  const priceHist = collapseSwapBlips((priceHistRaw || []) as PriceHistoryRow[]);

  // Última bajada significativa por SKU dentro de la ventana de evaluación.
  type Cambio = {
    sku: string;
    item_id: string;
    sku_origen: string;
    precio_pre: number;
    precio_post: number;
    delta_pct: number;
    fuente: string;
    ejecutado_por: string | null;
    t0: string;
  };
  const ultimaBajadaBySku = new Map<string, Cambio>();
  for (const e of priceHist) {
    if (!e.sku) continue;
    if (e.delta_pct == null || e.delta_pct >= MIN_DELTA_PCT_BAJADA) continue;
    if (e.detected_at < sinceVentanaEval) continue;
    const cambio: Cambio = {
      sku: e.sku,
      item_id: e.item_id,
      sku_origen: e.sku_origen ?? e.sku,
      precio_pre: Number(e.precio_anterior ?? 0),
      precio_post: Number(e.precio),
      delta_pct: Number(e.delta_pct),
      fuente: String(e.fuente),
      ejecutado_por: e.ejecutado_por ?? null,
      t0: e.detected_at,
    };
    const cur = ultimaBajadaBySku.get(e.sku);
    if (!cur || cambio.t0 > cur.t0) ultimaBajadaBySku.set(e.sku, cambio);
  }

  if (ultimaBajadaBySku.size === 0) {
    return NextResponse.json({
      ventana_eval_dias: VENTANA_EVAL_DIAS,
      ventana_lift_dias: VENTANA_LIFT_DIAS,
      total: 0,
      seguimiento: [],
    });
  }

  const skus = Array.from(ultimaBajadaBySku.keys());

  // 2. Cargar ventas en ventana [T0_min - 14d, hoy].
  const t0Min = Math.min(...Array.from(ultimaBajadaBySku.values()).map(c => new Date(c.t0).getTime()));
  const ventanaPreInicio = new Date(t0Min - VENTANA_LIFT_DIAS * 86400000).toISOString();
  const { data: ventasRows, error: vErr } = await sb.from("ventas_ml_cache")
    .select("sku_venta, fecha, cantidad, anulada")
    .in("sku_venta", skus)
    .eq("anulada", false)
    .gte("fecha", ventanaPreInicio);
  if (vErr) {
    console.error(`[seguimiento] ventas_ml_cache query failed: ${vErr.message}`);
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }
  type Venta = { sku_venta: string; fecha: string; cantidad: number };
  const ventasBySku = new Map<string, Venta[]>();
  for (const v of (ventasRows || []) as Venta[]) {
    if (!v.sku_venta) continue;
    const arr = ventasBySku.get(v.sku_venta) ?? [];
    arr.push(v);
    ventasBySku.set(v.sku_venta, arr);
  }

  // 3. Cargar margin_cache + intelligence + productos para contexto.
  const [{ data: cacheRows }, { data: intelRows }, { data: prodRows }] = await Promise.all([
    sb.from("ml_margin_cache").select("sku, titulo, stock_total, margen_pct").in("sku", skus),
    sb.from("sku_intelligence").select("sku_origen, cuadrante, abc").in("sku_origen", skus),
    sb.from("productos").select("sku, costo, costo_promedio").in("sku", skus),
  ]);
  const cacheBySku = new Map<string, { titulo: string | null; stock_total: number; margen_pct: number | null }>();
  for (const r of (cacheRows || []) as Array<{ sku: string; titulo: string | null; stock_total: number | null; margen_pct: number | null }>) {
    cacheBySku.set(r.sku, {
      titulo: r.titulo,
      stock_total: Number(r.stock_total ?? 0),
      margen_pct: r.margen_pct,
    });
  }
  const intelBySku = new Map<string, { cuadrante: string | null; abc: string | null }>();
  for (const r of (intelRows || []) as Array<{ sku_origen: string; cuadrante: string | null; abc: string | null }>) {
    intelBySku.set(r.sku_origen, { cuadrante: r.cuadrante, abc: r.abc });
  }

  // 4. Construir filas de seguimiento.
  const seguimiento: SeguimientoRow[] = [];
  for (const [sku, cambio] of Array.from(ultimaBajadaBySku.entries())) {
    const t0Ms = new Date(cambio.t0).getTime();
    const diasDesdeMd = Math.floor((hoy - t0Ms) / 86400000);
    const cache = cacheBySku.get(sku);
    const intel = intelBySku.get(sku) || intelBySku.get(cambio.sku_origen);
    const ventas = ventasBySku.get(sku) || [];

    let udsPre = 0, udsPost = 0;
    const tPreInicio = t0Ms - VENTANA_LIFT_DIAS * 86400000;
    for (const v of ventas) {
      const f = new Date(v.fecha).getTime();
      const cant = Number(v.cantidad) || 0;
      if (f >= tPreInicio && f < t0Ms) udsPre += cant;
      else if (f >= t0Ms) udsPost += cant;
    }

    const velPre = udsPre / VENTANA_LIFT_DIAS;
    const velPost = diasDesdeMd > 0 ? udsPost / diasDesdeMd : null;
    const lift = velPre > 0 && velPost != null ? velPost / velPre : null;
    const udsPost14Proj = diasDesdeMd >= 2
      ? Math.round((udsPost / diasDesdeMd) * VENTANA_LIFT_DIAS * 10) / 10
      : null;
    const stockActual = cache?.stock_total ?? 0;
    const stockAlT0 = stockActual + udsPost; // aproximación: lo vendido post salió del stock
    const sellThrough = stockAlT0 > 0 ? udsPost / stockAlT0 : null;

    let estado: Estado;
    let recomendacion: string;
    if (diasDesdeMd >= VENTANA_EVAL_DIAS) {
      estado = "expirado";
      recomendacion = "Ventana eval cerrada. Liberado para nuevas señales.";
    } else if (diasDesdeMd < VENTANA_LIFT_DIAS) {
      estado = "en_eval";
      recomendacion = `Esperar ${VENTANA_LIFT_DIAS - diasDesdeMd}d más antes de evaluar lift.`;
    } else if (velPre <= 0) {
      estado = "indeterminado";
      recomendacion = "No había base de venta en pre-period. Mantener baseline + observar otros 14d.";
    } else if (lift != null && lift >= 1.5) {
      estado = "exitoso";
      recomendacion = "Lift ≥1.5× — mantener nuevo baseline (Op_Limpieza KPI #4 cumple).";
    } else if (lift != null && lift >= 1.0) {
      estado = "marginal";
      recomendacion = "Lift entre 1.0× y 1.5× — rondar 4 sem antes de profundizar.";
    } else {
      estado = "sin_lift";
      recomendacion = "Lift <1.0× — profundizar al siguiente escalón (E2 -25/-30%) o salir del DEAL.";
    }

    seguimiento.push({
      sku,
      titulo: cache?.titulo ?? null,
      cuadrante: intel?.cuadrante ?? null,
      abc: intel?.abc ?? null,
      precio_pre: cambio.precio_pre,
      precio_post: cambio.precio_post,
      delta_pct: Math.round(cambio.delta_pct * 100) / 100,
      fuente_cambio: cambio.fuente,
      ejecutado_por: cambio.ejecutado_por,
      t0: cambio.t0,
      dias_desde_md: diasDesdeMd,
      dias_restantes_lift: Math.max(0, VENTANA_LIFT_DIAS - diasDesdeMd),
      dias_restantes_eval: Math.max(0, VENTANA_EVAL_DIAS - diasDesdeMd),
      uds_pre_14d: udsPre,
      uds_post_actuales: udsPost,
      uds_post_14d: udsPost14Proj,
      vel_pre: Math.round(velPre * 1000) / 1000,
      vel_post: velPost != null ? Math.round(velPost * 1000) / 1000 : null,
      lift: lift != null ? Math.round(lift * 100) / 100 : null,
      stock_al_t0: stockAlT0,
      stock_actual: stockActual,
      sell_through: sellThrough != null ? Math.round(sellThrough * 1000) / 1000 : null,
      estado,
      recomendacion,
      margen_pct_actual: cache?.margen_pct ?? null,
    });
  }

  // Filtros
  let filtered = seguimiento;
  if (estadoFilter) filtered = filtered.filter(r => r.estado === estadoFilter);
  if (!incluirExpirados) filtered = filtered.filter(r => r.estado !== "expirado");

  // Orden: en_eval primero (más recientes arriba), luego sin_lift, marginal, exitoso, indeterminado.
  const ord: Record<Estado, number> = {
    sin_lift: 0,
    marginal: 1,
    en_eval: 2,
    exitoso: 3,
    indeterminado: 4,
    expirado: 5,
  };
  filtered.sort((a, b) => {
    const oa = ord[a.estado], ob = ord[b.estado];
    if (oa !== ob) return oa - ob;
    return b.t0.localeCompare(a.t0);
  });

  return NextResponse.json({
    ventana_eval_dias: VENTANA_EVAL_DIAS,
    ventana_lift_dias: VENTANA_LIFT_DIAS,
    total: filtered.length,
    breakdown: {
      en_eval: seguimiento.filter(r => r.estado === "en_eval").length,
      exitoso: seguimiento.filter(r => r.estado === "exitoso").length,
      marginal: seguimiento.filter(r => r.estado === "marginal").length,
      sin_lift: seguimiento.filter(r => r.estado === "sin_lift").length,
      indeterminado: seguimiento.filter(r => r.estado === "indeterminado").length,
      expirado: seguimiento.filter(r => r.estado === "expirado").length,
    },
    seguimiento: filtered,
  });
}
