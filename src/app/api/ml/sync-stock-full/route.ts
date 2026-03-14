import { NextRequest, NextResponse } from "next/server";
import { syncStockFull } from "@/lib/ml";

export const maxDuration = 120;

/**
 * POST /api/ml/sync-stock-full
 * Sincroniza stock Full desde ML API → stock_full_cache.
 * Opcionalmente dispara recálculo de inteligencia.
 */
export async function POST(req: NextRequest) {
  let body: { recalcular?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  try {
    console.log("[sync-stock-full] Iniciando sincronización...");
    const result = await syncStockFull();

    // Disparar recálculo incremental si se pidió
    if (body.recalcular && result.stock_actualizado > 0) {
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";

        await fetch(`${baseUrl}/api/intelligence/recalcular`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: true }),
        });
        console.log("[sync-stock-full] Recálculo de inteligencia disparado");
      } catch (err) {
        console.error("[sync-stock-full] Error disparando recálculo:", err);
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[sync-stock-full] Error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
