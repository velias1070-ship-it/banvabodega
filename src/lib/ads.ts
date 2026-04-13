import type { SupabaseClient } from "@supabase/supabase-js";

export type AdsAtribucion = "direct" | "organic" | "sin_datos";

export interface AdsResuelto {
  ads_cost_asignado: number; // con IVA
  ads_atribucion: AdsAtribucion;
}

const IVA = 1.19;

interface AdsDailyRow {
  item_id: string;
  date: string;
  cost_neto: number;
  direct_amount: number;
  direct_units: number;
}

export interface AdsPreload {
  byKey: Map<string, AdsDailyRow>; // key = `${item_id}|${date}`
}

function dateKey(itemId: string, fechaDate: string): string {
  return `${itemId}|${fechaDate}`;
}

/**
 * Preload del cache diario de ads para las ventas que vamos a procesar.
 * Recibe un Set de (item_id, fecha_date) y trae solo esas rows del cache.
 */
export async function preloadAdsForSales(
  sb: SupabaseClient,
  pairs: Array<{ item_id: string; fecha_date: string }>
): Promise<AdsPreload> {
  const byKey = new Map<string, AdsDailyRow>();
  if (pairs.length === 0) return { byKey };

  // Tomar items y fechas distintos para minimizar el fetch
  const itemIds = Array.from(new Set(pairs.map(p => p.item_id).filter(Boolean)));
  if (itemIds.length === 0) return { byKey };

  // Chunk de 200 item_ids para no pasarse del límite de URL
  for (let i = 0; i < itemIds.length; i += 200) {
    const chunk = itemIds.slice(i, i + 200);
    const { data } = await sb
      .from("ml_ads_daily_cache")
      .select("item_id, date, cost_neto, direct_amount, direct_units")
      .in("item_id", chunk);
    if (!data) continue;
    for (const r of data as AdsDailyRow[]) {
      byKey.set(dateKey(r.item_id, r.date), r);
    }
  }

  return { byKey };
}

/**
 * Resuelve el costo de publicidad atribuible a UNA venta individual.
 *
 * Método "fidelidad a ML":
 *   - Si la venta cabe dentro del direct_amount del día → 'direct'
 *     ads = cost_neto × 1.19 × (subtotal / direct_amount_dia)
 *   - Si no → 'organic' (ML no la atribuyó al ad)
 *     ads = $0
 *   - Si no hay data del día en cache → 'sin_datos' con $0
 */
export function resolverAdsVenta(
  itemId: string | null | undefined,
  fechaDate: string,
  subtotal: number,
  preload: AdsPreload
): AdsResuelto {
  if (!itemId || !fechaDate || subtotal <= 0) {
    return { ads_cost_asignado: 0, ads_atribucion: "sin_datos" };
  }

  const row = preload.byKey.get(dateKey(itemId, fechaDate));
  if (!row) {
    return { ads_cost_asignado: 0, ads_atribucion: "sin_datos" };
  }

  // Sin cost ese día → no hay ads que asignar
  if (row.cost_neto <= 0) {
    return { ads_cost_asignado: 0, ads_atribucion: "organic" };
  }

  // Sin ventas directas ese día → venta necesariamente orgánica
  if (row.direct_amount <= 0 || row.direct_units <= 0) {
    return { ads_cost_asignado: 0, ads_atribucion: "organic" };
  }

  // Matching heurístico: si el subtotal cabe dentro del direct_amount del día
  // asumimos que fue directa. En días con múltiples ventas, cada una recibe
  // pro-rata según su share del direct_amount.
  if (subtotal > row.direct_amount) {
    // La venta excede el direct del día → ML la clasificó como organic
    return { ads_cost_asignado: 0, ads_atribucion: "organic" };
  }

  const share = subtotal / row.direct_amount;
  const adsConIva = Math.round(row.cost_neto * IVA * share);
  return { ads_cost_asignado: adsConIva, ads_atribucion: "direct" };
}

/**
 * Calcula margen neto completo (después de publicidad).
 * Recibe el margen bruto (total_neto − costo_producto) y le resta ads.
 */
export function calcularMargenNeto(
  margenBruto: number,
  adsCost: number,
  subtotal: number
) {
  const margenNeto = margenBruto - adsCost;
  const margenNetoPct =
    subtotal > 0 ? Math.round((margenNeto / subtotal) * 10000) / 100 : 0;
  return { margen_neto: margenNeto, margen_neto_pct: margenNetoPct };
}
