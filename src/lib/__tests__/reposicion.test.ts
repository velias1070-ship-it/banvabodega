import { describe, it, expect } from "vitest";
import {
  calcularVelocidadSku,
  calcularCobertura,
  calcularTargetDias,
  calcularMandarFull,
  calcularPedirVenta,
  determinarAccion,
  calcularMargen,
  COSTO_ENVIO_FLEX,
} from "../reposicion";

describe("calcularVelocidadSku", () => {
  it("divide las órdenes de 6 semanas por 6", () => {
    const r = calcularVelocidadSku(60, 30, 0);
    expect(r.velFull).toBeCloseTo(10, 1);   // 60/6 = 10
    expect(r.velFlex).toBeCloseTo(5, 1);    // 30/6 = 5
    expect(r.velTotal).toBeCloseTo(15, 1);  // max(0, 15)
  });

  it("usa ProfitGuard cuando es mayor", () => {
    const r = calcularVelocidadSku(12, 6, 20);
    // órdenes: 12/6 + 6/6 = 3 total, PG = 20 → velTotal = 20
    expect(r.velTotal).toBe(20);
    // distribución canal: 12/(12+6) = 66.7% Full
    expect(r.pctFull).toBeCloseTo(0.667, 2);
    expect(r.velFull).toBeCloseTo(20 * (12 / 18), 1);
    expect(r.velFlex).toBeCloseTo(20 * (6 / 18), 1);
  });

  it("sin órdenes, pctFull = 100% (todo Full por defecto)", () => {
    const r = calcularVelocidadSku(0, 0, 10);
    expect(r.velTotal).toBe(10);
    expect(r.pctFull).toBe(1);
    expect(r.velFull).toBe(10);
    expect(r.velFlex).toBe(0);
  });

  it("sin órdenes ni PG, velTotal = 0", () => {
    const r = calcularVelocidadSku(0, 0, 0);
    expect(r.velTotal).toBe(0);
  });

  it("100% Flex cuando no hay Full", () => {
    const r = calcularVelocidadSku(0, 30, 0);
    expect(r.velTotal).toBeCloseTo(5, 1);
    expect(r.pctFull).toBe(0);
    expect(r.velFull).toBe(0);
    expect(r.velFlex).toBeCloseTo(5, 1);
  });

  it("ejemplo concreto: 50 uds Full en 6 semanas", () => {
    // Ejemplo del README: 10 + 8 + 12 + 0 + 15 + 5 = 50
    const r = calcularVelocidadSku(50, 0, 0);
    expect(r.velTotal).toBeCloseTo(50 / 6, 2); // 8.33
    expect(r.velFull).toBeCloseTo(50 / 6, 2);
    expect(r.velFlex).toBe(0);
  });
});

describe("calcularCobertura", () => {
  it("calcula días de cobertura correctamente", () => {
    // 100 uds stock, 10 uds/semana → 10 semanas = 70 días
    expect(calcularCobertura(100, 10)).toBe(70);
  });

  it("sin velocidad retorna 999 (infinito)", () => {
    expect(calcularCobertura(50, 0)).toBe(999);
  });

  it("sin stock retorna 0 días", () => {
    expect(calcularCobertura(0, 10)).toBe(0);
  });

  it("caso estándar: 20 uds stock, 5 uds/sem → 28 días", () => {
    expect(calcularCobertura(20, 5)).toBe(28);
  });
});

describe("calcularTargetDias", () => {
  it("retorna 30 si margen Flex > Full", () => {
    expect(calcularTargetDias(5000, 3000, 45)).toBe(30);
  });

  it("retorna cobObjetivo si margen Full >= Flex", () => {
    expect(calcularTargetDias(3000, 5000, 45)).toBe(45);
  });

  it("retorna cobObjetivo si no hay márgenes", () => {
    expect(calcularTargetDias(null, null, 45)).toBe(45);
  });

  it("retorna cobObjetivo si márgenes iguales", () => {
    expect(calcularTargetDias(3000, 3000, 45)).toBe(45);
  });
});

describe("calcularMandarFull", () => {
  it("calcula correctamente cuánto mandar", () => {
    // velFull=10, target45d → target=10*45/7=64.3, stock=20 → necesita 44.3 → ceil=45, min(45, bodega=100)=45
    expect(calcularMandarFull(10, 45, 20, 100)).toBe(45);
  });

  it("limita por stock bodega", () => {
    // target=64.3, stock=20, necesita 45, pero bodega=10 → 10
    expect(calcularMandarFull(10, 45, 20, 10)).toBe(10);
  });

  it("no manda si ya tiene suficiente stock Full", () => {
    // target=64.3, stockFull=70 → 70 > 64.3 → 0
    expect(calcularMandarFull(10, 45, 70, 100)).toBe(0);
  });

  it("sin velocidad Full, no manda nada", () => {
    expect(calcularMandarFull(0, 45, 0, 100)).toBe(0);
  });

  it("no manda negativo", () => {
    expect(calcularMandarFull(1, 45, 100, 50)).toBe(0);
  });
});

describe("calcularPedirVenta", () => {
  it("calcula cuánto pedir", () => {
    // velFull=8, velFlex=2, target45d
    // targetFull=8*45/7=51.4, targetFlex=2*45/7=12.9
    // total target=64.3, stock=20+30=50 → pedir=ceil(64.3-50)=15
    expect(calcularPedirVenta(8, 2, 45, 20, 30)).toBe(15);
  });

  it("no pide si tiene suficiente stock", () => {
    expect(calcularPedirVenta(5, 5, 45, 50, 50)).toBe(0);
  });

  it("sin velocidad, no pide", () => {
    expect(calcularPedirVenta(0, 0, 45, 0, 0)).toBe(0);
  });
});

describe("determinarAccion", () => {
  it("SIN VENTA cuando velTotal = 0", () => {
    expect(determinarAccion(0, 0, 50, 50, 999, 14, 60)).toBe("SIN VENTA");
  });

  it("MANDAR A FULL: stockFull=0, velFull>0, hay bodega", () => {
    expect(determinarAccion(10, 8, 0, 50, 0, 14, 60)).toBe("MANDAR A FULL");
  });

  it("AGOTADO PEDIR: stockFull=0, velFull>0, sin bodega", () => {
    expect(determinarAccion(10, 8, 0, 0, 0, 14, 60)).toBe("AGOTADO PEDIR");
  });

  it("URGENTE: cobFull < puntoReorden", () => {
    expect(determinarAccion(10, 8, 5, 100, 10, 14, 60)).toBe("URGENTE");
  });

  it("PLANIFICAR: cobFull entre puntoReorden y 30", () => {
    expect(determinarAccion(10, 8, 10, 100, 20, 14, 60)).toBe("PLANIFICAR");
  });

  it("OK: cobFull entre 30 y cobMaxima", () => {
    expect(determinarAccion(10, 8, 30, 100, 45, 14, 60)).toBe("OK");
  });

  it("EXCESO: cobFull > cobMaxima", () => {
    expect(determinarAccion(10, 8, 100, 100, 70, 14, 60)).toBe("EXCESO");
  });
});

describe("calcularMargen", () => {
  it("calcula margen Flex correctamente", () => {
    // ingresoUnit=10000, comisionUnit=1000, costoEnvio=FLEX-ingresoEnvio/qty
    // costoProducto=5000
    const agg = {
      totalSubtotal: 100000,  // 10 uds × $10000
      totalComision: 10000,   // 10 uds × $1000
      totalCostoEnvio: 0,     // no se usa en Flex
      totalIngresoEnvio: 5000, // 10 uds × $500
      totalCantidad: 10,
    };
    const margen = calcularMargen(agg, "flex", 5000);
    // ingreso=10000 - comision=1000 - envio=(3320-500)=2820 - costo=5000 = 1180
    expect(margen).toBe(1180);
  });

  it("calcula margen Full correctamente", () => {
    const agg = {
      totalSubtotal: 100000,
      totalComision: 10000,
      totalCostoEnvio: 20000, // 10 × $2000
      totalIngresoEnvio: 0,
      totalCantidad: 10,
    };
    const margen = calcularMargen(agg, "full", 5000);
    // ingreso=10000 - comision=1000 - envio=2000 - costo=5000 = 2000
    expect(margen).toBe(2000);
  });

  it("retorna null si no hay cantidad", () => {
    const agg = {
      totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0,
      totalIngresoEnvio: 0, totalCantidad: 0,
    };
    expect(calcularMargen(agg, "flex", 5000)).toBeNull();
  });
});

describe("escenario integrado: caso real conocido", () => {
  it("SKU con 50 Full + 20 Flex en 6 semanas, PG=10, stock Full=15, bodega=80", () => {
    // 1. Velocidad
    const vel = calcularVelocidadSku(50, 20, 10);
    // órdenes: 50/6+20/6 = 11.67 > PG=10 → velTotal=11.67
    expect(vel.velTotal).toBeCloseTo(11.67, 1);
    expect(vel.pctFull).toBeCloseTo(50 / 70, 2); // 71.4%
    expect(vel.velFull).toBeCloseTo(11.67 * (50 / 70), 1);  // ~8.33
    expect(vel.velFlex).toBeCloseTo(11.67 * (20 / 70), 1);  // ~3.33

    // 2. Cobertura Full
    const cobFull = calcularCobertura(15, vel.velFull);
    // 15 / 8.33 * 7 ≈ 12.6 días
    expect(cobFull).toBeCloseTo(12.6, 0);

    // 3. Target días (sin márgenes → cobObjetivo 45)
    const targetDias = calcularTargetDias(null, null, 45);
    expect(targetDias).toBe(45);

    // 4. Mandar a Full
    const mandarFull = calcularMandarFull(vel.velFull, targetDias, 15, 80);
    // target = 8.33 * 45 / 7 = 53.6, necesita ceil(53.6 - 15) = 39, min(39, 80) = 39
    expect(mandarFull).toBe(39);

    // 5. Pedir
    const pedir = calcularPedirVenta(vel.velFull, vel.velFlex, targetDias, 15, 80);
    // targetTotal = 11.67*45/7 = 75.0, stock = 15+80=95, 75-95 = -20 → 0
    expect(pedir).toBe(0);

    // 6. Acción: cobFull ≈ 12.6 < 14 → URGENTE
    const accion = determinarAccion(vel.velTotal, vel.velFull, 15, 80, Math.round(cobFull), 14, 60);
    expect(accion).toBe("URGENTE");
  });

  it("SKU sin ventas recientes pero con PG alto", () => {
    const vel = calcularVelocidadSku(0, 0, 25);
    // Sin órdenes → 100% Full por defecto
    expect(vel.velTotal).toBe(25);
    expect(vel.velFull).toBe(25);
    expect(vel.velFlex).toBe(0);

    const cobFull = calcularCobertura(100, vel.velFull);
    // 100/25*7 = 28 días
    expect(cobFull).toBe(28);

    const accion = determinarAccion(vel.velTotal, vel.velFull, 100, 50, Math.round(cobFull), 14, 60);
    expect(accion).toBe("PLANIFICAR"); // 28d entre 14 y 30
  });

  it("SKU con exceso de stock", () => {
    const vel = calcularVelocidadSku(6, 6, 0);
    // 6/6 + 6/6 = 2 uds/sem, 50% Full
    expect(vel.velTotal).toBeCloseTo(2, 1);

    const cobFull = calcularCobertura(50, vel.velFull); // 50/1*7 = 350d
    expect(cobFull).toBe(350);

    const mandarFull = calcularMandarFull(vel.velFull, 45, 50, 100);
    // target = 1*45/7=6.4, ceil(6.4-50) = -44 → 0
    expect(mandarFull).toBe(0);

    const accion = determinarAccion(vel.velTotal, vel.velFull, 50, 100, Math.round(cobFull), 14, 60);
    expect(accion).toBe("EXCESO");
  });
});
