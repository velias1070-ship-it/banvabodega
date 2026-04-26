import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  evaluarGates, margenPostAds, resolverPricingConfig,
  type CanalLogistico, type PricingCuadranteConfig,
} from "@/lib/pricing";

export const maxDuration = 300;

/**
 * GET /api/ml/auto-postular
 *
 * Devuelve el resumen + decisiones del ultimo dry-run (agrupado por hora
 * de corrida). Si no hay ejecuciones, devuelve arrays vacios.
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // Ultimo run = ventana de 5 min desde el log mas reciente
  const { data: ultimo } = await sb
    .from("auto_postulacion_log")
    .select("fecha")
    .order("fecha", { ascending: false })
    .limit(1);
  if (!ultimo || ultimo.length === 0) {
    return NextResponse.json({
      last_run: null,
      total: 0,
      decisiones: { postular: 0, skipear: 0, error: 0 },
      motivos: [],
      filas: [],
    });
  }
  const lastRunAt = (ultimo[0] as { fecha: string }).fecha;
  const since = new Date(new Date(lastRunAt).getTime() - 5 * 60000).toISOString();

  const { data: rows, error } = await sb
    .from("auto_postulacion_log")
    .select("id, fecha, sku, item_id, promo_name, promo_type, decision, motivo, precio_objetivo, precio_actual, floor_calculado, margen_proyectado_pct, modo, contexto")
    .gte("fecha", since)
    .order("sku", { ascending: true })
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filas = (rows || []) as Array<{
    id: string;
    fecha: string;
    sku: string;
    item_id: string | null;
    promo_name: string | null;
    promo_type: string | null;
    decision: string;
    motivo: string;
    precio_objetivo: number | null;
    precio_actual: number | null;
    floor_calculado: number | null;
    margen_proyectado_pct: number | null;
    modo: string;
    contexto: Record<string, unknown> | null;
  }>;

  const decisiones = { postular: 0, skipear: 0, error: 0 };
  const motivosMap = new Map<string, number>();
  for (const r of filas) {
    const d = r.decision.replace("dry_run_", "");
    if (d === "postular") decisiones.postular++;
    else if (d === "skipear") decisiones.skipear++;
    else if (d === "error") decisiones.error++;
    if (d === "skipear") {
      const tipo = r.motivo.split(":")[0]?.trim() || "otro";
      motivosMap.set(tipo, (motivosMap.get(tipo) || 0) + 1);
    }
  }
  const motivos = Array.from(motivosMap.entries())
    .map(([tipo, count]) => ({ tipo, count }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    last_run: lastRunAt,
    total: filas.length,
    decisiones,
    motivos,
    filas,
  });
}

/**
 * POST /api/ml/auto-postular
 *
 * Motor de postulacion automatica — dry-run por default. Para cada par
 * (item activo en ML × promo candidate), evalua los gates economicos +
 * regulatorios y decide postular/skipear. Loguea cada decision en
 * auto_postulacion_log para auditoria.
 *
 * Body JSON:
 * {
 *   "modo": "dry_run" | "apply"                (default dry_run)
 *   "scope": "all" | "auto_postular_only"       (default all para dry_run,
 *                                                auto_postular_only para apply)
 *   "promo_name": string?                        (filtra a una sola promo)
 *   "sku": string?                               (filtra a un solo SKU)
 *   "limit": number?                             (cap de items procesados,
 *                                                default 100 dry, 50 apply)
 * }
 *
 * Respuesta:
 * {
 *   total_items_evaluados: number
 *   decisiones: { postular: N, skipear: N, error: N }
 *   muestra: [{sku, promo, decision, motivo, precio_objetivo, margen}]
 *   log_ids: string[]
 * }
 */

type PromoPostulable = { name: string; type: string; id: string | null; min: number; max: number; suggested: number };

type MarginCacheRow = {
  item_id: string;
  sku: string;
  titulo: string;
  status_ml: string | null;
  price_ml: number;
  precio_venta: number;
  costo_neto: number;
  costo_bruto: number;
  peso_facturable: number;
  comision_pct: number;
  envio_clp: number;
  logistic_type: string | null;
  tiene_promo: boolean;
  promo_name: string | null;
  stock_total: number | null;
  promos_postulables: PromoPostulable[] | null;
};

type ProductoPolicy = {
  sku: string;
  costo: number;
  costo_promedio: number;
  es_kvi: boolean;
  margen_minimo_pct: number;
  politica_pricing: "defender" | "seguir" | "exprimir" | "liquidar";
  precio_piso: number | null;
  auto_postular: boolean;
};

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const modo: "dry_run" | "apply" = body.modo === "apply" ? "apply" : "dry_run";
  const scope: "all" | "auto_postular_only" = body.scope === "all"
    ? "all"
    : modo === "dry_run" ? "all" : "auto_postular_only";
  const promoNameFilter: string | undefined = body.promo_name;
  const skuFilter: string | undefined = body.sku;
  const limit = Math.min(parseInt(body.limit || "0", 10) || (modo === "apply" ? 50 : 100), 500);

  // 1. Cargar margin cache — solo activos en ML con promos candidate disponibles
  let query = sb
    .from("ml_margin_cache")
    .select("item_id, sku, titulo, status_ml, price_ml, precio_venta, costo_neto, costo_bruto, peso_facturable, comision_pct, envio_clp, logistic_type, tiene_promo, promo_name, stock_total, promos_postulables")
    .eq("status_ml", "active");
  if (skuFilter) query = query.eq("sku", skuFilter);
  const { data: cacheData, error: eCache } = await query;
  if (eCache) return NextResponse.json({ error: eCache.message }, { status: 500 });

  const cache: MarginCacheRow[] = (cacheData || []) as unknown as MarginCacheRow[];

  // 2. Cargar policy de productos
  const skus = Array.from(new Set(cache.map(r => r.sku)));
  const policyMap = new Map<string, ProductoPolicy>();
  if (skus.length > 0) {
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data: prods } = await sb
        .from("productos")
        .select("sku, costo, costo_promedio, es_kvi, margen_minimo_pct, politica_pricing, precio_piso, auto_postular")
        .in("sku", chunk);
      for (const p of (prods || []) as ProductoPolicy[]) policyMap.set(p.sku, p);
    }
  }

  // 3a. Cargar cobertura (y cuadrante) desde sku_intelligence
  const coberturaMap = new Map<string, { cob_total: number | null; cuadrante: string | null }>();
  if (skus.length > 0) {
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data: intel } = await sb
        .from("sku_intelligence")
        .select("sku_origen, cob_total, cuadrante")
        .in("sku_origen", chunk);
      for (const r of (intel || []) as Array<{ sku_origen: string; cob_total: number | null; cuadrante: string | null }>) {
        coberturaMap.set(r.sku_origen, { cob_total: r.cob_total, cuadrante: r.cuadrante });
      }
    }
  }

  // 3a.bis Cargar config por cuadrante (defaults editables desde tab Pricing
  // Config). Cascada que aplica resolverPricingConfig: SKU > cuadrante > _DEFAULT.
  // Manual: BANVA_Pricing_Investigacion_Comparada §6.2 (defaults por cuadrante).
  const cuadrantesConfigMap = new Map<string, PricingCuadranteConfig>();
  {
    const { data: ccRows } = await sb.from("pricing_cuadrante_config").select(
      "cuadrante, margen_min_pct, politica_default, acos_objetivo_pct, descuento_max_pct, descuento_max_kvi_pct, canal_preferido"
    );
    for (const r of (ccRows || []) as PricingCuadranteConfig[]) {
      cuadrantesConfigMap.set(r.cuadrante, r);
    }
  }
  const defaultCuadrante = cuadrantesConfigMap.get("_DEFAULT") || null;

  // 3b. Cargar ads fraccion por SKU (promedio ads_cost_asignado / unidades en 30d)
  const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const adsFraccionBySku = new Map<string, number>();
  const { data: adsRows } = await sb
    .from("ventas_ml_cache")
    .select("sku_venta, cantidad, ads_cost_asignado, anulada")
    .gte("fecha_date", sinceIso);
  const acc = new Map<string, { uds: number; ads: number }>();
  for (const r of (adsRows || []) as Array<{ sku_venta: string; cantidad: number; ads_cost_asignado: number | null; anulada: boolean | null }>) {
    if (r.anulada) continue;
    if (!r.sku_venta) continue;
    const cur = acc.get(r.sku_venta) || { uds: 0, ads: 0 };
    cur.uds += r.cantidad || 0;
    cur.ads += r.ads_cost_asignado || 0;
    acc.set(r.sku_venta, cur);
  }
  Array.from(acc.entries()).forEach(([sku, v]) => {
    if (v.uds > 0) adsFraccionBySku.set(sku, Math.round(v.ads / v.uds));
  });

  // 4. Evaluar cada par (item × promo candidate)
  const decisiones = { postular: 0, skipear: 0, error: 0 };
  const muestra: Array<{ sku: string; promo: string; decision: string; motivo: string; precio_objetivo: number; margen_pct: number | null }> = [];
  const logRows: Array<Record<string, unknown>> = [];

  let procesados = 0;
  for (const row of cache) {
    if (procesados >= limit) break;
    const policy = policyMap.get(row.sku);
    const intel = coberturaMap.get(row.sku);

    // Resolver pricing por cascada: SKU override > cuadrante config > _DEFAULT.
    // Habilita que ediciones en tab Pricing Config se apliquen automaticamente.
    const cuadranteRow = intel?.cuadrante ? cuadrantesConfigMap.get(intel.cuadrante) || defaultCuadrante : defaultCuadrante;
    const resolved = resolverPricingConfig(
      policy ? {
        precio_piso: policy.precio_piso ?? null,
        margen_minimo_pct: policy.margen_minimo_pct ?? null,
        politica_pricing: policy.politica_pricing ?? null,
        es_kvi: policy.es_kvi ?? false,
        auto_postular: policy.auto_postular ?? false,
      } : null,
      cuadranteRow ?? null,
      defaultCuadrante,
    );

    // Gate pre-motor: scope apply exige flag explicito
    if (scope === "auto_postular_only" && !resolved.auto_postular) continue;

    const promos = row.promos_postulables || [];
    if (promos.length === 0) continue;

    for (const promo of promos) {
      if (promoNameFilter && promo.name !== promoNameFilter && promo.type !== promoNameFilter) continue;
      procesados++;
      if (procesados > limit) break;

      // Precio objetivo: default = suggested de ML, fallback = max del rango
      const precioObjetivo = promo.suggested > 0
        ? promo.suggested
        : promo.max > 0 ? promo.max : row.precio_venta;

      const canal: CanalLogistico = row.logistic_type === "fulfillment" ? "full"
        : row.logistic_type === "self_service" ? "flex"
        : "unknown";
      const costoNeto = policy?.costo_promedio || policy?.costo || row.costo_neto || 0;

      // Ads fraccion = forward-looking (ACOS objetivo del cuadrante × precio_objetivo).
      // Antes usabamos realizado historico 30d (adsFraccionBySku); cambio a
      // forward-looking para que el motor sea predictivo, no reactivo
      // (BANVA_Pricing_Investigacion_Comparada §4.4: "Max CPC = AOV × CVR × Target
      // ACOS — not realized, target"). El realizado se conserva en contexto
      // para auditoria del gap forward vs realized.
      const acosObjPct = resolved.acos_objetivo_pct ?? 0;
      const adsFraccionObjetivo = Math.round(precioObjetivo * acosObjPct / 100);
      const adsFraccionRealizado = adsFraccionBySku.get(row.sku) || 0;

      const gateInputs = {
        costoNeto,
        precioReferencia: precioObjetivo,
        pesoGr: row.peso_facturable || 0,
        comisionPct: Number(row.comision_pct) || 0,
        canal,
        costoEnvioFullUnit: canal === "full" ? (row.envio_clp || 0) : 0,
        adsFraccionUnit: adsFraccionObjetivo,
        margenMinimoFrac: resolved.margen_min_frac,
        precioObjetivo,
        precioPisoManual: resolved.precio_piso_manual,
        esKvi: resolved.es_kvi,
        precioLista: row.price_ml,
        politica: resolved.politica,
        coberturaDias: intel?.cob_total ?? null,
      };

      // Gates adicionales fuera del lib/pricing.ts: stock LIGHTNING + sin costo
      const hardExtras: string[] = [];
      if (costoNeto <= 0) hardExtras.push("sin_costo: productos.costo=0 y productos.costo_promedio=0");
      if (/LIGHTNING/i.test(promo.type)) {
        const st = row.stock_total ?? 0;
        if (st < 5 || st > 15) hardExtras.push(`lightning_stock: ${st} fuera de 5-15`);
      }
      // Rango de la propia promo
      if (promo.min > 0 && precioObjetivo < promo.min) hardExtras.push(`promo_rango: ${precioObjetivo} < min ${promo.min}`);
      if (promo.max > 0 && precioObjetivo > promo.max) hardExtras.push(`promo_rango: ${precioObjetivo} > max ${promo.max}`);
      // Gate descuento_max_pct configurable por cuadrante (Pricing Config)
      if (resolved.descuento_max_pct != null && row.price_ml > 0) {
        const descPct = ((row.price_ml - precioObjetivo) / row.price_ml) * 100;
        if (descPct > resolved.descuento_max_pct) {
          hardExtras.push(`descuento_max_cuadrante: ${descPct.toFixed(1)}% > ${resolved.descuento_max_pct}% permitido para cuadrante ${intel?.cuadrante || "_DEFAULT"}`);
        }
      }

      const gate = evaluarGates(gateInputs);
      const bloquea = [...hardExtras, ...gate.motivosBloqueo];
      const pasa = bloquea.length === 0;

      const margenProyFrac = margenPostAds(precioObjetivo, gateInputs);
      const margenProyPct = margenProyFrac !== null ? Math.round(margenProyFrac * 10000) / 100 : null;

      const decision = modo === "apply"
        ? (pasa ? "postular" : "skipear")
        : (pasa ? "dry_run_postular" : "dry_run_skipear");

      if (pasa) decisiones.postular++;
      else decisiones.skipear++;

      const motivo = pasa
        ? `ok · floor ${gate.floor} · margen ${margenProyPct}%${gate.warnings.length ? " · " + gate.warnings.join(" · ") : ""}`
        : bloquea.join(" | ");

      logRows.push({
        sku: row.sku,
        canal: "ml",
        item_id: row.item_id,
        promo_id: promo.id,
        promo_type: promo.type,
        promo_name: promo.name,
        decision,
        motivo,
        precio_objetivo: precioObjetivo,
        precio_actual: row.precio_venta,
        floor_calculado: gate.floor,
        margen_proyectado_pct: margenProyPct,
        modo,
        contexto: {
          canal,
          stock_total: row.stock_total,
          cobertura_dias: intel?.cob_total ?? null,
          cuadrante: intel?.cuadrante || null,
          es_kvi: resolved.es_kvi,
          politica: resolved.politica,
          margen_min_pct_aplicado: resolved.margen_min_pct,
          margen_min_fuente: resolved.fuente.margen,
          politica_fuente: resolved.fuente.politica,
          descuento_max_aplicado: resolved.descuento_max_pct,
          acos_objetivo_pct: acosObjPct,
          ads_fraccion_objetivo: adsFraccionObjetivo,
          ads_fraccion_realizado_30d: adsFraccionRealizado,
          ads_modelo: "forward_acos_objetivo",
          comision_pct: Number(row.comision_pct),
          titulo: row.titulo,
        },
      });

      if (muestra.length < 50) {
        muestra.push({
          sku: row.sku,
          promo: promo.name || promo.type,
          decision,
          motivo,
          precio_objetivo: precioObjetivo,
          margen_pct: margenProyPct,
        });
      }
    }
  }

  // 5. Bulk insert en log
  const logIds: string[] = [];
  if (logRows.length > 0) {
    for (let i = 0; i < logRows.length; i += 200) {
      const batch = logRows.slice(i, i + 200);
      const { data: inserted, error: eIns } = await sb
        .from("auto_postulacion_log")
        .insert(batch)
        .select("id");
      if (eIns) {
        return NextResponse.json({
          error: `log insert failed: ${eIns.message}`,
          parcial: { decisiones, muestra, logIds },
        }, { status: 500 });
      }
      for (const r of (inserted || []) as Array<{ id: string }>) logIds.push(r.id);
    }
  }

  // 6. En modo apply, ejecutar las postulaciones realmente
  // (POR AHORA: solo loguear, no ejecutar. El apply real se habilita en una
  // iteracion siguiente cuando el dry-run valide que las decisiones son correctas.)
  if (modo === "apply") {
    // TODO: ejecutar join a ML para filas con decision=postular.
    // Mantenemos seguro por ahora: el modo apply loguea pero no actualiza ML.
  }

  return NextResponse.json({
    modo,
    scope,
    total_items_evaluados: procesados,
    decisiones,
    muestra,
    log_insertadas: logIds.length,
    nota: modo === "apply"
      ? "APPLY en modo seguro: se loguearon decisiones pero NO se ejecutaron postulaciones en ML. Habilitar tras validar dry-run."
      : "Dry-run completado. Revisa auto_postulacion_log para ver todas las decisiones.",
  });
}
