/**
 * Función canon de partición Full/Flex (PR3).
 *
 * Motivación (doc: banva-bodega-problema-stock-flex-2026-04-21.md).
 * Hasta 2026-04-21 la lógica Full/Flex estaba en 3 reglas paralelas que no
 * se hablaban entre sí:
 *   - Regla 1 pct: hardcoded 80/20 o 70/30 en intelligence.ts:1085-1093
 *   - Regla 2 split mandar_full: vel × pct × target / 7 (reserva matemática)
 *     en intelligence.ts:1307 (viejo) y :1661 (Fase B)
 *   - Regla 3 publicación ML: stock_bodega − buffer en
 *     src/app/api/ml/stock-sync/route.ts:129 (resta fija)
 *
 * Esta función unifica Reglas 2 y 3 sobre el estado real del bodega. Regla 1
 * queda intacta (es un input vía pct_full/pct_flex del contexto).
 *
 * Principio: "partición real, no reserva matemática". El bodega se divide en:
 *   - para_flex: lo que REALMENTE podemos publicar (stock_bodega − buffer)
 *   - para_full: lo que queda disponible para enviar a Full
 *
 * Sin esta función, un SKU con stock_bodega=5 y buffer=2 se publicaba como 3
 * en ML (Regla 3) pero el motor creía que tenía 4 uds reservadas para Flex
 * (Regla 2), gap de 1 uds invisible ("stock fantasma"). Con la función canon,
 * ambas decisiones leen del mismo estado.
 *
 * Función pura sin I/O: testeable en aislamiento.
 */

export interface FlexFullContext {
  // identidad
  sku_origen: string;
  // stock físico (en unidades físicas, no pack)
  stock_bodega: number;
  stock_full: number;
  stock_en_transito: number;
  // demanda
  vel_ponderada: number;
  pct_full: number; // 0..1 — fracción asignada a Full
  target_dias_full: number; // por ABC: A=42, B=28, C=14
  // política
  flex_objetivo: boolean; // true = este SKU debe sostener Flex
  // ML constraints
  buffer_ml: number; // 2 si no compartido, 4 si sku_origen compartido
  inner_pack: number; // 1 default — unidades que ML espera por "unidad publicable"
  // meta (no afecta cálculo hoy, reservado para políticas futuras)
  abc: "A" | "B" | "C";
}

export interface FlexFullState {
  // Partición real del bodega (en unidades físicas)
  para_flex: number; // reservado para publicación Flex
  para_full: number; // disponible para mandar a Full
  // Decisiones operativas
  publicar_flex: number; // cuántas unidades publicar en ML (post inner_pack)
  mandar_full: number; // cuántas mover de bodega a Full
  // Señales diagnósticas
  flex_activo: boolean; // publicar_flex > 0
  flex_bloqueado_por_stock: boolean; // flex_objetivo pero 0 < stock_bodega < buffer_ml
  gap_fantasma: number; // restante de para_flex / inner_pack (no publicable por truncado)
  reserva_ignorada: boolean; // placeholder para comparación con fórmula vieja; siempre false en esta versión
}

export function calcularEstadoFlexFull(ctx: FlexFullContext): FlexFullState {
  const para_flex = ctx.flex_objetivo
    ? Math.max(0, ctx.stock_bodega - ctx.buffer_ml)
    : 0;
  const para_full = ctx.stock_bodega - para_flex;
  const publicar_flex = ctx.inner_pack > 0
    ? Math.floor(para_flex / ctx.inner_pack)
    : 0;
  const gap_fantasma = para_flex - (publicar_flex * Math.max(1, ctx.inner_pack));
  const flex_bloqueado_por_stock =
    ctx.flex_objetivo &&
    ctx.stock_bodega > 0 &&
    ctx.stock_bodega < ctx.buffer_ml;

  // mandar_full: déficit en Full respecto al target, limitado por lo que el
  // bodega realmente puede entregar (para_full, NO stock_bodega completo).
  // Esto es el cambio estructural de PR3: antes el cálculo usaba stock_bodega
  // como si todo estuviera disponible para Full, pero parte está reservada
  // (de verdad) para publicación Flex.
  const targetFullUds = ctx.vel_ponderada * ctx.pct_full * ctx.target_dias_full / 7;
  const deficit_full = targetFullUds - ctx.stock_full - ctx.stock_en_transito;
  const mandar_full = Math.max(0, Math.min(Math.ceil(deficit_full), para_full));

  return {
    para_flex,
    para_full,
    publicar_flex,
    mandar_full,
    flex_activo: publicar_flex > 0,
    flex_bloqueado_por_stock,
    gap_fantasma,
    reserva_ignorada: false,
  };
}
