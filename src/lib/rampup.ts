/**
 * Ramp-up factor para pedir_proveedor post-quiebre.
 *
 * Matriz (dias_en_quiebre × es_quiebre_proveedor):
 *
 * | días        | propio (false)              | proveedor (true)             |
 * |-------------|-----------------------------|------------------------------|
 * | null / 0    | 1.00 no_aplica              | 1.00 no_aplica               |
 * | 1–14        | 1.00 quiebre_propio_fresco  | 1.00 quiebre_proveedor_fresco|
 * | 15–30       | 0.50 quiebre_propio_medio   | 1.00 quiebre_proveedor_fresco|
 * | 31–60       | 0.50 quiebre_propio_medio   | 0.75 quiebre_proveedor_medio |
 * | 61–120      | 0.30 quiebre_propio_largo   | 0.75 quiebre_proveedor_medio |
 * | 121–365     | 0.00 discontinuar_candidato | 0.50 quiebre_proveedor_largo |
 *
 * Fuentes: Manual Inventarios Parte 3 Error #5 (ranking ML degrada),
 * Parte 1 §1.1 (buffer capacidad test-and-learn), Parte 2 §7.4.
 */
export interface RampupResult {
  factor: number;
  motivo: string;
}

export function calcularFactorRampup(
  diasEnQuiebre: number | null,
  esQuiebreProveedor: boolean,
): RampupResult {
  if (diasEnQuiebre === null || diasEnQuiebre === 0) {
    return { factor: 1.0, motivo: "no_aplica" };
  }

  if (esQuiebreProveedor) {
    if (diasEnQuiebre <= 30) return { factor: 1.0, motivo: "quiebre_proveedor_fresco" };
    if (diasEnQuiebre <= 120) return { factor: 0.75, motivo: "quiebre_proveedor_medio_ranking_ml_degradado" };
    return { factor: 0.5, motivo: "quiebre_proveedor_largo_relanzar" };
  }

  if (diasEnQuiebre <= 14) return { factor: 1.0, motivo: "quiebre_propio_fresco" };
  if (diasEnQuiebre <= 60) return { factor: 0.5, motivo: "quiebre_propio_medio_zara" };
  if (diasEnQuiebre <= 120) return { factor: 0.3, motivo: "quiebre_propio_largo_reactivar" };
  return { factor: 0.0, motivo: "quiebre_propio_muy_largo_evaluar_discontinuar" };
}
