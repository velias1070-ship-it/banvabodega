import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/intelligence/sku/_bulk
 * Actualización masiva de vel_objetivo para múltiples SKUs.
 * Body: { updates: Array<{ sku_origen: string, vel_objetivo: number }>, motivo?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: { sku_origen: string; vel_objetivo: number }[] = body.updates || [];
    const motivo: string = body.motivo || "Ajuste masivo";

    if (updates.length === 0) {
      return NextResponse.json({ error: "No hay updates" }, { status: 400 });
    }

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // Leer vel_ponderada y vel_objetivo actual de todos los SKUs afectados
    const skus = updates.map(u => u.sku_origen);
    const currentMap = new Map<string, { vel_ponderada: number; vel_objetivo: number }>();
    for (let i = 0; i < skus.length; i += 100) {
      const chunk = skus.slice(i, i + 100);
      const { data } = await sb
        .from("sku_intelligence")
        .select("sku_origen, vel_ponderada, vel_objetivo")
        .in("sku_origen", chunk);
      for (const row of (data || [])) {
        currentMap.set(row.sku_origen, {
          vel_ponderada: row.vel_ponderada || 0,
          vel_objetivo: row.vel_objetivo || 0,
        });
      }
    }

    let updated = 0;
    const historialRows: {
      sku_origen: string;
      vel_objetivo_anterior: number;
      vel_objetivo_nueva: number;
      motivo: string;
    }[] = [];
    const actionLogRows: {
      accion: string;
      entidad: string;
      entidad_id: string;
      detalle: Record<string, unknown>;
    }[] = [];

    for (const u of updates) {
      const cur = currentMap.get(u.sku_origen);
      const velPonderada = cur?.vel_ponderada || 0;
      const velAnterior = cur?.vel_objetivo || 0;
      const velObj = Number(u.vel_objetivo) || 0;
      const gap = velObj > 0
        ? Math.round(((velPonderada - velObj) / velObj) * 10000) / 100
        : null;

      const { error } = await sb
        .from("sku_intelligence")
        .update({ vel_objetivo: velObj, gap_vel_pct: gap })
        .eq("sku_origen", u.sku_origen);

      if (!error) {
        updated++;
        if (velObj !== velAnterior) {
          historialRows.push({
            sku_origen: u.sku_origen,
            vel_objetivo_anterior: velAnterior,
            vel_objetivo_nueva: velObj,
            motivo,
          });
          actionLogRows.push({
            accion: "cambio_vel_objetivo",
            entidad: "sku_intelligence",
            entidad_id: u.sku_origen,
            detalle: {
              vel_objetivo_anterior: velAnterior,
              vel_objetivo_nueva: velObj,
              vel_ponderada: velPonderada,
              gap_vel_pct: gap,
              motivo,
            },
          });
        }
      }
    }

    // Insertar historial y log en batches (fire & forget)
    if (historialRows.length > 0) {
      const insertBatch = async (table: string, rows: Record<string, unknown>[]) => {
        for (let i = 0; i < rows.length; i += 500) {
          await sb.from(table).insert(rows.slice(i, i + 500));
        }
      };
      await Promise.all([
        insertBatch("vel_objetivo_historial", historialRows),
        insertBatch("admin_actions_log", actionLogRows),
      ]).catch(() => { /* no bloquear si falla el log */ });
    }

    return NextResponse.json({ ok: true, updated, logged: historialRows.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
