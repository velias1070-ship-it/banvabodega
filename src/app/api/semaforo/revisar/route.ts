import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no supabase" }, { status: 500 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { item_id, sku_origen, causa_identificada, causa_detalle, accion_tomada, accion_detalle, revisado_por } = body;

  if (!sku_origen || !causa_identificada || !accion_tomada) {
    return NextResponse.json({ error: "sku_origen, causa_identificada, accion_tomada requeridos" }, { status: 400 });
  }

  // Get latest semana
  const { data: latest } = await sb
    .from("semaforo_semanal")
    .select("semana_calculo")
    .order("semana_calculo", { ascending: false })
    .limit(1);

  if (!latest?.[0]) return NextResponse.json({ error: "no semaforo data" }, { status: 404 });
  const semana = latest[0].semana_calculo;

  // Get snapshot: prefer by item_id (pub especifica), fallback a primera pub del sku_origen
  let snapQuery = sb.from("semaforo_semanal").select("*").eq("semana_calculo", semana);
  if (item_id) snapQuery = snapQuery.eq("item_id", item_id);
  else snapQuery = snapQuery.eq("sku_origen", sku_origen);
  const { data: snap } = await snapQuery.limit(1);

  if (!snap?.[0]) return NextResponse.json({ error: `SKU ${sku_origen} not found in semaforo` }, { status: 404 });
  const s = snap[0];

  // Calculate dias_desde_aparicion (por sku_origen agrupado — una revision aplica a todas las pubs)
  let diasDesde = 0;
  const { data: prevWeeks } = await sb
    .from("semaforo_semanal")
    .select("semana_calculo, cubeta")
    .eq("sku_origen", sku_origen)
    .eq("cubeta", s.cubeta)
    .order("semana_calculo", { ascending: false })
    .limit(12);

  if (prevWeeks && prevWeeks.length > 0) {
    const oldest = prevWeeks[prevWeeks.length - 1].semana_calculo;
    diasDesde = Math.floor((new Date().getTime() - new Date(oldest).getTime()) / 86400000);
  }

  const { error } = await sb.from("sku_revision_log").insert({
    sku_origen,
    semana,
    cubeta: s.cubeta,
    vel_7d_snapshot: s.vel_7d,
    vel_30d_snapshot: s.vel_30d,
    stock_snapshot: s.stock_total,
    precio_snapshot: s.precio_actual,
    impacto_clp_snapshot: s.impacto_clp,
    revisado_por: revisado_por || "vicente",
    causa_identificada,
    causa_detalle: causa_detalle || null,
    accion_tomada,
    accion_detalle: accion_detalle || null,
    dias_desde_aparicion: diasDesde,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ status: "ok", sku_origen, semana, cubeta: s.cubeta, dias_desde_aparicion: diasDesde });
}
