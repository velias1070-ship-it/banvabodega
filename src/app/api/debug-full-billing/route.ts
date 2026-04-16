import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

type FullBillingItem = {
  charge_info?: { detail_id?: number; detail_amount?: number; detail_sub_type?: string; creation_date_time?: string; legal_document_number?: string };
  fulfillment_info?: { type?: string; amount?: number; amount_per_unit?: number; sku?: string | null; item_id?: string | null; item_title?: string | null; variation?: string | null; quantity?: number; inventory_id?: string | null; warehouse_id?: string | null; volume_type?: string | null };
  document_info?: { document_id?: number };
};

export async function GET() {
  const key = "2026-03-01";
  const all: FullBillingItem[] = [];
  let fromId = 0;
  for (let p = 0; p < 10; p++) {
    const url = `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=1000&from_id=${fromId}`;
    const raw = await mlGet<{ results?: FullBillingItem[]; last_id?: number; total?: number }>(url).catch(() => null);
    if (!raw?.results?.length) break;
    all.push(...raw.results);
    if (raw.results.length < 1000 || !raw.last_id) break;
    fromId = raw.last_id;
  }

  // Agregaciones
  const byType: Record<string, { count: number; total: number; with_sku: number; with_item_id: number; with_inventory: number; total_units: number }> = {};
  for (const item of all) {
    const t = item.fulfillment_info?.type || "UNKNOWN";
    if (!byType[t]) byType[t] = { count: 0, total: 0, with_sku: 0, with_item_id: 0, with_inventory: 0, total_units: 0 };
    byType[t].count++;
    byType[t].total += item.fulfillment_info?.amount || item.charge_info?.detail_amount || 0;
    byType[t].total_units += item.fulfillment_info?.quantity || 0;
    if (item.fulfillment_info?.sku) byType[t].with_sku++;
    if (item.fulfillment_info?.item_id) byType[t].with_item_id++;
    if (item.fulfillment_info?.inventory_id) byType[t].with_inventory++;
  }

  // Samples con SKU/item_id poblado (para ver si existen)
  const samplesWithSku = all.filter(x => x.fulfillment_info?.sku || x.fulfillment_info?.item_id).slice(0, 3);
  const samplesNoSku = all.filter(x => !x.fulfillment_info?.sku && !x.fulfillment_info?.item_id).slice(0, 3);

  return NextResponse.json({
    key,
    total_items: all.length,
    by_fulfillment_type: byType,
    samples_with_sku: samplesWithSku,
    samples_without_sku: samplesNoSku,
  });
}
