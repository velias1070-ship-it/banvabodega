import { NextRequest, NextResponse } from "next/server";
import { mlGetRaw } from "@/lib/ml";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Probe del billing API de ML. Sirve para explorar qué tipos/subtipos
 * de cargos aparecen en la factura mensual (WAREHOUSING, AGING,
 * WITHDRAWAL, INBOUND_COLLECT, INBOUND_PENALTY, etc.).
 *
 * Uso:
 *   /api/ml/billing-probe
 *   /api/ml/billing-probe?month=2026-03
 *   /api/ml/billing-probe?month=2026-03&subtypes=WAREHOUSING,AGING
 *   /api/ml/billing-probe?group=MP
 *   /api/ml/billing-probe?raw=1     (devuelve el JSON crudo sin resumen)
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `${month}-01`;
  const group = (url.searchParams.get("group") || "ML").toUpperCase();
  const subtypes = url.searchParams.get("subtypes"); // CSV
  const docType = url.searchParams.get("document_type") || "BILL";
  const limit = url.searchParams.get("limit") || "100";
  const raw = url.searchParams.get("raw") === "1";

  const qs = new URLSearchParams();
  qs.set("document_type", docType);
  qs.set("limit", limit);
  if (subtypes) qs.set("detail_sub_types", subtypes);

  const path = `/billing/integration/periods/key/${key}/group/${group}/details?${qs.toString()}`;
  const data = await mlGetRaw(path);

  if (!data) {
    return NextResponse.json({
      error: "ml_request_failed",
      path,
      hint: "Ver logs del server para status/body real.",
    }, { status: 502 });
  }

  if (raw) {
    return NextResponse.json({ path, data });
  }

  // Resumen: contar por detail_type y detail_sub_type, sumar amounts.
  type DetailRow = {
    detail_type?: string;
    detail_sub_type?: string;
    amount?: number;
    charge_amount?: number;
    marketplace_type?: string;
    item_id?: string;
    order_id?: string | number;
    shipment_id?: string | number;
    currency_id?: string;
    date_created?: string;
    [k: string]: unknown;
  };

  const d = data as { results?: DetailRow[]; paging?: unknown } & Record<string, unknown>;
  const rows: DetailRow[] = Array.isArray(d.results) ? d.results : [];

  const byType: Record<string, { count: number; amount: number }> = {};
  const bySubType: Record<string, { count: number; amount: number; sampleKeys: Set<string> }> = {};
  const byMarketplace: Record<string, number> = {};

  for (const r of rows) {
    const amt = Number(r.amount ?? r.charge_amount ?? 0) || 0;
    const t = r.detail_type || "UNKNOWN";
    const st = r.detail_sub_type || "—";
    const mk = r.marketplace_type || "—";

    byType[t] = byType[t] || { count: 0, amount: 0 };
    byType[t].count++;
    byType[t].amount += amt;

    bySubType[st] = bySubType[st] || { count: 0, amount: 0, sampleKeys: new Set() };
    bySubType[st].count++;
    bySubType[st].amount += amt;
    Object.keys(r).forEach(k => bySubType[st].sampleKeys.add(k));

    byMarketplace[mk] = (byMarketplace[mk] || 0) + 1;
  }

  // Ejemplos (los primeros 3 por subtipo) para ver estructura real
  const samplesBySubType: Record<string, DetailRow[]> = {};
  for (const r of rows) {
    const st = r.detail_sub_type || "—";
    samplesBySubType[st] = samplesBySubType[st] || [];
    if (samplesBySubType[st].length < 3) samplesBySubType[st].push(r);
  }

  // Agrupado por día: busca primer campo tipo fecha y lo usa.
  // Campos candidatos (en orden de preferencia).
  const DATE_FIELDS = ["date_created", "date", "detail_date", "charge_date"];
  const pickDate = (r: DetailRow): string | null => {
    for (const f of DATE_FIELDS) {
      const v = r[f];
      if (typeof v === "string" && v.length >= 10) return v.slice(0, 10);
    }
    return null;
  };

  const byDay: Record<string, { total_amount: number; count: number; by_sub_type: Record<string, { count: number; amount: number }> }> = {};
  let rowsSinFecha = 0;
  for (const r of rows) {
    const day = pickDate(r);
    if (!day) { rowsSinFecha++; continue; }
    const st = r.detail_sub_type || "—";
    const amt = Number(r.amount ?? r.charge_amount ?? 0) || 0;
    byDay[day] = byDay[day] || { total_amount: 0, count: 0, by_sub_type: {} };
    byDay[day].count++;
    byDay[day].total_amount += amt;
    byDay[day].by_sub_type[st] = byDay[day].by_sub_type[st] || { count: 0, amount: 0 };
    byDay[day].by_sub_type[st].count++;
    byDay[day].by_sub_type[st].amount += amt;
  }

  const byDaySorted = Object.fromEntries(
    Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
  );

  return NextResponse.json({
    path,
    period_key: key,
    group,
    total_rows: rows.length,
    rows_without_date: rowsSinFecha,
    paging: d.paging ?? null,
    by_detail_type: byType,
    by_detail_sub_type: Object.fromEntries(
      Object.entries(bySubType).map(([k, v]) => [k, { count: v.count, amount: v.amount, fields_seen: Array.from(v.sampleKeys).sort() }])
    ),
    by_marketplace: byMarketplace,
    by_day: byDaySorted,
    samples_by_sub_type: samplesBySubType,
  });
}
