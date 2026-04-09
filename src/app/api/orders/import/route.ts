import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { getBaseUrl } from "@/lib/base-url";

interface OrderRow {
  order_id: string;
  order_number?: string;
  fecha: string;
  sku_venta: string;
  nombre_producto?: string;
  cantidad: number;
  canal: string;
  precio_unitario: number;
  subtotal: number;
  comision_unitaria: number;
  comision_total: number;
  costo_envio: number;
  ingreso_envio?: number;
  ingreso_adicional_tc?: number;
  total: number;
  logistic_type: string;
  estado: string;
  fuente?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ordenesRaw: OrderRow[] = (body.ordenes || []).map((o: OrderRow) => ({
      ...o,
      sku_venta: (o.sku_venta || "").toUpperCase().trim(),
    }));
    const fuente: string = body.fuente || "manual";

    if (!Array.isArray(ordenesRaw) || ordenesRaw.length === 0) {
      return NextResponse.json({ error: "No se recibieron órdenes" }, { status: 400 });
    }

    // Deduplicar (order_id, sku_venta): ProfitGuard devuelve cada orderItem como
    // fila separada. Cuando una orden tiene 2 unidades del mismo SKU, llegan como
    // 2 filas idénticas con cant=1 cada una. Postgres ON CONFLICT no permite
    // afectar la misma fila dos veces en un upsert → si no agregamos, revienta
    // todo el chunk con "ON CONFLICT DO UPDATE command cannot affect row a second
    // time" y NADA se guarda. Agregamos sumando los campos cuantitativos.
    const dedupMap = new Map<string, OrderRow>();
    for (const o of ordenesRaw) {
      const key = `${o.order_id}|${o.sku_venta}`;
      const prev = dedupMap.get(key);
      if (!prev) {
        dedupMap.set(key, { ...o });
      } else {
        prev.cantidad = (prev.cantidad || 0) + (o.cantidad || 0);
        prev.subtotal = (prev.subtotal || 0) + (o.subtotal || 0);
        prev.comision_total = (prev.comision_total || 0) + (o.comision_total || 0);
        prev.costo_envio = (prev.costo_envio || 0) + (o.costo_envio || 0);
        prev.ingreso_envio = (prev.ingreso_envio || 0) + (o.ingreso_envio || 0);
        prev.ingreso_adicional_tc = (prev.ingreso_adicional_tc || 0) + (o.ingreso_adicional_tc || 0);
        prev.total = (prev.total || 0) + (o.total || 0);
        // precio_unitario y comision_unitaria se mantienen del primer item (son por unidad)
      }
    }
    const ordenes: OrderRow[] = Array.from(dedupMap.values());

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    // Obtener órdenes existentes para detectar cambios
    const orderKeys = ordenes.map(o => `${o.order_id}|${o.sku_venta}`);
    const existingMap = new Map<string, { estado: string; precio_unitario: number; subtotal: number; comision_unitaria: number; comision_total: number; costo_envio: number; ingreso_envio: number; total: number }>();

    // Consultar existentes en lotes de 500 order_ids
    const uniqueOrderIds = Array.from(new Set(ordenes.map(o => o.order_id)));
    for (let i = 0; i < uniqueOrderIds.length; i += 500) {
      const batch = uniqueOrderIds.slice(i, i + 500);
      const { data } = await sb.from("orders_history")
        .select("order_id, sku_venta, estado, precio_unitario, subtotal, comision_unitaria, comision_total, costo_envio, ingreso_envio, total")
        .in("order_id", batch);
      if (data) {
        for (const row of data) {
          existingMap.set(`${row.order_id}|${row.sku_venta}`, row);
        }
      }
    }

    let nuevas = 0;
    let actualizadas = 0;
    let sinCambio = 0;

    // Clasificar cada orden
    const toUpsert: OrderRow[] = [];
    for (const o of ordenes) {
      const key = `${o.order_id}|${o.sku_venta}`;
      const existing = existingMap.get(key);
      if (!existing) {
        nuevas++;
        toUpsert.push(o);
      } else {
        // Comparar campos que pueden cambiar
        const changed = existing.estado !== o.estado ||
          existing.precio_unitario !== o.precio_unitario ||
          existing.subtotal !== o.subtotal ||
          existing.comision_unitaria !== o.comision_unitaria ||
          existing.comision_total !== o.comision_total ||
          existing.costo_envio !== o.costo_envio ||
          existing.ingreso_envio !== (o.ingreso_envio || 0) ||
          existing.total !== o.total;
        if (changed) {
          actualizadas++;
          toUpsert.push(o);
        } else {
          sinCambio++;
        }
      }
    }

    // Upsert en lotes de 500
    for (let i = 0; i < toUpsert.length; i += 500) {
      const batch = toUpsert.slice(i, i + 500).map(o => ({
        order_id: o.order_id,
        order_number: o.order_number || null,
        fecha: o.fecha,
        sku_venta: o.sku_venta,
        nombre_producto: o.nombre_producto || null,
        cantidad: o.cantidad,
        canal: o.canal,
        precio_unitario: o.precio_unitario,
        subtotal: o.subtotal,
        comision_unitaria: o.comision_unitaria,
        comision_total: o.comision_total,
        costo_envio: o.costo_envio,
        ingreso_envio: o.ingreso_envio || 0,
        ingreso_adicional_tc: o.ingreso_adicional_tc || 0,
        total: o.total,
        logistic_type: o.logistic_type,
        estado: o.estado,
        fuente: o.fuente || fuente,
        importado_at: new Date().toISOString(),
      }));

      const { error } = await sb.from("orders_history").upsert(batch, { onConflict: "order_id,sku_venta" });
      if (error) {
        console.error("Error upsert orders_history:", error);
        return NextResponse.json({ error: "Error al guardar órdenes: " + error.message }, { status: 500 });
      }
    }

    // Registrar importación
    const fechas = ordenes.map(o => new Date(o.fecha).getTime()).filter(t => !isNaN(t));
    const rangoDesde = fechas.length > 0 ? new Date(Math.min(...fechas)).toISOString() : null;
    const rangoHasta = fechas.length > 0 ? new Date(Math.max(...fechas)).toISOString() : null;

    await sb.from("orders_imports").insert({
      fuente,
      rango_desde: rangoDesde,
      rango_hasta: rangoHasta,
      ordenes_nuevas: nuevas,
      ordenes_actualizadas: actualizadas,
      ordenes_sin_cambio: sinCambio,
      ordenes_total: ordenes.length,
    });

    // Disparar recálculo de inteligencia con los SKUs afectados (fire and forget)
    if (nuevas > 0 || actualizadas > 0) {
      const skusAfectados = Array.from(new Set(toUpsert.map(o => o.sku_venta)));
      const baseUrl = getBaseUrl();
      fetch(`${baseUrl}/api/intelligence/recalcular`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus: skusAfectados }),
      }).catch(err => console.error("[orders/import] Error disparando recálculo intelligence:", err));
    }

    return NextResponse.json({
      ok: true,
      nuevas,
      actualizadas,
      sinCambio,
      total: ordenes.length,
    });
  } catch (err) {
    console.error("Error en /api/orders/import:", err);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
