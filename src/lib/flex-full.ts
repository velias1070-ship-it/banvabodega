/**
 * Funcion canon de particion Full/Flex.
 *
 * Evolucion del calculo mandar_full:
 *   - v1 (2026-03-13, 38bfc60): limitado por stock_bodega completo. Riesgo
 *     de vaciar Flex al mandar todo a Full.
 *   - v2 (2026-03-29, 02bc393): reserva Flex = vel × pct_flex × 30/7.
 *     disponibleParaFull = stock_bodega - reservaFlex. Logica sensata.
 *   - v3 (2026-04-16, 4896f6d): unifica reserva Flex con target_dias_full
 *     por ABC (no mas 30d hardcoded). Misma estructura que v2.
 *   - v4 (2026-04-21, 21f68f8): "funcion canon" colapsa v3 a
 *     para_full = stock_bodega - para_flex = buffer_ml. Regresion: el motor
 *     nunca propone mandar mas que buffer al Full. Sesgo pro-Flex absoluto.
 *   - v5 (2026-04-23 primera iteracion): restaura logica v3 dentro de la
 *     funcion canon. Reserva Flex = max(buffer_ml, vel × pct_flex × target/7).
 *   - v6 (2026-04-23 final): stock_en_transito NO entra en deficit_full.
 *     Regla de Vicente: "mandar a Full solo debe ver lo que hay realmente
 *     en bodega". stock_en_transito solo sirve para pedir_proveedor (evitar
 *     sobrepedir al proveedor). Esto evita el sesgo pro-espera: antes, si
 *     OC por 60 uds estaba en camino, el motor frenaba cualquier envio a
 *     Full aunque el Full se estuviera vaciando ahora.
 *
 * Contrato:
 *   - `para_full` = lo que efectivamente se manda a Full en este ciclo
 *     (== mandar_full). Semantica operativa: "las uds que salen de bodega
 *     hacia Full ahora".
 *   - `para_flex` = stock_bodega - para_full. Lo que queda en bodega para
 *     sostener publicacion Flex.
 *   - `publicar_flex` = floor(max(0, para_flex - buffer_ml) / uds_pack_venta).
 *     Las uds publicables en ML descontando el buffer anti-race y
 *     respetando el pack de venta.
 *
 * Invariante: para_flex + para_full = stock_bodega. No hay doble conteo
 * (stock fantasma P9 evitado).
 *
 * Funcion pura sin I/O: testeable en aislamiento.
 */

export interface FlexFullContext {
  sku_origen: string;
  stock_bodega: number;
  stock_full: number;
  stock_en_transito: number;
  vel_ponderada: number;
  pct_full: number; // 0..1 — fraccion asignada a Full. pct_flex = 1 - pct_full
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
  abc: "A" | "B" | "C"; // reservado para politicas futuras
}

export interface FlexFullState {
  // Particion real del bodega (en unidades fisicas)
  para_flex: number;
  para_full: number;
  // Decisiones operativas
  publicar_flex: number;
  mandar_full: number;
  // Señales diagnosticas
  flex_activo: boolean;
  gap_fantasma: number;
}

export function calcularEstadoFlexFull(ctx: FlexFullContext): FlexFullState {
  const udsPackVenta = ctx.unidades_pack_venta > 0 ? ctx.unidades_pack_venta : 1;
  const pctFlex = Math.max(0, 1 - ctx.pct_full);

  // Target uds por canal segun velocidad × pct × dias cobertura.
  const targetFullUds = ctx.vel_ponderada * ctx.pct_full * ctx.target_dias_full / 7;
  const targetFlexUds = ctx.vel_ponderada * pctFlex * ctx.target_dias_full / 7;

  // Reserva Flex: cubrir cobertura Flex del target + piso buffer_ml.
  // El buffer_ml actua como colchon minimo aun si targetFlexUds=0 (SKU sin
  // historia Flex): nunca dejamos bodega expuesta al 100%.
  const reservaFlex = Math.max(ctx.buffer_ml, Math.ceil(targetFlexUds));
  const disponibleParaFull = Math.max(0, ctx.stock_bodega - reservaFlex);

  // Deficit Full: solo considera lo que hay FISICAMENTE hoy (stock_full).
  // stock_en_transito NO se usa aca: esas uds estan en camino del proveedor,
  // no en bodega, y desde bodega es de donde se puede despachar a Full ahora.
  // stock_en_transito solo se usa en pedir_proveedor (evitar pedir de mas).
  // Regla de negocio (Vicente, 2026-04-23): "el mandar a Full solo deberia
  // ver lo que hay realmente en bodega". Evita el sesgo de confiar en
  // promesas de OC que pueden demorar o llegar parciales.
  const deficit_full = targetFullUds - ctx.stock_full;
  const mandar_full = Math.max(0, Math.min(Math.ceil(deficit_full), disponibleParaFull));

  // Particion derivada: lo que va al Full + lo que queda en bodega = stock_bodega
  const para_full = mandar_full;
  const para_flex = ctx.stock_bodega - para_full;

  // publicar_flex: descontar buffer_ml (colchon anti-race con ML) y respetar
  // uds_pack_venta (ej. si ML vende packs de 2, solo publicas pares).
  const publicable_fisico = Math.max(0, para_flex - ctx.buffer_ml);
  const publicar_flex = Math.floor(publicable_fisico / udsPackVenta);
  const gap_fantasma = publicable_fisico - (publicar_flex * udsPackVenta);

  return {
    para_flex,
    para_full,
    publicar_flex,
    mandar_full,
    flex_activo: publicar_flex > 0,
    gap_fantasma,
  };
}
