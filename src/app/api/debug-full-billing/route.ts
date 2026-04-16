import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function GET(req: NextRequest) {
  // 1. Primero listar todos los periods disponibles
  const periods = await mlGet<Record<string, unknown>>(
    `/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=20`
  ).catch(() => null);

  // 2. Tomar el key de marzo cerrado y probar varios endpoints
  const marzoKey = "2026-03-01";
  const urls = [
    // Variante 1: key estándar
    `/billing/integration/periods/key/${marzoKey}/group/ML/full/details?limit=3`,
    `/billing/integration/periods/key/${marzoKey}/group/ML/details?limit=3`,
    `/billing/integration/periods/key/${marzoKey}/group/ML/summary`,
    // Variante 2: document_type
    `/billing/integration/periods/key/${marzoKey}/group/ML/details?document_type=BILL&limit=3`,
    `/billing/integration/periods/key/${marzoKey}/group/ML/full/details?document_type=BILL&limit=3`,
    // Variante 3: documents
    `/billing/integration/periods/key/${marzoKey}/documents?group=ML&limit=3`,
    `/billing/integration/periods/key/${marzoKey}/group/ML/documents?limit=3`,
    // Variante 4: sin "key/" path
    `/billing/integration/periods/${marzoKey}/group/ML/details?limit=3`,
    // Variante 5: FS (fulfillment) en vez de full
    `/billing/integration/periods/key/${marzoKey}/group/ML/FS/details?limit=3`,
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
        results_count: raw && Array.isArray((raw as { results?: unknown[] }).results)
          ? (raw as { results: unknown[] }).results.length
          : null,
        sample_json: raw ? JSON.stringify(raw).slice(0, 1200) : null,
      });
    } catch (e) {
      results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    periods_summary: periods ? {
      total: (periods as { total?: number }).total,
      sample: Array.isArray((periods as { results?: unknown[] }).results)
        ? (periods as { results: Array<Record<string, unknown>> }).results.slice(0, 3)
        : null,
    } : null,
    probes: results,
  });
}
