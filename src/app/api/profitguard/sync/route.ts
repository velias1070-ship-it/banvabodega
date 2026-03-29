import { NextResponse } from "next/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/profitguard/sync
 * Cron: sincroniza últimas 6 semanas de órdenes desde ProfitGuard → orders_history.
 * Divide en chunks de 14 días para no sobrecargar la API.
 */
export async function GET() {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 42); // 6 semanas

  // Dividir en chunks de 14 días
  const chunks: { from: string; to: string }[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + 13);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({
      from: cursor.toISOString().slice(0, 10),
      to: actualEnd.toISOString().slice(0, 10),
    });
    cursor.setTime(actualEnd.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }

  const totales = { nuevas: 0, actualizadas: 0, sinCambio: 0, total: 0, chunks: chunks.length, errores: 0 };

  for (const chunk of chunks) {
    try {
      // 1. Fetch desde ProfitGuard
      const res = await fetch(`${baseUrl}/api/profitguard/orders?from=${chunk.from}&to=${chunk.to}`);
      if (!res.ok) {
        console.error(`[PG Sync] Error chunk ${chunk.from}→${chunk.to}: ${res.status}`);
        totales.errores++;
        continue;
      }
      const json = await res.json();
      if (!json.ordenes || json.ordenes.length === 0) continue;

      // 2. Persistir
      const importRes = await fetch(`${baseUrl}/api/orders/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ordenes: json.ordenes, fuente: "cron" }),
      });
      const importJson = await importRes.json();
      if (importJson) {
        totales.nuevas += importJson.nuevas || 0;
        totales.actualizadas += importJson.actualizadas || 0;
        totales.sinCambio += importJson.sinCambio || 0;
        totales.total += importJson.total || 0;
      }
    } catch (err) {
      console.error(`[PG Sync] Error chunk ${chunk.from}→${chunk.to}:`, err);
      totales.errores++;
    }
  }

  console.log(`[PG Sync] Completado: ${totales.nuevas} nuevas, ${totales.actualizadas} actualizadas, ${totales.total} total`);
  return NextResponse.json(totales);
}
