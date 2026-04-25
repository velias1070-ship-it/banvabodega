import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 30;

/**
 * Admin endpoint para gestionar cadencias por fase del cron metrics-sync.
 *
 * GET  → lista config + estado actual de cada fase
 * POST → modifica config con audit log
 *        Body: {fase, cadencia_horas?, active?, notes?, confirm: true, reason: "..."}
 *        Validaciones:
 *          - confirm === true (previene cambios accidentales)
 *          - reason no vacío (audit retroactivo)
 *          - cadencia_horas dentro de [cadencia_min_horas, cadencia_max_horas]
 *          - fase debe existir en la tabla
 */

interface ConfigRow {
  fase: string;
  cadencia_horas: number;
  cadencia_min_horas: number;
  cadencia_max_horas: number;
  active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  notes: string | null;
  updated_by: string | null;
  updated_at: string;
}

function isAuthorized(req: NextRequest): boolean {
  const cron = req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
  const internal = req.headers.get("x-internal") === "1";
  const local = process.env.NODE_ENV === "development";
  const admin = (req.headers.get("referer") || "").includes("/admin");
  return cron || internal || local || admin;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data, error } = await sb
    .from("ml_sync_phases_config")
    .select("*")
    .order("cadencia_horas", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Adjuntar phase_status desde ml_sync_health para visibility
  const { data: healthRow } = await sb
    .from("ml_sync_health")
    .select("phase_status")
    .eq("job_name", "metrics_monthly")
    .maybeSingle();
  const phaseStatus = (healthRow as { phase_status: Record<string, unknown> } | null)?.phase_status ?? {};

  return NextResponse.json({
    status: "ok",
    config: data as ConfigRow[],
    phase_status: phaseStatus,
  });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const fase = body.fase as string | undefined;
  const cadencia = body.cadencia_horas as number | undefined;
  const active = body.active as boolean | undefined;
  const notes = body.notes as string | undefined;
  const confirm = body.confirm === true;
  const reason = (body.reason as string | undefined)?.trim();
  const changedBy = (body.changed_by as string | undefined)?.trim() || "admin";

  // Validación 1: payload explícito
  if (!confirm) {
    return NextResponse.json({
      error: "missing_confirm",
      detail: "POST requires {confirm: true} to prevent accidental changes",
    }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({
      error: "missing_reason",
      detail: "POST requires {reason: '...'} for audit log",
    }, { status: 400 });
  }
  if (!fase) {
    return NextResponse.json({ error: "missing_fase" }, { status: 400 });
  }

  // Validación 2: fase existe
  const { data: current, error: readErr } = await sb
    .from("ml_sync_phases_config")
    .select("*")
    .eq("fase", fase)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!current) {
    return NextResponse.json({ error: "fase_not_found", fase }, { status: 404 });
  }
  const cur = current as ConfigRow;

  // Validación 3: cadencia dentro del rango permitido para esta fase
  const updates: Record<string, unknown> = {};
  const auditEntries: { field: string; oldValue: string | null; newValue: string | null }[] = [];

  if (cadencia !== undefined) {
    if (typeof cadencia !== "number" || !Number.isInteger(cadencia)) {
      return NextResponse.json({ error: "cadencia_must_be_integer" }, { status: 400 });
    }
    if (cadencia < cur.cadencia_min_horas || cadencia > cur.cadencia_max_horas) {
      return NextResponse.json({
        error: "cadencia_out_of_range",
        detail: `cadencia_horas debe estar entre ${cur.cadencia_min_horas} y ${cur.cadencia_max_horas} para la fase '${fase}'`,
        proposed: cadencia,
        min: cur.cadencia_min_horas,
        max: cur.cadencia_max_horas,
      }, { status: 400 });
    }
    if (cadencia !== cur.cadencia_horas) {
      updates.cadencia_horas = cadencia;
      auditEntries.push({
        field: "cadencia_horas",
        oldValue: String(cur.cadencia_horas),
        newValue: String(cadencia),
      });
    }
  }

  if (active !== undefined && active !== cur.active) {
    if (typeof active !== "boolean") {
      return NextResponse.json({ error: "active_must_be_boolean" }, { status: 400 });
    }
    updates.active = active;
    auditEntries.push({
      field: "active",
      oldValue: String(cur.active),
      newValue: String(active),
    });
  }

  if (notes !== undefined && notes !== cur.notes) {
    updates.notes = notes;
    auditEntries.push({
      field: "notes",
      oldValue: cur.notes,
      newValue: notes,
    });
  }

  if (auditEntries.length === 0) {
    return NextResponse.json({
      status: "no_change",
      detail: "Los valores propuestos coinciden con la config actual",
      current: cur,
    });
  }

  // Aplicar updates
  updates.updated_by = changedBy;
  updates.updated_at = new Date().toISOString();

  const { error: updErr } = await sb
    .from("ml_sync_phases_config")
    .update(updates)
    .eq("fase", fase);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  // Audit log
  const auditRows = auditEntries.map(e => ({
    fase,
    field: e.field,
    old_value: e.oldValue,
    new_value: e.newValue,
    changed_by: changedBy,
    reason,
  }));
  const { error: auditErr } = await sb.from("ml_sync_config_history").insert(auditRows);
  if (auditErr) console.error(`[sync-config] audit insert failed: ${auditErr.message}`);

  return NextResponse.json({
    status: "ok",
    fase,
    changes: auditEntries,
    changed_by: changedBy,
    reason,
  });
}
