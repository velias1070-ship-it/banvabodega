import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const PG_API = "https://app.profitguard.cl/api/v1/orders";

interface PGOrderItem {
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
  orderItems: PGOrderItem[];
}

interface PGResponse {
  data?: PGOrder[];
  items?: PGOrder[];
  pagination?: { page: number; page_size: number; pages: number; count: number };
  meta?: { currentPage?: number; current_page?: number; totalPages?: number; total_pages?: number; totalItems?: number; total_count?: number };
}

function mapEstado(status: string): string {
  switch (status) {
    case "paid": return "Pagada";
    case "cancelled": return "Cancelada";
    default: return status;
  }
}

function mapCanal(logisticType: string): string {
  if (logisticType === "fulfillment" || logisticType === "xd_drop_off") return "Full";
  return "Flex";
}

async function fetchPage(apiKey: string, url: string): Promise<PGResponse> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ProfitGuard API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchAllPages(apiKey: string, baseUrl: string): Promise<PGOrder[]> {
  const allOrders: PGOrder[] = [];
  const sep = baseUrl.includes("?") ? "&" : "?";

  const firstResponse = await fetchPage(apiKey, `${baseUrl}${sep}page=1`);
  // Support both old format (data) and new format (items)
  const firstItems = firstResponse.items || firstResponse.data;
  if (!firstItems || !Array.isArray(firstItems)) {
    console.error("[ProfitGuard] Respuesta inesperada — ni items ni data es array:", JSON.stringify(firstResponse).slice(0, 500));
    return [];
  }
  allOrders.push(...firstItems);
  const totalPages = firstResponse.meta?.totalPages ?? firstResponse.meta?.total_pages ?? firstResponse.pagination?.pages ?? 1;
  const totalCount = firstResponse.meta?.totalItems ?? firstResponse.meta?.total_count ?? firstResponse.pagination?.count ?? firstItems.length;

  console.log(`[ProfitGuard] Página 1/${totalPages} — ${firstItems.length} órdenes (total: ${totalCount})`);

  let page = 2;
  while (page <= totalPages) {
    await new Promise(r => setTimeout(r, 100));
    const pageRes = await fetchPage(apiKey, `${baseUrl}${sep}page=${page}`);
    const pageItems = pageRes.items || pageRes.data;
    if (!pageItems || !Array.isArray(pageItems)) {
      console.error(`[ProfitGuard] Página ${page} respuesta inválida, abortando paginación`);
      break;
    }
    allOrders.push(...pageItems);
    console.log(`[ProfitGuard] Página ${page}/${totalPages} — ${pageItems.length} órdenes`);
    page++;
  }

  return allOrders;
}

async function fetchOrders(apiKey: string, from: string, to: string): Promise<PGOrder[]> {
  // ProfitGuard requires datetime format: YYYY-MM-DDTHH:mm
  const fromDT = from.includes("T") ? from : `${from}T00:00`;
  const toDT = to.includes("T") ? to : `${to}T23:59`;
  const url = `${PG_API}?from=${encodeURIComponent(fromDT)}&to=${encodeURIComponent(toDT)}&status=paid`;
  let orders = await fetchAllPages(apiKey, url);

  if (orders.length > 0) {
    // Verificar si la API realmente aplicó el filtro de fechas
    const fechas = orders.map(o => new Date(o.datetime).getTime());
    const minFecha = new Date(Math.min(...fechas));
    const fromDate = new Date(from);
    const diffDays = (minFecha.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 7) {
      console.log(`[ProfitGuard] API ignoró filtro de fechas (diff ${Math.round(diffDays)}d). Filtrando en backend.`);
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      orders = orders.filter(o => {
        const d = new Date(o.datetime);
        return d >= fromDate && d <= toDate;
      });
    }
    return orders;
  }

  // Fallback: sin filtro de fechas, filtrar en backend
  console.log("[ProfitGuard] Sin resultados con fechas, trayendo todo");
  orders = await fetchAllPages(apiKey, `${PG_API}?status=paid`);
  if (orders.length > 0) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    const before = orders.length;
    orders = orders.filter(o => {
      const d = new Date(o.datetime);
      return d >= fromDate && d <= toDate;
    });
    console.log(`[ProfitGuard] Filtrado backend: ${before} → ${orders.length}`);
  }

  return orders;
}

interface MappedOrder {
  order_id: string;
  order_number: string;
  fecha: string;
  sku_venta: string;
  nombre_producto: string;
  cantidad: number;
  canal: string;
  precio_unitario: number;
  subtotal: number;
  comision_unitaria: number;
  comision_total: number;
  costo_envio: number;
  ingreso_envio: number;
  ingreso_adicional_tc: number;
  total: number;
  logistic_type: string;
  estado: string;
  fuente: string;
}

function mapOrders(rawOrders: PGOrder[]): MappedOrder[] {
  const mapped: MappedOrder[] = [];
  for (const order of rawOrders) {
    if (!order.orderItems || order.orderItems.length === 0) continue;
    for (const item of order.orderItems) {
      if (!item.product?.sku) continue;
      mapped.push({
        order_id: order.externalId,
        order_number: order.externalNumber,
        fecha: order.datetime,
        sku_venta: item.product.sku,
        nombre_producto: item.product.name,
        cantidad: item.quantity,
        canal: mapCanal(order.logisticType),
        precio_unitario: item.unitPrice?.cents ?? 0,
        subtotal: item.total?.cents ?? 0,
        comision_unitaria: item.unitSalesFee?.cents ?? 0,
        comision_total: item.commission?.cents ?? 0,
        costo_envio: item.shippingCost?.cents ?? 0,
        ingreso_envio: item.shippingRevenue?.cents ?? 0,
        ingreso_adicional_tc: item.creditCardExtraRevenue?.cents ?? 0,
        total: item.netTotal?.cents ?? 0,
        logistic_type: order.logisticType || "",
        estado: mapEstado(order.status),
        fuente: "api",
      });
    }
  }
  return mapped;
}

/* ───── Route Handler ───── */
export async function GET(req: NextRequest) {
  const apiKey = process.env.PROFITGUARD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "PROFITGUARD_API_KEY no configurada" }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "Parámetros 'from' y 'to' son requeridos" }, { status: 400 });
  }

  try {
    // Debug: test raw API response
    const debug = searchParams.get("debug") === "1";
    if (debug) {
      const fromDT = from.includes("T") ? from : `${from}T00:00`;
      const toDT = to.includes("T") ? to : `${to}T23:59`;
      const testUrl = `${PG_API}?from=${encodeURIComponent(fromDT)}&to=${encodeURIComponent(toDT)}&status=paid&page=1`;
      const res = await fetch(testUrl, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      const text = await res.text();
      // Show pagination info from response
      let pgMeta = null;
      try {
        const parsed = JSON.parse(text);
        pgMeta = { keys: Object.keys(parsed), meta: parsed.meta || null, pagination: parsed.pagination || null, items_count: Array.isArray(parsed.items) ? parsed.items.length : (Array.isArray(parsed.data) ? parsed.data.length : null) };
      } catch { /* ignore */ }
      return NextResponse.json({ debug_url: testUrl, status: res.status, pg_meta: pgMeta });
    }

    const rawOrders = await fetchOrders(apiKey, from, to);
    console.log(`[ProfitGuard] ${rawOrders.length} órdenes obtenidas para ${from} → ${to}`);

    const ordenes = mapOrders(rawOrders);
    console.log(`[ProfitGuard] ${ordenes.length} filas (items) de ${rawOrders.length} órdenes`);

    return NextResponse.json({
      ordenes,
      total: ordenes.length,
      total_raw: rawOrders.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error desconocido";
    console.error("[ProfitGuard] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
