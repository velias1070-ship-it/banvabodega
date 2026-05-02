import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// Sprint 4.2 (2026-05-03) — Endpoint detalle por SKU para panel transparencia.
// Lee v_reposicion_explain (Sprint 4.2 view). Sin auth server-side.

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { sku: string } }
) {
  const sb = getServerSupabase();
  if (!sb) {
    return NextResponse.json({ error: "DB no disponible" }, { status: 500 });
  }

  const sku = decodeURIComponent(params.sku).toUpperCase().trim();

  const { data, error } = await sb
    .from("v_reposicion_explain")
    .select("*")
    .eq("sku_origen", sku)
    .maybeSingle();

  if (error) {
    console.error(`[sku-explain] query error sku=${sku}:`, error.message);
    return NextResponse.json({ error: error.message, sku }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "SKU no encontrado", sku }, { status: 404 });
  }

  return NextResponse.json({ data });
}
