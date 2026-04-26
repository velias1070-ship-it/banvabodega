import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { VALLE_MUERTE_MIN, VALLE_MUERTE_MAX } from "@/lib/pricing";

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
  nivel_markdown: -20 | -40 | -60;
  precio_actual: number;
  precio_markdown: number;
  motivo: string;
  bloqueado_por: string[];
  decision: "candidato" | "skip";
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
  const start = Date.now();

  // 1. Última venta por sku_origen vía composicion_venta + orders_history
  const { data: ventasRaw, error: eVentas } = await sb.rpc("ultima_venta_por_sku_origen");
  let ultimaVentaPorSku = new Map<string, string>();
  if (!eVentas && Array.isArray(ventasRaw)) {
    for (const r of ventasRaw as Array<{ sku_origen: string; ultima_venta: string }>) {
      ultimaVentaPorSku.set(r.sku_origen, r.ultima_venta);
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
    stats.evaluados++;
    if (p.estado_sku === "descontinuado") { stats.descontinuados++; continue; }
    const ultimaStr = ultimaVentaPorSku.get(p.sku);
    if (!ultimaStr) { stats.sin_venta++; continue; }

    const ultimaDate = new Date(ultimaStr + "T00:00:00Z");
    const diasSinVenta = Math.floor((hoy.getTime() - ultimaDate.getTime()) / 86400_000);
    if (diasSinVenta < 90) continue;

    let nivelMarkdown: -20 | -40 | -60;
    if (diasSinVenta >= 180) nivelMarkdown = -60;
    else if (diasSinVenta >= 120) nivelMarkdown = -40;
    else nivelMarkdown = -20;

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
    // Valle muerte
    if (precioMarkdown > VALLE_MUERTE_MIN && precioMarkdown < VALLE_MUERTE_MAX) {
      bloqueadoPor.push(`valle_muerte: $${precioMarkdown} en $${VALLE_MUERTE_MIN}-$${VALLE_MUERTE_MAX}`);
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

  // 6. Apply real bloqueado por ahora (TODO)
  if (modo === "apply") {
    return NextResponse.json({
      modo, stats, candidatos: candidatos.length, duration_ms: Date.now() - start,
      nota: "APPLY bloqueado en este endpoint. Validar dry-run primero. Habilitar en una iteración siguiente cuando los candidatos sean revisados.",
    });
  }

  return NextResponse.json({
    modo,
    duration_ms: Date.now() - start,
    stats,
    candidatos: candidatos.sort((a, b) => b.dias_sin_venta - a.dias_sin_venta),
  });
}
