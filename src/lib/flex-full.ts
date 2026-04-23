/**
 * Función canon de partición Full/Flex.
 *
 * Motivación (doc: banva-bodega-problema-stock-flex-2026-04-21.md).
 * El motor tenía 3 reglas paralelas desalineadas:
 *   - Regla 1 pct: hardcoded 80/20 o 70/30 en intelligence.ts:1085-1093
 *   - Regla 2 split mandar_full: vel × pct × target / 7 (reserva matemática)
 *     en intelligence.ts (2 lugares)
 *   - Regla 3 publicación ML: stock_bodega − buffer en
 *     src/app/api/ml/stock-sync/route.ts:129 (resta fija, independiente)
 *
 * Esta función unifica la lógica de partición del bodega: el stock físico
 * se divide en `para_flex` (publicable por Flex) y `para_full` (disponible
 * para mandar a Full). Política: todos los SKUs activos viven en Flex si
 * tienen stock > buffer; no hay flag de opt-in/opt-out.
 *
 * Principio: "partición real, no reserva matemática". Antes, un SKU con
 * stock_bodega=5 y buffer=2 se publicaba como 3 en ML (Regla 3) pero el
 * motor creía que tenía 4 uds reservadas para Flex (Regla 2), gap de 1 uds
 * invisible. Con la función canon, ambas decisiones leen del mismo estado.
 *
 * Función pura sin I/O: testeable en aislamiento.
 */

export interface FlexFullContext {
  sku_origen: string;
  stock_bodega: number;
  stock_full: number;
  stock_en_transito: number;
  vel_ponderada: number;
  pct_full: number; // 0..1 — fracción asignada a Full
  target_dias_full: number; // por ABC: A=42, B=28, C=14
  buffer_ml: number; // 2 si no compartido, 4 si sku_origen compartido
  /**
   * Uds fisicas por pack de venta ML. Viene de composicion_venta.unidades
   * (cuantas uds fisicas forman "1 pack" que se publica en ML). Default 1.
   *
   * NO confundir con productos.inner_pack (uds por bulto del proveedor,
   * usado para redondeo de OCs de compra, no para venta).
   */
  unidades_pack_venta: number;
  abc: "A" | "B" | "C"; // reservado para políticas futuras
}

export interface FlexFullState {
  // Partición real del bodega (en unidades físicas)
  para_flex: number;
  para_full: number;
  // Decisiones operativas
  publicar_flex: number;
  mandar_full: number;
  // Señales diagnósticas
  flex_activo: boolean;
  gap_fantasma: number;
}

export function calcularEstadoFlexFull(ctx: FlexFullContext): FlexFullState {
  const para_flex = Math.max(0, ctx.stock_bodega - ctx.buffer_ml);
  const para_full = ctx.stock_bodega - para_flex;
  // uds_pack_venta es cuantas uds fisicas forman 1 pack publicable en ML.
  // NO es el bulto del proveedor (productos.inner_pack).
  const udsPackVenta = ctx.unidades_pack_venta > 0 ? ctx.unidades_pack_venta : 1;
  const publicar_flex = Math.floor(para_flex / udsPackVenta);
  const gap_fantasma = para_flex - (publicar_flex * udsPackVenta);

  const targetFullUds = ctx.vel_ponderada * ctx.pct_full * ctx.target_dias_full / 7;
  const deficit_full = targetFullUds - ctx.stock_full - ctx.stock_en_transito;
  const mandar_full = Math.max(0, Math.min(Math.ceil(deficit_full), para_full));

  return {
    para_flex,
    para_full,
    publicar_flex,
    mandar_full,
    flex_activo: publicar_flex > 0,
    gap_fantasma,
  };
}
