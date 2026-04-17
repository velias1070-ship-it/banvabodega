// Medición de error del forecast vel_ponderada.
// Módulo puro: sin Supabase, sin I/O. Ver PR1/3 (PR2 agrega alertas, PR3 TSB).
//
// Convención de signo:
//   error = actual - forecast
//   bias > 0  → subestimamos demanda (propenso a stockout)
//   bias < 0  → sobrestimamos demanda (propenso a exceso)
//
// vel_ponderada del motor está en uds/SEMANA (ver intelligence.ts:776), no uds/día.
// Los actuales también se agregan por semana ISO lun-dom UTC, así que la comparación
// es directa: forecast_semana = vel_ponderada (no se multiplica por 7).

export interface ForecastSemanal {
  semana_inicio: string;     // YYYY-MM-DD (lunes UTC)
  vel_ponderada: number;     // uds/semana predichas
  /**
   * `true`  = semana marcada en quiebre (≥3 días sin stock en stock_snapshots).
   * `false` = semana sin quiebre.
   * `null`  = fila reconstruida por backfill (no hay historia de stock_snapshots
   *           para ese lunes). Tratada como excluida por prudencia.
   */
  en_quiebre: boolean | null;
}

export interface ActualSemanal {
  semana_inicio: string;     // YYYY-MM-DD
  uds_fisicas: number;       // ventas físicas expandidas vía composicion_venta
}

export interface MetricasForecast {
  ventana_semanas: 4 | 8 | 12;
  semanas_evaluadas: number;
  semanas_excluidas: number;
  wmape: number | null;            // Σ|error| / Σactual — NULL si Σactual = 0
  bias: number | null;             // Σerror / n — promedio con signo
  mad: number | null;              // Σ|error| / n
  tracking_signal: number | null;  // Σerror / MAD — NULL si MAD = 0
  forecast_total: number;
  actual_total: number;
  es_confiable: boolean;           // false si semanas_evaluadas < 4
}

/**
 * Calcula WMAPE / bias / MAD / tracking_signal para un SKU.
 *
 * Procedimiento:
 *   1. Aparea forecasts con actuales por `semana_inicio`.
 *   2. Toma las últimas N semanas cerradas según `ventanaSemanas` (orden DESC por fecha).
 *   3. Excluye semanas con `en_quiebre=true` o `en_quiebre=null`.
 *   4. Si quedan menos de 4 → todas las métricas NULL, es_confiable=false.
 *   5. Casos borde: Σactual=0 ⇒ wmape=null; MAD=0 ⇒ tracking_signal=null.
 */
export function calcularMetricas(
  forecasts: ForecastSemanal[],
  actuales: ActualSemanal[],
  ventanaSemanas: 4 | 8 | 12,
): MetricasForecast {
  const actualesPorSemana = new Map<string, number>();
  for (const a of actuales) actualesPorSemana.set(a.semana_inicio, a.uds_fisicas);

  // Pares (forecast, actual, en_quiebre) ordenados DESC: más reciente primero.
  const pares = forecasts
    .filter(f => actualesPorSemana.has(f.semana_inicio))
    .map(f => ({
      semana: f.semana_inicio,
      forecast: f.vel_ponderada,
      actual: actualesPorSemana.get(f.semana_inicio)!,
      en_quiebre: f.en_quiebre,
    }))
    .sort((a, b) => (a.semana < b.semana ? 1 : -1));

  // Tomar ventana más reciente, luego filtrar quiebres.
  const ventana = pares.slice(0, ventanaSemanas);
  // Semanas con en_quiebre=null vienen de backfill sin historia de stock_snapshots.
  // Las tratamos como excluidas por prudencia: preferimos NULLs iniciales
  // antes que métricas falsamente optimistas.
  const excluidos = ventana.filter(p => p.en_quiebre === true || p.en_quiebre === null);
  const validos = ventana.filter(p => p.en_quiebre === false);

  const n = validos.length;
  const semanas_excluidas = excluidos.length;
  const forecast_total = validos.reduce((s, p) => s + p.forecast, 0);
  const actual_total = validos.reduce((s, p) => s + p.actual, 0);

  if (n < 4) {
    return {
      ventana_semanas: ventanaSemanas,
      semanas_evaluadas: n,
      semanas_excluidas,
      wmape: null,
      bias: null,
      mad: null,
      tracking_signal: null,
      forecast_total,
      actual_total,
      es_confiable: false,
    };
  }

  let sumErrorAbs = 0;
  let sumErrorSigned = 0;
  for (const p of validos) {
    const error = p.actual - p.forecast;
    sumErrorAbs += Math.abs(error);
    sumErrorSigned += error;
  }

  const wmape = actual_total > 0 ? sumErrorAbs / actual_total : null;
  const bias = sumErrorSigned / n;
  const mad = sumErrorAbs / n;
  const tracking_signal = mad > 0 ? sumErrorSigned / mad : null;

  return {
    ventana_semanas: ventanaSemanas,
    semanas_evaluadas: n,
    semanas_excluidas,
    wmape,
    bias,
    mad,
    tracking_signal,
    forecast_total,
    actual_total,
    es_confiable: true,
  };
}
