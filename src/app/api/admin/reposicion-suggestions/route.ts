import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// Sprint 4 (2026-05-03) — Endpoint para /admin/reposicion-suggestions.
// Lee v_reposicion_dashboard (Sprint 4 view) y arma summary para banner.
// Sin auth server-side: el panel admin tiene PIN client-side (security.md).

export const dynamic = "force-dynamic";

type Row = {
  sku_origen: string;
  nivel_alerta: string;
  clp_estimado: number | null;
  [key: string]: unknown;
};

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) {
    return NextResponse.json({ error: "DB no disponible" }, { status: 500 });
  }

  const { data, error } = await sb
    .from("v_reposicion_dashboard")
    .select("*")
    .order("prioridad", { ascending: true })
    .order("clp_estimado", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[reposicion-suggestions] query error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows: Row[] = (data || []) as Row[];

  const summary = {
    quiebre_total: rows.filter((r) => r.nivel_alerta === "QUIEBRE_TOTAL").length,
    critico: rows.filter((r) => r.nivel_alerta === "CRITICO").length,
    urgente: rows.filter((r) => r.nivel_alerta === "URGENTE").length,
    atencion: rows.filter((r) => r.nivel_alerta === "ATENCION").length,
    total_skus: rows.length,
    total_clp: rows.reduce((s, r) => s + (Number(r.clp_estimado) || 0), 0),
  };

  return NextResponse.json({ data: rows, summary });
}
