import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/sii/bhe-rec
 * Body: { periodo }
 * Descarga BHE recibidas del SII via Railway.
 */

export const maxDuration = 120;

const SII_SERVER_URL = process.env.SII_SERVER_URL || "https://rcv-sii-server-production.up.railway.app";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { periodo } = body as { periodo: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "periodo debe ser YYYYMM" }, { status: 400 });
    }

    let result: Record<string, unknown> | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
        const resp = await fetch(
          `${SII_SERVER_URL}/sync-bhe-recibidas?periodo=${periodo}&key=${SII_API_KEY}`,
          { signal: AbortSignal.timeout(100000) }
        );
        result = await resp.json();
        if (result!.status !== "error") break;
        lastErr = String(result!.error || "");
        if (!lastErr.includes("SSL") && !lastErr.includes("Max retries")) break;
        result = null;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!lastErr.includes("SSL") && !lastErr.includes("Max retries")) break;
      }
    }

    if (!result) {
      return NextResponse.json({ error: lastErr || "Error tras 3 intentos" }, { status: 500 });
    }

    if (result.status === "error") {
      return NextResponse.json({ error: result.error, log: result.log }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      periodo,
      registros: result.honorarios || 0,
      data: result.boletas || [],
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
  }
}
