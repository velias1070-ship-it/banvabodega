import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/intelligence/sku/{sku_origen}
 * Devuelve todos los campos de sku_intelligence para un SKU + snapshots de stock
 * recientes (para diagnosticar si la caida de velocidad es por quiebre previo).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sku_origen: string }> },
) {
  const { sku_origen } = await params;
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "Sin conexion a Supabase" }, { status: 500 });

  const { data: intel, error: intelErr } = await sb
    .from("sku_intelligence")
    .select("*")
    .eq("sku_origen", sku_origen)
    .maybeSingle();
  if (intelErr) return NextResponse.json({ error: intelErr.message }, { status: 500 });

  // Traer snapshots de stock ultimos 60 dias para ver historial de quiebres
  const fechaDesde = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const { data: snaps } = await sb
    .from("stock_snapshots")
    .select("fecha, stock_full, stock_bodega, stock_total, en_quiebre_full")
    .eq("sku_origen", sku_origen)
    .gte("fecha", fechaDesde)
    .order("fecha", { ascending: true });

  return NextResponse.json({
    sku_origen,
    intelligence: intel,
    snapshots: snaps || [],
  });
}

/**
 * PATCH /api/intelligence/sku/{sku_origen}
 * Actualiza vel_objetivo y recalcula gap_vel_pct.
 * Body: { vel_objetivo: number, motivo?: string }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sku_origen: string }> },
) {
  try {
    const { sku_origen } = await params;
    const body = await req.json();
    const velObjetivo = Number(body.vel_objetivo) || 0;
    const motivo = body.motivo || "Ajuste manual";

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // Leer vel_ponderada y vel_objetivo actual
    const { data: current } = await sb
      .from("sku_intelligence")
      .select("vel_ponderada, vel_objetivo")
      .eq("sku_origen", sku_origen)
      .single();

    if (!current) {
      return NextResponse.json({ error: "SKU no encontrado" }, { status: 404 });
    }

    const velPonderada = current.vel_ponderada || 0;
    const velAnterior = current.vel_objetivo || 0;
    const gapVelPct = velObjetivo > 0
      ? Math.round(((velPonderada - velObjetivo) / velObjetivo) * 10000) / 100
      : null;

    // Actualizar sku_intelligence
    const { error } = await sb
      .from("sku_intelligence")
      .update({ vel_objetivo: velObjetivo, gap_vel_pct: gapVelPct })
      .eq("sku_origen", sku_origen);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Registrar en vel_objetivo_historial + admin_actions_log (fire & forget)
    if (velObjetivo !== velAnterior) {
      await Promise.all([
        sb.from("vel_objetivo_historial").insert({
          sku_origen,
          vel_objetivo_anterior: velAnterior,
          vel_objetivo_nueva: velObjetivo,
          motivo,
        }),
        sb.from("admin_actions_log").insert({
          accion: "cambio_vel_objetivo",
          entidad: "sku_intelligence",
          entidad_id: sku_origen,
          detalle: {
            vel_objetivo_anterior: velAnterior,
            vel_objetivo_nueva: velObjetivo,
            vel_ponderada: velPonderada,
            gap_vel_pct: gapVelPct,
            motivo,
          },
        }),
      ]).catch(() => { /* no bloquear si falla el log */ });
    }

    return NextResponse.json({ ok: true, sku_origen, vel_objetivo: velObjetivo, gap_vel_pct: gapVelPct });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
