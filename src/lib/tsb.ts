// TSB (Teunter-Syntetos-Babai) para demanda intermitente — PR3 Fase A.
//
// Referencia: Teunter R., Syntetos A., Babai M. (2011) "Intermittent demand:
// Linking forecasting to inventory obsolescence". European J. of Operational
// Research 214(3), 606-615.
//
// Fórmula (versión canónica con suavizado exponencial doble):
//   z_t = α · y_t + (1−α) · z_{t−1}          (sólo si y_t > 0)
//   p_t = β · I(y_t > 0) + (1−β) · p_{t−1}   (siempre)
//   forecast = z_t · p_t                      (demanda esperada por período)
//
// Diferencia vs Croston/SBA: el componente p_t se actualiza TODOS los períodos,
// lo que permite detectar obsolescencia (caída de probabilidad) sin esperar a
// que lleguen observaciones con demanda. Croston sólo actualiza en períodos
// con venta → nunca "apaga" un SKU que dejó de venderse.
//
// Shadow mode: este módulo es puro. El motor lo invoca desde Paso 2 y persiste
// el output en `vel_ponderada_tsb`. No consume el valor para decisiones hasta
// Fase C (post-benchmark).

const MIN_HISTORIA_SEMANAS = 8;

export type ModeloForecast = "sma_ponderado" | "tsb";

export interface ResultadoTSB {
  forecast: number;       // uds/sem pronosticadas
  alpha_usado: number;
  beta_usado: number;
  // Debug opcional — útil para inspección y tests.
  z_final: number;
  p_final: number;
}

/**
 * Calcula el forecast TSB dado un array de ventas semanales.
 *
 * Entrada: `ventas[0]` = semana más antigua, `ventas[n-1]` = semana más reciente.
 * Ventana típica: 9-12 semanas en BANVA (el motor arma `ventasSemana[9]`).
 *
 * - Si hay < 8 semanas de historia → devuelve `null` (TSB no converge).
 * - Si todas las ventas son 0 → devuelve forecast=0 (no hay obsolescencia que
 *   detectar; simplemente el SKU no se vende).
 * - Si `alpha`/`beta` no se pasan, aplica grid search simple sobre
 *   `{0.1, 0.2, 0.3, 0.4}` minimizando MSE de 1-paso-adelante sobre las
 *   últimas 4 semanas. Rango intencionalmente estrecho — los valores típicos
 *   de la literatura para retail están en 0.1-0.3.
 */
export function calcularTSB(
  ventas: number[],
  alpha?: number,
  beta?: number,
): ResultadoTSB | null {
  if (ventas.length < MIN_HISTORIA_SEMANAS) return null;

  const todoCero = ventas.every(v => v === 0);
  if (todoCero) {
    return {
      forecast: 0,
      alpha_usado: alpha ?? 0.2,
      beta_usado: beta ?? 0.2,
      z_final: 0,
      p_final: 0,
    };
  }

  if (alpha !== undefined && beta !== undefined) {
    return correrTSB(ventas, alpha, beta);
  }

  // Auto-calibración: grid search.
  const grid = [0.1, 0.2, 0.3, 0.4];
  let mejor: ResultadoTSB | null = null;
  let mejorMSE = Infinity;
  for (const a of grid) {
    for (const b of grid) {
      const { mse, resultado } = evaluarMSE(ventas, a, b);
      if (mse < mejorMSE) {
        mejorMSE = mse;
        mejor = resultado;
      }
    }
  }
  return mejor;
}

function correrTSB(ventas: number[], alpha: number, beta: number): ResultadoTSB {
  // Inicialización:
  //   z_0 = media de ventas en períodos con demanda > 0 (evita arrancar en 0
  //         y bloquear el suavizado cuando α es chico).
  //   p_0 = proporción de períodos con demanda > 0 en el warm-up (primeras
  //         4 semanas) — pivote estable pero no demasiado lento.
  const warmup = Math.min(4, ventas.length);
  let sumaDemanda = 0;
  let periodosConDemanda = 0;
  for (let i = 0; i < warmup; i++) {
    if (ventas[i] > 0) {
      sumaDemanda += ventas[i];
      periodosConDemanda++;
    }
  }
  let z = periodosConDemanda > 0 ? sumaDemanda / periodosConDemanda : 0;
  let p = warmup > 0 ? periodosConDemanda / warmup : 0;

  // Actualización secuencial (versión canónica TSB).
  for (let t = warmup; t < ventas.length; t++) {
    const y = ventas[t];
    if (y > 0) {
      z = alpha * y + (1 - alpha) * z;
      p = beta * 1 + (1 - beta) * p;
    } else {
      // z no se actualiza si no hubo demanda (sólo el suavizado de probabilidad).
      p = beta * 0 + (1 - beta) * p;
    }
  }

  const forecast = z * p;
  return {
    forecast: round4(forecast),
    alpha_usado: alpha,
    beta_usado: beta,
    z_final: round4(z),
    p_final: round4(p),
  };
}

function evaluarMSE(ventas: number[], alpha: number, beta: number): { mse: number; resultado: ResultadoTSB } {
  // Calcula MSE usando las últimas 4 predicciones 1-paso-adelante (walk-forward).
  // Para t en [n-4, n-1]: predice con ventas[0..t-1], compara con ventas[t].
  const n = ventas.length;
  const ventanaEval = Math.min(4, n - MIN_HISTORIA_SEMANAS);
  if (ventanaEval < 1) {
    // No alcanza para walk-forward — usa el forecast final sin MSE confiable.
    return {
      mse: 0,
      resultado: correrTSB(ventas, alpha, beta),
    };
  }

  let sumSqErr = 0;
  for (let t = n - ventanaEval; t < n; t++) {
    const historia = ventas.slice(0, t);
    if (historia.length < MIN_HISTORIA_SEMANAS) continue;
    const pred = correrTSB(historia, alpha, beta).forecast;
    const err = ventas[t] - pred;
    sumSqErr += err * err;
  }
  const mse = sumSqErr / ventanaEval;
  return { mse, resultado: correrTSB(ventas, alpha, beta) };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ════════════════════════════════════════════════════════════════════════════
// Puerta de selección de modelo
// ════════════════════════════════════════════════════════════════════════════

/**
 * Decide qué modelo de forecast usar para un SKU.
 *
 * Reglas (PR3 Fase A, "Ajuste 1" del plan):
 *   - Si `xyz !== 'Z'` → SMA ponderado (modelo actual). Sólo Z es candidato TSB.
 *   - Si `primera_venta` es null → SMA ponderado (no sé la edad, jugarla seguro).
 *   - Si días desde primera venta < 60 → SMA ponderado (puerta anti-ramp-up;
 *     TSB interpretaría ceros iniciales como obsolescencia de un producto
 *     que en realidad recién se lanzó).
 *   - Resto (Z maduro, ≥60 días) → TSB.
 *
 * Intencionalmente no tenemos 3 modelos vivos simultáneos (SMA + Croston + TSB):
 * sólo 2 regímenes (nuevo = SMA, maduro = TSB) para que el comportamiento
 * sea auditable.
 */
export function seleccionarModeloZ(
  sku: { primera_venta: Date | string | null; xyz: string },
  hoy: Date,
): ModeloForecast {
  if (sku.xyz !== "Z") return "sma_ponderado";
  if (!sku.primera_venta) return "sma_ponderado";
  const pv = sku.primera_venta instanceof Date
    ? sku.primera_venta
    : new Date(sku.primera_venta);
  if (Number.isNaN(pv.getTime())) return "sma_ponderado";
  const diasDesdeInicio = (hoy.getTime() - pv.getTime()) / 86_400_000;
  return diasDesdeInicio >= 60 ? "tsb" : "sma_ponderado";
}

export { MIN_HISTORIA_SEMANAS };
