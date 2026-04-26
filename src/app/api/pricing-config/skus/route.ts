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

  // Lectura desde sku_intelligence (granularidad sku_origen, refresco diario).
  // Antes leiamos semaforo_semanal pero esa tabla es por item_id ML (multiple
  // filas por sku_origen) y solo se actualiza los lunes — datos hasta 7d
  // stale. Manual confirma que la decision de cuadrante vive en sku_intelligence
  // (intelligence.ts:1749) y semaforo solo lo copia (BANVA_Pricing_Investigacion_Comparada §6.2).
  const [prodRes, intelRes, pisoRes] = await Promise.all([
    sb.from("productos").select(
      "sku, nombre, categoria, proveedor, costo, costo_promedio, precio, " +
      "precio_piso, margen_minimo_pct, politica_pricing, es_kvi, auto_postular, estado_sku"
    ),
    sb.from("sku_intelligence").select(
      "sku_origen, cuadrante, abc, abc_ingreso, abc_unidades, xyz, " +
      "vel_ponderada, stock_total, margen_full_30d, precio_promedio, " +
      "dias_en_quiebre, factor_rampup_aplicado"
    ),
    // Vista derivada por canal: hoy filtramos canal='ml'.
    // Cuando agreguemos Falabella/D2C, reemplazar este select por
    // múltiples (uno por canal) o devolver array de pisos por canal.
    sb.from("v_precio_piso_por_canal").select(
      "sku, canal, precio_piso_calculado, calculado_at, decision, contexto"
    ).eq("canal", "ml"),
  ]);
  if (prodRes.error) {
    return NextResponse.json({ error: `productos: ${prodRes.error.message}` }, { status: 500 });
  }
  if (intelRes.error) {
    console.error(`[pricing-config/skus] sku_intelligence error: ${intelRes.error.message}`);
  }
  if (pisoRes.error) {
    console.error(`[pricing-config/skus] v_precio_piso_actual error: ${pisoRes.error.message}`);
  }
  const productos = (prodRes.data || []) as unknown as Array<Record<string, unknown>>;
  const intel = (intelRes.data || []) as unknown as Array<{
    sku_origen: string; cuadrante: string | null; abc: string | null;
    abc_ingreso: string | null; abc_unidades: string | null; xyz: string | null;
    vel_ponderada: number | null; stock_total: number | null;
    margen_full_30d: number | null; precio_promedio: number | null;
    dias_en_quiebre: number | null; factor_rampup_aplicado: number | null;
  }>;
  const pisos = (pisoRes.data || []) as unknown as Array<{
    sku: string; precio_piso_calculado: number | null;
    calculado_at: string | null; decision: string | null;
    contexto: Record<string, unknown> | null;
  }>;

  const intelBySku = new Map<string, typeof intel[number]>();
  for (const r of intel) intelBySku.set(r.sku_origen, r);
  const pisoBySku = new Map<string, typeof pisos[number]>();
  for (const r of pisos) pisoBySku.set(r.sku, r);

  const rows = productos.map(p => {
    const i = intelBySku.get(p.sku as string);
    const piso = pisoBySku.get(p.sku as string);
    return {
      ...p,
      cuadrante: i?.cuadrante ?? null,
      abc: i?.abc ?? null,
      abc_ingreso: i?.abc_ingreso ?? null,
      abc_unidades: i?.abc_unidades ?? null,
      xyz: i?.xyz ?? null,
      vel_ponderada: i?.vel_ponderada ?? null,
      stock_total: i?.stock_total ?? null,
      margen_full_30d: i?.margen_full_30d ?? null,
      precio_actual: i?.precio_promedio ?? null,
      dias_en_quiebre: i?.dias_en_quiebre ?? null,
      factor_rampup: i?.factor_rampup_aplicado ?? null,
      precio_piso_calculado: piso?.precio_piso_calculado ?? null,
      precio_piso_calculado_at: piso?.calculado_at ?? null,
      precio_piso_calculado_inputs: piso?.contexto ?? null,
      precio_piso_decision: piso?.decision ?? null,
    };
  });

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
