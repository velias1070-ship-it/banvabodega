import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/proveedor-catalogo/faltantes
 *
 * Devuelve la lista de SKUs A/B (por margen O ingreso) que NO tienen
 * precio en proveedor_catalogo. Ordenados por margen_neto_30d desc.
 *
 * Filtros: excluye Idetex (que ya tiene catálogo cargado en bulk).
 * Incluye TODOS los SKUs de Verbo Divino (no solo A/B) porque son pocos
 * y vale la pena cubrir el catálogo completo de ese proveedor.
 */
export async function GET() {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // 1. Productos con su WAC y proveedor (excluyendo Idetex)
  const { data: prodData } = await sb.from("productos")
    .select("sku, nombre, proveedor, costo_promedio, inner_pack")
    .neq("proveedor", "Idetex");

  // 2. SKUs ya en catálogo con precio > 0
  const { data: catData } = await sb.from("proveedor_catalogo")
    .select("sku_origen, precio_neto");
  const conPrecio = new Set<string>();
  for (const r of (catData || []) as { sku_origen: string; precio_neto: number }[]) {
    if ((r.precio_neto || 0) > 0) conPrecio.add(r.sku_origen.toUpperCase());
  }

  // 3. Inteligencia (ABC + cuadrante + margen)
  const { data: intelData } = await sb.from("sku_intelligence")
    .select("sku_origen, abc_margen, abc_ingreso, cuadrante, vel_ponderada, margen_neto_30d, stock_full, stock_bodega");
  const intelMap = new Map<string, {
    abc_margen: string; abc_ingreso: string; cuadrante: string;
    vel_ponderada: number; margen_neto_30d: number;
    stock_full: number; stock_bodega: number;
  }>();
  for (const r of (intelData || []) as Record<string, unknown>[]) {
    intelMap.set((r.sku_origen as string).toUpperCase(), {
      abc_margen: (r.abc_margen as string) || "C",
      abc_ingreso: (r.abc_ingreso as string) || "C",
      cuadrante: (r.cuadrante as string) || "REVISAR",
      vel_ponderada: (r.vel_ponderada as number) || 0,
      margen_neto_30d: (r.margen_neto_30d as number) || 0,
      stock_full: (r.stock_full as number) || 0,
      stock_bodega: (r.stock_bodega as number) || 0,
    });
  }

  // 4. Filtrar
  type Faltante = {
    sku: string; nombre: string; proveedor: string;
    inner_pack: number; wac_actual: number;
    abc_margen: string; abc_ingreso: string; cuadrante: string;
    vel_ponderada: number; margen_neto_30d: number;
    stock_total: number;
  };
  const faltantes: Faltante[] = [];
  for (const p of (prodData || []) as Record<string, unknown>[]) {
    const sku = (p.sku as string).toUpperCase();
    if (conPrecio.has(sku)) continue; // ya tiene precio

    const intel = intelMap.get(sku);
    const proveedor = (p.proveedor as string) || "Sin proveedor";

    // Verbo Divino: incluir TODOS sin importar ABC
    // Otros: solo A o B (margen o ingreso)
    const esVerboDivino = proveedor === "Verbo Divino";
    const esAoB = intel && (
      intel.abc_margen === "A" || intel.abc_margen === "B" ||
      intel.abc_ingreso === "A" || intel.abc_ingreso === "B"
    );
    if (!esVerboDivino && !esAoB) continue;

    faltantes.push({
      sku,
      nombre: (p.nombre as string) || "",
      proveedor,
      inner_pack: (p.inner_pack as number) || 1,
      wac_actual: Math.round((p.costo_promedio as number) || 0),
      abc_margen: intel?.abc_margen || "C",
      abc_ingreso: intel?.abc_ingreso || "C",
      cuadrante: intel?.cuadrante || "REVISAR",
      vel_ponderada: intel?.vel_ponderada || 0,
      margen_neto_30d: intel?.margen_neto_30d || 0,
      stock_total: (intel?.stock_full || 0) + (intel?.stock_bodega || 0),
    });
  }

  // Ordenar por margen 30d desc
  faltantes.sort((a, b) => b.margen_neto_30d - a.margen_neto_30d);

  return NextResponse.json({
    ok: true,
    total: faltantes.length,
    faltantes,
  });
}
