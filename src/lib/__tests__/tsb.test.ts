import { describe, it, expect } from "vitest";
import { calcularTSB, seleccionarModeloZ, MIN_HISTORIA_SEMANAS } from "../tsb";

describe("calcularTSB", () => {
  it("serie intermitente clásica (cero-cero-3-cero-cero-2 repetido) → forecast > 0 y < media simple", () => {
    const ventas = [0, 0, 3, 0, 0, 2, 0, 0, 3, 0];
    const r = calcularTSB(ventas, 0.2, 0.2)!;
    expect(r).not.toBeNull();
    expect(r.forecast).toBeGreaterThan(0);
    // Media aritmética cruda es 0.8; TSB con p≈0.3 y z≈2.5 debería estar <1
    expect(r.forecast).toBeLessThan(1.0);
    expect(r.p_final).toBeLessThan(0.5); // demanda intermitente → p bajo
  });

  it("serie en decaimiento (obsolescencia) — forecast debería caer respecto a fin-historia", () => {
    // Ventas saludables las primeras 6 semanas, luego cero
    const ventas = [5, 6, 4, 5, 5, 4, 0, 0, 0, 0, 0, 0];
    const r = calcularTSB(ventas, 0.2, 0.3)!;
    expect(r).not.toBeNull();
    // p_final debe haber caído bastante (4 períodos de warmup con venta → p_0≈1,
    // luego 6 semanas de ceros con β=0.3 lo bajan a ~0.12)
    expect(r.p_final).toBeLessThan(0.25);
    // Forecast bajo: z_final alto pero p_final bajo → forecast pequeño
    expect(r.forecast).toBeLessThan(1.0);
  });

  it("serie en ramp-up — TSB no debe quedarse en cero (como lo haría Croston puro)", () => {
    // Ceros iniciales típicos de lanzamiento, venta fuerte al final
    const ventas = [0, 0, 0, 0, 0, 2, 3, 5, 4, 6, 5, 7];
    const r = calcularTSB(ventas, 0.3, 0.3)!;
    expect(r).not.toBeNull();
    // z_final debe reflejar la venta reciente (z acumula sólo cuando hay venta)
    expect(r.z_final).toBeGreaterThan(3);
    // p_final recupera porque las últimas 7 semanas tienen demanda
    expect(r.p_final).toBeGreaterThan(0.5);
    // Nota: este caso ES el que muestra por qué usamos la puerta `seleccionarModeloZ`.
    // TSB acá subestima vs SMA porque las primeras 5 semanas jalan p hacia abajo.
    // Para SKUs nuevos (<60 días) la puerta los excluye.
  });

  it("serie sin ventas (todos ceros) → forecast = 0, no NULL", () => {
    const ventas = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = calcularTSB(ventas, 0.2, 0.2)!;
    expect(r).not.toBeNull();
    expect(r.forecast).toBe(0);
    expect(r.z_final).toBe(0);
    expect(r.p_final).toBe(0);
  });

  it("<8 semanas de historia → devuelve null", () => {
    const ventas = [1, 0, 2, 0, 0, 1, 3]; // 7 semanas
    expect(calcularTSB(ventas, 0.2, 0.2)).toBeNull();
    expect(MIN_HISTORIA_SEMANAS).toBe(8);
  });

  it("exactamente 8 semanas → no null", () => {
    const ventas = [1, 0, 2, 0, 0, 1, 3, 0];
    const r = calcularTSB(ventas, 0.2, 0.2);
    expect(r).not.toBeNull();
  });

  it("auto-calibración (sin pasar α/β) — produce forecast razonable", () => {
    const ventas = [0, 0, 3, 0, 0, 2, 0, 0, 3, 0, 0, 2];
    const r = calcularTSB(ventas)!; // sin alpha, beta → grid search
    expect(r).not.toBeNull();
    expect(r.forecast).toBeGreaterThan(0);
    expect([0.1, 0.2, 0.3, 0.4]).toContain(r.alpha_usado);
    expect([0.1, 0.2, 0.3, 0.4]).toContain(r.beta_usado);
  });

  it("α/β custom → sale distinto a auto-calibrado", () => {
    const ventas = [0, 0, 5, 0, 0, 4, 0, 0, 6, 0, 0, 3];
    const rFijo = calcularTSB(ventas, 0.1, 0.1)!;
    const rAuto = calcularTSB(ventas)!;
    // α/β explícitos respetan lo pasado
    expect(rFijo.alpha_usado).toBe(0.1);
    expect(rFijo.beta_usado).toBe(0.1);
    // Al menos uno debe diferir (grid busca en 0.1-0.4)
    const mismos = rAuto.alpha_usado === 0.1 && rAuto.beta_usado === 0.1;
    if (!mismos) {
      expect(rFijo.forecast).not.toBe(rAuto.forecast);
    }
  });
});

describe("seleccionarModeloZ", () => {
  const hoy = new Date("2026-04-17T12:00:00Z");

  it("SKU bajo puerta 60d (nuevo) → sma_ponderado", () => {
    const primera = new Date("2026-03-10T00:00:00Z"); // ~38 días
    expect(
      seleccionarModeloZ({ primera_venta: primera, xyz: "Z" }, hoy),
    ).toBe("sma_ponderado");
  });

  it("SKU Z maduro (≥60d) → tsb", () => {
    const primera = new Date("2025-10-01T00:00:00Z"); // >6 meses
    expect(
      seleccionarModeloZ({ primera_venta: primera, xyz: "Z" }, hoy),
    ).toBe("tsb");
  });

  it("SKU X o Y, independiente de edad → sma_ponderado", () => {
    const primera = new Date("2025-01-01T00:00:00Z");
    expect(seleccionarModeloZ({ primera_venta: primera, xyz: "X" }, hoy)).toBe("sma_ponderado");
    expect(seleccionarModeloZ({ primera_venta: primera, xyz: "Y" }, hoy)).toBe("sma_ponderado");
  });

  it("primera_venta=null → sma_ponderado (seguro por default)", () => {
    expect(
      seleccionarModeloZ({ primera_venta: null, xyz: "Z" }, hoy),
    ).toBe("sma_ponderado");
  });

  it("primera_venta como string ISO → parsea y decide", () => {
    // 61 días antes de 2026-04-17
    expect(
      seleccionarModeloZ({ primera_venta: "2026-02-15", xyz: "Z" }, hoy),
    ).toBe("tsb");
    // 30 días antes
    expect(
      seleccionarModeloZ({ primera_venta: "2026-03-18", xyz: "Z" }, hoy),
    ).toBe("sma_ponderado");
  });

  it("primera_venta string inválido → sma_ponderado (fallback seguro)", () => {
    expect(
      seleccionarModeloZ({ primera_venta: "no-es-fecha", xyz: "Z" }, hoy),
    ).toBe("sma_ponderado");
  });
});
