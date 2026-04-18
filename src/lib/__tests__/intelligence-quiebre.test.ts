import { describe, it, expect } from "vitest";
import { resolverDiasEnQuiebre } from "../intelligence";

// Helper: fecha ISO utc + hoyX = fecha X días después.
const iso = (s: string) => new Date(s + "T00:00:00.000Z");
const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
};

describe("resolverDiasEnQuiebre (PR5 — fix contador incorrecto)", () => {
  it("SKU en quiebre 3 días: dias_en_quiebre=3 sin importar cuántos recálculos hubo", () => {
    const ancla = iso("2026-04-15");
    const hoy = iso("2026-04-18");
    // Caso: primera pasada — no había fecha previa, primerQuiebre=ancla.
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      primerQuiebre: ancla,
      hoy,
    });
    expect(r1.dias_en_quiebre).toBe(3);
    expect(r1.fecha_entrada_quiebre).toBe("2026-04-15");

    // Caso: 50 pasadas más en el mismo día → no cambia (idempotente).
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-15",
      primerQuiebre: ancla,
      hoy,
    });
    expect(r2.dias_en_quiebre).toBe(3);
    expect(r2.fecha_entrada_quiebre).toBe("2026-04-15");
  });

  it("SKU se repone (!enQuiebreAhora): reset a 0 y fecha a NULL aunque haya historial previo", () => {
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: false,
      prevFechaEntradaQuiebre: "2026-03-01",
      primerQuiebre: iso("2026-03-01"),
      hoy: iso("2026-04-18"),
    });
    expect(r.dias_en_quiebre).toBe(0);
    expect(r.fecha_entrada_quiebre).toBeNull();
  });

  it("SKU vuelve a quebrar después de estar repuesto: cuenta desde cero, no hereda fecha vieja", () => {
    // Ciclo 1: estuvo en quiebre antiguo, se repuso, prev.fecha=null.
    // Ciclo 2: entra en quiebre de nuevo. primerQuiebre ya no tiene sentido
    // (viene de snapshots viejos), pero si está presente lo usamos — en
    // caso real queda acotado a día actual si la fecha es anómala.
    const hoy = iso("2026-04-18");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      primerQuiebre: null, // limpio
      hoy,
    });
    // Sin ancla previa ni primerQuiebre → arranca HOY.
    expect(r.dias_en_quiebre).toBe(0);
    expect(r.fecha_entrada_quiebre).toBe("2026-04-18");
  });

  it("SKU con accion saludable (EXCESO / MANDAR_FULL): reset aunque stock_full=0", () => {
    // En el motor, !enQuiebreAhora = (stFull>0) O (velPonderada==0).
    // MANDAR_FULL típicamente stFull=0 + vel>0 → SÍ está en quiebre.
    // EXCESO con vel=0 → !enQuiebreAhora → reset.
    // Este test simula vel=0 (por eso enQuiebreAhora=false).
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: false, // vel_ponderada==0, aunque stFull pueda ser 0
      prevFechaEntradaQuiebre: "2024-12-01", // fósil heredado del bug
      primerQuiebre: null,
      hoy: iso("2026-04-18"),
    });
    expect(r.dias_en_quiebre).toBe(0);
    expect(r.fecha_entrada_quiebre).toBeNull();
  });

  it("Idempotencia al cambiar de día UTC: dos recálculos en el mismo día dan el mismo resultado", () => {
    const ancla = iso("2026-04-10");
    const hoy = iso("2026-04-18");
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-10",
      primerQuiebre: ancla,
      hoy,
    });
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: r1.fecha_entrada_quiebre,
      primerQuiebre: ancla,
      hoy,
    });
    expect(r2).toEqual(r1);
    expect(r1.dias_en_quiebre).toBe(8); // 2026-04-10 → 2026-04-18 = 8 días
  });

  it("SKU en quiebre a las 23:59 + recálculo al día siguiente a las 00:01: incrementa 1, no 2", () => {
    // El cálculo usa solo la porción de fecha (YYYY-MM-DD) en UTC, no la hora.
    const ancla = iso("2026-04-15");
    // Ambos recálculos corren en días UTC distintos (17 y 18).
    const hoyDia17 = new Date("2026-04-17T23:59:00.000Z");
    const hoyDia18 = new Date("2026-04-18T00:01:00.000Z");
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-15",
      primerQuiebre: ancla,
      hoy: hoyDia17,
    });
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-15",
      primerQuiebre: ancla,
      hoy: hoyDia18,
    });
    expect(r1.dias_en_quiebre).toBe(2);
    expect(r2.dias_en_quiebre).toBe(3);
    // Delta = 1 día calendario, no 2 (idempotente dentro de cada día).
    expect(r2.dias_en_quiebre - r1.dias_en_quiebre).toBe(1);
  });

  it("Fecha previa anómala (< 2025-01-01): se descarta y arranca fresh", () => {
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2020-05-15", // fósil corrupto
      primerQuiebre: null,
      hoy: iso("2026-04-18"),
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-04-18");
    expect(r.dias_en_quiebre).toBe(0);
  });

  it("Cap a 365 días: aunque la ancla sea de hace 2 años, no pasa de 365", () => {
    const hoy = iso("2026-04-18");
    const anclaLejos = iso("2023-04-18"); // 3 años atrás — no debería pasar del MIN_ISO filter
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2023-04-18", // antes del MIN_ISO 2025-01-01
      primerQuiebre: anclaLejos,
      hoy,
    });
    // Como ancla es < 2025, se descarta. primerQuiebre también < 2025 → fallback hoy.
    expect(r.fecha_entrada_quiebre).toBe("2026-04-18");
    expect(r.dias_en_quiebre).toBe(0);

    // Ahora caso con ancla de 2025-01-01 (400+ días): cap se aplica.
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2025-01-01",
      primerQuiebre: null,
      hoy,
    });
    expect(r2.fecha_entrada_quiebre).toBe("2025-01-01");
    // 2025-01-01 → 2026-04-18 = ~472 días, cap a 365.
    expect(r2.dias_en_quiebre).toBe(365);
  });
});
