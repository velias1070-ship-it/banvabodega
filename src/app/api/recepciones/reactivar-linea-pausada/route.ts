import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enqueueNotification } from "@/lib/notifications";

export const maxDuration = 30;

/**
 * Reactivación manual de una línea pausada o abandonada (Chunk 5 §6.1.1, paso 5).
 *
 * Para casos donde la disc se resolvió pero el cron no re-activó, o cuando admin
 * quiere reactivar manualmente una línea ABANDONADA.
 *
 * POST body: { lineaId: string, operario?: string }
 *
 * Response: { ok: boolean, estado_anterior: string, estado_nuevo: 'REACTIVADA' }
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { lineaId?: string; operario?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const lineaId = body.lineaId;
  const operario = body.operario || "admin";
  if (!lineaId) {
    return NextResponse.json({ error: "lineaId required" }, { status: 400 });
  }

  const { data: row, error: fetchErr } = await sb.from("recepcion_lineas")
    .select("id, sku, recepcion_id, pausada_estado, pausada_por")
    .eq("id", lineaId).maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  const linea = row as { id: string; sku: string; recepcion_id: string; pausada_estado: string | null; pausada_por: string | null } | null;
  if (!linea) return NextResponse.json({ error: "linea_not_found" }, { status: 404 });
  if (linea.pausada_estado !== "PAUSADA" && linea.pausada_estado !== "ABANDONADA") {
    return NextResponse.json({
      ok: false,
      error: `linea no está PAUSADA ni ABANDONADA (estado actual: ${linea.pausada_estado || "null"})`,
    }, { status: 400 });
  }

  const estadoAnterior = linea.pausada_estado;
  const { error: upErr } = await sb.from("recepcion_lineas")
    .update({ pausada_estado: "REACTIVADA" })
    .eq("id", lineaId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  await sb.from("audit_log").insert({
    accion: "linea_reactivada_manual",
    entidad: "recepcion_lineas",
    entidad_id: lineaId,
    operario,
    params: { sku: linea.sku, recepcion_id: linea.recepcion_id, estado_anterior: estadoAnterior },
    resultado: { estado: "REACTIVADA" },
  });

  if (linea.pausada_por) {
    try {
      await enqueueNotification("whatsapp", "56991655931@s.whatsapp.net", {
        text: `✅ Línea reactivada manualmente (${linea.sku}). ${linea.pausada_por}, podés ubicarla.`,
      });
    } catch (e) {
      console.error("[reactivar-linea-pausada] notify error:", e);
    }
  }

  return NextResponse.json({
    ok: true,
    estado_anterior: estadoAnterior,
    estado_nuevo: "REACTIVADA",
  });
}
