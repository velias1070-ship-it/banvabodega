import { NextRequest, NextResponse } from "next/server";
import {
  getSyncEstado,
  iniciarSync,
  ejecutarSyncCompleto,
  getPreviousMonthPeriod,
} from "@/lib/ml-metrics";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SYNC_SECRET = process.env.ML_SYNC_SECRET || "";

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = SYNC_SECRET && querySecret === SYNC_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";
  return isVercelCron || isManual || isLocalDev || !SYNC_SECRET;
}

/**
 * GET — Vercel Cron trigger (días 1-3 de cada mes).
 * Auto-inicia sync del mes anterior si idle, luego ejecuta fases.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    let estado = await getSyncEstado();

    // Auto-start on 1st-3rd of month if idle
    const day = new Date().getDate();
    if (estado && estado.fase === "idle" && day >= 1 && day <= 3) {
      const periodo = getPreviousMonthPeriod();
      console.log(`[metrics-sync] Auto-starting sync for ${periodo}`);
      estado = await iniciarSync(periodo);
    }

    if (!estado || estado.fase === "idle" || estado.fase === "done") {
      return NextResponse.json({
        status: "ok",
        message: estado?.fase === "done" ? "Sync already completed" : "No active sync",
        estado: estado?.fase ?? "idle",
        periodo: estado?.periodo ?? null,
        completado_at: estado?.completado_at ?? null,
        timestamp: new Date().toISOString(),
      });
    }

    if (estado.fase === "error") {
      return NextResponse.json({
        status: "error",
        message: estado.error_msg,
        estado: "error",
        periodo: estado.periodo,
        timestamp: new Date().toISOString(),
      });
    }

    // Execute phases (self-chaining up to 240s)
    const result = await ejecutarSyncCompleto(240_000);

    return NextResponse.json({
      status: result.error ? "error" : "ok",
      fases_completadas: result.fases_completadas,
      estado_final: result.estado_final,
      error: result.error ?? null,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[metrics-sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST — Manual trigger.
 * Body: { action: "start"|"status"|"reset"|"retry", periodo?: "2026-03" }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    switch (action) {
      case "start": {
        const periodo = body.periodo as string;
        if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
          return NextResponse.json({ error: "periodo requerido (YYYY-MM)" }, { status: 400 });
        }
        const estado = await iniciarSync(periodo);
        // Start executing phases immediately
        const result = await ejecutarSyncCompleto(240_000);
        return NextResponse.json({
          status: "ok",
          action: "start",
          periodo,
          fases_completadas: result.fases_completadas,
          estado_final: result.estado_final,
          timestamp: new Date().toISOString(),
        });
      }

      case "status": {
        const estado = await getSyncEstado();
        return NextResponse.json({
          status: "ok",
          estado,
          timestamp: new Date().toISOString(),
        });
      }

      case "reset": {
        const sb = getServerSupabase();
        if (sb) {
          await sb.from("ml_sync_estado").update({
            fase: "idle",
            error_msg: null,
            items_procesados: 0,
            ultimo_item_idx: 0,
            actualizado_at: new Date().toISOString(),
          }).eq("id", "metrics");
        }
        return NextResponse.json({ status: "ok", action: "reset", timestamp: new Date().toISOString() });
      }

      case "retry": {
        const estado = await getSyncEstado();
        if (!estado || estado.fase !== "error") {
          return NextResponse.json({ error: "No error state to retry" }, { status: 400 });
        }
        // Find the phase that errored (stored in error_msg as "phase: message")
        const errorPhase = estado.error_msg?.split(":")[0] || "visits";
        const sb = getServerSupabase();
        if (sb) {
          await sb.from("ml_sync_estado").update({
            fase: errorPhase,
            error_msg: null,
            actualizado_at: new Date().toISOString(),
          }).eq("id", "metrics");
        }
        const result = await ejecutarSyncCompleto(240_000);
        return NextResponse.json({
          status: "ok",
          action: "retry",
          fases_completadas: result.fases_completadas,
          estado_final: result.estado_final,
          timestamp: new Date().toISOString(),
        });
      }

      case "diagnose": {
        const sb = getServerSupabase();
        if (!sb) {
          return NextResponse.json({
            status: "error",
            supabase: "null — no client",
            env_test_mode: process.env.NEXT_PUBLIC_TEST_MODE ?? "undefined",
            env_url: process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "missing",
            env_test_url: process.env.NEXT_PUBLIC_SUPABASE_TEST_URL ? "set" : "missing",
          });
        }
        const { data, error } = await sb.from("ml_sync_estado").select("*").limit(1);
        return NextResponse.json({
          status: "ok",
          supabase: "connected",
          env_test_mode: process.env.NEXT_PUBLIC_TEST_MODE ?? "undefined",
          query_data: data,
          query_error: error ? { message: error.message, details: error.details, hint: error.hint, code: error.code } : null,
        });
      }

      default:
        return NextResponse.json({ error: "action requerido: start|status|reset|retry|diagnose" }, { status: 400 });
    }

  } catch (err) {
    console.error("[metrics-sync] POST Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
