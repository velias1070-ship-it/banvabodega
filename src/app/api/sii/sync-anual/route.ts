import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

const SII_SERVER_URL = process.env.SII_SERVER_URL || "http://localhost:8080";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";

/**
 * POST /api/sii/sync-anual
 * Sincroniza compras y/o ventas de todos los meses de un año.
 * Body: { anio: 2025, tipo: "compras" | "ventas" | "ambos", desde_mes?: 1, hasta_mes?: 12 }
 * Procesa mes a mes en secuencia para no sobrecargar Railway.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { anio, tipo = "compras", desde_mes = 1, hasta_mes = 12 } = body as {
      anio: number;
      tipo?: string;
      desde_mes?: number;
      hasta_mes?: number;
    };

    if (!anio || anio < 2020 || anio > 2030) {
      return NextResponse.json({ error: "Año inválido" }, { status: 400 });
    }

    const resultados: { periodo: string; compras: number; ventas: number; error?: string }[] = [];
    let totalCompras = 0;
    let totalVentas = 0;

    for (let mes = desde_mes; mes <= hasta_mes; mes++) {
      const periodo = `${anio}${String(mes).padStart(2, "0")}`;
      try {
        const siiUrl = `${SII_SERVER_URL}/sync-supabase?periodo=${periodo}&tipo=${tipo}&key=${SII_API_KEY}`;
        console.log(`[SII Anual] Sincronizando ${periodo} (${tipo})...`);

        const siiRes = await fetch(siiUrl, { signal: AbortSignal.timeout(120000) });
        if (!siiRes.ok) {
          const errText = await siiRes.text();
          resultados.push({ periodo, compras: 0, ventas: 0, error: `HTTP ${siiRes.status}: ${errText.slice(0, 100)}` });
          continue;
        }

        const data = await siiRes.json();
        if (data.status === "error") {
          resultados.push({ periodo, compras: 0, ventas: 0, error: data.error });
          continue;
        }

        const c = data.compras || 0;
        const v = data.ventas || 0;
        totalCompras += c;
        totalVentas += v;
        resultados.push({ periodo, compras: c, ventas: v });
        console.log(`[SII Anual] ${periodo}: ${c} compras, ${v} ventas`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resultados.push({ periodo, compras: 0, ventas: 0, error: msg.includes("timeout") ? "Timeout" : msg });
        console.error(`[SII Anual] Error ${periodo}:`, msg);
      }
    }

    return NextResponse.json({
      anio,
      tipo,
      total_compras: totalCompras,
      total_ventas: totalVentas,
      meses: resultados,
    });
  } catch (err) {
    console.error("[SII Anual] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
