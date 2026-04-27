import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  queryStockPorSku,
  queryComposicion,
  queryProductos,
  queryOrdenes,
  queryEventosActivos,
  queryConteos,
  queryMovimientos,
  queryStockFullCache,
  queryStockSnapshots,
  queryOrdenesCompraActivas,
  upsertSkuIntelligence,
  insertHistorySnapshots,
  upsertStockSnapshots,
  queryPrevIntelligence,
  queryStockFullDetail,
  queryVelObjetivos,
  queryIntelConfig,
  queryProveedorCatalogo,
  queryEnviosFullPendientes,
  queryMargenPorSku,
  queryProveedores,
  queryPrimeraVentaPorSkuOrigen,
  queryFlagEstacional,
  type SkuIntelligenceUpsert,
} from "@/lib/intelligence-queries";
import {
  recalcularTodo,
  generarHistoryRows,
  generarStockSnapshots,
  DEFAULT_INTEL_CONFIG,
} from "@/lib/intelligence";
import type { SkuIntelRow, OrdenInput, QuiebreSnapshot } from "@/lib/intelligence";
import { ultimasMetricasAccuracy, type MetricaActual } from "@/lib/forecast-accuracy-queries";

/**
 * POST /api/intelligence/recalcular
 *
 * Body: { skus?: string[], full?: boolean, snapshot?: boolean }
 * - full=true: recalcula todos los SKUs
 * - skus: recalcula solo esos SKUs
 * - sin params: recalcula SKUs con movimientos desde último recálculo
 * - snapshot=true: además guarda history + stock_snapshots (usado por cron diario)
 *
 * GET /api/intelligence/recalcular?full=true&snapshot=true
 * Usado por Vercel crons (GET con query params). Equivalente al POST.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const full = url.searchParams.get("full") === "true";
  const snapshot = url.searchParams.get("snapshot") === "true";
  const skusParam = url.searchParams.get("skus");
  const debugSku = url.searchParams.get("debug_sku") || undefined;
  const skus = skusParam ? skusParam.split(",").map(s => s.trim()).filter(Boolean) : undefined;
  return ejecutarRecalculo({ skus, full, snapshot, debugSku });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return ejecutarRecalculo({
    skus: body.skus,
    full: body.full === true,
    snapshot: body.snapshot === true,
    debugSku: body.debug_sku,
  });
}

/**
 * Telemetría a ml_sync_health.intelligence_recalcular. Llamar en TODOS los return paths
 * del cron (success o error). Lección P1.1: el "queue empty / sin trabajo" también
 * cuenta como éxito (cron corrió, no había nada que recalcular).
 */
async function reportHealth(ok: boolean, errMsg?: string): Promise<void> {
  const sb = getServerSupabase();
  if (!sb) return;
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { last_attempt_at: now };
  if (ok) {
    updates.last_success_at = now;
    updates.last_error = null;
    updates.consecutive_failures = 0;
  } else {
    updates.last_error = (errMsg ?? "unknown").slice(0, 500);
  }
  await sb.from("ml_sync_health").update(updates).eq("job_name", "intelligence_recalcular");
}

async function ejecutarRecalculo(params: { skus?: string[]; full: boolean; snapshot: boolean; debugSku?: string }) {
  const start = Date.now();
  try {
    const skusFilter = params.skus;
    const full = params.full;
    const doSnapshot = params.snapshot;
    const debugSku = params.debugSku;

    const sb = getServerSupabase();
    if (!sb) {
      await reportHealth(false, "Sin conexión a Supabase");
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    console.log(`[intelligence] Iniciando recálculo. full=${full}, skus=${skusFilter?.length || "todos"}, snapshot=${doSnapshot}`);

    // ── Fetch todas las fuentes de datos en paralelo ──
    const [
      stockBodega,
      composicion,
      productos,
      ordenes,
      stockFullCache,
      snapshots,
      ocLineas,
      conteos,
      movimientos,
      prevIntelligence,
      stockFullDetail,
      proveedorCatalogo,
    ] = await Promise.all([
      queryStockPorSku(),
      queryComposicion(),
      queryProductos(),
      queryOrdenes(60),
      queryStockFullCache(),
      queryStockSnapshots(60),
      queryOrdenesCompraActivas(),
      queryConteos(3),
      queryMovimientos(60),
      queryPrevIntelligence(),
      queryStockFullDetail(),
      queryProveedorCatalogo(),
    ]);

    // Fetch vel_objetivo, config, margen y proveedores LT
    const [velObjetivos, intelConfig, ventasMlAgregado, proveedoresLT] = await Promise.all([
      queryVelObjetivos(),
      queryIntelConfig(),
      queryMargenPorSku(30),
      queryProveedores(),  // Fase B: lead times por proveedor
    ]);

    // Eventos activos para hoy
    const hoy = new Date();
    const hoyStr = hoy.toISOString().slice(0, 10);
    const eventosActivos = await queryEventosActivos(hoyStr);

    // PR2/3 — forecast accuracy. Falla silenciosa: si la tabla no existe o la
    // query se cae, el motor sigue sin las 3 alertas nuevas.
    let metricasAccuracy: Map<string, MetricaActual> = new Map();
    try {
      metricasAccuracy = await ultimasMetricasAccuracy(sb, 8);
    } catch (err) {
      console.warn(
        "[intelligence] forecast_accuracy no disponible, continúo sin alertas de forecast:",
        err instanceof Error ? err.message : err,
      );
    }

    // PR3 Fase A — primera venta por sku_origen (puerta TSB "edad mínima 60d").
    // Query separada porque el motor sólo trae 60d de órdenes; para saber la
    // edad real del SKU necesitamos MIN sobre toda la historia de ventas_ml_cache.
    let primeraVentaPorSkuOrigen: Map<string, Date> = new Map();
    try {
      primeraVentaPorSkuOrigen = await queryPrimeraVentaPorSkuOrigen();
    } catch (err) {
      console.warn(
        "[intelligence] primera_venta no disponible, TSB queda en sma_ponderado por default:",
        err instanceof Error ? err.message : err,
      );
    }

    // PR4 Fase 1 — SKUs marcados manualmente como estacionales. Falla silenciosa:
    // si la columna no existe (v54 no aplicada) o la query se cae, ningún SKU
    // queda marcado y el motor sigue con el régimen TSB pre-PR4.
    let skusEstacionales: Set<string> = new Set();
    try {
      skusEstacionales = await queryFlagEstacional();
    } catch (err) {
      console.warn(
        "[intelligence] es_estacional no disponible (¿v54 sin aplicar?), TSB corre sin exclusión por estacionalidad:",
        err instanceof Error ? err.message : err,
      );
    }

    // ── Stock en tránsito desde órdenes de compra ──
    const stockEnTransito = new Map<string, number>();
    const ocPendientesPorSku = new Map<string, number>();
    for (const linea of ocLineas) {
      const pendiente = (linea.cantidad_pedida || 0) - (linea.cantidad_recibida || 0);
      if (pendiente > 0) {
        stockEnTransito.set(
          linea.sku_origen,
          (stockEnTransito.get(linea.sku_origen) || 0) + pendiente,
        );
        ocPendientesPorSku.set(
          linea.sku_origen,
          (ocPendientesPorSku.get(linea.sku_origen) || 0) + 1,
        );
      }
    }

    // ── Envíos a Full PENDIENTES (ABIERTA / EN_PROCESO) cuentan como en tránsito ──
    // Estas unidades están reservadas en bodega y van a entrar a Full pronto.
    // Si NO se cuentan, "Pedido a Proveedor" sobreestima cuánto pedir, porque no
    // ve que ya hay N uds en camino a Full. Sólo se cuentan componentes
    // PENDIENTES (los PICKEADOS ya liberaron su reserva al confirmar).
    // Las sesiones COMPLETADAS NO se incluyen porque su stock ya bajó de bodega
    // y entran en limbo entre bodega y ML — contarlas inflaría el proyectado
    // hasta que ML reciba (puede tardar días).
    const enviosFullPendientes = await queryEnviosFullPendientes();
    enviosFullPendientes.forEach((uds, sku) => {
      stockEnTransito.set(sku, (stockEnTransito.get(sku) || 0) + uds);
    });

    // ── Inferir quiebres de Full desde orders_history ──
    // Si un SKU con vel_30d > 1 tiene 3+ días consecutivos con 0 ventas Full
    // rodeados de días con ventas, marcar como quiebre retroactivo.
    const quiebresInferidos = inferirQuiebresDeOrdenes(ordenes, hoy);

    // Combinar quiebres de snapshots + inferidos
    // Solo snapshots reales se marcan como explícitos — los inferidos son heurísticos
    const quiebresCombinados: QuiebreSnapshot[] = [
      ...snapshots.map(s => ({
        fecha: s.fecha,
        sku_origen: s.sku_origen,
        en_quiebre_full: s.en_quiebre_full,
        en_quiebre_flex: s.en_quiebre_flex ?? false,
        explicito: true as const,
      })),
      ...quiebresInferidos.map(q => ({
        ...q,
        explicito: false as const,
      })),
    ];

    // ── Ejecutar recálculo completo ──
    const { rows: resultados, debugLog } = recalcularTodo({
      productos,
      composicion,
      ordenes: ordenes as OrdenInput[],
      stockBodega,
      stockFull: stockFullCache,
      stockFullDetail,
      eventosActivos: eventosActivos.map(e => ({
        nombre: e.nombre,
        multiplicador: e.multiplicador,
        categorias: e.categorias || [],
      })),
      quiebres: quiebresCombinados,
      conteos: conteos.map(c => ({
        lineas: (c.lineas || []) as { sku?: string; diferencia?: number }[],
        created_at: c.created_at,
      })),
      movimientos: movimientos.map(m => ({
        sku: m.sku,
        created_at: m.created_at,
      })),
      stockEnTransito,
      ocPendientesPorSku,
      prevIntelligence,
      velObjetivos,
      proveedorCatalogo,
      margenPorSku: ventasMlAgregado.margen,
      unidadesPorSku: ventasMlAgregado.unidades,
      proveedoresLT,
      metricasAccuracy,
      primeraVentaPorSkuOrigen,
      skusEstacionales,
      config: {
        ...DEFAULT_INTEL_CONFIG,
        targetDiasA: intelConfig.target_dias_a,
        targetDiasB: intelConfig.target_dias_b,
        targetDiasC: intelConfig.target_dias_c,
      },
      hoy,
      debugSku,
    });

    // ── Filtrar si no es full ──
    let rowsToUpsert = resultados;
    if (!full && skusFilter && skusFilter.length > 0) {
      const filterSet = new Set(skusFilter.map(s => s.toUpperCase()));
      rowsToUpsert = resultados.filter(r => filterSet.has(r.sku_origen.toUpperCase()));
    } else if (!full && !skusFilter) {
      // Recalcular solo SKUs con movimientos recientes (últimos 7 días)
      const skusConMov = new Set<string>();
      for (const m of movimientos) {
        const diffDias = (hoy.getTime() - new Date(m.created_at).getTime()) / 86400000;
        if (diffDias <= 7) skusConMov.add(m.sku);
      }
      if (skusConMov.size > 0) {
        rowsToUpsert = resultados.filter(r => skusConMov.has(r.sku_origen));
      }
      // Si no hay movimientos recientes, no recalcular nada
      if (skusConMov.size === 0) {
        await reportHealth(true);
        return NextResponse.json({
          ok: true,
          recalculados: 0,
          tiempo_ms: Date.now() - start,
          mensaje: "Sin movimientos recientes, nada que recalcular",
        });
      }
    }

    // ── Upsert a sku_intelligence ──
    const upsertRows = rowsToUpsert.map(rowToUpsert);
    const total = await upsertSkuIntelligence(upsertRows);

    // ── Snapshot diario (si se pide) ──
    let snapshotCount = 0;
    let historyCount = 0;
    if (doSnapshot) {
      // History snapshot
      const historyRows = generarHistoryRows(resultados, hoyStr);
      historyCount = await insertHistorySnapshots(historyRows);

      // Stock snapshots (registro de quiebres)
      const stockSnaps = generarStockSnapshots(resultados, hoyStr);
      await upsertStockSnapshots(stockSnaps);
      snapshotCount = stockSnaps.length;
    }

    // Resumen de alertas
    const alertasResumen: Record<string, number> = {};
    for (const r of rowsToUpsert) {
      for (const a of r.alertas) {
        alertasResumen[a] = (alertasResumen[a] || 0) + 1;
      }
    }

    const tiempo = Date.now() - start;
    console.log(`[intelligence] Recálculo completado. ${total} SKUs en ${tiempo}ms.`);

    await reportHealth(true);
    return NextResponse.json({
      ok: true,
      recalculados: total,
      total_skus_evaluados: resultados.length,
      tiempo_ms: tiempo,
      snapshot: doSnapshot ? { history: historyCount, stock_snapshots: snapshotCount } : null,
      alertas: alertasResumen,
      resumen: {
        urgentes: rowsToUpsert.filter(r => r.accion === "URGENTE").length,
        agotados: rowsToUpsert.filter(r => r.accion === "AGOTADO_PEDIR").length,
        mandar_full: rowsToUpsert.filter(r => r.accion === "MANDAR_FULL").length,
        en_transito: rowsToUpsert.filter(r => r.accion === "EN_TRANSITO").length,
        nuevos: rowsToUpsert.filter(r => r.accion === "NUEVO").length,
        dead_stock: rowsToUpsert.filter(r => r.accion === "DEAD_STOCK").length,
        liquidar: rowsToUpsert.filter(r => r.liquidacion_accion !== null).length,
      },
      ...(debugLog ? { debug: debugLog } : {}),
    });
  } catch (err) {
    console.error("[intelligence] Error en recálculo:", err);
    await reportHealth(false, String(err));
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

/**
 * Infiere quiebres de Full desde orders_history.
 * Si un SKU con vel_30d > 1 uds/sem tiene 3+ días consecutivos con 0 ventas Full
 * rodeados de días con ventas, es un quiebre.
 */
function inferirQuiebresDeOrdenes(
  ordenes: { sku_venta: string; cantidad: number; canal: string; fecha: string }[],
  hoy: Date,
): QuiebreSnapshot[] {
  // Solo órdenes Full de los últimos 60 días
  const hace60d = hoy.getTime() - 60 * 86400000;
  const ordsFull = ordenes.filter(o =>
    o.canal === "Full" && new Date(o.fecha).getTime() >= hace60d,
  );

  // Agrupar por SKU → por día
  const porSku = new Map<string, Map<string, number>>();
  for (const o of ordsFull) {
    const dia = o.fecha.slice(0, 10);
    if (!porSku.has(o.sku_venta)) porSku.set(o.sku_venta, new Map());
    const dias = porSku.get(o.sku_venta)!;
    dias.set(dia, (dias.get(dia) || 0) + o.cantidad);
  }

  const quiebres: QuiebreSnapshot[] = [];

  porSku.forEach((diasMap, skuVenta) => {
    // Calcular vel_30d aproximada
    const totalQty = Array.from(diasMap.values()).reduce((s, v) => s + v, 0);
    const vel30d = totalQty / 4.3;
    if (vel30d < 1) return; // No aplica a SKUs lentos

    // Generar array de todos los días del rango
    const diasOrdenados = Array.from(diasMap.keys()).sort();
    if (diasOrdenados.length < 2) return;

    const primerDia = new Date(diasOrdenados[0]);
    const ultimoDia = new Date(diasOrdenados[diasOrdenados.length - 1]);

    // Iterar día a día buscando gaps de 3+
    let gapCount = 0;
    const cursor = new Date(primerDia);
    while (cursor <= ultimoDia) {
      const diaStr = cursor.toISOString().slice(0, 10);
      if (!diasMap.has(diaStr)) {
        gapCount++;
      } else {
        // Si venimos de un gap de 3+ días, marcar esos días como quiebre
        if (gapCount >= 3) {
          for (let g = gapCount; g >= 1; g--) {
            const fechaQuiebre = new Date(cursor);
            fechaQuiebre.setDate(fechaQuiebre.getDate() - g);
            quiebres.push({
              fecha: fechaQuiebre.toISOString().slice(0, 10),
              sku_origen: skuVenta, // Se mapea a origen después si es necesario
              en_quiebre_full: true,
            });
          }
        }
        gapCount = 0;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return quiebres;
}

/** Convierte SkuIntelRow a formato de upsert para Supabase */
function rowToUpsert(r: SkuIntelRow): SkuIntelligenceUpsert {
  return {
    sku_origen: r.sku_origen,
    nombre: r.nombre,
    categoria: r.categoria,
    proveedor: r.proveedor,
    skus_venta: r.skus_venta,
    vel_7d: r.vel_7d,
    vel_30d: r.vel_30d,
    vel_60d: r.vel_60d,
    vel_ponderada: r.vel_ponderada,
    vel_full: r.vel_full,
    vel_flex: r.vel_flex,
    vel_total: r.vel_total,
    pct_full: r.pct_full,
    pct_flex: r.pct_flex,
    tendencia_vel: r.tendencia_vel,
    tendencia_vel_pct: r.tendencia_vel_pct,
    es_pico: r.es_pico,
    pico_magnitud: r.pico_magnitud,
    multiplicador_evento: r.multiplicador_evento,
    evento_activo: r.evento_activo,
    vel_ajustada_evento: r.vel_ajustada_evento,
    stock_full: r.stock_full,
    stock_bodega: r.stock_bodega,
    stock_total: r.stock_total,
    stock_sin_etiquetar: r.stock_sin_etiquetar,
    stock_proveedor: r.stock_proveedor,
    tiene_stock_prov: r.tiene_stock_prov,
    inner_pack: r.inner_pack,
    stock_en_transito: r.stock_en_transito,
    stock_proyectado: r.stock_proyectado,
    oc_pendientes: r.oc_pendientes,
    cob_full: r.cob_full,
    cob_flex: r.cob_flex,
    cob_total: r.cob_total,
    target_dias_full: r.target_dias_full,
    margen_full_7d: r.margen_full_7d,
    margen_full_30d: r.margen_full_30d,
    margen_full_60d: r.margen_full_60d,
    margen_flex_7d: r.margen_flex_7d,
    margen_flex_30d: r.margen_flex_30d,
    margen_flex_60d: r.margen_flex_60d,
    margen_tendencia_full: r.margen_tendencia_full,
    margen_tendencia_flex: r.margen_tendencia_flex,
    canal_mas_rentable: r.canal_mas_rentable,
    precio_promedio: r.precio_promedio,
    abc: r.abc,
    abc_margen: r.abc_margen,
    abc_ingreso: r.abc_ingreso,
    abc_unidades: r.abc_unidades,
    ingreso_30d: r.ingreso_30d,
    pct_ingreso_acumulado: r.pct_ingreso_acumulado,
    margen_neto_30d: r.margen_neto_30d,
    pct_margen_acumulado: r.pct_margen_acumulado,
    uds_30d: r.uds_30d,
    pct_unidades_acumulado: r.pct_unidades_acumulado,
    cv: r.cv,
    xyz: r.xyz,
    desviacion_std: r.desviacion_std,
    cuadrante: r.cuadrante,
    gmroi: r.gmroi,
    dio: r.dio,
    costo_neto: r.costo_neto,
    costo_bruto: r.costo_bruto,
    costo_fuente: r.costo_fuente,
    costo_inventario_total: r.costo_inventario_total,
    stock_seguridad: r.stock_seguridad,
    punto_reorden: r.punto_reorden,
    nivel_servicio: r.nivel_servicio,
    // Fase B reposición
    lead_time_real_dias: r.lead_time_real_dias,
    lead_time_real_sigma: r.lead_time_real_sigma,
    lead_time_usado_dias: r.lead_time_usado_dias,
    lead_time_fuente: r.lead_time_fuente,
    lt_muestras: r.lt_muestras,
    safety_stock_simple: r.safety_stock_simple,
    safety_stock_completo: r.safety_stock_completo,
    safety_stock_fuente: r.safety_stock_fuente,
    rop_calculado: r.rop_calculado,
    necesita_pedir: r.necesita_pedir,
    dias_sin_stock_full: r.dias_sin_stock_full,
    semanas_con_quiebre: r.semanas_con_quiebre,
    venta_perdida_uds: r.venta_perdida_uds,
    venta_perdida_pesos: r.venta_perdida_pesos,
    oportunidad_perdida_es_estimacion: r.oportunidad_perdida_es_estimacion,
    ingreso_perdido: r.ingreso_perdido,
    accion: r.accion,
    prioridad: r.prioridad,
    mandar_full: r.mandar_full,
    pedir_proveedor: r.pedir_proveedor,
    pedir_proveedor_bultos: r.pedir_proveedor_bultos,
    pedir_proveedor_sin_rampup: r.pedir_proveedor_sin_rampup,
    factor_rampup_aplicado: r.factor_rampup_aplicado,
    rampup_motivo: r.rampup_motivo,
    requiere_ajuste_precio: r.requiere_ajuste_precio,
    liquidacion_accion: r.liquidacion_accion,
    liquidacion_dias_extra: r.liquidacion_dias_extra,
    liquidacion_descuento_sugerido: r.liquidacion_descuento_sugerido,
    ultimo_conteo: r.ultimo_conteo,
    dias_sin_conteo: r.dias_sin_conteo,
    diferencias_conteo: r.diferencias_conteo,
    ultimo_movimiento: r.ultimo_movimiento,
    dias_sin_movimiento: r.dias_sin_movimiento,
    alertas: r.alertas,
    alertas_count: r.alertas_count,
    vel_pre_quiebre: r.vel_pre_quiebre,
    margen_unitario_pre_quiebre: r.margen_unitario_pre_quiebre,
    dias_en_quiebre: r.dias_en_quiebre,
    fecha_entrada_quiebre: r.fecha_entrada_quiebre,
    es_quiebre_proveedor: r.es_quiebre_proveedor,
    abc_pre_quiebre: r.abc_pre_quiebre,
    gmroi_potencial: r.gmroi_potencial,
    es_catch_up: r.es_catch_up,
    // v60 — Quiebre Flex
    dias_en_quiebre_flex: r.dias_en_quiebre_flex,
    fecha_entrada_quiebre_flex: r.fecha_entrada_quiebre_flex,
    vel_flex_pre_quiebre: r.vel_flex_pre_quiebre,
    vel_objetivo: r.vel_objetivo,
    gap_vel_pct: r.gap_vel_pct,
    // PR2/3 — forecast accuracy (8s)
    forecast_wmape_8s: r.forecast_wmape_8s,
    forecast_bias_8s: r.forecast_bias_8s,
    forecast_tracking_signal_8s: r.forecast_tracking_signal_8s,
    forecast_semanas_evaluadas_8s: r.forecast_semanas_evaluadas_8s,
    forecast_es_confiable_8s: r.forecast_es_confiable_8s,
    forecast_calculado_at: r.forecast_calculado_at,
    // PR3 Fase A — TSB shadow
    vel_ponderada_tsb: r.vel_ponderada_tsb,
    tsb_alpha: r.tsb_alpha,
    tsb_beta: r.tsb_beta,
    tsb_modelo_usado: r.tsb_modelo_usado,
    primera_venta: r.primera_venta,
    dias_desde_primera_venta: r.dias_desde_primera_venta,
    updated_at: r.updated_at,
    datos_desde: r.datos_desde,
    datos_hasta: r.datos_hasta,
  };
}
