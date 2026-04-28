import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/pricing/elasticidad-historica?dias=14
 *
 * Cruza ml_price_history con ventas_ml_cache para construir, por cada
 * cambio de precio significativo (|delta_pct| > 1%), una observación
 * (delta_precio_pct, delta_uds_pct) que permite estimar elasticidad.
 *
 * Manual Investigacion_Comparada:631: "synthetic control sobre los ~30
 * SKUs más vendidos: cambios ±5-10% en ventanas 4 semanas con pre-period
 * ≥8 semanas". Hoy todavía no tenemos 8 semanas de historia (arrancó
 * 2026-04-25), pero el endpoint queda listo para cuando se acumule.
 *
 * Para cada cambio:
 *   - uds_pre = unidades vendidas en (T-N, T)
 *   - uds_post = unidades vendidas en (T, T+N)
 *   - delta_uds_pct = (uds_post - uds_pre) / max(uds_pre, 1)
 *   - elasticidad = delta_uds_pct / delta_precio_pct (si |delta_precio_pct| > 0)
 *
 * Filtros:
 *   - dias: ventana pre/post (default 14)
 *   - sku: filtrar por sku específico
 *   - cuadrante: filtrar por cuadrante (extraído del contexto)
 */

type Cambio = {
  id: string;
  sku_origen: string;
  item_id: string;
  precio_anterior: number | null;
  precio: number;
  delta_pct: number | null;
  fuente: string;
  detected_at: string;
  cuadrante: string | null;
  uds_pre: number;
  uds_post: number;
  gmv_pre: number;
  gmv_post: number;
  delta_uds_pct: number | null;
  elasticidad: number | null;
  ventana_dias: number;
  contexto: Record<string, unknown> | null;
};

export async function GET(req: Request) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const ventana = Math.max(1, Math.min(60, Number(url.searchParams.get("dias") || "14")));
  const filtroSku = url.searchParams.get("sku");
  const filtroCuad = url.searchParams.get("cuadrante");
  const minDeltaPct = Number(url.searchParams.get("min_delta_pct") || "1");

  // 1. Cambios de precio significativos
  let q = sb
    .from("ml_price_history")
    .select("id, sku_origen, item_id, precio_anterior, precio, delta_pct, fuente, detected_at, contexto")
    .not("sku_origen", "is", null)
    .not("delta_pct", "is", null)
    .order("detected_at", { ascending: false })
    .limit(500);
  if (filtroSku) q = q.eq("sku_origen", filtroSku);
  const { data: cambios, error } = await q;
  if (error) {
    console.error(`[elasticidad-historica] history error: ${error.message}`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const filas = (cambios || []) as Array<{
    id: string;
    sku_origen: string;
    item_id: string;
    precio_anterior: number | null;
    precio: number;
    delta_pct: number | null;
    fuente: string;
    detected_at: string;
    contexto: Record<string, unknown> | null;
  }>;

  // 2. Para cada cambio, traer ventas pre/post
  const out: Cambio[] = [];
  for (const c of filas) {
    if (c.delta_pct == null || Math.abs(c.delta_pct) < minDeltaPct) continue;
    const cuad = (c.contexto?.cuadrante as string | undefined) ?? null;
    if (filtroCuad && cuad !== filtroCuad) continue;

    const t0 = new Date(c.detected_at);
    const tPre = new Date(t0.getTime() - ventana * 86400_000);
    const tPost = new Date(t0.getTime() + ventana * 86400_000);

    const { data: ventas } = await sb
      .from("ventas_ml_cache")
      .select("subtotal, fecha")
      .eq("sku_venta", c.sku_origen)
      .eq("anulada", false)
      .gte("fecha", tPre.toISOString())
      .lt("fecha", tPost.toISOString());

    let uds_pre = 0, uds_post = 0, gmv_pre = 0, gmv_post = 0;
    for (const v of (ventas || []) as Array<{ subtotal: number | null; fecha: string }>) {
      const f = new Date(v.fecha);
      if (f < t0) {
        uds_pre += 1;
        gmv_pre += Number(v.subtotal || 0);
      } else {
        uds_post += 1;
        gmv_post += Number(v.subtotal || 0);
      }
    }

    const delta_uds_pct = uds_pre > 0 ? ((uds_post - uds_pre) / uds_pre) * 100 : null;
    const elasticidad = delta_uds_pct != null && c.delta_pct != null && Math.abs(c.delta_pct) > 0.01
      ? Math.round((delta_uds_pct / c.delta_pct) * 100) / 100
      : null;

    out.push({
      id: c.id,
      sku_origen: c.sku_origen,
      item_id: c.item_id,
      precio_anterior: c.precio_anterior,
      precio: c.precio,
      delta_pct: c.delta_pct,
      fuente: c.fuente,
      detected_at: c.detected_at,
      cuadrante: cuad,
      uds_pre,
      uds_post,
      gmv_pre: Math.round(gmv_pre),
      gmv_post: Math.round(gmv_post),
      delta_uds_pct: delta_uds_pct != null ? Math.round(delta_uds_pct * 10) / 10 : null,
      elasticidad,
      ventana_dias: ventana,
      contexto: c.contexto,
    });
  }

  // 3. Resumen global
  const conElasticidad = out.filter((o) => o.elasticidad != null);
  const elasticidadMedia = conElasticidad.length
    ? Math.round((conElasticidad.reduce((s, o) => s + (o.elasticidad ?? 0), 0) / conElasticidad.length) * 100) / 100
    : null;

  // Resumen por cuadrante
  type Acc = { n: number; sum_e: number; con_e: number };
  const porCuad = new Map<string, Acc>();
  for (const o of out) {
    const k = o.cuadrante || "_SIN_CUADRANTE";
    const a = porCuad.get(k) || { n: 0, sum_e: 0, con_e: 0 };
    a.n += 1;
    if (o.elasticidad != null) {
      a.sum_e += o.elasticidad;
      a.con_e += 1;
    }
    porCuad.set(k, a);
  }
  const resumen_cuadrante = Array.from(porCuad.entries()).map(([cuadrante, a]) => ({
    cuadrante,
    cambios: a.n,
    cambios_con_elasticidad: a.con_e,
    elasticidad_media: a.con_e > 0 ? Math.round((a.sum_e / a.con_e) * 100) / 100 : null,
  })).sort((a, b) => a.cuadrante.localeCompare(b.cuadrante));

  return NextResponse.json({
    ok: true,
    ventana_dias: ventana,
    total_cambios: out.length,
    cambios_con_elasticidad: conElasticidad.length,
    elasticidad_media_global: elasticidadMedia,
    nota: "Manual Investigacion_Comparada:631 sugiere ≥8 semanas pre-period. ml_price_history arrancó 2026-04-25 — todavía hay poco historial. La elasticidad reportada hoy es indicativa, no estadísticamente robusta hasta acumular varios meses.",
    resumen_cuadrante,
    cambios: out,
  });
}
