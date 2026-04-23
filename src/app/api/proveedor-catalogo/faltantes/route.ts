import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/proveedor-catalogo/faltantes
 *
 * Devuelve la lista de SKUs que NO tienen precio en proveedor_catalogo.
 * Ordenados por margen_neto_30d desc.
 *
 * Query params:
 *   - proveedor (string, opcional): filtrar por un proveedor específico.
 *   - incluir_todos (=1): incluir TODOS los SKUs activos sin catálogo
 *     del proveedor filtrado (sin filtrar por ABC). Útil para rellenar
 *     catálogo de un proveedor completo.
 *
 * Por default (sin filtros): incluye SKUs A/B por margen o ingreso +
 * Verbo Divino completo. Idetex se incluye también (antes se excluía).
 */
export async function GET(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const proveedorFiltro = req.nextUrl.searchParams.get("proveedor") || "";
  const incluirTodos = req.nextUrl.searchParams.get("incluir_todos") === "1";

  // 1. Productos con su WAC y proveedor
  let prodQuery = sb.from("productos")
    .select("sku, nombre, proveedor, costo_promedio, inner_pack, estado_sku");
  if (proveedorFiltro) prodQuery = prodQuery.eq("proveedor", proveedorFiltro);
  const { data: prodData } = await prodQuery;

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
    const activo = (p.estado_sku as string) !== "descontinuado";

    // Modo "incluir_todos": trae todos los SKUs activos del proveedor filtrado
    if (incluirTodos) {
      if (!activo) continue;
      // sigue adelante (sin filtro ABC)
    } else {
      // Default: Verbo Divino completo, resto solo A/B
      const esVerboDivino = proveedor === "Verbo Divino";
      const esAoB = intel && (
        intel.abc_margen === "A" || intel.abc_margen === "B" ||
        intel.abc_ingreso === "A" || intel.abc_ingreso === "B"
      );
      if (!esVerboDivino && !esAoB) continue;
    }

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
