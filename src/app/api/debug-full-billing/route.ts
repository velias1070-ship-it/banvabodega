import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  // 1. Listar periods para ver estado de abril y anteriores cerrados
  const periods = await mlGet<Record<string, unknown>>(
    `/billing/integration/monthly/periods?group=ML&document_type=BILL&limit=10`
  ).catch(() => null);

  // 2. Probar abril con los 2 endpoints y ambos document_type
  const aprilKey = "2026-04-01";
  const marchKey = "2026-03-01";
  const probes: Record<string, Record<string, unknown>> = {};
  const urls = [
    `/billing/integration/periods/key/${aprilKey}/group/ML/full/details?document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${aprilKey}/group/ML/details?document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${aprilKey}/group/ML/full/details?document_type=CREDIT_NOTE&limit=5`,
    `/billing/integration/periods/key/${aprilKey}/group/ML/details?document_type=CREDIT_NOTE&limit=5`,
    `/billing/integration/periods/key/${aprilKey}/group/ML/details?limit=5`,  // sin doc_type
    `/billing/integration/periods/key/${aprilKey}/group/ML/full/details?limit=5`,
    // Marzo con CREDIT_NOTE (por comparar)
    `/billing/integration/periods/key/${marchKey}/group/ML/full/details?document_type=CREDIT_NOTE&limit=5`,
  ];
  for (const url of urls) {
    const raw = await mlGet<Record<string, unknown>>(url).catch(() => null);
    probes[url] = {
      null: raw === null,
      keys: raw ? Object.keys(raw) : null,
      total: raw ? (raw as { total?: number }).total : null,
      has_results: raw && Array.isArray((raw as { results?: unknown[] }).results)
        ? (raw as { results: unknown[] }).results.length
        : 0,
      sample: raw && Array.isArray((raw as { results?: unknown[] }).results) && (raw as { results: unknown[] }).results.length > 0
        ? JSON.stringify((raw as { results: unknown[] }).results[0]).slice(0, 800)
        : null,
    };
  }

  return NextResponse.json({
    periods_list: periods ? {
      total: (periods as { total?: number }).total,
      results: Array.isArray((periods as { results?: unknown[] }).results)
        ? (periods as { results: unknown[] }).results
        : null,
    } : null,
    probes,
  });
}
