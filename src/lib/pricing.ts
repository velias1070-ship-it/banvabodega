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
  /** Política del SKU. 'liquidar' puede ir bajo margen_min. */
  politica?: "defender" | "seguir" | "exprimir" | "liquidar";
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

  // 5. Warning si margen proyectado queda muy cerca del mínimo
  const margenProyectado = margenPostAds(inputs.precioObjetivo, inputs);
  if (margenProyectado !== null && margenProyectado < inputs.margenMinimoFrac + 0.03 && margenProyectado >= inputs.margenMinimoFrac) {
    warnings.push(
      `margen_ajustado: ${(margenProyectado * 100).toFixed(1)}% (mínimo ${(inputs.margenMinimoFrac * 100).toFixed(0)}%, colchón <3pp)`
    );
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
