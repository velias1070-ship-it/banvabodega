import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { queryLeadTimeReal } from "@/lib/intelligence-queries";

export const dynamic = "force-dynamic";

/**
 * GET /api/intelligence/actualizar-lead-times
 *
 * Cron semanal (lunes 12 UTC = 9 AM Chile). Calcula LT real promedio + sigma
 * por proveedor desde OCs cerradas con fecha_recepcion poblada, y actualiza
 * la tabla `proveedores` cuando hay >=3 muestras (suficiente para confiar).
 *
 * Hoy (sin OCs cerradas) probablemente no actualice nada. Conforme Vicente
 * use el flujo OC → recepción, el cron irá poblando los LT reales.
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const ltReal = await queryLeadTimeReal();
  const updates: Array<{ proveedor: string; lt: number; sigma: number; muestras: number }> = [];
  const skipped: Array<{ proveedor: string; muestras: number; razon: string }> = [];

  ltReal.forEach((stats, proveedor) => {
    if (stats.muestras < 3) {
      skipped.push({ proveedor, muestras: stats.muestras, razon: "muestras_insuficientes" });
      return;
    }
    updates.push({
      proveedor,
      lt: stats.lead_time_dias,
      sigma: stats.lead_time_sigma_dias,
      muestras: stats.muestras,
    });
  });

  let aplicados = 0;
  for (const u of updates) {
    const { error } = await sb.from("proveedores")
      .update({
        lead_time_dias: u.lt,
        lead_time_sigma_dias: u.sigma,
        lead_time_fuente: "oc_real",
        lead_time_muestras: u.muestras,
        lead_time_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("nombre", u.proveedor);
    if (!error) aplicados++;
  }

  return NextResponse.json({
    ok: true,
    proveedores_evaluados: ltReal.size,
    actualizados: aplicados,
    skipped,
    detalle: updates,
  });
}
