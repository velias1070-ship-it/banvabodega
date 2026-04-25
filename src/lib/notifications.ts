/**
 * Helper para insertar notificaciones a la outbox.
 * Vercel inserta acá → Viki polea cada 1m → entrega vía ~/.whatsapp-channel/outbound/.
 *
 * Uso:
 *   await enqueueNotification("whatsapp", "56991655931@s.whatsapp.net", { text: "..." });
 */

import { getServerSupabase } from "./supabase-server";

export interface NotificationPayload {
  text: string;
  attachments?: unknown[];
}

export async function enqueueNotification(
  channel: "whatsapp" | "email" | "slack",
  destination: string,
  payload: NotificationPayload,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  const sb = getServerSupabase();
  if (!sb) return { ok: false, error: "no_db" };

  const { data, error } = await sb
    .from("notifications_outbox")
    .insert({ channel, destination, payload })
    .select("id")
    .single();

  if (error) {
    console.error(`[notifications] enqueue failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
  return { ok: true, id: (data as { id: number }).id };
}
