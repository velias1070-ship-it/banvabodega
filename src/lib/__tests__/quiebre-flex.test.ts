import { describe, it, expect } from "vitest";
import { generarStockSnapshots, type SkuIntelRow } from "../intelligence";

// Factory minimo de SkuIntelRow para tests — solo los campos relevantes al snapshot.
function makeRow(partial: Partial<SkuIntelRow>): SkuIntelRow {
  const base = {
    sku_origen: "TEST",
    stock_full: 0,
    stock_bodega: 0,
    stock_total: 0,
    vel_full: 0,
    vel_flex: 0,
    vel_ponderada: 0,
    vel_flex_pre_quiebre: 0,
    publicar_flex: 0,
  } as unknown as SkuIntelRow;
  return { ...base, ...partial } as SkuIntelRow;
}

describe("v60 — generarStockSnapshots agrega en_quiebre_flex y publicar_flex", () => {
  const FECHA = "2026-04-22";

  it("quiebre Flex clasico: publicar_flex=0 y vel_flex>0 → en_quiebre_flex=true", () => {
    const rows = [
      makeRow({ sku_origen: "A", publicar_flex: 0, vel_flex: 1.5, vel_ponderada: 2, stock_total: 1 }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].en_quiebre_flex).toBe(true);
    expect(snaps[0].publicar_flex).toBe(0);
  });

  it("publicando Flex: publicar_flex>0 → en_quiebre_flex=false", () => {
    const rows = [
      makeRow({ sku_origen: "B", publicar_flex: 5, vel_flex: 2, vel_ponderada: 3, stock_total: 10 }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps[0].en_quiebre_flex).toBe(false);
    expect(snaps[0].publicar_flex).toBe(5);
  });

  it("quiebre prolongado degrada vel_flex: vel_flex_pre_quiebre mantiene la deteccion", () => {
    // SKU lleva semanas sin publicar → vel_flex cayó a 0, pero pre_quiebre recuerda el historico.
    const rows = [
      makeRow({ sku_origen: "C", publicar_flex: 0, vel_flex: 0, vel_flex_pre_quiebre: 3.2, vel_ponderada: 1, stock_total: 1 }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps[0].en_quiebre_flex).toBe(true);
  });

  it("SKU sin historia Flex: publicar_flex=0 y vel_flex=0 → en_quiebre_flex=false (no es quiebre)", () => {
    const rows = [
      makeRow({ sku_origen: "D", publicar_flex: 0, vel_flex: 0, vel_flex_pre_quiebre: 0, vel_ponderada: 1, stock_total: 1 }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps[0].en_quiebre_flex).toBe(false);
  });

  it("SKU sin actividad no se snapshotea (filter vel_ponderada>0 || stock_total>0)", () => {
    const rows = [
      makeRow({ sku_origen: "E", publicar_flex: 0, vel_flex: 0, vel_ponderada: 0, stock_total: 0 }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps).toHaveLength(0);
  });

  it("paridad con Full: ambos flags se computan independientes", () => {
    const rows = [
      makeRow({
        sku_origen: "F",
        stock_full: 0, vel_full: 2, // quiebre Full
        publicar_flex: 3, vel_flex: 1, // Flex publicando OK
        vel_ponderada: 3, stock_total: 3,
      }),
      makeRow({
        sku_origen: "G",
        stock_full: 10, vel_full: 2, // Full OK
        publicar_flex: 0, vel_flex: 1, // quiebre Flex
        vel_ponderada: 3, stock_total: 10,
      }),
    ];
    const snaps = generarStockSnapshots(rows, FECHA);
    expect(snaps[0].sku_origen).toBe("F");
    expect(snaps[0].en_quiebre_full).toBe(true);
    expect(snaps[0].en_quiebre_flex).toBe(false);
    expect(snaps[1].sku_origen).toBe("G");
    expect(snaps[1].en_quiebre_full).toBe(false);
    expect(snaps[1].en_quiebre_flex).toBe(true);
  });
});
