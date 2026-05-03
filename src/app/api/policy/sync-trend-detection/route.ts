import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/policy/sync-trend-detection
// Cron diario 12:00 UTC (post motor 11:00 + post policy_sync 11:30).
// Refresca tendencia + cell_efectiva en sku_node_policy desde v_trend_detection.
// Idempotente. Auth: Bearer CRON_SECRET (Vercel cron) | NODE_ENV=development | ?run=1
// Sprint 4.3b (2026-05-04). Ver /docs/sprints/sprint-4.3b-trend-detection.md.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const hasRunParam = req.nextUrl.searchParams.has("run");
  if (!isVercelCron && !isLocalDev && !hasRunParam) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "DB no disponible" }, { status: 500 });

  const startedAt = Date.now();

  const { data, error } = await sb.rpc("refresh_trend_in_sku_node_policy");
  if (error) {
    console.error("[trend-sync] rpc error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  const row = Array.isArray(data) && data[0] ? data[0] : null;
  const rowsAffected = row?.rows_affected != null ? Number(row.rows_affected) : null;
  const summary = row?.summary ?? null;

  // Audit log (Regla 3 inventory-policy.md: error catch + contexto).
  const { error: auditErr } = await sb.from("audit_log").insert({
    accion: "cron_trend_sync",
    entidad: "sku_node_policy",
    params: { trigger: isVercelCron ? "vercel_cron" : isLocalDev ? "local_dev" : "manual_run" },
    resultado: { rows_affected: rowsAffected, summary, duration_ms: durationMs },
  });
  if (auditErr) {
    console.error("[trend-sync] audit_log insert failed:", auditErr.message);
  }

  return NextResponse.json({
    ok: true,
    rows_affected: rowsAffected,
    summary,
    duration_ms: durationMs,
    triggered_by: isVercelCron ? "vercel_cron" : isLocalDev ? "local_dev" : "manual_run",
  });
}
