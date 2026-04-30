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
  // Para items con variations clásicas (un MLC con variation[]), ML emite una
  // entry por variation con rangos propios. Si el item es User Products /
  // multi-warehouse (variantes son items distintos compartiendo family_name),
  // este campo viene null y todo el rango aplica al item entero.
  variation_id?: number | null;
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
  min_price: number;            // mínimo permitido (0 si ML no lo expone, ej. started)
  max_price: number;            // máximo permitido (0 si ML no lo expone)
  // Rango estimado por inferencia: para promos `started` donde ML no expone
  // min/max, miramos las candidates de la MISMA promo en la MISMA variation.
  // Antes mezclábamos rangos de todas las variations del item — fallaba para
  // items con variations donde cada una tiene su propio techo de credibility.
  min_price_estimado: number;
  max_price_estimado: number;
  range_estimado: boolean;
  top_deal_price: number;       // umbral de "oferta destacada"
  meli_pct: number;
  seller_pct: number;
  deal_id: string | null;
  variation_id: number | null;  // null si la promo aplica al item entero
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
  "SELLER_COUPON_CAMPAIGN",
  "SMART",
  "LIGHTNING",
  "DOD",
  "VOLUME",
  "PRE_NEGOTIATED",
  "PRICE_DISCOUNT",
  "PRICE_MATCHING",
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

    // Estimación del rango de credibility por (item, variation_id):
    // antes mezclábamos TODAS las candidates del item ignorando que para items
    // con variations clásicas cada variation tiene su propio techo. Ahora
    // agrupamos por variation_id (null = item entero) y calculamos por grupo.
    type RangoCache = { max: number; min: number };
    const rangosPorVariation = new Map<string, RangoCache>();
    for (const p of raw) {
      if ((p.status || "").toLowerCase() !== "candidate") continue;
      if (typeof p.max_discounted_price !== "number" || (p.max_discounted_price || 0) <= 0) continue;
      const key = p.variation_id != null ? String(p.variation_id) : "_item";
      const max = p.max_discounted_price || 0;
      const min = p.min_discounted_price || 0;
      const prev = rangosPorVariation.get(key);
      if (!prev) {
        rangosPorVariation.set(key, { max, min });
      } else {
        rangosPorVariation.set(key, {
          max: Math.max(prev.max, max),
          min: prev.min === 0 ? min : (min > 0 ? Math.min(prev.min, min) : prev.min),
        });
      }
    }

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
      const minRaw = p.min_discounted_price ?? 0;
      const maxRaw = p.max_discounted_price ?? 0;
      const tieneRangoPropio = minRaw > 0 || maxRaw > 0;
      const variationKey = p.variation_id != null ? String(p.variation_id) : "_item";
      const rangoEstimado = rangosPorVariation.get(variationKey) || { max: 0, min: 0 };
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
        min_price: minRaw,
        max_price: maxRaw,
        min_price_estimado: tieneRangoPropio ? minRaw : rangoEstimado.min,
        max_price_estimado: tieneRangoPropio ? maxRaw : rangoEstimado.max,
        range_estimado: !tieneRangoPropio && rangoEstimado.max > 0,
        top_deal_price: p.top_deal_price ?? 0,
        meli_pct: meliPct,
        seller_pct: sellerPct,
        deal_id: p.deal_id ?? null,
        variation_id: p.variation_id ?? null,
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
