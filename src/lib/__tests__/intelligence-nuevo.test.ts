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
