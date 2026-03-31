import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

interface Pendiente {
  sku: string;
  titulo: string;
  tipo: "sin_producto_wms" | "sin_costo" | "sin_costo_con_full";
  stock_full: number;
  stock_bodega: number;
  costo: number;
  codigos_ml: string[];
}

/**
 * GET /api/intelligence/pendientes
 * Detecta productos que requieren atencion:
 * 1. Stock en Full pero sin producto creado en WMS
 * 2. Producto con stock (bodega o Full) pero sin costo
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const [cacheRes, prodRes, stockRes, compRes, itemsMapRes] = await Promise.all([
      sb.from("stock_full_cache").select("sku_venta, cantidad").gt("cantidad", 0),
      sb.from("productos").select("sku, nombre, costo, sku_venta"),
      sb.from("stock").select("sku, cantidad, qty_reserved"),
      sb.from("composicion_venta").select("sku_venta, sku_origen"),
      sb.from("ml_items_map").select("sku, item_id, sku_venta, titulo").eq("activo", true),
    ]);

    const fullCache = (cacheRes.data || []) as { sku_venta: string; cantidad: number }[];
    const productos = (prodRes.data || []) as { sku: string; nombre: string; costo: number; sku_venta: string | null }[];
    const stock = (stockRes.data || []) as { sku: string; cantidad: number; qty_reserved: number }[];
    const composicion = (compRes.data || []) as { sku_venta: string; sku_origen: string }[];
    const itemsMap = (itemsMapRes.data || []) as { sku: string; item_id: string; sku_venta: string | null; titulo: string | null }[];

    // ml_items_map: item_id (MLC...) → { sku_venta, titulo }
    const mlItemToInfo = new Map<string, { sku_venta: string | null; titulo: string | null }>();
    for (const m of itemsMap) {
      mlItemToInfo.set(m.item_id.toUpperCase(), { sku_venta: m.sku_venta, titulo: m.titulo });
      // Also map by sku if it looks like an MLC code
      if (m.sku && m.sku.toUpperCase().startsWith("MLC")) {
        mlItemToInfo.set(m.sku.toUpperCase(), { sku_venta: m.sku_venta, titulo: m.titulo });
      }
    }

    // productos lookup
    const prodBySku = new Map<string, { nombre: string; costo: number }>();
    const prodBySkuVenta = new Map<string, { sku: string; nombre: string; costo: number }>();
    for (const p of productos) {
      prodBySku.set(p.sku.toUpperCase(), { nombre: p.nombre, costo: p.costo || 0 });
      if (p.sku_venta) {
        for (const sv of p.sku_venta.split(",")) {
          const trimmed = sv.trim().toUpperCase();
          if (trimmed) prodBySkuVenta.set(trimmed, { sku: p.sku, nombre: p.nombre, costo: p.costo || 0 });
        }
      }
    }

    // composicion: sku_venta → sku_origen
    const compMap = new Map<string, string>();
    for (const c of composicion) {
      compMap.set(c.sku_venta.toUpperCase(), c.sku_origen.toUpperCase());
    }

    // Stock bodega (disponible = cantidad - reservado)
    const stockBodega = new Map<string, number>();
    for (const s of stock) {
      const key = s.sku.toUpperCase();
      const disponible = Math.max(0, (s.cantidad || 0) - (s.qty_reserved || 0));
      stockBodega.set(key, (stockBodega.get(key) || 0) + disponible);
    }

    // Resolver cada entrada de stock_full_cache a un SKU real
    // Agrupar por SKU resuelto para evitar duplicados
    const resolvedMap = new Map<string, { skuReal: string; titulo: string; stockFull: number; codigosML: string[] }>();

    for (const fc of fullCache) {
      const svUp = fc.sku_venta.toUpperCase();

      // Intentar resolver: composicion → producto → ml_items_map
      let skuReal = svUp;
      let titulo = fc.sku_venta;

      // 1. composicion_venta
      const skuOrigen = compMap.get(svUp);
      if (skuOrigen) {
        skuReal = skuOrigen;
      }

      // 2. Si es un MLC, resolver via ml_items_map
      const mlInfo = mlItemToInfo.get(svUp);
      if (mlInfo?.sku_venta) {
        const resolvedSv = mlInfo.sku_venta.toUpperCase();
        const resolvedOrigen = compMap.get(resolvedSv) || resolvedSv;
        skuReal = resolvedOrigen;
        titulo = mlInfo.titulo || mlInfo.sku_venta;
      }

      // Buscar producto
      const prod = prodBySku.get(skuReal) || prodBySku.get(svUp) || prodBySkuVenta.get(svUp) || prodBySkuVenta.get(skuReal);
      if (prod) {
        skuReal = skuReal; // ya resuelto
        titulo = prod.nombre || titulo;
      }

      // Agrupar
      const existing = resolvedMap.get(skuReal);
      if (existing) {
        existing.stockFull += fc.cantidad;
        if (svUp !== skuReal && !existing.codigosML.includes(svUp)) {
          existing.codigosML.push(svUp);
        }
      } else {
        resolvedMap.set(skuReal, {
          skuReal,
          titulo,
          stockFull: fc.cantidad,
          codigosML: svUp !== skuReal ? [svUp] : [],
        });
      }
    }

    const pendientes: Pendiente[] = [];

    // 1. Evaluar cada SKU resuelto
    for (const [skuReal, info] of Array.from(resolvedMap.entries())) {
      const prod = prodBySku.get(skuReal) || prodBySkuVenta.get(skuReal);

      if (!prod) {
        pendientes.push({
          sku: skuReal,
          titulo: info.titulo,
          tipo: "sin_producto_wms",
          stock_full: info.stockFull,
          stock_bodega: 0,
          costo: 0,
          codigos_ml: info.codigosML,
        });
      } else if (prod.costo <= 0) {
        pendientes.push({
          sku: skuReal,
          titulo: prod.nombre || info.titulo,
          tipo: "sin_costo_con_full",
          stock_full: info.stockFull,
          stock_bodega: stockBodega.get(skuReal) || 0,
          costo: 0,
          codigos_ml: info.codigosML,
        });
      }
    }

    // 2. Productos con stock en bodega pero sin costo (sin stock Full)
    const skusYaReportados = new Set(pendientes.map(p => p.sku.toUpperCase()));
    for (const p of productos) {
      if ((p.costo || 0) > 0) continue;
      const skuUp = p.sku.toUpperCase();
      if (skusYaReportados.has(skuUp)) continue;
      const stBodega = stockBodega.get(skuUp) || 0;
      if (stBodega <= 0) continue;
      pendientes.push({
        sku: p.sku,
        titulo: p.nombre || p.sku,
        tipo: "sin_costo",
        stock_full: 0,
        stock_bodega: stBodega,
        costo: 0,
        codigos_ml: [],
      });
    }

    const orden: Record<string, number> = { sin_producto_wms: 0, sin_costo_con_full: 1, sin_costo: 2 };
    pendientes.sort((a, b) => orden[a.tipo] - orden[b.tipo] || b.stock_full - a.stock_full);

    return NextResponse.json({
      pendientes,
      resumen: {
        sin_producto_wms: pendientes.filter(p => p.tipo === "sin_producto_wms").length,
        sin_costo_con_full: pendientes.filter(p => p.tipo === "sin_costo_con_full").length,
        sin_costo: pendientes.filter(p => p.tipo === "sin_costo").length,
        total: pendientes.length,
      },
    });
  } catch (err) {
    console.error("[pendientes] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
