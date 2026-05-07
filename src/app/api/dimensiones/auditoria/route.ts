import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ML_DIVISOR_VOL = 4000;

/**
 * GET /api/dimensiones/auditoria
 *
 * Devuelve SKUs donde el peso facturable BANVA cae en distinto tramo de
 * ml_shipping_tariffs que el peso ML — los únicos que cambian costo de
 * envío. Cruza con ventas 30d para calcular impacto $ por SKU.
 *
 * Excluye sku_origen que aparezcan en composicion_venta con unidades>1
 * porque la comparación es inválida (sku_origen=1u vs ml_dim=pack-de-N).
 *
 * Divisor volumétrico ML Chile = 4000.
 *
 * Response: { items[], totales }
 */
export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // 1. SKUs en pack (excluir de la comparación BANVA vs ML)
  const { data: packs, error: packErr } = await sb
    .from("composicion_venta")
    .select("sku_origen, unidades")
    .gt("unidades", 1);
  if (packErr) {
    console.error("[auditoria] packs query failed:", packErr.message);
    return NextResponse.json({ error: packErr.message }, { status: 500 });
  }
  const skuEnPack = new Set((packs || []).map(p => p.sku_origen));

  // 2. Productos con dim BANVA y ML
  const { data: prods, error: pErr } = await sb
    .from("productos")
    .select("sku, nombre, largo_cm, ancho_cm, alto_cm, peso_real_gr, ml_largo_cm, ml_ancho_cm, ml_alto_cm, ml_peso_gr")
    .not("largo_cm", "is", null)
    .not("ml_largo_cm", "is", null);
  if (pErr) {
    console.error("[auditoria] productos query failed:", pErr.message);
    return NextResponse.json({ error: pErr.message }, { status: 500 });
  }

  // 3. Tarifas ML (ordenadas asc por peso_hasta_gr para buscar tramo)
  const { data: tarifas, error: tErr } = await sb
    .from("ml_shipping_tariffs")
    .select("peso_hasta_gr, peso_hasta_label, costo_barato, costo_medio, costo_caro")
    .order("peso_hasta_gr", { ascending: true });
  if (tErr) {
    console.error("[auditoria] tarifas query failed:", tErr.message);
    return NextResponse.json({ error: tErr.message }, { status: 500 });
  }
  const tarifasArr = tarifas || [];
  const buscarTramo = (pesoGr: number) => tarifasArr.find(t => t.peso_hasta_gr >= pesoGr) || tarifasArr[tarifasArr.length - 1];

  // 4. Ventas 30d agregadas por sku_venta (filtrar anulada=false — ver feedback_ventas_anuladas_filter)
  const fechaDesde = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const { data: ventas, error: vErr } = await sb
    .from("ventas_ml_cache")
    .select("sku_venta, cantidad, precio_unitario")
    .gte("fecha_date", fechaDesde)
    .eq("anulada", false);
  if (vErr) {
    console.error("[auditoria] ventas query failed:", vErr.message);
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }
  const ventasPorSkuVenta = new Map<string, { uds: number; sumPrecio: number; n: number }>();
  for (const v of ventas || []) {
    const cur = ventasPorSkuVenta.get(v.sku_venta) || { uds: 0, sumPrecio: 0, n: 0 };
    cur.uds += v.cantidad || 0;
    cur.sumPrecio += v.precio_unitario || 0;
    cur.n += 1;
    ventasPorSkuVenta.set(v.sku_venta, cur);
  }

  // 5. Composicion para mapear sku_venta → sku_origen (con multiplicador unidades)
  const { data: comps, error: cErr } = await sb
    .from("composicion_venta")
    .select("sku_venta, sku_origen, unidades");
  if (cErr) {
    console.error("[auditoria] composicion query failed:", cErr.message);
    return NextResponse.json({ error: cErr.message }, { status: 500 });
  }
  const ventasPorOrigen = new Map<string, { uds: number; sumPrecio: number; n: number }>();
  for (const cv of comps || []) {
    const v = ventasPorSkuVenta.get(cv.sku_venta);
    if (!v) continue;
    const cur = ventasPorOrigen.get(cv.sku_origen) || { uds: 0, sumPrecio: 0, n: 0 };
    cur.uds += v.uds * (cv.unidades || 1);
    cur.sumPrecio += v.sumPrecio;
    cur.n += v.n;
    ventasPorOrigen.set(cv.sku_origen, cur);
  }

  // 6a. SKUs vendidos sin dim BANVA — lista priorizada para medir.
  // Necesitamos productos con sku que tengan ventas pero largo_cm IS NULL.
  const { data: prodsSinDim, error: pndErr } = await sb
    .from("productos")
    .select("sku, nombre, ml_largo_cm, ml_ancho_cm, ml_alto_cm, ml_peso_gr")
    .is("largo_cm", null);
  if (pndErr) {
    console.error("[auditoria] productos sin dim query failed:", pndErr.message);
    return NextResponse.json({ error: pndErr.message }, { status: 500 });
  }
  type SinMedirItem = {
    sku: string; nombre: string | null;
    uds_30d: number;
    ml_largo_cm: number | null; ml_ancho_cm: number | null; ml_alto_cm: number | null;
    ml_peso_gr: number | null;
  };
  const sinMedir: SinMedirItem[] = [];
  for (const p of prodsSinDim || []) {
    const v = ventasPorOrigen.get(p.sku);
    if (!v || v.uds === 0) continue;
    sinMedir.push({
      sku: p.sku, nombre: p.nombre, uds_30d: v.uds,
      ml_largo_cm: p.ml_largo_cm, ml_ancho_cm: p.ml_ancho_cm,
      ml_alto_cm: p.ml_alto_cm, ml_peso_gr: p.ml_peso_gr,
    });
  }
  sinMedir.sort((a, b) => b.uds_30d - a.uds_30d);

  // 6b. Calcular discrepancias (solo cambio de tramo)
  type Item = {
    sku: string; nombre: string | null;
    peso_banva_gr: number; peso_ml_gr: number;
    tramo_banva: string; tramo_ml: string;
    uds_30d: number; precio_prom: number;
    delta_x_venta: number; impacto_30d: number;
    direccion: "banva_pesa_mas" | "banva_pesa_menos";
  };
  const items: Item[] = [];
  for (const p of prods || []) {
    if (skuEnPack.has(p.sku)) continue;
    const L = Number(p.largo_cm), A = Number(p.ancho_cm), H = Number(p.alto_cm);
    const pesoBanvaVol = Math.round((L * A * H) / ML_DIVISOR_VOL * 1000);
    const pesoBanva = Math.max(p.peso_real_gr || 0, pesoBanvaVol);
    const mlL = Number(p.ml_largo_cm), mlA = Number(p.ml_ancho_cm), mlH = Number(p.ml_alto_cm);
    const pesoMlVol = Math.round((mlL * mlA * mlH) / ML_DIVISOR_VOL * 1000);
    const pesoMl = Math.max(p.ml_peso_gr || 0, pesoMlVol);

    const trBanva = buscarTramo(pesoBanva);
    const trMl = buscarTramo(pesoMl);
    if (trBanva.peso_hasta_gr === trMl.peso_hasta_gr) continue;

    const v = ventasPorOrigen.get(p.sku);
    const uds = v?.uds || 0;
    const precioProm = v && v.n > 0 ? Math.round(v.sumPrecio / v.n) : 0;

    const precioRef = precioProm > 0 ? precioProm : 25000;
    let delta: number;
    if (precioRef < 9990) delta = trBanva.costo_barato - trMl.costo_barato;
    else if (precioRef < 19990) delta = trBanva.costo_medio - trMl.costo_medio;
    else delta = trBanva.costo_caro - trMl.costo_caro;

    items.push({
      sku: p.sku, nombre: p.nombre,
      peso_banva_gr: pesoBanva, peso_ml_gr: pesoMl,
      tramo_banva: trBanva.peso_hasta_label, tramo_ml: trMl.peso_hasta_label,
      uds_30d: uds, precio_prom: precioProm,
      delta_x_venta: delta, impacto_30d: uds * delta,
      direccion: trBanva.peso_hasta_gr > trMl.peso_hasta_gr ? "banva_pesa_mas" : "banva_pesa_menos",
    });
  }
  items.sort((a, b) => Math.abs(b.impacto_30d) - Math.abs(a.impacto_30d));

  const totales = {
    skus_con_drift: items.length,
    skus_vendidos: items.filter(i => i.uds_30d > 0).length,
    perdida_30d: items.filter(i => i.impacto_30d < 0).reduce((s, i) => s + i.impacto_30d, 0),
    ganancia_oculta_30d: items.filter(i => i.impacto_30d > 0).reduce((s, i) => s + i.impacto_30d, 0),
    neto_30d: items.reduce((s, i) => s + i.impacto_30d, 0),
    skus_pack_excluidos: skuEnPack.size,
  };

  return NextResponse.json({ items, totales, sin_medir: sinMedir });
}
