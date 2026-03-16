/**
 * API Route: /api/sii/sync
 *
 * Importa datos del SII (compras y/o ventas) para un periodo dado.
 * Flujo simplificado: Railway hace TODO (SII → parseo → Supabase)
 *
 * POST body: { periodo: "YYYYMM", tipo: "compras" | "ventas" | "ambos" }
 */

import { NextRequest, NextResponse } from "next/server";

// URL del servidor RCV SII (Railway)
const SII_SERVER_URL = process.env.SII_SERVER_URL || "http://localhost:8080";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { periodo, tipo = "ambos" } = body as { periodo?: string; tipo?: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }
    if (!["compras", "ventas", "ambos"].includes(tipo)) {
      return NextResponse.json({ error: "Tipo debe ser: compras, ventas, ambos" }, { status: 400 });
    }

    // Llamar a Railway — hace todo: SII auth → descarga → parseo → Supabase upsert
    const siiUrl = `${SII_SERVER_URL}/sync-supabase?periodo=${periodo}&tipo=${tipo}&key=${SII_API_KEY}`;
    console.log(`[SII Sync] Llamando a ${SII_SERVER_URL}/sync-supabase periodo=${periodo} tipo=${tipo}`);

    const siiRes = await fetch(siiUrl, { signal: AbortSignal.timeout(180000) }); // 3 min timeout
    if (!siiRes.ok) {
      const errText = await siiRes.text();
      return NextResponse.json(
        { error: `Error del servidor SII: ${siiRes.status} ${errText.slice(0, 300)}` },
        { status: 502 }
      );
    }

    const result = await siiRes.json();
    if (result.status === "error") {
      return NextResponse.json(
        { error: `SII error: ${result.error}`, log: result.log || [] },
        { status: 502 }
      );
    }

    console.log(`[SII Sync] OK — compras: ${result.compras}, ventas: ${result.ventas}`);
    return NextResponse.json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SII Sync] Error:", msg);
    if (msg.includes("timeout") || msg.includes("abort")) {
      return NextResponse.json(
        { error: "Timeout: el servidor SII tardó más de 3 minutos. Intenta de nuevo." },
        { status: 504 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
