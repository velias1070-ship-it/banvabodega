import { describe, it, expect } from "vitest";
import { calcularEstadoFlexFull, type FlexFullContext } from "../flex-full";

// Función canon de partición Full/Flex. Política: todo SKU activo vive en
// Flex si stock_bodega > buffer_ml (sin flag de opt-in). Tests verifican:
// - partición correcta para_flex/para_full según buffer
// - publicar_flex respeta unidades_pack_venta (composicion_venta.unidades) (+ gap_fantasma)
// - mandar_full limitado por para_full, no stock_bodega completo

function ctx(overrides: Partial<FlexFullContext> = {}): FlexFullContext {
  return {
    sku_origen: "TEST",
    stock_bodega: 0,
    stock_full: 0,
    stock_en_transito: 0,
    vel_ponderada: 0,
    pct_full: 0.8,
    target_dias_full: 28,
    buffer_ml: 2,
    unidades_pack_venta: 1,
    abc: "B",
    ...overrides,
  };
}

describe("calcularEstadoFlexFull — partición Full/Flex", () => {
  it("stock_bodega=0, buffer=2 → todo en cero", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 0 }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(0);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
  });

  it("stock_bodega=1, buffer=2 → para_flex=0, para_full=1 (buffer no alcanza)", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 1 }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
  });

  it("stock_bodega=2=buffer → buffer se consume completo, publica=0", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 2 }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(0);
  });

  it("stock_bodega=3, buffer=2 → publica 1", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 3 }));
    expect(s.para_flex).toBe(1);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(1);
    expect(s.flex_activo).toBe(true);
  });

  it("stock_bodega=25, buffer=2 → publica 23 (caso ABC=A)", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 25, abc: "A", target_dias_full: 42,
    }));
    expect(s.para_flex).toBe(23);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(23);
    expect(s.flex_activo).toBe(true);
  });

  it("unidades_pack_venta=3: stock_bodega=5 buffer=2 → para_flex=3 publica=1 gap=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, unidades_pack_venta: 3,
    }));
    expect(s.para_flex).toBe(3);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(0);
  });

  it("unidades_pack_venta=2: stock_bodega=5 buffer=2 → para_flex=3 publica=1 gap=1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, unidades_pack_venta: 2,
    }));
    expect(s.para_flex).toBe(3);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(1);
  });

  it("buffer=4 (sku_origen compartido): stock_bodega=5 → publica solo 1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, buffer_ml: 4,
    }));
    expect(s.para_flex).toBe(1);
    expect(s.para_full).toBe(4);
    expect(s.publicar_flex).toBe(1);
  });
});

describe("calcularEstadoFlexFull — mandar_full limitado por para_full", () => {
  it("Full con déficit alto, stock_bodega suficiente: mandar_full = para_full", () => {
    // stock_bodega=10, buffer=2 → para_flex=8, para_full=2
    // targetFullUds = 20 × 1 × 42/7 = 120; deficit = 110; limit=para_full=2
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 10,
      vel_ponderada: 20,
      pct_full: 1.0,
      target_dias_full: 42,
    }));
    expect(s.para_flex).toBe(8);
    expect(s.para_full).toBe(2);
    expect(s.mandar_full).toBe(2);
  });

  it("Full sobrado (stock_full>target): mandar_full=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 500,
      vel_ponderada: 20,
      pct_full: 0.8,
      target_dias_full: 42,
    }));
    // targetFullUds = 96; deficit = 96-500-0 = -404 → 0
    expect(s.mandar_full).toBe(0);
  });

  it("stock_en_transito cubre el déficit: mandar_full=0 aunque stock_full bajo", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 5,
      stock_en_transito: 100,
      vel_ponderada: 10,
      pct_full: 1.0,
      target_dias_full: 42,
    }));
    // targetFullUds = 60; deficit = 60-5-100 = -45 → 0
    expect(s.mandar_full).toBe(0);
  });
});

describe("calcularEstadoFlexFull — testigos reales", () => {
  it("TXV24QLBRBA15: stock_bodega=1, stock_full=19, vel=5, pct_full=0.80, target=28", () => {
    // Full target = 16; stock_full=19 > 16 → sin déficit → mandar_full=0.
    // stock_bodega=1 < buffer=2 → para_flex=0, para_full=1.
    const s = calcularEstadoFlexFull({
      sku_origen: "TXV24QLBRBA15",
      stock_bodega: 1,
      stock_full: 19,
      stock_en_transito: 0,
      vel_ponderada: 5,
      pct_full: 0.8,
      target_dias_full: 28,
      buffer_ml: 2,
      unidades_pack_venta: 1,
      abc: "B",
    });
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
    expect(s.mandar_full).toBe(0);
  });

  it("LITAF400G4PGR: stock_bodega=14, stock_full=101, vel=18.19, Full sobrado → mandar_full=0, publica 12", () => {
    const s = calcularEstadoFlexFull({
      sku_origen: "LITAF400G4PGR",
      stock_bodega: 14,
      stock_full: 101,
      stock_en_transito: 0,
      vel_ponderada: 18.19,
      pct_full: 0.8,
      target_dias_full: 42,
      buffer_ml: 2,
      unidades_pack_venta: 1,
      abc: "A",
    });
    expect(s.para_flex).toBe(12);
    expect(s.para_full).toBe(2);
    expect(s.publicar_flex).toBe(12);
    expect(s.mandar_full).toBe(0);
  });
});
