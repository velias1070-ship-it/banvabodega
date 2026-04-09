import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { calcularMargen } from "@/lib/reposicion";
import type { FinancialAgg } from "@/lib/reposicion";

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

/**
 * GET /api/intelligence/sku-venta
 *
 * Genera filas a nivel SKU Venta consultando orders_history directamente
 * por cada sku_venta. Velocidad, margen, ingreso y stock son propios de
 * cada formato. ABC, XYZ, cuadrante, alertas, acción se heredan del
 * SKU Origen vía sku_intelligence.
 *
 * ?debug=SKU → devuelve info de diagnóstico para ese SKU
 */
export async function GET(request: Request) {
  const start = Date.now();
  const url = new URL(request.url);
  const debugSku = url.searchParams.get("debug")?.toUpperCase() || null;

  try {
    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // ── Fetch todo paginado en paralelo ──
    const fechaDesde = new Date(Date.now() - 60 * 86400000).toISOString();
    const [intelRows, composicion, cacheRows, ordenes, productosRows] = await Promise.all([
      paginate(() => sb.from("sku_intelligence")
        .select("sku_origen, nombre, categoria, proveedor, abc, xyz, cuadrante, accion, prioridad, alertas, alertas_count, target_dias_full, stock_bodega, stock_en_transito, mandar_full, pedir_proveedor, evento_activo, liquidacion_accion, dias_en_quiebre, vel_pre_quiebre, es_quiebre_proveedor, abc_pre_quiebre, es_catch_up, venta_perdida_pesos, oportunidad_perdida_es_estimacion, updated_at, vel_ponderada, stock_total, vel_objetivo, gap_vel_pct, gmroi, dio")
        .or("vel_ponderada.gt.0,stock_total.gt.0")),
      paginate(() => sb.from("composicion_venta").select("sku_venta, sku_origen, unidades, tipo_relacion")),
      paginate(() => sb.from("stock_full_cache").select("sku_venta, cantidad")),
      paginate(() => sb.from("orders_history")
        .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
        .eq("estado", "Pagada")
        .gte("fecha", fechaDesde)
        .order("fecha", { ascending: false })),
      paginate(() => sb.from("productos").select("sku, costo")),
    ]) as [Record<string, unknown>[], { sku_venta: string; sku_origen: string; unidades: number; tipo_relacion?: string }[], { sku_venta: string; cantidad: number }[], { sku_venta: string; cantidad: number; canal: string; fecha: string; subtotal: number; comision_total: number; costo_envio: number; ingreso_envio: number; total: number }[], { sku: string; costo: number }[]];

    // Debug log collector
    const debugLog: string[] = [];
    const isDebug = (sku: string) => debugSku && (sku.includes(debugSku) || debugSku.includes(sku));

    if (debugSku) {
      debugLog.push(`=== DEBUG para SKU: ${debugSku} ===`);
      debugLog.push(`Total órdenes cargadas: ${ordenes.length}`);
      debugLog.push(`Total composicion rows: ${composicion.length}`);
      debugLog.push(`Total intel rows: ${intelRows.length}`);
      debugLog.push(`Total cache rows: ${cacheRows.length}`);

      // Buscar en composición
      const compDebug = composicion.filter(c =>
        c.sku_venta.toUpperCase().includes(debugSku) || c.sku_origen.toUpperCase().includes(debugSku)
      );
      debugLog.push(`\n--- composicion_venta entries ---`);
      for (const c of compDebug) {
        debugLog.push(`  sku_venta="${c.sku_venta}" (UPPER="${c.sku_venta.toUpperCase()}"), sku_origen="${c.sku_origen}" (UPPER="${c.sku_origen.toUpperCase()}"), unidades=${c.unidades}`);
      }

      // Buscar en orders_history
      const ordDebug = ordenes.filter(o => o.sku_venta.toUpperCase().includes(debugSku));
      debugLog.push(`\n--- orders_history entries (matching) ---`);
      debugLog.push(`  Total matching: ${ordDebug.length}`);
      const bySkuVenta = new Map<string, number>();
      for (const o of ordDebug) {
        const key = o.sku_venta;
        bySkuVenta.set(key, (bySkuVenta.get(key) || 0) + 1);
      }
      bySkuVenta.forEach((count, sv) => {
        debugLog.push(`  "${sv}" (UPPER="${sv.toUpperCase()}"): ${count} órdenes`);
      });

      // Buscar en intel
      const intelDebug = intelRows.filter(r => (r.sku_origen as string).toUpperCase().includes(debugSku));
      debugLog.push(`\n--- sku_intelligence entries ---`);
      for (const r of intelDebug) {
        debugLog.push(`  sku_origen="${r.sku_origen}", vel_ponderada=${r.vel_ponderada}, stock_total=${r.stock_total}`);
      }
    }

    // ── Maps de lookup ──
    const intelMap = new Map<string, Record<string, unknown>>();
    for (const r of intelRows) {
      const key = (r.sku_origen as string).toUpperCase();
      intelMap.set(key, r);
    }

    const stockFullMap = new Map<string, number>();
    for (const r of cacheRows) stockFullMap.set(r.sku_venta.toUpperCase(), r.cantidad || 0);

    const productoCostos = new Map<string, number>();
    for (const p of productosRows) productoCostos.set(p.sku.toUpperCase(), p.costo || 0);

    // ── Órdenes agrupadas por SKU Venta (UPPER) ──
    const hoyMs = Date.now();
    const ordenesPorSV = new Map<string, typeof ordenes>();
    for (const o of ordenes) {
      const svUp = o.sku_venta.toUpperCase();
      if (!ordenesPorSV.has(svUp)) ordenesPorSV.set(svUp, []);
      ordenesPorSV.get(svUp)!.push(o);
    }

    if (debugSku) {
      debugLog.push(`\n--- ordenesPorSV (después de agrupar, antes de huérfanos) ---`);
      ordenesPorSV.forEach((ords, sv) => {
        if (isDebug(sv)) debugLog.push(`  "${sv}": ${ords.length} órdenes`);
      });
    }

    // ── Composición: SKU Origen → formatos de venta (UPPER, deduplicado, sin alternativos) ──
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

    if (debugSku) {
      debugLog.push(`\n--- allSkusVentaComp (contiene ${debugSku}?) ---`);
      allSkusVentaComp.forEach(sv => {
        if (isDebug(sv)) debugLog.push(`  "${sv}" → SÍ está en allSkusVentaComp`);
      });

      debugLog.push(`\n--- ventasPorOrigen ---`);
      ventasPorOrigen.forEach((ventas, soUp) => {
        if (isDebug(soUp) || ventas.some(v => isDebug(v.skuVenta))) {
          debugLog.push(`  origen="${soUp}" → ${JSON.stringify(ventas)}`);
        }
      });
    }

    // ── Reasignar órdenes huérfanas ──
    // SOLO si el sku_venta de la orden NO está en composicion_venta
    if (debugSku) debugLog.push(`\n--- Evaluación de huérfanos ---`);
    for (const svUp of Array.from(ordenesPorSV.keys())) {
      const enComp = allSkusVentaComp.has(svUp);
      if (debugSku && isDebug(svUp)) {
        debugLog.push(`  svUp="${svUp}": enComp=${enComp}`);
      }
      if (enComp) continue; // Es un sku_venta registrado → no tocar sus órdenes
      const formatos = ventasPorOrigen.get(svUp);
      if (!formatos || formatos.length === 0) continue;
      const individual = formatos.find(f => f.unidades === 1);
      if (!individual) continue;
      const target = individual.skuVenta;
      const ordsCount = ordenesPorSV.get(svUp)?.length || 0;
      if (debugSku && (isDebug(svUp) || isDebug(target))) {
        debugLog.push(`  REASIGNANDO: "${svUp}" (${ordsCount} órdenes) → "${target}"`);
      }
      if (!ordenesPorSV.has(target)) ordenesPorSV.set(target, []);
      ordenesPorSV.get(target)!.push(...(ordenesPorSV.get(svUp) || []));
      ordenesPorSV.delete(svUp);
    }

    if (debugSku) {
      debugLog.push(`\n--- ordenesPorSV (después de huérfanos) ---`);
      ordenesPorSV.forEach((ords, sv) => {
        if (isDebug(sv)) debugLog.push(`  "${sv}": ${ords.length} órdenes`);
      });
    }

    // ── Auto-detect alternativas (same logic as intelligence.ts) ──
    const compsPorSV = new Map<string, { soUp: string; unidades: number }[]>();
    for (const c of composicion) {
      if (c.tipo_relacion === "alternativo") continue;
      const svUp = c.sku_venta.toUpperCase();
      if (!compsPorSV.has(svUp)) compsPorSV.set(svUp, []);
      compsPorSV.get(svUp)!.push({ soUp: c.sku_origen.toUpperCase(), unidades: c.unidades });
    }
    // Build set of alternative sku_origen that should be skipped (not the principal)
    const alternativoSkipSet = new Set<string>();
    for (const [, comps] of Array.from(compsPorSV.entries())) {
      if (comps.length < 2) continue;
      const principal = comps[0]; // first one is principal
      for (const c of comps.slice(1)) {
        if (c.unidades === principal.unidades) {
          alternativoSkipSet.add(c.soUp);
        }
      }
    }

    // ── Contar formatos por origen (para flag compartido) ──
    const ventasCountPorOrigen = new Map<string, number>();
    ventasPorOrigen.forEach((ventas, soUp) => {
      ventasCountPorOrigen.set(soUp, ventas.length);
    });

    // ── Pre-computar unidades físicas 30d por origen (para distribución proporcional) ──
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

    // ── Generar filas: una por cada SKU Venta en composicion ──
    const result: Record<string, unknown>[] = [];

    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      // Skip alternative sku_origen — already covered by the principal
      if (alternativoSkipSet.has(skuOrigen)) return;

      const intel = intelMap.get(skuOrigen);

      if (debugSku && isDebug(skuOrigen)) {
        debugLog.push(`\n--- Procesando origen="${skuOrigen}" ---`);
        debugLog.push(`  intelMap.has("${skuOrigen}"): ${intelMap.has(skuOrigen)}`);
        if (!intel) debugLog.push(`  ⚠️ INTEL NO ENCONTRADO → se salta todo este origen`);
      }

      if (!intel) return;

      const velOrigenPonderada = (intel.vel_ponderada as number) || 0;
      const totalFisicasOrigen = fisicasPorOrigen.get(skuOrigen) || 0;
      const costoNeto = productoCostos.get(skuOrigen) || 0;
      const costoBruto = costoNeto > 0 ? Math.round(costoNeto * 1.19) : 0;

      for (const { skuVenta, unidades } of ventas) {
        const stFull = stockFullMap.get(skuVenta) || 0;
        const ords = ordenesPorSV.get(skuVenta) || [];

        if (debugSku && isDebug(skuVenta)) {
          debugLog.push(`\n  --- Formato: skuVenta="${skuVenta}", unidades=${unidades} ---`);
          debugLog.push(`    stockFullMap.get("${skuVenta}"): ${stFull}`);
          debugLog.push(`    ordenesPorSV.get("${skuVenta}"): ${ords.length} órdenes`);
          if (ords.length > 0) {
            debugLog.push(`    Primera orden: ${JSON.stringify(ords[0])}`);
            debugLog.push(`    Última orden: ${JSON.stringify(ords[ords.length - 1])}`);
          }
        }

        // Acumular por ventana en unidades físicas + FinancialAgg por canal
        let fisicas7 = 0, fisicas30 = 0, fisicas60 = 0;
        let fullFisicas30 = 0, flexFisicas30 = 0;
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
            if (o.canal === "Full") fullFisicas30 += udsFisicas;
            else flexFisicas30 += udsFisicas;
            if (o.total > 0 && o.cantidad > 0) {
              precioSum += o.total;
              precioCount += o.cantidad;
            }
          }
          if (diasAtras <= 60) fisicas60 += udsFisicas;
        }

        // Velocidad: distribuir vel_ponderada del origen proporcionalmente
        const share = totalFisicasOrigen > 0
          ? fisicas30 / totalFisicasOrigen
          : (ventas.length === 1 ? 1 : 0);
        const velPonderada = velOrigenPonderada * share;

        // Velocidades informativas (uds físicas, división simple)
        const vel7d = fisicas7 / 1;
        const vel30d = fisicas30 / 4.3;
        const vel60d = fisicas60 / 8.6;

        // Margen por unidad con costo producto (calcularMargen de reposicion.ts)
        const margenFull30d = calcularMargen(faFull, "full", costoBruto) ?? 0;
        const margenFlex30d = calcularMargen(faFlex, "flex", costoBruto) ?? 0;

        // Split por canal: ratio de rentabilidad (misma regla que intelligence.ts)
        let pctFull: number;
        let pctFlex: number;
        if (margenFull30d > 0 && margenFlex30d > 0 && margenFlex30d / margenFull30d > 1.1) {
          pctFull = 0.70;
          pctFlex = 0.30;
        } else {
          pctFull = 0.80;
          pctFlex = 0.20;
        }
        const velFull = velPonderada * pctFull;
        const velFlex = velPonderada * pctFlex;

        // Cobertura: stock_full / vel_full × 7
        const cobFull = velFull > 0 ? (stFull / velFull) * 7 : 999;
        const canalMasRentable = margenFull30d >= margenFlex30d ? "Full" : "Flex";
        const precioPromedio = precioCount > 0 ? precioSum / precioCount : 0;

        if (debugSku && isDebug(skuVenta)) {
          debugLog.push(`    fisicas7=${fisicas7}, fisicas30=${fisicas30}, fisicas60=${fisicas60}`);
          debugLog.push(`    vel7d=${vel7d}, vel30d=${vel30d.toFixed(2)}, vel60d=${vel60d.toFixed(2)}`);
          debugLog.push(`    velPonderada=${velPonderada.toFixed(2)} (origen=${velOrigenPonderada.toFixed(2)}, share=${share.toFixed(3)})`);
          debugLog.push(`    margenFull30d=${margenFull30d}, margenFlex30d=${margenFlex30d}, costoBruto=${costoBruto}`);
          debugLog.push(`    ingreso30=${ingreso30}`);
        }

        const compEntries = composicion.filter(c => c.sku_venta.toUpperCase() === skuVenta);
        const esPack = unidades > 1 || compEntries.length > 1;

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
          mandar_full: share > 0 ? Math.round((intel.mandar_full as number) * share) : 0,
          pedir_proveedor: share > 0 ? Math.round((intel.pedir_proveedor as number) * share) : 0,
          evento_activo: intel.evento_activo,
          dias_en_quiebre: intel.dias_en_quiebre,
          vel_pre_quiebre: intel.vel_pre_quiebre,
          es_quiebre_proveedor: intel.es_quiebre_proveedor,
          abc_pre_quiebre: intel.abc_pre_quiebre,
          es_catch_up: intel.es_catch_up,
          venta_perdida_pesos: intel.venta_perdida_pesos,
          oportunidad_perdida_es_estimacion: intel.oportunidad_perdida_es_estimacion ?? false,
          liquidacion_accion: intel.liquidacion_accion,
          vel_objetivo: (intel.vel_objetivo as number) || 0,
          gap_vel_pct: intel.gap_vel_pct ?? null,
          gmroi: (intel.gmroi as number) || 0,
          dio: (intel.dio as number) || 0,
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
        });
      }
    });

    result.sort((a, b) => ((a.prioridad as number) || 99) - ((b.prioridad as number) || 99));

    const response: Record<string, unknown> = {
      ok: true,
      total: result.length,
      tiempo_ms: Date.now() - start,
      rows: result,
    };

    if (debugSku) {
      // En modo debug, solo devolver las filas del SKU buscado + el log
      response.rows = result.filter(r =>
        (r.sku_venta as string).includes(debugSku) || (r.sku_origen as string).includes(debugSku)
      );
      response.total = (response.rows as unknown[]).length;
      response.debug = debugLog;
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error("[intelligence/sku-venta] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
