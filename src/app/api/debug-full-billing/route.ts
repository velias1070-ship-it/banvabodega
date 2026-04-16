import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Detail = {
  charge_info?: { detail_type?: string; detail_sub_type?: string; detail_amount?: number; transaction_detail?: string };
  marketplace_info?: { marketplace?: string };
  sales_info?: Array<{ order_id?: number }>;
  shipping_info?: unknown;
  items_info?: Array<{ item_id?: string }>;
};

export async function GET() {
  const key = "2026-03-01";
  // Fetch completo (paginado) para marzo cerrado
  const allDetails: Detail[] = [];
  let fromId = 0;
  for (let p = 0; p < 10; p++) {
    const url = `/billing/integration/periods/key/${key}/group/ML/details?document_type=BILL&limit=1000&from_id=${fromId}`;
    const raw = await mlGet<{ results?: Detail[]; last_id?: number; total?: number }>(url).catch(() => null);
    if (!raw || !Array.isArray(raw.results) || raw.results.length === 0) break;
    allDetails.push(...raw.results);
    if (raw.results.length < 1000 || !raw.last_id) break;
    fromId = raw.last_id;
  }

  // Catalogar detail_sub_type con monto agregado
  const bySubType: Record<string, { count: number; total: number; sample_transaction: string; sample_marketplace: string }> = {};
  const byMarketplace: Record<string, number> = {};
  for (const d of allDetails) {
    const st = d.charge_info?.detail_sub_type || "UNKNOWN";
    const amt = d.charge_info?.detail_amount || 0;
    if (!bySubType[st]) bySubType[st] = {
      count: 0,
      total: 0,
      sample_transaction: d.charge_info?.transaction_detail || "",
      sample_marketplace: d.marketplace_info?.marketplace || "",
    };
    bySubType[st].count++;
    bySubType[st].total += amt;
    const mp = d.marketplace_info?.marketplace || "none";
    byMarketplace[mp] = (byMarketplace[mp] || 0) + 1;
  }

  // También intentar /full/details con document_type
  const fullDetailsTry = await mlGet<Record<string, unknown>>(
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=10`
  ).catch(() => null);

  return NextResponse.json({
    key,
    total_fetched: allDetails.length,
    by_sub_type: bySubType,
    by_marketplace: byMarketplace,
    full_details_endpoint: fullDetailsTry
      ? {
          keys: Object.keys(fullDetailsTry),
          total: (fullDetailsTry as { total?: number }).total,
          sample: JSON.stringify(fullDetailsTry).slice(0, 1500),
        }
      : "null response",
  });
}
