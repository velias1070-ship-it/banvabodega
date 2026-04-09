/**
 * Returns the base URL para self-calls dentro de la app.
 *
 * IMPORTANTE: VERCEL_URL apunta al deployment URL único
 * (banvabodega-XXXX-vicentes-projects.vercel.app), que tiene Vercel Deployment
 * Protection activado y devuelve 401 a cualquier request sin token de bypass.
 * Usar siempre VERCEL_PROJECT_PRODUCTION_URL (banvabodega.vercel.app), que es
 * el alias de producción público y bypasea la protección.
 */
export function getBaseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}
