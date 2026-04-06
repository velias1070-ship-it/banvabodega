import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/sii/bhe
 * Body: { periodo }
 * Descarga BTE del SII via Railway (que no está bloqueado por IP).
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

    console.log(`[BHE] Llamando Railway /sync-bte periodo=${periodo}`);

    let result: Record<string, unknown> | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
        const resp = await fetch(
          `${SII_SERVER_URL}/sync-bte?periodo=${periodo}&key=${SII_API_KEY}`,
          { signal: AbortSignal.timeout(100000) }
        );
        result = await resp.json();
        if (result!.status !== "error") break;
        lastErr = String(result!.error || "");
        if (!lastErr.includes("SSL") && !lastErr.includes("Max retries")) break;
        console.warn(`[BHE] Intento ${attempt + 1} falló (SSL), reintentando...`);
        result = null;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (!lastErr.includes("SSL") && !lastErr.includes("Max retries")) break;
        console.warn(`[BHE] Intento ${attempt + 1} falló: ${lastErr}`);
      }
    }

    if (!result) {
      return NextResponse.json({ error: lastErr || "Error tras 3 intentos" }, { status: 500 });
    }

    if (result.status === "error") {
      console.error(`[BHE] Railway error: ${result.error}`);
      return NextResponse.json({ error: result.error, log: result.log }, { status: 500 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boletas = (result as any).boletas || [];
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
      evento_receptor: "BTE",
    }));

    console.log(`[BHE] ${data.length} BTE importadas`);

    return NextResponse.json({ ok: true, periodo, registros: data.length, data });
  } catch (err) {
    console.error("[BHE] Error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
  }
}
