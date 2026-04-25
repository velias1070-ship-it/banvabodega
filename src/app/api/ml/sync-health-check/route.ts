import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { enqueueNotification } from "@/lib/notifications";

export const maxDuration = 30;

const ALERT_COOLDOWN_HOURS = 6; // no re-notificar el mismo job antes de N horas

interface HealthRow {
  job_name: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  staleness_threshold_hours: number;
  alert_channel: string;
  alert_destination: string | null;
  is_alerting: boolean;
  last_alert_sent_at: string | null;
}

function isAuthorized(req: NextRequest): boolean {
  const cron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const internal = req.headers.get("x-internal") === "1";
  const local = process.env.NODE_ENV === "development";
  const admin = (req.headers.get("referer") || "").includes("/admin");
  return cron || internal || local || admin;
}

function hoursAgo(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: jobs, error } = await sb.from("ml_sync_health").select("*");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const stale: { job_name: string; hours_stale: number; threshold: number }[] = [];
  const enqueued: { job_name: string; outbox_id?: number }[] = [];
  const skipped_cooldown: string[] = [];

  for (const job of (jobs || []) as HealthRow[]) {
    const staleness = hoursAgo(job.last_success_at);
    if (staleness <= job.staleness_threshold_hours) {
      // Si volvió a estar OK y antes estaba alerting, limpiar flag
      if (job.is_alerting) {
        await sb.from("ml_sync_health").update({ is_alerting: false }).eq("job_name", job.job_name);
      }
      continue;
    }

    stale.push({ job_name: job.job_name, hours_stale: Math.round(staleness * 10) / 10, threshold: job.staleness_threshold_hours });

    // Cooldown: no spamear si ya alertamos hace <6h
    const sinceAlert = hoursAgo(job.last_alert_sent_at);
    if (sinceAlert < ALERT_COOLDOWN_HOURS) {
      skipped_cooldown.push(job.job_name);
      continue;
    }

    if (!job.alert_destination) {
      console.warn(`[sync-health-check] ${job.job_name} stale pero sin alert_destination`);
      continue;
    }

    const lastSeen = job.last_success_at ? new Date(job.last_success_at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "nunca";
    const text = `🔴 BANVA sync stale\n\nJob: *${job.job_name}*\nÚltimo éxito: ${lastSeen} (hace ${Math.round(staleness)}h)\nUmbral: ${job.staleness_threshold_hours}h\nÚltimo error: ${job.last_error || "—"}`;

    const result = await enqueueNotification(
      job.alert_channel as "whatsapp" | "email" | "slack",
      job.alert_destination,
      { text },
    );

    if (result.ok) {
      await sb.from("ml_sync_health").update({
        is_alerting: true,
        last_alert_sent_at: new Date().toISOString(),
      }).eq("job_name", job.job_name);
      enqueued.push({ job_name: job.job_name, outbox_id: result.id });
    }
  }

  return NextResponse.json({
    status: "ok",
    checked: (jobs || []).length,
    stale,
    enqueued,
    skipped_cooldown,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
