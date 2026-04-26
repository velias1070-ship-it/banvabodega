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
  /** Fracción de ads esperada por unidad (CLP/unidad). 0 si no hay ads. */
  adsFraccionUnit?: number;
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
 * Algebra: precio = costoNetoConIVA + comision + envio + ads + margenMin
 * Como comisión es % del precio, hay que despejar:
 *   precio (1 - comisionFrac) = costoConIVA + envio + ads + margenMinAbs
 * Si margenMin se expresa como fracción del precio:
 *   precio (1 - comisionFrac - margenMinFrac) = costoConIVA + envio + ads
 *   precio = (costoConIVA + envio + ads) / (1 - comisionFrac - margenMinFrac)
 */
export function calcularFloor(inputs: FloorInputs): FloorResult {
  const {
    costoNeto,
    precioReferencia,
    pesoGr,
    comisionPct,
    canal,
    costoEnvioFullUnit = 0,
    adsFraccionUnit = 0,
    margenMinimoFrac,
  } = inputs;

  const costoNetoConIva = Math.round(costoNeto * (1 + IVA_PCT));
  const comisionFrac = comisionPct / 100;
  const envioClp = canal === "full"
    ? Math.round(costoEnvioFullUnit)
    : canal === "flex"
      ? calcularCostoEnvioML(pesoGr, precioReferencia)
      : calcularCostoEnvioML(pesoGr, precioReferencia);
  const adsClp = Math.round(adsFraccionUnit);

  const denominador = 1 - comisionFrac - margenMinimoFrac;
  if (denominador <= 0) {
    // Combinación imposible: comisión + margen mínimo > 100% del precio.
    return {
      floor: Number.POSITIVE_INFINITY,
      desglose: {
        costoNeto,
        costoNetoConIva,
        comisionClp: 0,
        envioClp,
        adsClp,
        margenMinClp: 0,
      },
    };
  }

  const numerador = costoNetoConIva + envioClp + adsClp;
  const floor = Math.round(numerador / denominador);
  const comisionClp = Math.round(floor * comisionFrac);
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
  const { costoNeto, pesoGr, comisionPct, canal, costoEnvioFullUnit = 0, adsFraccionUnit = 0 } = inputs;
  const costoConIva = costoNeto * (1 + IVA_PCT);
  const comision = precio * (comisionPct / 100);
  const envio = canal === "full"
    ? costoEnvioFullUnit
    : canal === "flex"
      ? calcularCostoEnvioML(pesoGr, precio)
      : calcularCostoEnvioML(pesoGr, precio);
  const margenAbs = precio - costoConIva - comision - envio - adsFraccionUnit;
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

/**
 * Tier de vitrina/exposición de cada tipo de promo en MercadoLibre.
 * Manual: BANVA_Pricing_Investigacion_Comparada §4.4 (eventos premium ML
 * dan más tráfico que campañas seller propias). El motor lo usa como
 * gate: no degradar de tier mayor a tier menor cuando ya hay promo activa.
 *
 * 5 = máxima vitrina (curado ML, 1 SKU/categoría/día)
 * 4 = alta (campañas masivas ML con badge dedicado)
 * 3 = media (ML targeted: stock estancado, baja rotación)
 * 2 = ML automatizado (sin badge dedicado, pero ML decide precio)
 * 1 = baja (vendedor crea, sin badge especial)
 */
export const VITRINA_TIER: Record<string, number> = {
  DOD: 5,
  MELI_CHOICE: 5,
  DEAL: 4,
  MARKETPLACE_CAMPAIGN: 4,
  LIGHTNING: 4,
  LIGHTNING_DEAL: 4,
  UNHEALTHY_STOCK: 3,
  PRE_NEGOTIATED: 3,
  PRICE_MATCHING: 2,
  SMART: 2,
  SELLER_CAMPAIGN: 1,
  PRICE_DISCOUNT: 1,
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

  return {
    margen_min_pct,
    margen_min_frac: margen_min_pct / 100,
    politica,
    acos_objetivo_pct: cu?.acos_objetivo_pct ?? FALLBACK_GLOBAL.acos_objetivo_pct,
    descuento_max_pct: ov.es_kvi
      ? (cu?.descuento_max_kvi_pct ?? FALLBACK_GLOBAL.descuento_max_pct)
      : (cu?.descuento_max_pct ?? FALLBACK_GLOBAL.descuento_max_pct),
    precio_piso_manual: ov.precio_piso,
    es_kvi: ov.es_kvi,
    auto_postular: ov.auto_postular,
    fuente: { margen: fuenteMargen, politica: fuentePolitica },
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
