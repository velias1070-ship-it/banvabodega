// Helpers de fechas — semanas ISO lun-dom en UTC.
// Convención del proyecto: todas las semanas usan UTC (no hora Chile) para que
// los snapshots semanales coincidan entre Vercel (UTC) y los cálculos del motor.

const MS_DIA = 86_400_000;

/**
 * Lunes ISO (lun-dom) en UTC de la fecha dada, como `YYYY-MM-DD`.
 * Si la fecha cae domingo, devuelve el lunes 6 días antes.
 */
export function lunesIso(fecha: Date): string {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  const dow = d.getUTCDay(); // 0=dom, 1=lun, ..., 6=sáb
  const diffDias = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffDias);
  return d.toISOString().slice(0, 10);
}

/** Resta N semanas a un lunes ISO. Devuelve YYYY-MM-DD. */
export function restarSemanas(lunesIsoStr: string, n: number): string {
  const d = new Date(lunesIsoStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() - 7 * n);
  return d.toISOString().slice(0, 10);
}

/** Suma N semanas a un lunes ISO. */
export function sumarSemanas(lunesIsoStr: string, n: number): string {
  return restarSemanas(lunesIsoStr, -n);
}

/** Días entre dos fechas ISO (b - a). */
export function diasEntre(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00.000Z").getTime();
  const b = new Date(bIso + "T00:00:00.000Z").getTime();
  return Math.round((b - a) / MS_DIA);
}

/**
 * Lista los últimos N lunes ISO **cerrados** respecto a `hoy`.
 * Una semana está cerrada si el domingo de esa semana ya pasó (hoy ≥ lunes siguiente).
 * Devuelve orden ASC: [más viejo, ..., más reciente cerrado].
 */
export function ultimosNLunesCerrados(hoy: Date, n: number): string[] {
  const lunesActual = lunesIso(hoy);
  // Si hoy ES lunes, la semana del lunesActual aún no cerró.
  // El último lunes cerrado es el lunes anterior.
  const primerLunesCerrado = restarSemanas(lunesActual, 1);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(restarSemanas(primerLunesCerrado, i));
  return out;
}
