import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { VALLE_MUERTE_MIN, VALLE_MUERTE_MAX } from "@/lib/pricing";
import { loadActiveRuleSet, readRule, logDecision, type MarkdownLadder, type ValleMuerte } from "@/lib/pricing-rules";
import { mlPut, logPriceChange } from "@/lib/ml";
import { queryUltimaVentaPorSkuOrigen } from "@/lib/intelligence-queries";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/pricing/markdown-auto?modo=dry_run
 *
 * Trigger markdown automático por días sin venta. Manual:
 *   Inv_P3 §Roadmap #2 + Investigacion_Comparada §4.3 (3 manuales coinciden):
 *   90d  sin venta → markdown -20%
 *   120d sin venta → markdown -40%
 *   180d sin venta → liquidar -60%
 *
 * Filtros obligatorios:
 *   - stock_total > 0 (sin stock no hay nada para markdownear)
 *   - listing activo en ML (necesario para PUT /items)
 *   - precio_actual > 0
 *   - markdown no cae en valle muerte $19.990-$23.000
 *   - markdown >= floor del cuadrante (excepción REVISAR margen 0%)
 *   - SKU no tiene auto_postular=false (override manual respeta opt-out)
 *
 * Modos:
 *   dry_run (default): lista candidatos, no toca precios.
 *   apply: ejecuta PUT a ML para cada SKU. Bloqueado todavía (TODO).
 */

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const isManualTrigger = req.nextUrl.searchParams.get("manual") === "1";
  return isVercelCron || isLocalDev || isManualTrigger;
}

type Candidato = {
  sku: string;
  nombre: string;
  cuadrante: string | null;
  stock: number;
  ultima_venta: string;
  dias_sin_venta: number;
  nivel_markdown: number; // negativo: -20, -40, -60... configurable via rule set
  precio_actual: number;
  precio_markdown: number;
  motivo: string;
  bloqueado_por: string[];
  decision: "candidato" | "skip";
};

// Defaults si el rule set no carga (defensivo). Reflejan el manual:
// Investigacion_Comparada:197 (90/120/180 + descuentos -20/-40/-60).
const FALLBACK_LADDER: MarkdownLadder = {
  min_dias_para_postular: 90,
  niveles: [
    { dias_min: 90,  descuento_pct: 20 },
    { dias_min: 120, descuento_pct: 40 },
    { dias_min: 180, descuento_pct: 60 },
  ],
};
const FALLBACK_VALLE: ValleMuerte = {
  min_clp: VALLE_MUERTE_MIN,
  max_clp: VALLE_MUERTE_MAX,
};

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

  const url = new URL(req.url);
  const modo: "dry_run" | "apply" = url.searchParams.get("modo") === "apply" ? "apply" : "dry_run";
  const filtroSku = (url.searchParams.get("sku") || "").trim().toUpperCase() || null;
  const confirmApply = url.searchParams.get("confirm") === "1";
  const start = Date.now();

  // Cargar rule set activo (cache 60s). Fallback a defaults si falla.
  const rs = await loadActiveRuleSet();
  const ladder = readRule<MarkdownLadder>(rs?.rules ?? {}, "markdown_ladder", FALLBACK_LADDER);
  const valle  = readRule<ValleMuerte>(rs?.rules  ?? {}, "valle_muerte",    FALLBACK_VALLE);
  // Ordenar niveles desc por dias_min: el primero que matchea es el descuento mas agresivo.
  const nivelesDesc = [...ladder.niveles].sort((a, b) => b.dias_min - a.dias_min);

  // 1. Última venta por sku_origen.
  // Fuente primaria: ventas_ml_cache via composicion_venta (cubre historia
  // larga >1 ano). Mergeamos despues con la RPC ultima_venta_por_sku_origen
  // si está disponible (orders_history reciente puede tener ventas más nuevas
  // que ventas_ml_cache si la cache se actualiza con lag).
  let ultimaVentaPorSku = await queryUltimaVentaPorSkuOrigen();

  const { data: ventasRaw, error: eVentas } = await sb.rpc("ultima_venta_por_sku_origen");
  if (!eVentas && Array.isArray(ventasRaw)) {
    for (const r of ventasRaw as Array<{ sku_origen: string; ultima_venta: string }>) {
      const k = (r.sku_origen || "").trim().toUpperCase();
      const f = (r.ultima_venta || "").slice(0, 10);
      if (!k || !f) continue;
      const cur = ultimaVentaPorSku.get(k);
      if (!cur || f > cur) ultimaVentaPorSku.set(k, f);
    }
  } else {
    // Fallback: query manual paginada (la RPC quizás no existe).
    const { data: ords } = await sb.from("orders_history")
      .select("sku_venta, fecha")
      .eq("estado", "Pagada")
      .gte("fecha", new Date(Date.now() - 365 * 86400_000).toISOString());
    const { data: comp } = await sb.from("composicion_venta")
      .select("sku_venta, sku_origen");
    const skuVentaToOrigen = new Map<string, string>();
    for (const c of (comp || []) as Array<{ sku_venta: string; sku_origen: string }>) {
      skuVentaToOrigen.set(c.sku_venta, c.sku_origen);
    }
    for (const o of (ords || []) as Array<{ sku_venta: string; fecha: string }>) {
      const origen = skuVentaToOrigen.get(o.sku_venta);
      if (!origen) continue;
      const fecha = (o.fecha || "").slice(0, 10);
      const cur = ultimaVentaPorSku.get(origen);
      if (!cur || fecha > cur) ultimaVentaPorSku.set(origen, fecha);
    }
  }

  // 2. Productos activos
  const { data: prods } = await sb.from("productos")
    .select("sku, nombre, costo_promedio, auto_postular, estado_sku, precio_piso");
  const productos = (prods || []) as Array<{
    sku: string; nombre: string; costo_promedio: number | null;
    auto_postular: boolean; estado_sku: string | null; precio_piso: number | null;
  }>;

  // 3. ml_margin_cache para precio actual + listing activo
  const { data: cacheRows } = await sb.from("ml_margin_cache")
    .select("sku, item_id, precio_venta, price_ml, status_ml, stock_total")
    .eq("status_ml", "active");
  const principalBySku = new Map<string, { item_id: string; precio: number; stock: number }>();
  for (const r of (cacheRows || []) as Array<{ sku: string; item_id: string; precio_venta: number | null; price_ml: number | null; stock_total: number | null }>) {
    const cur = principalBySku.get(r.sku);
    const stockNuevo = r.stock_total ?? 0;
    if (!cur || stockNuevo > cur.stock) {
      principalBySku.set(r.sku, {
        item_id: r.item_id,
        precio: r.precio_venta || r.price_ml || 0,
        stock: stockNuevo,
      });
    }
  }

  // 4. Cuadrante para auditoría
  const cuadranteBySku = new Map<string, string | null>();
  {
    const { data: intel } = await sb.from("sku_intelligence").select("sku_origen, cuadrante");
    for (const r of (intel || []) as Array<{ sku_origen: string; cuadrante: string | null }>) {
      cuadranteBySku.set(r.sku_origen, r.cuadrante);
    }
  }

  // 5. Evaluar cada SKU
  const hoy = new Date();
  const candidatos: Candidato[] = [];
  const stats = { evaluados: 0, sin_venta: 0, candidatos_real: 0, bloqueados: 0, sin_listing: 0, sin_stock: 0, sin_costo: 0, descontinuados: 0 };

  for (const p of productos) {
    if (filtroSku && p.sku.trim().toUpperCase() !== filtroSku) continue;
    stats.evaluados++;
    if (p.estado_sku === "descontinuado") { stats.descontinuados++; continue; }
    // El helper devuelve keys UPPER. Normalizar el lookup también.
    const ultimaStr = ultimaVentaPorSku.get(p.sku.trim().toUpperCase());
    if (!ultimaStr) { stats.sin_venta++; continue; }

    const ultimaDate = new Date(ultimaStr + "T00:00:00Z");
    const diasSinVenta = Math.floor((hoy.getTime() - ultimaDate.getTime()) / 86400_000);
    if (diasSinVenta < ladder.min_dias_para_postular) continue;

    // Match al primer nivel cuyo dias_min sea <= diasSinVenta (recorrido desc).
    let nivelMarkdown = -ladder.niveles[0].descuento_pct;
    for (const n of nivelesDesc) {
      if (diasSinVenta >= n.dias_min) {
        nivelMarkdown = -n.descuento_pct;
        break;
      }
    }

    const principal = principalBySku.get(p.sku);
    const stock = principal?.stock ?? 0;
    const precioActual = principal?.precio ?? 0;

    const bloqueadoPor: string[] = [];
    if (!principal) { stats.sin_listing++; bloqueadoPor.push("sin_listing_activo"); }
    if (stock <= 0) { stats.sin_stock++; bloqueadoPor.push(`stock=${stock}`); }
    if (precioActual <= 0) bloqueadoPor.push("precio_actual=0");
    if (!p.costo_promedio || p.costo_promedio <= 0) { stats.sin_costo++; bloqueadoPor.push("sin_costo"); }
    if (!p.auto_postular && nivelMarkdown <= -40) bloqueadoPor.push("auto_postular=false (nivel >=120d requiere opt-in)");

    const factor = (100 + nivelMarkdown) / 100;
    let precioMarkdown = Math.round(precioActual * factor);

    // Respetar precio_piso manual si está seteado
    if (p.precio_piso && precioMarkdown < p.precio_piso) {
      bloqueadoPor.push(`precio_piso_manual: $${precioMarkdown} < $${p.precio_piso}`);
    }
    // Valle muerte (rango leído del rule set)
    if (precioMarkdown > valle.min_clp && precioMarkdown < valle.max_clp) {
      bloqueadoPor.push(`valle_muerte: $${precioMarkdown} en $${valle.min_clp}-$${valle.max_clp}`);
    }

    const decision: "candidato" | "skip" = bloqueadoPor.length > 0 ? "skip" : "candidato";
    if (decision === "candidato") stats.candidatos_real++;
    else stats.bloqueados++;

    candidatos.push({
      sku: p.sku,
      nombre: p.nombre,
      cuadrante: cuadranteBySku.get(p.sku) ?? null,
      stock,
      ultima_venta: ultimaStr,
      dias_sin_venta: diasSinVenta,
      nivel_markdown: nivelMarkdown,
      precio_actual: precioActual,
      precio_markdown: precioMarkdown,
      motivo: `${diasSinVenta}d sin venta → markdown ${nivelMarkdown}%`,
      bloqueado_por: bloqueadoPor,
      decision,
    });
  }

  // Visibilidad: qué rule set decidió.
  const rule_set_meta = rs ? {
    version_label: rs.version_label,
    content_hash: rs.content_hash.slice(0, 12),
    channel: "production",
    using_fallback: false,
  } : { version_label: "FALLBACK_HARDCODED", content_hash: null, channel: null, using_fallback: true };

  // 6. Apply real: solo permitido como PILOTO en 1 SKU especifico
  // (?modo=apply&sku=XXX&confirm=1). Esta restricción evita aplicar masivo
  // sin validar manual primero. Cuando se decida masivo, se levanta este gate.
  if (modo === "apply") {
    if (!filtroSku) {
      return NextResponse.json({
        modo, rule_set: rule_set_meta, stats, candidatos: candidatos.length, duration_ms: Date.now() - start,
        nota: "APPLY masivo bloqueado. Para piloto en 1 SKU usar ?modo=apply&sku=XXX&confirm=1.",
      });
    }
    if (!confirmApply) {
      return NextResponse.json({
        modo, rule_set: rule_set_meta, stats, candidatos, duration_ms: Date.now() - start,
        nota: `APPLY a SKU ${filtroSku} requiere confirm=1. Revisar candidato dry_run primero.`,
      });
    }
    const cand = candidatos.find(c => c.sku.trim().toUpperCase() === filtroSku && c.decision === "candidato");
    if (!cand) {
      return NextResponse.json({
        modo, rule_set: rule_set_meta, stats, candidatos, duration_ms: Date.now() - start,
        nota: `SKU ${filtroSku} no es candidato valido (skip o no encontrado). No se aplica nada.`,
      }, { status: 422 });
    }
    const principalCand = principalBySku.get(cand.sku);
    if (!principalCand) {
      return NextResponse.json({
        modo, rule_set: rule_set_meta, error: "principal_listing_missing", sku: cand.sku,
      }, { status: 422 });
    }

    // Ejecutar PUT a ML
    const result = await mlPut<{ id: string; status: string; price: number }>(
      `/items/${principalCand.item_id}`,
      { price: cand.precio_markdown }
    );
    if (!result) {
      return NextResponse.json({
        modo, rule_set: rule_set_meta, error: "ml_put_failed",
        sku: cand.sku, item_id: principalCand.item_id, precio_target: cand.precio_markdown,
      }, { status: 502 });
    }

    // Persistir cambio en ml_items_map y ml_price_history
    if (sb) {
      await sb.from("ml_items_map")
        .update({ price: result.price, updated_at: new Date().toISOString() })
        .eq("item_id", principalCand.item_id);

      await logPriceChange({
        item_id: principalCand.item_id,
        sku: cand.sku,
        precio: result.price,
        precio_anterior: cand.precio_actual,
        fuente: "markdown_auto_pilot",
        ejecutado_por: "pilot_apply",
        contexto: {
          dias_sin_venta: cand.dias_sin_venta,
          nivel_markdown: cand.nivel_markdown,
          rule_set_hash: rs?.content_hash,
          motivo: cand.motivo,
        },
      });

      await logDecision({
        sku_origen: cand.sku,
        domain: "global",
        rule_set_hash: rs?.content_hash || "FALLBACK",
        channel: "production",
        inputs: {
          dias_sin_venta: cand.dias_sin_venta,
          stock: cand.stock,
          precio_actual: cand.precio_actual,
          cuadrante: cand.cuadrante,
        },
        decision: {
          accion: "markdown_apply_pilot",
          nivel_markdown: cand.nivel_markdown,
          precio_markdown: cand.precio_markdown,
          precio_aplicado: result.price,
          item_id: principalCand.item_id,
        },
        applied: true,
      });
    }

    return NextResponse.json({
      modo, rule_set: rule_set_meta, ladder_aplicado: ladder, valle_muerte_aplicado: valle,
      duration_ms: Date.now() - start,
      pilot_apply: {
        sku: cand.sku,
        item_id: principalCand.item_id,
        precio_anterior: cand.precio_actual,
        precio_aplicado: result.price,
        precio_target: cand.precio_markdown,
        nivel_markdown: cand.nivel_markdown,
        dias_sin_venta: cand.dias_sin_venta,
        ml_status: result.status,
      },
      candidato: cand,
    });
  }

  return NextResponse.json({
    modo,
    rule_set: rule_set_meta,
    ladder_aplicado: ladder,
    valle_muerte_aplicado: valle,
    duration_ms: Date.now() - start,
    stats,
    candidatos: candidatos.sort((a, b) => b.dias_sin_venta - a.dias_sin_venta),
  });
}
