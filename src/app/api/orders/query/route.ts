import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Sin conexión a Supabase" }, { status: 500 });
    }

    const { searchParams } = req.nextUrl;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const skuRaw = searchParams.get("sku");
    const sku = skuRaw ? skuRaw.toUpperCase().trim() : null;
    const canal = searchParams.get("canal");
    const estado = searchParams.get("estado") || "Pagada";
    const groupBy = searchParams.get("group_by"); // 'sku', 'sku_canal', 'dia', 'semana'
    const metrics = searchParams.get("metrics"); // 'velocidad', 'margen', 'total'

    // Sin group_by: devolver resumen general
    if (!groupBy) {
      let query = sb.from("orders_history").select("id", { count: "exact", head: true });
      if (from) query = query.gte("fecha", from);
      if (to) query = query.lte("fecha", to + "T23:59:59");
      if (sku) query = query.eq("sku_venta", sku);
      if (canal) query = query.eq("canal", canal);
      if (estado) query = query.eq("estado", estado);
      const { count } = await query;

      // Rango de fechas
      const { data: rangoData } = await sb.from("orders_history")
        .select("fecha")
        .order("fecha", { ascending: true })
        .limit(1);
      const { data: rangoDataMax } = await sb.from("orders_history")
        .select("fecha")
        .order("fecha", { ascending: false })
        .limit(1);

      // Última importación
      const { data: lastImport } = await sb.from("orders_imports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1);

      return NextResponse.json({
        total: count || 0,
        fecha_min: rangoData?.[0]?.fecha || null,
        fecha_max: rangoDataMax?.[0]?.fecha || null,
        ultima_importacion: lastImport?.[0] || null,
      });
    }

    // Con group_by: traer datos y agregar en el servidor
    let query = sb.from("orders_history")
      .select("sku_venta, nombre_producto, canal, cantidad, fecha, subtotal, comision_total, costo_envio, ingreso_envio, total, logistic_type");
    if (from) query = query.gte("fecha", from);
    if (to) query = query.lte("fecha", to + "T23:59:59");
    if (sku) query = query.eq("sku_venta", sku);
    if (canal) query = query.eq("canal", canal);
    if (estado) query = query.eq("estado", estado);
    query = query.order("fecha", { ascending: false }).limit(50000);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = data || [];

    if (groupBy === "sku" || groupBy === "sku_canal") {
      const agg = new Map<string, {
        sku_venta: string; nombre: string; canal: string;
        cantidad: number; subtotal: number; comision_total: number;
        costo_envio: number; ingreso_envio: number; total: number; ordenes: number;
        fechas: number[];
      }>();

      for (const r of rows) {
        const key = groupBy === "sku_canal" ? `${r.sku_venta}|${r.canal}` : r.sku_venta;
        if (!agg.has(key)) {
          agg.set(key, {
            sku_venta: r.sku_venta, nombre: r.nombre_producto || r.sku_venta,
            canal: groupBy === "sku_canal" ? r.canal : "todos",
            cantidad: 0, subtotal: 0, comision_total: 0,
            costo_envio: 0, ingreso_envio: 0, total: 0, ordenes: 0,
            fechas: [],
          });
        }
        const a = agg.get(key)!;
        a.cantidad += r.cantidad;
        a.subtotal += r.subtotal;
        a.comision_total += r.comision_total;
        a.costo_envio += r.costo_envio;
        a.ingreso_envio += r.ingreso_envio || 0;
        a.total += r.total;
        a.ordenes++;
        a.fechas.push(new Date(r.fecha).getTime());
      }

      // Calcular velocidad semanal
      const result = Array.from(agg.values()).map(a => {
        const minF = Math.min(...a.fechas);
        const maxF = Math.max(...a.fechas);
        const semanas = Math.max(1, (maxF - minF) / (7 * 86400000));
        const velSemanal = a.cantidad / semanas;
        return {
          sku_venta: a.sku_venta,
          nombre: a.nombre,
          canal: a.canal,
          cantidad_total: a.cantidad,
          ordenes: a.ordenes,
          vel_semanal: Math.round(velSemanal * 100) / 100,
          subtotal: a.subtotal,
          comision_total: a.comision_total,
          costo_envio: a.costo_envio,
          ingreso_envio: a.ingreso_envio,
          total: a.total,
          margen_unitario: a.cantidad > 0 ? Math.round(a.total / a.cantidad) : 0,
        };
      });

      result.sort((a, b) => b.vel_semanal - a.vel_semanal);
      return NextResponse.json({ datos: result, total_rows: rows.length });
    }

    if (groupBy === "dia" || groupBy === "semana") {
      const agg = new Map<string, { periodo: string; cantidad: number; total: number; ordenes: number }>();

      for (const r of rows) {
        const d = new Date(r.fecha);
        let periodo: string;
        if (groupBy === "dia") {
          periodo = d.toISOString().slice(0, 10);
        } else {
          // Semana: usar lunes como inicio
          const day = d.getDay();
          const diff = d.getDate() - day + (day === 0 ? -6 : 1);
          const monday = new Date(d);
          monday.setDate(diff);
          periodo = monday.toISOString().slice(0, 10);
        }
        if (!agg.has(periodo)) {
          agg.set(periodo, { periodo, cantidad: 0, total: 0, ordenes: 0 });
        }
        const a = agg.get(periodo)!;
        a.cantidad += r.cantidad;
        a.total += r.total;
        a.ordenes++;
      }

      const result = Array.from(agg.values()).sort((a, b) => a.periodo.localeCompare(b.periodo));
      return NextResponse.json({ datos: result, total_rows: rows.length });
    }

    return NextResponse.json({ error: "group_by no válido" }, { status: 400 });
  } catch (err) {
    console.error("Error en /api/orders/query:", err);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
