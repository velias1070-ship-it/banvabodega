import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/ml/item-history?item_id=MLC123
 * Devuelve historial de acciones registradas sobre un item ML:
 * postulaciones a promos, salidas, cambios de precio lista, errores.
 *
 * Lee de admin_actions_log filtrando por item_id y acciones ml_*.
 */
export async function GET(req: NextRequest) {
  const itemId = req.nextUrl.searchParams.get("item_id");
  if (!itemId) return NextResponse.json({ error: "item_id requerido" }, { status: 400 });

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data, error } = await sb.from("admin_actions_log")
    .select("id, accion, entidad_id, detalle, created_at")
    .eq("entidad_id", itemId)
    .or("accion.like.ml_promo%,accion.like.ml_item_update%")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ actions: data || [] });
}
