import { NextRequest, NextResponse } from "next/server";
import { syncStockFull } from "@/lib/ml";
import { getBaseUrl } from "@/lib/base-url";

export const maxDuration = 300;

/**
 * GET /api/ml/sync-stock-full
 * Vercel cron handler — sincroniza stock Full y dispara recálculo.
 */
export async function GET() {
  try {
    console.log("[sync-stock-full] Cron: Iniciando sincronización...");
    const result = await syncStockFull();

    if (result.stock_actualizado > 0) {
      try {
        const baseUrl = getBaseUrl();
        await fetch(`${baseUrl}/api/intelligence/recalcular`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full: true }),
        });
        console.log("[sync-stock-full] Cron: Recálculo de inteligencia disparado");
      } catch (err) {
        console.error("[sync-stock-full] Cron: Error disparando recálculo:", err);
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[sync-stock-full] Cron error:", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/ml/sync-stock-full
 * Sincroniza stock Full desde ML API → stock_full_cache.
 * Opcionalmente dispara recálculo de inteligencia.
 */
export async function POST(req: NextRequest) {
  let body: { recalcular?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  // Por defecto recalcular=true para que inteligencia se actualice siempre.
  // El cron pasa recalcular=false porque hace su propio recálculo con snapshot.
  const shouldRecalc = body.recalcular !== false;

  try {
    console.log("[sync-stock-full] Iniciando sincronización...");
    const result = await syncStockFull();

    // Disparar recálculo de inteligencia cuando hay cambios de stock
    if (shouldRecalc && result.stock_actualizado > 0) {
      try {
        const baseUrl = getBaseUrl();

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
