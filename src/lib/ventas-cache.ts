import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet } from "@/lib/ml";
import { preloadCostos, resolverCostoVenta, calcularMargenVenta } from "@/lib/costos";
import { decidirSnapshotCosto } from "@/lib/snapshot-costo";
import { preloadAdsForSales, resolverAdsVenta, calcularMargenNeto } from "@/lib/ads";

const TARIFA_FLEX = 3320;

interface MLOrderForCache {
  id: number;
  date_created: string;
  date_closed: string;
  status: string;
  order_items: Array<{
    item: { id: string; title: string; seller_sku: string | null };
    quantity: number;
    unit_price: number;
    sale_fee: number;
  }>;
  shipping: { id: number; logistic_type?: string };
  pack_id: number | null;
  buyer: { id: number; nickname: string; first_name?: string; last_name?: string };
  total_amount: number;
  mediations?: Array<{ id: number }>;
}

function toChileISO(dateStr: string): string {
  try { return new Date(dateStr).toLocaleString("sv-SE", { timeZone: "America/Santiago" }).replace(" ", "T"); }
  catch { return dateStr; }
}

/**
 * Upsert a single ML order into ventas_ml_cache.
 * Fetches shipment costs from ML API for accurate shipping + bonificaciones.
 */
export async function upsertOrderToVentasCache(
  order: MLOrderForCache,
  options?: { estado?: string; logisticType?: string }
): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;

  // Resolve logistic_type
  let lt = options?.logisticType || order.shipping?.logistic_type || "";
  if (!lt && order.shipping?.id) {
    try {
      const ship = await mlGet<{ logistic_type?: string }>(`/shipments/${order.shipping.id}`);
      if (ship?.logistic_type) lt = ship.logistic_type;
    } catch { /* skip */ }
  }
  const isFull = lt === "fulfillment" || lt === "xd_drop_off" || lt === "cross_docking" || lt === "drop_off";
  const canal = isFull ? "Full" : "Flex";

  // Fetch shipment costs
  let senderCost = 0;
  let senderBonif = 0;
  let receiverLoyal = 0;
  let receiverPaid = 0;
  if (order.shipping?.id) {
    try {
      const costs = await mlGet<{
        senders: Array<{ cost: number; discounts: Array<{ type: string; promoted_amount: number }> }>;
        receiver?: { cost: number; discounts: Array<{ type: string; promoted_amount: number }> };
      }>(`/shipments/${order.shipping.id}/costs`);
      if (costs) {
        const sender = costs.senders?.[0];
        senderCost = Math.round(sender?.cost || 0);
        senderBonif = Math.round(sender?.discounts?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0);
        receiverLoyal = Math.round(costs.receiver?.discounts?.filter(d => d.type === "loyal")?.reduce((s, d) => s + (d.promoted_amount || 0), 0) || 0);
        receiverPaid = Math.round(costs.receiver?.cost || 0);
      }
    } catch { /* skip */ }
  }

  // Item count del pack: solo cuenta los items DENTRO de esta orden.
  //
  // ANTES: se buscaban hermanas en DB para sumar items de otras órdenes del
  // mismo pack_id. Eso fallaba cuando las hermanas cambiaban (cancelaciones,
  // re-asignaciones de pack), dejando packItemCount inflado y costo_envio
  // subestimado. Bug observado: orden Flex de 1 ítem registraba envío $1660
  // (=$3320/2) en vez de $3320.
  //
  // AHORA: el webhook calcula con los items propios. El cron diario de
  // /api/ml/ventas-sync agrupa correctamente por shipping.id y corrige el
  // costo_envio si la orden es parte de un pack real.
  const packItemCount = order.order_items?.length || 1;

  const packCostoEnvio = isFull ? senderCost : TARIFA_FLEX;
  const packBonificacion = isFull ? 0 : (senderBonif + receiverLoyal + receiverPaid);
  const costoEnvioPorItem = Math.round(packCostoEnvio / packItemCount);
  const bonifPorItem = Math.round(packBonificacion / packItemCount);
  const esCancelada = order.status === "cancelled";
  const esParcialRefund = order.status === "partially_refunded";
  const esAnulacion = esCancelada || esParcialRefund;
  const estado = options?.estado
    || (esCancelada ? "Cancelada" : esParcialRefund ? "Parcialmente reembolsada" : "Pagada");

  // Inmutabilidad contable: si ya existen filas para esta orden, preservar
  // el costo/margen original que ya se había snapshotado.
  const { data: existingRows } = await sb.from("ventas_ml_cache")
    .select("sku_venta, costo_producto, costo_fuente, margen, margen_pct, costo_snapshot_at, anulada, anulada_at, ads_cost_asignado, ads_atribucion, margen_neto, margen_neto_pct, costo_detalle")
    .eq("order_id", String(order.id));
  const existingBySku = new Map<string, {
    costo_producto: number | null;
    costo_fuente: string | null;
    margen: number | null;
    margen_pct: number | null;
    costo_snapshot_at: string | null;
    anulada: boolean;
    anulada_at: string | null;
    ads_cost_asignado: number | null;
    ads_atribucion: string | null;
    margen_neto: number | null;
    margen_neto_pct: number | null;
    costo_detalle: unknown | null;
  }>();
  for (const r of (existingRows || [])) {
    existingBySku.set((r.sku_venta || "").toUpperCase(), r);
  }

  const preload = existingBySku.size === 0 ? await preloadCostos(sb) : null;
  const snapshotAt = new Date().toISOString();

  // Resolver item_ids y preload ads cache para esta orden
  const skuToItemId = new Map<string, string>();
  {
    const skus = (order.order_items || []).map(it => (it.item?.seller_sku || "").toUpperCase()).filter(Boolean);
    if (skus.length > 0) {
      const { data: imap } = await sb.from("ml_items_map").select("sku, item_id").in("sku", skus);
      for (const m of (imap || []) as { sku: string; item_id: string }[]) {
        skuToItemId.set(m.sku, m.item_id);
      }
    }
  }
  const fechaDate = toChileISO(order.date_closed || order.date_created).slice(0, 10);
  const adsPairs = Array.from(skuToItemId.values()).map(item_id => ({ item_id, fecha_date: fechaDate }));
  const adsPreload = await preloadAdsForSales(sb, adsPairs);

  const rows = (order.order_items || []).map(item => {
    const sku = (item.item?.seller_sku || `ML-${item.item?.id}`).toUpperCase();
    const subtotal = Math.round(item.unit_price * item.quantity);
    const comisionUnit = Math.round(item.sale_fee || 0);
    const comisionTotal = comisionUnit * item.quantity;
    const totalNeto = subtotal - comisionTotal - costoEnvioPorItem + bonifPorItem;

    // Inmutabilidad: solo preservar campos que vienen de fuentes externas
    // (costo_producto, ads_cost_asignado). margen y margen_neto se recalculan
    // SIEMPRE porque dependen de total_neto (que puede cambiar por re-balance
    // de envío en packs compartidos).
    const existing = existingBySku.get(sku);
    const resolved = preload ? resolverCostoVenta(sku, item.quantity, preload) : null;
    const snapshot = decidirSnapshotCosto(
      existing,
      () => resolved || { costo_producto: 0, costo_fuente: "sin_costo" as const },
      snapshotAt,
      { order_id: order.id, sku_venta: sku },
    );
    const costo_producto = snapshot.costo_producto;
    const costo_fuente = snapshot.costo_fuente;
    const costo_snapshot_at = snapshot.costo_snapshot_at;
    const costo_detalle = snapshot.fromSnapshot ? (existing?.costo_detalle || null) : (resolved?.detalle || null);
    const mBruto = calcularMargenVenta(totalNeto, costo_producto, subtotal);
    const margen = mBruto.margen;
    const margen_pct = mBruto.margen_pct;

    // Ads: preservar atribución si ya existía (es snapshot del día)
    let ads_cost_asignado: number;
    let ads_atribucion: string;
    if (existing && existing.ads_cost_asignado != null) {
      ads_cost_asignado = existing.ads_cost_asignado;
      ads_atribucion = existing.ads_atribucion || "sin_datos";
    } else {
      const itemId = skuToItemId.get(sku) || null;
      const ads = resolverAdsVenta(itemId, fechaDate, subtotal, adsPreload);
      ads_cost_asignado = ads.ads_cost_asignado;
      ads_atribucion = ads.ads_atribucion;
    }
    const mn = calcularMargenNeto(margen, ads_cost_asignado, subtotal);
    const margen_neto = mn.margen_neto;
    const margen_neto_pct = mn.margen_neto_pct;

    // Anulada: si ya estaba marcada preservar la fecha original; si recién se anula ahora, timestamp.
    const anulada = esAnulacion || (existing?.anulada === true);
    const anulada_at = existing?.anulada_at || (esAnulacion ? snapshotAt : null);

    return {
      order_id: String(order.id),
      order_number: String(order.pack_id || order.id),
      fecha: toChileISO(order.date_closed || order.date_created),
      fecha_date: toChileISO(order.date_closed || order.date_created).slice(0, 10),
      cliente: [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(" ") || order.buyer?.nickname || "",
      razon_social: "",
      sku_venta: sku,
      nombre_producto: item.item?.title || "",
      cantidad: item.quantity,
      canal,
      precio_unitario: Math.round(item.unit_price),
      subtotal,
      comision_unitaria: comisionUnit,
      comision_total: comisionTotal,
      costo_envio: costoEnvioPorItem,
      ingreso_envio: bonifPorItem,
      ingreso_adicional_tc: 0,
      total: subtotal,
      total_neto: totalNeto,
      costo_producto,
      costo_fuente,
      costo_snapshot_at,
      costo_detalle,
      margen,
      margen_pct,
      ads_cost_asignado,
      ads_atribucion,
      margen_neto,
      margen_neto_pct,
      anulada,
      anulada_at,
      logistic_type: lt,
      estado,
      documento_tributario: "",
      estado_documento: "",
      updated_at: snapshotAt,
    };
  });

  if (rows.length === 0) return false;

  // Delete existing rows for this order then insert (avoids upsert non-PK issues)
  await sb.from("ventas_ml_cache").delete().eq("order_id", String(order.id));
  const { error } = await sb.from("ventas_ml_cache").insert(rows);
  if (error) {
    console.warn(`[Ventas Cache] Insert error for order ${order.id}:`, error.message);
    return false;
  }

  // El re-balanceo de hermanas se hace ahora en el cron diario de
  // /api/ml/ventas-sync que agrupa correctamente por shipping.id.
  // El webhook ya no toca costos de hermanas porque la lógica vieja
  // generaba el bug de packItemCount inflado.

  return true;
}

/**
 * Update estado for a specific order in ventas_ml_cache.
 * Used by claims webhook.
 */
export async function updateVentaEstado(orderId: number, estado: string): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;

  const esAnulacion = estado === "Cancelada" || estado === "Reembolsada" || estado === "Parcialmente reembolsada";
  const now = new Date().toISOString();
  const { error } = await sb.from("ventas_ml_cache")
    .update({
      estado,
      ...(esAnulacion ? { anulada: true, anulada_at: now } : {}),
      updated_at: now,
    })
    .eq("order_id", String(orderId));

  if (error) {
    console.warn(`[Ventas Cache] Update estado error for ${orderId}:`, error.message);
    return false;
  }
  return true;
}
