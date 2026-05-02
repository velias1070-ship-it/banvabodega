import { describe, it, expect } from "vitest";
import { resolverDiasEnQuiebre } from "../intelligence";

// Helper: fecha ISO utc + hoyX = fecha X días después.
const iso = (s: string) => new Date(s + "T00:00:00.000Z");
const addDays = (d: Date, n: number) => {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
};

describe("resolverDiasEnQuiebre (PR5 + Sprint 4.2.1)", () => {
  it("SKU en quiebre 3 días: dias=3 desde último día con stock + 1", () => {
    // ultimoDiaConStockFull = hace 4 días → fecha_entrada = hace 3 días → dias=3
    const hoy = iso("2026-04-18");
    const ultimoConStock = iso("2026-04-14"); // 4 días antes
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy,
    });
    expect(r.dias_en_quiebre).toBe(3);
    expect(r.fecha_entrada_quiebre).toBe("2026-04-15");
  });

  it("Idempotencia: la fecha previa no afecta cuando hay evidencia en snapshots", () => {
    const hoy = iso("2026-04-18");
    const ultimoConStock = iso("2026-04-14");
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy,
    });
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-15",
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy,
    });
    expect(r2).toEqual(r1);
  });

  it("SKU se repone (!enQuiebreAhora): reset a 0/null aunque haya historial", () => {
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: false,
      prevFechaEntradaQuiebre: "2026-03-01",
      ultimoDiaConStockFull: iso("2026-04-15"),
      primerSnapshotDisponible: iso("2026-03-01"),
      hoy: iso("2026-04-18"),
    });
    expect(r.dias_en_quiebre).toBe(0);
    expect(r.fecha_entrada_quiebre).toBeNull();
  });

  it("Off-by-one fix: si último día con stock fue HOY (snapshot pre-quiebre), fecha=HOY, dias=0", () => {
    // Caso testigo TXTPBL20200SK: snapshot del 2026-05-02 (HOY) tenía stock_full=1,
    // ahora stock_full=0 (acaba de quebrar). fecha_entrada debe ser HOY, no HOY+1.
    const hoy = iso("2026-05-02");
    const ultimoConStock = iso("2026-05-02"); // snapshot de HOY tenía stock
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-16"),
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-05-02");
    expect(r.dias_en_quiebre).toBe(0);
  });

  it("FÓSIL Sprint 4.2.1: prev<primerSnapshot sin evidencia de stock → resetear a hoy", () => {
    // Caso TXTPBL20200SK pre-fix: fecha_entrada_quiebre=2026-03-28 persistida,
    // stock_snapshots arrancó 2026-04-16 sin ningún registro de stock_full>0
    // (snapshot diario nunca capturó stock>0 para este SKU porque siempre
    // se quedaba en 0 al momento del cron).
    // ultimoDiaConStockFull=null porque no hay evidencia.
    // prev=2026-03-28 < primerSnapshot=2026-04-16 → FÓSIL → resetear a HOY.
    const hoy = iso("2026-05-02");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-03-28",
      ultimoDiaConStockFull: null,
      primerSnapshotDisponible: iso("2026-04-16"),
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-05-02"); // reset a hoy
    expect(r.dias_en_quiebre).toBe(0);
  });

  it("prev >= primerSnapshot, sin evidencia de stock: preservar prev", () => {
    // SKU que entró en quiebre dentro del rango trackeable y nunca volvió a
    // tener stock>0 según snapshots.
    const hoy = iso("2026-05-02");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-25",
      ultimoDiaConStockFull: null,
      primerSnapshotDisponible: iso("2026-04-16"),
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-04-25");
    expect(r.dias_en_quiebre).toBe(7);
  });

  it("Sin prev y sin snapshots: fecha=hoy, dias=0", () => {
    const hoy = iso("2026-04-18");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: null,
      primerSnapshotDisponible: null,
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-04-18");
    expect(r.dias_en_quiebre).toBe(0);
  });

  it("Idempotencia al cambiar de día UTC: dos recálculos en mismo día dan el mismo resultado", () => {
    const ultimoConStock = iso("2026-04-09");
    const hoy = iso("2026-04-18");
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2026-04-10",
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy,
    });
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: r1.fecha_entrada_quiebre,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy,
    });
    expect(r2).toEqual(r1);
    expect(r1.dias_en_quiebre).toBe(8);
  });

  it("Cambio de día UTC: incrementa exactamente 1, no 2", () => {
    const ultimoConStock = iso("2026-04-14");
    const hoyDia17 = new Date("2026-04-17T23:59:00.000Z");
    const hoyDia18 = new Date("2026-04-18T00:01:00.000Z");
    const r1 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy: hoyDia17,
    });
    const r2 = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: null,
      ultimoDiaConStockFull: ultimoConStock,
      primerSnapshotDisponible: iso("2026-04-01"),
      hoy: hoyDia18,
    });
    expect(r1.dias_en_quiebre).toBe(2);
    expect(r2.dias_en_quiebre).toBe(3);
    expect(r2.dias_en_quiebre - r1.dias_en_quiebre).toBe(1);
  });

  it("Fecha previa anómala (< 2025-01-01) sin evidencia: resetea a hoy", () => {
    const hoy = iso("2026-04-18");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2020-05-15", // fósil corrupto pre-MIN_ISO
      ultimoDiaConStockFull: null,
      primerSnapshotDisponible: null,
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2026-04-18");
    expect(r.dias_en_quiebre).toBe(0);
  });

  it("Cap a 365 días: ancla legítima de hace 2 años → cap, no más", () => {
    const hoy = iso("2026-04-18");
    const r = resolverDiasEnQuiebre({
      enQuiebreAhora: true,
      prevFechaEntradaQuiebre: "2025-01-01",
      ultimoDiaConStockFull: null,
      primerSnapshotDisponible: iso("2025-01-01"), // misma fecha → preserva prev
      hoy,
    });
    expect(r.fecha_entrada_quiebre).toBe("2025-01-01");
    // 2025-01-01 → 2026-04-18 = ~472 días, cap a 365.
    expect(r.dias_en_quiebre).toBe(365);
  });
});
