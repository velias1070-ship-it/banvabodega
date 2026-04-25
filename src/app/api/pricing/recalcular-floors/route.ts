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
 * Cron diario que recalcula productos.precio_piso_calculado para cada SKU
 * activo. Itera ml_margin_cache para encontrar el listing principal de cada
 * SKU (el de mas sold_quantity), aplica resolverPricingConfig + calcularFloor,
 * persiste resultado + inputs en JSONB para auditoria.
 *
 * Manual: BANVA_Pricing_Investigacion_Comparada §6.2 (reglas deterministicas
 * en WMS) + Inv_P3 §10. Repricer interno (no Ajuste Auto ML) porque BANVA
 * tiene 0 SKUs con catalog_listing=true.
 *
 * Auth: Bearer CRON_SECRET (cron Vercel) o NODE_ENV=development (local).
 */

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  // Tambien permitir trigger manual desde admin (sin auth header) para tests
  const isManualTrigger = req.nextUrl.searchParams.get("manual") === "1";
  return isVercelCron || isLocalDev || isManualTrigger;
}

export async function POST(req: NextRequest) {
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
    skipped_sin_intel: 0,
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

  // 2. Productos activos con costo
  const { data: prods, error: ePr } = await sb.from("productos")
    .select("sku, costo, costo_promedio, precio_piso, margen_minimo_pct, politica_pricing, es_kvi, auto_postular, estado_sku");
  if (ePr) return NextResponse.json({ error: ePr.message }, { status: 500 });
  const productos = (prods || []) as Array<{
    sku: string; costo: number | null; costo_promedio: number | null;
    precio_piso: number | null; margen_minimo_pct: number | null;
    politica_pricing: string | null; es_kvi: boolean; auto_postular: boolean;
    estado_sku: string | null;
  }>;

  // 3. ml_margin_cache (todos los listings activos) — agrupar por SKU,
  //    elegir el listing con mayor stock_total (proxy de "principal").
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

  // 4. Cuadrante por SKU desde sku_intelligence
  const cuadranteBySku = new Map<string, string | null>();
  {
    const { data: intel } = await sb.from("sku_intelligence")
      .select("sku_origen, cuadrante");
    for (const r of (intel || []) as Array<{ sku_origen: string; cuadrante: string | null }>) {
      cuadranteBySku.set(r.sku_origen, r.cuadrante);
    }
  }

  // 5. Iterar productos y calcular floor
  const updates: Array<{ sku: string; precio_piso_calculado: number; precio_piso_calculado_at: string; precio_piso_calculado_inputs: Record<string, unknown> }> = [];
  for (const p of productos) {
    stats.productos_evaluados++;
    if (p.estado_sku === "descontinuado") continue;

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

    // Ads forward-looking: precio_referencia × ACOS objetivo (cuadrante)
    const precioRef = principal.precio_venta || principal.price_ml || 20000;
    const adsObj = Math.round(precioRef * (resolved.acos_objetivo_pct ?? 0) / 100);

    const inputs = {
      costoNeto,
      precioReferencia: precioRef,
      pesoGr: principal.peso_facturable || 0,
      comisionPct: Number(principal.comision_pct) || 0,
      canal,
      costoEnvioFullUnit: canal === "full" ? (principal.envio_clp || 0) : 0,
      adsFraccionUnit: adsObj,
      margenMinimoFrac: resolved.margen_min_frac,
    };

    try {
      const { floor, desglose } = calcularFloor(inputs);
      if (!isFinite(floor) || floor <= 0) { stats.errores++; continue; }
      stats.pisos_calculados++;
      updates.push({
        sku: p.sku,
        precio_piso_calculado: floor,
        precio_piso_calculado_at: new Date().toISOString(),
        precio_piso_calculado_inputs: {
          item_id: principal.item_id,
          cuadrante,
          margen_min_pct: resolved.margen_min_pct,
          margen_min_fuente: resolved.fuente.margen,
          acos_objetivo_pct: resolved.acos_objetivo_pct,
          canal,
          costoNeto,
          costoNetoConIva: desglose.costoNetoConIva,
          comisionClp: desglose.comisionClp,
          envioClp: desglose.envioClp,
          adsClp: desglose.adsClp,
          margenMinClp: desglose.margenMinClp,
          precio_referencia: precioRef,
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

  // 6. Persistir en chunks (upsert por sku)
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200);
    for (const u of chunk) {
      const { error } = await sb.from("productos").update({
        precio_piso_calculado: u.precio_piso_calculado,
        precio_piso_calculado_at: u.precio_piso_calculado_at,
        precio_piso_calculado_inputs: u.precio_piso_calculado_inputs,
      }).eq("sku", u.sku);
      if (error) {
        console.error(`[recalcular-floors] update error sku=${u.sku}: ${error.message}`);
        stats.errores++;
      }
    }
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - start,
    stats,
    muestra,
  });
}
