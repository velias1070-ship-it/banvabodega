import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Recalcula ads_cost_asignado en ventas_ml_cache con pro-rata correcto:
 *   ads_por_venta = (cost_neto × 1.19) × (subtotal / Σ subtotal_sku_dia)
 *
 * Aplica sobre ventas de los últimos N días (default 35).
 * Pensado para correr después de /api/ml/ads-daily-sync.
 *
 * GET /api/ml/ads-rebalance?days=35
 */

const IVA = 1.19;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const hasParam = req.nextUrl.searchParams.has("days");
  if (!isVercelCron && !isLocalDev && !hasParam) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") || "35") || 35, 89);
  const today = new Date();
  const dateTo = today.toISOString().slice(0, 10);
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  const dateFrom = from.toISOString().slice(0, 10);

  try {
    // 1. Traer ventas del período
    const ventas: Array<{
      id: string;
      sku_venta: string;
      fecha_date: string;
      subtotal: number;
      margen: number | null;
      costo_producto: number | null;
    }> = [];
    let off = 0;
    while (true) {
      const { data } = await sb
        .from("ventas_ml_cache")
        .select("id, sku_venta, fecha_date, subtotal, margen, costo_producto")
        .gte("fecha_date", dateFrom)
        .lte("fecha_date", dateTo)
        .range(off, off + 999);
      if (!data || !data.length) break;
      ventas.push(...(data as typeof ventas));
      if (data.length < 1000) break;
      off += 1000;
    }

    // 2. Resolver sku → item_id
    const { data: imap } = await sb.from("ml_items_map").select("sku, item_id");
    const skuToItem = new Map<string, string>();
    for (const r of (imap || []) as { sku: string; item_id: string }[]) {
      skuToItem.set(r.sku, r.item_id);
    }

    // 3. Leer cache del período
    const cacheMap = new Map<string, number>(); // key = item_id|date → cost_neto
    let off2 = 0;
    while (true) {
      const { data } = await sb
        .from("ml_ads_daily_cache")
        .select("item_id, date, cost_neto")
        .gte("date", dateFrom)
        .lte("date", dateTo)
        .range(off2, off2 + 999);
      if (!data || !data.length) break;
      for (const r of data as { item_id: string; date: string; cost_neto: number }[]) {
        cacheMap.set(`${r.item_id}|${r.date}`, r.cost_neto || 0);
      }
      if (data.length < 1000) break;
      off2 += 1000;
    }

    // 4. Agrupar ventas por (item_id, fecha_date)
    type VentaRow = typeof ventas[number];
    const groups = new Map<string, VentaRow[]>();
    for (const v of ventas) {
      const itemId = skuToItem.get(v.sku_venta);
      if (!itemId) continue;
      const key = `${itemId}|${v.fecha_date}`;
      const g = groups.get(key) || [];
      g.push(v);
      groups.set(key, g);
    }

    // 5. Para cada grupo, recalcular ads_cost_asignado
    const updates: Array<{
      id: string;
      ads_cost_asignado: number;
      ads_atribucion: string;
      margen_neto: number;
      margen_neto_pct: number;
    }> = [];
    const stats = { direct: 0, organic: 0, sin_datos: 0 };

    for (const [key, vs] of Array.from(groups.entries())) {
      const costNeto = cacheMap.get(key);
      if (costNeto == null) {
        for (const v of vs) {
          const mn = v.margen ?? 0;
          const pct = v.subtotal > 0 ? Math.round((mn / v.subtotal) * 10000) / 100 : 0;
          updates.push({ id: v.id, ads_cost_asignado: 0, ads_atribucion: "sin_datos", margen_neto: mn, margen_neto_pct: pct });
          stats.sin_datos++;
        }
        continue;
      }
      if (costNeto <= 0) {
        for (const v of vs) {
          const mn = v.margen ?? 0;
          const pct = v.subtotal > 0 ? Math.round((mn / v.subtotal) * 10000) / 100 : 0;
          updates.push({ id: v.id, ads_cost_asignado: 0, ads_atribucion: "organic", margen_neto: mn, margen_neto_pct: pct });
          stats.organic++;
        }
        continue;
      }
      const costConIva = Math.round(costNeto * IVA);
      const totalSub = vs.reduce((s: number, v: VentaRow) => s + (v.subtotal || 0), 0);
      if (totalSub <= 0) continue;
      for (const v of vs) {
        const share = (v.subtotal || 0) / totalSub;
        const ads = Math.round(costConIva * share);
        const margenBruto = v.margen ?? (0 - (v.costo_producto || 0));
        const mn = margenBruto - ads;
        const pct = v.subtotal > 0 ? Math.round((mn / v.subtotal) * 10000) / 100 : 0;
        updates.push({
          id: v.id,
          ads_cost_asignado: ads,
          ads_atribucion: "direct",
          margen_neto: mn,
          margen_neto_pct: pct,
        });
        stats.direct++;
      }
    }

    // 6. Apply con pool concurrente
    let ok = 0,
      fail = 0;
    const CONCURRENCY = 15;
    for (let i = 0; i < updates.length; i += CONCURRENCY) {
      const batch = updates.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (u) => {
          try {
            const { error } = await sb
              .from("ventas_ml_cache")
              .update({
                ads_cost_asignado: u.ads_cost_asignado,
                ads_atribucion: u.ads_atribucion,
                margen_neto: u.margen_neto,
                margen_neto_pct: u.margen_neto_pct,
              })
              .eq("id", u.id);
            return { ok: !error, err: error?.message };
          } catch (e) {
            return { ok: false, err: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      for (const r of results) {
        if (r.ok) ok++;
        else fail++;
      }
    }

    return NextResponse.json({
      status: "ok",
      range: `${dateFrom} → ${dateTo}`,
      ventas_in_range: ventas.length,
      groups: groups.size,
      attribution: stats,
      updates_ok: ok,
      updates_failed: fail,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ads-rebalance] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
