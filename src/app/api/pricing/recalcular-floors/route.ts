import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  calcularFloor, resolverPricingConfig,
  type CanalLogistico, type PricingCuadranteConfig,
} from "@/lib/pricing";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/pricing/recalcular-floors
 *
 * Cron diario 11:30am que cubre los SKUs sin promos disponibles para evaluar
 * (que el motor de auto-postular nunca evalua porque no tiene promos
 * candidate). Para esos SKUs inserta una fila en auto_postulacion_log con
 * decision='baseline_warming' para que la vista v_precio_piso_actual los
 * cubra junto con los SKUs que sí tienen promos evaluadas.
 *
 * Manual: inventory-policy.md Regla 5 (no duplicar fuente). El floor lo
 * calcula y persiste auto-postular cada vez que evalua una promo. Este cron
 * solo cubre el gap (~262 SKUs sin promos disponibles hoy).
 */

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const isManualTrigger = req.nextUrl.searchParams.get("manual") === "1";
  return isVercelCron || isLocalDev || isManualTrigger;
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const start = Date.now();
  const stats = {
    productos_evaluados: 0,
    pisos_calculados: 0,
    skipped_sin_costo: 0,
    skipped_sin_listing: 0,
    skipped_descontinuado: 0,
    skipped_ya_evaluado_hoy: 0,
    errores: 0,
  };
  const muestra: Array<Record<string, unknown>> = [];

  // 1. Cargar config por cuadrante
  const cuadrantesConfig = new Map<string, PricingCuadranteConfig>();
  {
    const { data: ccRows } = await sb.from("pricing_cuadrante_config").select(
      "cuadrante, margen_min_pct, politica_default, acos_objetivo_pct, descuento_max_pct, descuento_max_kvi_pct, canal_preferido"
    );
    for (const r of (ccRows || []) as PricingCuadranteConfig[]) {
      cuadrantesConfig.set(r.cuadrante, r);
    }
  }
  const defaultCuadrante = cuadrantesConfig.get("_DEFAULT") || null;

  // 2. SKUs ya evaluados hoy por auto-postular (skip para no duplicar)
  const hoyISO = new Date().toISOString().slice(0, 10);
  const skusEvaluadosHoy = new Set<string>();
  {
    const { data: logHoy } = await sb.from("auto_postulacion_log")
      .select("sku")
      .gte("fecha", hoyISO);
    for (const r of (logHoy || []) as Array<{ sku: string }>) {
      skusEvaluadosHoy.add(r.sku);
    }
  }

  // 3. Productos activos
  const { data: prods, error: ePr } = await sb.from("productos")
    .select("sku, costo, costo_promedio, precio_piso, margen_minimo_pct, politica_pricing, es_kvi, auto_postular, estado_sku");
  if (ePr) return NextResponse.json({ error: ePr.message }, { status: 500 });
  const productos = (prods || []) as Array<{
    sku: string; costo: number | null; costo_promedio: number | null;
    precio_piso: number | null; margen_minimo_pct: number | null;
    politica_pricing: string | null; es_kvi: boolean; auto_postular: boolean;
    estado_sku: string | null;
  }>;

  // 4. ml_margin_cache (listing principal por SKU)
  const { data: cacheRows, error: eCache } = await sb.from("ml_margin_cache")
    .select("sku, item_id, status_ml, price_ml, precio_venta, costo_neto, peso_facturable, comision_pct, envio_clp, logistic_type, stock_total")
    .eq("status_ml", "active");
  if (eCache) return NextResponse.json({ error: eCache.message }, { status: 500 });
  type CacheRow = {
    sku: string; item_id: string; price_ml: number | null;
    precio_venta: number | null; costo_neto: number | null;
    peso_facturable: number | null; comision_pct: number | null;
    envio_clp: number | null; logistic_type: string | null;
    stock_total: number | null;
  };
  const principalBySku = new Map<string, CacheRow>();
  for (const r of (cacheRows || []) as unknown as CacheRow[]) {
    const cur = principalBySku.get(r.sku);
    const stockNuevo = r.stock_total ?? 0;
    const stockCur = cur?.stock_total ?? -1;
    if (!cur || stockNuevo > stockCur) principalBySku.set(r.sku, r);
  }

  // 5. Cuadrante por SKU
  const cuadranteBySku = new Map<string, string | null>();
  {
    const { data: intel } = await sb.from("sku_intelligence")
      .select("sku_origen, cuadrante");
    for (const r of (intel || []) as Array<{ sku_origen: string; cuadrante: string | null }>) {
      cuadranteBySku.set(r.sku_origen, r.cuadrante);
    }
  }

  // 6. Para cada SKU sin evaluacion hoy, calcular floor e insertar en log
  const inserts: Array<Record<string, unknown>> = [];
  for (const p of productos) {
    stats.productos_evaluados++;
    if (p.estado_sku === "descontinuado") { stats.skipped_descontinuado++; continue; }
    if (skusEvaluadosHoy.has(p.sku)) { stats.skipped_ya_evaluado_hoy++; continue; }

    const costoNeto = p.costo_promedio || p.costo || 0;
    if (costoNeto <= 0) { stats.skipped_sin_costo++; continue; }

    const principal = principalBySku.get(p.sku);
    if (!principal) { stats.skipped_sin_listing++; continue; }

    const cuadrante = cuadranteBySku.get(p.sku) ?? null;
    const cuadranteRow = cuadrante ? cuadrantesConfig.get(cuadrante) || defaultCuadrante : defaultCuadrante;
    const resolved = resolverPricingConfig(
      {
        precio_piso: p.precio_piso ?? null,
        margen_minimo_pct: p.margen_minimo_pct ?? null,
        politica_pricing: p.politica_pricing ?? null,
        es_kvi: p.es_kvi ?? false,
        auto_postular: p.auto_postular ?? false,
      },
      cuadranteRow ?? null,
      defaultCuadrante,
    );

    const canal: CanalLogistico = principal.logistic_type === "fulfillment" ? "full"
      : principal.logistic_type === "self_service" ? "flex"
      : "unknown";
    const precioRef = principal.precio_venta || principal.price_ml || 20000;
    const adsObj = Math.round(precioRef * (resolved.acos_objetivo_pct ?? 0) / 100);

    try {
      const { floor, desglose } = calcularFloor({
        costoNeto,
        precioReferencia: precioRef,
        pesoGr: principal.peso_facturable || 0,
        comisionPct: Number(principal.comision_pct) || 0,
        canal,
        costoEnvioFullUnit: canal === "full" ? (principal.envio_clp || 0) : 0,
        adsFraccionUnit: adsObj,
        margenMinimoFrac: resolved.margen_min_frac,
      });
      if (!isFinite(floor) || floor <= 0) { stats.errores++; continue; }
      stats.pisos_calculados++;

      inserts.push({
        sku: p.sku,
        canal: "ml",
        item_id: principal.item_id,
        promo_id: null,
        promo_type: "_baseline",
        promo_name: "_baseline_warming",
        decision: "baseline_warming",
        motivo: `baseline cron · floor ${floor} · margen ${resolved.margen_min_pct}%${resolved.es_kvi ? " · KVI" : ""}`,
        precio_objetivo: floor,
        precio_actual: precioRef,
        floor_calculado: floor,
        margen_proyectado_pct: resolved.margen_min_pct,
        modo: "baseline",
        contexto: {
          canal,
          cuadrante,
          es_kvi: resolved.es_kvi,
          politica: resolved.politica,
          margen_min_pct_aplicado: resolved.margen_min_pct,
          margen_min_fuente: resolved.fuente.margen,
          politica_fuente: resolved.fuente.politica,
          descuento_max_aplicado: resolved.descuento_max_pct,
          acos_objetivo_pct: resolved.acos_objetivo_pct,
          ads_fraccion_objetivo: adsObj,
          comision_pct: Number(principal.comision_pct) || 0,
          desglose_floor: {
            costoNetoConIva: desglose.costoNetoConIva,
            comisionClp: desglose.comisionClp,
            envioClp: desglose.envioClp,
            adsClp: desglose.adsClp,
            margenMinClp: desglose.margenMinClp,
          },
          ads_modelo: "forward_acos_objetivo",
          fuente_calculo: "cron_pricing_recalcular_floors",
        },
      });

      if (muestra.length < 10) {
        muestra.push({ sku: p.sku, cuadrante, floor, precio_actual: precioRef, espacio_pct: precioRef > 0 ? Math.round((1 - floor / precioRef) * 1000) / 10 : null });
      }
    } catch (e) {
      stats.errores++;
      console.error(`[recalcular-floors] error sku=${p.sku}: ${e}`);
    }
  }

  // 7. Insert batch
  for (let i = 0; i < inserts.length; i += 200) {
    const chunk = inserts.slice(i, i + 200);
    const { error } = await sb.from("auto_postulacion_log").insert(chunk);
    if (error) {
      console.error(`[recalcular-floors] insert batch error: ${error.message}`);
      stats.errores += chunk.length;
    }
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - start,
    stats,
    muestra,
  });
}
