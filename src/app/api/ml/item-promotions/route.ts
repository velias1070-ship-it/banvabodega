import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";

/**
 * GET /api/ml/item-promotions?item_id=MLC123
 *
 * Wrapper liviano sobre /seller-promotions/items/{item_id}?app_version=v2
 * que normaliza los campos útiles para el simulador de margen:
 * tipo, status, rango de precio permitido, sugerido, meli%/seller%,
 * fechas y si ya estás adentro.
 */

type RawPromo = {
  id?: string;
  type?: string;
  sub_type?: string;
  name?: string;
  status?: string;
  offer_type?: string;
  start_date?: string;
  finish_date?: string;
  price?: number;
  original_price?: number;
  suggested_discounted_price?: number;
  min_discounted_price?: number;
  max_discounted_price?: number;
  top_deal_price?: number;
  meli_percentage?: number;
  seller_percentage?: number;
  benefits?: { meli_percentage?: number; seller_percentage?: number };
  deal_id?: string;
};

export type NormalizedPromo = {
  id: string | null;
  type: string;
  sub_type: string | null;
  name: string;
  status: string;
  offer_type: string | null;
  start_date: string | null;
  finish_date: string | null;
  price_actual: number;        // precio si ya estás postulado
  original_price: number;
  suggested_price: number;      // sugerido por ML
  min_price: number;            // mínimo permitido
  max_price: number;            // máximo permitido
  top_deal_price: number;       // umbral de "oferta destacada"
  meli_pct: number;
  seller_pct: number;
  deal_id: string | null;
  // Flags derivados
  activa: boolean;              // status === "started"
  postulable: boolean;          // status === "candidate" o "pending"
  permite_custom_price: boolean; // tipo acepta deal_price custom
};

const PROMO_TYPES_CUSTOM_PRICE = new Set([
  "PRICE_DISCOUNT",
  "DEAL",
  "MARKETPLACE_CAMPAIGN",
  "SELLER_CAMPAIGN",
  "SMART",
  "LIGHTNING",
  "LIGHTNING_DEAL",
  "DOD",
  "MELI_CHOICE",
  "PRICE_MATCHING_MELI_ALL",
  "UNHEALTHY_STOCK",
]);

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const itemId = url.searchParams.get("item_id");
  if (!itemId) {
    return NextResponse.json({ error: "item_id required" }, { status: 400 });
  }

  try {
    const raw = await mlGet<RawPromo[]>(`/seller-promotions/items/${itemId}?app_version=v2`);
    if (!Array.isArray(raw)) {
      return NextResponse.json({ promotions: [] });
    }

    // ML aplica siempre el descuento que mas beneficia al comprador. Cuando
    // hay varias promos con status=started y price>0, la aplicada es la de
    // MENOR price_actual. Las demas tambien tienen status=started pero son
    // candidatas globales donde el item aun no esta suscrito o tiene un precio
    // menos beneficioso.
    // NO se puede usar /items/{id}?price para identificar la aplicada: ese
    // endpoint devuelve el price base del seller, sin considerar DEALs externos
    // (ver comentario en margin-cache/refresh para caso TXV25QLBRBG25).
    const menorPrecioStarted = Math.min(
      ...raw.filter(p => (p.status || "").toLowerCase() === "started" && (p.price || 0) > 0)
        .map(p => p.price || Infinity),
      Infinity,
    );

    const normalized: NormalizedPromo[] = raw.map(p => {
      const type = (p.type || "").toUpperCase();
      const status = (p.status || "").toLowerCase();
      const meliPct = p.meli_percentage ?? p.benefits?.meli_percentage ?? 0;
      const sellerPct = p.seller_percentage ?? p.benefits?.seller_percentage ?? 0;
      const priceActual = p.price ?? 0;
      // "Activa" = status started Y price es el menor (la que ML aplica).
      // Si hay solo 1 started, esa es la aplicada automaticamente.
      const esAplicada = status === "started" && priceActual > 0 &&
        priceActual === menorPrecioStarted;
      return {
        id: p.id ?? null,
        type,
        sub_type: p.sub_type ?? null,
        name: p.name || type || "Promoción",
        status,
        offer_type: p.offer_type ?? null,
        start_date: p.start_date ?? null,
        finish_date: p.finish_date ?? null,
        price_actual: priceActual,
        original_price: p.original_price ?? 0,
        suggested_price: p.suggested_discounted_price ?? 0,
        min_price: p.min_discounted_price ?? 0,
        max_price: p.max_discounted_price ?? 0,
        top_deal_price: p.top_deal_price ?? 0,
        meli_pct: meliPct,
        seller_pct: sellerPct,
        deal_id: p.deal_id ?? null,
        activa: esAplicada,
        // Las started pero no aplicadas (precio mayor) son candidatas disponibles
        postulable: status === "candidate" || status === "pending" ||
          (status === "started" && !esAplicada),
        permite_custom_price: PROMO_TYPES_CUSTOM_PRICE.has(type),
      };
    });

    // Orden: activas primero, postulables después, resto al final
    normalized.sort((a, b) => {
      const rank = (p: NormalizedPromo) => (p.activa ? 0 : p.postulable ? 1 : 2);
      return rank(a) - rank(b);
    });

    return NextResponse.json({ promotions: normalized });
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : "unknown",
      promotions: [],
    }, { status: 500 });
  }
}
