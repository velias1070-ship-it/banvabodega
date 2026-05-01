import { describe, it, expect } from "vitest";
import { calcularEstadoFlexFull, type FlexFullContext } from "../flex-full";

// Funcion canon de particion Full/Flex (v7, 2026-05-01).
// - para_full = mandar_full (lo que efectivamente se despacha a Full en este
//   ciclo). para_flex = stock_bodega - para_full.
// - Prioridad invertida (manual Parte1 §577-578): cycle stock va a Full
//   primero. disponibleParaFull = stock_bodega - buffer_ml. Bodega solo
//   conserva el piso anti-race; no reserva targetFlexUds.
// - publicar_flex = floor(max(0, para_flex - buffer_ml) / unidades_pack_venta).

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

describe("calcularEstadoFlexFull — particion Full/Flex", () => {
  it("stock_bodega=0, vel=0 → todo en cero", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 0 }));
    expect(s.para_flex).toBe(0);
    expect(s.para_full).toBe(0);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
  });

  it("stock_bodega=1, vel=0 → sin deficit, queda todo en bodega para Flex", () => {
    // vel=0 → deficit_full=0 → mandar_full=0 → para_flex=1, para_full=0.
    // publicable = max(0, 1-2) = 0 → publicar_flex=0.
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 1 }));
    expect(s.para_full).toBe(0);
    expect(s.para_flex).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.flex_activo).toBe(false);
  });

  it("stock_bodega=3, vel=0, buffer=2 → publica 1 en Flex", () => {
    const s = calcularEstadoFlexFull(ctx({ stock_bodega: 3 }));
    expect(s.para_flex).toBe(3);
    expect(s.para_full).toBe(0);
    expect(s.publicar_flex).toBe(1);
    expect(s.flex_activo).toBe(true);
  });

  it("stock_bodega=25, vel=0, buffer=2 → publica 23 (caso ABC=A)", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 25, abc: "A", target_dias_full: 42,
    }));
    expect(s.para_flex).toBe(25);
    expect(s.para_full).toBe(0);
    expect(s.publicar_flex).toBe(23); // 25 - 2 buffer = 23
    expect(s.flex_activo).toBe(true);
  });

  it("unidades_pack_venta=3: stock_bodega=5 buffer=2 vel=0 → publica floor(3/3)=1 gap=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, unidades_pack_venta: 3,
    }));
    expect(s.para_flex).toBe(5);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(0);
  });

  it("unidades_pack_venta=2: stock_bodega=5 buffer=2 vel=0 → publica floor(3/2)=1 gap=1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, unidades_pack_venta: 2,
    }));
    expect(s.para_flex).toBe(5);
    expect(s.publicar_flex).toBe(1);
    expect(s.gap_fantasma).toBe(1);
  });

  it("buffer=4 (sku_origen compartido): stock_bodega=5 vel=0 → publica 1", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 5, buffer_ml: 4,
    }));
    expect(s.para_flex).toBe(5);
    expect(s.publicar_flex).toBe(1); // 5 - 4 buffer = 1
  });
});

describe("calcularEstadoFlexFull — mandar_full con prioridad Full (v7)", () => {
  it("deficit Full alto, bodega sobra: mandar_full = deficit (Flex queda con el resto)", () => {
    // stock_bodega=101, stock_full=10, vel=15.48, pct_full=0.70, target=42.
    // targetFull = 15.48 × 0.70 × 42/7 = 65.02 → deficit = 65.02 - 10 = 55.02 → 56
    // disponibleParaFull = 101 - buffer_ml(2) = 99
    // mandar_full = min(56, 99) = 56
    // para_flex = 101 - 56 = 45
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 101,
      stock_full: 10,
      vel_ponderada: 15.48,
      pct_full: 0.7,
      target_dias_full: 42,
    }));
    expect(s.mandar_full).toBe(56);
    expect(s.para_full).toBe(56);
    expect(s.para_flex).toBe(45);
  });

  it("deficit Full chico: mandar_full = deficit exacto", () => {
    // stock_bodega=20, stock_full=5, vel=5, pct_full=0.8, target=28.
    // targetFull = 5 × 0.8 × 28/7 = 16 → deficit = 16 - 5 = 11
    // disponibleParaFull = 20 - 2 = 18 → mandar = min(11, 18) = 11
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 20,
      stock_full: 5,
      vel_ponderada: 5,
      pct_full: 0.8,
      target_dias_full: 28,
    }));
    expect(s.mandar_full).toBe(11);
  });

  it("Full sobrado (stock_full > target): mandar_full=0", () => {
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 500,
      vel_ponderada: 20,
      pct_full: 0.8,
      target_dias_full: 42,
    }));
    expect(s.mandar_full).toBe(0);
  });

  it("stock_en_transito NO cubre deficit (regla v6): transito no es bodega", () => {
    // targetFull = 10 × 1.0 × 6 = 60 → deficit_full = 60 - 5 = 55 (transito 100 NO resta)
    // disponibleParaFull = 10 - 2 = 8 → mandar = min(55, 8) = 8
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      stock_full: 5,
      stock_en_transito: 100,
      vel_ponderada: 10,
      pct_full: 1.0,
      target_dias_full: 42,
    }));
    expect(s.mandar_full).toBe(8);
  });

  it("vel=0 (SKU sin historia): deficit=0 → mandar_full=0, bodega intacta", () => {
    // deficit = 0 - 0 = 0 → mandar=0
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      vel_ponderada: 0,
    }));
    expect(s.mandar_full).toBe(0);
    expect(s.para_flex).toBe(10);
  });

  it("bodega chica con deficit Full grande: manda lo que puede menos buffer (v7)", () => {
    // stock_bodega=10, vel=10, pct_full=0.5, target=42.
    // targetFull = 10 × 0.5 × 6 = 30 → deficit = 30
    // disponibleParaFull = 10 - 2 = 8 → mandar = min(30, 8) = 8
    // (v6 daba 0 porque reservaFlex=30 > bodega; v7 prioriza Full).
    const s = calcularEstadoFlexFull(ctx({
      stock_bodega: 10,
      vel_ponderada: 10,
      pct_full: 0.5,
      target_dias_full: 42,
    }));
    expect(s.mandar_full).toBe(8);
    expect(s.para_flex).toBe(2);
  });
});

describe("calcularEstadoFlexFull — testigos reales", () => {
  it("TXV24QLBRBA15: stock_bodega=1, stock_full=19 > target → mandar_full=0 (Full sobrado)", () => {
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
    expect(s.para_full).toBe(0);
    expect(s.para_flex).toBe(1);
    expect(s.publicar_flex).toBe(0);
    expect(s.mandar_full).toBe(0);
  });

  it("LITAF400G4PGR: stock_bodega=14, stock_full=101 > target → publica 12 Flex, no manda Full", () => {
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
    expect(s.mandar_full).toBe(0);
    expect(s.para_flex).toBe(14);
    expect(s.publicar_flex).toBe(12);
  });

  it("TXTPBL20200SK (post-recepcion): stock_bodega=101, stock_full=10 → mandar 56 al Full, publica 43 Flex", () => {
    // targetFull = 15.48 × 0.70 × 6 = 65.02 → deficit = 55.02 → ceil=56
    // disponibleParaFull = 101 - 2 = 99 → mandar = min(56, 99) = 56
    // para_flex = 101 - 56 = 45 → publicable = 45 - 2 = 43
    const s = calcularEstadoFlexFull({
      sku_origen: "TXTPBL20200SK",
      stock_bodega: 101,
      stock_full: 10,
      stock_en_transito: 0,
      vel_ponderada: 15.48,
      pct_full: 0.7,
      target_dias_full: 42,
      buffer_ml: 2,
      unidades_pack_venta: 1,
      abc: "A",
    });
    expect(s.mandar_full).toBe(56);
    expect(s.para_flex).toBe(45);
    expect(s.publicar_flex).toBe(43);
  });

  it("TXTPBL20200SK (pre-recepcion, OC 60 en transito, v7): manda casi toda la bodega al Full", () => {
    // Hoy: stock_bodega=41, stock_full=10, transito=60
    // targetFull = 65 → deficit = 65 - 10 = 55 (transito NO resta, regla v6)
    // disponibleParaFull = 41 - 2 = 39 → mandar = min(55, 39) = 39 (v7)
    // (v6 daba 13 porque reservaFlex=28 > 41-28=13)
    const s = calcularEstadoFlexFull({
      sku_origen: "TXTPBL20200SK",
      stock_bodega: 41,
      stock_full: 10,
      stock_en_transito: 60,
      vel_ponderada: 15.48,
      pct_full: 0.7,
      target_dias_full: 42,
      buffer_ml: 2,
      unidades_pack_venta: 1,
      abc: "A",
    });
    expect(s.mandar_full).toBe(39);
    expect(s.para_flex).toBe(2);
    expect(s.publicar_flex).toBe(0);
  });

  it("TXTPBL20200SK (caso real 2026-05-01, v7): full=1 cob 0.43d → manda lo que puede menos buffer", () => {
    // stock_bodega=41, stock_full=1, vel_ajustada_evento=23.27 (Dia de la Madre x1.3)
    // targetFull = 23.27 × 0.7 × 6 = 97.73 → deficit = 96.73 → 97
    // disponibleParaFull = 41 - 2 = 39 → mandar = min(97, 39) = 39
    // (v6 daba 0 porque reservaFlex=42 > bodega=41 — bug fix de inversion)
    const s = calcularEstadoFlexFull({
      sku_origen: "TXTPBL20200SK",
      stock_bodega: 41,
      stock_full: 1,
      stock_en_transito: 30,
      vel_ponderada: 23.27,
      pct_full: 0.7,
      target_dias_full: 42,
      buffer_ml: 2,
      unidades_pack_venta: 1,
      abc: "A",
    });
    expect(s.mandar_full).toBe(39);
    expect(s.para_flex).toBe(2);
  });
});
