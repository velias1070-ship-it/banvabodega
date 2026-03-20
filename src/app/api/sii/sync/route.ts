/**
 * API Route: /api/sii/sync
 *
 * Importa datos del SII (compras y/o ventas) para un periodo dado.
 * Flujo simplificado: Railway hace TODO (SII → parseo → Supabase)
 *
 * POST body: { periodo: "YYYYMM", tipo: "compras" | "ventas" | "ambos" }
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300; // 5 minutos (Vercel Pro)

// URL del servidor RCV SII (Railway)
const SII_SERVER_URL = process.env.SII_SERVER_URL || "http://localhost:8080";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";

async function syncTipo(periodo: string, tipo: string, soloRegistro = false): Promise<{ compras: number; ventas: number; log?: string[] }> {
  const siiUrl = `${SII_SERVER_URL}/sync-supabase?periodo=${periodo}&tipo=${tipo}&key=${SII_API_KEY}${soloRegistro ? "&solo_registro=true" : ""}`;
  console.log(`[SII Sync] Llamando a Railway: periodo=${periodo} tipo=${tipo} solo_registro=${soloRegistro}`);

  const siiRes = await fetch(siiUrl, { signal: AbortSignal.timeout(240000) }); // 4 min timeout
  if (!siiRes.ok) {
    const errText = await siiRes.text();
    throw new Error(`Error del servidor SII: ${siiRes.status} ${errText.slice(0, 300)}`);
  }

  const result = await siiRes.json();
  if (result.status === "error") {
    throw new Error(`SII error: ${result.error}`);
  }
  return result;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { periodo, tipo = "ambos", solo_registro = false } = body as { periodo?: string; tipo?: string; solo_registro?: boolean };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }
    if (!["compras", "ventas", "ambos"].includes(tipo)) {
      return NextResponse.json({ error: "Tipo debe ser: compras, ventas, ambos" }, { status: 400 });
    }

    if (tipo === "ambos") {
      const resCompras = await syncTipo(periodo, "compras", solo_registro);
      const resVentas = await syncTipo(periodo, "ventas", solo_registro);
      const result = {
        compras: resCompras.compras || 0,
        ventas: resVentas.ventas || 0,
        log: [...(resCompras.log || []), ...(resVentas.log || [])],
      };
      console.log(`[SII Sync] OK — compras: ${result.compras}, ventas: ${result.ventas}`);
      return NextResponse.json(result);
    }

    const result = await syncTipo(periodo, tipo, solo_registro);
    console.log(`[SII Sync] OK — compras: ${result.compras || 0}, ventas: ${result.ventas || 0}`);
    return NextResponse.json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SII Sync] Error:", msg);
    if (msg.includes("timeout") || msg.includes("abort")) {
      return NextResponse.json(
        { error: "Timeout: el servidor SII tardó más de 4 minutos. Intenta sincronizar compras y ventas por separado." },
        { status: 504 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
