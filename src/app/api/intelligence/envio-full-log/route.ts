import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/intelligence/envio-full-log
 * Registra un envío a Full en el historial + admin_actions_log.
 * Body: {
 *   pickingSessionId: string,
 *   totals: { skus, udsVenta, udsFisicas, bultos, eventoActivo?, multiplicadorEvento? },
 *   lineas: Array<{ skuVenta, skuOrigen, cantidadSugerida, cantidadEnviada, fueEditada,
 *     abc, velPonderada, velObjetivo, stockFullAntes, stockBodegaAntes, cobFullAntes,
 *     targetDias, margenFull, innerPack, redondeo, alertas, nota }>,
 *   skusEditados: string[]
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { pickingSessionId, totals, lineas, skusEditados } = body;

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // 1. Insertar cabecera
    const { data: envio, error: errEnvio } = await sb
      .from("envios_full_historial")
      .insert({
        picking_session_id: pickingSessionId,
        total_skus: totals.skus,
        total_uds_venta: totals.udsVenta,
        total_uds_fisicas: totals.udsFisicas,
        total_bultos: totals.bultos,
        evento_activo: totals.eventoActivo || null,
        multiplicador_evento: totals.multiplicadorEvento || 1.0,
      })
      .select("id")
      .single();

    if (errEnvio || !envio) {
      return NextResponse.json({ error: errEnvio?.message || "Error al crear envío" }, { status: 500 });
    }

    const envioId = envio.id;

    // 2. Insertar líneas en batches de 500
    const rows = (lineas || []).map((l: Record<string, unknown>) => ({
      envio_id: envioId,
      sku_venta: l.skuVenta,
      sku_origen: l.skuOrigen,
      cantidad_sugerida: l.cantidadSugerida,
      cantidad_enviada: l.cantidadEnviada,
      fue_editada: l.fueEditada || false,
      abc: l.abc,
      vel_ponderada: l.velPonderada,
      vel_objetivo: l.velObjetivo,
      stock_full_antes: l.stockFullAntes,
      stock_bodega_antes: l.stockBodegaAntes,
      cob_full_antes: l.cobFullAntes,
      target_dias: l.targetDias,
      margen_full: l.margenFull,
      inner_pack: l.innerPack,
      redondeo: l.redondeo,
      alertas: l.alertas,
      nota: l.nota,
    }));

    for (let i = 0; i < rows.length; i += 500) {
      await sb.from("envios_full_lineas").insert(rows.slice(i, i + 500));
    }

    // 3. Insertar en admin_actions_log
    try {
      await sb.from("admin_actions_log").insert({
        accion: "crear_picking_full",
        entidad: "inteligencia",
        entidad_id: pickingSessionId,
        detalle: {
          envioId,
          pickingSessionId,
          cantidadSkus: totals.skus,
          cantidadUnidades: totals.udsVenta,
          cantidadBultos: totals.bultos,
          skusEditados: skusEditados || [],
          fuente: "inteligencia",
        },
      });
    } catch { /* no bloquear */ }

    return NextResponse.json({ ok: true, envioId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
