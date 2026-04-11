import { NextRequest, NextResponse } from "next/server";

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

export const maxDuration = 30;

interface MPReport {
  id: number;
  file_name: string;
  status: string;
  begin_date: string;
  end_date: string;
}

/**
 * POST /api/mp/check-report
 * Body: { periodo: "YYYYMM" }
 * Verifica si hay un release report listo para el período (status enabled/processed)
 * o uno pendiente.
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
    const desdeDate = new Date(`${anio}-${String(mes).padStart(2, "0")}-01T03:00:00Z`).getTime();
    const nextMonth = mes === 12 ? 1 : mes + 1;
    const nextYear = mes === 12 ? anio + 1 : anio;
    const hastaDate = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T02:59:59Z`).getTime();

    const res = await fetch(`${MP_BASE_URL}/v1/account/release_report/list`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      return NextResponse.json({ error: `MP API ${res.status}` }, { status: 500 });
    }

    const all = await res.json() as MPReport[];

    // Filtrar reportes que cubren el período
    const overlapping = (all || []).filter(r => {
      const rBegin = new Date(r.begin_date).getTime();
      const rEnd = new Date(r.end_date).getTime();
      return rEnd >= desdeDate && rBegin <= hastaDate;
    });

    const listos = overlapping.filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name?.endsWith(".csv"));
    const pendientes = overlapping.filter(r => r.status === "pending");

    return NextResponse.json({
      ok: true,
      listos: listos.length,
      pendientes: pendientes.length,
      reportes_listos: listos.map(r => ({ file_name: r.file_name, end_date: r.end_date })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
