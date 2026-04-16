import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Detail = {
  charge_info?: {
    detail_id?: number;
    detail_amount?: number;
    detail_sub_type?: string;
    detail_type?: string;
    creation_date_time?: string;
    transaction_detail?: string;
    concept_type?: string;
  };
  marketplace_info?: { marketplace?: string };
  sales_info?: Array<{ order_id?: number }>;
  fulfillment_info?: Record<string, unknown>;
};

// Sub-types de cargos FULL que queremos aislar
const FULL_SUB_TYPES = new Set([
  "CFWA", // Cargo por servicio de almacenamiento Full (WAREHOUSING)
  "CFAG", // Aging
  "CFWD", // Withdrawal
  "CFIC", // Inbound Collect
  "CFIP", // Inbound Penalty
  "BFWA", // Bonificación de almacenamiento (credit)
]);

export async function GET() {
  const key = "2026-04-01";
  const all: Detail[] = [];
  let fromId: number | undefined;
  for (let p = 0; p < 200; p++) {
    const q = fromId ? `from_id=${fromId}&limit=50` : `limit=50`;
    const url = `/billing/integration/periods/key/${key}/group/ML/details?document_type=BILL&${q}`;
    const raw = await mlGet<{ results?: Detail[]; last_id?: number; total?: number }>(url).catch(() => null);
    if (!raw?.results?.length) break;
    all.push(...raw.results);
    if (!raw.last_id || raw.last_id === fromId) break;
    fromId = raw.last_id;
    if (raw.results.length < 50) break;
  }

  // Catalogar todos los detail_sub_type con sus montos
  const bySubType: Record<string, { count: number; total: number; concept?: string; transaction?: string }> = {};
  for (const d of all) {
    const st = d.charge_info?.detail_sub_type || "?";
    if (!bySubType[st]) bySubType[st] = {
      count: 0, total: 0,
      concept: d.charge_info?.concept_type,
      transaction: d.charge_info?.transaction_detail,
    };
    bySubType[st].count++;
    bySubType[st].total += d.charge_info?.detail_amount || 0;
  }

  // Aislar cargos Full y agrupar por día
  const fullItems = all.filter(d =>
    d.charge_info?.concept_type === "FULFILLMENT" ||
    FULL_SUB_TYPES.has(d.charge_info?.detail_sub_type || "")
  );
  const fullByDay: Record<string, Record<string, { count: number; total: number }>> = {};
  for (const d of fullItems) {
    const day = (d.charge_info?.creation_date_time || "").slice(0, 10);
    const st = d.charge_info?.detail_sub_type || "?";
    if (!fullByDay[day]) fullByDay[day] = {};
    if (!fullByDay[day][st]) fullByDay[day][st] = { count: 0, total: 0 };
    fullByDay[day][st].count++;
    fullByDay[day][st].total += d.charge_info?.detail_amount || 0;
  }

  // Abril 15 detalle específico
  const items15 = fullItems.filter(d => (d.charge_info?.creation_date_time || "").slice(0, 10) === "2026-04-15");

  return NextResponse.json({
    key,
    total_fetched: all.length,
    total_full_items: fullItems.length,
    by_sub_type_all: bySubType,
    full_by_day: fullByDay,
    abril_15: items15.map(d => ({
      detail_id: d.charge_info?.detail_id,
      date: d.charge_info?.creation_date_time,
      sub_type: d.charge_info?.detail_sub_type,
      transaction: d.charge_info?.transaction_detail,
      concept: d.charge_info?.concept_type,
      amount: d.charge_info?.detail_amount,
      fulfillment_info: d.fulfillment_info,
    })),
  });
}
