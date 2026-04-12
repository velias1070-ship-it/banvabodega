import { getServerSupabase } from "@/lib/supabase-server";
import { mlGet } from "@/lib/ml";
import { preloadCostos, resolverCostoVenta, calcularMargenVenta } from "@/lib/costos";

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

  const itemCount = order.order_items?.length || 1;
  const packCostoEnvio = isFull ? senderCost : TARIFA_FLEX;
  const packBonificacion = isFull ? 0 : (senderBonif + receiverLoyal + receiverPaid);
  const costoEnvioPorItem = Math.round(packCostoEnvio / itemCount);
  const bonifPorItem = Math.round(packBonificacion / itemCount);
  const esCancelada = order.status === "cancelled";
  const estado = options?.estado || (esCancelada ? "Cancelada" : "Pagada");

  // Inmutabilidad contable: si ya existen filas para esta orden, preservar
  // el costo/margen original que ya se había snapshotado.
  const { data: existingRows } = await sb.from("ventas_ml_cache")
    .select("sku_venta, costo_producto, costo_fuente, margen, margen_pct, costo_snapshot_at, anulada, anulada_at")
    .eq("order_id", String(order.id));
  const existingBySku = new Map<string, {
    costo_producto: number | null;
    costo_fuente: string | null;
    margen: number | null;
    margen_pct: number | null;
    costo_snapshot_at: string | null;
    anulada: boolean;
    anulada_at: string | null;
  }>();
  for (const r of (existingRows || [])) {
    existingBySku.set((r.sku_venta || "").toUpperCase(), r);
  }

  const preload = existingBySku.size === 0 ? await preloadCostos(sb) : null;
  const snapshotAt = new Date().toISOString();

  const rows = (order.order_items || []).map(item => {
    const sku = (item.item?.seller_sku || `ML-${item.item?.id}`).toUpperCase();
    const subtotal = Math.round(item.unit_price * item.quantity);
    const comisionUnit = Math.round(item.sale_fee || 0);
    const comisionTotal = comisionUnit * item.quantity;
    const totalNeto = subtotal - comisionTotal - costoEnvioPorItem + bonifPorItem;

    // Si la fila ya existía, preservar el snapshot contable original (inmutable).
    // Si es nueva, resolver costo ahora.
    const existing = existingBySku.get(sku);
    let costo_producto: number;
    let costo_fuente: string;
    let costo_snapshot_at: string;
    let margen: number;
    let margen_pct: number;
    if (existing && existing.costo_producto != null) {
      costo_producto = existing.costo_producto;
      costo_fuente = existing.costo_fuente || "promedio";
      costo_snapshot_at = existing.costo_snapshot_at || snapshotAt;
      margen = existing.margen ?? (totalNeto - costo_producto);
      margen_pct = existing.margen_pct ?? (totalNeto > 0 ? Math.round(((totalNeto - costo_producto) / totalNeto) * 10000) / 100 : 0);
    } else {
      const resolved = resolverCostoVenta(sku, item.quantity, preload!);
      costo_producto = resolved.costo_producto;
      costo_fuente = resolved.costo_fuente;
      costo_snapshot_at = snapshotAt;
      const m = calcularMargenVenta(totalNeto, costo_producto);
      margen = m.margen;
      margen_pct = m.margen_pct;
    }

    // Anulada: si ya estaba marcada preservar la fecha original; si recién se anula ahora, timestamp.
    const anulada = esCancelada || (existing?.anulada === true);
    const anulada_at = existing?.anulada_at || (esCancelada ? snapshotAt : null);

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
      margen,
      margen_pct,
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
  return true;
}

/**
 * Update estado for a specific order in ventas_ml_cache.
 * Used by claims webhook.
 */
export async function updateVentaEstado(orderId: number, estado: string): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;

  const { error } = await sb.from("ventas_ml_cache")
    .update({ estado, updated_at: new Date().toISOString() })
    .eq("order_id", String(orderId));

  if (error) {
    console.warn(`[Ventas Cache] Update estado error for ${orderId}:`, error.message);
    return false;
  }
  return true;
}
