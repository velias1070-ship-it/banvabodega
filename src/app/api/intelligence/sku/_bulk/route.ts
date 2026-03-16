import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/intelligence/sku/_bulk
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
    const velMap = new Map<string, number>();
    // Paginar: in() soporta hasta ~100 items
    for (let i = 0; i < skus.length; i += 100) {
      const chunk = skus.slice(i, i + 100);
      const { data } = await sb
        .from("sku_intelligence")
        .select("sku_origen, vel_ponderada")
        .in("sku_origen", chunk);
      for (const row of (data || [])) {
        velMap.set(row.sku_origen, row.vel_ponderada || 0);
      }
    }

    let updated = 0;
    for (const u of updates) {
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

    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
