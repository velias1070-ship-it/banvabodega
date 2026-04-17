import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/ml/stock-health
 *
 * Radiografía del pipeline de stock en vivo. Sirve para detectar drift:
 *  - ¿Siguen llegando webhooks de ML?
 *  - ¿Cuál es la latencia?
 *  - ¿Hay SKUs con stock_full_cache "stale" (sin actualizar hace rato)?
 *  - ¿Hay errores recientes en webhooks?
 *
 * Uso: abrir en el navegador o ponerlo en un monitor externo.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    if (!sb) return NextResponse.json({ error: "Sin conexión" }, { status: 500 });

    const ahora = Date.now();

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

    // Stats por topic últimas 24h (inline en vez de RPC)
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
    // Latencias (avg + p95)
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

    // Stock más stale (>60 min sin actualizar es sospechoso)
    const stockStaleRows = (stockStale.data || []).map(r => ({
      sku_venta: r.sku_venta,
      cantidad: r.cantidad,
      updated_at: r.updated_at,
      min_sin_actualizar: r.updated_at ? Math.round((ahora - new Date(r.updated_at).getTime()) / 60000) : null,
    }));

    // Salud global: warning si algún topic de stock no llegó en 2h
    const STOCK_TOPICS = ["marketplace_fbm_stock", "stock-location"];
    const warnings: string[] = [];
    for (const t of STOCK_TOPICS) {
      const s = porTopic[t];
      if (!s) warnings.push(`No llegaron webhooks de "${t}" en las últimas 24h — revisar suscripción en ML.`);
      else if (s.last_seen && (ahora - new Date(s.last_seen).getTime()) > 2 * 3600 * 1000) {
        const horas = Math.round((ahora - new Date(s.last_seen).getTime()) / 3600000);
        warnings.push(`Último webhook "${t}" hace ${horas}h — posible desconexión.`);
      }
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
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
