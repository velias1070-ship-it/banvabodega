import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/promos-eventos
 *   Lista todo el catálogo. Usado para UI de gestión.
 *
 * PATCH /api/promos-eventos
 *   Body: { promo_name: string, evento_tag?: string, evento_subtag?: string, notas?: string }
 *   Update manual de un mapping. Marca fuente_tag='manual' para que el
 *   auto-tag no lo pise. Si ya estaba 'manual'/'override', se mantiene.
 *
 * POST /api/promos-eventos
 *   Body: { promo_name, evento_tag, evento_subtag?, notas? }
 *   Insert manual de un mapping nuevo (evita esperar a que aparezca en history).
 */

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });
  const { data, error } = await sb.from("promos_eventos")
    .select("*")
    .order("evento_tag", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data || [] });
}

export async function PATCH(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { promo_name?: string; evento_tag?: string; evento_subtag?: string | null; notas?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "body invalido" }, { status: 400 }); }
  const promo_name = body.promo_name?.trim();
  if (!promo_name) return NextResponse.json({ error: "promo_name requerido" }, { status: 400 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.evento_tag !== undefined) updates.evento_tag = body.evento_tag;
  if (body.evento_subtag !== undefined) updates.evento_subtag = body.evento_subtag;
  if (body.notas !== undefined) updates.notas = body.notas;
  // Marcar como manual para que auto_tag no lo pise
  updates.fuente_tag = "manual";

  const { error } = await sb.from("promos_eventos").update(updates).eq("promo_name", promo_name);
  if (error) {
    console.error(`[promos-eventos] PATCH ${promo_name} failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, promo_name, updates });
}

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  let body: { promo_name?: string; evento_tag?: string; evento_subtag?: string | null; notas?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "body invalido" }, { status: 400 }); }
  const promo_name = body.promo_name?.trim();
  const evento_tag = body.evento_tag?.trim();
  if (!promo_name || !evento_tag) {
    return NextResponse.json({ error: "promo_name y evento_tag requeridos" }, { status: 400 });
  }

  const { error } = await sb.from("promos_eventos").upsert({
    promo_name,
    evento_tag,
    evento_subtag: body.evento_subtag ?? null,
    notas: body.notas ?? null,
    fuente_tag: "manual",
    updated_at: new Date().toISOString(),
  }, { onConflict: "promo_name" });
  if (error) {
    console.error(`[promos-eventos] POST ${promo_name} failed:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
