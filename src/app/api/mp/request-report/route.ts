import { NextRequest, NextResponse } from "next/server";

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

export const maxDuration = 30;

/**
 * POST /api/mp/request-report
 * Body: { periodo: "YYYYMM" }
 * Solicita a MercadoPago que genere un release report para el período.
 * Retorna inmediatamente sin esperar a que el reporte esté listo.
 */
export async function POST(req: NextRequest) {
  if (!MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: "MP_ACCESS_TOKEN no configurado" }, { status: 500 });
  }

  try {
    const body = await req.json();
    const { periodo } = body as { periodo: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }

    const anio = parseInt(periodo.slice(0, 4));
    const mes = parseInt(periodo.slice(4, 6));
    // Inicio del mes en UTC (Chile = -04/-03, por eso T03:00:00Z)
    const mesStr = String(mes).padStart(2, "0");
    const fechaDesde = `${anio}-${mesStr}-01T03:00:00Z`;
    const nextMonth = mes === 12 ? 1 : mes + 1;
    const nextYear = mes === 12 ? anio + 1 : anio;
    const fechaHasta = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T02:59:59Z`;

    const res = await fetch(`${MP_BASE_URL}/v1/account/release_report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ begin_date: fechaDesde, end_date: fechaHasta }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 409 || errBody.includes("already")) {
        return NextResponse.json({
          ok: true,
          mensaje: "Ya hay un reporte en generación para este período. Espera 2-5 min y reintenta Sync MP.",
        });
      }
      return NextResponse.json({
        error: `MP API ${res.status}: ${errBody.slice(0, 200)}`,
      }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      mensaje: `Reporte solicitado a MercadoPago para ${mesStr}/${anio}. Espera 2-5 min y presiona Sync MP nuevamente.`,
    });
  } catch (err) {
    console.error("[MP Request Report] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
