import { calcularCostoEnvioML } from "./ml-shipping";

/**
 * Motor de pricing — cálculo de floor matemático y gates de postulación.
 *
 * Las 3 fuentes (compass_artifact, Ajuste Plan Pricing BANVA, deep-research 2)
 * coinciden en que el núcleo del motor es un "floor" compuesto por 6 partes:
 *
 *   floor = COGS + fee_ML + costo_logistico + fracción_ads + IVA_no_recup + margen_min
 *
 * Bajo ese precio, postular destruye margen. Sobre ese precio, hay libertad
 * para jugar con descuentos y visibilidad.
 *
 * Este módulo no consulta DB — recibe todos los inputs como parámetros para
 * ser testeable y reusable desde cualquier endpoint.
 */

export const IVA_PCT = 0.19;

/**
 * Constantes regulatorias Chile + ML Chile.
 * Fuente: Ajuste Plan Pricing BANVA.md — "valle de la muerte" envío gratis.
 */
export const VALLE_MUERTE_MIN = 19990;
export const VALLE_MUERTE_MAX = 23000;

/**
 * Umbral SERNAC: precios congelados N días antes de evento con descuento
 * anunciado. 2024 multó a Falabella/Paris/Líder por no cumplir.
 */
export const DIAS_CONGELAMIENTO_EVENTO = 45;

/**
 * Cobertura mínima para postular a descuentos.
 * Fuente: Compass artifact — "Excluir SKUs con stock <28 días cobertura
 * (subir precio defensivo, no postular)".
 * Razonamiento: descuento acelera ventas → quiebre → pérdida de Buy Box por
 * semanas. El costo del stockout supera el ingreso del descuento.
 */
export const COBERTURA_MIN_POSTULAR_DIAS = 28;

/**
 * Cobertura que activa flag "sobrestock" — soft signal para priorizar
 * postulación agresiva (liquidar rotación lenta).
 */
export const COBERTURA_SOBRESTOCK_DIAS = 90;

export type CanalLogistico = "flex" | "full" | "unknown";

export type FloorInputs = {
  /** Costo unitario neto del producto (productos.costo_promedio o costo). */
  costoNeto: number;
  /** Precio al que se evalúa el floor (para calcular fees y ads proporcionales). */
  precioReferencia: number;
  /** Peso facturable en gramos (ml_margin_cache.peso_facturable). */
  pesoGr: number;
  /** Comisión % de ML para esta categoría + listing_type. */
  comisionPct: number;
  /** Canal logístico: cambia costo de envío y quién lo paga. */
  canal: CanalLogistico;
  /** Costo de envío Full unitario en CLP (si aplica). 0 si es Flex. */
  costoEnvioFullUnit?: number;
  /**
   * ACOS objetivo como fracción del precio final (0.05 = 5%). El motor lo
   * trata proporcional al piso: ads = piso × acosFrac. Va al denominador
   * de la fórmula (mismo trato que comisión y margen mínimo).
   *
   * Antes había `adsFraccionUnit` con valor absoluto fijo (CLP), pero
   * sobrestimaba el piso porque imputaba el ads del precio actual incluso
   * al precio reducido. Si bajas el precio, los ads bajan proporcionales.
   */
  acosFrac?: number;
  /** Margen mínimo neto requerido, en fracción (0.15 = 15%). */
  margenMinimoFrac: number;
};

export type FloorResult = {
  /** Precio mínimo de postulación que respeta margen_min post-ads. */
  floor: number;
  /** Desglose para transparencia / UI. */
  desglose: {
    costoNeto: number;
    costoNetoConIva: number;
    comisionClp: number;
    envioClp: number;
    adsClp: number;
    margenMinClp: number;
  };
};

/**
 * Calcula el floor matemático.
 *
 * Algebra: precio = costoConIVA + comision + envio + ads + margenMin
 * Comisión, ads y margenMin se expresan como fracción del precio →
 * todos van al denominador:
 *   precio (1 - comisionFrac - acosFrac - margenMinFrac) = costoConIVA + envio
 *   precio = (costoConIVA + envio) / (1 - comisionFrac - acosFrac - margenMinFrac)
 */
export function calcularFloor(inputs: FloorInputs): FloorResult {
  const {
    costoNeto,
    precioReferencia,
    pesoGr,
    comisionPct,
    canal,
    costoEnvioFullUnit = 0,
    acosFrac = 0,
    margenMinimoFrac,
  } = inputs;

  const costoNetoConIva = Math.round(costoNeto * (1 + IVA_PCT));
  const comisionFrac = comisionPct / 100;
  const envioClp = canal === "full"
    ? Math.round(costoEnvioFullUnit)
    : canal === "flex"
      ? calcularCostoEnvioML(pesoGr, precioReferencia)
      : calcularCostoEnvioML(pesoGr, precioReferencia);

  const denominador = 1 - comisionFrac - acosFrac - margenMinimoFrac;
  if (denominador <= 0) {
    // Combinación imposible: comisión + ads + margen > 100% del precio.
    return {
      floor: Number.POSITIVE_INFINITY,
      desglose: {
        costoNeto,
        costoNetoConIva,
        comisionClp: 0,
        envioClp,
        adsClp: 0,
        margenMinClp: 0,
      },
    };
  }

  const numerador = costoNetoConIva + envioClp;
  const floor = Math.round(numerador / denominador);
  const comisionClp = Math.round(floor * comisionFrac);
  const adsClp = Math.round(floor * acosFrac);
  const margenMinClp = Math.round(floor * margenMinimoFrac);

  return {
    floor,
    desglose: {
      costoNeto,
      costoNetoConIva,
      comisionClp,
      envioClp,
      adsClp,
      margenMinClp,
    },
  };
}

/**
 * Evalúa si un precio objetivo pasa todos los gates económicos y regulatorios.
 * Devuelve lista de motivos para bloqueo (vacía si pasa).
 */
export type GateInputs = FloorInputs & {
  precioObjetivo: number;
  /** Override manual de precio piso en productos.precio_piso. Si viene, gana sobre el floor calculado. */
  precioPisoManual?: number | null;
  /** Si el SKU es KVI, prohíbe descuentos agresivos (>20% off lista). */
  esKvi?: boolean;
  /** Precio de lista actual (para calcular % descuento propuesto). */
  precioLista?: number;
  /** Política del SKU. 'liquidar' puede ir bajo margen_min y sin cobertura mínima. */
  politica?: "defender" | "seguir" | "exprimir" | "liquidar";
  /** Cobertura en días del SKU (stock_total / velocidad_diaria). Default: sin gate si no viene. */
  coberturaDias?: number | null;
};

export type GateResult = {
  pasa: boolean;
  floor: number;
  motivosBloqueo: string[];
  warnings: string[];
};

export function evaluarGates(inputs: GateInputs): GateResult {
  const motivosBloqueo: string[] = [];
  const warnings: string[] = [];

  // 1. Floor económico
  const { floor, desglose } = calcularFloor(inputs);
  const floorEfectivo = Math.max(floor, inputs.precioPisoManual || 0);
  if (inputs.precioObjetivo < floorEfectivo && inputs.politica !== "liquidar") {
    motivosBloqueo.push(
      `bajo_floor: ${inputs.precioObjetivo} < ${floorEfectivo} (costo+iva ${desglose.costoNetoConIva} · comisión ${desglose.comisionClp} · envío ${desglose.envioClp} · ads ${desglose.adsClp} · margen_min ${desglose.margenMinClp})`
    );
  }

  // 2. Valle de la muerte — envío gratis forzado en ML Chile
  if (inputs.precioObjetivo > VALLE_MUERTE_MIN && inputs.precioObjetivo < VALLE_MUERTE_MAX) {
    motivosBloqueo.push(
      `valle_muerte: ${inputs.precioObjetivo} en rango prohibido ${VALLE_MUERTE_MIN}-${VALLE_MUERTE_MAX} (envío gratis obligatorio sin ingreso compensatorio)`
    );
  }

  // 3. KVI no acepta descuento agresivo (>20% off lista)
  if (inputs.esKvi && inputs.precioLista && inputs.precioLista > 0) {
    const descPct = ((inputs.precioLista - inputs.precioObjetivo) / inputs.precioLista) * 100;
    if (descPct > 20) {
      motivosBloqueo.push(
        `kvi_descuento_excesivo: ${descPct.toFixed(1)}% off > 20% permitido para KVI`
      );
    }
  }

  // 4. Política defender no acepta descuentos >10%
  if (inputs.politica === "defender" && inputs.precioLista && inputs.precioLista > 0) {
    const descPct = ((inputs.precioLista - inputs.precioObjetivo) / inputs.precioLista) * 100;
    if (descPct > 10) {
      motivosBloqueo.push(
        `politica_defender: ${descPct.toFixed(1)}% off > 10% permitido en política 'defender'`
      );
    }
  }

  // 5. Gate de cobertura — no postular a descuento si stock insuficiente
  //    (las 3 fuentes coinciden: stockout por descuento destruye Buy Box
  //    por semanas; el costo supera el ingreso del descuento). Excepción:
  //    política 'liquidar' puede postular con cobertura baja (objetivo explícito).
  if (typeof inputs.coberturaDias === "number" && inputs.coberturaDias !== null && inputs.politica !== "liquidar") {
    if (inputs.coberturaDias < COBERTURA_MIN_POSTULAR_DIAS) {
      motivosBloqueo.push(
        `cobertura_baja: ${inputs.coberturaDias.toFixed(0)}d < ${COBERTURA_MIN_POSTULAR_DIAS}d mínimo (descuento con poco stock acelera quiebre y destruye Buy Box)`
      );
    }
  }

  // 6. Warning si margen proyectado queda muy cerca del mínimo
  const margenProyectado = margenPostAds(inputs.precioObjetivo, inputs);
  if (margenProyectado !== null && margenProyectado < inputs.margenMinimoFrac + 0.03 && margenProyectado >= inputs.margenMinimoFrac) {
    warnings.push(
      `margen_ajustado: ${(margenProyectado * 100).toFixed(1)}% (mínimo ${(inputs.margenMinimoFrac * 100).toFixed(0)}%, colchón <3pp)`
    );
  }

  // 7. Señal informativa: sobrestock (oportunidad de liquidación)
  if (typeof inputs.coberturaDias === "number" && inputs.coberturaDias !== null && inputs.coberturaDias > COBERTURA_SOBRESTOCK_DIAS) {
    warnings.push(`sobrestock: cobertura ${inputs.coberturaDias.toFixed(0)}d > ${COBERTURA_SOBRESTOCK_DIAS}d — candidato prioritario para liquidar`);
  }

  return { pasa: motivosBloqueo.length === 0, floor: floorEfectivo, motivosBloqueo, warnings };
}

/**
 * Calcula margen post-ads proyectado a un precio dado, en fracción (0.18 = 18%).
 * Devuelve null si el precio es 0.
 */
export function margenPostAds(precio: number, inputs: FloorInputs): number | null {
  if (precio <= 0) return null;
  const { costoNeto, pesoGr, comisionPct, canal, costoEnvioFullUnit = 0, acosFrac = 0 } = inputs;
  const costoConIva = costoNeto * (1 + IVA_PCT);
  const comision = precio * (comisionPct / 100);
  const envio = canal === "full"
    ? costoEnvioFullUnit
    : canal === "flex"
      ? calcularCostoEnvioML(pesoGr, precio)
      : calcularCostoEnvioML(pesoGr, precio);
  const adsAbs = precio * acosFrac;
  const margenAbs = precio - costoConIva - comision - envio - adsAbs;
  return margenAbs / precio;
}

/**
 * Cooldown anti race-to-the-bottom.
 *
 * Manual: BANVA_Pricing_Investigacion_Comparada §4.1 implicacion #3:
 *   "Si bajo el precio 2 veces en 24h sin recuperar Buy Box, frenar."
 *
 * Adaptado a BANVA (sin Buy Box, sin catalogo competitivo): si el SKU
 * tuvo N o mas bajadas de precio en la ventana de horas, bloquear nuevas
 * postulaciones a promo. Evita loop accidental cuando hay mucha promo
 * disponible y los gates sueltan a varias en cadena.
 *
 * Lee ml_price_history (delta_pct < 0 = bajada) en ventana reciente.
 *
 * Uso:
 *   const result = await evaluarCooldown(sb, sku, { ventanaHoras: 24, maxBajadas: 2 });
 *   if (result.bloqueado) -> push motivo a hardExtras
 */
export interface CooldownInputs {
  ventanaHoras: number;
  maxBajadas: number;
}

export interface CooldownResult {
  bloqueado: boolean;
  bajadas_en_ventana: number;
  motivo: string | null;
  ultima_bajada_at?: string;
}

// Constants exportadas para reuso en UI/tests
export const COOLDOWN_VENTANA_HORAS = 24;
export const COOLDOWN_MAX_BAJADAS = 2;

// Ventana de evaluación post-markdown.
// Manual: BANVA_Op_Limpieza:498 (no profundizar antes de cerrar la ventana de
// credibilidad MLC 30d) + Op_Limpieza:402 (pausar profundización post-MD para
// medir lift+sell-through antes del próximo escalón).
// VENTANA_LIFT_DIAS = 14 días: ventana mínima para medir lift = vel_post/vel_pre
// (Op_Limpieza KPI #4). Antes de los 14d no hay señal estadística.
// VENTANA_EVAL_DIAS = 30 días: ventana extendida que incluye sell-through
// (Op_Limpieza KPI #3) + cierre de credibilidad MLC.
// MIN_DELTA_PCT_BAJADA_REAL = -3%: una bajada menor a -3% se considera ruido
// (cambio de promo cosmético, ajuste de redondeo). Solo bajadas reales gatillan
// la ventana de evaluación.
export const VENTANA_EVAL_DIAS = 30;
export const VENTANA_LIFT_DIAS = 14;
export const MIN_DELTA_PCT_BAJADA_REAL = -3;

export interface VentanaEvalResult {
  bloqueado: boolean;
  dias_desde_md: number;
  dias_restantes: number;
  ult_bajada_at: string;
  precio_pre: number;
  precio_post: number;
  motivo: string;
}

/**
 * Última bajada real por SKU desde una lista de eventos ya pasada por
 * `collapseSwapBlips`. Solo cuenta delta_pct ≤ MIN_DELTA_PCT_BAJADA_REAL
 * para descartar ruido cosmético. Devuelve Map<sku_origen, evento más reciente>.
 *
 * Manual: BANVA_Op_Limpieza:498 — usar el evento real, no el ruido sync_diff.
 */
export function ultimaBajadaRealPorSku(
  eventosColapsados: PriceHistoryRow[],
  thresholdDeltaPct: number = MIN_DELTA_PCT_BAJADA_REAL,
): Map<string, { precio: number; precio_anterior: number; detected_at: string }> {
  const m = new Map<string, { precio: number; precio_anterior: number; detected_at: string }>();
  for (const h of eventosColapsados) {
    const key = h.sku_origen || h.sku;
    if (!key) continue;
    if (h.delta_pct == null || h.delta_pct > thresholdDeltaPct) continue;
    const cur = m.get(key);
    if (!cur || h.detected_at > cur.detected_at) {
      m.set(key, {
        precio: Number(h.precio),
        precio_anterior: Number(h.precio_anterior ?? 0),
        detected_at: h.detected_at,
      });
    }
  }
  return m;
}

/**
 * Evalúa si un SKU está en ventana de evaluación post-markdown.
 *
 * Si el SKU tuvo una bajada real (delta ≤ -3%) en los últimos VENTANA_EVAL_DIAS,
 * el motor NO debe profundizar (no nuevas bajadas, no nuevas postulaciones de
 * promo con descuento adicional) hasta que cierre la ventana.
 *
 * Manual:
 *   - BANVA_Op_Limpieza:498,504 (no profundizar durante credibilidad 30d)
 *   - BANVA_Op_Limpieza:402 (pausar para medir lift)
 *   - Engines:411 (decisiones referencian rule_set vigente)
 *
 * Patrón de uso:
 *   1. Query batch a ml_price_history WHERE detected_at >= NOW() - 30d.
 *   2. const eventos = collapseSwapBlips(rawRows).
 *   3. const map = ultimaBajadaRealPorSku(eventos).
 *   4. Para cada SKU: const r = evaluarVentanaEval(map.get(sku) ?? null, hoy).
 *   5. Si r.bloqueado → no aplicar acción, loguear motivo.
 */
export function evaluarVentanaEval(
  ultBajada: { precio: number; precio_anterior: number; detected_at: string } | null,
  hoy: Date = new Date(),
  ventanaDias: number = VENTANA_EVAL_DIAS,
): VentanaEvalResult | null {
  if (!ultBajada) return null;
  const diasDesde = Math.floor((hoy.getTime() - new Date(ultBajada.detected_at).getTime()) / 86400_000);
  if (diasDesde >= ventanaDias) return null;
  const diasRestantes = ventanaDias - diasDesde;
  return {
    bloqueado: true,
    dias_desde_md: diasDesde,
    dias_restantes: diasRestantes,
    ult_bajada_at: ultBajada.detected_at,
    precio_pre: ultBajada.precio_anterior,
    precio_post: ultBajada.precio,
    motivo: `ventana_eval_activa: bajada $${ultBajada.precio_anterior.toLocaleString("es-CL")}→$${ultBajada.precio.toLocaleString("es-CL")} hace ${diasDesde}d, faltan ${diasRestantes}d para profundizar (Op_Limpieza:498)`,
  };
}

/**
 * Tier de vitrina/exposición de cada tipo de promo en MercadoLibre.
 * Mapeo derivado de la investigación operativa ML Chile (sección Ofertas,
 * eventos comerciales, etiquetas de descuento) y BANVA_Pricing_Investigacion_Comparada §4.4.
 * El motor lo usa como gate: no degradar de tier mayor a tier menor cuando ya hay promo activa.
 *
 * Lista canónica oficial de tipos en seller-promotions v2 (al 2026-04-26):
 * DEAL, MARKETPLACE_CAMPAIGN, PRICE_DISCOUNT, LIGHTNING, DOD, VOLUME,
 * PRE_NEGOTIATED, SELLER_CAMPAIGN, SMART, PRICE_MATCHING, UNHEALTHY_STOCK,
 * SELLER_COUPON_CAMPAIGN. Tipos nuevos que ML disponibilice en el futuro
 * caen al fallback tier 1 vía `tierVitrina()`.
 *
 * TIER S (5) — Máxima exposición: sección "Ofertas" + push notifications.
 *   DOD (24h, 1 SKU/categoría, +1M visitas/día), LIGHTNING (6h, urgencia + sección).
 *
 * TIER A (4) — Eventos comerciales con sección exclusiva o co-financiamiento.
 *   DEAL (Hot Sale, CyberDay, Día de la Mama), MARKETPLACE_CAMPAIGN, SMART (ML co-fondea
 *   y prioriza ranking porque está co-invirtiendo).
 *
 * TIER B (3) — Etiqueta verde "% OFF" + boost CTR en grilla, sin sección dedicada.
 *   PRICE_DISCOUNT (descuento individual con tag verde), PRE_NEGOTIATED (negociado 1-a-1 con KAM).
 *
 * TIER C (2) — Boost moderado de nicho (ML targeted, sin tag premium).
 *   UNHEALTHY_STOCK (ML quiere desalojar Full estancado, boost moderado).
 *
 * TIER D (1) — Sin boost de exposición. Solo precio rebajado.
 *   PRICE_MATCHING, SELLER_CAMPAIGN, SELLER_COUPON_CAMPAIGN, VOLUME.
 */
export const VITRINA_TIER: Record<string, number> = {
  DOD: 5,
  LIGHTNING: 5,
  DEAL: 4,
  MARKETPLACE_CAMPAIGN: 4,
  SMART: 4,
  PRICE_DISCOUNT: 3,
  PRE_NEGOTIATED: 3,
  UNHEALTHY_STOCK: 2,
  PRICE_MATCHING: 1,
  SELLER_CAMPAIGN: 1,
  SELLER_COUPON_CAMPAIGN: 1,
  VOLUME: 1,
};

export function tierVitrina(promoType: string | null | undefined): number {
  if (!promoType) return 0;
  return VITRINA_TIER[promoType.toUpperCase()] ?? 1;
}

/**
 * Resolver de configuracion pricing por SKU con override jerarquico.
 *
 * Cascada: productos.<campo> override > pricing_cuadrante_config[cuadrante] > _DEFAULT.
 *
 * Fuente: BANVA_Pricing_Ajuste_Plan §5 + Investigacion_Comparada §6.2 ("defaults
 * por cuadrante, override por SKU"). El manual prescribe NO un default uniforme
 * de margen 15% sino diferenciacion: ESTRELLA 8%, CASHCOW 20%, REVISAR 0%.
 */
export interface PricingCuadranteConfig {
  cuadrante: string;
  margen_min_pct: number;
  politica_default: "defender" | "seguir" | "exprimir" | "liquidar";
  acos_objetivo_pct: number | null;
  descuento_max_pct: number | null;
  descuento_max_kvi_pct: number | null;
  canal_preferido: string | null;
}

export interface PricingProductoOverrides {
  precio_piso: number | null;
  margen_minimo_pct: number | null;
  politica_pricing: string | null;
  es_kvi: boolean;
  auto_postular: boolean;
}

export interface PricingResolved {
  margen_min_pct: number;
  margen_min_frac: number;
  politica: "defender" | "seguir" | "exprimir" | "liquidar";
  acos_objetivo_pct: number | null;
  descuento_max_pct: number | null;
  precio_piso_manual: number | null;
  es_kvi: boolean;
  auto_postular: boolean;
  fuente: {
    margen: "sku" | "cuadrante" | "default";
    politica: "sku" | "cuadrante" | "default";
  };
  /**
   * Sub-clasificacion derivada cuando cuadrante = REVISAR. El manual
   * (Investigacion_Comparada §3 + §6) separa cola larga sana, dead stock
   * real, sin stock y nuevo. La matriz ABC×Margen los junta indistintamente.
   * null = no aplica (el cuadrante NO es REVISAR o no se pasaron metricas).
   */
  cuadrante_subtipo: "revisar_sano" | "revisar_liquidar" | "revisar_sin_stock" | "revisar_nuevo" | null;
  /**
   * Bandera derivada del subtipo. true cuando el manual prescribe NO
   * postular (sin stock o nuevo). El motor lo respeta como hard-skip.
   */
  no_postular_por_subtipo: boolean;
}

/**
 * Metricas de inventario/ventas necesarias para sub-clasificar dentro
 * de REVISAR. Tomadas de sku_intelligence directamente.
 */
export interface MetricsParaSubtipo {
  uds_30d: number | null;
  margen_neto_30d: number | null;
  dias_sin_movimiento: number | null;
  dias_desde_primera_venta: number | null;
  stock_total: number | null;
  alertas: string[] | null;
}

/**
 * Sub-clasificacion del cuadrante REVISAR siguiendo los umbrales del
 * manual (Investigacion_Comparada §3 línea 197 + §6 línea 237):
 *   - revisar_liquidar: dead stock real (>180d sin movimiento o alerta dead_stock).
 *     Manual: "Dog/descontinuar: >90-180d slow; >180-365d dead stock".
 *   - revisar_sin_stock: stock = 0 y sin venta. Gobierno de surtido:
 *     descontinuar (manual Deep_Research §3 "gobierno de surtido").
 *   - revisar_nuevo: <60d desde primera venta. Esperar a que madure.
 *   - revisar_sano (default): cola larga rentable. Manual: "Long tail con
 *     premium monitoreado +10-20% vs commodity, NO hacer price exploration".
 */
export function subtipoRevisar(metrics: MetricsParaSubtipo): NonNullable<PricingResolved["cuadrante_subtipo"]> {
  const uds = metrics.uds_30d ?? 0;
  const stock = metrics.stock_total ?? 0;
  const dias_sin_mov = metrics.dias_sin_movimiento ?? 0;
  const dias_desde_primera = metrics.dias_desde_primera_venta ?? 999;
  const alertas = metrics.alertas ?? [];

  if (alertas.includes("dead_stock") || dias_sin_mov >= 180) return "revisar_liquidar";
  if (stock <= 0 && uds === 0) return "revisar_sin_stock";
  if (dias_desde_primera < 60) return "revisar_nuevo";
  return "revisar_sano";
}

const FALLBACK_GLOBAL = {
  margen_min_pct: 15,
  politica: "seguir" as const,
  acos_objetivo_pct: 12,
  descuento_max_pct: 20,
};

export function resolverPricingConfig(
  override: PricingProductoOverrides | null,
  cuadranteConfig: PricingCuadranteConfig | null,
  defaultConfig: PricingCuadranteConfig | null,
  // Opcionales para sub-clasificar dentro de REVISAR. Si no se pasan,
  // el resolver mantiene el comportamiento previo (REVISAR → liquidar).
  cuadranteName?: string | null,
  metrics?: MetricsParaSubtipo,
): PricingResolved {
  const ov = override ?? { precio_piso: null, margen_minimo_pct: null, politica_pricing: null, es_kvi: false, auto_postular: false };
  const cu = cuadranteConfig ?? defaultConfig ?? null;

  const margenSku = ov.margen_minimo_pct;
  const margenCuad = cu?.margen_min_pct;
  let margen_min_pct: number;
  let fuenteMargen: "sku" | "cuadrante" | "default";
  if (margenSku != null && margenSku !== 15) {
    margen_min_pct = margenSku;
    fuenteMargen = "sku";
  } else if (margenCuad != null) {
    margen_min_pct = margenCuad;
    fuenteMargen = "cuadrante";
  } else {
    margen_min_pct = FALLBACK_GLOBAL.margen_min_pct;
    fuenteMargen = "default";
  }

  const politicaSku = ov.politica_pricing;
  const politicaCuad = cu?.politica_default;
  let politica: PricingResolved["politica"];
  let fuentePolitica: "sku" | "cuadrante" | "default";
  if (politicaSku && politicaSku !== "seguir") {
    politica = politicaSku as PricingResolved["politica"];
    fuentePolitica = "sku";
  } else if (politicaCuad) {
    politica = politicaCuad;
    fuentePolitica = "cuadrante";
  } else {
    politica = FALLBACK_GLOBAL.politica;
    fuentePolitica = "default";
  }

  // Sub-clasificación dentro de REVISAR (manual Investigacion_Comparada §3 + §6).
  // Override programático que NO toca pricing_cuadrante_config — los defaults
  // del cuadrante REVISAR se aplican solo al subtipo "revisar_liquidar".
  let cuadrante_subtipo: PricingResolved["cuadrante_subtipo"] = null;
  let no_postular_por_subtipo = false;
  let descuento_max_override: number | null = null;
  if (cuadranteName === "REVISAR" && metrics && fuentePolitica === "cuadrante" && fuenteMargen === "cuadrante") {
    cuadrante_subtipo = subtipoRevisar(metrics);
    if (cuadrante_subtipo === "revisar_sano") {
      // Cola larga sana: defender margen +10-15%, NO liquidar.
      politica = "defender";
      margen_min_pct = 15;
      descuento_max_override = 20;
    } else if (cuadrante_subtipo === "revisar_sin_stock") {
      // Sin stock + sin venta: gobierno de surtido = no postular.
      politica = "defender";
      margen_min_pct = 20;
      descuento_max_override = 10;
      no_postular_por_subtipo = true;
    } else if (cuadrante_subtipo === "revisar_nuevo") {
      // SKU nuevo (<60d): esperar a que madure, no actuar.
      politica = "defender";
      margen_min_pct = 15;
      descuento_max_override = 15;
      no_postular_por_subtipo = true;
    }
    // revisar_liquidar: mantiene config REVISAR (liquidar, 0%, 60%).
  }

  return {
    margen_min_pct,
    margen_min_frac: margen_min_pct / 100,
    politica,
    acos_objetivo_pct: cu?.acos_objetivo_pct ?? FALLBACK_GLOBAL.acos_objetivo_pct,
    descuento_max_pct: descuento_max_override != null
      ? descuento_max_override
      : ov.es_kvi
        ? (cu?.descuento_max_kvi_pct ?? FALLBACK_GLOBAL.descuento_max_pct)
        : (cu?.descuento_max_pct ?? FALLBACK_GLOBAL.descuento_max_pct),
    precio_piso_manual: ov.precio_piso,
    es_kvi: ov.es_kvi,
    auto_postular: ov.auto_postular,
    fuente: { margen: fuenteMargen, politica: fuentePolitica },
    cuadrante_subtipo,
    no_postular_por_subtipo,
  };
}

/**
 * Evalua el gate de cooldown a partir del conteo de bajadas en ventana.
 * Sincrónico — el caller hace la query a ml_price_history y pasa el count.
 *
 * Patron para usarlo en un endpoint:
 *   1. Query batch a ml_price_history WHERE delta_pct < 0 AND detected_at > NOW() - 24h
 *   2. Construir Map<sku, count_bajadas>
 *   3. Para cada SKU evaluado: evaluarCooldown(map.get(sku) ?? 0, opts)
 */
export function evaluarCooldown(
  bajadasEnVentana: number,
  opts: CooldownInputs = { ventanaHoras: COOLDOWN_VENTANA_HORAS, maxBajadas: COOLDOWN_MAX_BAJADAS },
): CooldownResult {
  const bloqueado = bajadasEnVentana >= opts.maxBajadas;
  return {
    bloqueado,
    bajadas_en_ventana: bajadasEnVentana,
    motivo: bloqueado
      ? `cooldown: ${bajadasEnVentana} bajadas en ${opts.ventanaHoras}h (max ${opts.maxBajadas})`
      : null,
  };
}

// ==================== PRICE HISTORY READER ====================
//
// ml_price_history es append-only y captura TODO cambio detectado, incluyendo
// "ruido" del propio sistema:
//
//   1. Admin/motor postula una promo nueva (fuente='promo_join') — cambio real.
//   2. cron_margin_cache corre con timing imperfecto y ve momentaneamente el
//      precio sin la promo nueva — registra sync_diff con priceList como precio.
//   3. cron_margin_cache corre de nuevo cuando ML ya propago la promo — registra
//      sync_diff con el precio efectivo final.
//
// Caso real ALPCMPRBO4575 (2026-04-28 12:41):
//   - 12:41:13 promo_join admin_ui: $19.980 → $9.980 (real)
//   - 12:41:23 sync_diff cron:      $11.980 → $19.980 (ruido — vio price_lista)
//   - 12:41:29 sync_diff cron:      $19.980 → $9.980  (ruido — confirma 1)
//
// Sin filtrar, un analizador de "cambios reales" cuenta 3 eventos cuando hubo 1.
// `collapseSwapBlips` colapsa la cascada manteniendo solo el evento "real".

export type PriceHistoryFuente =
  | "sync_diff" | "item_update_api" | "promo_join" | "promo_delete"
  | "snapshot_diario" | "manual_admin" | "markdown_auto_pilot";

export interface PriceHistoryRow {
  item_id: string;
  sku_origen?: string | null;
  sku?: string | null;
  precio: number;
  precio_anterior: number | null;
  delta_pct: number | null;
  fuente: PriceHistoryFuente | string;
  ejecutado_por?: string | null;
  detected_at: string;
  contexto?: Record<string, unknown> | null;
}

const REAL_ACTION_FUENTES = new Set<string>([
  "promo_join", "promo_delete", "item_update_api",
  "manual_admin", "markdown_auto_pilot",
]);

const SWAP_BLIP_WINDOW_SECONDS = 60;

/**
 * Colapsa la cascada de eventos sync_diff que sigue a una accion real
 * (promo_join, manual_admin, etc) dentro de SWAP_BLIP_WINDOW_SECONDS.
 *
 * Reglas:
 *   - Si un evento de "accion real" tiene >=1 sync_diff dentro de la ventana
 *     y el ULTIMO sync_diff de la ventana coincide en precio (±$100) con la
 *     accion real → todos los sync_diff de esa ventana se descartan.
 *   - Caso 2 sync_diff que se anulan exactamente (a sube X→Y, b baja Y→X) →
 *     descartar ambos (eco puro del cron sin cambio real).
 *
 * Eventos quedan ordenados por detected_at ascendente.
 */
export function collapseSwapBlips(events: PriceHistoryRow[]): PriceHistoryRow[] {
  const sorted = [...events].sort((a, b) => a.detected_at.localeCompare(b.detected_at));
  const drop = new Set<number>();
  const ts = (s: string) => new Date(s).getTime();

  for (let i = 0; i < sorted.length; i++) {
    if (drop.has(i)) continue;
    const e = sorted[i];
    if (!REAL_ACTION_FUENTES.has(String(e.fuente))) continue;
    const tEnd = ts(e.detected_at) + SWAP_BLIP_WINDOW_SECONDS * 1000;
    const wIdx: number[] = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const f = sorted[j];
      if (f.item_id !== e.item_id) continue;
      if (ts(f.detected_at) > tEnd) break;
      if (f.fuente !== "sync_diff") continue;
      wIdx.push(j);
    }
    if (wIdx.length === 0) continue;
    const last = sorted[wIdx[wIdx.length - 1]];
    if (Math.abs(Number(last.precio) - Number(e.precio)) <= 100) {
      for (const j of wIdx) drop.add(j);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (drop.has(i)) continue;
    if (sorted[i].fuente !== "sync_diff") continue;
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!b || drop.has(i + 1)) continue;
    if (b.fuente !== "sync_diff") continue;
    if (b.item_id !== a.item_id) continue;
    if (ts(b.detected_at) - ts(a.detected_at) > SWAP_BLIP_WINDOW_SECONDS * 1000) continue;
    if (
      a.precio_anterior != null && b.precio_anterior != null &&
      Number(a.precio) === Number(b.precio_anterior) &&
      Number(a.precio_anterior) === Number(b.precio)
    ) {
      drop.add(i); drop.add(i + 1);
    }
  }

  return sorted.filter((_, i) => !drop.has(i));
}
