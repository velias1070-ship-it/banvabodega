import { NextRequest, NextResponse } from "next/server";
import { mlGet } from "@/lib/ml";
import { upsertOrderToVentasCache } from "@/lib/ventas-cache";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get("ids") || "").split(",").filter(Boolean);
  const results: Array<{ id: string; status: string; inserted: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const order = await mlGet<any>(`/orders/${id}`);
      if (!order) { results.push({ id, status: "null", inserted: false, error: "order not found" }); continue; }
      const estadoMap: Record<string, string> = { cancelled: "Cancelada", partially_refunded: "Parcialmente reembolsada", paid: "Pagada" };
      const estado = estadoMap[order.status] || "Pagada";
      const ok = await upsertOrderToVentasCache(order, { estado });
      results.push({ id, status: order.status, inserted: ok });
    } catch (e) {
      results.push({ id, status: "error", inserted: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results });
}
