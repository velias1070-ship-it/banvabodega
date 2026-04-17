import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  snapshotSemanalActual,
  calcularYGuardarAccuracy,
} from "@/lib/forecast-accuracy-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false; // sin secret configurado, bloquear por defecto
  const header = req.headers.get("authorization") || "";
  const xcron = req.headers.get("x-cron-secret") || "";
  return header === `Bearer ${secret}` || xcron === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });

  const fecha = new Date();
  try {
    const snap = await snapshotSemanalActual(sb, fecha);
    const run = await calcularYGuardarAccuracy(sb, fecha);
    return NextResponse.json({
      ok: true,
      snapshot: snap,
      skus_procesados: run.skus_procesados,
      skus_confiables: run.skus_confiables,
      tiempo_ms: run.tiempo_ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * GET ?sku_origen=X  → las 3 entradas más recientes (ventanas 4/8/12) del SKU.
 * Lectura pública (convención del proyecto, RLS permisivo).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sku = searchParams.get("sku_origen");
  if (!sku) {
    return NextResponse.json({ ok: false, error: "missing sku_origen" }, { status: 400 });
  }
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });

  const { data, error } = await sb
    .from("forecast_accuracy")
    .select("*")
    .eq("sku_origen", sku)
    .order("calculado_at", { ascending: false })
    .order("ventana_semanas", { ascending: true })
    .limit(9); // hasta 3 corridas × 3 ventanas
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Agrupa la última corrida (3 filas más recientes por ventana).
  const latestByWindow: Record<number, unknown> = {};
  for (const r of data || []) {
    if (!latestByWindow[r.ventana_semanas]) latestByWindow[r.ventana_semanas] = r;
  }
  return NextResponse.json({ ok: true, sku_origen: sku, latest: latestByWindow, history: data });
}
