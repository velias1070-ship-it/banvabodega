import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/promos-eventos/auto-tag
 *
 * Re-aplica las reglas de pattern matching sobre todos los promo_name
 * presentes en ml_price_history. Idempotente: solo toca filas con
 * fuente_tag='auto'. Inserta nuevos promo_names que no estén en el
 * catálogo aún.
 *
 * Llamado por:
 *   - Cron diario (vercel.json)
 *   - Botón manual desde UI cuando se quiere refrescar tras editar reglas
 *
 * Response observable: { insertados, actualizados, sin_cambio }
 */
export async function POST() {
  return await ejecutar();
}
export async function GET() {
  return await ejecutar();
}

async function ejecutar() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data, error } = await sb.rpc("auto_tag_promos_eventos");
  if (error) {
    console.error("[auto-tag-promos] rpc failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const stats = (data as Array<{ insertados: number; actualizados: number; sin_cambio: number }>)?.[0] || { insertados: 0, actualizados: 0, sin_cambio: 0 };
  return NextResponse.json({ ok: true, ...stats });
}
