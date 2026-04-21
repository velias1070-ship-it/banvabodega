import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * PATCH /api/intelligence/sku/{sku_origen}/flex-objetivo
 * Toggle manual del flag flex_objetivo en productos.
 * Body: { flex_objetivo: boolean }
 *
 * Side effects:
 *   - flex_objetivo_auto pasa a false (el valor fue validado por humano)
 *   - flex_objetivo_motivo se etiqueta como 'manual_YYYY-MM-DD'
 *
 * PR2 del sprint estructura Flex/Full. No toca el motor ni los cálculos —
 * solo persiste el flag. El consumo viene en PR3 (calcularEstadoFlexFull).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sku_origen: string }> },
) {
  try {
    const { sku_origen } = await params;
    const body = await req.json();
    const flexObjetivo = Boolean(body.flex_objetivo);

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const motivo = `manual_${hoy}`;

    const { data: updated, error } = await sb
      .from("productos")
      .update({
        flex_objetivo: flexObjetivo,
        flex_objetivo_auto: false,
        flex_objetivo_motivo: motivo,
      })
      .eq("sku", sku_origen)
      .select("sku, flex_objetivo, flex_objetivo_auto, flex_objetivo_motivo")
      .maybeSingle();

    if (error) {
      console.error(`[flex-objetivo] update failed for ${sku_origen}: ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: "SKU no encontrado en productos" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      sku: updated.sku,
      flex_objetivo: updated.flex_objetivo,
      flex_objetivo_auto: updated.flex_objetivo_auto,
      flex_objetivo_motivo: updated.flex_objetivo_motivo,
    });
  } catch (err) {
    console.error("[flex-objetivo] unhandled error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
