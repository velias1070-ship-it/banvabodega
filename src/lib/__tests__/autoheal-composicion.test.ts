import { describe, it, expect, vi, beforeEach } from "vitest";
import { autohealComposicionExtendido } from "../ml";

// PR6c tests para autohealComposicionExtendido.
// Contexto: el autoheal original del paso 5b de syncStockFull solo cubría
// SKUs devueltos por ML en la corrida (`mapped`). Los items que la API
// fulfillment no listaba quedaban sin composicion_venta trivial durante
// semanas → el motor no veía su stock Full.

interface FakeState {
  mlItemsMap: Array<{ sku: string; sku_venta: string | null; status_ml: string; activo: boolean }>;
  productos: Array<{ sku: string }>;
  composicionVenta: Array<{ sku_venta: string; sku_origen: string; unidades?: number; tipo_relacion?: string }>;
  compositionUpsertCalls: Array<{ rows: unknown[]; onConflict: string | undefined }>;
  upsertError?: string;
}

function makeSupabase(state: FakeState) {
  return {
    from: (table: string) => {
      if (table === "ml_items_map") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, _val: unknown) => ({
              in: (col: string, vals: unknown[]) => {
                const rows = state.mlItemsMap
                  .filter(r => r.activo)
                  .filter(r => (vals as string[]).includes(r.status_ml));
                return Promise.resolve({ data: rows, error: null });
              },
            }),
          }),
        };
      }
      if (table === "productos") {
        return {
          select: (_cols: string) => ({
            in: (col: string, vals: unknown[]) => {
              const rows = state.productos.filter(p => (vals as string[]).includes(p.sku));
              return Promise.resolve({ data: rows, error: null });
            },
          }),
        };
      }
      if (table === "composicion_venta") {
        return {
          select: (cols: string) => ({
            in: (col: string, vals: unknown[]) => {
              const key = col as "sku_origen" | "sku_venta";
              const rows = state.composicionVenta
                .filter(c => (vals as string[]).includes(c[key] as string))
                .map(c => ({ [key]: c[key] }));
              return Promise.resolve({ data: rows, error: null });
            },
          }),
          upsert: (rows: Array<{ sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string }>, opts?: { onConflict?: string }) => {
            state.compositionUpsertCalls.push({ rows, onConflict: opts?.onConflict });
            if (state.upsertError) return Promise.resolve({ error: { message: state.upsertError } });
            for (const r of rows) {
              const exists = state.composicionVenta.some(c => c.sku_venta === r.sku_venta && c.sku_origen === r.sku_origen);
              if (!exists) state.composicionVenta.push(r);
            }
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("autohealComposicionExtendido (PR6c)", () => {
  it("Test 1: idempotencia — 2 corridas no duplican filas (upsert con onConflict)", async () => {
    const state: FakeState = {
      mlItemsMap: [{ sku: "SKU_A", sku_venta: "SKU_A", status_ml: "active", activo: true }],
      productos: [{ sku: "SKU_A" }],
      composicionVenta: [],
      compositionUpsertCalls: [],
    };
    const sb = makeSupabase(state);

    const r1 = await autohealComposicionExtendido(sb as never);
    const r2 = await autohealComposicionExtendido(sb as never);

    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(state.composicionVenta).toHaveLength(1);
    expect(state.compositionUpsertCalls[0].onConflict).toBe("sku_venta,sku_origen");
  });

  it("Test 2: no pisa packs reales — SKU con composición no trivial no se toca", async () => {
    const state: FakeState = {
      mlItemsMap: [
        { sku: "PACK_Y", sku_venta: "PACK_Y", status_ml: "active", activo: true },
      ],
      productos: [{ sku: "PACK_Y" }, { sku: "COMP_A" }, { sku: "COMP_B" }],
      composicionVenta: [
        // Pack ya configurado: 2 componentes distintos
        { sku_venta: "PACK_Y", sku_origen: "COMP_A", unidades: 2, tipo_relacion: "componente" },
        { sku_venta: "PACK_Y", sku_origen: "COMP_B", unidades: 1, tipo_relacion: "componente" },
      ],
      compositionUpsertCalls: [],
    };
    const sb = makeSupabase(state);

    const r = await autohealComposicionExtendido(sb as never);

    expect(r.inserted).toBe(0);
    // Fila trivial (PACK_Y, PACK_Y) NUNCA se crea — la mirada al SELECT lo
    // excluye porque ya tiene rows como sku_origen... espera: PACK_Y está
    // como sku_venta, no como sku_origen. El filtro del helper es
    // `conCompo.has(s)` donde conCompo proviene de sku_origen.
    // En este caso sku='PACK_Y' NO aparece en conCompo (PACK_Y no es
    // sku_origen en las filas), entonces el helper intenta insertar la
    // trivial (PACK_Y, PACK_Y). Eso rompería el pack.
    // PREVENCIÓN: en el helper, también excluir SKUs que tengan filas como
    // sku_venta con sku_origen distinto. Este test fuerza ese control.
    expect(state.composicionVenta).toHaveLength(2);
  });

  it("Test 3: solo SKUs con producto — ghost (sin productos) no recibe fila", async () => {
    const state: FakeState = {
      mlItemsMap: [
        { sku: "REAL_SKU", sku_venta: "REAL_SKU", status_ml: "active", activo: true },
        { sku: "GHOST_SKU", sku_venta: "GHOST_SKU", status_ml: "active", activo: true },
      ],
      productos: [{ sku: "REAL_SKU" }], // ghost no está
      composicionVenta: [],
      compositionUpsertCalls: [],
    };
    const sb = makeSupabase(state);

    const r = await autohealComposicionExtendido(sb as never);

    expect(r.inserted).toBe(1);
    expect(state.composicionVenta).toHaveLength(1);
    expect(state.composicionVenta[0].sku_origen).toBe("REAL_SKU");
  });

  // Test 4 — regresión. Este test protege contra la regresión del anti-patrón
  // detectado en PR6c: el autoheal original (5b) solo cubría SKUs en `mapped`
  // (los devueltos por ML en la corrida actual). SKUs que ML API no lista
  // quedaban huérfanos de composicion_venta indefinidamente.
  // Si este test falla tras un refactor, revisar si alguien removió el paso 5c
  // (llamada a autohealComposicionExtendido) en src/lib/ml.ts syncStockFull.
  it("Test 4 (regresión): rescata SKU no visto por fulfillment API", async () => {
    const state: FakeState = {
      // Simula: SKU está en ml_items_map.activo pero ML API NO lo devolvió
      // en la fulfillment query actual → el autoheal inline 5b no lo toca.
      // El 5c extendido sí debe rescatarlo.
      mlItemsMap: [{ sku: "TEST_SKU_AH_EXT", sku_venta: "TEST_SKU_AH_EXT", status_ml: "active", activo: true }],
      productos: [{ sku: "TEST_SKU_AH_EXT" }],
      composicionVenta: [],
      compositionUpsertCalls: [],
    };
    const sb = makeSupabase(state);
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const r = await autohealComposicionExtendido(sb as never);

    expect(r.inserted).toBe(1);
    expect(state.composicionVenta).toEqual([
      { sku_venta: "TEST_SKU_AH_EXT", sku_origen: "TEST_SKU_AH_EXT", unidades: 1, tipo_relacion: "componente" },
    ]);
    const logMsg = spyLog.mock.calls.map(c => String(c[0])).find(m => m.includes("Autoheal extendido"));
    expect(logMsg).toContain("1 composiciones triviales rescatadas");
    spyLog.mockRestore();
  });
});
