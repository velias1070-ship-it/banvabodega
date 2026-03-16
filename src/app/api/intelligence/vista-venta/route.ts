import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { calcularMargen } from "@/lib/reposicion";
import type { FinancialAgg } from "@/lib/reposicion";

/**
 * GET /api/intelligence/vista-venta
 *
 * Desglosa sku_intelligence (nivel SKU Origen) a nivel SKU Venta.
 * Cada SKU Venta hereda ABC, XYZ, cuadrante, proveedor, alertas, acción del origen.
 * Pero tiene sus propios: stock_full, velocidad, margen, cobertura.
 */
export async function GET() {
  const start = Date.now();
  try {
    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // ── Fetch en paralelo ──
    const [intelRes, compRes, prodRes, cacheRes, ordRes] = await Promise.all([
      sb.from("sku_intelligence")
        .select("sku_origen, nombre, categoria, proveedor, skus_venta, abc, xyz, cuadrante, accion, prioridad, alertas, alertas_count, target_dias_full, stock_bodega, stock_en_transito, mandar_full, pedir_proveedor, evento_activo, multiplicador_evento, liquidacion_accion, dias_en_quiebre, vel_pre_quiebre, es_quiebre_proveedor, abc_pre_quiebre, es_catch_up, venta_perdida_pesos, updated_at, vel_ponderada, vel_objetivo, gap_vel_pct, gmroi, dio")
        .or("vel_ponderada.gt.0,stock_total.gt.0"),
      sb.from("composicion_venta").select("sku_venta, sku_origen, unidades"),
      sb.from("productos").select("sku, sku_venta, nombre, costo, precio"),
      sb.from("stock_full_cache").select("sku_venta, cantidad, stock_danado, stock_perdido, stock_transferencia, stock_no_disponible"),
      sb.from("orders_history")
        .select("sku_venta, cantidad, canal, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total")
        .eq("estado", "Pagada")
        .gte("fecha", new Date(Date.now() - 60 * 86400000).toISOString())
        .limit(50000),
    ]);

    const intelRows = (intelRes.data || []) as Record<string, unknown>[];
    const composicion = (compRes.data || []) as { sku_venta: string; sku_origen: string; unidades: number }[];
    const productos = (prodRes.data || []) as { sku: string; sku_venta: string; nombre: string; costo: number; precio: number }[];
    const cacheRows = (cacheRes.data || []) as { sku_venta: string; cantidad: number; stock_danado: number; stock_perdido: number; stock_transferencia: number; stock_no_disponible: number }[];
    const ordenes = (ordRes.data || []) as { sku_venta: string; cantidad: number; canal: string; fecha: string; subtotal: number; comision_total: number; costo_envio: number; ingreso_envio: number; total: number }[];

    // ── Maps de lookup ──
    const intelMap = new Map<string, Record<string, unknown>>();
    for (const r of intelRows) intelMap.set(r.sku_origen as string, r);

    const stockFullMap = new Map<string, number>();
    const stockDetailMap = new Map<string, { stock_danado: number; stock_perdido: number; stock_transferencia: number }>();
    for (const r of cacheRows) {
      const svUp = r.sku_venta.toUpperCase();
      stockFullMap.set(svUp, r.cantidad || 0);
      const danado = r.stock_danado || 0;
      const perdido = r.stock_perdido || 0;
      const transferencia = r.stock_transferencia || 0;
      if (danado > 0 || perdido > 0 || transferencia > 0) {
        stockDetailMap.set(svUp, { stock_danado: danado, stock_perdido: perdido, stock_transferencia: transferencia });
      }
    }

    // Composición: SKU Venta → [{sku_origen, unidades}] (normalizado UPPER)
    const compPorVenta = new Map<string, { sku_origen: string; unidades: number }[]>();
    for (const c of composicion) {
      const svUp = c.sku_venta.toUpperCase();
      if (!compPorVenta.has(svUp)) compPorVenta.set(svUp, []);
      compPorVenta.get(svUp)!.push({ sku_origen: c.sku_origen.toUpperCase(), unidades: c.unidades });
    }

    const productoNombres = new Map<string, string>();
    const productoCostos = new Map<string, number>();
    for (const p of productos) {
      const skuUp = p.sku.toUpperCase();
      productoNombres.set(skuUp, p.nombre || "");
      productoCostos.set(skuUp, p.costo || 0);
    }

    // ── Agrupar órdenes por SKU Venta (normalizado UPPER) ──
    const hoyMs = Date.now();
    const ordenesPorSV = new Map<string, typeof ordenes>();
    for (const o of ordenes) {
      const svUp = o.sku_venta.toUpperCase();
      if (!ordenesPorSV.has(svUp)) ordenesPorSV.set(svUp, []);
      ordenesPorSV.get(svUp)!.push(o);
    }

    // ── Construir mapeo SKU Origen → SKU Ventas SOLO desde composicion_venta ──
    const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();

    for (const c of composicion) {
      const svUp = c.sku_venta.toUpperCase();
      const soUp = c.sku_origen.toUpperCase();
      if (!ventasPorOrigen.has(soUp)) ventasPorOrigen.set(soUp, []);
      const arr = ventasPorOrigen.get(soUp)!;
      // Deduplicar por UPPER
      if (!arr.some(e => e.skuVenta === svUp)) {
        arr.push({ skuVenta: svUp, unidades: c.unidades });
      }
    }

    // ── Reasignar órdenes huérfanas: sku_venta == sku_origen sin formato propio ──
    const allSkusVentaComp = new Set<string>();
    for (const c of composicion) allSkusVentaComp.add(c.sku_venta.toUpperCase());

    // Iterar sobre copia de keys para poder mutar el mapa
    for (const svUp of Array.from(ordenesPorSV.keys())) {
      if (allSkusVentaComp.has(svUp)) continue; // ya es un sku_venta válido
      const formatos = ventasPorOrigen.get(svUp);
      if (!formatos || formatos.length === 0) continue; // no es un sku_origen conocido
      const individual = formatos.find(f => f.unidades === 1);
      if (!individual) continue;
      const target = individual.skuVenta;
      if (!ordenesPorSV.has(target)) ordenesPorSV.set(target, []);
      ordenesPorSV.get(target)!.push(...(ordenesPorSV.get(svUp) || []));
      ordenesPorSV.delete(svUp);
    }

    // ── Contar cuántos SKU Venta comparten cada SKU Origen (para flag compartido) ──
    const ventasCountPorOrigen = new Map<string, number>();
    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      ventasCountPorOrigen.set(skuOrigen, ventas.length);
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

    // ── Generar filas a nivel SKU Venta ──
    const result: Record<string, unknown>[] = [];

    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      const intel = intelMap.get(skuOrigen);
      if (!intel) return;

      const velOrigenPonderada = (intel.vel_ponderada as number) || 0;
      const totalFisicasOrigen = fisicasPorOrigen.get(skuOrigen) || 0;
      const costoNeto = productoCostos.get(skuOrigen) || 0;
      const costoBruto = costoNeto > 0 ? Math.round(costoNeto * 1.19) : 0;

      for (const { skuVenta, unidades } of ventas) {
        const stFull = stockFullMap.get(skuVenta) || 0;
        const ords = ordenesPorSV.get(skuVenta) || [];

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

        // Split por canal
        const totalCanal30 = fullFisicas30 + flexFisicas30;
        const pctFull = totalCanal30 > 0 ? fullFisicas30 / totalCanal30 : 0.5;
        const pctFlex = 1 - pctFull;
        const velFull = velPonderada * pctFull;
        const velFlex = velPonderada * pctFlex;

        // Cobertura: stock_full / vel_full × 7
        const cobFull = velFull > 0 ? (stFull / velFull) * 7 : 999;

        // Margen por unidad con costo producto (calcularMargen de reposicion.ts)
        const margenFull30d = calcularMargen(faFull, "full", costoBruto) ?? 0;
        const margenFlex30d = calcularMargen(faFlex, "flex", costoBruto) ?? 0;
        const canalMasRentable = margenFull30d >= margenFlex30d ? "Full" : "Flex";
        const precioPromedio = precioCount > 0 ? precioSum / precioCount : 0;

        result.push({
          sku_venta: skuVenta,
          sku_origen: skuOrigen,
          nombre: (intel.nombre as string) || productoNombres.get(skuOrigen) || null,
          unidades_por_pack: unidades,
          es_pack: unidades > 1 || (compPorVenta.get(skuVenta)?.length || 0) > 1,
          // Heredados del origen
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
          vel_objetivo: (intel.vel_objetivo as number) || 0,
          gap_vel_pct: intel.gap_vel_pct ?? null,
          gmroi: (intel.gmroi as number) || 0,
          dio: (intel.dio as number) || 0,
          updated_at: intel.updated_at,
          // Propios del SKU Venta
          stock_full: stFull,
          stock_danado: stockDetailMap.get(skuVenta)?.stock_danado || 0,
          stock_perdido: stockDetailMap.get(skuVenta)?.stock_perdido || 0,
          stock_transferencia_full: stockDetailMap.get(skuVenta)?.stock_transferencia || 0,
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
        });
      }
    });

    // Ordenar por prioridad del origen
    result.sort((a, b) => ((a.prioridad as number) || 99) - ((b.prioridad as number) || 99));

    return NextResponse.json({
      ok: true,
      total: result.length,
      tiempo_ms: Date.now() - start,
      rows: result,
    });
  } catch (err) {
    console.error("[intelligence/vista-venta] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
