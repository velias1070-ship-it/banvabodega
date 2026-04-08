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


/**
 * Busca un release report existente que cubra el período solicitado.
 * No genera reportes automáticamente (tardan demasiado).
 * Si no hay reporte, informa al usuario que lo genere desde el panel de MP.
 */
async function findReports(fechaDesde: string, fechaHasta: string, log: string[]): Promise<{ fileName: string; type: "release" | "settlement" }[]> {
  const desdeDate = new Date(fechaDesde).getTime();
  const hastaDate = new Date(fechaHasta).getTime();

  try {
    // Buscar release reports existentes
    const allReports = await mpGet("/v1/account/release_report/list") as MPReport[];
    const csvReports = (allReports || [])
      .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"));
    log.push(`Release reports en MP: ${csvReports.length} disponibles`);

    // Reportes con overlap: end_date >= inicio periodo AND begin_date <= fin periodo
    const overlapping = csvReports
      .filter(r => new Date(r.end_date).getTime() >= desdeDate && new Date(r.begin_date).getTime() <= hastaDate)
      .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());

    if (overlapping.length > 0) {
      log.push(`${overlapping.length} reportes cubren el periodo`);
      return overlapping.map(r => ({ fileName: r.file_name, type: "release" as const }));
    }

    log.push("Sin release reports para este periodo");

    // Fallback: settlement reports
    try {
      const settlements = await mpGet("/v1/account/settlement_report/list") as MPReport[];
      const csvSettlements = (settlements || [])
        .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
        .filter(r => new Date(r.end_date).getTime() >= desdeDate && new Date(r.begin_date).getTime() <= hastaDate)
        .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());
      if (csvSettlements.length > 0) {
        return csvSettlements.map(r => ({ fileName: r.file_name, type: "settlement" as const }));
      }
    } catch { /* no settlement reports */ }

    log.push("Genera un reporte desde el panel de MercadoPago (Reportes → Liquidaciones) y vuelve a sincronizar.");
  } catch (err) {
    log.push(`Error buscando reportes: ${err instanceof Error ? err.message : String(err)}`);
  }

  return [];
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
    const debit = Math.abs(parseFloat(col(cols, "NET_DEBIT_AMOUNT")) || 0);

    // Egresos: payout (transferencias) + payment con debit (compras con saldo MP)
    const isPayout = desc === "payout";
    const isCompra = desc === "payment" && debit > 0;
    if (!isPayout && !isCompra) continue;

    const sourceId = col(cols, "SOURCE_ID");
    const fecha = safeDate(col(cols, "DATE"));
    const payerName = col(cols, "PAYER_NAME");
    if (!debit || !fecha) continue;

    const descParts = [isPayout ? "RETIRO MP" : "COMPRA MP"];
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
      referencia: isPayout ? `MP-RETIRO-${sourceId}` : `MP-COMPRA-${sourceId}`,
      origen: "api" as const,
      cuenta_bancaria_id: cuentaBancariaId,
      referencia_unica: refHash(isPayout ? "mp_retiro" : "mp_compra", sourceId),
      metadata: JSON.stringify({
        tipo: isPayout ? "retiro" : "compra",
        source_id: sourceId,
        monto: debit,
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
    // MP API requires UTC format (T03:00:00Z for Chile = midnight -03:00)
    const mesStr = String(mes).padStart(2, "0");
    const fechaDesde = `${anio}-${mesStr}-01T03:00:00Z`;
    // End: first day of next month at 02:59:59Z (= last second of the month in Chile)
    const nextMonth = mes === 12 ? 1 : mes + 1;
    const nextYear = mes === 12 ? anio + 1 : anio;
    const fechaHasta = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T02:59:59Z`;

    // Empresa
    const { data: empresas } = await sb.from("empresas").select("id").limit(1);
    const empresaId = empresas?.[0]?.id;
    if (!empresaId) return NextResponse.json({ error: "Sin empresa" }, { status: 500 });

    // Cuenta bancaria MP
    const { data: cuentas } = await sb.from("cuentas_bancarias")
      .select("id").eq("empresa_id", empresaId).eq("banco", "MercadoPago").limit(1);
    const cuentaBancariaId = cuentas?.[0]?.id || null;

    // Buscar fecha del ultimo movimiento MP que ya tenemos
    const { data: lastMov } = await sb.from("movimientos_banco")
      .select("fecha")
      .eq("empresa_id", empresaId)
      .eq("banco", "MercadoPago")
      .order("fecha", { ascending: false })
      .limit(1);
    const lastMovFecha = lastMov?.[0]?.fecha || null;

    const log: string[] = [];
    log.push(`Periodo: ${periodo} (${fechaDesde} a ${fechaHasta})`);
    if (lastMovFecha) log.push(`Ultimo movimiento MP en sistema: ${lastMovFecha}`);

    // ══════════════════════════════════════
    // RETIROS (PAYOUTS) desde release o settlement report
    // ══════════════════════════════════════
    let retiroRows: ReturnType<typeof parseRetirosRelease> = [];
    const reportesUsados: string[] = [];

    try {
      const reports = await findReports(fechaDesde, fechaHasta, log);

      for (const report of reports) {
        try {
          const downloadPath = report.type === "release"
            ? `/v1/account/release_report/${report.fileName}`
            : `/v1/account/settlement_report/${report.fileName}`;
          const csv = await mpGetText(downloadPath);
          const csvLines = csv.split("\n");
          log.push(`${report.fileName}: ${csvLines.length - 1} lineas`);

          const rows = report.type === "release"
            ? parseRetirosRelease(csv, empresaId, cuentaBancariaId)
            : parseRetirosSettlement(csv, empresaId, cuentaBancariaId);
          if (rows.length > 0) {
            retiroRows.push(...rows);
            reportesUsados.push(report.fileName);
            log.push(`  → ${rows.length} retiros encontrados`);
          }
        } catch (err) {
          log.push(`Error descargando ${report.fileName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (reports.length === 0) {
        log.push("Sin reportes. Genera uno desde el panel de MercadoPago (Reportes → Liquidaciones).");
      } else {
        log.push(`Total retiros de ${reportesUsados.length} reportes: ${retiroRows.length}`);
      }
    } catch (err) {
      log.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Dedup por referencia_unica dentro de los mismos reportes (un retiro puede aparecer en varios)
    const seen = new Map<string, typeof retiroRows[0]>();
    for (const r of retiroRows) { if (!seen.has(r.referencia_unica)) seen.set(r.referencia_unica, r); }
    retiroRows = Array.from(seen.values());

    // ══════════════════════════════════════
    // DEDUP E INSERT
    // ══════════════════════════════════════
    if (retiroRows.length === 0) {
      return NextResponse.json({
        periodo, retiros_nuevos: 0, reporte: reportesUsados.join(", ") || null,
        mensaje: reportesUsados.length > 0 ? "Sin retiros nuevos en el periodo" : "Sin reporte disponible. Genera uno desde el panel de MercadoPago.",
        log,
      });
    }

    const existingRefs = new Set<string>();
    const allRefs = retiroRows.map(r => r.referencia_unica);
    for (let i = 0; i < allRefs.length; i += 100) {
      const batch = allRefs.slice(i, i + 100);
      const { data: existing } = await sb.from("movimientos_banco")
        .select("referencia_unica").eq("empresa_id", empresaId).in("referencia_unica", batch);
      for (const r of (existing || [])) existingRefs.add(r.referencia_unica);
    }

    const newRows = retiroRows.filter(r => !existingRefs.has(r.referencia_unica));
    log.push(`Dedup: ${retiroRows.length} encontrados, ${existingRefs.size} ya existian, ${newRows.length} nuevos`);

    let inserted = 0;
    for (let i = 0; i < newRows.length; i += 500) {
      const batch = newRows.slice(i, i + 500);
      const { error } = await sb.from("movimientos_banco").insert(batch);
      if (error) { log.push(`ERROR insertando: ${error.message}`); }
      else inserted += batch.length;
    }

    if (inserted > 0) log.push(`${inserted} retiros importados exitosamente`);
    else log.push("Sin retiros nuevos para importar");

    await sb.from("sync_log").insert({ empresa_id: empresaId, periodo, tipo: "mercadopago", registros: inserted });

    return NextResponse.json({
      periodo, reportes: reportesUsados,
      retiros_encontrados: retiroRows.length, ya_existentes: existingRefs.size, retiros_nuevos: inserted,
      log,
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
