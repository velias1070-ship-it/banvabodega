import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import crypto from "crypto";

export const maxDuration = 300;

const MP_BASE_URL = "https://api.mercadopago.com";
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "";

// ==================== HELPERS ====================

async function mpGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const url = `${MP_BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`MP API ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

async function mpPost(path: string, body: unknown): Promise<unknown> {
  const url = `${MP_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`MP API POST ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

async function mpGetText(path: string): Promise<string> {
  const url = `${MP_BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`MP API ${res.status}`);
  return res.text();
}

function safeDate(dt: string | null): string | null {
  if (!dt) return null;
  try { return new Date(dt).toISOString().slice(0, 10); }
  catch { return dt.slice(0, 10); }
}

function refHash(prefix: string, id: string): string {
  return crypto.createHash("sha256").update(`${prefix}_${id}`).digest("hex").slice(0, 32);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== SETTLEMENT REPORT ====================

interface MPReport {
  id: number;
  file_name: string;
  status: string;
  begin_date: string;
  end_date: string;
}

/**
 * Obtiene un settlement report procesado para el periodo.
 * Si no existe uno que cubra el periodo completo, genera uno nuevo y espera.
 */
async function getSettlementReport(fechaDesde: string, fechaHasta: string): Promise<string | null> {
  // 1. Buscar reportes existentes
  const reports = await mpGet("/v1/account/settlement_report/list", {
    begin_date: fechaDesde,
    end_date: fechaHasta,
  }) as MPReport[];

  // Buscar uno procesado que cubra hasta cerca del fin del periodo
  const hastaDate = new Date(fechaHasta).getTime();
  const processed = (reports || [])
    .filter(r => r.status === "processed" && r.file_name)
    .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());

  // Si el reporte más reciente cubre al menos hasta ayer, usarlo
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (processed.length > 0) {
    const bestEnd = new Date(processed[0].end_date).getTime();
    const now = Date.now();
    // Usar si cubre hasta ayer o si el periodo ya terminó
    if (bestEnd >= hastaDate - oneDayMs || hastaDate < now - oneDayMs) {
      return processed[0].file_name;
    }
  }

  // 2. Generar reporte nuevo
  console.log("[MP Sync] No hay reporte actualizado, generando uno nuevo...");
  const generated = await mpPost("/v1/account/settlement_report", {
    begin_date: fechaDesde,
    end_date: fechaHasta,
  }) as MPReport;

  if (!generated?.id) {
    console.error("[MP Sync] No se pudo generar el reporte");
    // Fallback: usar el mejor reporte existente si hay alguno
    return processed.length > 0 ? processed[0].file_name : null;
  }

  // 3. Polling hasta que esté procesado (max 4 minutos)
  const maxWait = 240_000;
  const pollInterval = 15_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(pollInterval);

    const updated = await mpGet("/v1/account/settlement_report/list", {
      begin_date: fechaDesde,
      end_date: fechaHasta,
    }) as MPReport[];

    const ready = (updated || []).find(r => r.id === generated.id && r.status === "processed");
    if (ready?.file_name) {
      console.log(`[MP Sync] Reporte listo: ${ready.file_name}`);
      return ready.file_name;
    }

    const pending = (updated || []).find(r => r.id === generated.id);
    console.log(`[MP Sync] Reporte ${generated.id} status: ${pending?.status || "?"} (${Math.round((Date.now() - start) / 1000)}s)`);
  }

  // Timeout: usar el mejor reporte existente como fallback
  console.warn("[MP Sync] Timeout esperando reporte nuevo, usando el mejor disponible");
  return processed.length > 0 ? processed[0].file_name : null;
}

/**
 * Parsea el CSV del settlement report y extrae retiros (PAYOUTS).
 */
function parseRetiros(csv: string, empresaId: string, cuentaBancariaId: string | null) {
  const lines = csv.split("\n");
  const rows: {
    empresa_id: string;
    banco: string;
    cuenta: null;
    fecha: string | null;
    descripcion: string;
    monto: number;
    saldo: null;
    referencia: string;
    origen: "api";
    cuenta_bancaria_id: string | null;
    referencia_unica: string;
    metadata: string;
  }[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(";");
    if (cols.length < 8) continue;
    if (cols[2] !== "PAYOUTS") continue;

    const sourceId = cols[0];
    const monto = Math.abs(parseFloat(cols[3]) || 0);
    const fecha = safeDate(cols[4]);
    if (!monto || !fecha) continue;

    rows.push({
      empresa_id: empresaId,
      banco: "MercadoPago",
      cuenta: null,
      fecha,
      descripcion: `RETIRO MP → Banco | $${monto.toLocaleString("es-CL")}`,
      monto: -monto,
      saldo: null,
      referencia: `MP-RETIRO-${sourceId}`,
      origen: "api" as const,
      cuenta_bancaria_id: cuentaBancariaId,
      referencia_unica: refHash("mp_retiro", sourceId),
      metadata: JSON.stringify({
        tipo: "retiro",
        source_id: sourceId,
        monto_retirado: monto,
      }),
    });
  }

  return rows;
}

// ==================== MAIN ====================

/**
 * POST /api/mp/sync
 * Body: { periodo: "YYYYMM" }
 * Sincroniza retiros/transferencias de MercadoPago del periodo.
 * Genera automáticamente un settlement report si no existe uno actualizado.
 */
export async function POST(req: NextRequest) {
  if (!MP_ACCESS_TOKEN) {
    return NextResponse.json({ error: "MP_ACCESS_TOKEN no configurado" }, { status: 500 });
  }

  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  try {
    const body = await req.json();
    const { periodo } = body as { periodo: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }

    const anio = parseInt(periodo.slice(0, 4));
    const mes = parseInt(periodo.slice(4, 6));
    const lastDay = new Date(anio, mes, 0).getDate();
    const fechaDesde = `${anio}-${String(mes).padStart(2, "0")}-01T00:00:00.000-03:00`;
    const fechaHasta = `${anio}-${String(mes).padStart(2, "0")}-${lastDay}T23:59:59.999-03:00`;

    // Empresa
    const { data: empresas } = await sb.from("empresas").select("id").limit(1);
    const empresaId = empresas?.[0]?.id;
    if (!empresaId) return NextResponse.json({ error: "Sin empresa" }, { status: 500 });

    // Cuenta bancaria MP
    const { data: cuentas } = await sb.from("cuentas_bancarias")
      .select("id").eq("empresa_id", empresaId).eq("banco", "MercadoPago").limit(1);
    const cuentaBancariaId = cuentas?.[0]?.id || null;

    // ══════════════════════════════════════
    // RETIROS (PAYOUTS del settlement report)
    // ══════════════════════════════════════
    let retiroRows: ReturnType<typeof parseRetiros> = [];
    let reportUsado: string | null = null;

    try {
      const fileName = await getSettlementReport(fechaDesde, fechaHasta);

      if (fileName) {
        reportUsado = fileName;
        const csv = await mpGetText(`/v1/account/settlement_report/${fileName}`);
        retiroRows = parseRetiros(csv, empresaId, cuentaBancariaId);
      }
    } catch (err) {
      console.error("[MP Sync] Error obteniendo retiros:", err);
    }

    // ══════════════════════════════════════
    // DEDUP E INSERT
    // ══════════════════════════════════════
    if (retiroRows.length === 0) {
      return NextResponse.json({
        periodo,
        retiros_nuevos: 0,
        reporte: reportUsado,
        mensaje: reportUsado
          ? "Sin retiros nuevos en el periodo"
          : "No se pudo obtener el settlement report. Intenta de nuevo en unos minutos.",
      });
    }

    // Dedup
    const existingRefs = new Set<string>();
    const allRefs = retiroRows.map(r => r.referencia_unica);
    for (let i = 0; i < allRefs.length; i += 100) {
      const batch = allRefs.slice(i, i + 100);
      const { data: existing } = await sb.from("movimientos_banco")
        .select("referencia_unica")
        .eq("empresa_id", empresaId)
        .in("referencia_unica", batch);
      for (const r of (existing || [])) existingRefs.add(r.referencia_unica);
    }

    const newRows = retiroRows.filter(r => !existingRefs.has(r.referencia_unica));

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const batch = newRows.slice(i, i + 500);
      const { error } = await sb.from("movimientos_banco").insert(batch);
      if (error) console.error(`[MP Sync] Insert error:`, error.message);
      else inserted += batch.length;
    }

    // Sync log
    await sb.from("sync_log").insert({
      empresa_id: empresaId,
      periodo,
      tipo: "mercadopago",
      registros: inserted,
    });

    return NextResponse.json({
      periodo,
      reporte: reportUsado,
      retiros_encontrados: retiroRows.length,
      ya_existentes: existingRefs.size,
      retiros_nuevos: inserted,
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
