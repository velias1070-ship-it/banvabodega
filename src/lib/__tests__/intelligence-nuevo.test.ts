import { describe, it, expect } from "vitest";
import { esAccionNuevo } from "../intelligence";

// PR6a — fix del bug `dias_sin_movimiento=999` que apagaba la rama `NUEVO`.
// Antes el centinela 999 hacía que `diasSinMov <= 30` fallara siempre, y los
// SKUs recién recepcionados quedaban atrapados en DEAD_STOCK.

const base = {
  vel_ponderada: 0,
  vel_pre_quiebre: 0,
  stock_total: 10,
  stock_full: 10,  // evita rama "MANDAR_FULL"
  stock_bodega: 0,
};

describe("esAccionNuevo (PR6a)", () => {
  it("dias_sin_movimiento=null → NUEVO (no hay evidencia de ser viejo)", () => {
    expect(esAccionNuevo({ ...base, dias_sin_movimiento: null })).toBe(true);
  });

  it("dias_sin_movimiento=0 → NUEVO (movimiento hoy)", () => {
    expect(esAccionNuevo({ ...base, dias_sin_movimiento: 0 })).toBe(true);
  });

  it("dias_sin_movimiento=30 → NUEVO (límite inclusivo)", () => {
    expect(esAccionNuevo({ ...base, dias_sin_movimiento: 30 })).toBe(true);
  });

  it("dias_sin_movimiento=31 → NO NUEVO (pasó la puerta)", () => {
    expect(esAccionNuevo({ ...base, dias_sin_movimiento: 31 })).toBe(false);
  });

  it("SKU con ventas históricas (vel_ponderada>0) → NO NUEVO", () => {
    expect(
      esAccionNuevo({ ...base, vel_ponderada: 2, dias_sin_movimiento: null }),
    ).toBe(false);
  });

  it("SKU sin stock (stock_total=0) → NO NUEVO (es INACTIVO)", () => {
    expect(
      esAccionNuevo({ ...base, stock_total: 0, stock_full: 0, dias_sin_movimiento: null }),
    ).toBe(false);
  });

  it("SKU con stock_bodega>0 y stock_full=0 → NO NUEVO (precedencia de MANDAR_FULL)", () => {
    expect(
      esAccionNuevo({ ...base, stock_full: 0, stock_bodega: 5, dias_sin_movimiento: null }),
    ).toBe(false);
  });

  it("vel_pre_quiebre>0 implica historial → NO NUEVO", () => {
    expect(
      esAccionNuevo({ ...base, vel_pre_quiebre: 3, dias_sin_movimiento: null }),
    ).toBe(false);
  });

  it("dias_sin_movimiento=999 heredado de bug pre-PR6a → NO NUEVO (respeta el dato)", () => {
    // Este test documenta el comportamiento cuando DB viene con data sucia
    // pre-backfill. El helper NO re-interpreta 999 como null; confía en el dato.
    // El fix debe aplicar en el pipeline (leer de movimientos, persistir null),
    // no en el helper.
    expect(
      esAccionNuevo({ ...base, dias_sin_movimiento: 999 }),
    ).toBe(false);
  });
});

// PR6a-bis — test de integración del matching normalizado en el Map.
// Verifica que variantes de case/spacing en `movimientos.sku` matcheen igual
// con el `skuOrigen` UPPER canónico del loop. Previene una regresión futura
// donde un import traiga `"  abc123  "` o `"Abc123"` y el Map no matchee.
import { recalcularTodo, DEFAULT_INTEL_CONFIG } from "../intelligence";
import type {
  ProductoInput, ComposicionInput, RecalculoInput, OrdenInput, MovimientoInput,
} from "../intelligence";

function buildMinimalInput(overrides: Partial<RecalculoInput>): RecalculoInput {
  return {
    productos: [],
    composicion: [],
    ordenes: [],
    stockBodega: new Map(),
    stockFull: new Map(),
    stockFullDetail: new Map(),
    eventosActivos: [],
    quiebres: [],
    conteos: [],
    movimientos: [],
    stockEnTransito: new Map(),
    ocPendientesPorSku: new Map(),
    prevIntelligence: new Map(),
    velObjetivos: new Map(),
    config: DEFAULT_INTEL_CONFIG,
    hoy: new Date("2026-04-20T12:00:00Z"),
    ...overrides,
  };
}

describe("PR6a-bis — matching sku normalizado UPPER+trim", () => {
  const producto: ProductoInput = {
    sku: "ABC123",
    nombre: "Test SKU",
    categoria: "Test",
    proveedor: "Test",
    inner_pack: 1,
    moq: 1,
    lead_time_dias: 5,
    costo_promedio: 100,
    estado_sku: "activo",
    updated_at: "2026-04-01T00:00:00Z",
  } as ProductoInput;
  const composicion: ComposicionInput[] = [
    { sku_venta: "ABC123", sku_origen: "ABC123", unidades: 1, tipo_relacion: "componente" },
  ];
  const stockBodega = new Map([["ABC123", 5]]);
  const hace10Dias = new Date("2026-04-10T00:00:00Z").toISOString();

  it("Map key se normaliza: sku='abc123' (lowercase) matchea sku_origen='ABC123'", () => {
    const mov: MovimientoInput = { sku: "abc123", created_at: hace10Dias };
    const { rows } = recalcularTodo(buildMinimalInput({
      productos: [producto], composicion, stockBodega, movimientos: [mov],
    }));
    const r = rows.find(x => x.sku_origen === "ABC123")!;
    expect(r.ultimo_movimiento).toBe(hace10Dias);
    expect(r.dias_sin_movimiento).toBe(10);
  });

  it("Map key se normaliza: sku='  ABC123  ' (con espacios) matchea también", () => {
    const mov: MovimientoInput = { sku: "  ABC123  ", created_at: hace10Dias };
    const { rows } = recalcularTodo(buildMinimalInput({
      productos: [producto], composicion, stockBodega, movimientos: [mov],
    }));
    const r = rows.find(x => x.sku_origen === "ABC123")!;
    expect(r.dias_sin_movimiento).toBe(10);
  });

  it("Combo lowercase + trailing: sku='  abc123  ' → matchea", () => {
    const mov: MovimientoInput = { sku: "  abc123  ", created_at: hace10Dias };
    const { rows } = recalcularTodo(buildMinimalInput({
      productos: [producto], composicion, stockBodega, movimientos: [mov],
    }));
    const r = rows.find(x => x.sku_origen === "ABC123")!;
    expect(r.dias_sin_movimiento).toBe(10);
    expect(r.ultimo_movimiento).toBe(hace10Dias);
  });

  it("Sin movimientos → dias_sin_movimiento = NULL (no 999)", () => {
    const { rows } = recalcularTodo(buildMinimalInput({
      productos: [producto], composicion, stockBodega, movimientos: [],
    }));
    const r = rows.find(x => x.sku_origen === "ABC123")!;
    expect(r.dias_sin_movimiento).toBeNull();
    expect(r.ultimo_movimiento).toBeNull();
  });

  it("Movimiento de otro SKU no contamina: sku='OTRO' no afecta 'ABC123'", () => {
    const mov: MovimientoInput = { sku: "OTRO", created_at: hace10Dias };
    const { rows } = recalcularTodo(buildMinimalInput({
      productos: [producto], composicion, stockBodega, movimientos: [mov],
    }));
    const r = rows.find(x => x.sku_origen === "ABC123")!;
    expect(r.dias_sin_movimiento).toBeNull();
  });
});

