import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Cron: sync ventas ML al cache.
 * Llama a /api/ml/orders-history para los últimos 3 días y guarda en ventas_ml_cache.
 * Corre cada 10 minutos via vercel.json.
 *
 * GET ?days=N  — override de días a sincronizar (default 3)
 * GET ?full=1  — resync completo del mes actual + mes anterior
 */
export async function GET(req: NextRequest) {
  // Allow: Vercel cron, local dev, admin referer, or direct browser access with params
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const referer = req.headers.get("referer") || "";
  const isAdminCall = referer.includes("/admin");
  const hasParams = req.nextUrl.searchParams.has("full") || req.nextUrl.searchParams.has("from") || req.nextUrl.searchParams.has("days");

  if (!isVercelCron && !isLocalDev && !isAdminCall && !hasParams) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const isFull = searchParams.get("full") === "1";
  const daysParam = parseInt(searchParams.get("days") || "3") || 3;

  try {
    const today = new Date();
    let fromDate: string;
    let toDate: string;

    const customFrom = searchParams.get("from");
    const customTo = searchParams.get("to");

    if (customFrom && customTo) {
      // Custom range
      fromDate = customFrom;
      toDate = customTo;
    } else if (isFull) {
      // Full sync: this month + last month
      const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      fromDate = lastMonthStart.toISOString().slice(0, 10);
      toDate = today.toISOString().slice(0, 10);
    } else {
      // Incremental: last N days
      const from = new Date(today);
      from.setDate(from.getDate() - (daysParam - 1));
      fromDate = from.toISOString().slice(0, 10);
      toDate = today.toISOString().slice(0, 10);
    }

    console.log(`[Ventas Sync] Syncing ${fromDate} → ${toDate} (${isFull ? "full" : "incremental"})`);

    // Fetch from orders-history endpoint (reuse all the logic already built)
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.NEXT_PUBLIC_VERCEL_URL
        ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
        : "http://localhost:3000";

    // Fetch in 15-day chunks to avoid timeout
    const allOrdenes: Array<Record<string, unknown>> = [];
    const cursor = new Date(fromDate + "T00:00:00");
    const end = new Date(toDate + "T00:00:00");

    while (cursor <= end) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + 14);
      const actualEnd = chunkEnd > end ? end : chunkEnd;
      const chunkFrom = cursor.toISOString().slice(0, 10);
      const chunkTo = actualEnd.toISOString().slice(0, 10);

      console.log(`[Ventas Sync] Chunk ${chunkFrom} → ${chunkTo}`);
      const res = await fetch(`${baseUrl}/api/ml/orders-history?from=${chunkFrom}&to=${chunkTo}&tarifa_flex=3320`, {
        headers: { "x-internal": "1" },
      });

      if (res.ok) {
        const json = await res.json();
        if (json.ordenes) allOrdenes.push(...json.ordenes);
      } else {
        console.warn(`[Ventas Sync] Chunk ${chunkFrom}→${chunkTo} failed: ${res.status}`);
      }

      cursor.setDate(actualEnd.getDate() + 1);
    }

    if (allOrdenes.length === 0) {
      return NextResponse.json({ status: "ok", synced: 0, range: `${fromDate} → ${toDate}` });
    }

    // Upsert to ventas_ml_cache
    const rows = allOrdenes.map(o => ({
      order_id: String(o.order_id),
      order_number: String(o.order_number || o.order_id),
      fecha: String(o.fecha || ""),
      fecha_date: String(o.fecha || "").slice(0, 10) || null,
      cliente: String(o.cliente || ""),
      razon_social: String(o.razon_social || ""),
      sku_venta: String(o.sku_venta || ""),
      nombre_producto: String(o.nombre_producto || ""),
      cantidad: Number(o.cantidad) || 1,
      canal: String(o.canal || ""),
      precio_unitario: Number(o.precio_unitario) || 0,
      subtotal: Number(o.subtotal) || 0,
      comision_unitaria: Number(o.comision_unitaria) || 0,
      comision_total: Number(o.comision_total) || 0,
      costo_envio: Number(o.costo_envio) || 0,
      ingreso_envio: Number(o.ingreso_envio) || 0,
      ingreso_adicional_tc: Number(o.ingreso_adicional_tc) || 0,
      total: Number(o.total) || 0,
      total_neto: Number(o.total_neto) || 0,
      logistic_type: String(o.logistic_type || ""),
      estado: String(o.estado || ""),
      documento_tributario: String(o.documento_tributario || ""),
      estado_documento: String(o.estado_documento || ""),
      updated_at: new Date().toISOString(),
    }));

    // Batch upsert in chunks of 500
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from("ventas_ml_cache").upsert(chunk, { onConflict: "order_id,sku_venta" });
      if (error) console.warn(`[Ventas Sync] Upsert error:`, error.message);
      else upserted += chunk.length;
    }

    console.log(`[Ventas Sync] Done: ${upserted} rows upserted for ${fromDate} → ${toDate}`);
    return NextResponse.json({ status: "ok", synced: upserted, total_orders: allOrdenes.length, range: `${fromDate} → ${toDate}` });
  } catch (err) {
    console.error("[Ventas Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
