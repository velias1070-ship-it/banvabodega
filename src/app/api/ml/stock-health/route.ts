import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { fetchFulfillmentStock } from "@/lib/ml";

/**
 * GET /api/ml/stock-health
 *
 * Radiografía del pipeline de stock en vivo.
 *
 * Query params:
 *   - check_drift=true   → consulta ML en vivo para detectar diferencias con el cache.
 *   - limit=N            → cuántos SKUs auditar (default 20, max 50).
 *   - mode=top_vendidos  → auditar los más vendidos 30d (default).
 *   - mode=stale         → auditar los con cache más viejo.
 *
 * El check cuesta llamadas a ML (cada SKU = 1 GET), así que es opt-in.
 */
export async function GET(req: NextRequest) {
  try {
    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "Sin conexión" }, { status: 500 });

    const ahora = Date.now();
    const { searchParams } = new URL(req.url);
    const checkDrift = searchParams.get("check_drift") === "true";
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));
    const mode = searchParams.get("mode") || "top_vendidos";

    const [ultimos, erroresRecientes, stockStale, totalCache] = await Promise.all([
      sb.from("ml_webhook_log")
        .select("topic, resource, received_at, processed_at, latency_ms, status, sku_afectado, inventory_id, error")
        .order("received_at", { ascending: false })
        .limit(20),
      sb.from("ml_webhook_log")
        .select("topic, received_at, error, resource")
        .eq("status", "error")
        .order("received_at", { ascending: false })
        .limit(10),
      sb.from("stock_full_cache")
        .select("sku_venta, cantidad, updated_at")
        .order("updated_at", { ascending: true })
        .limit(15),
      sb.from("stock_full_cache").select("sku_venta", { count: "exact", head: true }),
    ]);

    // Stats por topic últimas 24h
    const { data: statsRaw } = await sb.from("ml_webhook_log")
      .select("topic, status, latency_ms, received_at")
      .gte("received_at", new Date(ahora - 24 * 3600 * 1000).toISOString());

    type StatRow = { topic: string; status: string; latency_ms: number | null; received_at: string };
    const porTopic: Record<string, { total: number; ok: number; error: number; ignored: number; avg_ms: number; p95_ms: number; last_seen: string | null }> = {};
    for (const r of (statsRaw as StatRow[] | null) || []) {
      if (!porTopic[r.topic]) porTopic[r.topic] = { total: 0, ok: 0, error: 0, ignored: 0, avg_ms: 0, p95_ms: 0, last_seen: null };
      const s = porTopic[r.topic];
      s.total++;
      if (r.status === "ok") s.ok++;
      else if (r.status === "error") s.error++;
      else if (r.status === "ignored") s.ignored++;
      if (!s.last_seen || r.received_at > s.last_seen) s.last_seen = r.received_at;
    }
    const latsPorTopic: Record<string, number[]> = {};
    for (const r of (statsRaw as StatRow[] | null) || []) {
      if (r.latency_ms == null) continue;
      latsPorTopic[r.topic] = latsPorTopic[r.topic] || [];
      latsPorTopic[r.topic].push(r.latency_ms);
    }
    for (const topic in porTopic) {
      const lats = (latsPorTopic[topic] || []).slice().sort((a, b) => a - b);
      if (lats.length > 0) {
        porTopic[topic].avg_ms = Math.round(lats.reduce((s, v) => s + v, 0) / lats.length);
        porTopic[topic].p95_ms = lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))];
      }
    }

    const stockStaleRows = (stockStale.data || []).map(r => ({
      sku_venta: r.sku_venta,
      cantidad: r.cantidad,
      updated_at: r.updated_at,
      min_sin_actualizar: r.updated_at ? Math.round((ahora - new Date(r.updated_at).getTime()) / 60000) : null,
    }));

    // Warning si los topics críticos de stock no llegaron en las últimas 2h.
    // Nombres reales según /applications/:id (verificados contra ML abr-2026).
    const STOCK_TOPICS = ["stock-locations", "fbm_stock_operations"];
    const warnings: string[] = [];
    for (const t of STOCK_TOPICS) {
      const s = porTopic[t];
      if (!s) warnings.push(`No llegaron webhooks de "${t}" en las últimas 24h (normal si no hubo cambios de stock Full).`);
      else if (s.last_seen && (ahora - new Date(s.last_seen).getTime()) > 2 * 3600 * 1000) {
        const horas = Math.round((ahora - new Date(s.last_seen).getTime()) / 3600000);
        warnings.push(`Último webhook "${t}" hace ${horas}h — posible desconexión.`);
      }
    }

    // ─── Check de drift (opt-in): compara cache vs ML en vivo ───
    type DriftRow = { sku_venta: string; inventory_id: string; cache: number; ml: number; diff: number; updated_at: string | null };
    type DriftCheck = { mode: string; auditados: number; drifts: DriftRow[]; errores: string[]; duracion_ms: number };
    let driftCheck: DriftCheck | null = null;

    if (checkDrift) {
      const tStart = Date.now();
      const config = await sb.from("ml_config").select("seller_id").eq("id", "main").single();
      const sellerId = config.data?.seller_id;
      if (!sellerId) {
        return NextResponse.json({ error: "ML no configurado" }, { status: 500 });
      }

      // Elegir SKUs a auditar
      let skusAuditar: Array<{ sku_venta: string; inventory_id: string; cache: number; updated_at: string | null }> = [];
      if (mode === "stale") {
        const { data } = await sb.from("stock_full_cache")
          .select("sku_venta, cantidad, updated_at")
          .order("updated_at", { ascending: true })
          .limit(limit);
        const skus = (data || []).map(r => r.sku_venta);
        const { data: itemsData } = await sb.from("ml_items_map")
          .select("sku, inventory_id")
          .in("sku", skus);
        const invBySku = new Map<string, string>();
        for (const it of itemsData || []) if (it.inventory_id) invBySku.set(it.sku, it.inventory_id);
        skusAuditar = (data || [])
          .filter(r => invBySku.has(r.sku_venta))
          .map(r => ({ sku_venta: r.sku_venta, inventory_id: invBySku.get(r.sku_venta)!, cache: r.cantidad || 0, updated_at: r.updated_at }));
      } else {
        // top_vendidos: los SKUs con más ventas últimos 30d
        const desde = new Date(ahora - 30 * 86400000).toISOString().slice(0, 10);
        const { data: ventasData } = await sb.from("ventas_ml_cache")
          .select("sku_venta, cantidad")
          .gte("fecha_date", desde)
          .eq("anulada", false);
        const vendidoPorSku = new Map<string, number>();
        for (const v of ventasData || []) {
          vendidoPorSku.set(v.sku_venta, (vendidoPorSku.get(v.sku_venta) || 0) + (v.cantidad || 0));
        }
        const topSkus = Array.from(vendidoPorSku.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([sku]) => sku);
        const [cacheRes, itemsRes] = await Promise.all([
          sb.from("stock_full_cache").select("sku_venta, cantidad, updated_at").in("sku_venta", topSkus),
          sb.from("ml_items_map").select("sku, inventory_id").in("sku", topSkus),
        ]);
        const cacheBySku = new Map<string, { cantidad: number; updated_at: string | null }>();
        for (const r of cacheRes.data || []) cacheBySku.set(r.sku_venta, { cantidad: r.cantidad || 0, updated_at: r.updated_at });
        const invBySku = new Map<string, string>();
        for (const r of itemsRes.data || []) if (r.inventory_id) invBySku.set(r.sku, r.inventory_id);
        skusAuditar = topSkus
          .filter(sku => invBySku.has(sku))
          .map(sku => ({
            sku_venta: sku,
            inventory_id: invBySku.get(sku)!,
            cache: cacheBySku.get(sku)?.cantidad ?? 0,
            updated_at: cacheBySku.get(sku)?.updated_at ?? null,
          }));
      }

      // Consultar ML en paralelo (chunks de 5 para no saturar)
      const drifts: DriftRow[] = [];
      const errores: string[] = [];
      for (let i = 0; i < skusAuditar.length; i += 5) {
        const chunk = skusAuditar.slice(i, i + 5);
        await Promise.all(chunk.map(async item => {
          try {
            const detail = await fetchFulfillmentStock(item.inventory_id, sellerId);
            if (!detail) {
              errores.push(`${item.sku_venta} (${item.inventory_id}): sin respuesta ML`);
              return;
            }
            const mlCant = detail.available_quantity || 0;
            if (mlCant !== item.cache) {
              drifts.push({
                sku_venta: item.sku_venta,
                inventory_id: item.inventory_id,
                cache: item.cache,
                ml: mlCant,
                diff: mlCant - item.cache,
                updated_at: item.updated_at,
              });
            }
          } catch (err) {
            errores.push(`${item.sku_venta}: ${err}`);
          }
        }));
      }

      driftCheck = {
        mode,
        auditados: skusAuditar.length,
        drifts: drifts.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
        errores,
        duracion_ms: Date.now() - tStart,
      };
    }

    return NextResponse.json({
      ok: true,
      ahora: new Date(ahora).toISOString(),
      resumen: {
        webhooks_24h: Object.values(porTopic).reduce((s, v) => s + v.total, 0),
        errores_24h: Object.values(porTopic).reduce((s, v) => s + v.error, 0),
        skus_en_cache: totalCache.count,
      },
      warnings,
      por_topic: porTopic,
      ultimos_webhooks: ultimos.data || [],
      errores_recientes: erroresRecientes.data || [],
      stock_mas_stale: stockStaleRows,
      drift_check: driftCheck,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
