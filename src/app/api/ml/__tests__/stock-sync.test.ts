import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// El test valida que la rama `enqueue_all=1` se ejecuta y llama al upsert.
// Bug histórico PR6b-pivot (2026-04-21): se usaba `new URL(req.url)` en vez de
// `req.nextUrl.searchParams.get` y en Vercel la rama nunca entraba, devolviendo
// 200 con "queue empty" sin encolar. Cuarto caso del antipatrón "endpoint
// silencioso" (PR5/PR6a/PR6a-bis/PR6b-pivot).

const activeSkus = Array.from({ length: 620 }, (_, i) => ({ sku: `SKU${i}` }));
const upsertCalls: Array<Array<{ sku: string }>> = [];
const insertCalls: Array<unknown[]> = [];

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      const chain = {
        select: (_cols?: string) => chain,
        eq: (_col: string, _val: unknown) => chain,
        order: (_col: string) => chain,
        upsert: (rows: Array<{ sku: string }>, _opts?: unknown) => {
          if (table === "stock_sync_queue") upsertCalls.push(rows);
          return Promise.resolve({ error: null });
        },
        insert: (rows: unknown[]) => {
          insertCalls.push(rows);
          return Promise.resolve({ error: null });
        },
        delete: () => ({ in: () => Promise.resolve({ error: null }) }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        update: () => ({
          eq: () => ({ or: () => Promise.resolve({ error: null }) }),
        }),
        or: () => Promise.resolve({ data: null, error: null }),
        in: () => Promise.resolve({ data: null, error: null }),
        // Terminal: resuelve la promesa con los datos apropiados
        then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
          if (table === "ml_items_map") return resolve({ data: activeSkus, error: null });
          if (table === "stock_sync_queue") return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

vi.mock("@/lib/supabase-server", () => ({
  getServerSupabase: () => makeSupabaseMock(),
}));
vi.mock("@/lib/ml", () => ({
  syncStockToML: vi.fn().mockResolvedValue(0),
}));

beforeEach(() => {
  upsertCalls.length = 0;
  insertCalls.length = 0;
});

describe("stock-sync enqueue_all=1", () => {
  it("ejecuta la rama enqueue_all y upsertea todos los SKUs activos", async () => {
    const { POST } = await import("../stock-sync/route");
    const req = new NextRequest(
      new URL("https://app/api/ml/stock-sync?enqueue_all=1"),
      { method: "POST", headers: { "x-internal": "1" } },
    );

    const res = await POST(req);
    const body = await res.json();

    expect(body.enqueue_all_ran).toBe(true);
    expect(body.enqueue_all_inserted).toBe(620);
    const totalUpserted = upsertCalls.reduce((n, rows) => n + rows.length, 0);
    expect(totalUpserted).toBe(620);
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2); // 620 / 500 = 2 chunks
  });

  it("sin enqueue_all no toca la cola con SKUs activos", async () => {
    const { POST } = await import("../stock-sync/route");
    const req = new NextRequest(
      new URL("https://app/api/ml/stock-sync"),
      { method: "POST", headers: { "x-internal": "1" } },
    );

    const res = await POST(req);
    const body = await res.json();

    expect(body.enqueue_all_ran).toBe(false);
    expect(body.enqueue_all_inserted).toBe(0);
    expect(upsertCalls.length).toBe(0);
  });
});
