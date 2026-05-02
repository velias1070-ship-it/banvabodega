import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/policy/sync-from-templates
// Cron weekly (lunes 11:30 UTC, post motor recalcular 11:00).
// Recalcula sku_node_policy desde policy_templates × sku_intelligence × productos.
// Preserva manual_override=true. Idempotente.
//
// Auth: Bearer CRON_SECRET (Vercel cron) o NODE_ENV=development o ?run=1
// Sprint 2 (2026-05-02). Ver /docs/sprints/sprint-2-populate-policy.md.

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

  const { data, error } = await sb.rpc("refresh_sku_node_policy_from_templates");
  if (error) {
    console.error("[policy-sync] rpc error:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  const rowsAffected = Array.isArray(data) && data[0]?.rows_affected != null
    ? Number(data[0].rows_affected)
    : null;

  // Audit log (Regla 3 inventory-policy.md: error catch + contexto).
  const { error: auditErr } = await sb.from("audit_log").insert({
    accion: "cron_policy_sync",
    entidad: "sku_node_policy",
    params: { trigger: isVercelCron ? "vercel_cron" : isLocalDev ? "local_dev" : "manual_run" },
    resultado: { rows_affected: rowsAffected, duration_ms: durationMs },
  });
  if (auditErr) {
    console.error("[policy-sync] audit_log insert failed:", auditErr.message);
    // No fallar el endpoint por audit log: la operación principal ya pasó.
  }

  return NextResponse.json({
    ok: true,
    rows_affected: rowsAffected,
    duration_ms: durationMs,
    triggered_by: isVercelCron ? "vercel_cron" : isLocalDev ? "local_dev" : "manual_run",
  });
}
