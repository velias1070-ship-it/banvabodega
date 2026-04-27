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
// Reposición — Lee de sku_intelligence pre-calculada
// ============================================

async function prepararReposicion(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Leer datos pre-calculados de sku_intelligence
  const { data: intel } = await sb.from("sku_intelligence")
    .select("sku_origen, nombre, categoria, proveedor, skus_venta, vel_7d, vel_30d, vel_60d, vel_ponderada, vel_full, vel_flex, vel_total, pct_full, pct_flex, tendencia_vel, tendencia_vel_pct, es_pico, pico_magnitud, stock_full, stock_bodega, stock_total, stock_sin_etiquetar, stock_proveedor, tiene_stock_prov, inner_pack, stock_en_transito, stock_proyectado, oc_pendientes, cob_full, cob_flex, cob_total, target_dias_full, abc, xyz, cuadrante, accion, prioridad, mandar_full, pedir_proveedor, pedir_proveedor_bultos, requiere_ajuste_precio, punto_reorden, stock_seguridad, dias_sin_stock_full, venta_perdida_uds, venta_perdida_pesos, alertas, alertas_count, evento_activo, multiplicador_evento, vel_ajustada_evento, updated_at")
    .or("vel_ponderada.gt.0,stock_total.gt.0")
    .order("prioridad", { ascending: true })
    .limit(300);

  const rows = (intel || []) as Record<string, unknown>[];

  // Resumen
  const urgentes = rows.filter((r: Record<string, unknown>) => r.accion === "URGENTE" || r.accion === "PEDIR").length;
  const agotados = rows.filter((r: Record<string, unknown>) => (r.stock_full as number) <= 0 && (r.vel_full as number) > 0).length;
  const conAlerta = rows.filter((r: Record<string, unknown>) => (r.alertas_count as number) > 0).length;
  const conTransito = rows.filter((r: Record<string, unknown>) => (r.stock_en_transito as number) > 0).length;
  const conEvento = rows.filter((r: Record<string, unknown>) => r.evento_activo).length;

  const datos: Record<string, unknown> = {
    resumen: {
      total_skus: rows.length,
      total_stock_unidades: rows.reduce((a: number, r: Record<string, unknown>) => a + ((r.stock_total as number) || 0), 0),
      skus_urgentes: urgentes,
      skus_agotados_full: agotados,
      skus_con_alertas: conAlerta,
      skus_con_stock_transito: conTransito,
      skus_con_evento_activo: conEvento,
      fecha_datos: new Date().toISOString(),
    },
    skus: rows.map(r => ({
      sku_origen: r.sku_origen,
      nombre: r.nombre,
      categoria: r.categoria,
      proveedor: r.proveedor,
      skus_venta: r.skus_venta,
      // Velocidades
      vel_7d: r.vel_7d,
      vel_30d: r.vel_30d,
      vel_ponderada: r.vel_ponderada,
      vel_full: r.vel_full,
      vel_flex: r.vel_flex,
      pct_full: r.pct_full,
      tendencia_vel: r.tendencia_vel,
      tendencia_vel_pct: r.tendencia_vel_pct,
      es_pico: r.es_pico,
      // Evento estacional
      evento_activo: r.evento_activo,
      multiplicador_evento: r.multiplicador_evento,
      vel_ajustada_evento: r.vel_ajustada_evento,
      // Stock
      stock_full: r.stock_full,
      stock_bodega: r.stock_bodega,
      stock_total: r.stock_total,
      stock_en_transito: r.stock_en_transito,
      stock_proyectado: r.stock_proyectado,
      oc_pendientes: r.oc_pendientes,
      inner_pack: r.inner_pack,
      // Cobertura
      cob_full: r.cob_full,
      cob_total: r.cob_total,
      target_dias_full: r.target_dias_full,
      // Clasificación
      abc: r.abc,
      xyz: r.xyz,
      cuadrante: r.cuadrante,
      // Acción
      accion: r.accion,
      prioridad: r.prioridad,
      mandar_full: r.mandar_full,
      pedir_proveedor: r.pedir_proveedor,
      pedir_proveedor_bultos: r.pedir_proveedor_bultos,
      punto_reorden: r.punto_reorden,
      stock_seguridad: r.stock_seguridad,
      // Quiebres
      dias_sin_stock_full: r.dias_sin_stock_full,
      venta_perdida_uds: r.venta_perdida_uds,
      venta_perdida_pesos: r.venta_perdida_pesos,
      // Alertas
      alertas: r.alertas,
    })),
  };

  return { datos, hash: hashDatos(datos) };
}

// ============================================
// Inventario — Lee de sku_intelligence + datos operativos
// ============================================

async function prepararInventario(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Datos de intelligence para métricas de inventario.
  // Filtro: traer SKUs con stock o con conteo reciente (<90d). Los nunca-contados
  // con stock entran por la rama stock_total>0. NULL en dias_sin_conteo es válido.
  const { data: intel } = await sb.from("sku_intelligence")
    .select("sku_origen, nombre, categoria, stock_full, stock_bodega, stock_total, stock_sin_etiquetar, stock_en_transito, stock_proyectado, oc_pendientes, cob_total, dio, gmroi, costo_inventario_total, ultimo_conteo, dias_sin_conteo, diferencias_conteo, ultimo_movimiento, dias_sin_movimiento, accion, liquidacion_accion, liquidacion_dias_extra, liquidacion_descuento_sugerido, alertas, alertas_count")
    .or("stock_total.gt.0,dias_sin_conteo.lt.90")
    .order("dias_sin_conteo", { ascending: false, nullsFirst: false })
    .limit(200);

  // Conteos recientes (datos operativos no en intelligence)
  const { data: conteos } = await sb.from("conteos").select("id, tipo, estado, lineas, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  // Movimientos últimos 7 días
  const hace7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: movimientos } = await sb.from("movimientos").select("sku, tipo, razon, cantidad, created_at")
    .gte("created_at", hace7d)
    .order("created_at", { ascending: false })
    .limit(300);

  // Discrepancias de cantidad
  const { data: discQty } = await sb.from("discrepancias_qty").select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = (intel || []) as Record<string, unknown>[];

  const datos: Record<string, unknown> = {
    resumen: {
      total_skus_con_stock: rows.filter((r: Record<string, unknown>) => (r.stock_total as number) > 0).length,
      // Incluye SKUs con conteo > 30d Y los que nunca fueron contados pero tienen stock.
      skus_sin_conteo_30d: rows.filter((r: Record<string, unknown>) => {
        const d = r.dias_sin_conteo as number | null;
        const stock = (r.stock_total as number) || 0;
        return (d != null && d >= 30) || (d == null && stock > 0);
      }).length,
      skus_con_diferencias: rows.filter((r: Record<string, unknown>) => (r.diferencias_conteo as number) > 0).length,
      skus_liquidacion: rows.filter((r: Record<string, unknown>) => r.liquidacion_accion).length,
      conteos_recientes: (conteos || []).length,
      valor_inventario: rows.reduce((a: number, r: Record<string, unknown>) => a + ((r.costo_inventario_total as number) || 0), 0),
      fecha_datos: new Date().toISOString(),
    },
    skus: rows.map((r: Record<string, unknown>) => ({
      sku_origen: r.sku_origen,
      nombre: r.nombre,
      categoria: r.categoria,
      stock_full: r.stock_full,
      stock_bodega: r.stock_bodega,
      stock_total: r.stock_total,
      stock_sin_etiquetar: r.stock_sin_etiquetar,
      stock_en_transito: r.stock_en_transito,
      stock_proyectado: r.stock_proyectado,
      oc_pendientes: r.oc_pendientes,
      cob_total: r.cob_total,
      dio: r.dio,
      gmroi: r.gmroi,
      costo_inventario_total: r.costo_inventario_total,
      ultimo_conteo: r.ultimo_conteo,
      dias_sin_conteo: r.dias_sin_conteo,
      diferencias_conteo: r.diferencias_conteo,
      ultimo_movimiento: r.ultimo_movimiento,
      dias_sin_movimiento: r.dias_sin_movimiento,
      liquidacion_accion: r.liquidacion_accion,
      liquidacion_dias_extra: r.liquidacion_dias_extra,
      liquidacion_descuento_sugerido: r.liquidacion_descuento_sugerido,
      alertas: r.alertas,
    })),
    conteos_recientes: (conteos || []).map((c: Record<string, unknown>) => ({
      id: c.id,
      tipo: c.tipo,
      estado: c.estado,
      num_lineas: Array.isArray(c.lineas) ? c.lineas.length : 0,
      created_at: c.created_at,
    })),
    movimientos_7d: (movimientos || []).slice(0, 200),
    discrepancias_qty: (discQty || []).slice(0, 30),
  };

  return { datos, hash: hashDatos(datos) };
}

// ============================================
// Rentabilidad — Lee de sku_intelligence pre-calculada
// ============================================

async function prepararRentabilidad(): Promise<{ datos: Record<string, unknown>; hash: string }> {
  const sb = getServerSupabase();
  if (!sb) return { datos: {}, hash: "empty" };

  // Datos de intelligence para métricas de rentabilidad
  const { data: intel } = await sb.from("sku_intelligence")
    .select("sku_origen, nombre, categoria, proveedor, skus_venta, vel_ponderada, vel_full, vel_flex, ingreso_30d, pct_ingreso_acumulado, abc, xyz, cuadrante, margen_full_7d, margen_full_30d, margen_full_60d, margen_flex_7d, margen_flex_30d, margen_flex_60d, margen_tendencia_full, margen_tendencia_flex, canal_mas_rentable, precio_promedio, costo_neto, costo_bruto, costo_inventario_total, gmroi, dio, stock_total, stock_en_transito, requiere_ajuste_precio, evento_activo, multiplicador_evento, alertas")
    .gt("ingreso_30d", 0)
    .order("ingreso_30d", { ascending: false })
    .limit(200);

  const rows = (intel || []) as Record<string, unknown>[];

  // Resumen
  const margenNegFull = rows.filter((r: Record<string, unknown>) => (r.margen_full_30d as number) < 0).length;
  const margenNegFlex = rows.filter((r: Record<string, unknown>) => (r.margen_flex_30d as number) < 0).length;
  const ajustePrecio = rows.filter((r: Record<string, unknown>) => r.requiere_ajuste_precio).length;
  const ingresoTotal = rows.reduce((a: number, r: Record<string, unknown>) => a + ((r.ingreso_30d as number) || 0), 0);

  const datos: Record<string, unknown> = {
    resumen: {
      total_skus_con_ingreso: rows.length,
      ingreso_total_30d: Math.round(ingresoTotal),
      skus_margen_negativo_full: margenNegFull,
      skus_margen_negativo_flex: margenNegFlex,
      skus_requieren_ajuste_precio: ajustePrecio,
      distribucion_abc: {
        A: rows.filter((r: Record<string, unknown>) => r.abc === "A").length,
        B: rows.filter((r: Record<string, unknown>) => r.abc === "B").length,
        C: rows.filter((r: Record<string, unknown>) => r.abc === "C").length,
      },
      fecha_datos: new Date().toISOString(),
    },
    skus: rows.map((r: Record<string, unknown>) => ({
      sku_origen: r.sku_origen,
      nombre: r.nombre,
      categoria: r.categoria,
      proveedor: r.proveedor,
      skus_venta: r.skus_venta,
      // Velocidad
      vel_ponderada: r.vel_ponderada,
      vel_full: r.vel_full,
      vel_flex: r.vel_flex,
      // Ingresos y clasificación
      ingreso_30d: r.ingreso_30d,
      abc: r.abc,
      xyz: r.xyz,
      cuadrante: r.cuadrante,
      // Márgenes por ventana
      margen_full_7d: r.margen_full_7d,
      margen_full_30d: r.margen_full_30d,
      margen_full_60d: r.margen_full_60d,
      margen_flex_7d: r.margen_flex_7d,
      margen_flex_30d: r.margen_flex_30d,
      margen_flex_60d: r.margen_flex_60d,
      margen_tendencia_full: r.margen_tendencia_full,
      margen_tendencia_flex: r.margen_tendencia_flex,
      canal_mas_rentable: r.canal_mas_rentable,
      // Costos
      precio_promedio: r.precio_promedio,
      costo_neto: r.costo_neto,
      costo_bruto: r.costo_bruto,
      costo_inventario_total: r.costo_inventario_total,
      // Financieros
      gmroi: r.gmroi,
      dio: r.dio,
      stock_total: r.stock_total,
      stock_en_transito: r.stock_en_transito,
      requiere_ajuste_precio: r.requiere_ajuste_precio,
      // Evento
      evento_activo: r.evento_activo,
      multiplicador_evento: r.multiplicador_evento,
      // Alertas
      alertas: r.alertas,
    })),
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
  const recIds = (recepciones || []).map((r: Record<string, unknown>) => r.id);
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

  const recs = (recepciones || []) as Record<string, unknown>[];

  const datos: Record<string, unknown> = {
    resumen: {
      recepciones_30d: recs.length,
      recepciones_pendientes: recs.filter((r: Record<string, unknown>) => r.estado === "CREADA" || r.estado === "EN_PROCESO").length,
      recepciones_completadas: recs.filter((r: Record<string, unknown>) => r.estado === "COMPLETADA").length,
      total_discrepancias_costo: (discCosto || []).length,
      total_discrepancias_qty: (discQty || []).length,
      fecha_datos: new Date().toISOString(),
    },
    recepciones: recs.map((r: Record<string, unknown>) => ({
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
