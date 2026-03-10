import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/* ───── Tipos ───── */
interface ProfitGuardOrder {
  // Campos que probablemente devuelve la API (basados en el Excel)
  [key: string]: unknown;
}

interface OrdenMapped {
  sku: string;
  cantidad: number;
  fecha: string; // ISO string
  canal: "full" | "flex";
  subtotal: number;
  comisionTotal: number;
  costoEnvio: number;
  ingresoEnvio: number;
}

/* ───── Helpers ───── */

/** Busca un valor en un objeto con múltiples posibles keys (case-insensitive) */
function findField(obj: Record<string, unknown>, ...patterns: string[]): unknown {
  const keys = Object.keys(obj);
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    const found = keys.find(k => k.toLowerCase().includes(p));
    if (found !== undefined) return obj[found];
  }
  return undefined;
}

function mapOrden(raw: ProfitGuardOrder): OrdenMapped | null {
  const obj = raw as Record<string, unknown>;

  // Estado: solo "Pagada"
  const estado = String(findField(obj, "estado", "status") || "").trim();
  if (estado !== "Pagada" && estado !== "pagada") return null;

  // SKU
  const sku = String(findField(obj, "sku") || "").trim();
  if (!sku) return null;

  // Cantidad
  const cantidad = Number(findField(obj, "cantidad", "quantity", "qty") || 0);
  if (cantidad <= 0) return null;

  // Fecha
  const fechaRaw = findField(obj, "fecha", "date", "created_at", "order_date");
  if (!fechaRaw) return null;
  const fecha = new Date(String(fechaRaw));
  if (isNaN(fecha.getTime())) return null;

  // Logística → canal
  const logistica = String(findField(obj, "logistic", "logística", "tipo_logistic", "logistics_type", "tipo logistic") || "").trim().toLowerCase();
  const canal: "full" | "flex" = (logistica === "fulfillment" || logistica === "xd_drop_off") ? "full" : "flex";

  // Campos financieros
  const subtotal = Number(findField(obj, "subtotal") || 0);
  const comisionTotal = Number(findField(obj, "comision_total", "comision total", "comision", "commission") || 0);
  const costoEnvio = Number(findField(obj, "costo_envio", "costo envío", "costo envio", "shipping_cost") || 0);
  const ingresoEnvio = Number(findField(obj, "ingreso_envio", "ingreso envío", "ingreso envio", "shipping_income") || 0);

  return { sku, cantidad, fecha: fecha.toISOString(), canal, subtotal, comisionTotal, costoEnvio, ingresoEnvio };
}

async function fetchAllOrders(apiKey: string, from: string, to: string): Promise<ProfitGuardOrder[]> {
  const allOrders: ProfitGuardOrder[] = [];
  let page = 1;
  const limit = 500;
  let hasMore = true;

  while (hasMore) {
    const url = new URL("https://app.profitguard.cl/api/v1/orders");
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ProfitGuard API error ${res.status}: ${text}`);
    }

    const body = await res.json();

    // La API puede devolver un array directo o un objeto con data/orders/results
    let orders: ProfitGuardOrder[];
    if (Array.isArray(body)) {
      orders = body;
    } else if (body.data && Array.isArray(body.data)) {
      orders = body.data;
    } else if (body.orders && Array.isArray(body.orders)) {
      orders = body.orders;
    } else if (body.results && Array.isArray(body.results)) {
      orders = body.results;
    } else {
      // Log la estructura para debug
      console.log("[ProfitGuard] Respuesta inesperada, keys:", Object.keys(body));
      // Intentar usar el body completo si parece ser un solo objeto
      orders = [];
      hasMore = false;
      break;
    }

    allOrders.push(...orders);

    // Detectar si hay más páginas
    if (orders.length < limit) {
      hasMore = false;
    } else {
      page++;
      // Rate limit: esperar 1 segundo entre páginas
      await new Promise(r => setTimeout(r, 1000));
    }

    // Log primera respuesta para debug
    if (page === 2 && orders.length > 0) {
      console.log("[ProfitGuard] Ejemplo de orden (primer registro):", JSON.stringify(orders[0], null, 2));
    }
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
    console.log(`[ProfitGuard] ${rawOrders.length} órdenes raw obtenidas`);

    // Log primer registro para debug de mapeo
    if (rawOrders.length > 0) {
      console.log("[ProfitGuard] Keys del primer registro:", Object.keys(rawOrders[0] as Record<string, unknown>));
    }

    // Mapear al formato del WMS
    const ordenes: OrdenMapped[] = [];
    for (const raw of rawOrders) {
      const mapped = mapOrden(raw);
      if (mapped) ordenes.push(mapped);
    }

    console.log(`[ProfitGuard] ${ordenes.length} órdenes mapeadas (de ${rawOrders.length} raw)`);

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
