import { describe, it, expect } from "vitest";
import { collapseSwapBlips, type PriceHistoryRow } from "../pricing";

// Caso real ALPCMPRBO4575 (2026-04-28 12:41): admin postuló DEAL -50% via
// promo_join. Cron margin-cache vio el flow salir/entrar y registró 2
// sync_diff "ruido" dentro de 16s.

function ev(o: Partial<PriceHistoryRow>): PriceHistoryRow {
  return {
    item_id: "MLC1",
    precio: 0,
    precio_anterior: null,
    delta_pct: null,
    fuente: "sync_diff",
    detected_at: "2026-04-28T12:41:00Z",
    ...o,
  } as PriceHistoryRow;
}

describe("collapseSwapBlips", () => {
  it("colapsa promo_join + 2 sync_diff dentro de ventana 60s al evento real", () => {
    const events: PriceHistoryRow[] = [
      ev({ fuente: "promo_join",  precio: 9980,  precio_anterior: 19980, detected_at: "2026-04-28T12:41:13Z" }),
      ev({ fuente: "sync_diff",   precio: 19980, precio_anterior: 11980, detected_at: "2026-04-28T12:41:23Z" }),
      ev({ fuente: "sync_diff",   precio: 9980,  precio_anterior: 19980, detected_at: "2026-04-28T12:41:29Z" }),
    ];
    const out = collapseSwapBlips(events);
    expect(out).toHaveLength(1);
    expect(out[0].fuente).toBe("promo_join");
    expect(out[0].precio).toBe(9980);
  });

  it("no colapsa si los sync_diff caen fuera de la ventana", () => {
    const events: PriceHistoryRow[] = [
      ev({ fuente: "promo_join",  precio: 9980,  precio_anterior: 19980, detected_at: "2026-04-28T12:41:13Z" }),
      ev({ fuente: "sync_diff",   precio: 19980, precio_anterior: 11980, detected_at: "2026-04-28T12:42:30Z" }),
    ];
    const out = collapseSwapBlips(events);
    expect(out).toHaveLength(2);
  });

  it("no colapsa si el ultimo sync_diff no coincide con el promo_join", () => {
    const events: PriceHistoryRow[] = [
      ev({ fuente: "promo_join",  precio: 9980,  precio_anterior: 19980, detected_at: "2026-04-28T12:41:13Z" }),
      ev({ fuente: "sync_diff",   precio: 19980, precio_anterior: 11980, detected_at: "2026-04-28T12:41:23Z" }),
      ev({ fuente: "sync_diff",   precio: 14990, precio_anterior: 19980, detected_at: "2026-04-28T12:41:29Z" }),
    ];
    const out = collapseSwapBlips(events);
    expect(out).toHaveLength(3);
  });

  it("descarta dos sync_diff que se anulan exactamente", () => {
    const events: PriceHistoryRow[] = [
      ev({ precio: 19980, precio_anterior: 11980, detected_at: "2026-04-28T12:41:00Z" }),
      ev({ precio: 11980, precio_anterior: 19980, detected_at: "2026-04-28T12:41:30Z" }),
    ];
    const out = collapseSwapBlips(events);
    expect(out).toHaveLength(0);
  });

  it("respeta item_id distinto: no colapsa eventos cruzados", () => {
    const events: PriceHistoryRow[] = [
      ev({ item_id: "A", fuente: "promo_join", precio: 9980, precio_anterior: 19980, detected_at: "2026-04-28T12:41:13Z" }),
      ev({ item_id: "B", fuente: "sync_diff",  precio: 9980, precio_anterior: 19980, detected_at: "2026-04-28T12:41:29Z" }),
    ];
    const out = collapseSwapBlips(events);
    expect(out).toHaveLength(2);
  });
});
