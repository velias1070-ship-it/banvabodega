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

// ==================== RELEASE REPORT ====================

interface MPReport {
  id: number;
  file_name: string;
  status: string;
  begin_date: string;
  end_date: string;
  format?: string;
}

async function mpPost(path: string, body: unknown): Promise<unknown> {
  const url = `${MP_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`MP API POST ${res.status}`);
  return res.json();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Busca un release report que cubra TODO el período solicitado.
 * Un reporte "cubre" el período si su begin_date <= fechaDesde Y end_date >= hoy (o fin de mes).
 * Si no hay uno que cubra todo, genera uno nuevo y espera hasta 3 minutos.
 * Fallback: usa el mejor reporte disponible (el más amplio).
 */
async function findReport(fechaDesde: string, fechaHasta: string): Promise<{ fileName: string; type: "release" | "settlement" } | null> {
  const desdeDate = new Date(fechaDesde).getTime();
  const hastaDate = new Date(fechaHasta).getTime();
  const now = Date.now();
  // El end_date mínimo aceptable: el menor entre hoy y el fin del período
  const minEndDate = Math.min(hastaDate, now);

  try {
    const releases = await mpGet("/v1/account/release_report/list") as MPReport[];
    const csvReports = (releases || [])
      .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"));

    // Buscar un reporte que cubra TODO el rango: begin_date <= fechaDesde Y end_date >= hoy
    const fullCoverage = csvReports
      .filter(r => new Date(r.begin_date).getTime() <= desdeDate && new Date(r.end_date).getTime() >= minEndDate - 86400000)
      .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());

    if (fullCoverage.length > 0) {
      // Verificar si el mejor es reciente (< 2 horas)
      const best = fullCoverage[0];
      const nameMatch = best.file_name.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.csv$/);
      if (nameMatch) {
        const reportDate = new Date(`${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}T${nameMatch[4]}:${nameMatch[5]}:${nameMatch[6]}Z`);
        const ageMs = now - reportDate.getTime();
        if (ageMs < 7200_000) {
          console.log(`[MP Sync] Reporte completo y fresco: ${best.file_name}`);
          return { fileName: best.file_name, type: "release" };
        }
      }
    }

    // No hay reporte completo y fresco — generar uno nuevo
    console.log("[MP Sync] Generando reporte completo del período...");
    const bestOld = fullCoverage.length > 0 ? fullCoverage[0] : null;

    try {
      await mpPost("/v1/account/release_report", {
        begin_date: fechaDesde,
        end_date: fechaHasta,
      });

      // Polling: esperar hasta 4 min (meses anteriores tardan más)
      const startPoll = Date.now();
      for (let i = 0; i < 24; i++) {
        await sleep(10_000);
        const updated = await mpGet("/v1/account/release_report/list") as MPReport[];
        const fresh = (updated || [])
          .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
          .filter(r => new Date(r.begin_date).getTime() <= desdeDate && new Date(r.end_date).getTime() >= minEndDate - 86400000)
          .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());

        if (fresh.length > 0 && (!bestOld || fresh[0].file_name !== bestOld.file_name)) {
          console.log(`[MP Sync] Reporte nuevo listo en ${Math.round((Date.now() - startPoll) / 1000)}s: ${fresh[0].file_name}`);
          return { fileName: fresh[0].file_name, type: "release" };
        }
        console.log(`[MP Sync] Esperando reporte... ${Math.round((Date.now() - startPoll) / 1000)}s`);
      }
    } catch (err) {
      console.log("[MP Sync] No se pudo generar reporte:", err);
    }

    // Fallback: usar el mejor reporte existente (el más amplio)
    if (bestOld) {
      console.log(`[MP Sync] Timeout, usando reporte existente: ${bestOld.file_name}`);
      return { fileName: bestOld.file_name, type: "release" };
    }

    // Último fallback: cualquier reporte que al menos cubra parte del período
    const anyReport = csvReports
      .filter(r => new Date(r.end_date).getTime() >= desdeDate)
      .sort((a, b) => {
        // Preferir el que cubra más rango
        const rangeA = new Date(a.end_date).getTime() - new Date(a.begin_date).getTime();
        const rangeB = new Date(b.end_date).getTime() - new Date(b.begin_date).getTime();
        return rangeB - rangeA;
      });
    if (anyReport.length > 0) {
      console.log(`[MP Sync] Usando reporte parcial: ${anyReport[0].file_name}`);
      return { fileName: anyReport[0].file_name, type: "release" };
    }
  } catch (err) {
    console.log("[MP Sync] Error consultando release_report:", err);
  }

  // Settlement report como último recurso
  try {
    const settlements = await mpGet("/v1/account/settlement_report/list", {
      begin_date: fechaDesde,
      end_date: fechaHasta,
    }) as MPReport[];
    const ready = (settlements || [])
      .filter(r => r.status === "processed" && r.file_name)
      .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());
    if (ready.length > 0) return { fileName: ready[0].file_name, type: "settlement" };
  } catch (err) {
    console.log("[MP Sync] Error consultando settlement_report:", err);
  }

  return null;
}

/**
 * Parsea retiros del release report. Usa nombres de columna del header (no posición fija).
 * Los payouts tienen DESCRIPTION = "payout"
 */
function parseRetirosRelease(csv: string, empresaId: string, cuentaBancariaId: string | null) {
  const lines = csv.split("\n");
  if (lines.length < 2) return [];

  // Mapear columnas por nombre
  const header = lines[0].split(";");
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });

  const col = (row: string[], name: string) => {
    const i = idx[name];
    return i !== undefined && i < row.length ? row[i].trim() : "";
  };

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
    if (cols.length < 6) continue;

    const desc = col(cols, "DESCRIPTION");
    if (desc !== "payout") continue;

    const sourceId = col(cols, "SOURCE_ID");
    const debit = Math.abs(parseFloat(col(cols, "NET_DEBIT_AMOUNT")) || 0);
    const fecha = safeDate(col(cols, "DATE"));
    const payerName = col(cols, "PAYER_NAME");
    if (!debit || !fecha) continue;

    const descParts = ["RETIRO MP"];
    if (payerName) descParts.push(payerName);
    descParts.push(`$${debit.toLocaleString("es-CL")}`);

    rows.push({
      empresa_id: empresaId,
      banco: "MercadoPago",
      cuenta: null,
      fecha,
      descripcion: descParts.join(" | "),
      monto: -debit,
      saldo: null,
      referencia: `MP-RETIRO-${sourceId}`,
      origen: "api" as const,
      cuenta_bancaria_id: cuentaBancariaId,
      referencia_unica: refHash("mp_retiro", sourceId),
      metadata: JSON.stringify({
        tipo: "retiro",
        source_id: sourceId,
        monto_retirado: debit,
        payer_name: payerName || null,
      }),
    });
  }

  return rows;
}

/**
 * Parsea retiros del settlement report (columnas: SOURCE_ID;PAYMENT_METHOD_TYPE;TRANSACTION_TYPE;TRANSACTION_AMOUNT;...)
 * Los payouts tienen TRANSACTION_TYPE = "PAYOUTS"
 */
function parseRetirosSettlement(csv: string, empresaId: string, cuentaBancariaId: string | null) {
  const lines = csv.split("\n");
  const rows: ReturnType<typeof parseRetirosRelease> = [];

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
 * Usa release report (preferido) o settlement report como fallback.
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
    // RETIROS (PAYOUTS) desde release o settlement report
    // ══════════════════════════════════════
    let retiroRows: ReturnType<typeof parseRetirosRelease> = [];
    let reportUsado: string | null = null;
    let reportType: string | null = null;

    try {
      const report = await findReport(fechaDesde, fechaHasta);

      if (report) {
        reportUsado = report.fileName;
        reportType = report.type;
        const downloadPath = report.type === "release"
          ? `/v1/account/release_report/${report.fileName}`
          : `/v1/account/settlement_report/${report.fileName}`;
        const csv = await mpGetText(downloadPath);

        retiroRows = report.type === "release"
          ? parseRetirosRelease(csv, empresaId, cuentaBancariaId)
          : parseRetirosSettlement(csv, empresaId, cuentaBancariaId);
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
        reporte_tipo: reportType,
        mensaje: reportUsado
          ? "Sin retiros nuevos en el periodo"
          : "No hay reporte disponible. Genera uno desde el panel de MercadoPago en Informes → Liberaciones.",
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
      reporte_tipo: reportType,
      retiros_encontrados: retiroRows.length,
      ya_existentes: existingRefs.size,
      retiros_nuevos: inserted,
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
