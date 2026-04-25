import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet } from "@/lib/ml";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Refresca ml_ads_daily_cache para items con ventas recientes.
 *
 * Estrategia:
 *   1. Toma SKUs vendidos en los últimos N días (default 35)
 *   2. Resuelve item_id via ml_items_map
 *   3. Para cada item, fetch /advertising/MLC/product_ads/ads/{item_id}
 *      con aggregation_type=DAILY en el rango
 *   4. Upsert en ml_ads_daily_cache
 *
 * Después llama a /api/ml/ads-rebalance para recalcular ads_cost_asignado.
 *
 * GET /api/ml/ads-daily-sync?days=35   (manual)
 * GET /api/ml/ads-daily-sync           (cron — default 35d)
 */

const SITE_ID = "MLC";
const METRICS = "clicks,prints,cost,cpc,acos,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,organic_units_quantity,organic_units_amount";

interface AdsApiRow {
  date: string;
  cost?: number;
  clicks?: number;
  prints?: number;
  direct_amount?: number;
  indirect_amount?: number;
  total_amount?: number;
  direct_units_quantity?: number;
  indirect_units_quantity?: number;
  organic_units_quantity?: number;
  organic_units_amount?: number;
  acos?: number;
}

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
    // 1. Items activos: fuente canónica ml_items_map (Regla 6 inventory-policy: NO iterar
    //    sobre respuesta parcial como ventas_ml_cache, que dejaba items pausados/sin venta
    //    histórica fuera del sync. Cobertura previa: 54%, esperada con este cambio: 100%).
    const { data: imap } = await sb
      .from("ml_items_map")
      .select("item_id")
      .eq("activo", true)
      .not("item_id", "is", null);
    const itemIds = Array.from(new Set(((imap || []) as { item_id: string }[]).map((i) => i.item_id).filter(Boolean)));

    console.log(`[ads-daily-sync] ${itemIds.length} item_ids activos, rango ${dateFrom}→${dateTo}`);

    // 3. Fetch daily ads por item con paralelismo controlado
    const allCacheRows: Record<string, unknown>[] = [];
    let ok = 0,
      fail = 0;
    const CONCURRENCY = 10;

    for (let i = 0; i < itemIds.length; i += CONCURRENCY) {
      const batch = itemIds.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (itemId) => {
          try {
            const data = await mlGet<{ results: AdsApiRow[] }>(
              `/advertising/${SITE_ID}/product_ads/ads/${itemId}?date_from=${dateFrom}&date_to=${dateTo}&metrics=${METRICS}&aggregation_type=DAILY`,
              { "api-version": "2" }
            );
            const rows = (data?.results || []).map((r) => ({
              item_id: itemId,
              date: r.date,
              cost_neto: Math.round(r.cost || 0),
              clicks: r.clicks || 0,
              prints: r.prints || 0,
              direct_amount: Math.round(r.direct_amount || 0),
              direct_units: r.direct_units_quantity || 0,
              indirect_amount: Math.round(r.indirect_amount || 0),
              indirect_units: r.indirect_units_quantity || 0,
              organic_amount: Math.round(r.organic_units_amount || 0),
              organic_units: r.organic_units_quantity || 0,
              total_amount: Math.round(r.total_amount || 0),
              acos: r.acos || 0,
            }));
            return { ok: true, rows };
          } catch (e) {
            return { ok: false, rows: [], err: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      for (const r of results) {
        if (r.ok) {
          ok++;
          allCacheRows.push(...r.rows);
        } else {
          fail++;
        }
      }
    }

    console.log(`[ads-daily-sync] fetched ${ok}/${itemIds.length} items (${fail} fails), ${allCacheRows.length} rows`);

    // 4. Upsert en batches
    let upsertOk = 0;
    const upsertErrors: string[] = [];
    for (let i = 0; i < allCacheRows.length; i += 500) {
      const chunk = allCacheRows.slice(i, i + 500);
      const { error } = await sb
        .from("ml_ads_daily_cache")
        .upsert(chunk, { onConflict: "item_id,date" });
      if (error) upsertErrors.push(error.message);
      else upsertOk += chunk.length;
    }

    const totalCost = allCacheRows.reduce((s, r) => s + ((r.cost_neto as number) || 0), 0);

    // Telemetría a ml_sync_health (Regla 7 in-progress)
    {
      const now = new Date().toISOString();
      const ok_run = upsertErrors.length === 0;
      await sb.from("ml_sync_health").update({
        last_attempt_at: now,
        ...(ok_run ? { last_success_at: now, last_error: null, consecutive_failures: 0 } : {}),
      }).eq("job_name", "ads_daily");
    }

    return NextResponse.json({
      status: "ok",
      range: `${dateFrom} → ${dateTo}`,
      items_total: itemIds.length,
      items_fetched: ok,
      items_failed: fail,
      cache_rows_upserted: upsertOk,
      cost_total_neto: totalCost,
      cost_total_con_iva: Math.round(totalCost * 1.19),
      upsert_errors: upsertErrors.length > 0 ? upsertErrors.slice(0, 3) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ads-daily-sync] error:", msg);
    const sb2 = getServerSupabase();
    if (sb2) {
      await sb2.from("ml_sync_health").update({
        last_attempt_at: new Date().toISOString(),
        last_error: msg,
        consecutive_failures: 1, // simplificado: no incrementa, marca que falló
      }).eq("job_name", "ads_daily");
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
