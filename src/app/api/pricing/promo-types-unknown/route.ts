import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { VITRINA_TIER } from "@/lib/pricing";

export const dynamic = "force-dynamic";

/**
 * GET /api/pricing/promo-types-unknown
 *
 * Detecta tipos de promo que aparecen en la data real pero NO están
 * mapeados en VITRINA_TIER (pricing.ts). El motor los trata como tier 1
 * por fallback, lo cual puede ser incorrecto si ML disponibiliza un tipo
 * nuevo de mayor exposición.
 *
 * Response:
 *   { unknown: [{type, count, sample_skus}], known: [...], total_known, total_unknown }
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const knownTypes = new Set(Object.keys(VITRINA_TIER).map(s => s.toUpperCase()));

  // Tipos en promos activas + postulables
  const { data: cacheRows, error } = await sb
    .from("ml_margin_cache")
    .select("sku, item_id, promo_type, promos_postulables")
    .eq("status_ml", "active");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counter = new Map<string, { count: number; sample_skus: string[] }>();
  const bump = (rawType: string | null | undefined, sku: string) => {
    if (!rawType) return;
    const t = String(rawType).toUpperCase().trim();
    if (!t) return;
    const cur = counter.get(t) || { count: 0, sample_skus: [] };
    cur.count++;
    if (cur.sample_skus.length < 3 && !cur.sample_skus.includes(sku)) {
      cur.sample_skus.push(sku);
    }
    counter.set(t, cur);
  };

  for (const row of (cacheRows || []) as Array<{
    sku: string; promo_type: string | null;
    promos_postulables: Array<{ type?: string }> | null;
  }>) {
    if (row.promo_type) bump(row.promo_type, row.sku);
    if (Array.isArray(row.promos_postulables)) {
      for (const p of row.promos_postulables) {
        if (p?.type) bump(p.type, row.sku);
      }
    }
  }

  const unknown: Array<{ type: string; count: number; sample_skus: string[] }> = [];
  const known: Array<{ type: string; count: number; tier: number }> = [];
  Array.from(counter.entries()).forEach(([type, info]) => {
    if (knownTypes.has(type)) {
      known.push({ type, count: info.count, tier: VITRINA_TIER[type] ?? 1 });
    } else {
      unknown.push({ type, count: info.count, sample_skus: info.sample_skus });
    }
  });
  unknown.sort((a, b) => b.count - a.count);
  known.sort((a, b) => b.tier - a.tier || b.count - a.count);

  return NextResponse.json({
    unknown,
    known,
    total_known: known.length,
    total_unknown: unknown.length,
    canonical_official_types: [
      "DEAL", "MARKETPLACE_CAMPAIGN", "PRICE_DISCOUNT", "LIGHTNING",
      "DOD", "VOLUME", "PRE_NEGOTIATED", "SELLER_CAMPAIGN", "SMART",
      "PRICE_MATCHING", "UNHEALTHY_STOCK", "SELLER_COUPON_CAMPAIGN",
    ],
  });
}
