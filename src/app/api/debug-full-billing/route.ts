import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const key = "2026-04-01"; // período OPEN

  const urls = [
    // Monthly period summary
    `/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=5`,
    `/billing/integration/monthly/periods?group=ML&document_type=CREDIT_NOTE&limit=5`,
    // Details & full/details
    `/billing/integration/periods/key/${key}/group/ML/details?document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${key}/group/ML/details?document_type=CREDIT_NOTE&limit=5`,
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=CREDIT_NOTE&limit=5`,
    // Summary
    `/billing/integration/periods/key/${key}/group/ML/summary?document_type=BILL`,
    `/billing/integration/periods/key/${key}/group/ML/summary?document_type=CREDIT_NOTE`,
    // Documents (facturas PDF)
    `/billing/integration/periods/key/${key}/documents?group=ML&limit=5`,
    // Unbilled / pending (posible)
    `/billing/integration/periods/key/${key}/group/ML/unbilled?limit=5`,
    `/billing/integration/unbilled?group=ML&limit=5`,
    `/billing/integration/group/ML/unbilled?limit=5`,
    // Fees
    `/users/me/billing_info`,
  ];

  const results: Record<string, Record<string, unknown>> = {};
  for (const url of urls) {
    const raw = await mlGet<Record<string, unknown>>(url).catch((e: Error) => ({ __error: e.message }));
    if (raw === null) {
      results[url] = { status: "NULL" };
    } else if ((raw as { __error?: string }).__error) {
      results[url] = { status: "ERROR", error: (raw as { __error?: string }).__error };
    } else {
      const r = raw as Record<string, unknown>;
      results[url] = {
        status: "OK",
        keys: Object.keys(r),
        total: r.total,
        has_results: Array.isArray(r.results) ? (r.results as unknown[]).length : null,
        sample: Array.isArray(r.results) && (r.results as unknown[]).length > 0
          ? JSON.stringify((r.results as unknown[])[0]).slice(0, 600)
          : JSON.stringify(r).slice(0, 600),
      };
    }
  }

  return NextResponse.json({ key, results });
}
