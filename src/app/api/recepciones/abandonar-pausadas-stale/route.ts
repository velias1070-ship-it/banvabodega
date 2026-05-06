import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enqueueNotification } from "@/lib/notifications";
import { marcarLineasPausadasComoAbandonadas } from "@/lib/store";

export const maxDuration = 60;

/**
 * Cron diario (Chunk 5 §6.1.1, paso 4.3): marca como ABANDONADA las
 * líneas pausadas hace más de 24h y notifica al admin con el listado.
 *
 * Idempotente: solo toca filas con pausada_estado='PAUSADA' antiguas.
 *
 * GET ?dry_run=1 → no escribe, solo reporta.
 *
 * Response:
 *   {
 *     scanned: number,
 *     abandonadas: number,
 *     items: Array<{ id, sku, recepcion_id, pausada_at, pausada_por }>,
 *     notified: boolean,
 *   }
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  if (dryRun) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb.from("recepcion_lineas")
      .select("id, sku, recepcion_id, pausada_at, pausada_por")
      .eq("pausada_estado", "PAUSADA");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const all = (data || []) as Array<{ id: string; sku: string; recepcion_id: string; pausada_at: string; pausada_por: string | null }>;
    const stale = all.filter(r => r.pausada_at && r.pausada_at < cutoff);
    return NextResponse.json({
      scanned: all.length, abandonadas: stale.length,
      items: stale, notified: false, dry_run: true,
    });
  }

  const stale = await marcarLineasPausadasComoAbandonadas();

  let notified = false;
  if (stale.length > 0) {
    const lines = [
      `⚠️ ${stale.length} líneas abandonadas (>24h pausadas sin resolver)`,
      ...stale.slice(0, 10).map(s =>
        `· ${s.sku} (rec ${s.recepcion_id.slice(0, 8)}) — pausada por ${s.pausada_por || "?"}`,
      ),
      stale.length > 10 ? `… y ${stale.length - 10} más` : "",
      "Revisar /admin/recepciones y reactivar manualmente las que correspondan.",
    ].filter(Boolean);
    const res = await enqueueNotification("whatsapp", "56991655931@s.whatsapp.net", {
      text: lines.join("\n"),
    });
    notified = res.ok;
  }

  return NextResponse.json({
    abandonadas: stale.length, items: stale, notified,
  });
}
