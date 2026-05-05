/**
 * Feature flags para migraciones graduales.
 *
 * Resolución (orden de precedencia, primero gana):
 *   1. localStorage["banva_ff_<flagName>"] — override por usuario (browser).
 *   2. process.env.NEXT_PUBLIC_<flagName> — default global (deploy-wide).
 *   3. fallback hardcoded (default seguro: false).
 *
 * El localStorage solo aplica client-side. En el server (RSC, route handlers)
 * el flag se resuelve únicamente por env var. Esto significa que un endpoint
 * v2 con env=false NO se puede activar por localStorage — para eso, fetch
 * directo al endpoint v2 desde el componente con el flag client-side.
 *
 * Doc: docs/sprints/sprint-5-migracion-inteligencia.md (rollout playbook)
 * Convención: CONVENTIONS.md §10 (feature flags).
 */

// ── Catálogo de flags activos ──
export const FEATURE_FLAGS = {
  /** Sprint 5 — /inteligencia lee del motor nuevo (v_reposicion_explain) */
  INTEL_USE_NEW_ENGINE: "INTEL_USE_NEW_ENGINE",
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

// ── Resolución client-side (con localStorage override) ──

const LS_PREFIX = "banva_ff_";

function readLocalStorage(name: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}${name}`);
    if (raw === null) return null;
    return raw === "true" || raw === "1";
  } catch {
    return null;
  }
}

function readEnv(name: string): boolean {
  // En Next.js, NEXT_PUBLIC_* vars se inlinean en el build. Hay que listarlas
  // explícitamente porque process.env[`NEXT_PUBLIC_${name}`] no se resuelve.
  switch (name) {
    case FEATURE_FLAGS.INTEL_USE_NEW_ENGINE:
      // Sprint 8 Fase 1 (2026-05-05): motor nuevo es el default.
      // Apagar globalmente: NEXT_PUBLIC_INTEL_USE_NEW_ENGINE=false en Vercel.
      // Apagar local: localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "false")
      return process.env.NEXT_PUBLIC_INTEL_USE_NEW_ENGINE !== "false";
    default:
      return false;
  }
}

/**
 * Lee el valor del flag. Client-side respeta localStorage > env. Server-side
 * solo respeta env. Default: false.
 */
export function isFeatureEnabled(name: FeatureFlagName): boolean {
  const ls = readLocalStorage(name);
  if (ls !== null) return ls;
  return readEnv(name);
}

/**
 * Override client-side via localStorage. Para validación con owner antes
 * de prender el flag global.
 *
 * Uso desde devtools: localStorage.setItem("banva_ff_INTEL_USE_NEW_ENGINE", "true")
 */
export function setFeatureOverride(name: FeatureFlagName, value: boolean | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      window.localStorage.removeItem(`${LS_PREFIX}${name}`);
    } else {
      window.localStorage.setItem(`${LS_PREFIX}${name}`, value ? "true" : "false");
    }
  } catch {
    /* localStorage no disponible (incognito, quota) */
  }
}

/**
 * Útil para mostrar el estado en UI de admin. Devuelve la fuente del valor
 * actual para diagnosticar por qué el flag está como está.
 */
export function getFeatureSource(name: FeatureFlagName): "localStorage" | "env" | "default" {
  if (readLocalStorage(name) !== null) return "localStorage";
  if (readEnv(name)) return "env";
  return "default";
}
