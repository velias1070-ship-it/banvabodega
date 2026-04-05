import { getServerSupabase } from "@/lib/supabase-server";

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
 * Used by webhooks (real-time) and reconciliation cron.
 */
export async function upsertOrderToVentasCache(
  order: MLOrderForCache,
  options?: { estado?: string; logisticType?: string }
): Promise<boolean> {
  const sb = getServerSupabase();
  if (!sb) return false;

  const lt = options?.logisticType || order.shipping?.logistic_type || "";
  const isFlex = lt === "self_service" || lt === "";
  const canal = isFlex ? "Flex" : "Full";
  const itemCount = order.order_items?.length || 1;
  const costoEnvioPorItem = Math.round(TARIFA_FLEX / itemCount);
  const estado = options?.estado || (order.status === "cancelled" ? "Cancelada" : "Pagada");

  const rows = (order.order_items || []).map(item => {
    const sku = (item.item?.seller_sku || `ML-${item.item?.id}`).toUpperCase();
    const subtotal = Math.round(item.unit_price * item.quantity);
    const comisionUnit = Math.round(item.sale_fee || 0);
    const comisionTotal = comisionUnit * item.quantity;
    const totalNeto = subtotal - comisionTotal - costoEnvioPorItem;

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
      ingreso_envio: 0,
      ingreso_adicional_tc: 0,
      total: subtotal,
      total_neto: totalNeto,
      logistic_type: lt,
      estado,
      documento_tributario: "",
      estado_documento: "",
      updated_at: new Date().toISOString(),
    };
  });

  if (rows.length === 0) return false;

  const { error } = await sb.from("ventas_ml_cache").upsert(rows, { onConflict: "order_id,sku_venta" });
  if (error) {
    console.warn(`[Ventas Cache] Upsert error for order ${order.id}:`, error.message);
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
