import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import type { ConteoLinea, ConteoSkuDisparador } from "@/lib/db";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET/POST /api/conteos/auto-generar
 *
 * Cron diario que crea automaticamente el conteo del dia segun cadencia ABC.
 * Manual Inventarios Parte3 §5.6 linea 247 entregable Fase 1: "Cycle counting
 * diario implementado con generacion automatica de lista (4 SKUs/dia)."
 *
 * Logica:
 * 1) Lee v_skus_vencidos_conteo (ya filtra por A>30d, B>90d, C>365d con MAX 3 ejes).
 * 2) Toma top N posiciones unicas (default: 2 posiciones, parametro `posiciones`).
 * 3) Skip posiciones que ya estan en un conteo ABIERTA/EN_PROCESO.
 * 4) Crea UN solo conteo por_posicion con esas posiciones, lineas pre-cargadas
 *    desde stock, origen='auto_diario', skus_disparadores con la metadata.
 * 5) Si todas las posiciones vencidas ya tienen conteo activo, no crea nada.
 *
 * Auth: header Bearer ${CRON_SECRET} (Vercel cron lo envia auto)
 *       o ?manual=1 (panel admin) o NODE_ENV=development.
 *
 * Schedule (vercel.json): "0 11 * * 1-6" = 11:00 UTC L-S = 07:00 Chile invierno.
 */
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const isManualTrigger = req.nextUrl.searchParams.get("manual") === "1";
  return isVercelCron || isLocalDev || isManualTrigger;
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }

interface SkuVencidoRow {
  sku_origen: string;
  nombre: string | null;
  abc: "A" | "B" | "C" | null;
  stock_total: number;
  dias_sin_conteo: number | null;
  umbral_dias: number;
  dias_vencido: number | null;
  urgencia_score: number;
}

interface StockRow {
  sku: string;
  posicion_id: string;
  cantidad: number;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_supabase" }, { status: 500 });

  const url = req.nextUrl;
  const maxPosiciones = Math.max(1, Math.min(10, parseInt(url.searchParams.get("posiciones") || "2", 10)));

  try {
    // 1) Vencidos según cadencia ABC (ya filtrado por la vista).
    const { data: vencidosRaw, error: vencidosErr } = await sb
      .from("v_skus_vencidos_conteo").select("*").limit(200);
    if (vencidosErr) {
      console.error(`[auto-generar] vencidos query failed: ${vencidosErr.message}`);
      return NextResponse.json({ error: "vencidos_query_failed", detail: vencidosErr.message }, { status: 500 });
    }
    const vencidos = (vencidosRaw || []) as SkuVencidoRow[];
    if (vencidos.length === 0) {
      return NextResponse.json({ status: "ok", created: false, reason: "no_vencidos" });
    }

    // 2) Posiciones de los vencidos (ya ordenado por urgencia desde la vista).
    const skusVencidos = vencidos.map(v => v.sku_origen);
    const { data: stockRaw, error: stockErr } = await sb
      .from("stock").select("sku, posicion_id, cantidad")
      .in("sku", skusVencidos)
      .gt("cantidad", 0);
    if (stockErr) {
      console.error(`[auto-generar] stock query failed: ${stockErr.message}`);
      return NextResponse.json({ error: "stock_query_failed", detail: stockErr.message }, { status: 500 });
    }
    const stockRows = (stockRaw || []) as StockRow[];

    // posicion_id -> array de SKUs vencidos en esa posicion
    const posicionToSkusVencidos = new Map<string, SkuVencidoRow[]>();
    const skuToVencido = new Map(vencidos.map(v => [v.sku_origen, v] as const));
    for (const sr of stockRows) {
      const v = skuToVencido.get(sr.sku);
      if (!v) continue;
      const arr = posicionToSkusVencidos.get(sr.posicion_id) || [];
      arr.push(v);
      posicionToSkusVencidos.set(sr.posicion_id, arr);
    }

    if (posicionToSkusVencidos.size === 0) {
      return NextResponse.json({ status: "ok", created: false, reason: "vencidos_sin_stock_fisico" });
    }

    // 3) Excluir posiciones ya en conteo ABIERTA/EN_PROCESO.
    const { data: activosRaw } = await sb
      .from("conteos").select("posiciones")
      .in("estado", ["ABIERTA", "EN_PROCESO"]);
    const activas = new Set<string>();
    for (const c of (activosRaw || []) as { posiciones: string[] | null }[]) {
      for (const p of c.posiciones || []) activas.add(p);
    }

    // 4) Ranking de posiciones por urgencia maxima (max urgencia_score de sus SKUs).
    const posicionesRank: Array<{ posicion: string; urgencia: number; nSkusVencidos: number }> = [];
    posicionToSkusVencidos.forEach((skus: SkuVencidoRow[], pos: string) => {
      if (activas.has(pos)) return;  // ya hay conteo activo
      const maxUrg = Math.max(...skus.map((s: SkuVencidoRow) => s.urgencia_score));
      posicionesRank.push({ posicion: pos, urgencia: maxUrg, nSkusVencidos: skus.length });
    });
    posicionesRank.sort((a, b) => b.urgencia - a.urgencia || b.nSkusVencidos - a.nSkusVencidos);
    const posicionesElegidas = posicionesRank.slice(0, maxPosiciones).map(p => p.posicion);

    if (posicionesElegidas.length === 0) {
      return NextResponse.json({
        status: "ok", created: false, reason: "todas_las_vencidas_ya_estan_en_conteo_activo",
        posiciones_activas: activas.size,
        posiciones_vencidas_total: posicionToSkusVencidos.size,
      });
    }

    // 5) Pre-cargar lineas: TODOS los SKUs con stock>0 en las posiciones elegidas
    //    (no solo los vencidos — location-based count completo).
    const { data: stockEnPos, error: stockPosErr } = await sb
      .from("stock").select("sku, posicion_id, cantidad")
      .in("posicion_id", posicionesElegidas).gt("cantidad", 0);
    if (stockPosErr) {
      return NextResponse.json({ error: "stock_pos_query_failed", detail: stockPosErr.message }, { status: 500 });
    }
    const skusEnPos = Array.from(new Set((stockEnPos || []).map(r => (r as StockRow).sku)));

    const { data: prodsRaw } = await sb.from("productos").select("sku, nombre").in("sku", skusEnPos);
    const prodMap = new Map((prodsRaw || []).map(p => [(p as { sku: string }).sku, (p as { sku: string; nombre: string | null }).nombre || ""] as const));

    // posiciones tabla: label
    const { data: posMetaRaw } = await sb.from("posiciones").select("id, label").in("id", posicionesElegidas);
    const posLabel = new Map((posMetaRaw || []).map(p => [(p as { id: string; label: string | null }).id, (p as { id: string; label: string | null }).label || (p as { id: string }).id] as const));

    const lineas: ConteoLinea[] = [];
    for (const sr of (stockEnPos || []) as StockRow[]) {
      lineas.push({
        posicion_id: sr.posicion_id,
        posicion_label: posLabel.get(sr.posicion_id) || sr.posicion_id,
        sku: sr.sku,
        nombre: prodMap.get(sr.sku) || sr.sku,
        stock_sistema: sr.cantidad,
        stock_contado: 0,
        operario: "",
        timestamp: "",
        estado: "PENDIENTE",
        es_inesperado: false,
      });
    }

    // 6) skus_disparadores: SKUs vencidos que están en las posiciones elegidas.
    const disparadores: ConteoSkuDisparador[] = [];
    for (const pos of posicionesElegidas) {
      const skusVencidosEnPos = posicionToSkusVencidos.get(pos) || [];
      for (const v of skusVencidosEnPos) {
        const razon = v.dias_sin_conteo == null
          ? `nunca contado, clase ${v.abc} con stock`
          : `clase ${v.abc} vencido +${v.dias_vencido}d (umbral ${v.umbral_dias}d)`;
        disparadores.push({ sku: v.sku_origen, nombre: v.nombre || undefined, abc: v.abc, razon });
      }
    }

    // 7) Crear conteo
    const fecha = new Date().toISOString().slice(0, 10);
    const { data: created, error: createErr } = await sb.from("conteos").insert({
      fecha,
      tipo: "por_posicion",
      estado: "ABIERTA",
      lineas: lineas as unknown,
      posiciones: posicionesElegidas,
      posiciones_contadas: [],
      created_by: "Cron auto",
      origen: "auto_diario",
      skus_disparadores: disparadores as unknown,
    }).select("id").single();

    if (createErr) {
      console.error(`[auto-generar] insert failed: ${createErr.message}`);
      return NextResponse.json({ error: "insert_failed", detail: createErr.message }, { status: 500 });
    }

    return NextResponse.json({
      status: "ok",
      created: true,
      conteo_id: created?.id,
      fecha,
      posiciones: posicionesElegidas,
      n_lineas: lineas.length,
      n_skus_vencidos_disparadores: disparadores.length,
      n_skus_vecinos: lineas.length - disparadores.length,
      backlog_restante_posiciones: posicionToSkusVencidos.size - posicionesElegidas.length,
    });
  } catch (err) {
    console.error("[auto-generar] uncaught:", err);
    return NextResponse.json({ error: "uncaught", detail: String(err) }, { status: 500 });
  }
}
