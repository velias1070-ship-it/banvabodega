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
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`[MP Sync] POST ${path} => ${res.status}: ${errBody}`);
    throw new Error(`MP API POST ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Busca un release report que cubra el período solicitado.
 * Usa margen de 2 días para compensar diferencias de zona horaria.
 * Para meses pasados, acepta cualquier reporte existente que cubra el rango.
 * Para el mes actual, necesita un reporte reciente (< 2h) o genera uno nuevo.
 * Si no hay reporte, genera uno y espera hasta 4.5 min.
 */
async function findReport(fechaDesde: string, fechaHasta: string, log: string[]): Promise<{ fileName: string; type: "release" | "settlement" } | null> {
  const desdeDate = new Date(fechaDesde).getTime();
  const hastaDate = new Date(fechaHasta).getTime();
  const now = Date.now();
  const DAY = 86400_000;
  const desdeMargin = desdeDate + 2 * DAY;
  const isPastMonth = hastaDate < now - DAY;

  try {
    const releases = await mpGet("/v1/account/release_report/list") as MPReport[];
    const csvReports = (releases || [])
      .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"));
    log.push(`Reportes disponibles en MP: ${csvReports.length}`);

    // Para meses pasados: buscar reporte que cubra el rango completo
    if (isPastMonth) {
      const minEnd = hastaDate - DAY;
      const covering = csvReports
        .filter(r => {
          const begin = new Date(r.begin_date).getTime();
          const end = new Date(r.end_date).getTime();
          return begin <= desdeMargin && end >= minEnd;
        })
        .sort((a, b) => (new Date(b.end_date).getTime() - new Date(b.begin_date).getTime()) - (new Date(a.end_date).getTime() - new Date(a.begin_date).getTime()));

      if (covering.length > 0) {
        log.push(`Mes pasado: usando reporte existente ${covering[0].file_name}`);
        return { fileName: covering[0].file_name, type: "release" };
      }
      log.push("Mes pasado: no hay reporte que cubra el rango. Generando uno...");
    } else {
      // Mes actual: SIEMPRE generar un reporte fresco para tener datos hasta ahora
      log.push("Mes actual: generando reporte fresco para incluir movimientos de hoy...");
    }

    // Generar reporte nuevo (para mes actual siempre, para pasado si no hay cobertura)
    const existingNames = new Set(csvReports.map(r => r.file_name));

    // Para mes actual, end_date = ahora (no fin de mes futuro)
    const endDate = isPastMonth ? fechaHasta : new Date().toISOString().replace(/\.\d{3}/, "");

    try {
      log.push(`Solicitando reporte: ${fechaDesde} a ${endDate}`);
      await mpPost("/v1/account/release_report", {
        begin_date: fechaDesde,
        end_date: endDate,
      });

      // Polling hasta 90s (Vercel free tier timeout = 60s, pro = 300s)
      const startPoll = Date.now();
      while (Date.now() - startPoll < 90_000) {
        await sleep(8_000);
        const elapsed = Math.round((Date.now() - startPoll) / 1000);
        const updated = await mpGet("/v1/account/release_report/list") as MPReport[];
        const fresh = (updated || [])
          .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
          .filter(r => !existingNames.has(r.file_name));

        if (fresh.length > 0) {
          log.push(`Reporte listo en ${elapsed}s: ${fresh[0].file_name}`);
          return { fileName: fresh[0].file_name, type: "release" };
        }

        // Tambien buscar reportes pending que se completaron
        const justReady = (updated || [])
          .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
          .filter(r => {
            const begin = new Date(r.begin_date).getTime();
            return begin <= desdeMargin && !existingNames.has(r.file_name);
          });
        if (justReady.length > 0) {
          log.push(`Reporte listo en ${elapsed}s: ${justReady[0].file_name}`);
          return { fileName: justReady[0].file_name, type: "release" };
        }

        log.push(`Esperando reporte... ${elapsed}s`);
      }
      log.push("Timeout esperando reporte de MP");
    } catch (err) {
      log.push(`Error generando reporte: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Ultimo intento: re-listar y buscar cualquier reporte nuevo
    try {
      const finalList = await mpGet("/v1/account/release_report/list") as MPReport[];
      const newOnes = (finalList || [])
        .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
        .filter(r => !existingNames.has(r.file_name));
      if (newOnes.length > 0) {
        log.push(`Reporte encontrado post-timeout: ${newOnes[0].file_name}`);
        return { fileName: newOnes[0].file_name, type: "release" };
      }
    } catch {}

    // Fallback: usar el reporte mas reciente que toque el periodo
    const allReports = await mpGet("/v1/account/release_report/list") as MPReport[];
    const fallbackList = (allReports || [])
      .filter(r => (r.status === "enabled" || r.status === "processed") && r.file_name && r.file_name.endsWith(".csv"))
      .filter(r => new Date(r.begin_date).getTime() <= desdeMargin)
      .sort((a, b) => new Date(b.end_date).getTime() - new Date(a.end_date).getTime());
    if (fallbackList.length > 0) {
      log.push(`Usando fallback: ${fallbackList[0].file_name} (puede no tener datos de hoy)`);
      return { fileName: fallbackList[0].file_name, type: "release" };
    }
  } catch (err) {
    log.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
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

    const log: string[] = [];
    log.push(`Periodo: ${periodo} (${fechaDesde} a ${fechaHasta})`);

    // ══════════════════════════════════════
    // RETIROS (PAYOUTS) desde release o settlement report
    // ══════════════════════════════════════
    let retiroRows: ReturnType<typeof parseRetirosRelease> = [];
    let reportUsado: string | null = null;
    let reportType: string | null = null;

    try {
      const report = await findReport(fechaDesde, fechaHasta, log);

      if (report) {
        reportUsado = report.fileName;
        reportType = report.type;
        log.push(`Reporte encontrado: ${report.fileName} (${report.type})`);
        const downloadPath = report.type === "release"
          ? `/v1/account/release_report/${report.fileName}`
          : `/v1/account/settlement_report/${report.fileName}`;
        const csv = await mpGetText(downloadPath);

        const csvLines = csv.split("\n");
        const csvDataLines = csvLines.length - 1;
        log.push(`CSV descargado: ${csvDataLines} lineas de datos`);

        // Count DESCRIPTION types
        if (report.type === "release" && csvDataLines > 0) {
          const headerCols = csvLines[0].split(";");
          const descIdx = headerCols.findIndex(h => h.trim() === "DESCRIPTION");
          if (descIdx >= 0) {
            const counts: Record<string, number> = {};
            for (const line of csvLines.slice(1)) {
              const d = line.split(";")[descIdx]?.trim() || "(vacio)";
              counts[d] = (counts[d] || 0) + 1;
            }
            const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", ");
            log.push(`Tipos en CSV: ${summary}`);
          }
        }

        retiroRows = report.type === "release"
          ? parseRetirosRelease(csv, empresaId, cuentaBancariaId)
          : parseRetirosSettlement(csv, empresaId, cuentaBancariaId);
        log.push(`Retiros parseados: ${retiroRows.length} (payouts + compras con debito)`);
      } else {
        log.push("No se encontro reporte. Se solicito generar uno nuevo a MP (puede tardar 2-3 min).");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.push(`ERROR obteniendo retiros: ${errMsg}`);
    }

    // ══════════════════════════════════════
    // DEDUP E INSERT
    // ══════════════════════════════════════
    if (retiroRows.length === 0) {
      return NextResponse.json({
        periodo, retiros_nuevos: 0, reporte: reportUsado, reporte_tipo: reportType,
        mensaje: reportUsado ? "Sin retiros nuevos en el periodo" : "El reporte se esta generando. Espera 2-3 min e intenta de nuevo.",
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
      periodo, reporte: reportUsado, reporte_tipo: reportType,
      retiros_encontrados: retiroRows.length, ya_existentes: existingRefs.size, retiros_nuevos: inserted,
      log,
    });
  } catch (err) {
    console.error("[MP Sync] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
