import { NextRequest, NextResponse } from "next/server";
import { mlGet, mlPut, logPriceChange } from "@/lib/ml";
import { getServerSupabase } from "@/lib/supabase-server";
import { loadActiveRuleSet, logDecision } from "@/lib/pricing-rules";
import { newCorrelationId, type ActorPrecio } from "@/lib/pricing-tracking";

export const maxDuration = 60;

/**
 * POST /api/pricing/aplicar-sugerencia
 *
 * Aplica una sugerencia de Pulsos de velocidad. Garantiza que el cambio quede
 * marcado con motivo='senal_pulsos_velocidad' + correlation_id para cerrar el
 * loop hipótesis → cambio → seguimiento → lift.
 *
 * Manuales: Engines:432 (motivo NOT NULL) + Op_Limpieza:87,89,509
 * (aprobado_por + motivo_trigger + correlation_id).
 *
 * Body: { item_id, precio_propuesto, sku?, senal?, actor? }
 *
 * Branches:
 *  - Sin promo activa → PUT /items/{item_id} con price (logPriceChange fuente=item_update_api)
 *  - Con promo activa Y subida (precio_propuesto > precio_actual) → 409:
 *    el admin debe sacar la promo primero. No es seguro mutar la promo.
 *  - Con promo activa Y bajada (profundizar) → join con deal_price más bajo
 *    (logPriceChange fuente=promo_join). Reusa /api/ml/promotions internamente.
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const { item_id, precio_propuesto, sku, senal } = body;
    const actor: ActorPrecio = (body.actor as ActorPrecio | undefined) ?? "admin";

    if (!item_id || typeof precio_propuesto !== "number" || precio_propuesto <= 0) {
      return NextResponse.json({ error: "item_id y precio_propuesto requeridos" }, { status: 400 });
    }

    const correlationId = newCorrelationId();

    // 1. Snapshot del estado actual
    const { data: maps } = await sb.from("ml_items_map")
      .select("sku, item_id, price, sku_origen, listing_type, category_id")
      .eq("item_id", item_id)
      .limit(1);
    const map = (maps || [])[0];
    if (!map) return NextResponse.json({ error: "item no encontrado" }, { status: 404 });

    const skuResolved = sku || map.sku_origen || map.sku;
    const precioAnterior = map.price ?? null;

    // 2. Detectar promo activa via ML API (fuente de verdad: ML, no cache)
    let promoActiva: { id?: string; type: string; status: string; price: number } | null = null;
    try {
      const promos = await mlGet<Array<{ id?: string; type: string; status: string; price: number }>>(
        `/seller-promotions/items/${item_id}?app_version=v2`
      );
      if (Array.isArray(promos)) {
        promoActiva = promos.find(p => p.status === "started") || null;
      }
    } catch { /* ignore — si falla, asumimos sin promo activa y delegamos a mlPut */ }

    const motivoDetalle = {
      origen: "pulsos_velocidad_apply",
      senal: senal ?? null,
      precio_anterior: precioAnterior,
      precio_propuesto,
      promo_activa: promoActiva ? { type: promoActiva.type, id: promoActiva.id, price: promoActiva.price } : null,
    };

    // ─── Branch A: tiene promo activa ─────────────────────────────────
    if (promoActiva) {
      // Solo permitimos profundizar (bajar precio). Subir precio con promo
      // activa requiere DELETE manual primero — no es atomico aca.
      if (precio_propuesto >= promoActiva.price) {
        return NextResponse.json({
          error: "promo_activa_bloquea_subida",
          message: `Este SKU tiene promo activa "${promoActiva.type}" a $${promoActiva.price.toLocaleString("es-CL")}. ` +
                   `Para subir precio, primero hay que sacar la promo manualmente desde el panel.`,
          promo_activa: { type: promoActiva.type, id: promoActiva.id, price: promoActiva.price },
        }, { status: 409 });
      }

      // Profundizar: re-join con deal_price más bajo. Reusamos /api/ml/promotions
      // internamente para no replicar la lógica de credibility/retry.
      const origin = req.nextUrl.origin;
      const promoBody = {
        item_id,
        action: "join",
        promotion_id: promoActiva.id,
        promotion_type: promoActiva.type,
        deal_price: precio_propuesto,
        motivo: "senal_pulsos_velocidad",
        actor,
        motivo_detalle: motivoDetalle,
      };
      const r = await fetch(`${origin}/api/ml/promotions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promoBody),
      });
      const j = await r.json();
      if (!r.ok) {
        return NextResponse.json({ error: j.error || "promotion_failed", detail: j }, { status: r.status });
      }
      return NextResponse.json({
        ok: true,
        branch: "promo_join",
        correlation_id: correlationId,
        applied_price: (j.result?.price as number | undefined) ?? precio_propuesto,
        warning: j.warning ?? null,
      });
    }

    // ─── Branch B: sin promo activa → mlPut directo ───────────────────
    const result = await mlPut<{ id: string; status: string; price: number }>(`/items/${item_id}`, { price: precio_propuesto });
    if (!result) {
      return NextResponse.json({ error: "ml_put_failed" }, { status: 502 });
    }

    // Update cache local
    await sb.from("ml_items_map")
      .update({ price: result.price, updated_at: new Date().toISOString() })
      .eq("item_id", item_id);

    // logPriceChange + logDecision con motivo explícito
    await logPriceChange({
      item_id,
      sku: map.sku,
      sku_origen: skuResolved,
      precio: result.price,
      precio_anterior: precioAnterior,
      fuente: "item_update_api",
      ejecutado_por: actor === "auto" ? "auto_pulsos" : "admin_ui",
      contexto: { senal: senal ?? null, source: "pulsos_velocidad" },
      motivo: "senal_pulsos_velocidad",
      motivo_detalle: motivoDetalle,
      actor,
      correlation_id: correlationId,
    });

    const rs = await loadActiveRuleSet();
    await logDecision({
      sku_origen: skuResolved,
      domain: "global",
      channel: "production",
      rule_set_hash: rs?.content_hash || "FALLBACK",
      inputs: { item_id, senal: senal ?? null, precio_anterior: precioAnterior, precio_propuesto },
      decision: { accion: "pulsos_velocidad_apply", applied_price: result.price, status: "ok" },
      applied: true,
      motivo: "senal_pulsos_velocidad",
      actor,
      request_id: correlationId,
    });

    return NextResponse.json({
      ok: true,
      branch: "item_update",
      correlation_id: correlationId,
      applied_price: result.price,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
