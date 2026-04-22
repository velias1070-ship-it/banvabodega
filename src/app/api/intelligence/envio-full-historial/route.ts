import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/intelligence/envio-full-historial
 * Lista ultimos N envios a Full (cabeceras).
 *
 * GET /api/intelligence/envio-full-historial?id=UUID
 * Detalle de un envio especifico (cabecera + lineas).
 *
 * Panel AdminInteligencia renderiza el historial dentro de la vista "Envio a Full".
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "Sin conexion a Supabase" }, { status: 500 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const { data: cab, error: errCab } = await sb
      .from("envios_full_historial")
      .select("id, picking_session_id, fecha, total_skus, total_uds_venta, total_uds_fisicas, total_bultos, evento_activo, multiplicador_evento, created_at")
      .eq("id", id)
      .single();
    if (errCab || !cab) return NextResponse.json({ error: errCab?.message || "No encontrado" }, { status: 404 });

    const { data: lineas, error: errLin } = await sb
      .from("envios_full_lineas")
      .select("sku_venta, sku_origen, cantidad_sugerida, cantidad_enviada, fue_editada, abc, vel_ponderada, stock_full_antes, stock_bodega_antes, cob_full_antes, inner_pack, alertas")
      .eq("envio_id", id)
      .order("cantidad_enviada", { ascending: false });
    if (errLin) return NextResponse.json({ error: errLin.message }, { status: 500 });

    return NextResponse.json({ cabecera: cab, lineas: lineas || [] });
  }

  // Listado de cabeceras (ultimos 30)
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30", 10), 100);
  const { data, error } = await sb
    .from("envios_full_historial")
    .select("id, picking_session_id, fecha, total_skus, total_uds_venta, total_uds_fisicas, total_bultos, evento_activo, multiplicador_evento, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cabeceras: data || [] });
}
