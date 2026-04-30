import { NextRequest, NextResponse } from "next/server";
import { mlGet, logPriceChange } from "@/lib/ml";
import { newCorrelationId, type MotivoPrecio, type ActorPrecio } from "@/lib/pricing-tracking";
import { getServerSupabase } from "@/lib/supabase-server";
import { loadActiveRuleSet, logDecision } from "@/lib/pricing-rules";

export const maxDuration = 120;

interface PromoInfo {
  id?: string;
  type: string;
  sub_type?: string;
  name?: string;
  status: string;
  price: number;
  original_price: number;
  meli_percentage?: number;
  seller_percentage?: number;
  start_date?: string;
  finish_date?: string;
  suggested_discounted_price?: number;
  min_discounted_price?: number;
  max_discounted_price?: number;
  comision_promo?: number;
}

interface ItemPromoResult {
  item_id: string;
  sku: string;
  titulo: string;
  price_ml: number;
  costo_neto: number;
  costo_bruto: number;
  comision_ml: number;
  comision_pct: number;
  costo_envio: number;
  peso_facturable: number;
  listing_type: string;
  category_id: string;
  promotions: PromoInfo[];
}

/**
 * GET /api/ml/promotions?item_ids=MLC123,MLC456
 * Trae promociones disponibles + costos para calcular márgenes.
 *
 * POST /api/ml/promotions
 * Body: { item_id, action: "create_discount" | "delete", deal_price?, start_date?, finish_date? }
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);

  // Quick fee lookup: /api/ml/promotions?fee_price=12000&listing_type=gold_special&category_id=MLC30059
  const feePrice = url.searchParams.get("fee_price");
  if (feePrice) {
    const lt = url.searchParams.get("listing_type") || "gold_special";
    const cat = url.searchParams.get("category_id") || "";
    const fees = await mlGet<{ sale_fee_amount: number }>(`/sites/MLC/listing_prices?price=${feePrice}&listing_type_id=${lt}&category_id=${cat}`);
    return NextResponse.json({ fee: fees?.sale_fee_amount || 0 });
  }

  const itemIds = url.searchParams.get("item_ids")?.split(",").slice(0, 30) || [];
  if (itemIds.length === 0) return NextResponse.json({ error: "item_ids required" }, { status: 400 });

  const results: ItemPromoResult[] = [];

  // Obtener datos de ml_items_map + productos para costos
  for (const itemId of itemIds) {
    const { data: maps } = await sb.from("ml_items_map")
      .select("sku, item_id, titulo, price, sku_origen, listing_type, category_id")
      .eq("item_id", itemId)
      .limit(1);

    const map = maps?.[0];
    if (!map) continue;

    // Costo del producto
    const skuCosto = map.sku_origen || map.sku;
    const { data: prods } = await sb.from("productos")
      .select("costo, costo_promedio")
      .eq("sku", skuCosto)
      .limit(1);

    const { data: comp } = await sb.from("composicion_venta")
      .select("sku_origen, unidades")
      .eq("sku_venta", map.sku);

    let costoNeto = prods?.[0]?.costo_promedio || prods?.[0]?.costo || 0;
    if (comp && comp.length > 0) {
      let totalCosto = 0;
      for (const c of comp) {
        const { data: cp } = await sb.from("productos")
          .select("costo, costo_promedio")
          .eq("sku", c.sku_origen)
          .limit(1);
        totalCosto += ((cp?.[0]?.costo_promedio || cp?.[0]?.costo || 0)) * c.unidades;
      }
      if (totalCosto > 0) costoNeto = totalCosto;
    }

    // Comisión ML via API listing_prices
    let comisionMl = 0;
    let comisionPct = 0;
    const price = map.price || 0;
    const listingType = map.listing_type || "gold_special";
    const categoryId = map.category_id || "";
    if (price > 0 && categoryId) {
      try {
        const fees = await mlGet<{ sale_fee_amount: number; sale_fee_details?: { percentage_fee: number } }>(`/sites/MLC/listing_prices?price=${price}&listing_type_id=${listingType}&category_id=${categoryId}`);
        comisionMl = fees?.sale_fee_amount || 0;
        comisionPct = fees?.sale_fee_details?.percentage_fee || 0;
      } catch { /* ignore */ }
    }

    // Costo envío desde API de ML (tarifa real por peso/dimensiones del item)
    let costoEnvio = 0;
    let pesoFacturable = 0;
    try {
      const sellerId = (await sb.from("ml_config").select("seller_id").eq("id", "main").limit(1)).data?.[0]?.seller_id;
      if (sellerId) {
        const shipFree = await mlGet<{ coverage: { all_country: { list_cost: number; billable_weight: number } } }>(
          `/users/${sellerId}/shipping_options/free?item_id=${itemId}`
        );
        if (shipFree?.coverage?.all_country) {
          costoEnvio = shipFree.coverage.all_country.list_cost;
          pesoFacturable = shipFree.coverage.all_country.billable_weight;
        }
      }
    } catch { /* ignore */ }

    // Promociones de ML + calcular comisión con precio promo
    let promotions: PromoInfo[] = [];
    try {
      const promos = await mlGet<PromoInfo[]>(`/seller-promotions/items/${itemId}?app_version=v2`);
      if (promos && Array.isArray(promos)) {
        for (const p of promos) {
          let comisionPromo = 0;
          const promoPrice = p.price > 0 ? p.price : (p.suggested_discounted_price || 0);
          if (promoPrice > 0 && categoryId) {
            try {
              const feesPromo = await mlGet<{ sale_fee_amount: number }>(`/sites/MLC/listing_prices?price=${promoPrice}&listing_type_id=${listingType}&category_id=${categoryId}`);
              comisionPromo = feesPromo?.sale_fee_amount || 0;
            } catch { /* ignore */ }
          }
          promotions.push({ ...p, comision_promo: comisionPromo });
        }
      }
    } catch { /* ignore */ }

    results.push({
      item_id: itemId,
      sku: map.sku,
      titulo: map.titulo || "",
      price_ml: price,
      costo_neto: costoNeto,
      costo_bruto: Math.round(costoNeto * 1.19),
      comision_ml: comisionMl,
      comision_pct: comisionPct,
      costo_envio: costoEnvio,
      peso_facturable: pesoFacturable,
      listing_type: listingType,
      category_id: categoryId,
      promotions,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  return NextResponse.json({ items: results });
}

/**
 * Para errores de credibility de ML: trae las promos candidate del item y
 * filtra a la promo+variation específica que estamos postulando. Match por:
 *   1. variation_id (si el item tiene variations clásicas, cada una con su rango)
 *   2. promotion_id (la deal exacta)
 *   3. promotion_type (DEAL, SMART, etc.)
 *   4. fallback al primer candidate
 *
 * Antes mezclaba rangos de TODAS las candidates ("best for seller") y mostraba
 * un techo que correspondía a otra deal o a otra variant — caso testigo
 * TXV24QLBRDN20 postulando "Día de la mama 2026" en variation X (rango ≤
 * $19.780) recibía hint de la variation Y (max $28.481).
 */
async function buildCredibilityHint(
  itemId: string,
  dealPriceRequested: number,
  targetPromotionId?: string,
  targetPromotionType?: string,
  targetVariationId?: number | null,
) {
  try {
    const promos = await mlGet<Array<{
      id?: string; type: string; name?: string; status: string;
      min_discounted_price?: number; max_discounted_price?: number;
      suggested_discounted_price?: number; variation_id?: number | null;
    }>>(`/seller-promotions/items/${itemId}?app_version=v2`);
    if (!promos || !Array.isArray(promos)) return null;
    // Lista amplia: cualquier promo con rango definido. PRICE_DISCOUNT no
    // aparece como `candidate` hasta crearse, pero ML expone su rango en otro
    // status. Cuando el caller pasa un target específico (id/type) buscamos
    // sobre TODO el array; si no pasa target, usamos solo candidates clásicos.
    const conRango = promos.filter(p =>
      typeof p.max_discounted_price === "number" && (p.max_discounted_price || 0) > 0,
    );
    if (conRango.length === 0) return null;
    let pool = conRango;
    if (targetVariationId != null) {
      const sameVar = conRango.filter(p => p.variation_id === targetVariationId);
      if (sameVar.length > 0) pool = sameVar;
    }
    // Match por id > type. Si el caller especificó target y no hay match,
    // devolver null en vez de caer a un candidate cualquiera — antes caía al
    // primer candidate y mostraba el rango de OTRA promo (caso testigo:
    // create_discount con type=PRICE_DISCOUNT devolvía hint de Cyber Day).
    let match = targetPromotionId
      ? pool.find(p => p.id === targetPromotionId)
      : undefined;
    if (!match && targetPromotionType) {
      match = pool.find(p => p.type === targetPromotionType);
    }
    if (!match && !targetPromotionId && !targetPromotionType) {
      // Sin target específico: fallback al primer candidate clásico (status=candidate).
      match = pool.find(p => p.status === "candidate") || pool[0];
    }
    if (!match) return null;
    return {
      max_aceptable: match.max_discounted_price!,
      sugerido: match.suggested_discounted_price || 0,
      min_aceptable: match.min_discounted_price || 0,
      promo_referencia: match.name || match.type,
      variation_id: match.variation_id ?? null,
      precio_solicitado: dealPriceRequested,
    };
  } catch {
    return null;
  }
}

function friendlyCredibilityError(
  hint: {
    max_aceptable: number;
    sugerido: number;
    min_aceptable: number;
    precio_solicitado: number;
    promo_referencia: string;
  } | null,
  rawErr: string,
): { message: string; max_aceptable?: number; min_aceptable?: number; sugerido?: number; sugerido_original?: number } {
  if (!hint) {
    return { message: `ML rechazó el precio. Probá un valor más bajo. (${rawErr})` };
  }
  const fmt = (n: number) => `$${n.toLocaleString("es-CL")}`;
  const rango = hint.min_aceptable > 0
    ? `Rango aceptable: ${fmt(hint.min_aceptable)} – ${fmt(hint.max_aceptable)}`
    : `Máximo aceptable: ${fmt(hint.max_aceptable)}`;
  const sug = hint.sugerido > 0 ? ` · Sugerido: ${fmt(hint.sugerido)}` : "";
  let causa: string;
  let sugeridoAplicable = hint.sugerido;
  if (hint.precio_solicitado > hint.max_aceptable) {
    causa = `supera el techo permitido`;
  } else if (hint.min_aceptable > 0 && hint.precio_solicitado < hint.min_aceptable) {
    causa = `cae debajo del piso permitido`;
  } else if (hint.sugerido > 0 && Math.abs(hint.precio_solicitado - hint.sugerido) < 1) {
    // El precio solicitado COINCIDE con el sugerido pero ML igual rechazó.
    // El rango GET de ML es engañoso para este item — probablemente hay una
    // regla de descuento mínimo respecto al price_ml que no aparece en el GET.
    // No tiene sentido devolver el sugerido como recomendación (loop), mejor
    // sugerir un precio más conservador (~80% del techo).
    sugeridoAplicable = Math.round(hint.max_aceptable * 0.7);
    causa = `ML rechaza incluso el sugerido (rango GET no aplica al POST). Probá ~${fmt(sugeridoAplicable)} (70% del techo)`;
  } else {
    // Precio dentro del rango pero rechazado.
    causa = hint.sugerido > 0
      ? `el rango GET de ML es engañoso, ML rechazó al POST. Postulá al sugerido ${fmt(hint.sugerido)}`
      : `ML rechazó pese a estar dentro del rango. Probá un valor distinto`;
  }
  const msg = `ML rechazó ${fmt(hint.precio_solicitado)} en "${hint.promo_referencia}": ${causa}. ${rango}${sug}.`;
  return {
    message: msg,
    max_aceptable: hint.max_aceptable,
    min_aceptable: hint.min_aceptable,
    // sugerido_aplicable: si precio_solicitado coincidía con el sugerido, este
    // viene reducido (~70% del techo) para no caer en loop. El frontend usa
    // este campo para auto-cargar el input.
    sugerido: sugeridoAplicable,
    sugerido_original: hint.sugerido,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { item_id, action, deal_price, start_date, finish_date, promotion_id, promotion_type } = body;
    // variation_id opcional: items con variations clásicas tienen rangos de
    // credibility por variant. Sin esto ML aplica al item entero (o al primero).
    const variationIdRaw = body.variation_id;
    const variation_id: number | null = typeof variationIdRaw === "number"
      ? variationIdRaw
      : (typeof variationIdRaw === "string" && variationIdRaw ? Number(variationIdRaw) : null);
    if (!item_id || !action) {
      return NextResponse.json({ error: "item_id y action requeridos" }, { status: 400 });
    }
    // v95 — motivo y actor del cambio. Si caller no los pasa, default razonable
    // según action. Manuales: Engines:432 (reason text NOT NULL), Op_Limpieza:87
    // (aprobado_por). Permite distinguir hipótesis (Pulsos) de operativo (DEAL).
    const motivoBody = (body.motivo as MotivoPrecio | undefined) ?? null;
    const actorBody = (body.actor as ActorPrecio | undefined) ?? "admin";
    const motivoDetalle = (body.motivo_detalle as Record<string, unknown> | undefined) ?? null;
    const correlationId = newCorrelationId();

    const token = await getToken();
    const auditSb = getServerSupabase();
    // Snapshot del estado previo del item (para trazar el cambio en audit log)
    let prevSku: string | null = null;
    let prevPrice: number | null = null;
    if (auditSb) {
      const { data: mapRow } = await auditSb.from("ml_items_map")
        .select("sku, price").eq("item_id", item_id).limit(1);
      const row = (mapRow || [])[0] as { sku?: string; price?: number } | undefined;
      prevSku = row?.sku || null;
      prevPrice = row?.price ?? null;
    }
    // Helper para logear acciones de promo. No bloquea pero loguea errores
    // para poder depurar si el insert falla (antes era silent y no se veia).
    const logAction = async (accion: string, detalle: Record<string, unknown>) => {
      if (!auditSb) {
        console.warn("[ml_promo_log] no supabase client, skipping");
        return;
      }
      const { error } = await auditSb.from("admin_actions_log").insert({
        accion,
        entidad: "ml_items_map",
        entidad_id: item_id,
        detalle: { sku: prevSku, prev_price: prevPrice, ...detalle },
      });
      if (error) {
        console.error(`[ml_promo_log] insert failed for ${accion} on ${item_id}: ${error.message}`);
      }
    };

    // Helper: parsea respuesta de ML defensivamente (puede venir vacía)
    const parseMlResponse = async (resp: Response) => {
      const raw = await resp.text();
      let data: unknown = {};
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = { raw }; }
      }
      return data;
    };

    if (action === "create_discount") {
      if (!deal_price || !start_date || !finish_date) {
        return NextResponse.json({ error: "deal_price, start_date, finish_date requeridos" }, { status: 400 });
      }
      const discountBody: Record<string, unknown> = {
        promotion_type: "PRICE_DISCOUNT", deal_price, start_date, finish_date,
      };
      if (variation_id != null) discountBody.variation_id = variation_id;
      const resp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(discountBody),
      });
      const data = await parseMlResponse(resp);
      if (!resp.ok) {
        const errMsg = (data as { message?: string }).message || `HTTP ${resp.status}`;
        await logAction("ml_promo:create_discount_error", { deal_price, variation_id, start_date, finish_date, error: errMsg });
        if (/credibility|credible|ERROR_CREDIBILITY/i.test(errMsg)) {
          // create_discount es siempre PRICE_DISCOUNT (la promo propia del seller).
          const hint = await buildCredibilityHint(item_id, deal_price, undefined, "PRICE_DISCOUNT", variation_id);
          const friendly = friendlyCredibilityError(hint, errMsg);
          return NextResponse.json({
            error: friendly.message,
            code: "CREDIBILITY_REJECT",
            max_aceptable: friendly.max_aceptable,
            min_aceptable: friendly.min_aceptable,
            sugerido: friendly.sugerido,
            sugerido_original: friendly.sugerido_original,
            variation_id,
            raw_error: errMsg,
            detail: data,
          }, { status: resp.status });
        }
        return NextResponse.json({ error: errMsg, detail: data }, { status: resp.status });
      }
      await logAction("ml_promo:create_discount", { deal_price, variation_id, start_date, finish_date, result: data });
      return NextResponse.json({ ok: true, result: data });
    }

    if (action === "join") {
      const { offer_type } = body;
      const joinBody: Record<string, unknown> = { promotion_type };
      if (promotion_id) joinBody.promotion_id = promotion_id;
      // ML usa distintos campos según el tipo de promo:
      //   - PRICE_DISCOUNT, DEAL, MARKETPLACE_CAMPAIGN, DOD → deal_price
      //   - SELLER_CAMPAIGN (FLEXIBLE_PERCENTAGE, CUSTOM_PRICE) → price
      // Mandamos AMBOS para cubrir todos los casos — ML ignora el que no aplica.
      if (deal_price) {
        joinBody.deal_price = deal_price;
        joinBody.price = deal_price;
      }
      if (offer_type) joinBody.offer_type = offer_type;
      // Items con variations clásicas: aplicar promo a la variant específica.
      if (variation_id != null) joinBody.variation_id = variation_id;

      // BUG confirmado probando live: cuando un ítem ya está en un SELLER_CAMPAIGN
      // con un precio, el POST NO actualiza el precio aunque devuelva 201 Created.
      // ML silenciosamente ignora el cambio. Para actualizar necesitamos
      // DELETE → wait → POST fresh. DELETE sin query params extra es seguro
      // (idempotente: si no estaba, no pasa nada).
      if (promotion_type === "SELLER_CAMPAIGN") {
        try {
          await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          // ML propaga con ~3-5s de lag tras el DELETE
          await new Promise(r => setTimeout(r, 2500));
        } catch { /* ignore, el POST siguiente tirará error si hay algo mal */ }
      }

      let resp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(joinBody),
      });
      let data = await parseMlResponse(resp);

      // Auto-retry OFFER_ALREADY_EXISTS: el item ya tiene una promo activa
      // (la misma o una distinta). Para actualizar el precio o cambiar de promo
      // necesitamos DELETE → wait → POST. Lo hacemos automatico aca para que
      // cualquier caller (modal "Actualizar", switch, bulk) funcione sin retry
      // duplicado en frontend.
      if (!resp.ok) {
        const errMsg = (data as { message?: string }).message || "";
        if (/offer_already_exists/i.test(errMsg) || /offer.*already/i.test(errMsg)) {
          try {
            await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 4500));
          resp = await fetch(`https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(joinBody),
          });
          data = await parseMlResponse(resp);
        }
      }

      if (!resp.ok) {
        const errMsg = (data as { message?: string }).message || `HTTP ${resp.status}`;
        await logAction("ml_promo:join_error", { promotion_id, promotion_type, deal_price, variation_id, error: errMsg });
        if (/credibility|credible|ERROR_CREDIBILITY/i.test(errMsg)) {
          // En join sí tenemos la promo concreta — pasarla para que el hint no
          // mezcle rangos de otras candidates ni de otras variations.
          const hint = await buildCredibilityHint(item_id, deal_price, promotion_id, promotion_type, variation_id);
          const friendly = friendlyCredibilityError(hint, errMsg);
          return NextResponse.json({
            error: friendly.message,
            code: "CREDIBILITY_REJECT",
            max_aceptable: friendly.max_aceptable,
            min_aceptable: friendly.min_aceptable,
            sugerido: friendly.sugerido,
            sugerido_original: friendly.sugerido_original,
            variation_id,
            raw_error: errMsg,
            detail: data,
          }, { status: resp.status });
        }
        return NextResponse.json({ error: errMsg, detail: data }, { status: resp.status });
      }

      // ML puede aceptar el POST (201 Created) pero silenciosamente ignorar
      // el precio si la campaña no lo soporta. En la respuesta viene el
      // precio REAL aplicado. Si difiere significativamente del que pedimos,
      // avisamos al caller con un flag para que muestre un warning.
      const appliedPrice = (data as { price?: number }).price;
      const priceTolerance = Math.max(200, Math.round(deal_price * 0.02));
      if (deal_price && appliedPrice && Math.abs(appliedPrice - deal_price) > priceTolerance) {
        await logAction("ml_promo:join", { promotion_id, promotion_type, deal_price_requested: deal_price, deal_price_applied: appliedPrice, overridden: true });
        await logPriceChange({
          item_id, sku: prevSku,
          precio: appliedPrice, precio_anterior: prevPrice,
          promo_name: promotion_id || promotion_type, fuente: "promo_join",
          ejecutado_por: "admin_ui",
          contexto: { promotion_type, promotion_id, deal_price_requested: deal_price, overridden: true },
          motivo: motivoBody,  // explicit del UI; null → infer (postular_evento/ml_obliga_precio)
          motivo_detalle: motivoDetalle,
          actor: actorBody,
          correlation_id: correlationId,
        });
        // Audit canónico: cambios manuales también van a pricing_decision_log
        // (Engines:80, "rerun specific request"). Trazabilidad simétrica con motor.
        if (prevSku) {
          const rs = await loadActiveRuleSet();
          await logDecision({
            sku_origen: prevSku, domain: "global", channel: "production",
            rule_set_hash: rs?.content_hash || "FALLBACK",
            inputs: { item_id, promotion_type, promotion_id, precio_anterior: prevPrice, deal_price_requested: deal_price },
            decision: { accion: "manual_promo_join", applied_price: appliedPrice, status: "overridden" },
            applied: true,
            motivo: motivoBody,
            actor: actorBody,
            request_id: correlationId,
          });
        }
        return NextResponse.json({
          ok: true,
          result: data,
          warning: {
            type: "price_overridden",
            requested: deal_price,
            applied: appliedPrice,
            message: `ML ignoró tu precio ($${deal_price.toLocaleString("es-CL")}) y aplicó $${appliedPrice.toLocaleString("es-CL")} según la regla de la campaña.`,
          },
        });
      }
      await logAction("ml_promo:join", { promotion_id, promotion_type, deal_price, deal_price_applied: appliedPrice });
      if (appliedPrice) {
        await logPriceChange({
          item_id, sku: prevSku,
          precio: appliedPrice, precio_anterior: prevPrice,
          promo_name: promotion_id || promotion_type, fuente: "promo_join",
          ejecutado_por: "admin_ui",
          contexto: { promotion_type, promotion_id, deal_price_requested: deal_price },
          motivo: motivoBody,
          motivo_detalle: motivoDetalle,
          actor: actorBody,
          correlation_id: correlationId,
        });
        if (prevSku) {
          const rs = await loadActiveRuleSet();
          await logDecision({
            sku_origen: prevSku, domain: "global", channel: "production",
            rule_set_hash: rs?.content_hash || "FALLBACK",
            inputs: { item_id, promotion_type, promotion_id, precio_anterior: prevPrice, deal_price_requested: deal_price },
            decision: { accion: "manual_promo_join", applied_price: appliedPrice, status: "ok" },
            applied: true,
            motivo: motivoBody,
            actor: actorBody,
            request_id: correlationId,
          });
        }
      }
      return NextResponse.json({ ok: true, result: data });
    }

    if (action === "delete") {
      const { promotion_type: delType, promotion_id: delId } = body;
      let url = `https://api.mercadolibre.com/seller-promotions/items/${item_id}?app_version=v2`;
      if (delType) url += `&promotion_type=${delType}`;
      if (delId) url += `&promotion_id=${delId}`;
      const resp = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await parseMlResponse(resp);
      if (!resp.ok) {
        const errMsg = (data as { message?: string }).message || `HTTP ${resp.status}`;
        await logAction("ml_promo:delete_error", { promotion_id: delId, promotion_type: delType, error: errMsg });
        return NextResponse.json({ error: errMsg, detail: data }, { status: resp.status });
      }
      await logAction("ml_promo:delete", { promotion_id: delId, promotion_type: delType });
      // Tras el delete el precio publicado vuelve al listado. ML no devuelve
      // el nuevo precio en el body; el cron de margin-cache/refresh lo va a
      // capturar como sync_diff dentro de 2min, pero igual dejamos un marker
      // explicito (precio=null en la tabla no es valido, asi que solo logeamos
      // si ML devolvio algo en data.price post-delete).
      const postDeletePrice = (data as { price?: number }).price;
      if (postDeletePrice) {
        // Para delete, motivo default es 'revertir' (subir precio post-promo).
        // El caller puede override via body.motivo si fue otra razón.
        const motivoDelete = motivoBody ?? "revertir";
        await logPriceChange({
          item_id, sku: prevSku,
          precio: postDeletePrice, precio_anterior: prevPrice,
          fuente: "promo_delete", ejecutado_por: "admin_ui",
          contexto: { promotion_type: delType, promotion_id: delId },
          motivo: motivoDelete,
          motivo_detalle: motivoDetalle,
          actor: actorBody,
          correlation_id: correlationId,
        });
        if (prevSku) {
          const rs = await loadActiveRuleSet();
          await logDecision({
            sku_origen: prevSku, domain: "global", channel: "production",
            rule_set_hash: rs?.content_hash || "FALLBACK",
            inputs: { item_id, promotion_type: delType, promotion_id: delId, precio_anterior: prevPrice },
            decision: { accion: "manual_promo_delete", applied_price: postDeletePrice, status: "ok" },
            applied: true,
            motivo: motivoDelete,
            actor: actorBody,
            request_id: correlationId,
          });
        }
      }
      return NextResponse.json({ ok: true, result: data });
    }

    return NextResponse.json({ error: "action inválida" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function getToken(): Promise<string> {
  const sb = getServerSupabase();
  if (!sb) return "";
  const { data } = await sb.from("ml_config").select("access_token").eq("id", "main").limit(1);
  return data?.[0]?.access_token || "";
}
