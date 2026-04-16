import { NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

type Item = Record<string, unknown>;

export async function GET() {
  const key = "2026-03-01";
  // Probar variantes de paginación
  const tests: Record<string, unknown> = {};

  const urls = [
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=5`,
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=5&from_id=0`,
    `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&limit=5&offset=0`,
  ];
  for (const url of urls) {
    const raw = await mlGet<Record<string, unknown>>(url).catch(() => null);
    tests[url] = {
      null: raw === null,
      keys: raw ? Object.keys(raw) : null,
      total: raw ? (raw as { total?: number }).total : null,
      results_count: raw && Array.isArray((raw as { results?: unknown[] }).results)
        ? (raw as { results: unknown[] }).results.length
        : 0,
      last_id: raw ? (raw as { last_id?: number }).last_id : null,
    };
  }

  // Fetch completo correcto: sin from_id en primera, luego con last_id
  const all: Item[] = [];
  let lastId: number | undefined = undefined;
  for (let p = 0; p < 10; p++) {
    const query: string = lastId ? `from_id=${lastId}&limit=200` : `limit=200`;
    const url: string = `/billing/integration/periods/key/${key}/group/ML/full/details?document_type=BILL&${query}`;
    const raw: { results?: Item[]; last_id?: number; total?: number } | null = await mlGet<{ results?: Item[]; last_id?: number; total?: number }>(url).catch(() => null);
    if (!raw?.results?.length) break;
    all.push(...raw.results);
    if (!raw.last_id || raw.last_id === lastId) break;
    lastId = raw.last_id;
    if (raw.results.length < 1000) break;
  }

  // Agregaciones sobre todo
  const byType: Record<string, { count: number; total: number; with_sku: number; with_item_id: number; with_inventory: number; total_units: number }> = {};
  for (const item of all) {
    const fi = (item as { fulfillment_info?: Record<string, unknown> }).fulfillment_info;
    const ci = (item as { charge_info?: Record<string, unknown> }).charge_info;
    const t = (fi?.type as string) || "UNKNOWN";
    if (!byType[t]) byType[t] = { count: 0, total: 0, with_sku: 0, with_item_id: 0, with_inventory: 0, total_units: 0 };
    byType[t].count++;
    byType[t].total += (fi?.amount as number) || (ci?.detail_amount as number) || 0;
    byType[t].total_units += (fi?.quantity as number) || 0;
    if (fi?.sku) byType[t].with_sku++;
    if (fi?.item_id) byType[t].with_item_id++;
    if (fi?.inventory_id) byType[t].with_inventory++;
  }

  return NextResponse.json({
    key,
    pagination_tests: tests,
    total_items_fetched: all.length,
    by_fulfillment_type: byType,
    sample_first: all[0],
    sample_last: all[all.length - 1],
  });
}
