import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/* ───── Tipos ProfitGuard API ───── */
interface PGItem {
  product: { sku: string; name: string };
  quantity: number;
  unitPrice: { cents: number };
  total: { cents: number };
  unitSalesFee: { cents: number };
  commission: { cents: number };
  shippingCost: { cents: number };
  shippingRevenue: { cents: number };
  creditCardExtraRevenue: { cents: number };
  netTotal: { cents: number };
}

interface PGOrder {
  externalId: string;
  externalNumber: string;
  datetime: string;
  status: string;
  logisticType: string;
  orderItems: PGItem[];
}

interface PGPagination {
  page: number;
  page_size: number;
  pages: number;
  count: number;
}

interface PGResponse {
  data: PGOrder[];
  pagination: PGPagination;
}

/* ───── Tipo de salida ───── */
interface OrdenMapped {
  canal: string;
  orderId: string;
  fecha: string;
  producto: string;
  sku: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
  comisionUnitaria: number;
  comisionTotal: number;
  estado: string;
  costoEnvio: number;
  ingresoEnvio: number;
  ingresoAdicionalTC: number;
  total: number;
  logistica: string;
}

/* ───── Helpers ───── */

function mapOrden(orden: PGOrder, item: PGItem): OrdenMapped {
  return {
    canal: "banva",
    orderId: orden.externalId,
    fecha: orden.datetime,
    producto: item.product.name,
    sku: item.product.sku,
    cantidad: item.quantity,
    precioUnitario: item.unitPrice?.cents ?? 0,
    subtotal: item.total?.cents ?? 0,
    comisionUnitaria: item.unitSalesFee?.cents ?? 0,
    comisionTotal: item.commission?.cents ?? 0,
    estado: orden.status === "paid" ? "Pagada" : orden.status === "cancelled" ? "Cancelada" : orden.status,
    costoEnvio: item.shippingCost?.cents ?? 0,
    ingresoEnvio: item.shippingRevenue?.cents ?? 0,
    ingresoAdicionalTC: item.creditCardExtraRevenue?.cents ?? 0,
    total: item.netTotal?.cents ?? 0,
    logistica: orden.logisticType || "",
  };
}

async function fetchPage(apiKey: string, url: string): Promise<PGResponse> {
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ProfitGuard API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchAllOrders(apiKey: string, from: string, to: string): Promise<PGOrder[]> {
  const allOrders: PGOrder[] = [];

  // Estrategia 1: Con filtro de status "paid"
  const baseUrl = "https://app.profitguard.cl/api/v1/orders";
  let url = `${baseUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=paid&page=1`;

  let firstResponse: PGResponse;
  try {
    firstResponse = await fetchPage(apiKey, url);
  } catch (e) {
    throw e;
  }

  // Si no hay datos con status=paid, intentar sin filtro de status
  if (firstResponse.data.length === 0) {
    console.log("[ProfitGuard] Sin resultados con status=paid, intentando sin filtro de status");
    url = `${baseUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=1`;
    firstResponse = await fetchPage(apiKey, url);
  }

  // Si sigue vacío, intentar sin filtros de fecha (y filtrar en backend)
  let filtrarFechaBackend = false;
  if (firstResponse.data.length === 0) {
    console.log("[ProfitGuard] Sin resultados con filtros de fecha, trayendo todo");
    url = `${baseUrl}?page=1`;
    firstResponse = await fetchPage(apiKey, url);
    filtrarFechaBackend = true;
  }

  allOrders.push(...firstResponse.data);
  const totalPages = firstResponse.pagination?.pages ?? 1;

  console.log(`[ProfitGuard] Página 1/${totalPages} — ${firstResponse.data.length} órdenes`);
  if (firstResponse.data.length > 0) {
    console.log("[ProfitGuard] Ejemplo primer registro:", JSON.stringify(firstResponse.data[0], null, 2).slice(0, 500));
  }

  // Paginar el resto
  const baseForPagination = url.replace(/page=\d+/, "");
  for (let page = 2; page <= totalPages; page++) {
    await new Promise(r => setTimeout(r, 500)); // 500ms delay entre páginas
    const pageUrl = `${baseForPagination}page=${page}`;
    const pageRes = await fetchPage(apiKey, pageUrl);
    allOrders.push(...pageRes.data);
    console.log(`[ProfitGuard] Página ${page}/${totalPages} — ${pageRes.data.length} órdenes`);
  }

  // Si tuvimos que traer todo sin filtro de fecha, filtrar en backend
  if (filtrarFechaBackend && from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    return allOrders.filter(o => {
      const d = new Date(o.datetime);
      return d >= fromDate && d <= toDate;
    });
  }

  return allOrders;
}

/* ───── Route Handler ───── */
export async function GET(req: NextRequest) {
  const apiKey = process.env.PROFITGUARD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "PROFITGUARD_API_KEY no configurada" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const forceRefresh = searchParams.get("refresh") === "1";

  if (!from || !to) {
    return NextResponse.json({ error: "Parámetros 'from' y 'to' son requeridos" }, { status: 400 });
  }

  // Revisar cache en Supabase
  if (!forceRefresh) {
    try {
      const sb = getServerSupabase();
      if (sb) {
        const { data: cache } = await sb
          .from("profitguard_cache")
          .select("*")
          .eq("id", "orders")
          .single();

        if (cache) {
          const updatedAt = new Date(cache.updated_at);
          const ahora = new Date();
          const minutosDesdeCache = (ahora.getTime() - updatedAt.getTime()) / 60000;
          const mismoRango = cache.rango_desde === from && cache.rango_hasta === to;

          if (mismoRango && minutosDesdeCache < 60) {
            return NextResponse.json({
              ordenes: cache.datos,
              total: cache.cantidad_ordenes,
              cached: true,
              cached_at: cache.updated_at,
              minutos_cache: Math.round(minutosDesdeCache),
            });
          }
        }
      }
    } catch (e) {
      console.log("[ProfitGuard] Cache no disponible:", e);
    }
  }

  // Fetch desde ProfitGuard API
  try {
    const rawOrders = await fetchAllOrders(apiKey, from, to);
    console.log(`[ProfitGuard] ${rawOrders.length} órdenes obtenidas`);

    // Expandir órdenes a filas por item
    const ordenes: OrdenMapped[] = [];
    for (const orden of rawOrders) {
      if (!orden.orderItems || orden.orderItems.length === 0) continue;
      for (const item of orden.orderItems) {
        if (!item.product?.sku) continue;
        ordenes.push(mapOrden(orden, item));
      }
    }

    console.log(`[ProfitGuard] ${ordenes.length} filas (items) de ${rawOrders.length} órdenes`);

    // Guardar en cache
    try {
      const sb = getServerSupabase();
      if (sb) {
        await sb.from("profitguard_cache").upsert({
          id: "orders",
          datos: ordenes,
          rango_desde: from,
          rango_hasta: to,
          cantidad_ordenes: ordenes.length,
          updated_at: new Date().toISOString(),
        }, { onConflict: "id" });
      }
    } catch (e) {
      console.log("[ProfitGuard] Error guardando cache:", e);
    }

    return NextResponse.json({
      ordenes,
      total: ordenes.length,
      total_raw: rawOrders.length,
      cached: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[ProfitGuard] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
