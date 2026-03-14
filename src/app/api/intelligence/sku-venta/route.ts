import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

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

    // ── Fetch en paralelo ──
    const [intelRes, compRes, cacheRes, ordRes] = await Promise.all([
      sb.from("sku_intelligence")
        .select("sku_origen, nombre, categoria, proveedor, abc, xyz, cuadrante, accion, prioridad, alertas, alertas_count, target_dias_full, stock_bodega, stock_en_transito, mandar_full, pedir_proveedor, evento_activo, liquidacion_accion, dias_en_quiebre, vel_pre_quiebre, es_quiebre_proveedor, abc_pre_quiebre, es_catch_up, venta_perdida_pesos, updated_at, vel_ponderada, stock_total"),
      sb.from("composicion_venta").select("sku_venta, sku_origen, unidades"),
      sb.from("stock_full_cache").select("sku_venta, cantidad"),
      sb.from("orders_history")
        .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
        .eq("estado", "Pagada")
        .gte("fecha", new Date(Date.now() - 60 * 86400000).toISOString())
        .limit(50000),
    ]);

    const intelRows = (intelRes.data || []) as Record<string, unknown>[];
    const composicion = (compRes.data || []) as { sku_venta: string; sku_origen: string; unidades: number }[];
    const cacheRows = (cacheRes.data || []) as { sku_venta: string; cantidad: number }[];
    const ordenes = (ordRes.data || []) as { sku_venta: string; cantidad: number; canal: string; fecha: string; subtotal: number; comision_total: number; costo_envio: number; ingreso_envio: number; total: number }[];

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

    // ── Composición: SKU Origen → formatos de venta (UPPER, deduplicado) ──
    const allSkusVentaComp = new Set<string>();
    const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();
    for (const c of composicion) {
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

    // ── Contar formatos por origen (para flag compartido) ──
    const ventasCountPorOrigen = new Map<string, number>();
    ventasPorOrigen.forEach((ventas, soUp) => {
      ventasCountPorOrigen.set(soUp, ventas.length);
    });

    // ── Generar filas: una por cada SKU Venta en composicion ──
    const result: Record<string, unknown>[] = [];

    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      const intel = intelMap.get(skuOrigen);

      if (debugSku && isDebug(skuOrigen)) {
        debugLog.push(`\n--- Procesando origen="${skuOrigen}" ---`);
        debugLog.push(`  intelMap.has("${skuOrigen}"): ${intelMap.has(skuOrigen)}`);
        if (!intel) debugLog.push(`  ⚠️ INTEL NO ENCONTRADO → se salta todo este origen`);
      }

      if (!intel) return;

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

        let qty7 = 0, qty30 = 0, qty60 = 0;
        let fullQty30 = 0, flexQty30 = 0;
        let margenFull = 0, margenFlex = 0;
        let ingreso30 = 0;
        let ordsFull30 = 0, ordsFlex30 = 0;
        let precioSum = 0, precioCount = 0;

        for (const o of ords) {
          const diasAtras = (hoyMs - new Date(o.fecha).getTime()) / 86400000;
          const margen = (o.subtotal || 0) - (o.comision_total || 0) - (o.costo_envio || 0) + (o.ingreso_envio || 0);
          if (diasAtras <= 7) qty7 += o.cantidad;
          if (diasAtras <= 30) {
            qty30 += o.cantidad;
            ingreso30 += o.total || 0;
            if (o.canal === "Full") { fullQty30 += o.cantidad; margenFull += margen; ordsFull30++; }
            else { flexQty30 += o.cantidad; margenFlex += margen; ordsFlex30++; }
            if (o.total > 0 && o.cantidad > 0) {
              precioSum += o.total;
              precioCount += o.cantidad;
            }
          }
          if (diasAtras <= 60) qty60 += o.cantidad;
        }

        const vel7d = qty7 / 1;
        const vel30d = qty30 / 4.3;
        const vel60d = qty60 / 8.6;
        const velPonderada = vel7d * 0.4 + vel30d * 0.4 + vel60d * 0.2;
        const totalQty30 = fullQty30 + flexQty30;
        const pctFull = totalQty30 > 0 ? fullQty30 / totalQty30 : 0.5;
        const pctFlex = 1 - pctFull;
        const velFull = velPonderada * pctFull;
        const velFlex = velPonderada * pctFlex;
        const cobFull = velFull > 0 ? (stFull / velFull) * 7 : 999;
        const mppFull = ordsFull30 > 0 ? margenFull / fullQty30 : 0;
        const mppFlex = ordsFlex30 > 0 ? margenFlex / flexQty30 : 0;
        const canalMasRentable = mppFull >= mppFlex ? "Full" : "Flex";
        const precioPromedio = precioCount > 0 ? precioSum / precioCount : 0;

        if (debugSku && isDebug(skuVenta)) {
          debugLog.push(`    qty7=${qty7}, qty30=${qty30}, qty60=${qty60}`);
          debugLog.push(`    vel7d=${vel7d}, vel30d=${vel30d.toFixed(2)}, vel60d=${vel60d.toFixed(2)}`);
          debugLog.push(`    velPonderada=${velPonderada.toFixed(2)}`);
          debugLog.push(`    margenFull=${margenFull}, margenFlex=${margenFlex}`);
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
          mandar_full: intel.mandar_full,
          pedir_proveedor: intel.pedir_proveedor,
          evento_activo: intel.evento_activo,
          dias_en_quiebre: intel.dias_en_quiebre,
          vel_pre_quiebre: intel.vel_pre_quiebre,
          es_quiebre_proveedor: intel.es_quiebre_proveedor,
          abc_pre_quiebre: intel.abc_pre_quiebre,
          es_catch_up: intel.es_catch_up,
          venta_perdida_pesos: intel.venta_perdida_pesos,
          liquidacion_accion: intel.liquidacion_accion,
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
          margen_full_30d: Math.round(margenFull),
          margen_flex_30d: Math.round(margenFlex),
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
