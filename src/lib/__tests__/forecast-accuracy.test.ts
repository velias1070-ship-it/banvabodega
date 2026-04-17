import { describe, it, expect } from "vitest";
import {
  calcularMetricas,
  type ForecastSemanal,
  type ActualSemanal,
} from "../forecast-accuracy";

// Helpers para construir fixtures rápido.
// Devuelve N semanas ISO consecutivas terminando el lunes `hastaLunesIso`.
function ultimosNLunes(hastaLunesIso: string, n: number): string[] {
  const d = new Date(hastaLunesIso + "T00:00:00.000Z");
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const w = new Date(d);
    w.setUTCDate(w.getUTCDate() - 7 * i);
    out.push(w.toISOString().slice(0, 10));
  }
  return out;
}

const HOY_LUN = "2026-04-13"; // lunes reciente

describe("calcularMetricas", () => {
  it("serie perfecta (forecast=actual) → wmape=0, bias=0, ts=null (MAD=0)", () => {
    const semanas = ultimosNLunes(HOY_LUN, 4);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 10,
    }));

    const m = calcularMetricas(forecasts, actuales, 4);
    expect(m.es_confiable).toBe(true);
    expect(m.semanas_evaluadas).toBe(4);
    expect(m.semanas_excluidas).toBe(0);
    expect(m.wmape).toBe(0);
    expect(m.bias).toBe(0);
    expect(m.mad).toBe(0);
    expect(m.tracking_signal).toBeNull(); // MAD=0
    expect(m.forecast_total).toBe(40);
    expect(m.actual_total).toBe(40);
  });

  it("sesgo positivo sostenido (subestimamos) → bias > 0, ts > 0", () => {
    const semanas = ultimosNLunes(HOY_LUN, 8);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 15, // actual > forecast sostenidamente
    }));

    const m = calcularMetricas(forecasts, actuales, 8);
    expect(m.es_confiable).toBe(true);
    expect(m.bias).toBeGreaterThan(0);
    expect(m.tracking_signal).not.toBeNull();
    expect(m.tracking_signal!).toBeGreaterThan(0);
    // error = 15-10=5 por semana → |TS| = 8·5 / 5 = 8 (MAD=5, ΣE=40)
    expect(m.tracking_signal!).toBeCloseTo(8, 3);
    expect(m.wmape).toBeCloseTo(5 / 15, 3); // |error|/actual por semana
  });

  it("sesgo negativo sostenido (sobrestimamos) → bias < 0, ts < 0", () => {
    const semanas = ultimosNLunes(HOY_LUN, 8);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 20,
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 12,
    }));

    const m = calcularMetricas(forecasts, actuales, 8);
    expect(m.es_confiable).toBe(true);
    expect(m.bias).toBeLessThan(0);
    expect(m.tracking_signal).not.toBeNull();
    expect(m.tracking_signal!).toBeLessThan(0);
    // error = 12-20=-8 por semana → bias=-8, MAD=8, TS=8*(-8)/8 = -8
    expect(m.tracking_signal!).toBeCloseTo(-8, 3);
  });

  it("semanas en_quiebre=true se excluyen del cálculo", () => {
    const semanas = ultimosNLunes(HOY_LUN, 6);
    // 2 semanas en quiebre + 4 normales (perfectas)
    const forecasts: ForecastSemanal[] = semanas.map((s, i) => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: i < 2, // las dos más viejas, en quiebre
    }));
    const actuales: ActualSemanal[] = semanas.map((s, i) => ({
      semana_inicio: s,
      uds_fisicas: i < 2 ? 0 : 10, // las en quiebre "no vendieron"
    }));

    const m = calcularMetricas(forecasts, actuales, 8);
    expect(m.semanas_evaluadas).toBe(4);   // 6 disponibles − 2 excluidas
    expect(m.semanas_excluidas).toBe(2);
    expect(m.es_confiable).toBe(true);
    // Las válidas son perfectas → wmape=0
    expect(m.wmape).toBe(0);
    expect(m.bias).toBe(0);
  });

  it("en_quiebre=null (reconstruido) se trata igual que true: excluido", () => {
    const semanas = ultimosNLunes(HOY_LUN, 6);
    const forecasts: ForecastSemanal[] = semanas.map((s, i) => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: i < 3 ? null : false, // primeras 3 reconstruidas
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 12,
    }));

    const m = calcularMetricas(forecasts, actuales, 8);
    expect(m.semanas_excluidas).toBe(3);
    // Sólo 3 válidas → <4, no confiable
    expect(m.es_confiable).toBe(false);
    expect(m.wmape).toBeNull();
    expect(m.bias).toBeNull();
    expect(m.tracking_signal).toBeNull();
  });

  it("menos de 4 semanas de historia → todas las métricas NULL", () => {
    const semanas = ultimosNLunes(HOY_LUN, 3);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 10,
    }));

    const m = calcularMetricas(forecasts, actuales, 4);
    expect(m.semanas_evaluadas).toBe(3);
    expect(m.es_confiable).toBe(false);
    expect(m.wmape).toBeNull();
    expect(m.bias).toBeNull();
    expect(m.mad).toBeNull();
    expect(m.tracking_signal).toBeNull();
  });

  it("serie intermitente con ceros (clase Z) → Σactual=0 ⇒ wmape=null; MAD>0 ⇒ ts definido", () => {
    const semanas = ultimosNLunes(HOY_LUN, 4);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 2, // motor predice 2 uds/sem
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      uds_fisicas: 0, // nunca vendió en la ventana
    }));

    const m = calcularMetricas(forecasts, actuales, 4);
    expect(m.es_confiable).toBe(true);
    expect(m.actual_total).toBe(0);
    expect(m.wmape).toBeNull();       // división por cero evitada
    expect(m.bias).toBeCloseTo(-2, 3);
    expect(m.mad).toBeCloseTo(2, 3);
    expect(m.tracking_signal).toBeCloseTo(-4, 3); // -8/2
  });

  it("ventana=12 recorta semanas viejas si hay más de 12 pares", () => {
    const semanas = ultimosNLunes(HOY_LUN, 20);
    const forecasts: ForecastSemanal[] = semanas.map(s => ({
      semana_inicio: s,
      vel_ponderada: 10,
      en_quiebre: false,
    }));
    const actuales: ActualSemanal[] = semanas.map((s, i) => ({
      semana_inicio: s,
      uds_fisicas: i < 8 ? 1000 : 10, // las 8 más viejas son outliers que NO deberían contar
    }));

    const m = calcularMetricas(forecasts, actuales, 12);
    expect(m.semanas_evaluadas).toBe(12);
    // Las 12 últimas incluyen las 12 con actual=10 → wmape=0
    expect(m.wmape).toBe(0);
    expect(m.actual_total).toBe(120);
  });
});
