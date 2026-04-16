import type { SupabaseClient } from "@supabase/supabase-js";

export type CostoFuente =
  | "promedio"           // WAC real desde productos.costo_promedio
  | "catalogo"           // Fallback a productos.costo (editado manual)
  | "sin_costo"          // Sin WAC ni catálogo para el SKU
  | "sin_fuente"         // Snapshot heredado con costo_producto poblado pero costo_fuente NULL
  | "backfill_estimado"; // Legacy: UPDATE masivo del 2026-04-12 fuera del código versionado

export interface CostoResuelto {
  costo_producto: number;
  costo_fuente: CostoFuente;
  detalle: Array<{ sku_origen: string; unidades: number; costo_unit_neto: number }>;
}

const IVA = 1.19;

interface ProductoCostoRow { sku: string; costo_promedio: number | null; costo: number | null }
interface ComposicionRow { sku_venta: string; sku_origen: string; unidades: number; tipo_relacion: string }

export interface CostosPreload {
  composicion: Map<string, ComposicionRow[]>;
  productos: Map<string, { costo_promedio: number; costo: number }>;
  stock: Map<string, number>;
}

/**
 * Preload composicion_venta + productos para resolver costos en batch.
 * Usar cuando tenés muchas ventas que resolver (sync, backfill).
 */
export async function preloadCostos(sb: SupabaseClient): Promise<CostosPreload> {
  const { data: comp } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades, tipo_relacion");
  const compMap = new Map<string, ComposicionRow[]>();
  for (const c of (comp || []) as ComposicionRow[]) {
    const key = (c.sku_venta || "").toUpperCase();
    const arr = compMap.get(key) || [];
    arr.push({ sku_venta: key, sku_origen: (c.sku_origen || "").toUpperCase(), unidades: c.unidades || 1, tipo_relacion: c.tipo_relacion || "componente" });
    compMap.set(key, arr);
  }

  const { data: prods } = await sb.from("productos").select("sku, costo, costo_promedio");
  const prodMap = new Map<string, { costo_promedio: number; costo: number }>();
  for (const p of (prods || []) as ProductoCostoRow[]) {
    prodMap.set((p.sku || "").toUpperCase(), {
      costo_promedio: p.costo_promedio || 0,
      costo: p.costo || 0,
    });
  }

  const { data: stocks } = await sb.from("stock").select("sku, cantidad");
  const stockMap = new Map<string, number>();
  for (const s of (stocks || []) as Array<{ sku: string; cantidad: number }>) {
    const key = (s.sku || "").toUpperCase();
    stockMap.set(key, (stockMap.get(key) || 0) + (s.cantidad || 0));
  }

  return { composicion: compMap, productos: prodMap, stock: stockMap };
}

/**
 * Resuelve el costo de una línea de venta (sku_venta × cantidad).
 * Retorna el costo total CON IVA (×1,19) sumando todos los componentes
 * vía composicion_venta + productos.costo_promedio.
 *
 * Prioridad de fuente:
 *   1. productos.costo_promedio (ponderado real de recepciones)
 *   2. productos.costo (catálogo manual) → fuente = 'catalogo'
 *   3. nada → fuente = 'sin_costo' y costo = 0
 *
 * La fuente final de la venta es el PEOR caso de sus componentes:
 * si algún componente es 'sin_costo', toda la venta lo es.
 */
export function resolverCostoVenta(
  skuVenta: string,
  cantidad: number,
  preload: CostosPreload,
): CostoResuelto {
  const sv = (skuVenta || "").toUpperCase();
  const qty = cantidad || 1;

  const componentes = preload.composicion.get(sv);
  const detalle: CostoResuelto["detalle"] = [];
  let fuente: CostoFuente = "promedio";
  let costoNetoTotal = 0;

  // Si no hay composición, tratamos el sku_venta como si fuera su propio origen.
  const allComps = componentes && componentes.length > 0
    ? componentes
    : [{ sku_venta: sv, sku_origen: sv, unidades: 1, tipo_relacion: "componente" }];

  // Separar componentes principales de alternativos.
  // Un componente principal puede tener N alternativos que lo reemplazan en picking.
  // El costo de ese "slot" es el WAC ponderado por stock de (principal + alternativas).
  const principales = allComps.filter(c => c.tipo_relacion !== "alternativo");
  const alternativos = allComps.filter(c => c.tipo_relacion === "alternativo");

  // Si no hay principales (solo alternativos), usar el primero como principal
  if (principales.length === 0 && alternativos.length > 0) {
    principales.push(alternativos.shift()!);
  }

  function costoDeOrigen(skuOrigen: string): { costo: number; fuente: CostoFuente } {
    const prod = preload.productos.get(skuOrigen);
    if (prod && prod.costo_promedio > 0) return { costo: prod.costo_promedio, fuente: "promedio" };
    if (prod && prod.costo > 0) return { costo: prod.costo, fuente: "catalogo" };
    return { costo: 0, fuente: "sin_costo" };
  }

  for (const c of principales) {
    // Buscar alternativas para este slot (mismo unidades)
    const alts = alternativos.filter(a => a.unidades === c.unidades);
    const candidatos = [c, ...alts];

    // WAC ponderado por stock entre principal + alternativas
    let numerador = 0;
    let denominador = 0;
    let peorFuente: CostoFuente = "promedio";

    for (const cand of candidatos) {
      const { costo: costoUnit, fuente: fuenteCand } = costoDeOrigen(cand.sku_origen);
      const stock = preload.stock.get(cand.sku_origen) || 0;
      if (costoUnit > 0 && stock > 0) {
        numerador += costoUnit * stock;
        denominador += stock;
      }
      if (fuenteCand === "sin_costo") peorFuente = "sin_costo";
      else if (fuenteCand === "catalogo" && peorFuente === "promedio") peorFuente = "catalogo";
    }

    let costoUnit: number;
    if (denominador > 0) {
      costoUnit = Math.round(numerador / denominador);
    } else {
      // Sin stock en ninguno: usar costo del principal
      costoUnit = costoDeOrigen(c.sku_origen).costo;
    }

    if (peorFuente === "sin_costo") fuente = "sin_costo";
    else if (peorFuente === "catalogo" && fuente === "promedio") fuente = "catalogo";

    costoNetoTotal += costoUnit * c.unidades * qty;
    detalle.push({
      sku_origen: c.sku_origen,
      unidades: c.unidades,
      costo_unit_neto: costoUnit,
    });
  }

  const costoConIva = fuente === "sin_costo" ? 0 : Math.round(costoNetoTotal * IVA);
  return { costo_producto: costoConIva, costo_fuente: fuente, detalle };
}

/**
 * Calcula margen a partir del total_neto y el costo del producto.
 *
 * - margen $: total_neto − costo_producto
 *   (total_neto ya descontó comisión ML + costo envío + bonificaciones)
 * - margen %: sobre el subtotal (precio bruto = precio_unitario × cantidad),
 *   para que se lea como "de cada $100 que cobré al cliente, X fueron margen".
 */
export function calcularMargenVenta(totalNeto: number, costoProducto: number, subtotal: number) {
  const margen = totalNeto - costoProducto;
  const margenPct = subtotal > 0 ? Math.round((margen / subtotal) * 10000) / 100 : 0;
  return { margen, margen_pct: margenPct };
}
