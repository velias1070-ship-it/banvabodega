import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Item = {
  charge_info?: {
    detail_id?: number;
    detail_amount?: number;
    detail_sub_type?: string;
    creation_date_time?: string;
    legal_document_number?: string;
    transaction_detail?: string;
  };
  fulfillment_info?: {
    type?: string;
    amount?: number;
    amount_per_unit?: number;
    sku?: string | null;
    item_id?: string | null;
    item_title?: string | null;
    quantity?: number;
    inventory_id?: string | null;
  };
};

export async function GET() {
  // Abril en curso — período 2026-04-01
  const key = "2026-04-01";
  const all: Item[] = [];
  let lastId: number | undefined = undefined;
  for (let p = 0; p < 20; p++) {
    const q: string = lastId ? `from_id=${lastId}&limit=50` : `limit=50`;
    const url: string = `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&${q}`;
    const raw: { results?: Item[]; last_id?: number; total?: number } | null = await mlGet<{ results?: Item[]; last_id?: number; total?: number }>(url).catch(() => null);
    if (!raw?.results?.length) break;
    all.push(...raw.results);
    if (!raw.last_id || raw.last_id === lastId) break;
    lastId = raw.last_id;
    if (raw.results.length < 50) break;
  }

  // Agrupar por día (fecha del charge) x tipo
  const byDay: Record<string, Record<string, { count: number; total: number; units: number }>> = {};
  for (const item of all) {
    const dt = item.charge_info?.creation_date_time || "";
    const day = dt.slice(0, 10);
    const type = item.fulfillment_info?.type || "UNKNOWN";
    if (!byDay[day]) byDay[day] = {};
    if (!byDay[day][type]) byDay[day][type] = { count: 0, total: 0, units: 0 };
    byDay[day][type].count++;
    byDay[day][type].total += item.fulfillment_info?.amount || item.charge_info?.detail_amount || 0;
    byDay[day][type].units += item.fulfillment_info?.quantity || 0;
  }

  // Total global
  const totalByType: Record<string, { count: number; total: number; units: number }> = {};
  for (const item of all) {
    const t = item.fulfillment_info?.type || "UNKNOWN";
    if (!totalByType[t]) totalByType[t] = { count: 0, total: 0, units: 0 };
    totalByType[t].count++;
    totalByType[t].total += item.fulfillment_info?.amount || item.charge_info?.detail_amount || 0;
    totalByType[t].units += item.fulfillment_info?.quantity || 0;
  }

  // Items de abril 15 específicamente
  const items15 = all.filter(i => (i.charge_info?.creation_date_time || "").slice(0, 10) === "2026-04-15");

  return NextResponse.json({
    key,
    total_items: all.length,
    global_by_type: totalByType,
    by_day: byDay,
    abril_15: {
      count: items15.length,
      items: items15.map(i => ({
        detail_id: i.charge_info?.detail_id,
        date: i.charge_info?.creation_date_time,
        transaction: i.charge_info?.transaction_detail,
        type: i.fulfillment_info?.type,
        amount: i.fulfillment_info?.amount,
        amount_per_unit: i.fulfillment_info?.amount_per_unit,
        quantity: i.fulfillment_info?.quantity,
        sku: i.fulfillment_info?.sku,
        item_id: i.fulfillment_info?.item_id,
        item_title: i.fulfillment_info?.item_title,
      })),
    },
  });
}
