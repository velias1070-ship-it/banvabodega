import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// Sprint 7 Fase 6 — Endpoint que sirve v_sku_explanation por SKU.
// Devuelve la narrativa estructurada (jsonb) + texto plano para el modal.

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
    .from("v_sku_explanation")
    .select("sku_origen, explicacion, explicacion_texto")
    .eq("sku_origen", sku)
    .maybeSingle();

  if (error) {
    console.error(`[sku-explanation] query error sku=${sku}:`, error.message);
    return NextResponse.json({ error: error.message, sku }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "SKU sin narrativa", sku }, { status: 404 });
  }

  return NextResponse.json(data);
}
