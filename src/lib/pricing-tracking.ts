/**
 * Tracking de cambios de precio — taxonomía + inferencia de motivo.
 *
 * Manuales:
 *   - BANVA_Pricing_Engines_a_Escala:80 (DoorDash: "persist all the metadata")
 *   - BANVA_Pricing_Engines_a_Escala:211 (Stripe Ledger: append-only inmutable)
 *   - BANVA_Pricing_Engines_a_Escala:432 (reason text NOT NULL)
 *   - BANVA_Pricing_Operacion_Limpieza:87-89 (aprobado_por + motivo_trigger)
 *   - BANVA_Pricing_Operacion_Limpieza:509 (regla #15: cada operación logueada
 *     con motivo + aprobado_por, append-only)
 *
 * Sistema cerrado (taxonomía no-jsonb) que distingue por qué cambió un precio:
 *   - Pulsos de velocidad sugirió → admin aplicó (HIPÓTESIS, medir lift)
 *   - Admin tocó precio en tab Márgenes (OPERATIVO ajuste margen)
 *   - Postulación bulk a DEAL/SELLER_CAMPAIGN (OPERATIVO evento)
 *   - cron markdown 90/120/180 (OPERATIVO aging)
 *   - ML obligó precio fijo (UNHEALTHY/SMART/LIGHTNING/PRE_NEGOTIATED)
 *   - Reverse de markdown (subir precio post-evento)
 *   - Corrección operativa (typo, ajuste catálogo)
 *   - Sync externo (cambio detectado por cron, no fue decisión nuestra)
 *
 * El sistema de seguimiento (lift, sell-through) sólo aplica al primer caso.
 * Sin distinguir motivo, métricas no comparables se mezclan.
 */

export type MotivoPrecio =
  | "senal_pulsos_velocidad"
  | "ajuste_margen_manual"
  | "postular_evento"
  | "markdown_aging"
  | "ml_obliga_precio"
  | "revertir"
  | "correccion_operativa"
  | "sync_externo";

export type ActorPrecio =
  | "vicente"
  | "raimundo"
  | "admin"        // genérico cuando no se identifica el operador
  | "auto"          // cron / motor automático
  | "ml"            // ML obligó (precio fijo de promo)
  | "desconocido"
  | string;         // permite agent_X dinámico

/**
 * Inferencia best-effort cuando el caller NO pasa motivo explícito.
 * Mismo orden que el backfill SQL de v95 — mantener sincronizado.
 *
 * Nota: si el caller PUEDE saber el motivo (ej. botón en UI Pulsos), debe
 * pasarlo explícito. Esta función es solo fallback para crons que detectan
 * cambios externos o legado sin clasificar.
 */
export function inferMotivoFromFuente(
  fuente: string,
  contexto?: Record<string, unknown> | null,
): MotivoPrecio | null {
  if (fuente === "markdown_auto_pilot") return "markdown_aging";
  if (fuente === "promo_delete") return "revertir";
  if (fuente === "sync_diff" || fuente === "cron_margin_cache") return "sync_externo";

  if (fuente === "promo_join") {
    const promoType = String(contexto?.promotion_type ?? "").toUpperCase();
    if (["UNHEALTHY_STOCK", "SMART", "LIGHTNING", "PRE_NEGOTIATED", "PRICE_MATCHING"].includes(promoType)) {
      return "ml_obliga_precio";
    }
    if (["DEAL", "MARKETPLACE_CAMPAIGN", "SELLER_CAMPAIGN", "DOD", "VOLUME", "SELLER_COUPON_CAMPAIGN"].includes(promoType)) {
      return "postular_evento";
    }
  }

  // item_update_api directo: el admin tocó el precio sin pasar por promo.
  // Sin más info no podemos distinguir ajuste_margen_manual de correccion_
  // operativa, así que dejamos NULL (mejor null que clasificar mal).
  return null;
}

/**
 * Genera un nuevo correlation_id (UUID v4).
 * Mismo valor se usa en ml_price_history.correlation_id Y
 * pricing_decision_log.request_id para vincular evento físico ↔ decisión lógica.
 */
export function newCorrelationId(): string {
  // crypto.randomUUID disponible en Node 18+ y todos los runtimes Vercel.
  return globalThis.crypto.randomUUID();
}

/**
 * Etiquetas humanas para UI. Mantener alineado con las constantes de
 * AdminVelocitySignals.tsx + cualquier otro componente que filtre por motivo.
 */
export const MOTIVO_LABEL: Record<MotivoPrecio, string> = {
  senal_pulsos_velocidad: "Hipótesis Pulsos",
  ajuste_margen_manual:   "Ajuste margen",
  postular_evento:        "Evento (DEAL/promo)",
  markdown_aging:         "Markdown aging",
  ml_obliga_precio:       "ML obligó precio",
  revertir:               "Revert",
  correccion_operativa:   "Corrección",
  sync_externo:           "Sync externo",
};

/**
 * Subset de motivos que SÍ son hipótesis a medir vía lift/sell-through.
 * Los demás son operativos: la métrica de éxito es otra (margen efectivo,
 * cumplimiento, ranking). El endpoint /api/pricing/seguimiento puede filtrar
 * por este conjunto para mostrar solo los relevantes a evaluación.
 */
export const MOTIVOS_HIPOTESIS: ReadonlySet<MotivoPrecio> = new Set<MotivoPrecio>([
  "senal_pulsos_velocidad",
  "ajuste_margen_manual",
  "markdown_aging",
]);

export const MOTIVOS_OPERATIVOS: ReadonlySet<MotivoPrecio> = new Set<MotivoPrecio>([
  "postular_evento",
  "ml_obliga_precio",
  "revertir",
  "correccion_operativa",
  "sync_externo",
]);
