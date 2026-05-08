import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// GET /api/intelligence/durmientes
//
// Detecta SKUs "durmientes con potencial": vendieron bien en histórico
// (180d) pero la ventana móvil del motor (60d) está vacía → el motor
// los etiqueta como EXCESO/INACTIVO/DEAD_STOCK y los entierra.
//
// Causa típica: WMS no existía cuando vendían (data antes de mar-2026 sin
// movimientos en banvabodega), Full agotó stock, ML pausó la publicación,
// y desde entonces el motor solo ve ceros.
//
// Criterios:
//   - uds en últimos 180d ≥ MIN_UDS (default 3)
//   - uds en últimos 60d = 0 (motor no los ve)
//   - Cualquier action 'muerta' del motor: EXCESO, INACTIVO, DEAD_STOCK, LIQUIDACION
//   - Sin filtrar por stock_proveedor — si el SKU vendía 25 uds/180d, vale la
//     pena revisar el proveedor aunque el catálogo banva diga 0/null.
//
// Sort: por uds_180d desc (los que más vendieron primero).

export const dynamic = "force-dynamic";

interface Row {
  sku_origen: string;
  nombre: string | null;
  proveedor: string | null;
  uds_180d: number;
  uds_90d: number;
  uds_60d: number;
  uds_30d: number;
  ordenes_180d: number;
  ultima_venta: string;
  dias_sin_venta: number;
  stock_proveedor: number | null;
  disponibilidad_nota: string | null;
  abc: string | null;
  cuadrante: string | null;
  accion_motor: string | null;
  vel_ponderada: number;
  vel_pre_quiebre: number;
  vel_historico_sem: number;
  costo_promedio: number;
  ingreso_estimado_180d: number;
}

export async function GET(_req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const start = Date.now();

  // Una sola query SQL que cruza ventas históricas, productos, proveedor_catalogo
  // y sku_intelligence. Ejecutada vía rpc personalizada o directamente con select
  // crudo. Como Supabase JS no maneja CTE complejos, usamos rpc execute_sql vía
  // función SQL si existe, o fallback a múltiples queries.
  //
  // Para mantener simple: hacemos las queries por separado y joinamos en JS.

  const desde180 = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

  // 1. Ventas agregadas por sku_origen (joineado vía composicion_venta).
  type VentaAgg = { sku_origen: string; uds_180d: number; uds_90d: number; uds_60d: number; uds_30d: number; ordenes_180d: number; ultima_venta: string };
  const ventaPorOrigen = new Map<string, VentaAgg>();

  // Necesitamos paginación porque ventas_ml_cache puede ser grande. Pull todo
  // desde 180d en chunks de 1000.
  const ventas: Array<{ sku_venta: string; cantidad: number; fecha_date: string; order_id: string }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from("ventas_ml_cache")
      .select("sku_venta, cantidad, fecha_date, order_id")
      .eq("anulada", false)
      .gte("fecha_date", desde180)
      .range(off, off + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    ventas.push(...(data as typeof ventas));
    if (data.length < 1000) break;
  }

  const { data: composicionData } = await sb.from("composicion_venta")
    .select("sku_venta, sku_origen, tipo_relacion");
  const skuVentaToOrigen = new Map<string, string>();
  for (const c of (composicionData || []) as Array<{ sku_venta: string; sku_origen: string; tipo_relacion: string | null }>) {
    if (c.tipo_relacion === "alternativo") continue;
    if (!skuVentaToOrigen.has(c.sku_venta.toUpperCase())) {
      skuVentaToOrigen.set(c.sku_venta.toUpperCase(), c.sku_origen);
    }
  }

  const hoy = new Date();
  const hoyMs = hoy.getTime();
  const ordenesPorOrigen180 = new Map<string, Set<string>>();
  for (const v of ventas) {
    const so = skuVentaToOrigen.get(v.sku_venta.toUpperCase()) || v.sku_venta;
    const dias = (hoyMs - new Date(v.fecha_date).getTime()) / 86400000;
    let agg = ventaPorOrigen.get(so);
    if (!agg) {
      agg = { sku_origen: so, uds_180d: 0, uds_90d: 0, uds_60d: 0, uds_30d: 0, ordenes_180d: 0, ultima_venta: v.fecha_date };
      ventaPorOrigen.set(so, agg);
    }
    agg.uds_180d += v.cantidad;
    if (dias <= 90) agg.uds_90d += v.cantidad;
    if (dias <= 60) agg.uds_60d += v.cantidad;
    if (dias <= 30) agg.uds_30d += v.cantidad;
    if (v.fecha_date > agg.ultima_venta) agg.ultima_venta = v.fecha_date;
    if (!ordenesPorOrigen180.has(so)) ordenesPorOrigen180.set(so, new Set());
    ordenesPorOrigen180.get(so)!.add(v.order_id);
  }
  for (const [so, set] of Array.from(ordenesPorOrigen180.entries())) {
    const agg = ventaPorOrigen.get(so);
    if (agg) agg.ordenes_180d = set.size;
  }

  // Filtrar candidatos: vendió ≥3 uds en 180d, 0 en 60d
  const candidatos = Array.from(ventaPorOrigen.values())
    .filter(a => a.uds_180d >= 3 && a.uds_60d === 0);

  if (candidatos.length === 0) {
    return NextResponse.json({ ok: true, total: 0, rows: [], tiempo_ms: Date.now() - start });
  }

  const skus = candidatos.map(c => c.sku_origen);

  // 2. Joinar contra productos, proveedor_catalogo, sku_intelligence
  const { data: productos } = await sb.from("productos")
    .select("sku, nombre, proveedor, costo_promedio").in("sku", skus);
  const prodMap = new Map<string, { nombre: string | null; proveedor: string | null; costo_promedio: number }>();
  for (const p of (productos || []) as Array<{ sku: string; nombre: string | null; proveedor: string | null; costo_promedio: number | null }>) {
    prodMap.set(p.sku, { nombre: p.nombre, proveedor: p.proveedor, costo_promedio: Number(p.costo_promedio) || 0 });
  }

  const { data: catalogo } = await sb.from("proveedor_catalogo")
    .select("sku_origen, stock_disponible, disponibilidad_nota").in("sku_origen", skus);
  const catMap = new Map<string, { stock_disponible: number | null; disponibilidad_nota: string | null }>();
  for (const c of (catalogo || []) as Array<{ sku_origen: string; stock_disponible: number | null; disponibilidad_nota: string | null }>) {
    catMap.set(c.sku_origen, { stock_disponible: c.stock_disponible, disponibilidad_nota: c.disponibilidad_nota });
  }

  const { data: intel } = await sb.from("sku_intelligence")
    .select("sku_origen, abc, cuadrante, accion, vel_ponderada, vel_pre_quiebre").in("sku_origen", skus);
  const intelMap = new Map<string, { abc: string | null; cuadrante: string | null; accion: string | null; vel_ponderada: number; vel_pre_quiebre: number }>();
  for (const i of (intel || []) as Array<{ sku_origen: string; abc: string | null; cuadrante: string | null; accion: string | null; vel_ponderada: number; vel_pre_quiebre: number }>) {
    intelMap.set(i.sku_origen, {
      abc: i.abc, cuadrante: i.cuadrante, accion: i.accion,
      vel_ponderada: Number(i.vel_ponderada) || 0,
      vel_pre_quiebre: Number(i.vel_pre_quiebre) || 0,
    });
  }

  // 3. Ensamblar rows. Filtrar finalmente por accion del motor (solo los que está
  // omitiendo) — un SKU URGENTE con uds_180d alto NO es durmiente, ya está siendo
  // procesado.
  const rows: Row[] = [];
  const accionesOmitidas = new Set(["EXCESO", "INACTIVO", "DEAD_STOCK", "LIQUIDACION", "OK"]);
  for (const c of candidatos) {
    const prod = prodMap.get(c.sku_origen);
    const cat = catMap.get(c.sku_origen);
    const it = intelMap.get(c.sku_origen);
    if (!it || !accionesOmitidas.has(it.accion || "")) continue;
    const dias = Math.round((hoyMs - new Date(c.ultima_venta).getTime()) / 86400000);
    rows.push({
      sku_origen: c.sku_origen,
      nombre: prod?.nombre ?? null,
      proveedor: prod?.proveedor ?? null,
      uds_180d: c.uds_180d,
      uds_90d: c.uds_90d,
      uds_60d: c.uds_60d,
      uds_30d: c.uds_30d,
      ordenes_180d: c.ordenes_180d,
      ultima_venta: c.ultima_venta,
      dias_sin_venta: dias,
      stock_proveedor: cat?.stock_disponible ?? null,
      disponibilidad_nota: cat?.disponibilidad_nota ?? null,
      abc: it.abc,
      cuadrante: it.cuadrante,
      accion_motor: it.accion,
      vel_ponderada: it.vel_ponderada,
      vel_pre_quiebre: it.vel_pre_quiebre,
      vel_historico_sem: Math.round((c.uds_180d / 180) * 7 * 100) / 100,
      costo_promedio: prod?.costo_promedio ?? 0,
      ingreso_estimado_180d: c.uds_180d * (prod?.costo_promedio ?? 0) * 1.5, // markup estimado 50%
    });
  }
  rows.sort((a, b) => b.uds_180d - a.uds_180d);

  return NextResponse.json({
    ok: true,
    total: rows.length,
    tiempo_ms: Date.now() - start,
    rows,
  });
}
