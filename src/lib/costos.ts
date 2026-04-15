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
interface ComposicionRow { sku_venta: string; sku_origen: string; unidades: number }

export interface CostosPreload {
  composicion: Map<string, ComposicionRow[]>;
  productos: Map<string, { costo_promedio: number; costo: number }>;
}

/**
 * Preload composicion_venta + productos para resolver costos en batch.
 * Usar cuando tenés muchas ventas que resolver (sync, backfill).
 */
export async function preloadCostos(sb: SupabaseClient): Promise<CostosPreload> {
  const { data: comp } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");
  const compMap = new Map<string, ComposicionRow[]>();
  for (const c of (comp || []) as ComposicionRow[]) {
    const key = (c.sku_venta || "").toUpperCase();
    const arr = compMap.get(key) || [];
    arr.push({ sku_venta: key, sku_origen: (c.sku_origen || "").toUpperCase(), unidades: c.unidades || 1 });
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

  return { composicion: compMap, productos: prodMap };
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

  // Si no hay composición, tratamos el sku_venta como si fuera su propio origen
  // (fallback: no toda venta está en composicion_venta todavía).
  const comps = componentes && componentes.length > 0
    ? componentes
    : [{ sku_venta: sv, sku_origen: sv, unidades: 1 }];

  for (const c of comps) {
    const prod = preload.productos.get(c.sku_origen);
    let costoUnit = 0;
    let fuenteComp: CostoFuente;

    if (prod && prod.costo_promedio > 0) {
      costoUnit = prod.costo_promedio;
      fuenteComp = "promedio";
    } else if (prod && prod.costo > 0) {
      costoUnit = prod.costo;
      fuenteComp = "catalogo";
    } else {
      costoUnit = 0;
      fuenteComp = "sin_costo";
    }

    // Peor caso: sin_costo > catalogo > promedio
    if (fuenteComp === "sin_costo") fuente = "sin_costo";
    else if (fuenteComp === "catalogo" && fuente === "promedio") fuente = "catalogo";

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
