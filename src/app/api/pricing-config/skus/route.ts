import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET   /api/pricing-config/skus -> lista enriquecida (productos + cuadrante semaforo + flags)
 * PATCH /api/pricing-config/skus -> body { sku, ...campos } (override por SKU)
 *
 * Override jerarquico: BANVA_Pricing_Investigacion_Comparada §6.2.
 */

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const [{ data: productos }, { data: semaforo }] = await Promise.all([
    sb.from("productos").select(
      "sku, nombre, categoria, proveedor, costo, costo_promedio, precio, " +
      "precio_piso, margen_minimo_pct, politica_pricing, es_kvi, auto_postular, estado_sku"
    ),
    sb.from("semaforo_semanal").select("sku_origen, cuadrante, abc_ingreso, cubeta, vel_ponderada, stock_total, margen_full_30d, precio_actual")
      .order("semana_calculo", { ascending: false }),
  ]);

  const semaforoBySku = new Map<string, {
    cuadrante: string | null; abc: string | null; cubeta: string | null;
    vel_ponderada: number | null; stock_total: number | null;
    margen_full_30d: number | null; precio_actual: number | null;
  }>();
  for (const r of (semaforo || []) as Array<{ sku_origen: string; cuadrante: string | null; abc_ingreso: string | null; cubeta: string | null; vel_ponderada: number | null; stock_total: number | null; margen_full_30d: number | null; precio_actual: number | null }>) {
    if (!semaforoBySku.has(r.sku_origen)) {
      semaforoBySku.set(r.sku_origen, {
        cuadrante: r.cuadrante, abc: r.abc_ingreso, cubeta: r.cubeta,
        vel_ponderada: r.vel_ponderada, stock_total: r.stock_total,
        margen_full_30d: r.margen_full_30d, precio_actual: r.precio_actual,
      });
    }
  }

  const rows = (productos || []).map((p: Record<string, unknown>) => ({
    ...p,
    ...(semaforoBySku.get(p.sku as string) || {
      cuadrante: null, abc: null, cubeta: null,
      vel_ponderada: null, stock_total: null,
      margen_full_30d: null, precio_actual: null,
    }),
  }));

  return NextResponse.json({ rows, count: rows.length });
}

export async function PATCH(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const body = await req.json();
  const { sku, ...campos } = body as Record<string, unknown> & { sku?: string };
  if (!sku) return NextResponse.json({ error: "sku_required" }, { status: 400 });
  const allowed = new Set([
    "precio_piso", "margen_minimo_pct", "politica_pricing", "es_kvi", "auto_postular",
  ]);
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (allowed.has(k)) update[k] = v === "" ? null : v;
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  update.updated_at = new Date().toISOString();
  const { error } = await sb.from("productos").update(update).eq("sku", sku);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Audit
  await sb.from("admin_actions_log").insert({
    accion: "pricing_config:sku_override",
    entidad: "productos",
    entidad_id: sku,
    detalle: { update },
  });
  return NextResponse.json({ ok: true, sku, fields_updated: Object.keys(update) });
}
