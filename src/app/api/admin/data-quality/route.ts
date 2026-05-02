import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// Sprint 4.2 (2026-05-03) — Reporte global de calidad de datos.
// Lee v_data_quality_drift. Devuelve filas + summary por status.

export const dynamic = "force-dynamic";

type Row = {
  sku_origen: string;
  data_quality_status: string;
  clp_estimado: number | null;
  [key: string]: unknown;
};

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) {
    return NextResponse.json({ error: "DB no disponible" }, { status: 500 });
  }

  const { data, error } = await sb
    .from("v_data_quality_drift")
    .select("*")
    .order("clp_estimado", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[data-quality] query error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: Row[] = (data || []) as Row[];

  const summary = {
    total_skus: rows.length,
    drift_both: rows.filter((r) => r.data_quality_status === "DRIFT_BOTH").length,
    drift_vel: rows.filter((r) => r.data_quality_status === "DRIFT_VEL").length,
    drift_lt: rows.filter((r) => r.data_quality_status === "DRIFT_LT").length,
    drift_moderate: rows.filter((r) => r.data_quality_status === "DRIFT_MODERATE").length,
    blocked_cost: rows.filter((r) => r.data_quality_status === "BLOCKED_COST").length,
    blocked_history: rows.filter((r) => r.data_quality_status === "BLOCKED_HISTORY").length,
    sin_baseline: rows.filter((r) => r.data_quality_status === "SIN_BASELINE").length,
    ok: rows.filter((r) => r.data_quality_status === "OK").length,
  };

  return NextResponse.json({ data: rows, summary });
}
