import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface PromoInfo {
  type: string;
  status: string;
  price: number;
  name?: string;
}

/**
 * GET /api/ml/scan-promos
 * Escanea TODOS los items activos y devuelve los que no tienen promo activa.
 * Ejecuta server-side para máxima velocidad (sin round-trips al browser).
 */
export async function GET(req: NextRequest) {
  const hasParams = req.nextUrl.searchParams.has("run");
  if (!hasParams) return NextResponse.json({ error: "?run=true required" }, { status: 400 });

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { data: items } = await sb.from("ml_items_map")
    .select("item_id, sku, titulo, price, status_ml")
    .eq("activo", true)
    .eq("status_ml", "active");

  if (!items || items.length === 0) {
    return NextResponse.json({ total: 0, sin_promo: [], con_promo: 0 });
  }

  // Deduplicar por item_id
  const unique = Array.from(new Map(items.map(i => [i.item_id, i])).values());

  const sinPromo: Array<{ item_id: string; sku: string; titulo: string; price: number; promos_disponibles: number }> = [];
  const conPromo: Array<{ item_id: string; sku: string; titulo: string }> = [];

  // Escanear en paralelo (5 concurrentes)
  const CONCURRENCY = 5;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const promos = await mlGet<PromoInfo[]>(`/seller-promotions/items/${item.item_id}?app_version=v2`);
          if (!promos || !Array.isArray(promos)) return { item, hasActive: false, disponibles: 0 };
          const hasActive = promos.some(p => p.status === "started");
          const disponibles = promos.filter(p => p.status === "candidate" || p.status === "pending").length;
          return { item, hasActive, disponibles };
        } catch {
          return { item, hasActive: false, disponibles: 0 };
        }
      })
    );

    for (const r of results) {
      if (r.hasActive) {
        conPromo.push({ item_id: r.item.item_id, sku: r.item.sku, titulo: r.item.titulo });
      } else {
        sinPromo.push({ item_id: r.item.item_id, sku: r.item.sku, titulo: r.item.titulo || "", price: r.item.price || 0, promos_disponibles: r.disponibles });
      }
    }
  }

  return NextResponse.json({
    total: unique.length,
    con_promo: conPromo.length,
    sin_promo: sinPromo,
  });
}
