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
}

/**
 * GET /api/intelligence/pendientes
 * Detecta productos que requieren atención:
 * 1. Stock en Full pero sin producto creado en WMS
 * 2. Producto con stock (bodega o Full) pero sin costo
 * 3. Stock en Full sin costo asignado
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    // Fetch en paralelo
    const [cacheRes, prodRes, stockRes, compRes] = await Promise.all([
      sb.from("stock_full_cache").select("sku_venta, cantidad").gt("cantidad", 0),
      sb.from("productos").select("sku, nombre, costo, sku_venta"),
      sb.from("stock").select("sku, cantidad"),
      sb.from("composicion_venta").select("sku_venta, sku_origen"),
    ]);

    const fullCache = (cacheRes.data || []) as { sku_venta: string; cantidad: number }[];
    const productos = (prodRes.data || []) as { sku: string; nombre: string; costo: number; sku_venta: string | null }[];
    const stock = (stockRes.data || []) as { sku: string; cantidad: number }[];
    const composicion = (compRes.data || []) as { sku_venta: string; sku_origen: string }[];

    // Maps de lookup
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

    // Stock bodega por SKU
    const stockBodega = new Map<string, number>();
    for (const s of stock) {
      const key = s.sku.toUpperCase();
      stockBodega.set(key, (stockBodega.get(key) || 0) + (s.cantidad || 0));
    }

    const pendientes: Pendiente[] = [];

    // 1. Stock en Full sin producto en WMS
    for (const fc of fullCache) {
      const svUp = fc.sku_venta.toUpperCase();
      // Resolver SKU origen
      const skuOrigen = compMap.get(svUp) || svUp;
      const prod = prodBySku.get(skuOrigen) || prodBySku.get(svUp) || prodBySkuVenta.get(svUp);

      if (!prod) {
        pendientes.push({
          sku: fc.sku_venta,
          titulo: fc.sku_venta,
          tipo: "sin_producto_wms",
          stock_full: fc.cantidad,
          stock_bodega: 0,
          costo: 0,
        });
      } else if (prod.costo <= 0) {
        pendientes.push({
          sku: fc.sku_venta,
          titulo: prod.nombre || fc.sku_venta,
          tipo: "sin_costo_con_full",
          stock_full: fc.cantidad,
          stock_bodega: stockBodega.get(skuOrigen) || stockBodega.get(svUp) || 0,
          costo: 0,
        });
      }
    }

    // 2. Productos con stock en bodega pero sin costo
    for (const p of productos) {
      if ((p.costo || 0) > 0) continue;
      const skuUp = p.sku.toUpperCase();
      const stBodega = stockBodega.get(skuUp) || 0;
      if (stBodega <= 0) continue;
      // Verificar que no esté ya reportado como sin_costo_con_full
      if (pendientes.some(pe => pe.sku.toUpperCase() === skuUp && pe.tipo === "sin_costo_con_full")) continue;
      // Verificar si tiene stock full
      const svEntries = fullCache.filter(fc => {
        const svUp = fc.sku_venta.toUpperCase();
        const origen = compMap.get(svUp) || svUp;
        return origen === skuUp || svUp === skuUp;
      });
      const stFull = svEntries.reduce((s, e) => s + e.cantidad, 0);
      if (pendientes.some(pe => pe.sku.toUpperCase() === skuUp)) continue;
      pendientes.push({
        sku: p.sku,
        titulo: p.nombre || p.sku,
        tipo: "sin_costo",
        stock_full: stFull,
        stock_bodega: stBodega,
        costo: 0,
      });
    }

    // Ordenar: sin_producto_wms primero, luego sin_costo_con_full, luego sin_costo
    const orden = { sin_producto_wms: 0, sin_costo_con_full: 1, sin_costo: 2 };
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
