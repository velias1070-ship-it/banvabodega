import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") || "2026-04-01";
  const limit = req.nextUrl.searchParams.get("limit") || "5";
  // Probar múltiples formatos y endpoints
  const urls = [
    `/billing/integration/periods/key/${key}/group/ML/full/details?limit=${limit}`,
    `/billing/integration/periods?group=ML&document_type=BILL&limit=5`,
    `/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${key}/group/ML/details?limit=${limit}`,
    `/billing/integration/periods/key/${key}/group/ML/summary`,
    `/billing/integration/periods/${key}/group/ML/full/details?limit=${limit}`,
  ];
  const results: Array<Record<string, unknown>> = [];
  for (const url of urls) {
    try {
      const raw = await mlGet<Record<string, unknown>>(url);
      results.push({
        url,
        ok: true,
        is_null: raw === null,
        keys: raw ? Object.keys(raw) : [],
        sample_json: raw ? JSON.stringify(raw).slice(0, 800) : null,
      });
    } catch (e) {
      results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results });
}
