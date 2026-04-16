import { NextRequest, NextResponse } from "next/server";
import { mlGetRaw } from "@/lib/ml";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 120;

/**
 * Probe del billing API de ML.
 *
 * Estructura real observada (ML CL):
 *   row.charge_info.{detail_type, detail_sub_type, creation_date_time, detail_amount}
 *   row.discount_info.{charge_amount_without_discount, discount_amount}
 *   row.marketplace_info.marketplace  ("CORE", "SHIPPING", ...)
 *   row.sales_info[].{order_id, sale_date_time, transaction_amount}
 *   row.items_info[].{item_id, item_title, item_price}
 *
 * Uso:
 *   /api/ml/billing-probe
 *   /api/ml/billing-probe?month=2026-03
 *   /api/ml/billing-probe?month=2026-03&subtypes=WAREHOUSING,AGING
 *   /api/ml/billing-probe?all_pages=1    (paginar hasta traer todo)
 *   /api/ml/billing-probe?raw=1          (JSON crudo del primer page)
 *   /api/ml/billing-probe?day=2026-03-15 (filtra por día en el resumen)
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
  const key = `${month}-01`;
  const group = (url.searchParams.get("group") || "ML").toUpperCase();
  const subtypes = url.searchParams.get("subtypes");
  const docType = url.searchParams.get("document_type") || "BILL";
  const pageSize = Math.min(parseInt(url.searchParams.get("limit") || "150"), 150);
  const raw = url.searchParams.get("raw") === "1";
  const allPages = url.searchParams.get("all_pages") === "1";
  const dayFilter = url.searchParams.get("day"); // YYYY-MM-DD

  type Row = {
    charge_info?: {
      detail_type?: string;
      detail_sub_type?: string;
      creation_date_time?: string;
      detail_amount?: number;
      transaction_detail?: string;
    };
    discount_info?: {
      charge_amount_without_discount?: number;
      discount_amount?: number;
    };
    marketplace_info?: { marketplace?: string };
    sales_info?: Array<{ sale_date_time?: string; transaction_amount?: number; order_id?: number }>;
    items_info?: Array<{ item_id?: string; item_title?: string }>;
    [k: string]: unknown;
  };

  type Resp = { results?: Row[]; paging?: { total?: number; offset?: number; limit?: number } };

  // Paginar
  const allRows: Row[] = [];
  let offset = 0;
  let firstPath = "";
  let pagesFetched = 0;
  const maxPages = allPages ? 40 : 1;

  while (pagesFetched < maxPages) {
    const qs = new URLSearchParams();
    qs.set("document_type", docType);
    qs.set("limit", String(pageSize));
    qs.set("offset", String(offset));
    if (subtypes) qs.set("detail_sub_types", subtypes);
    const path = `/billing/integration/periods/key/${key}/group/${group}/details?${qs.toString()}`;
    if (!firstPath) firstPath = path;
    const data = await mlGetRaw(path) as Resp | null;
    if (!data) {
      if (allRows.length === 0) return NextResponse.json({ error: "ml_request_failed", path }, { status: 502 });
      break;
    }
    const page: Row[] = Array.isArray(data.results) ? data.results : [];
    if (raw && pagesFetched === 0) {
      return NextResponse.json({ path, data });
    }
    allRows.push(...page);
    pagesFetched++;
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  // Aggregations
  const byType: Record<string, { count: number; amount: number; amount_gross: number; discount: number }> = {};
  const bySubType: Record<string, { count: number; amount: number; label: string; marketplaces: Set<string> }> = {};
  const byMarketplace: Record<string, { count: number; amount: number }> = {};
  const byDay: Record<string, {
    count: number;
    total_amount: number;
    by_sub_type: Record<string, { count: number; amount: number; label: string }>;
  }> = {};
  const sampleBySubType: Record<string, Row[]> = {};

  for (const r of allRows) {
    const ci = r.charge_info || {};
    const di = r.discount_info || {};
    const t = ci.detail_type || "UNKNOWN";
    const st = ci.detail_sub_type || "—";
    const label = ci.transaction_detail || "";
    const amt = Number(ci.detail_amount || 0);
    const gross = Number(di.charge_amount_without_discount || amt);
    const disc = Number(di.discount_amount || 0);
    const mk = r.marketplace_info?.marketplace || "—";
    const dt = ci.creation_date_time || r.sales_info?.[0]?.sale_date_time || "";
    const day = dt ? dt.slice(0, 10) : "—";

    if (dayFilter && day !== dayFilter) continue;

    byType[t] = byType[t] || { count: 0, amount: 0, amount_gross: 0, discount: 0 };
    byType[t].count++;
    byType[t].amount += amt;
    byType[t].amount_gross += gross;
    byType[t].discount += disc;

    bySubType[st] = bySubType[st] || { count: 0, amount: 0, label, marketplaces: new Set() };
    bySubType[st].count++;
    bySubType[st].amount += amt;
    if (!bySubType[st].label && label) bySubType[st].label = label;
    bySubType[st].marketplaces.add(mk);

    byMarketplace[mk] = byMarketplace[mk] || { count: 0, amount: 0 };
    byMarketplace[mk].count++;
    byMarketplace[mk].amount += amt;

    byDay[day] = byDay[day] || { count: 0, total_amount: 0, by_sub_type: {} };
    byDay[day].count++;
    byDay[day].total_amount += amt;
    byDay[day].by_sub_type[st] = byDay[day].by_sub_type[st] || { count: 0, amount: 0, label };
    byDay[day].by_sub_type[st].count++;
    byDay[day].by_sub_type[st].amount += amt;

    if (!sampleBySubType[st] || sampleBySubType[st].length < 2) {
      sampleBySubType[st] = sampleBySubType[st] || [];
      sampleBySubType[st].push(r);
    }
  }

  const byDaySorted = Object.fromEntries(Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)));

  // Top-level totals
  const totalAmount = Object.values(byType).reduce((s, v) => s + v.amount, 0);
  const totalGross = Object.values(byType).reduce((s, v) => s + v.amount_gross, 0);
  const totalDiscount = Object.values(byType).reduce((s, v) => s + v.discount, 0);

  return NextResponse.json({
    first_path: firstPath,
    period_key: key,
    group,
    rows_total: allRows.length,
    pages_fetched: pagesFetched,
    day_filter: dayFilter,
    totals: { amount_net: totalAmount, amount_gross: totalGross, discount: totalDiscount },
    by_detail_type: byType,
    by_detail_sub_type: Object.fromEntries(
      Object.entries(bySubType).map(([k, v]) => [k, {
        count: v.count,
        amount: v.amount,
        label: v.label,
        marketplaces: Array.from(v.marketplaces),
      }])
    ),
    by_marketplace: byMarketplace,
    by_day: byDaySorted,
    samples_by_sub_type: sampleBySubType,
  });
}
