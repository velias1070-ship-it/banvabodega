import { describe, it, expect } from "vitest";
import { calcularEstadoFlexFull, type FlexFullContext } from "../flex-full";

// PR3 — función canon que unifica Reglas 2 y 3 del motor Full/Flex.
// Referencia doc: banva-bodega-problema-stock-flex-2026-04-21.md Anexo A §A1.

function ctx(overrides: Partial<FlexFullContext> = {}): FlexFullContext {
  return {
    sku_origen: "TEST",
    stock_bodega: 0,
    stock_full: 0,
    stock_en_transito: 0,
    vel_ponderada: 0,
    pct_full: 0.8,
    target_dias_full: 28,
    flex_objetivo: false,
    buffer_ml: 2,
    inner_pack: 1,
    abc: "B",
    ...overrides,
  };
}

describe("calcularEstadoFlexFull — casos borde (Anexo A A1)", () => {
  it("stock_bodega=0, flex_objetivo=true, buffer=2 → todo en cero, no bloqueado", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 0, flex_objetivo: true }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(0);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
    // stock_bodega=0 NO es "bloqueado" (no hay uds paria, simplemente no hay stock)
    expect(s.flex_bloqueado_por_stock).toBe(false);
  });

  it("stock_bodega=1, buffer=2, flex_objetivo=true → bloqueado, para_full=1", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 1, flex_objetivo: true }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
    expect(s.flex_bloqueado_por_stock).toBe(true); // 0 < 1 < buffer
  });

  it("stock_bodega=2 = buffer → no bloqueado (buffer se consume completo)", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 2, flex_objetivo: true }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(2);
    expect(s.flex_bloqueado_por_stock).toBe(false);
  });

  it("stock_bodega=3, buffer=2, flex_objetivo=true → publica 1 uds en Flex", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 3, flex_objetivo: true }));
    expect(s.para_flex).toBe(1);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(1);
    expect(s.flex_activo).toBe(true);
  });

  it("stock_bodega=25, buffer=2, flex_objetivo=true → publica 23 (caso ABC=A)", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 25, flex_objetivo: true, abc: "A", target_dias_full: 42,
    }));
    expect(s.para_flex).toBe(23);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(23);
    expect(s.flex_activo).toBe(true);
  });

  it("stock_bodega=25, flex_objetivo=false → todo para Full", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 25, flex_objetivo: false }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(25);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_bloqueado_por_stock).toBe(false);
  });

  it("inner_pack=3: stock_bodega=5 buffer=2 → para_flex=3 publica=1 gap=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, flex_objetivo: true, inner_pack: 3,
    }));
    expect(s.para_flex).toBe(3);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(0);
  });

  it("inner_pack=2: stock_bodega=5 buffer=2 → para_flex=3 publica=1 gap=1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, flex_objetivo: true, inner_pack: 2,
    }));
    expect(s.para_flex).toBe(3);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(1);
  });

  it("buffer=4 (sku_origen compartido): stock_bodega=5 → publica solo 1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, flex_objetivo: true, buffer_ml: 4,
    }));
    expect(s.para_flex).toBe(1);
    expect(s.para_full).toBe(4);
    expect(s.publicar_flex).toBe(1);
  });
});

describe("calcularEstadoFlexFull — mandar_full considera para_full, no stock_bodega", () => {
  it("Full con déficit alto, stock_bodega suficiente pero parte en para_flex: mandar_full limitado", () => {
    // stock_bodega=10, buffer=2, flex_objetivo=true → para_flex=8, para_full=2
    // Full déficit enorme (target 100 vs stock 10) → mandar_full debería ser 2 (no 10)
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 10,
      flex_objetivo: true,
      vel_ponderada: 20,
      pct_full: 1.0,
      target_dias_full: 42,
    }));
    expect(s.para_flex).toBe(8);
    expect(s.para_full).toBe(2);
    // targetFullUds = 20 × 1 × 42/7 = 120; deficit = 120-10-0 = 110; limit para_full=2
    expect(s.mandar_full).toBe(2);
  });

  it("Full sobrado (stock_full>target): mandar_full=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 500,
      flex_objetivo: true,
      vel_ponderada: 20,
      pct_full: 0.8,
      target_dias_full: 42,
    }));
    // targetFullUds = 20×0.8×42/7 = 96; deficit = 96-500-0 = -404 → 0
    expect(s.mandar_full).toBe(0);
  });

  it("stock_en_transito cubre el déficit: mandar_full=0 aunque stock_full bajo", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 5,
      stock_en_transito: 100,
      flex_objetivo: false,
      vel_ponderada: 10,
      pct_full: 1.0,
      target_dias_full: 42,
    }));
    // targetFullUds = 60; deficit = 60-5-100 = -45 → 0
    expect(s.mandar_full).toBe(0);
  });
});

describe("calcularEstadoFlexFull — testigos reales del sprint", () => {
  it("TXV24QLBRBA15 (flex_objetivo=true por migración): stock_bodega=1 → bloqueado, para_full=1, mandar_full=0 (Full sobrado)", () => {
    // Estado real 2026-04-21: stock_bodega=1, stock_full=19, vel=5, pct_full=0.80, target=28
    // Full target = 5×0.8×28/7 = 16; stock_full=19 > 16 → sin déficit → mandar_full=0.
    // flex_objetivo=true por migración inicial (tuvo 3 ventas Flex en marzo).
    const s = calcularEstadoFlexFull({
      sku_origen: "TXV24QLBRBA15",
      stock_bodega: 1,
      stock_full: 19,
      stock_en_transito: 0,
      vel_ponderada: 5,
      pct_full: 0.8,
      target_dias_full: 28,
      flex_objetivo: true,
      buffer_ml: 2,
      inner_pack: 1,
      abc: "B",
    });
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
    expect(s.flex_bloqueado_por_stock).toBe(true);
    expect(s.mandar_full).toBe(0); // Full ya sobrado
  });

  it("LITAF400G4PGR (Set 4 Toallas Gris, A-ESTRELLA, flex_objetivo=true): compatibilidad con mandar_full pre-PR3", () => {
    // Estado pre-PR3: stock_bodega=14, stock_full=101, vel=18.19, pct_full=0.8, target=42
    // Fórmula vieja (intelligence.ts:1745-1746 con pct_flex=0.2):
    //   targetFlexUds = 18.19 × 0.2 × 42/7 = 21.83 → ceil=22
    //   disponibleParaFull = max(0, 14-22) = 0
    //   mandar_full = 0
    // Fórmula canon (PR3):
    //   para_flex = max(0, 14-2) = 12
    //   para_full = 2
    //   targetFullUds = 18.19 × 0.8 × 42/7 = 87.31
    //   deficit = 87.31 - 101 - 0 = -13.7 → mandar_full=0
    // Conclusión: ambas dan mandar_full=0 porque Full está sobrado, pero la
    // fórmula canon publica 12 en Flex (antes 0) — el cambio no afecta este SKU
    // en mandar_full pero sí en publicar_flex.
    const s = calcularEstadoFlexFull({
      sku_origen: "LITAF400G4PGR",
      stock_bodega: 14,
      stock_full: 101,
      stock_en_transito: 0,
      vel_ponderada: 18.19,
      pct_full: 0.8,
      target_dias_full: 42,
      flex_objetivo: true,
      buffer_ml: 2,
      inner_pack: 1,
      abc: "A",
    });
    expect(s.para_flex).toBe(12);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(12); // cambio estructural PR3: antes ML publicaba 12 via Regla 3, ahora consistente
    expect(s.mandar_full).toBe(0); // compatible con pre-PR3
  });
});
