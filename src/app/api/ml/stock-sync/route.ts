import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { syncStockToML } from "@/lib/ml";

// Vercel Pro: allow up to 60s execution
export const maxDuration = 60;

/**
 * Stock sync endpoint — pushes WMS stock to MercadoLibre using distributed stock API.
 *
 * Pack-aware: when a sku_venta has composicion_venta, calculates:
 *   publicar = FLOOR((disponible_origen - buffer) / unidades_pack)
 *
 * Buffer: 2 for simple SKUs, 4 for SKUs with shared packs (multiple sku_venta
 * consuming the same sku_origen).
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const referer = req.headers.get("referer") || "";
  const isAdminCall = referer.includes("/admin");
  const isInternal = req.headers.get("x-internal") === "1";

  if (!isVercelCron && !isLocalDev && !isAdminCall && !isInternal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // 0. If enqueue_all=1, queue all active SKUs first (server-side, no client limits)
    const url = new URL(req.url);
    if (url.searchParams.get("enqueue_all") === "1") {
      const { data: activeSkus } = await sb.from("ml_items_map").select("sku").eq("activo", true);
      if (activeSkus && activeSkus.length > 0) {
        const rows = (activeSkus as { sku: string }[]).map(r => ({ sku: r.sku, created_at: new Date().toISOString() }));
        // Batch upsert in chunks of 500
        for (let i = 0; i < rows.length; i += 500) {
          await sb.from("stock_sync_queue").upsert(rows.slice(i, i + 500), { onConflict: "sku" });
        }
        console.log(`[ML Stock Sync] Enqueued ${activeSkus.length} active SKUs`);
      }
    }

    // 1. Read the sync queue
    const { data: queue } = await sb.from("stock_sync_queue").select("sku").order("created_at");
    const skus = (queue || []).map((d: { sku: string }) => d.sku);

    if (skus.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, total: 0, remaining: 0, message: "queue empty" });
    }

    // 2. Load composicion_venta for pack resolution
    const { data: composiciones } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");
    const compMap: Record<string, { sku_origen: string; unidades: number }> = {};
    const origenToVentas: Record<string, string[]> = {};
    for (const c of (composiciones || []) as { sku_venta: string; sku_origen: string; unidades: number }[]) {
      compMap[c.sku_venta] = { sku_origen: c.sku_origen, unidades: c.unidades };
      if (!origenToVentas[c.sku_origen]) origenToVentas[c.sku_origen] = [];
      if (!origenToVentas[c.sku_origen].includes(c.sku_venta)) {
        origenToVentas[c.sku_origen].push(c.sku_venta);
      }
    }

    // 3. Load ml_items_map for sku_origen resolution (before expansion so we can use it)
    const { data: itemMaps } = await sb.from("ml_items_map")
      .select("sku, sku_origen").eq("activo", true);
    const mlSkuOrigen: Record<string, string> = {};
    const mlOrigenToVentas: Record<string, string[]> = {};
    for (const m of (itemMaps || []) as { sku: string; sku_origen: string | null }[]) {
      if (m.sku_origen) {
        mlSkuOrigen[m.sku] = m.sku_origen;
        if (!mlOrigenToVentas[m.sku_origen]) mlOrigenToVentas[m.sku_origen] = [];
        if (!mlOrigenToVentas[m.sku_origen].includes(m.sku)) mlOrigenToVentas[m.sku_origen].push(m.sku);
      }
    }

    // 4. Expand queue: for each SKU, include pack siblings + ml_items_map sku_venta
    const expandedSkus = new Set<string>();
    for (const sku of skus) {
      expandedSkus.add(sku);
      // If this sku_venta has a composicion, find siblings
      const comp = compMap[sku];
      if (comp) {
        const siblings = origenToVentas[comp.sku_origen] || [];
        for (const sib of siblings) expandedSkus.add(sib);
      }
      // If this IS a sku_origen, find all sku_venta via composicion_venta
      const ventas = origenToVentas[sku];
      if (ventas) {
        for (const sv of ventas) expandedSkus.add(sv);
      }
      // Also expand via ml_items_map: sku_origen → sku_venta
      const mlVentas = mlOrigenToVentas[sku];
      if (mlVentas) {
        for (const sv of mlVentas) expandedSkus.add(sv);
      }
    }

    // 5. Shared origins (have >1 sku_venta) get bigger buffer
    const sharedOrigins = new Set<string>();
    for (const [origen, ventas] of Object.entries(origenToVentas)) {
      if (ventas.length > 1) sharedOrigins.add(origen);
    }

    console.log(`[ML Stock Sync] Processing ${expandedSkus.size} SKUs (${skus.length} queued + siblings)`);
    const uniqueSkus = Array.from(expandedSkus);
    let synced = 0;
    const errors: string[] = [];
    const startTime = Date.now();
    const TIME_LIMIT = 55_000; // 55s per batch
    const processed: string[] = [];

    for (let idx = 0; idx < uniqueSkus.length; idx++) {
      if (Date.now() - startTime > TIME_LIMIT) {
        console.log(`[ML Stock Sync] Time limit reached, ${uniqueSkus.length - idx} SKUs remaining in queue`);
        break;
      }
      const sku = uniqueSkus[idx];
      processed.push(sku);
      if (idx > 0) await new Promise(r => setTimeout(r, 200));
      try {
        // 6. Resolve sku_origen and unidades
        const comp = compMap[sku];
        const skuOrigen = comp?.sku_origen || mlSkuOrigen[sku] || sku;
        const unidadesPack = comp?.unidades || 1;
        const buffer = sharedOrigins.has(skuOrigen) ? 4 : 2;

        // 7. Get disponible from v_stock_disponible by sku_origen
        const { data: stockRow } = await sb.from("v_stock_disponible")
          .select("disponible").eq("sku", skuOrigen).maybeSingle();
        const disponibleOrigen = Math.max(0, (stockRow as { disponible: number } | null)?.disponible ?? 0);

        // 8. Calculate: publicar = FLOOR((disponible - buffer) / unidades_pack)
        const available = Math.max(0, Math.floor((disponibleOrigen - buffer) / unidadesPack));

        // 9. Send to ML
        const count = await syncStockToML(sku, available);
        if (count > 0) {
          synced++;
          // Update stock_flex_cache so timeline shows current value
          await sb.from("ml_items_map")
            .update({ stock_flex_cache: available, cache_updated_at: new Date().toISOString() })
            .eq("sku", sku).eq("activo", true);
        }
      } catch (err) {
        errors.push(`${sku}: ${String(err)}`);
      }
    }

    // 10. Clear only processed items from queue (not timed-out ones)
    await sb.from("stock_sync_queue").delete().in("sku", processed);

    const remaining = uniqueSkus.length - processed.length;
    console.log(`[ML Stock Sync] Done: ${synced}/${processed.length} synced, ${remaining} remaining`);
    return NextResponse.json({
      status: "ok",
      synced,
      total: processed.length,
      remaining,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("[ML Stock Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
