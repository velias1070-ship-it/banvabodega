import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 120; // Permitir hasta 2 min para paginar todas las páginas

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
  data: PGOrder[];
  pagination: { page: number; page_size: number; pages: number; count: number };
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

  // Página 1
  const firstResponse = await fetchPage(apiKey, `${baseUrl}&page=1`);
  allOrders.push(...firstResponse.data);
  const totalPages = firstResponse.pagination?.pages ?? 1;

  console.log(`[ProfitGuard] Página 1/${totalPages} — ${firstResponse.data.length} órdenes (total según API: ${firstResponse.pagination?.count ?? "?"})`);

  // Todas las páginas restantes sin límite
  let page = 2;
  while (page <= totalPages) {
    await new Promise(r => setTimeout(r, 300));
    const pageRes = await fetchPage(apiKey, `${baseUrl}&page=${page}`);
    allOrders.push(...pageRes.data);
    console.log(`[ProfitGuard] Página ${page}/${totalPages} — ${pageRes.data.length} órdenes`);
    page++;
  }

  return allOrders;
}

async function fetchAllOrders(apiKey: string, from: string, to: string): Promise<PGOrder[]> {
  // Estrategia 1: Con filtro de fecha y status=paid
  const urlWithDates = `${PG_API}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&status=paid`;
  let orders = await fetchAllPages(apiKey, urlWithDates);

  if (orders.length > 0) {
    // Verificar si las fechas realmente se aplicaron
    const fechas = orders.map(o => new Date(o.datetime).getTime());
    const minFecha = new Date(Math.min(...fechas));
    const maxFecha = new Date(Math.max(...fechas));
    const fromDate = new Date(from);
    console.log(`[ProfitGuard] Rango solicitado: ${from} a ${to}`);
    console.log(`[ProfitGuard] Rango recibido: ${minFecha.toISOString().slice(0,10)} a ${maxFecha.toISOString().slice(0,10)}`);

    // Si la fecha mínima recibida es mucho más reciente que la solicitada, las fechas se ignoraron
    const diffDays = (minFecha.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 7) {
      console.log(`[ProfitGuard] API parece ignorar filtro de fechas (diferencia ${Math.round(diffDays)} días). Intentando sin filtro de fechas...`);
      orders = []; // Forzar fallback
    }
  }

  // Estrategia 2: Sin filtro de status
  if (orders.length === 0) {
    console.log("[ProfitGuard] Intentando sin filtro de status...");
    const urlNoStatus = `${PG_API}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    orders = await fetchAllPages(apiKey, urlNoStatus);
  }

  // Estrategia 3: Sin filtros de fecha — traer todo y filtrar en backend
  if (orders.length === 0) {
    console.log("[ProfitGuard] Sin resultados con filtros de fecha, trayendo todo sin filtros");
    const urlAll = `${PG_API}?status=paid`;
    orders = await fetchAllPages(apiKey, urlAll);

    // Filtrar en backend
    if (orders.length > 0 && from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      const before = orders.length;
      orders = orders.filter(o => {
        const d = new Date(o.datetime);
        return d >= fromDate && d <= toDate;
      });
      console.log(`[ProfitGuard] Filtrado backend: ${before} → ${orders.length} órdenes en rango ${from} a ${to}`);
    }
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

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "Parámetros 'from' y 'to' son requeridos" }, { status: 400 });
  }

  try {
    const rawOrders = await fetchAllOrders(apiKey, from, to);
    console.log(`[ProfitGuard] ${rawOrders.length} órdenes obtenidas`);

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
