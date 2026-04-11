import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/mp/cleanup-live
 * Borra movimientos importados por sync-live que tienen monto 0 o tipo "retiro_live"
 * y descripción que NO es un payout real (ventas, bonificaciones, etc).
 */
export async function POST() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    // Borrar todos los movimientos MercadoPago con monto = 0 y origen = api
    const { data: toDelete } = await sb
      .from("movimientos_banco")
      .select("id, descripcion, monto")
      .eq("banco", "MercadoPago")
      .eq("origen", "api")
      .eq("monto", 0);

    if (!toDelete || toDelete.length === 0) {
      return NextResponse.json({ ok: true, eliminados: 0, mensaje: "Nada que limpiar" });
    }

    const ids = toDelete.map(m => m.id);
    const { error } = await sb.from("movimientos_banco").delete().in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, eliminados: ids.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
