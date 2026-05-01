import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/intelligence/sku/{sku_origen}/explain
 *
 * Devuelve el arbol de calculo para cada metrica del SKU. Para cada
 * metrica: valor actual (de sku_intelligence), formula que la computa,
 * inputs (variables con valor + fuente tabla.columna o referencia a otra
 * metrica), file:line del codigo, link al doc maestro, y verificacion
 * manual del calculo cuando es reproducible.
 *
 * Sirve de base para el panel UI "Explicar SKU" y para debugging.
 *
 * Doc autoritativo de formulas: /docs/policies/inventario-formulas.md
 */

interface InputCrudo {
  nombre: string;
  valor: number | string | null;
  tipo: "fuente" | "constante" | "metrica" | "derivado";
  fuente?: string;
  ref?: string;
  formula?: string;
  inputs?: InputCrudo[];
  nota?: string;
}

interface MetricaExplicada {
  valor: number | string | boolean | null;
  unidad?: string;
  formula?: string;
  inputs?: InputCrudo[];
  policy?: string;
  codigo?: string;
  doc?: string;
  verificacion?: {
    calculado: number;
    motor: number;
    match: boolean;
    delta?: number;
  };
  nota?: string;
}

type IntelRow = Record<string, number | string | boolean | null | string[]>;

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

function explicarMetricas(r: IntelRow): Record<string, MetricaExplicada> {
  const sku = r.sku_origen as string;
  const abc = r.abc as string;
  const stockFull = num(r.stock_full);
  const stockBodega = num(r.stock_bodega);
  const stockEnTransito = num(r.stock_en_transito);
  const stockTotal = num(r.stock_total);
  const velPonderada = num(r.vel_ponderada);
  const velFull = num(r.vel_full);
  const velFlex = num(r.vel_flex);
  const velAjustadaEvento = num(r.vel_ajustada_evento);
  const multiplicadorEvento = num(r.multiplicador_evento);
  const pctFull = num(r.pct_full);
  const pctFlex = num(r.pct_flex);
  const targetDias = num(r.target_dias_full);
  const cobFull = num(r.cob_full);
  const ropCalculado = num(r.rop_calculado);
  const safetyCompleto = num(r.safety_stock_completo);
  const safetySimple = num(r.safety_stock_simple);
  const sigmaD = num(r.desviacion_std);
  const ltDias = num(r.lead_time_usado_dias);
  const ltSigma = 1.5; // hoy plano fallback
  const nivelServicio = num(r.nivel_servicio);
  const margenFull30d = num(r.margen_full_30d);
  const margenFlex30d = num(r.margen_flex_30d);
  const accion = r.accion as string;
  const prioridad = num(r.prioridad);
  const mandarFull = num(r.mandar_full);
  const pedirProveedor = num(r.pedir_proveedor);
  const pedirSinRampup = num(r.pedir_proveedor_sin_rampup);
  const factorRampup = num(r.factor_rampup_aplicado);
  const innerPack = num(r.inner_pack);
  const cuadrante = r.cuadrante as string;
  const xyz = r.xyz as string;
  const cv = num(r.cv);

  const ltSem = ltDias / 7;
  const sigmaLtSem = ltSigma / 7;
  const z = nivelServicio === 0.97 ? 1.88 : nivelServicio === 0.95 ? 1.65 : nivelServicio === 0.90 ? 1.28 : 0;
  const bufferMl = 2; // simplificado — el motor decide 2 vs 4 segun sharedOrigins

  // ── Velocidad ──
  const vel7d = num(r.vel_7d);
  const vel30d = num(r.vel_30d);
  const vel60d = num(r.vel_60d);
  const velPonderadaCalc = round2(0.5 * vel7d + 0.3 * vel30d + 0.2 * vel60d);

  // ── velFullCalc / velFlexCalc para cob ──
  const velCalculo = multiplicadorEvento > 1 ? velAjustadaEvento : velPonderada;
  const velFullCalc = velCalculo * pctFull;
  const cobFullCalc = velFullCalc > 0 ? round2((stockFull / velFullCalc) * 7) : 999;

  // ── Safety stock completo ──
  const ssCompletoCalc = sigmaD > 0 || sigmaLtSem > 0
    ? round2(z * Math.sqrt(ltSem * sigmaD * sigmaD + velPonderada * velPonderada * sigmaLtSem * sigmaLtSem))
    : 0;

  // ── ROP ──
  const ropCalc = round2(velPonderada * ltSem + safetyCompleto);

  // ── mandar_full v7 ──
  const targetFullUds = velCalculo * pctFull * targetDias / 7;
  const deficitFull = Math.max(0, Math.ceil(targetFullUds - stockFull));
  const disponibleParaFull = Math.max(0, stockBodega - bufferMl);
  const mandarFullCalc = Math.min(deficitFull, disponibleParaFull);

  // ── pedir_proveedor (sin rampup) ──
  const demandaCiclo = velCalculo * targetDias / 7;
  const cantidadObjetivo = demandaCiclo + safetyCompleto;
  const stockTotalParaPedir = stockFull + stockBodega + stockEnTransito;
  const pedirSinRampupCalc = Math.max(0, Math.ceil(cantidadObjetivo - stockTotalParaPedir));

  return {
    // ════════════════════════════════════════════════════════════════════
    // §1 IDENTIDAD Y COSTO
    // ════════════════════════════════════════════════════════════════════

    sku_origen: {
      valor: sku,
      doc: "/docs/policies/inventario-formulas.md#sku_origen",
      inputs: [{ nombre: "productos.sku", valor: sku, tipo: "fuente", fuente: "productos.sku (tabla maestra)" }],
    },

    nombre: {
      valor: r.nombre as string,
      inputs: [{ nombre: "productos.nombre", valor: r.nombre as string, tipo: "fuente", fuente: "productos.nombre" }],
    },

    proveedor: {
      valor: r.proveedor as string,
      nota: "Cache legible. FK canonico es productos.proveedor_id.",
      inputs: [{ nombre: "productos.proveedor", valor: r.proveedor as string, tipo: "fuente", fuente: "productos.proveedor" }],
    },

    costo_neto: {
      valor: num(r.costo_neto),
      unidad: "CLP",
      formula: "cascada: productos.costo_promedio (WAC) → costo_manual → proveedor_catalogo.precio_neto",
      codigo: "src/lib/intelligence.ts:918-940",
      doc: "/docs/policies/inventario-formulas.md#costo_neto",
      inputs: [
        { nombre: "costo_fuente", valor: r.costo_fuente as string, tipo: "fuente", fuente: "intelligence.ts:923 (cascada)" },
      ],
    },

    inner_pack: {
      valor: innerPack,
      nota: "Unidades por bulto del proveedor. Distinto a unidades_pack_venta.",
      inputs: [
        { nombre: "proveedor_catalogo.inner_pack", valor: innerPack, tipo: "fuente", fuente: "proveedor_catalogo (fallback productos.inner_pack)" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §2 VELOCIDAD
    // ════════════════════════════════════════════════════════════════════

    vel_7d: {
      valor: vel7d,
      unidad: "uds/semana",
      formula: "sum(uds vendidas en últimos 7 días)",
      codigo: "src/lib/intelligence.ts:1040",
      doc: "/docs/policies/inventario-formulas.md#vel_7d",
      inputs: [
        { nombre: "ventas_ml_cache", valor: "filtradas anulada=false AND estado='Pagada'", tipo: "fuente", fuente: "ventas_ml_cache.fecha_date >= hoy-7d" },
        { nombre: "composicion_venta", valor: "para mapear sku_venta → sku_origen × unidades", tipo: "fuente", fuente: "composicion_venta" },
      ],
    },

    vel_30d: {
      valor: vel30d,
      unidad: "uds/semana",
      formula: "sum(uds últimos 30d) / semanasActivas30d",
      nota: "semanasActivas30d excluye semanas con ≥3 días de quiebre Full",
      codigo: "src/lib/intelligence.ts:1048",
      inputs: [
        { nombre: "ventas_ml_cache", valor: "ventana 30d", tipo: "fuente", fuente: "ventas_ml_cache" },
        { nombre: "semanasActivas30d", valor: "max(1, 4.3 − semanas en quiebre)", tipo: "derivado", fuente: "stock_snapshots / inferirQuiebres" },
      ],
    },

    vel_60d: {
      valor: vel60d,
      unidad: "uds/semana",
      formula: "sum(uds últimos 60d) / semanasActivas60d",
      codigo: "src/lib/intelligence.ts:1049",
      inputs: [
        { nombre: "ventas_ml_cache", valor: "ventana 60d", tipo: "fuente", fuente: "ventas_ml_cache" },
      ],
    },

    vel_ponderada: {
      valor: velPonderada,
      unidad: "uds/semana",
      formula: "0.5 × vel_7d + 0.3 × vel_30d + 0.2 × vel_60d",
      codigo: "src/lib/intelligence.ts:1055",
      doc: "/docs/policies/inventario-formulas.md#vel_ponderada",
      verificacion: {
        calculado: velPonderadaCalc,
        motor: velPonderada,
        match: Math.abs(velPonderadaCalc - velPonderada) < 0.05,
        delta: round2(velPonderadaCalc - velPonderada),
      },
      inputs: [
        { nombre: "vel_7d", valor: vel7d, tipo: "metrica", ref: "vel_7d" },
        { nombre: "vel_30d", valor: vel30d, tipo: "metrica", ref: "vel_30d" },
        { nombre: "vel_60d", valor: vel60d, tipo: "metrica", ref: "vel_60d" },
      ],
    },

    vel_full: {
      valor: velFull,
      unidad: "uds/semana",
      formula: "sum(uds Full últimos 30d) / semanasActivas30d",
      inputs: [
        { nombre: "ventas_ml_cache", valor: "filtrada canal='Full'", tipo: "fuente", fuente: "ventas_ml_cache.canal" },
      ],
    },

    vel_flex: {
      valor: velFlex,
      unidad: "uds/semana",
      formula: "sum(uds Flex últimos 30d) / semanasActivas30d",
      inputs: [
        { nombre: "ventas_ml_cache", valor: "filtrada canal='Flex'", tipo: "fuente", fuente: "ventas_ml_cache.canal" },
      ],
    },

    pct_full: {
      valor: pctFull,
      unidad: "fracción 0..1",
      formula: "0.7 si margen_flex_30d / margen_full_30d > 1.1, sino 0.8",
      codigo: "src/lib/intelligence.ts:1170-1186",
      doc: "/docs/policies/inventario-formulas.md#pct_full",
      verificacion: (() => {
        const ratioOk = margenFull30d > 0 && margenFlex30d > 0;
        const calc = ratioOk && (margenFlex30d / margenFull30d) > 1.1 ? 0.7 : 0.8;
        return {
          calculado: calc,
          motor: pctFull,
          match: Math.abs(calc - pctFull) < 0.01,
        };
      })(),
      inputs: [
        { nombre: "margen_full_30d", valor: margenFull30d, tipo: "metrica", ref: "margen_full_30d" },
        { nombre: "margen_flex_30d", valor: margenFlex30d, tipo: "metrica", ref: "margen_flex_30d" },
      ],
    },

    pct_flex: {
      valor: pctFlex,
      unidad: "fracción 0..1",
      formula: "1 − pct_full",
      inputs: [{ nombre: "pct_full", valor: pctFull, tipo: "metrica", ref: "pct_full" }],
    },

    multiplicador_evento: {
      valor: multiplicadorEvento,
      unidad: "factor",
      formula: "max(multiplicadores aplicables) si hay evento activo, sino 1.0",
      inputs: [
        { nombre: "evento_activo", valor: r.evento_activo as string, tipo: "fuente", fuente: "eventos_demanda" },
      ],
    },

    vel_ajustada_evento: {
      valor: velAjustadaEvento,
      unidad: "uds/semana",
      formula: "vel_ponderada × multiplicador_evento",
      verificacion: {
        calculado: round2(velPonderada * multiplicadorEvento),
        motor: velAjustadaEvento,
        match: Math.abs(velPonderada * multiplicadorEvento - velAjustadaEvento) < 0.05,
      },
      inputs: [
        { nombre: "vel_ponderada", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
        { nombre: "multiplicador_evento", valor: multiplicadorEvento, tipo: "metrica", ref: "multiplicador_evento" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §3 STOCK
    // ════════════════════════════════════════════════════════════════════

    stock_full: {
      valor: stockFull,
      unidad: "uds",
      doc: "/docs/policies/inventario-formulas.md#stock_full",
      inputs: [
        { nombre: "stock_full_cache.qty_disponible", valor: stockFull, tipo: "fuente", fuente: "stock_full_cache (cron /api/ml/sync-stock-full lee meli_facility cada 1h)" },
      ],
    },

    stock_bodega: {
      valor: stockBodega,
      unidad: "uds",
      formula: "SUM(stock.cantidad) WHERE UPPER(stock.sku) = UPPER(sku_origen)",
      inputs: [
        { nombre: "tabla stock", valor: stockBodega, tipo: "fuente", fuente: "stock (RPC registrar_movimiento_stock es único actualizador)" },
      ],
    },

    stock_en_transito: {
      valor: stockEnTransito,
      unidad: "uds",
      formula: "SUM(cantidad_pedida − cantidad_recibida) FROM ordenes_compra_lineas WHERE estado IN ('EMITIDA','RECIBIDA_PARCIAL')",
      nota: "stock_en_transito NO entra en deficit_full (regla v6 flex-full.ts). Solo en pedir_proveedor.",
      inputs: [
        { nombre: "ordenes_compra_lineas", valor: stockEnTransito, tipo: "fuente", fuente: "ordenes_compra_lineas + trigger v93 sincroniza cantidad_recibida desde recepcion_lineas" },
      ],
    },

    stock_total: {
      valor: stockTotal,
      unidad: "uds",
      formula: "stock_full + stock_bodega + stock_alternativos",
      verificacion: {
        calculado: stockFull + stockBodega,
        motor: stockTotal,
        match: Math.abs(stockFull + stockBodega - stockTotal) < 1,
      },
      inputs: [
        { nombre: "stock_full", valor: stockFull, tipo: "metrica", ref: "stock_full" },
        { nombre: "stock_bodega", valor: stockBodega, tipo: "metrica", ref: "stock_bodega" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §4 COBERTURA
    // ════════════════════════════════════════════════════════════════════

    target_dias_full: {
      valor: targetDias,
      unidad: "días",
      formula: "ABC=A → 42, ABC=B → 28, ABC=C → 14",
      codigo: "src/lib/intelligence.ts:387-389,1776-1778",
      inputs: [
        { nombre: "abc", valor: abc, tipo: "metrica", ref: "abc" },
        { nombre: "intel_config.targetDiasA/B/C", valor: "42/28/14", tipo: "constante", fuente: "intel_config" },
      ],
    },

    cob_full: {
      valor: cobFull,
      unidad: "días",
      formula: "stock_full / (velCalculo × pct_full) × 7",
      nota: "velCalculo = vel_ajustada_evento si evento, sino vel_ponderada",
      codigo: "src/lib/reposicion.ts:107-110",
      doc: "/docs/policies/inventario-formulas.md#cob_full",
      verificacion: {
        calculado: cobFullCalc,
        motor: cobFull,
        match: Math.abs(cobFullCalc - cobFull) < 0.1,
        delta: round2(cobFullCalc - cobFull),
      },
      inputs: [
        { nombre: "stock_full", valor: stockFull, tipo: "metrica", ref: "stock_full" },
        { nombre: "velCalculo", valor: velCalculo, tipo: "derivado", formula: "evento ? vel_ajustada_evento : vel_ponderada" },
        { nombre: "pct_full", valor: pctFull, tipo: "metrica", ref: "pct_full" },
      ],
    },

    cob_total: {
      valor: num(r.cob_total),
      unidad: "días",
      formula: "stock_total / velCalculo × 7",
      inputs: [
        { nombre: "stock_total", valor: stockTotal, tipo: "metrica", ref: "stock_total" },
        { nombre: "velCalculo", valor: velCalculo, tipo: "derivado" },
      ],
    },

    dias_sin_stock_full: {
      valor: num(r.dias_sin_stock_full),
      unidad: "días",
      formula: "(hoy − fecha_entrada_quiebre) si stock_full = 0, sino 0",
      codigo: "src/lib/intelligence.ts:590-636",
      inputs: [
        { nombre: "fecha_entrada_quiebre", valor: r.fecha_entrada_quiebre as string, tipo: "fuente", fuente: "sku_intelligence (ancla preservada entre recálculos)" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §5 ABC + XYZ + CUADRANTE
    // ════════════════════════════════════════════════════════════════════

    abc: {
      valor: abc,
      formula: "max(abc_margen, abc_ingreso, abc_unidades)",
      nota: "Cada eje es Pareto 80/95: A hasta 80% acumulado, B hasta 95%, C resto. Se toma el peor (más exigente).",
      codigo: "src/lib/intelligence.ts:1703-1736",
      inputs: [
        { nombre: "abc_margen", valor: r.abc_margen as string, tipo: "metrica" },
        { nombre: "abc_ingreso", valor: r.abc_ingreso as string, tipo: "metrica" },
        { nombre: "abc_unidades", valor: r.abc_unidades as string, tipo: "metrica" },
      ],
    },

    desviacion_std: {
      valor: sigmaD,
      unidad: "uds/semana",
      formula: "stddev de ventas semanales en últimos 60d",
      codigo: "src/lib/intelligence.ts:519-525,1188-1197",
      inputs: [
        { nombre: "ventas semanales 60d", valor: "agrupadas por semana, excluyendo semanas en quiebre", tipo: "fuente", fuente: "ventas_ml_cache + agruparPorSemana" },
      ],
    },

    cv: {
      valor: cv,
      formula: "desviacion_std / media_semanal",
      inputs: [
        { nombre: "desviacion_std", valor: sigmaD, tipo: "metrica", ref: "desviacion_std" },
      ],
    },

    xyz: {
      valor: xyz,
      formula: "X si cv<0.5, Y si cv<1.0, Z si cv≥1.0",
      codigo: "src/lib/intelligence.ts:1193-1197",
      inputs: [
        { nombre: "cv", valor: cv, tipo: "metrica", ref: "cv" },
      ],
    },

    cuadrante: {
      valor: cuadrante,
      formula: "matriz 2×2 sobre abc_margen × abc_unidades",
      nota: "ESTRELLA=A×A · CASHCOW=A×(B/C) · REVISAR=(B/C)×A · PERRO=(B/C)×(B/C)",
      inputs: [
        { nombre: "abc_margen", valor: r.abc_margen as string, tipo: "metrica" },
        { nombre: "abc_unidades", valor: r.abc_unidades as string, tipo: "metrica" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §6 SAFETY STOCK + ROP
    // ════════════════════════════════════════════════════════════════════

    nivel_servicio: {
      valor: nivelServicio,
      unidad: "fracción 0..1",
      formula: "ABC=A → 0.97, ABC=B → 0.95 (default), ABC=C → 0.90",
      codigo: "src/lib/intelligence.ts:1825-1828",
      doc: "/docs/policies/inventario-formulas.md#nivel_servicio",
      nota: "Pendiente: matriz ABC×XYZ del manual (9 valores, hoy plano por ABC).",
      inputs: [
        { nombre: "abc", valor: abc, tipo: "metrica", ref: "abc" },
      ],
    },

    lead_time_usado_dias: {
      valor: ltDias,
      unidad: "días",
      formula: "cascada: lead_time_real_dias (medido) → proveedores.lead_time_dias (manual) → 7d default",
      nota: "Hoy 0/86 proveedores tienen LT medido (lt_muestras=0). Idetex=5d 'manual', resto=7d 'fallback'.",
      inputs: [
        { nombre: "lead_time_fuente", valor: r.lead_time_fuente as string, tipo: "fuente", fuente: "intelligence.ts:1832-1837 cascada" },
      ],
    },

    safety_stock_simple: {
      valor: safetySimple,
      unidad: "uds",
      formula: "Z × σ_D × √(LT_sem)",
      codigo: "src/lib/intelligence.ts:1846",
      verificacion: {
        calculado: round2(z * sigmaD * Math.sqrt(ltSem)),
        motor: safetySimple,
        match: Math.abs(round2(z * sigmaD * Math.sqrt(ltSem)) - safetySimple) < 0.5,
      },
      inputs: [
        { nombre: "Z", valor: z, tipo: "derivado", formula: "zScore(nivel_servicio)" },
        { nombre: "σ_D", valor: sigmaD, tipo: "metrica", ref: "desviacion_std" },
        { nombre: "LT_sem", valor: round2(ltSem), tipo: "derivado", formula: "lead_time_usado_dias / 7" },
      ],
    },

    safety_stock_completo: {
      valor: safetyCompleto,
      unidad: "uds",
      formula: "Z × √(LT_sem × σ_D² + D² × σ_LT_sem²)",
      nota: "Fórmula que prescribe BANVA_Manual_Inventarios_Parte1.md §507.",
      codigo: "src/lib/intelligence.ts:1853-1862",
      doc: "/docs/policies/inventario-formulas.md#safety_stock_completo",
      verificacion: {
        calculado: ssCompletoCalc,
        motor: safetyCompleto,
        match: Math.abs(ssCompletoCalc - safetyCompleto) < 0.5,
        delta: round2(ssCompletoCalc - safetyCompleto),
      },
      inputs: [
        { nombre: "Z", valor: z, tipo: "derivado", formula: "zScore(nivel_servicio)" },
        { nombre: "LT_sem", valor: round2(ltSem), tipo: "derivado", formula: "lead_time_usado_dias / 7" },
        { nombre: "σ_D", valor: sigmaD, tipo: "metrica", ref: "desviacion_std" },
        { nombre: "D", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
        { nombre: "σ_LT_sem", valor: round2(sigmaLtSem), tipo: "constante", nota: "Hoy 1.5/7 plano. Pendiente medir σ_LT real por OC." },
      ],
    },

    rop_calculado: {
      valor: ropCalculado,
      unidad: "uds",
      formula: "D × LT_sem + safety_stock_completo",
      nota: "Si stock_total ≤ rop_calculado AND vel>0 → necesita_pedir=true",
      codigo: "src/lib/intelligence.ts:1862",
      doc: "/docs/policies/inventario-formulas.md#rop_calculado",
      verificacion: {
        calculado: ropCalc,
        motor: ropCalculado,
        match: Math.abs(ropCalc - ropCalculado) < 0.5,
        delta: round2(ropCalc - ropCalculado),
      },
      inputs: [
        { nombre: "D", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
        { nombre: "LT_sem", valor: round2(ltSem), tipo: "derivado" },
        { nombre: "safety_stock_completo", valor: safetyCompleto, tipo: "metrica", ref: "safety_stock_completo" },
      ],
    },

    necesita_pedir: {
      valor: r.necesita_pedir as boolean,
      formula: "stock_total ≤ rop_calculado AND vel_ponderada > 0",
      codigo: "src/lib/intelligence.ts:1868-1869",
      verificacion: {
        calculado: stockTotal <= ropCalculado && velPonderada > 0 ? 1 : 0,
        motor: r.necesita_pedir ? 1 : 0,
        match: ((stockTotal <= ropCalculado && velPonderada > 0) === Boolean(r.necesita_pedir)),
      },
      inputs: [
        { nombre: "stock_total", valor: stockTotal, tipo: "metrica", ref: "stock_total" },
        { nombre: "rop_calculado", valor: ropCalculado, tipo: "metrica", ref: "rop_calculado" },
        { nombre: "vel_ponderada", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §7 GMROI Y DIO
    // ════════════════════════════════════════════════════════════════════

    gmroi: {
      valor: num(r.gmroi),
      formula: "(margen_neto_30d × 12) / costo_inventario_total",
      nota: "Saludable > 3. Margen anual generado por cada $1 invertido en stock.",
      codigo: "src/lib/intelligence.ts:1252",
      inputs: [
        { nombre: "margen_neto_30d", valor: num(r.margen_neto_30d), tipo: "metrica", ref: "margen_neto_30d" },
        { nombre: "costo_inventario_total", valor: num(r.costo_inventario_total), tipo: "metrica", ref: "costo_inventario_total" },
      ],
    },

    dio: {
      valor: num(r.dio),
      unidad: "días",
      formula: "stock_total / vel_ponderada × 7",
      nota: "Idéntico a cob_total.",
      codigo: "src/lib/intelligence.ts:1253",
      inputs: [
        { nombre: "stock_total", valor: stockTotal, tipo: "metrica", ref: "stock_total" },
        { nombre: "vel_ponderada", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §8 ACCIÓN Y PRIORIDAD
    // ════════════════════════════════════════════════════════════════════

    accion: {
      valor: accion,
      formula: "decision tree (11 valores) — ver §11 del doc maestro",
      codigo: "src/lib/intelligence.ts:1439-1462",
      doc: "/docs/policies/inventario-formulas.md#accion",
      nota: "Override: si URGENTE/AGOTADO_PEDIR pero stock_en_transito > 0 → EN_TRANSITO.",
      inputs: [
        { nombre: "stock_full", valor: stockFull, tipo: "metrica", ref: "stock_full" },
        { nombre: "stock_bodega", valor: stockBodega, tipo: "metrica", ref: "stock_bodega" },
        { nombre: "vel_ponderada", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
        { nombre: "vel_full", valor: velFull, tipo: "metrica", ref: "vel_full" },
        { nombre: "cob_full", valor: cobFull, tipo: "metrica", ref: "cob_full" },
        { nombre: "punto_reorden", valor: num(r.punto_reorden), tipo: "metrica" },
        { nombre: "stock_en_transito", valor: stockEnTransito, tipo: "metrica", ref: "stock_en_transito" },
        { nombre: "es_quiebre_proveedor", valor: r.es_quiebre_proveedor as boolean ? "true" : "false", tipo: "metrica" },
      ],
    },

    prioridad: {
      valor: prioridad,
      formula: "tabla por accion: AGOTADO_SIN_PROV=3, AGOTADO_PEDIR=5, MANDAR_FULL=10, URGENTE=15, EN_TRANSITO=25, PLANIFICAR=40, NUEVO=50, OK=60, EXCESO=70, DEAD_STOCK=80, INACTIVO=99",
      nota: "Menor número = más urgente.",
      inputs: [
        { nombre: "accion", valor: accion, tipo: "metrica", ref: "accion" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §9 MANDAR AL FULL (split bodega/Full v7)
    // ════════════════════════════════════════════════════════════════════

    mandar_full: {
      valor: mandarFull,
      unidad: "uds",
      formula: "min(deficit_full, max(0, stock_bodega − buffer_ml))",
      policy: "P-INV-1 (cycle stock va a Full primero, manual Parte1 §577-578)",
      codigo: "src/lib/flex-full.ts:71-93",
      doc: "/docs/policies/inventario-formulas.md#mandar_full",
      verificacion: {
        calculado: mandarFullCalc,
        motor: mandarFull,
        match: Math.abs(mandarFullCalc - mandarFull) <= 1,
        delta: mandarFullCalc - mandarFull,
      },
      inputs: [
        {
          nombre: "deficit_full",
          valor: deficitFull,
          tipo: "derivado",
          formula: "max(0, ceil(targetFullUds − stock_full))",
          inputs: [
            {
              nombre: "targetFullUds",
              valor: round2(targetFullUds),
              tipo: "derivado",
              formula: "velCalculo × pct_full × target_dias_full / 7",
              inputs: [
                { nombre: "velCalculo", valor: velCalculo, tipo: "derivado", formula: "evento ? vel_ajustada_evento : vel_ponderada" },
                { nombre: "pct_full", valor: pctFull, tipo: "metrica", ref: "pct_full" },
                { nombre: "target_dias_full", valor: targetDias, tipo: "metrica", ref: "target_dias_full" },
              ],
            },
            { nombre: "stock_full", valor: stockFull, tipo: "metrica", ref: "stock_full" },
          ],
        },
        { nombre: "stock_bodega", valor: stockBodega, tipo: "metrica", ref: "stock_bodega" },
        { nombre: "buffer_ml", valor: bufferMl, tipo: "constante", nota: "2 si SKU no compartido, 4 si aparece en >1 publicación ML" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §10 PEDIR PROVEEDOR
    // ════════════════════════════════════════════════════════════════════

    pedir_proveedor_sin_rampup: {
      valor: pedirSinRampup,
      unidad: "uds",
      formula: "max(0, ceil(cantidad_objetivo − stock_total_pedido))",
      codigo: "src/lib/intelligence.ts:1882-1939",
      doc: "/docs/policies/inventario-formulas.md#pedir_proveedor",
      verificacion: {
        calculado: pedirSinRampupCalc,
        motor: pedirSinRampup,
        match: Math.abs(pedirSinRampupCalc - pedirSinRampup) <= 3,
        delta: pedirSinRampupCalc - pedirSinRampup,
      },
      inputs: [
        {
          nombre: "cantidad_objetivo",
          valor: round2(cantidadObjetivo),
          tipo: "derivado",
          formula: "demanda_ciclo + safety_stock_completo",
          inputs: [
            {
              nombre: "demanda_ciclo",
              valor: round2(demandaCiclo),
              tipo: "derivado",
              formula: "velCalculo × target_dias_full / 7",
            },
            { nombre: "safety_stock_completo", valor: safetyCompleto, tipo: "metrica", ref: "safety_stock_completo" },
          ],
        },
        {
          nombre: "stock_total_pedido",
          valor: stockTotalParaPedir,
          tipo: "derivado",
          formula: "stock_full + stock_bodega + stock_en_transito",
        },
      ],
    },

    factor_rampup_aplicado: {
      valor: factorRampup,
      unidad: "factor",
      formula: "1.5 a 2.0 si saliendo de quiebre prolongado, sino 1.0",
      codigo: "src/lib/rampup.ts",
      inputs: [
        { nombre: "rampup_motivo", valor: r.rampup_motivo as string, tipo: "fuente", fuente: "rampup.ts" },
      ],
    },

    pedir_proveedor: {
      valor: pedirProveedor,
      unidad: "uds",
      formula: "pedir_proveedor_sin_rampup × factor_rampup_aplicado",
      verificacion: {
        calculado: Math.round(pedirSinRampup * factorRampup),
        motor: pedirProveedor,
        match: Math.abs(Math.round(pedirSinRampup * factorRampup) - pedirProveedor) <= 1,
      },
      inputs: [
        { nombre: "pedir_proveedor_sin_rampup", valor: pedirSinRampup, tipo: "metrica", ref: "pedir_proveedor_sin_rampup" },
        { nombre: "factor_rampup_aplicado", valor: factorRampup, tipo: "metrica", ref: "factor_rampup_aplicado" },
      ],
    },

    pedir_proveedor_bultos: {
      valor: num(r.pedir_proveedor_bultos),
      unidad: "bultos",
      formula: "ceil(pedir_proveedor / inner_pack)",
      verificacion: {
        calculado: innerPack > 0 ? Math.ceil(pedirProveedor / innerPack) : pedirProveedor,
        motor: num(r.pedir_proveedor_bultos),
        match: Math.abs((innerPack > 0 ? Math.ceil(pedirProveedor / innerPack) : pedirProveedor) - num(r.pedir_proveedor_bultos)) <= 1,
      },
      inputs: [
        { nombre: "pedir_proveedor", valor: pedirProveedor, tipo: "metrica", ref: "pedir_proveedor" },
        { nombre: "inner_pack", valor: innerPack, tipo: "metrica", ref: "inner_pack" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §11 ALERTAS
    // ════════════════════════════════════════════════════════════════════

    alertas: {
      valor: Array.isArray(r.alertas) ? (r.alertas as string[]).join(", ") : (r.alertas as string),
      formula: "31 tipos posibles, ver §16 del doc maestro",
      codigo: "src/lib/intelligence.ts:2080-2115",
      inputs: [
        { nombre: "alertas_count", valor: num(r.alertas_count), tipo: "metrica" },
      ],
    },

    // ════════════════════════════════════════════════════════════════════
    // §12 PÉRDIDA
    // ════════════════════════════════════════════════════════════════════

    venta_perdida_uds: {
      valor: num(r.venta_perdida_uds),
      unidad: "uds",
      formula: "vel_ponderada × dias_sin_stock_full / 7",
      inputs: [
        { nombre: "vel_ponderada", valor: velPonderada, tipo: "metrica", ref: "vel_ponderada" },
        { nombre: "dias_sin_stock_full", valor: num(r.dias_sin_stock_full), tipo: "metrica", ref: "dias_sin_stock_full" },
      ],
    },

    venta_perdida_pesos: {
      valor: num(r.venta_perdida_pesos),
      unidad: "CLP",
      formula: "venta_perdida_uds × margen_unitario (cascada margen_full_30d → _60d → precio_promedio × 0.25)",
      codigo: "src/lib/intelligence.ts:1367-1385",
      nota: r.oportunidad_perdida_es_estimacion ? "Calculado con fallback (precio × 0.25)." : "Calculado con margen real.",
      inputs: [
        { nombre: "venta_perdida_uds", valor: num(r.venta_perdida_uds), tipo: "metrica", ref: "venta_perdida_uds" },
        { nombre: "margen_full_30d", valor: margenFull30d, tipo: "metrica" },
      ],
    },
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sku_origen: string }> },
) {
  const { sku_origen } = await params;
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "Sin conexion a Supabase" }, { status: 500 });

  const { data: intel, error } = await sb
    .from("sku_intelligence")
    .select("*")
    .eq("sku_origen", sku_origen)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!intel) return NextResponse.json({ error: "SKU no encontrado" }, { status: 404 });

  const metricas = explicarMetricas(intel as IntelRow);

  // Stats de verificacion
  let totalVerificadas = 0;
  let matchOk = 0;
  const discrepancias: { metrica: string; calculado: number; motor: number; delta: number }[] = [];
  for (const [nombre, m] of Object.entries(metricas)) {
    if (m.verificacion) {
      totalVerificadas++;
      if (m.verificacion.match) matchOk++;
      else discrepancias.push({
        metrica: nombre,
        calculado: m.verificacion.calculado,
        motor: m.verificacion.motor,
        delta: m.verificacion.delta || 0,
      });
    }
  }

  return NextResponse.json({
    sku_origen,
    calculado_at: intel.updated_at,
    verificacion_summary: {
      total_metricas_verificables: totalVerificadas,
      match_ok: matchOk,
      discrepancias,
    },
    metricas,
    docs: {
      maestro: "/docs/policies/inventario-formulas.md",
      policies: "/docs/policies/inventario.md",
      manual: "/docs/manuales/inventarios/",
    },
  });
}
