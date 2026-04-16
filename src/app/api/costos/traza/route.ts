import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { preloadCostos, resolverCostoVenta } from "@/lib/costos";

export const dynamic = "force-dynamic";

/**
 * GET /api/costos/traza?sku_venta=RAPAC50X70AFA
 * GET /api/costos/traza?sku_origen=RAPAC50X70AFA
 *
 * Traza en vivo del cálculo de costo para un SKU.
 * Muestra composición, alternativas, stock, WAC, y últimas recepciones.
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const skuVenta = req.nextUrl.searchParams.get("sku_venta")?.toUpperCase();
  const skuOrigen = req.nextUrl.searchParams.get("sku_origen")?.toUpperCase();

  if (!skuVenta && !skuOrigen) {
    return NextResponse.json({ error: "Pasar ?sku_venta=X o ?sku_origen=X" }, { status: 400 });
  }

  const preload = await preloadCostos(sb);

  // Si viene sku_origen, buscar todos los sku_venta que lo contienen
  let skusVenta: string[] = [];
  if (skuVenta) {
    skusVenta = [skuVenta];
  } else if (skuOrigen) {
    const { data: cvRows } = await sb.from("composicion_venta")
      .select("sku_venta")
      .eq("sku_origen", skuOrigen);
    skusVenta = Array.from(new Set((cvRows || []).map(r => (r.sku_venta as string).toUpperCase())));
    if (skusVenta.length === 0) skusVenta = [skuOrigen];
  }

  const resultados = [];

  for (const sv of skusVenta) {
    const composicion = preload.composicion.get(sv) || [];
    const resolved = resolverCostoVenta(sv, 1, preload);

    const componentes = [];
    for (const c of composicion) {
      const prod = preload.productos.get(c.sku_origen);
      const stock = preload.stock.get(c.sku_origen) || 0;

      // Últimas 5 recepciones
      const { data: receps } = await sb.from("recepcion_lineas")
        .select("costo_unitario, qty_recibida, recepciones!inner(folio, created_at, estado)")
        .eq("sku", c.sku_origen)
        .order("recepciones(created_at)", { ascending: false })
        .limit(5);

      componentes.push({
        sku_origen: c.sku_origen,
        unidades: c.unidades,
        tipo_relacion: c.tipo_relacion,
        costo_promedio: prod?.costo_promedio || 0,
        costo_catalogo: prod?.costo || 0,
        stock_actual: stock,
        recepciones: (receps || []).map((r: Record<string, unknown>) => {
          const rec = r.recepciones as Record<string, unknown>;
          return {
            folio: rec?.folio,
            fecha: rec?.created_at,
            estado: rec?.estado,
            costo_unitario: r.costo_unitario,
            qty: r.qty_recibida,
          };
        }),
      });
    }

    const principales = componentes.filter(c => c.tipo_relacion !== "alternativo");
    const alternativos = componentes.filter(c => c.tipo_relacion === "alternativo");

    resultados.push({
      sku_venta: sv,
      composicion_total: composicion.length,
      principales: principales.length,
      alternativos: alternativos.length,
      costo_resuelto: {
        costo_neto: resolved.costo_producto > 0 ? Math.round(resolved.costo_producto / 1.19) : 0,
        costo_bruto_iva: resolved.costo_producto,
        fuente: resolved.costo_fuente,
        detalle: resolved.detalle,
      },
      componentes,
    });
  }

  // Si buscó por sku_origen, agregar info del producto
  let productoOrigen = null;
  if (skuOrigen) {
    const prod = preload.productos.get(skuOrigen);
    const stock = preload.stock.get(skuOrigen) || 0;
    productoOrigen = {
      sku: skuOrigen,
      costo_promedio: prod?.costo_promedio || 0,
      costo_catalogo: prod?.costo || 0,
      stock_actual: stock,
    };
  }

  return NextResponse.json({
    query: { sku_venta: skuVenta, sku_origen: skuOrigen },
    producto_origen: productoOrigen,
    skus_venta: resultados,
    timestamp: new Date().toISOString(),
  });
}
