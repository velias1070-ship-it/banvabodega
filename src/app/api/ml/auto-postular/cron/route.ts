import { NextRequest, NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/base-url";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/ml/auto-postular/cron
 *
 * Wrapper para cron Vercel: ejecuta auto-postular en modo apply, scope
 * auto_postular_only (solo SKUs con productos.auto_postular=true) y limit
 * conservador. Reusa POST /api/ml/auto-postular para no duplicar logica.
 *
 * Auth: header Authorization: Bearer ${CRON_SECRET} (Vercel cron lo envia
 * automaticamente) o ?manual=1 desde el panel admin.
 *
 * Manual: BANVA_Pricing_Investigacion_Comparada §6.1 (apply-only-flagged es
 * el switch suave que permite escalar el motor SKU por SKU sin riesgo).
 */
function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization");
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isLocalDev = process.env.NODE_ENV === "development";
  const isManualTrigger = req.nextUrl.searchParams.get("manual") === "1";
  return isVercelCron || isLocalDev || isManualTrigger;
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const start = Date.now();
  const baseUrl = getBaseUrl();
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "50", 10), 200);

  try {
    const resp = await fetch(`${baseUrl}/api/ml/auto-postular`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modo: "apply",
        scope: "auto_postular_only",
        limit,
      }),
    });
    const json = await resp.json().catch(() => ({}));
    return NextResponse.json({
      ok: resp.ok,
      status: resp.status,
      duration_ms: Date.now() - start,
      result: json,
    }, { status: resp.ok ? 200 : 502 });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      duration_ms: Date.now() - start,
      error: errMsg,
    }, { status: 500 });
  }
}
