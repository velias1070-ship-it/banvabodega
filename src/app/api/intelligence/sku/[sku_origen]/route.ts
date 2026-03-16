import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * PATCH /api/intelligence/sku/{sku_origen}
 * Actualiza vel_objetivo y recalcula gap_vel_pct.
 * Body: { vel_objetivo: number }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sku_origen: string }> },
) {
  try {
    const { sku_origen } = await params;
    const body = await req.json();
    const velObjetivo = Number(body.vel_objetivo) || 0;

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // Leer vel_ponderada actual
    const { data: current } = await sb
      .from("sku_intelligence")
      .select("vel_ponderada")
      .eq("sku_origen", sku_origen)
      .single();

    if (!current) {
      return NextResponse.json({ error: "SKU no encontrado" }, { status: 404 });
    }

    const velPonderada = current.vel_ponderada || 0;
    const gapVelPct = velObjetivo > 0
      ? Math.round(((velPonderada - velObjetivo) / velObjetivo) * 10000) / 100
      : null;

    const { error } = await sb
      .from("sku_intelligence")
      .update({ vel_objetivo: velObjetivo, gap_vel_pct: gapVelPct })
      .eq("sku_origen", sku_origen);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, sku_origen, vel_objetivo: velObjetivo, gap_vel_pct: gapVelPct });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/intelligence/sku/{sku_origen}
 * Actualización masiva de vel_objetivo para múltiples SKUs.
 * Body: { updates: Array<{ sku_origen: string, vel_objetivo: number }> }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: { sku_origen: string; vel_objetivo: number }[] = body.updates || [];

    if (updates.length === 0) {
      return NextResponse.json({ error: "No hay updates" }, { status: 400 });
    }

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // Leer vel_ponderada de todos los SKUs afectados
    const skus = updates.map(u => u.sku_origen);
    const { data: currentRows } = await sb
      .from("sku_intelligence")
      .select("sku_origen, vel_ponderada")
      .in("sku_origen", skus);

    const velMap = new Map<string, number>();
    for (const row of (currentRows || [])) {
      velMap.set(row.sku_origen, row.vel_ponderada || 0);
    }

    let updated = 0;
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100);
      for (const u of chunk) {
        const velPonderada = velMap.get(u.sku_origen) || 0;
        const velObj = Number(u.vel_objetivo) || 0;
        const gap = velObj > 0
          ? Math.round(((velPonderada - velObj) / velObj) * 10000) / 100
          : null;
        const { error } = await sb
          .from("sku_intelligence")
          .update({ vel_objetivo: velObj, gap_vel_pct: gap })
          .eq("sku_origen", u.sku_origen);
        if (!error) updated++;
      }
    }

    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
