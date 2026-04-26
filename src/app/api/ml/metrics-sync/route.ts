import { NextRequest, NextResponse } from "next/server";
import {
  getSyncEstado,
  iniciarSync,
  ejecutarSyncCompleto,
  getPreviousMonthPeriod,
  getCurrentMonthPeriod,
} from "@/lib/ml-metrics";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SYNC_SECRET = process.env.ML_SYNC_SECRET || "";

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = SYNC_SECRET && querySecret === SYNC_SECRET;
  const isLocalDev = process.env.NODE_ENV === "development";
  return isVercelCron || isManual || isLocalDev || !SYNC_SECRET;
}

/**
 * GET — Vercel Cron trigger (días 1-3 de cada mes).
 * Auto-inicia sync del mes anterior si idle, luego ejecuta fases.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    let estado = await getSyncEstado();

    // Auto-arranque cadencia-driven (cutover real, reemplaza gating día 1-3 puro):
    //  1. Días 1-3 del mes + idle → arranca para el MES PREVIO (cierre mensual, comportamiento original)
    //  2. Cualquier otro día + (idle O done) + alguna fase due → arranca para el MES ACTUAL
    //     (esto es el camino que activa las cadencias diferenciadas: visits/questions/aggregate diarias)
    const day = new Date().getDate();
    const isClosingWindow = day >= 1 && day <= 3;
    const { anyPhaseDue } = await import("@/lib/sync-phases-config");
    const phaseDue = await anyPhaseDue();

    if (estado && (estado.fase === "idle" || estado.fase === "done")) {
      if (isClosingWindow && estado.fase === "idle") {
        const periodo = getPreviousMonthPeriod();
        console.log(`[metrics-sync] Cierre mensual: arrancando ${periodo}`);
        estado = await iniciarSync(periodo);
      } else if (phaseDue) {
        const periodo = getCurrentMonthPeriod();
        console.log(`[metrics-sync] Cadencia-driven re-start: ${periodo} (alguna fase due)`);
        estado = await iniciarSync(periodo);
      }
    }

    if (!estado || estado.fase === "idle" || estado.fase === "done") {
      return NextResponse.json({
        status: "ok",
        message: estado?.fase === "done" ? "Sync already completed" : "No active sync",
        estado: estado?.fase ?? "idle",
        periodo: estado?.periodo ?? null,
        completado_at: estado?.completado_at ?? null,
        any_phase_due: phaseDue,
        timestamp: new Date().toISOString(),
      });
    }

    if (estado.fase === "error") {
      return NextResponse.json({
        status: "error",
        message: estado.error_msg,
        estado: "error",
        periodo: estado.periodo,
        timestamp: new Date().toISOString(),
      });
    }

    // Execute phases (self-chaining up to 240s)
    const result = await ejecutarSyncCompleto(240_000);

    return NextResponse.json({
      status: result.error ? "error" : "ok",
      fases_completadas: result.fases_completadas,
      estado_final: result.estado_final,
      error: result.error ?? null,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error("[metrics-sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST — Manual trigger.
 * Body: { action: "start"|"status"|"reset"|"retry", periodo?: "2026-03" }
 */
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    switch (action) {
      case "start": {
        const periodo = body.periodo as string;
        if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
          return NextResponse.json({ error: "periodo requerido (YYYY-MM)" }, { status: 400 });
        }
        const estado = await iniciarSync(periodo);
        // Start executing phases immediately
        const result = await ejecutarSyncCompleto(240_000);
        return NextResponse.json({
          status: "ok",
          action: "start",
          periodo,
          fases_completadas: result.fases_completadas,
          estado_final: result.estado_final,
          timestamp: new Date().toISOString(),
        });
      }

      case "status": {
        const estado = await getSyncEstado();
        return NextResponse.json({
          status: "ok",
          estado,
          timestamp: new Date().toISOString(),
        });
      }

      case "reset": {
        const sb = getServerSupabase();
        if (sb) {
          await sb.from("ml_sync_estado").update({
            fase: "idle",
            error_msg: null,
            items_procesados: 0,
            ultimo_item_idx: 0,
            actualizado_at: new Date().toISOString(),
          }).eq("id", "metrics");
        }
        return NextResponse.json({ status: "ok", action: "reset", timestamp: new Date().toISOString() });
      }

      case "retry": {
        const estado = await getSyncEstado();
        if (!estado || estado.fase !== "error") {
          return NextResponse.json({ error: "No error state to retry" }, { status: 400 });
        }
        // Find the phase that errored (stored in error_msg as "phase: message")
        const errorPhase = estado.error_msg?.split(":")[0] || "visits";
        const sb = getServerSupabase();
        if (sb) {
          await sb.from("ml_sync_estado").update({
            fase: errorPhase,
            error_msg: null,
            actualizado_at: new Date().toISOString(),
          }).eq("id", "metrics");
        }
        const result = await ejecutarSyncCompleto(240_000);
        return NextResponse.json({
          status: "ok",
          action: "retry",
          fases_completadas: result.fases_completadas,
          estado_final: result.estado_final,
          timestamp: new Date().toISOString(),
        });
      }

      case "debug-orders": {
        const { ensureValidToken: ensT2, getMLConfig: getCfg2 } = await import("@/lib/ml");
        const c2 = await getCfg2();
        const t2 = await ensT2();
        if (!c2 || !t2) return NextResponse.json({ error: "no config/token" });
        const ML2 = "https://api.mercadolibre.com";
        const h2 = { Authorization: `Bearer ${t2}` };

        // Count orders from ML API for March
        const r1 = await fetch(`${ML2}/orders/search?seller=${c2.seller_id}&order.status=paid&order.date_created.from=2026-03-01T00:00:00.000-04:00&order.date_created.to=2026-03-31T23:59:59.999-04:00&limit=1`, { headers: h2 });
        const d1 = await r1.json();

        // Also check date_closed
        const r2 = await fetch(`${ML2}/orders/search?seller=${c2.seller_id}&order.status=paid&order.date_closed.from=2026-03-01T00:00:00.000-04:00&order.date_closed.to=2026-03-31T23:59:59.999-04:00&limit=1`, { headers: h2 });
        const d2 = await r2.json();

        // Check cancelled
        const r3 = await fetch(`${ML2}/orders/search?seller=${c2.seller_id}&order.status=cancelled&order.date_created.from=2026-03-01T00:00:00.000-04:00&order.date_created.to=2026-03-31T23:59:59.999-04:00&limit=1`, { headers: h2 });
        const d3 = await r3.json();

        return NextResponse.json({
          paid_by_date_created: d1.paging,
          paid_by_date_closed: d2.paging,
          cancelled_by_date_created: d3.paging,
        });
      }

      case "debug-benchmarks": {
        const { ensureValidToken: ensTb, getMLConfig: getCfgB } = await import("@/lib/ml");
        const cb = await getCfgB();
        const tb = await ensTb();
        if (!cb || !tb) return NextResponse.json({ error: "no config/token" });
        const MLb = "https://api.mercadolibre.com";
        const hb = { Authorization: `Bearer ${tb}` };

        // 30 items: 10 commodity, 10 diferenciados, 10 unicos
        const testItems = [
          // COMMODITY (sabanas basicas, fundas, cubre colchon)
          { id: "MLC3554024054", type: "commodity", label: "Cubre colchon impermeable" },
          { id: "MLC3554257278", type: "commodity", label: "Cubre colchon impermeable 2" },
          { id: "MLC3395914968", type: "commodity", label: "Sabanas 2P Cannon 144H" },
          { id: "MLC3395969320", type: "commodity", label: "Sabanas 200H 2P Cannon" },
          { id: "MLC1731158257", type: "commodity", label: "Cubre colchon impermeable PM" },
          { id: "MLC3396367720", type: "commodity", label: "Almohada Cannon" },
          { id: "MLC1834147735", type: "commodity", label: "Sabanas 2P Cannon AF" },
          { id: "MLC3222192526", type: "commodity", label: "Sabanas 1P infantil blanco" },
          { id: "MLC3243863074", type: "commodity", label: "Cubre colchon cuna" },
          { id: "MLC3535178000", type: "commodity", label: "Almohada memory foam Cannon" },
          // DIFERENCIADOS (sets premium, kits, packs)
          { id: "MLC3395894776", type: "diferenciado", label: "Jgo 4 Toallas Cannon 400g" },
          { id: "MLC3407112460", type: "diferenciado", label: "Pack 2 Almohadas Premium" },
          { id: "MLC3176483928", type: "diferenciado", label: "Set 2 Almohadas Pluma Ganso" },
          { id: "MLC3243229464", type: "diferenciado", label: "Pack x2 Memory Foam Cannon" },
          { id: "MLC1724585011", type: "diferenciado", label: "Kit Manualidades Unicornio" },
          { id: "MLC3221940036", type: "diferenciado", label: "Bolso Matero Cuero Set" },
          { id: "MLC3198418658", type: "diferenciado", label: "Plumon Infantil Unicornio" },
          { id: "MLC3198328152", type: "diferenciado", label: "Plumon Infantil Stars" },
          { id: "MLC3198263546", type: "diferenciado", label: "Cortinas Visillos Lino 2P" },
          { id: "MLC3300642436", type: "diferenciado", label: "Biblia Catolica Jovenes" },
          // UNICOS (Atenas, Roma, BANVA branded)
          { id: "MLC3198351164", type: "unico", label: "Quilt Atenas 2P" },
          { id: "MLC3198338246", type: "unico", label: "Quilt Atenas 2P color2" },
          { id: "MLC1711090217", type: "unico", label: "Quilt Roma SK" },
          { id: "MLC3198350940", type: "unico", label: "Quilt Roma 2P" },
          { id: "MLC1711051257", type: "unico", label: "Quilt Roma SK Gris" },
          { id: "MLC3193672362", type: "unico", label: "Quilt Roma SK Negro" },
          { id: "MLC1880200541", type: "unico", label: "Quilt Breda King" },
          { id: "MLC3742327802", type: "unico", label: "Quilt Breda 2P" },
          { id: "MLC3198327524", type: "unico", label: "Manta Flannel Roma" },
          { id: "MLC1710960777", type: "unico", label: "Quilt Atenas SK" },
        ];

        const results: Array<Record<string, unknown>> = [];
        for (const item of testItems) {
          try {
            const r = await fetch(`${MLb}/marketplace/benchmarks/items/${item.id}/details`, { headers: hb });
            const d = r.status === 200 ? await r.json() : { _status: r.status, _body: await r.text().then(t => t.substring(0, 200)) };
            results.push({
              item_id: item.id,
              type: item.type,
              label: item.label,
              status: r.status,
              lowest_price: d.lowest_price ?? d.price_comparison?.lowest_price ?? null,
              internal_price: d.internal_price ?? d.price_comparison?.internal_price ?? null,
              suggested_price: d.suggested_price ?? d.price_comparison?.suggested_price ?? null,
              competitors: d.competitors_count ?? d.total_sellers ?? d.sellers_count ?? null,
              catalog_product_id: d.catalog_product_id ?? null,
              has_data: r.status === 200 && Object.keys(d).length > 2,
              raw_keys: r.status === 200 ? Object.keys(d) : null,
            });
          } catch (err) {
            results.push({ item_id: item.id, type: item.type, label: item.label, error: String(err) });
          }
        }

        // Also try alternative endpoints for price/competition data
        const sampleId = testItems[0].id;
        const altEndpoints: Record<string, { status: number; keys: string[] | null; sample: unknown }> = {};

        const tryEndpoint = async (name: string, url: string) => {
          const r = await fetch(url, { headers: hb });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          altEndpoints[name] = {
            status: r.status,
            keys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : null,
            sample: json ? (typeof json === "object" ? JSON.stringify(json).substring(0, 300) : json) : text.substring(0, 300),
          };
        };

        await tryEndpoint("benchmarks_details", `${MLb}/marketplace/benchmarks/items/${sampleId}/details`);
        await tryEndpoint("benchmarks_price", `${MLb}/marketplace/benchmarks/items/${sampleId}/price`);
        await tryEndpoint("item_health", `${MLb}/items/${sampleId}/health`);
        await tryEndpoint("item_price_info", `${MLb}/items/${sampleId}?attributes=price,original_price,sale_price,catalog_product_id,buy_box_winner,winner_item_id`);
        await tryEndpoint("catalog_search", `${MLb}/products/search?status=active&site_id=MLC&q=sabanas+cannon&limit=3`);
        await tryEndpoint("item_catalog", `${MLb}/items/${sampleId}/catalog_listing_eligibility`);
        await tryEndpoint("price_comparison", `${MLb}/items/${sampleId}/prices`);
        await tryEndpoint("seller_items_search", `${MLb}/users/${cb.seller_id}/items/search?limit=1`);

        // Summary
        const byType: Record<string, { total: number; with_data: number; with_price: number }> = {};
        for (const r of results) {
          const t = r.type as string;
          if (!byType[t]) byType[t] = { total: 0, with_data: 0, with_price: 0 };
          byType[t].total++;
          if (r.has_data) byType[t].with_data++;
          if (r.lowest_price || r.suggested_price) byType[t].with_price++;
        }

        return NextResponse.json({ summary: byType, alt_endpoints: altEndpoints });
      }

      case "debug-ads": {
        const { ensureValidToken: ensT3, getMLConfig: getCfg3 } = await import("@/lib/ml");
        const c3 = await getCfg3();
        const t3 = await ensT3();
        if (!c3 || !t3) return NextResponse.json({ error: "no config/token" });
        const ML3 = "https://api.mercadolibre.com";
        const h3 = { Authorization: `Bearer ${t3}`, "api-version": "2" };
        const advId3 = (c3 as unknown as Record<string, unknown>).advertiser_id;
        const base3 = `${ML3}/marketplace/advertising/MLC/advertisers/${advId3}/product_ads`;
        const targetItem = body.item_id || "MLC3742340416";

        // 1. Get ALL campaigns (not just active)
        const campsResp = await fetch(`${base3}/campaigns/search?limit=50`, { headers: h3 });
        const campsData = await campsResp.json();

        // 2. Search for the item across all campaigns
        const adsMetrics = "clicks,prints,ctr,cost,cpc,acos,roas,cvr,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,units_quantity";
        const foundIn: Array<Record<string, unknown>> = [];
        for (const camp of campsData.results || []) {
          let off = 0;
          while (true) {
            const adsResp = await fetch(
              `${base3}/ads/search?campaign_id=${camp.id}&metrics=${adsMetrics}&date_from=2026-03-01&date_to=2026-03-31&offset=${off}&limit=50`,
              { headers: h3 }
            );
            const adsData = await adsResp.json();
            const results = adsData.results || [];
            for (const ad of results) {
              if (ad.item_id === targetItem) {
                foundIn.push({ campaign: camp.name, campaign_id: camp.id, campaign_status: camp.status, ad_status: ad.status, metrics: ad.metrics });
              }
            }
            if (results.length < 50) break;
            off += 50;
          }
        }

        return NextResponse.json({
          targetItem,
          total_campaigns: campsData.paging?.total,
          campaigns: (campsData.results || []).map((c: Record<string, unknown>) => ({ id: c.id, name: c.name, status: c.status, budget: c.budget })),
          item_found_in: foundIn,
          snapshot_ads: null, // will be filled below
        });
      }

      case "debug-sku": {
        const { mlGet: mlG, getMLConfig: getCfg } = await import("@/lib/ml");
        const c = await getCfg();
        if (!c) return NextResponse.json({ error: "no config" });
        const sku = body.sku || body.item_id;
        if (!sku) return NextResponse.json({ error: "sku or item_id required" });

        const sb3 = getServerSupabase();
        // Find item_id from sku
        let itemId = sku.startsWith("MLC") ? sku : null;
        if (!itemId && sb3) {
          const { data: m } = await sb3.from("ml_items_map").select("item_id").eq("sku_venta", sku).eq("activo", true).limit(1);
          itemId = m?.[0]?.item_id;
        }
        if (!itemId) return NextResponse.json({ error: `item not found for ${sku}` });

        // Raw API calls
        const visits = await mlG(`/items/${itemId}/visits/time_window?last=30&unit=day`);
        const reviews = await mlG(`/reviews/item/${itemId}`);
        const questions = await mlG(`/questions/search?item=${itemId}&limit=5`);
        const reputation = await mlG(`/users/${c.seller_id}`);
        // Snapshot from DB
        let snapshot = null;
        if (sb3) {
          const { data } = await sb3.from("ml_snapshot_mensual").select("*").eq("periodo", "2026-03").eq("item_id", itemId).limit(1);
          snapshot = data?.[0] ?? null;
        }
        // Orders for this SKU
        let orderCount = 0;
        if (sb3) {
          const { data } = await sb3.from("orders_history").select("cantidad, fecha").eq("sku_venta", sku).eq("estado", "Pagada").gte("fecha", "2026-03-01").lte("fecha", "2026-03-31T23:59:59Z");
          orderCount = data?.reduce((s: number, r: Record<string, unknown>) => s + ((r.cantidad as number) || 0), 0) ?? 0;
        }

        return NextResponse.json({
          itemId, sku,
          visits_total: (visits as Record<string, unknown>)?.total_visits,
          reviews_avg: (reviews as Record<string, unknown>)?.rating_average,
          reviews_count: ((reviews as Record<string, unknown>)?.paging as Record<string, unknown>)?.total,
          questions_total: (questions as Record<string, unknown>)?.total,
          reputation_raw: (reputation as Record<string, unknown>)?.seller_reputation,
          orders_units: orderCount,
          snapshot_visitas: snapshot?.visitas,
          snapshot_unidades: snapshot?.unidades_vendidas,
          snapshot_cvr: snapshot?.cvr,
        });
      }

      case "test-apis": {
        const { ensureValidToken, getMLConfig: getConfigFn } = await import("@/lib/ml");
        const cfg = await getConfigFn();
        if (!cfg) return NextResponse.json({ error: "no ml config" });
        const token = await ensureValidToken();
        if (!token) return NextResponse.json({ error: "no token" });

        const sb2 = getServerSupabase();
        const { data: sampleItems } = await sb2!.from("ml_items_map").select("item_id").eq("activo", true).limit(3);
        const testIds = sampleItems?.map((r: { item_id: string }) => r.item_id) || [];
        const testId = testIds[0] || "MLC1847580431";
        const idsStr = testIds.join(",");
        const ML = "https://api.mercadolibre.com";
        const h = { Authorization: `Bearer ${token}` };

        // Raw fetch each endpoint to see status + body
        const rawFetch = async (url: string, extra?: Record<string, string>) => {
          const resp = await fetch(url, { headers: { ...h, ...extra } });
          const text = await resp.text().catch(() => "");
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          return { status: resp.status, body: json ?? text.substring(0, 500) };
        };

        const sellerId = cfg.seller_id;
        const cfgAny = cfg as unknown as Record<string, unknown>;
        const advId = cfgAny.advertiser_id;
        const accId = cfgAny.account_id;
        const adsBase = `${ML}/marketplace/advertising/MLC/advertisers`;
        const adsQ = `/product_ads/campaigns/search?limit=2`;
        const adsH2 = { "api-version": "2" };

        const [ads_advId, ads_sellerId, ads_accId, ads_old] = await Promise.all([
          rawFetch(`${adsBase}/${advId}${adsQ}`, adsH2),
          rawFetch(`${adsBase}/${sellerId}${adsQ}`, adsH2),
          rawFetch(`${adsBase}/${accId}${adsQ}`, adsH2),
          rawFetch(`${ML}/advertising/product_ads/campaigns?user_id=${sellerId}&limit=2`, adsH2),
        ]);

        // Test the exact same calls faseAds makes
        const metricsP = "clicks,prints,ctr,cost,cpc,acos,roas,cvr,sov,impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark,direct_amount,indirect_amount,total_amount,direct_units_quantity,indirect_units_quantity,units_quantity,organic_units_quantity,organic_units_amount";
        // 1. Campaigns (simplified, no metrics)
        const camps = await rawFetch(`${adsBase}/${advId}/product_ads/campaigns/search?limit=50`, adsH2);
        // 2. Ads for first campaign (with metrics + dates)
        const campId = camps.body?.results?.[0]?.id;
        const ads_with_metrics = campId
          ? await rawFetch(`${adsBase}/${advId}/product_ads/ads/search?campaign_id=${campId}&date_from=2026-03-01&date_to=2026-03-31&metrics=${metricsP}&offset=0&limit=3`, adsH2)
          : "no campaign";
        // 3. Ads without metrics (baseline)
        const ads_no_metrics = campId
          ? await rawFetch(`${adsBase}/${advId}/product_ads/ads/search?campaign_id=${campId}&limit=3`, adsH2)
          : "no campaign";

        return NextResponse.json({
          ids: { advId, sellerId, accId },
          campaigns_count: camps.body?.paging?.total,
          campId,
          ads_with_metrics,
          ads_no_metrics,
        });
      }

      case "diagnose": {
        const sb = getServerSupabase();
        if (!sb) {
          return NextResponse.json({
            status: "error",
            supabase: "null — no client",
            env_test_mode: process.env.NEXT_PUBLIC_TEST_MODE ?? "undefined",
            env_url: process.env.NEXT_PUBLIC_SUPABASE_URL ? "set" : "missing",
            env_test_url: process.env.NEXT_PUBLIC_SUPABASE_TEST_URL ? "set" : "missing",
          });
        }
        const { data, error } = await sb.from("ml_sync_estado").select("*").limit(1);
        return NextResponse.json({
          status: "ok",
          supabase: "connected",
          env_test_mode: process.env.NEXT_PUBLIC_TEST_MODE ?? "undefined",
          query_data: data,
          query_error: error ? { message: error.message, details: error.details, hint: error.hint, code: error.code } : null,
        });
      }

      default:
        return NextResponse.json({ error: "action requerido: start|status|reset|retry|diagnose" }, { status: 400 });
    }

  } catch (err) {
    console.error("[metrics-sync] POST Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
