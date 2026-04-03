import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/sii/bhe
 * Body: { rut, clave, periodo }
 * Descarga BHE recibidas del SII via Railway (Playwright headless browser).
 * El SII no acepta auth desde IPs de datacenter (Vercel), así que
 * delegamos a Railway que usa Playwright para simular un navegador real.
 */

export const maxDuration = 120;

const SII_SERVER_URL = process.env.SII_SERVER_URL || "https://rcv-sii-server-production.up.railway.app";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { rut: rutCompleto, clave, periodo } = body as { rut: string; clave: string; periodo: string };

    if (!rutCompleto || !clave || !periodo) {
      return NextResponse.json({ error: "Faltan parámetros: rut, clave, periodo" }, { status: 400 });
    }
    if (!/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "periodo debe ser YYYYMM" }, { status: 400 });
    }

    // Llamar a Railway que tiene Playwright
    const params = new URLSearchParams({
      periodo,
      rut_persona: rutCompleto,
      clave,
      key: SII_API_KEY,
    });

    console.log(`[BHE] Llamando a Railway: periodo=${periodo} rut=${rutCompleto}`);

    const resp = await fetch(`${SII_SERVER_URL}/scrape-bhe?${params.toString()}`, {
      signal: AbortSignal.timeout(100000), // 100s timeout
    });

    const result = await resp.json();

    if (result.status === "error") {
      console.error(`[BHE] Railway error: ${result.error}`);
      return NextResponse.json({ error: result.error, log: result.log }, { status: 500 });
    }

    // Railway ya guardó en Supabase, retornar datos para que el frontend muestre
    const boletas = result.boletas || [];
    const data = boletas.map((b: { nro_boleta: string; rut_emisor: string; nombre_emisor: string; fecha: string; monto_bruto: number; retencion: number; monto_liquido: number }) => ({
      periodo,
      estado: "REGISTRO",
      tipo_doc: 71,
      nro_doc: b.nro_boleta,
      rut_proveedor: b.rut_emisor,
      razon_social: b.nombre_emisor,
      fecha_docto: b.fecha,
      monto_exento: 0,
      monto_neto: b.monto_bruto,
      monto_iva: b.retencion,
      monto_total: b.monto_liquido,
      fecha_recepcion: b.fecha,
      evento_receptor: "BHE",
    }));

    console.log(`[BHE] ${data.length} BHE importadas`);

    return NextResponse.json({
      ok: true,
      periodo,
      registros: data.length,
      data,
      log: result.log,
    });
  } catch (err) {
    console.error("[BHE] Error:", err);
    const msg = err instanceof Error ? err.message : "Error consultando BHE";
    if (msg.includes("timeout") || msg.includes("abort")) {
      return NextResponse.json({ error: "Timeout: el scraper tardó demasiado. Intenta de nuevo." }, { status: 504 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
