import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { calcularMargen } from "@/lib/reposicion";
import type { FinancialAgg } from "@/lib/reposicion";

/**
 * GET /api/intelligence/sku-venta-v2
 *
 * Sprint 5 — clon de /api/intelligence/sku-venta pero leyendo del motor
 * nuevo (v_reposicion_explain). Mismo response shape que v1 para que el
 * componente AdminInteligencia.tsx no tenga que ramificar.
 *
 * Frontera: campos motor-nuevo (vel, stock, target, qty_a_comprar,
 * pre_full_target, etc.) vienen de v_reposicion_explain. Campos caso C
 * (abc, xyz, cuadrante, accion, alertas, prioridad, márgenes, vel_objetivo,
 * etc.) siguen viniendo de sku_intelligence en parallel-fetch — la frontera
 * permite leer sku_intelligence; lo que prohíbe es escrituras cruzadas.
 *
 * Doc: docs/policies/frontera-reposicion-pricing.md
 *      docs/discovery/inteligencia-migration-2026-05-04.md
 */

/** Paginar queries de Supabase (máx 1000 filas por request) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginate(queryFn: () => any): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let off = 0;
  while (true) {
    const { data } = await queryFn().range(off, off + 999);
    if (!data || data.length === 0) break;
    result.push(...data);
    if (data.length < 1000) break;
    off += 1000;
  }
  return result;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  return 0;
};

export async function GET(request: Request) {
  const start = Date.now();
  const url = new URL(request.url);
  const debugSku = url.searchParams.get("debug")?.toUpperCase() || null;

  try {
    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    const fechaDesde = new Date(Date.now() - 60 * 86400000).toISOString();

    // ── Fetch paralelo: motor nuevo + caso C campos + composición + ventas + costos ──
    const [explainRows, casoCRows, composicion, cacheRows, ordenes, productosRows] = await Promise.all([
      // Sprint 8.5 — Query A canónica del motor nuevo. Aliases mandar_full
      // y prioridad al shape v1 que consume el response.
      paginate(() => sb.from("v_reposicion_explain").select(
        "sku_origen, nombre, categoria, proveedor_nombre, cell, cell_original, cell_efectiva, " +
        "policy_action, target_dias_template, target_dias_flex, " +
        "vel_decl_sem, vel_7d_decl, vel_30d_decl, vel_60d_decl, " +
        "stock_bodega, stock_full, stock_total, in_transit_bodega, in_transit_picking_full, " +
        "cycle_stock, safety_stock, reorder_point, pre_full_target, reserva_flex_target, " +
        "qty_a_comprar, clp_estimado, dias_cobertura_actual, bajo_rop, " +
        "es_quiebre_proveedor, vel_pre_quiebre, dias_en_quiebre, fecha_entrada_quiebre, " +
        "factor_rampup_aplicado, rampup_motivo, evento_activo, multiplicador_evento, " +
        "mandar_full:mandar_full_uds, accion, prioridad:prioridad_nueva, " +
        "liquidacion_accion, liquidacion_descuento_sugerido, dio, " +
        "alertas, alertas_count, is_new_sku, inner_pack, d_avg_sem, " +
        "deficit_full, disponible_para_full, " +
        "tendencia, promocion_activa, promocion_motivo, alerta_operativa, " +
        "sku_intelligence_updated_at"
      )),
      paginate(() => sb.from("sku_intelligence").select(
        "sku_origen, abc, xyz, cuadrante, " +
        "abc_pre_quiebre, gmroi, vel_objetivo, gap_vel_pct, " +
        "venta_perdida_pesos, oportunidad_perdida_es_estimacion, " +
        "es_catch_up, updated_at"
      )),
      paginate(() => sb.from("composicion_venta").select("sku_venta, sku_origen, unidades, tipo_relacion")),
      paginate(() => sb.from("stock_full_cache").select("sku_venta, cantidad")),
      paginate(() => sb.from("orders_history")
        .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
        .eq("estado", "Pagada")
        .gte("fecha", fechaDesde)
        .order("fecha", { ascending: false })),
      paginate(() => sb.from("productos").select("sku, costo, costo_promedio")),
    ]) as [
      Record<string, unknown>[],
      Record<string, unknown>[],
      { sku_venta: string; sku_origen: string; unidades: number; tipo_relacion?: string }[],
      { sku_venta: string; cantidad: number }[],
      { sku_venta: string; cantidad: number; canal: string; fecha: string; subtotal: number; comision_total: number; costo_envio: number; ingreso_envio: number; total: number }[],
      { sku: string; costo: number; costo_promedio: number | null }[]
    ];

    const debugLog: string[] = [];
    const isDebug = (sku: string) => debugSku && (sku.includes(debugSku) || debugSku.includes(sku));
    if (debugSku) {
      debugLog.push(`=== DEBUG v2 para SKU: ${debugSku} ===`);
      debugLog.push(`v_reposicion_explain rows: ${explainRows.length}`);
      debugLog.push(`sku_intelligence (caso C) rows: ${casoCRows.length}`);
      debugLog.push(`composicion: ${composicion.length}, orders: ${ordenes.length}, cache: ${cacheRows.length}`);
    }

    // ── Maps de lookup ──
    // Merge: explainRow + casoCRow ambos por sku_origen UPPER.
    const casoCMap = new Map<string, Record<string, unknown>>();
    for (const r of casoCRows) {
      const key = (r.sku_origen as string).toUpperCase();
      casoCMap.set(key, r);
    }

    const intelMap = new Map<string, Record<string, unknown>>();
    for (const r of explainRows) {
      const key = (r.sku_origen as string).toUpperCase();
      const casoC = casoCMap.get(key) || {};
      // Merge: campos motor nuevo + campos caso C. Renames: vel_decl_sem→vel_ponderada,
      // target_dias_template→target_dias_full, in_transit_bodega→stock_en_transito,
      // safety_stock→stock_seguridad, reorder_point→punto_reorden, qty_a_comprar→pedir_proveedor.
      intelMap.set(key, {
        ...r,
        ...casoC,
        // renames para compatibilidad shape v1
        vel_ponderada: r.vel_decl_sem,
        vel_7d: r.vel_7d_decl,
        vel_30d: r.vel_30d_decl,
        vel_60d: r.vel_60d_decl,
        target_dias_full: r.target_dias_template,
        stock_en_transito: r.in_transit_bodega,
        stock_seguridad: r.safety_stock,
        punto_reorden: r.reorder_point,
        pedir_proveedor: r.qty_a_comprar,
        proveedor: r.proveedor_nombre,
        updated_at: r.sku_intelligence_updated_at || casoC.updated_at,
      });
    }

    const stockFullMap = new Map<string, number>();
    for (const r of cacheRows) stockFullMap.set(r.sku_venta.toUpperCase(), r.cantidad || 0);

    const productoCostos = new Map<string, number>();
    for (const p of productosRows) productoCostos.set(p.sku.toUpperCase(), (p.costo_promedio || 0) || (p.costo || 0));

    // ── Órdenes agrupadas por SKU Venta (UPPER) — idéntico a v1 ──
    const hoyMs = Date.now();
    const ordenesPorSV = new Map<string, typeof ordenes>();
    for (const o of ordenes) {
      const svUp = o.sku_venta.toUpperCase();
      if (!ordenesPorSV.has(svUp)) ordenesPorSV.set(svUp, []);
      ordenesPorSV.get(svUp)!.push(o);
    }

    // ── Composición: SKU Origen → formatos de venta ──
    const allSkusVentaComp = new Set<string>();
    const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();
    for (const c of composicion) {
      if (c.tipo_relacion === "alternativo") continue;
      const svUp = c.sku_venta.toUpperCase();
      const soUp = c.sku_origen.toUpperCase();
      allSkusVentaComp.add(svUp);
      if (!ventasPorOrigen.has(soUp)) ventasPorOrigen.set(soUp, []);
      const arr = ventasPorOrigen.get(soUp)!;
      if (!arr.some(e => e.skuVenta === svUp)) {
        arr.push({ skuVenta: svUp, unidades: c.unidades });
      }
    }

    // ── Reasignar órdenes huérfanas — mismo criterio que v1 ──
    for (const svUp of Array.from(ordenesPorSV.keys())) {
      if (allSkusVentaComp.has(svUp)) continue;
      const formatos = ventasPorOrigen.get(svUp);
      if (!formatos || formatos.length === 0) continue;
      const individual = formatos.find(f => f.unidades === 1);
      if (!individual) continue;
      const target = individual.skuVenta;
      if (!ordenesPorSV.has(target)) ordenesPorSV.set(target, []);
      ordenesPorSV.get(target)!.push(...(ordenesPorSV.get(svUp) || []));
      ordenesPorSV.delete(svUp);
    }

    // ── Auto-detect alternativas ──
    const compsPorSV = new Map<string, { soUp: string; unidades: number }[]>();
    for (const c of composicion) {
      if (c.tipo_relacion === "alternativo") continue;
      const svUp = c.sku_venta.toUpperCase();
      if (!compsPorSV.has(svUp)) compsPorSV.set(svUp, []);
      compsPorSV.get(svUp)!.push({ soUp: c.sku_origen.toUpperCase(), unidades: c.unidades });
    }
    const alternativoSkipSet = new Set<string>();
    for (const [, comps] of Array.from(compsPorSV.entries())) {
      if (comps.length < 2) continue;
      const principal = comps[0];
      for (const c of comps.slice(1)) {
        if (c.unidades === principal.unidades) alternativoSkipSet.add(c.soUp);
      }
    }

    const ventasCountPorOrigen = new Map<string, number>();
    ventasPorOrigen.forEach((ventas, soUp) => {
      ventasCountPorOrigen.set(soUp, ventas.length);
    });

    // ── Pre-computar unidades físicas 30d por origen ──
    const fisicasPorOrigen = new Map<string, number>();
    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      let total = 0;
      for (const { skuVenta, unidades } of ventas) {
        const ords = ordenesPorSV.get(skuVenta) || [];
        for (const o of ords) {
          const diasAtras = (hoyMs - new Date(o.fecha).getTime()) / 86400000;
          if (diasAtras <= 30) total += o.cantidad * unidades;
        }
      }
      fisicasPorOrigen.set(skuOrigen, total);
    });

    // ── Generar filas — idéntico a v1 pero usando intelMap merged ──
    const result: Record<string, unknown>[] = [];

    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      if (alternativoSkipSet.has(skuOrigen)) return;
      const intel = intelMap.get(skuOrigen);
      if (!intel) return;

      const velOrigenPonderada = num(intel.vel_ponderada);
      const totalFisicasOrigen = fisicasPorOrigen.get(skuOrigen) || 0;
      const costoNeto = productoCostos.get(skuOrigen) || 0;
      const costoBruto = costoNeto > 0 ? Math.round(costoNeto * 1.19) : 0;

      for (const { skuVenta, unidades } of ventas) {
        const stFull = stockFullMap.get(skuVenta) || 0;
        const ords = ordenesPorSV.get(skuVenta) || [];

        let fisicas7 = 0, fisicas30 = 0, fisicas60 = 0;
        let ingreso30 = 0;
        let precioSum = 0, precioCount = 0;
        const faFull: FinancialAgg = { totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0, totalIngresoEnvio: 0, totalCantidad: 0 };
        const faFlex: FinancialAgg = { totalSubtotal: 0, totalComision: 0, totalCostoEnvio: 0, totalIngresoEnvio: 0, totalCantidad: 0 };

        for (const o of ords) {
          const diasAtras = (hoyMs - new Date(o.fecha).getTime()) / 86400000;
          const udsFisicas = o.cantidad * unidades;
          if (diasAtras <= 7) fisicas7 += udsFisicas;
          if (diasAtras <= 30) {
            fisicas30 += udsFisicas;
            ingreso30 += o.total || 0;
            const fa = o.canal === "Full" ? faFull : faFlex;
            fa.totalSubtotal += o.subtotal || 0;
            fa.totalComision += o.comision_total || 0;
            fa.totalCostoEnvio += o.costo_envio || 0;
            fa.totalIngresoEnvio += o.ingreso_envio || 0;
            fa.totalCantidad += o.cantidad || 0;
            if (o.total > 0 && o.cantidad > 0) {
              precioSum += o.total;
              precioCount += o.cantidad;
            }
          }
          if (diasAtras <= 60) fisicas60 += udsFisicas;
        }

        const share = totalFisicasOrigen > 0
          ? fisicas30 / totalFisicasOrigen
          : (ventas.length === 1 ? 1 : 0);
        const velPonderada = velOrigenPonderada * share;

        const vel7d = fisicas7 / 1;
        const vel30d = fisicas30 / 4.3;
        const vel60d = fisicas60 / 8.6;

        const margenFull30d = calcularMargen(faFull, "full", costoBruto) ?? 0;
        const margenFlex30d = calcularMargen(faFlex, "flex", costoBruto) ?? 0;

        let pctFull: number;
        let pctFlex: number;
        if (margenFull30d > 0 && margenFlex30d > 0 && margenFlex30d / margenFull30d > 1.1) {
          pctFull = 0.70; pctFlex = 0.30;
        } else {
          pctFull = 0.80; pctFlex = 0.20;
        }
        const velFull = velPonderada * pctFull;
        const velFlex = velPonderada * pctFlex;

        const cobFull = velFull > 0 ? (stFull / velFull) * 7 : 999;
        const canalMasRentable = margenFull30d >= margenFlex30d ? "Full" : "Flex";
        const precioPromedio = precioCount > 0 ? precioSum / precioCount : 0;

        const compEntries = composicion.filter(c => c.sku_venta.toUpperCase() === skuVenta);
        const esPack = unidades > 1 || compEntries.length > 1;

        if (debugSku && (isDebug(skuVenta) || isDebug(skuOrigen))) {
          debugLog.push(`origen=${skuOrigen} sv=${skuVenta} velOrigen=${velOrigenPonderada.toFixed(2)} share=${share.toFixed(3)} qty_a_comprar=${num(intel.pedir_proveedor)} cell=${intel.cell ?? "—"} cell_efectiva=${intel.cell_efectiva ?? "—"} tendencia=${intel.tendencia ?? "—"}`);
        }

        result.push({
          sku_venta: skuVenta,
          sku_origen: skuOrigen,
          nombre: (intel.nombre as string) || null,
          unidades_por_pack: unidades,
          es_pack: esPack,
          abc: intel.abc,
          xyz: intel.xyz,
          cuadrante: intel.cuadrante,
          proveedor: intel.proveedor,
          alertas: intel.alertas || [],
          alertas_count: intel.alertas_count || 0,
          accion: intel.accion,
          prioridad: intel.prioridad,
          target_dias_full: intel.target_dias_full,
          stock_bodega: intel.stock_bodega,
          stock_bodega_compartido: (ventasCountPorOrigen.get(skuOrigen) || 1) > 1,
          stock_bodega_formatos: ventasCountPorOrigen.get(skuOrigen) || 1,
          stock_en_transito: intel.stock_en_transito,
          mandar_full: share > 0 ? Math.round(num(intel.mandar_full) * share) : 0,
          pedir_proveedor: share > 0 ? Math.round(num(intel.pedir_proveedor) * share) : 0,
          pedir_proveedor_sin_rampup: share > 0 ? Math.round(num(intel.pedir_proveedor_sin_rampup) * share) : 0,
          factor_rampup_aplicado: intel.factor_rampup_aplicado,
          rampup_motivo: intel.rampup_motivo,
          evento_activo: intel.evento_activo,
          dias_en_quiebre: intel.dias_en_quiebre,
          vel_pre_quiebre: intel.vel_pre_quiebre,
          es_quiebre_proveedor: intel.es_quiebre_proveedor,
          abc_pre_quiebre: intel.abc_pre_quiebre,
          es_catch_up: intel.es_catch_up,
          venta_perdida_pesos: intel.venta_perdida_pesos,
          oportunidad_perdida_es_estimacion: intel.oportunidad_perdida_es_estimacion ?? false,
          liquidacion_accion: intel.liquidacion_accion,
          // Sprint 8.5: motor nuevo guarda descuento como decimal 0..1; UI espera entero 0..100.
          liquidacion_descuento_sugerido: intel.liquidacion_descuento_sugerido != null
            ? Math.round(Number(intel.liquidacion_descuento_sugerido) * 100)
            : null,
          vel_objetivo: num(intel.vel_objetivo),
          gap_vel_pct: intel.gap_vel_pct ?? null,
          gmroi: num(intel.gmroi),
          dio: num(intel.dio),
          updated_at: intel.updated_at,
          stock_full: stFull,
          vel_7d: Math.round(vel7d * 100) / 100,
          vel_30d: Math.round(vel30d * 100) / 100,
          vel_60d: Math.round(vel60d * 100) / 100,
          vel_ponderada: Math.round(velPonderada * 100) / 100,
          vel_full: Math.round(velFull * 100) / 100,
          vel_flex: Math.round(velFlex * 100) / 100,
          pct_full: Math.round(pctFull * 1000) / 1000,
          pct_flex: Math.round(pctFlex * 1000) / 1000,
          cob_full: Math.round(cobFull * 10) / 10,
          margen_full_30d: Math.round(margenFull30d),
          margen_flex_30d: Math.round(margenFlex30d),
          ingreso_30d: Math.round(ingreso30),
          canal_mas_rentable: canalMasRentable,
          precio_promedio: Math.round(precioPromedio),
          ordenes_encontradas: ords.length,
          // ── Trazabilidad / campos exclusivos motor nuevo ──
          motor_fuente: "nuevo",
          cell: intel.cell,
          cell_efectiva: intel.cell_efectiva,
          cell_original: intel.cell_original,
          tendencia: intel.tendencia,
          promocion_activa: intel.promocion_activa,
          promocion_motivo: intel.promocion_motivo,
          pre_full_target: num(intel.pre_full_target),
          reserva_flex_target: num(intel.reserva_flex_target),
          bajo_rop: intel.bajo_rop,
          clp_estimado: num(intel.clp_estimado),
        });
      }
    });

    result.sort((a, b) => ((a.prioridad as number) || 99) - ((b.prioridad as number) || 99));

    const summary = {
      total_skus_venta: result.length,
      total_skus_origen_motor_nuevo: explainRows.length,
      total_caso_c: casoCRows.length,
      bajo_rop: result.filter(r => r.bajo_rop).length,
      sum_clp_estimado: result.reduce((acc, r) => acc + num(r.clp_estimado), 0),
    };

    const response: Record<string, unknown> = {
      ok: true,
      total: result.length,
      tiempo_ms: Date.now() - start,
      motor: "nuevo",
      summary,
      rows: result,
    };

    if (debugSku) {
      response.rows = result.filter(r =>
        (r.sku_venta as string).includes(debugSku) || (r.sku_origen as string).includes(debugSku)
      );
      response.total = (response.rows as unknown[]).length;
      response.debug = debugLog;
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error("[intelligence/sku-venta-v2] Error:", err);
    return NextResponse.json({ error: String(err), motor: "nuevo" }, { status: 500 });
  }
}
