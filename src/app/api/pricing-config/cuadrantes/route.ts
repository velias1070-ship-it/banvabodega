import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET   /api/pricing-config/cuadrantes  -> lista pricing_cuadrante_config
 * PATCH /api/pricing-config/cuadrantes  -> body { cuadrante, ...campos } (solo update)
 *
 * Defaults pricing por cuadrante BANVA. Override jerarquico documentado en
 * BANVA_Pricing_Ajuste_Plan §5 + Investigacion_Comparada §6.2.
 */

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const { data, error } = await sb.from("pricing_cuadrante_config").select("*").order("cuadrante");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data || [] });
}

export async function PATCH(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const body = await req.json();
  const { cuadrante, ...campos } = body as Record<string, unknown> & { cuadrante?: string };
  if (!cuadrante) return NextResponse.json({ error: "cuadrante_required" }, { status: 400 });
  const allowed = new Set([
    "margen_min_pct", "politica_default", "acos_objetivo_pct",
    "descuento_max_pct", "descuento_max_kvi_pct", "canal_preferido", "notas",
  ]);
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (allowed.has(k)) update[k] = v;
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  update.updated_at = new Date().toISOString();
  const { error } = await sb.from("pricing_cuadrante_config").update(update).eq("cuadrante", cuadrante);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, cuadrante, fields_updated: Object.keys(update) });
}
