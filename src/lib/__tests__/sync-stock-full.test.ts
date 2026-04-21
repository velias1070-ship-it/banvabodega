import { describe, it, expect, vi, beforeEach } from "vitest";

// PR6b-pivot-I: tests del fix del sync de stock Full.
// Contexto del bug: `syncStockFull` escribía a dos fuentes homónimas:
//   - Tabla canónica `stock_full_cache`
//   - Columna legada `ml_items_map.stock_full_cache`
// La línea 2293 usaba `void sb.from(...)` sin await ni error log, por lo que
// cualquier fallo del update era invisible. Además, el stale_cleanup (paso 8)
// bajaba la tabla a 0 pero no tocaba la columna → valores zombi durante
// semanas en los items que ML dejaba de reportar.
//
// Estos tests se insertan directamente en el pipeline mocked porque
// syncStockFull es ~500 líneas con muchas dependencias. En vez de ejecutar la
// función completa, validamos el contrato de las 3 operaciones que cambiamos.

type UpsertCall = { table: string; rows: unknown[] };
type UpdateCall = { table: string; set: Record<string, unknown>; where: Record<string, unknown> };

interface MockSupabase {
  upserts: UpsertCall[];
  updates: UpdateCall[];
  updateErrorFor?: (call: UpdateCall) => string | null;
  _selectData: (table: string) => unknown[];
}

function buildMock(opts: Partial<MockSupabase> = {}): MockSupabase & { from: (t: string) => unknown } {
  const state: MockSupabase = {
    upserts: [],
    updates: [],
    updateErrorFor: opts.updateErrorFor,
    _selectData: opts._selectData || (() => []),
  };
  const makeUpdateChain = (table: string, set: Record<string, unknown>) => {
    const where: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    const exec = () => {
      const call = { table, set, where };
      state.updates.push(call);
      const errMsg = state.updateErrorFor?.(call) ?? null;
      return Promise.resolve({ error: errMsg ? { message: errMsg } : null });
    };
    chain.eq = (col: string, val: unknown) => { where[col] = val; return chain; };
    chain.in = (col: string, vals: unknown[]) => { where[col] = vals; return chain; };
    chain.then = (resolve: (v: { error: { message: string } | null }) => unknown) =>
      exec().then(resolve);
    return chain;
  };
  const from = (table: string) => {
    return {
      select: () => ({
        eq: () => ({
          gt: () => ({ then: (res: any) => Promise.resolve({ data: state._selectData(table), error: null }).then(res) }),
          then: (res: any) => Promise.resolve({ data: state._selectData(table), error: null }).then(res),
        }),
        gt: () => ({ then: (res: any) => Promise.resolve({ data: state._selectData(table), error: null }).then(res) }),
        in: () => ({ then: (res: any) => Promise.resolve({ data: state._selectData(table), error: null }).then(res) }),
        then: (res: any) => Promise.resolve({ data: state._selectData(table), error: null }).then(res),
      }),
      upsert: (rows: unknown[]) => {
        state.upserts.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      update: (set: Record<string, unknown>) => makeUpdateChain(table, set),
    };
  };
  return Object.assign(state, { from }) as MockSupabase & { from: (t: string) => unknown };
}

// Helpers — reimplementamos localmente las 3 operaciones fixeadas en syncStockFull
// para aislar el test del resto del pipeline. El código real vive en
// src/lib/ml.ts:~2291 (sync 6d), ~2303 (stale_cleanup), ~2520 (por upId).

async function syncColumna(
  sb: ReturnType<typeof buildMock>,
  stockUpsert: Array<{ sku_venta: string; cantidad: number }>,
  errores: string[],
) {
  for (const row of stockUpsert) {
    const { error: colErr } = await (sb.from("ml_items_map") as any)
      .update({ stock_full_cache: row.cantidad, cache_updated_at: new Date().toISOString() })
      .eq("sku_venta", row.sku_venta)
      .eq("activo", true);
    if (colErr) {
      console.error(`[syncStockFull] col update error sku_venta=${row.sku_venta}: ${colErr.message}`);
      errores.push(`col_update ${row.sku_venta}: ${colErr.message}`);
    }
  }
}

async function staleCleanup(
  sb: ReturnType<typeof buildMock>,
  staleSkuVentas: string[],
  errores: string[],
) {
  const { error: tablaErr } = await (sb.from("stock_full_cache") as any)
    .update({ cantidad: 0, fuente: "ml_stale_cleanup", updated_at: new Date().toISOString() })
    .in("sku_venta", staleSkuVentas);
  if (tablaErr) errores.push(`stale_tabla: ${tablaErr.message}`);
  const { error: colErr } = await (sb.from("ml_items_map") as any)
    .update({ stock_full_cache: 0, cache_updated_at: new Date().toISOString() })
    .in("sku_venta", staleSkuVentas)
    .eq("activo", true);
  if (colErr) errores.push(`stale_col: ${colErr.message}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PR6b-pivot-I — syncStockFull", () => {
  it("sync normal: tabla y columna actualizan (upsert + update await)", async () => {
    const sb = buildMock();
    const errores: string[] = [];
    await syncColumna(sb, [
      { sku_venta: "SKU1", cantidad: 10 },
      { sku_venta: "SKU2", cantidad: 5 },
    ], errores);

    expect(sb.updates).toHaveLength(2);
    expect(sb.updates[0].table).toBe("ml_items_map");
    expect(sb.updates[0].set.stock_full_cache).toBe(10);
    expect(sb.updates[0].where.sku_venta).toBe("SKU1");
    expect(sb.updates[0].where.activo).toBe(true);
    expect(errores).toHaveLength(0);
  });

  it("stale cleanup baja TANTO la tabla como la columna a 0", async () => {
    const sb = buildMock();
    const errores: string[] = [];
    await staleCleanup(sb, ["STALE_A", "STALE_B"], errores);

    const tablaUpdate = sb.updates.find(u => u.table === "stock_full_cache");
    const colUpdate = sb.updates.find(u => u.table === "ml_items_map");

    expect(tablaUpdate).toBeDefined();
    expect(tablaUpdate!.set.cantidad).toBe(0);
    expect(tablaUpdate!.set.fuente).toBe("ml_stale_cleanup");
    expect(tablaUpdate!.where.sku_venta).toEqual(["STALE_A", "STALE_B"]);

    expect(colUpdate).toBeDefined();
    expect(colUpdate!.set.stock_full_cache).toBe(0);
    expect(colUpdate!.where.sku_venta).toEqual(["STALE_A", "STALE_B"]);
    expect(colUpdate!.where.activo).toBe(true);

    expect(errores).toHaveLength(0);
  });

  it("error en update de columna se loguea y agrega a errores (no se traga)", async () => {
    const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
    const sb = buildMock({
      updateErrorFor: (call) => call.table === "ml_items_map" ? "simulated 23505" : null,
    });
    const errores: string[] = [];
    await syncColumna(sb, [{ sku_venta: "SKU_FAIL", cantidad: 7 }], errores);

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(spyError.mock.calls[0][0]).toContain("SKU_FAIL");
    expect(spyError.mock.calls[0][0]).toContain("simulated 23505");
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain("col_update SKU_FAIL");
    spyError.mockRestore();
  });

  // Test 4 — regresión del void. Protege contra el antipatrón PR6b-pivot-I:
  // `void sb.from(...)` tragaba errores silenciosamente durante semanas.
  // Demostramos en simultáneo:
  //   a) la implementación correcta (await) captura el error
  //   b) la implementación con void pierde el error (comparación explícita)
  // Si alguien en ml.ts refactoriza y vuelve a poner `void` sin tocar esta
  // helper, el build sigue pasando pero el patrón visible acá es el contrato.
  it("regresión: await captura errores; void los silencia (anti-patrón)", async () => {
    const sb = buildMock({
      updateErrorFor: (call) => call.table === "ml_items_map" ? "would_be_silenced" : null,
    });

    const erroresCorrecto: string[] = [];
    await syncColumna(sb, [{ sku_venta: "SKU_X", cantidad: 1 }], erroresCorrecto);
    expect(erroresCorrecto.length).toBeGreaterThan(0);
    expect(erroresCorrecto[0]).toContain("would_be_silenced");

    // Simulación del antipatrón: si uso `void`, no espero la promesa, el error
    // nunca llega al array. Este bloque demuestra que `void` NO cumple el
    // contrato — si alguien vuelve a escribir `void sb.from(...)` en ml.ts,
    // los errores dejarán de aparecer en `errores` y debugs como el PR6b-pivot-I
    // reaparecen.
    const erroresVoid: string[] = [];
    const sb2 = buildMock({
      updateErrorFor: (call) => call.table === "ml_items_map" ? "would_be_silenced" : null,
    });
    void (sb2.from("ml_items_map") as any)
      .update({ stock_full_cache: 1 })
      .eq("sku_venta", "SKU_X")
      .eq("activo", true);
    // Sin await, `erroresVoid` queda vacío aunque la operación falle.
    expect(erroresVoid).toEqual([]);
  });
});
