/**
 * Configuración y helpers del sistema de costos rediseñado (v100+).
 *
 * Plan: docs/sistema-costos-redesign-2026-05.md §2.1
 */

export type ABCClase = "A" | "B" | "C" | null | undefined;

/**
 * Tolerancia para detección de discrepancias de costo según clase ABC.
 *
 * Plan §2.1: A=$1, B=2%, C=5%, sin ABC=5%.
 * A es absoluto (productos críticos: cero ruido). B/C son porcentuales.
 */
export function dentroDeTolerancia(
  costoCatalogo: number,
  costoFacturado: number,
  abc: ABCClase,
): boolean {
  if (!Number.isFinite(costoCatalogo) || !Number.isFinite(costoFacturado)) return false;
  if (costoCatalogo <= 0) return false;

  const diff = Math.abs(costoFacturado - costoCatalogo);
  if (abc === "A") return diff <= 1;

  const pct = diff / costoCatalogo;
  if (abc === "B") return pct <= 0.02;
  return pct <= 0.05;
}
