import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

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
        .select("sku_origen, nombre, categoria, proveedor, skus_venta, abc, xyz, cuadrante, accion, prioridad, alertas, alertas_count, target_dias_full, stock_bodega, stock_en_transito, mandar_full, pedir_proveedor, evento_activo, multiplicador_evento, liquidacion_accion, dias_en_quiebre, vel_pre_quiebre, es_quiebre_proveedor, abc_pre_quiebre, es_catch_up, venta_perdida_pesos, updated_at")
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
      stockFullMap.set(r.sku_venta, r.cantidad || 0);
      const danado = r.stock_danado || 0;
      const perdido = r.stock_perdido || 0;
      const transferencia = r.stock_transferencia || 0;
      if (danado > 0 || perdido > 0 || transferencia > 0) {
        stockDetailMap.set(r.sku_venta, { stock_danado: danado, stock_perdido: perdido, stock_transferencia: transferencia });
      }
    }

    // Composición: SKU Venta → [{sku_origen, unidades}]
    const compPorVenta = new Map<string, { sku_origen: string; unidades: number }[]>();
    for (const c of composicion) {
      if (!compPorVenta.has(c.sku_venta)) compPorVenta.set(c.sku_venta, []);
      compPorVenta.get(c.sku_venta)!.push({ sku_origen: c.sku_origen, unidades: c.unidades });
    }

    // Productos: SKU Origen → SKU Venta(s) simples (sin composición)
    const skuVentaToFisico = new Map<string, string>();
    const productoNombres = new Map<string, string>();
    const productoCostos = new Map<string, number>();
    for (const p of productos) {
      productoNombres.set(p.sku, p.nombre || "");
      productoCostos.set(p.sku, p.costo || 0);
      if (p.sku_venta) {
        for (const sv of p.sku_venta.split(",").map((s: string) => s.trim()).filter(Boolean)) {
          skuVentaToFisico.set(sv.toUpperCase(), p.sku);
        }
      }
    }

    // ── Agrupar órdenes por SKU Venta ──
    const hoyMs = Date.now();
    const ordenesPorSV = new Map<string, typeof ordenes>();
    for (const o of ordenes) {
      if (!ordenesPorSV.has(o.sku_venta)) ordenesPorSV.set(o.sku_venta, []);
      ordenesPorSV.get(o.sku_venta)!.push(o);
    }

    // ── Construir mapeo SKU Origen → SKU Ventas ──
    const ventasPorOrigen = new Map<string, { skuVenta: string; unidades: number }[]>();

    // Todos los SKU Venta conocidos
    const allSkusVenta = new Set<string>();
    for (const c of composicion) allSkusVenta.add(c.sku_venta);
    stockFullMap.forEach((_, sv) => allSkusVenta.add(sv));
    for (const o of ordenes) allSkusVenta.add(o.sku_venta);

    Array.from(allSkusVenta).forEach(sv => {
      const comps = compPorVenta.get(sv);
      if (comps && comps.length > 0) {
        // Pack/combo: mapea a múltiples orígenes
        for (const c of comps) {
          if (!ventasPorOrigen.has(c.sku_origen)) ventasPorOrigen.set(c.sku_origen, []);
          const arr = ventasPorOrigen.get(c.sku_origen)!;
          if (!arr.some(e => e.skuVenta === sv)) {
            arr.push({ skuVenta: sv, unidades: c.unidades });
          }
        }
      } else {
        // Simple: 1:1
        const fisico = skuVentaToFisico.get(sv.toUpperCase()) || sv;
        if (!ventasPorOrigen.has(fisico)) ventasPorOrigen.set(fisico, []);
        const arr = ventasPorOrigen.get(fisico)!;
        if (!arr.some(e => e.skuVenta === sv)) {
          arr.push({ skuVenta: sv, unidades: 1 });
        }
      }
    });

    // ── Generar filas a nivel SKU Venta ──
    const result: Record<string, unknown>[] = [];

    ventasPorOrigen.forEach((ventas, skuOrigen) => {
      const intel = intelMap.get(skuOrigen);
      if (!intel) return;

      for (const { skuVenta, unidades } of ventas) {
        // Stock Full propio de este SKU Venta
        const stFull = stockFullMap.get(skuVenta) || 0;

        // Velocidades propias de este SKU Venta (de orders_history)
        const ords = ordenesPorSV.get(skuVenta) || [];
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

        // Cobertura propia
        const cobFull = velFull > 0 ? (stFull / velFull) * 7 : 999;

        // Canal más rentable
        const mppFull = ordsFull30 > 0 ? margenFull / fullQty30 : 0;
        const mppFlex = ordsFlex30 > 0 ? margenFlex / flexQty30 : 0;
        const canalMasRentable = mppFull >= mppFlex ? "Full" : "Flex";

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
          margen_full_30d: Math.round(margenFull),
          margen_flex_30d: Math.round(margenFlex),
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
