import { getServerSupabase } from "./supabase-server";
import crypto from "crypto";

// ============================================
// Preparación de datos por agente
// ============================================

export async function prepararDatos(agente: string): Promise<{ datos: Record<string, unknown>; hash: string }> {
  switch (agente) {
    case "reposicion": return prepararReposicion();
    case "inventario": return prepararInventario();
    case "rentabilidad": return prepararRentabilidad();
    case "recepcion": return prepararRecepcion();
    default: return { datos: {}, hash: "empty" };
  }
}

function hashDatos(datos: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(datos)).digest("hex").slice(0, 16);
}

// ============================================
// Reposición
// ============================================

async function prepararReposicion(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Stock por SKU y posición
  const { data: stock } = await sb.from("stock").select("sku, posicion_id, cantidad");
  const stockRows = stock || [];

  // Stock agrupado por SKU
  const stockPorSku: Record<string, number> = {};
  for (const s of stockRows) {
    stockPorSku[s.sku] = (stockPorSku[s.sku] || 0) + (s.cantidad || 0);
  }

  // Productos activos
  const { data: productos } = await sb.from("productos").select("sku, sku_venta, nombre, costo, precio, inner_pack, categoria, proveedor");
  const prods = productos || [];

  // Composición de venta
  const { data: composicion } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");
  const comp = composicion || [];

  // Pedidos recientes (últimos 30 días) para velocidad
  const hace30d = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: shipmentItems } = await sb.from("ml_shipment_items").select("sku, cantidad, ml_shipments!inner(status, date_created, logistic_type)")
    .gte("ml_shipments.date_created", hace30d);

  // Picking sessions recientes como proxy de actividad
  const { data: pickings } = await sb.from("picking_sessions").select("tipo, lineas, created_at")
    .gte("created_at", hace30d)
    .order("created_at", { ascending: false })
    .limit(100);

  // Movimientos recientes (salidas = ventas proxy)
  const { data: movimientos } = await sb.from("movimientos").select("sku, tipo, razon, cantidad, created_at")
    .gte("created_at", hace30d)
    .in("tipo", ["SALIDA"])
    .order("created_at", { ascending: false })
    .limit(500);

  const datos: Record<string, unknown> = {
    resumen: {
      total_skus: prods.length,
      total_stock_unidades: Object.values(stockPorSku).reduce((a, b) => a + b, 0),
      skus_sin_stock: prods.filter(p => !stockPorSku[p.sku] || stockPorSku[p.sku] <= 0).length,
      fecha_datos: new Date().toISOString(),
    },
    productos: prods.map(p => ({
      sku: p.sku,
      sku_venta: p.sku_venta,
      nombre: p.nombre,
      costo: p.costo,
      precio: p.precio,
      inner_pack: p.inner_pack,
      categoria: p.categoria,
      proveedor: p.proveedor,
      stock_bodega: stockPorSku[p.sku] || 0,
    })),
    composicion: comp,
    ventas_recientes: (shipmentItems || []).slice(0, 200).map((si: Record<string, unknown>) => ({
      sku: si.sku,
      cantidad: si.cantidad,
    })),
    movimientos_salida: (movimientos || []).slice(0, 200).map(m => ({
      sku: m.sku,
      cantidad: m.cantidad,
      razon: m.razon,
      fecha: m.created_at,
    })),
    pickings_recientes: (pickings || []).length,
  };

  return { datos, hash: hashDatos(datos) };
}

// ============================================
// Inventario
// ============================================

async function prepararInventario(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Stock detallado por posición
  const { data: stock } = await sb.from("stock").select("sku, posicion_id, cantidad").gt("cantidad", 0);

  // Productos
  const { data: productos } = await sb.from("productos").select("sku, nombre, requiere_etiqueta");

  // Conteos recientes
  const { data: conteos } = await sb.from("conteos").select("id, tipo, estado, lineas, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  // Movimientos últimos 7 días
  const hace7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: movimientos } = await sb.from("movimientos").select("sku, tipo, razon, cantidad, created_at")
    .gte("created_at", hace7d)
    .order("created_at", { ascending: false })
    .limit(300);

  // Posiciones
  const { data: posiciones } = await sb.from("posiciones").select("id, tipo");

  // Discrepancias de cantidad
  const { data: discQty } = await sb.from("discrepancias_qty").select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const stockRows = stock || [];
  const prods = productos || [];

  // SKUs con stock en múltiples posiciones
  const skuPosCount: Record<string, number> = {};
  for (const s of stockRows) {
    skuPosCount[s.sku] = (skuPosCount[s.sku] || 0) + 1;
  }
  const skusMultiPos = Object.entries(skuPosCount).filter(([, c]) => c > 1).map(([sku, c]) => ({ sku, posiciones: c }));

  // SKUs que requieren etiqueta pero tienen stock
  const reqEtiqueta = prods.filter(p => p.requiere_etiqueta);
  const sinEtiquetar = reqEtiqueta.filter(p => stockRows.some(s => s.sku === p.sku));

  const datos: Record<string, unknown> = {
    resumen: {
      total_posiciones_con_stock: new Set(stockRows.map(s => s.posicion_id)).size,
      total_skus_con_stock: new Set(stockRows.map(s => s.sku)).size,
      skus_multi_posicion: skusMultiPos.length,
      conteos_ultimo_mes: (conteos || []).length,
      fecha_datos: new Date().toISOString(),
    },
    stock_por_posicion: stockRows.slice(0, 300),
    posiciones: posiciones || [],
    conteos_recientes: (conteos || []).map(c => ({
      id: c.id,
      tipo: c.tipo,
      estado: c.estado,
      num_lineas: Array.isArray(c.lineas) ? c.lineas.length : 0,
      created_at: c.created_at,
    })),
    movimientos_7d: (movimientos || []).slice(0, 200),
    skus_multi_posicion: skusMultiPos,
    skus_requieren_etiqueta: sinEtiquetar.map(p => ({ sku: p.sku, nombre: p.nombre })),
    discrepancias_qty: (discQty || []).slice(0, 30),
  };

  return { datos, hash: hashDatos(datos) };
}

// ============================================
// Rentabilidad
// ============================================

async function prepararRentabilidad(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Productos con costo
  const { data: productos } = await sb.from("productos").select("sku, sku_venta, nombre, costo, precio, categoria");

  // Shipments con items para calcular ingresos
  const hace60d = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: shipments } = await sb.from("ml_shipments").select("id, status, logistic_type, date_created")
    .gte("date_created", hace60d)
    .in("status", ["shipped", "delivered"]);

  const { data: shipmentItems } = await sb.from("ml_shipment_items").select("shipment_id, sku, cantidad, precio_unitario")
    .in("shipment_id", (shipments || []).map(s => s.id));

  // Composición
  const { data: composicion } = await sb.from("composicion_venta").select("sku_venta, sku_origen, unidades");

  const prods = productos || [];
  const items = shipmentItems || [];
  const ships = shipments || [];

  // Mapear shipment_id → logistic_type
  const shipMap: Record<string, string> = {};
  for (const s of ships) shipMap[s.id] = s.logistic_type || "unknown";

  // Ventas por SKU y canal
  const ventasPorSku: Record<string, { full: number; flex: number; ingreso_full: number; ingreso_flex: number }> = {};
  for (const item of items) {
    const canal = (shipMap[item.shipment_id] || "").includes("fulfillment") ? "full" : "flex";
    if (!ventasPorSku[item.sku]) ventasPorSku[item.sku] = { full: 0, flex: 0, ingreso_full: 0, ingreso_flex: 0 };
    const v = ventasPorSku[item.sku];
    if (canal === "full") {
      v.full += item.cantidad || 0;
      v.ingreso_full += (item.precio_unitario || 0) * (item.cantidad || 0);
    } else {
      v.flex += item.cantidad || 0;
      v.ingreso_flex += (item.precio_unitario || 0) * (item.cantidad || 0);
    }
  }

  const datos: Record<string, unknown> = {
    resumen: {
      total_productos: prods.length,
      productos_con_costo: prods.filter(p => p.costo && p.costo > 0).length,
      total_shipments_periodo: ships.length,
      fecha_datos: new Date().toISOString(),
    },
    productos: prods.map(p => ({
      sku: p.sku,
      sku_venta: p.sku_venta,
      nombre: p.nombre,
      costo: p.costo,
      precio: p.precio,
      categoria: p.categoria,
      ventas: ventasPorSku[p.sku] || { full: 0, flex: 0, ingreso_full: 0, ingreso_flex: 0 },
    })),
    composicion: composicion || [],
  };

  return { datos, hash: hashDatos(datos) };
}

// ============================================
// Recepción
// ============================================

async function prepararRecepcion(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  const hace30d = new Date(Date.now() - 30 * 86400000).toISOString();

  // Recepciones recientes
  const { data: recepciones } = await sb.from("recepciones").select("*")
    .gte("created_at", hace30d)
    .order("created_at", { ascending: false });

  // Líneas de recepción
  const recIds = (recepciones || []).map(r => r.id);
  let lineas: Record<string, unknown>[] = [];
  if (recIds.length > 0) {
    const { data } = await sb.from("recepcion_lineas").select("*").in("recepcion_id", recIds);
    lineas = data || [];
  }

  // Discrepancias de costo
  const { data: discCosto } = await sb.from("discrepancias_costo").select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  // Discrepancias de cantidad
  const { data: discQty } = await sb.from("discrepancias_qty").select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const recs = recepciones || [];

  const datos: Record<string, unknown> = {
    resumen: {
      recepciones_30d: recs.length,
      recepciones_pendientes: recs.filter(r => r.estado === "CREADA" || r.estado === "EN_PROCESO").length,
      recepciones_completadas: recs.filter(r => r.estado === "COMPLETADA").length,
      total_discrepancias_costo: (discCosto || []).length,
      total_discrepancias_qty: (discQty || []).length,
      fecha_datos: new Date().toISOString(),
    },
    recepciones: recs.map(r => ({
      id: r.id,
      folio: r.folio,
      proveedor: r.proveedor,
      estado: r.estado,
      num_lineas: lineas.filter((l: Record<string, unknown>) => l.recepcion_id === r.id).length,
      created_at: r.created_at,
    })),
    lineas_con_discrepancia: lineas.filter((l: Record<string, unknown>) => {
      const contada = l.cantidad_contada as number | null;
      const esperada = l.cantidad_esperada as number | null;
      return contada != null && esperada != null && contada !== esperada;
    }).slice(0, 100).map((l: Record<string, unknown>) => ({
      recepcion_id: l.recepcion_id,
      sku: l.sku,
      cantidad_esperada: l.cantidad_esperada,
      cantidad_contada: l.cantidad_contada,
      diferencia: ((l.cantidad_contada as number) || 0) - ((l.cantidad_esperada as number) || 0),
    })),
    discrepancias_costo: (discCosto || []).slice(0, 30),
    discrepancias_qty: (discQty || []).slice(0, 30),
  };

  return { datos, hash: hashDatos(datos) };
}
