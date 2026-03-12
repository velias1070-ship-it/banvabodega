/**
 * API Route: /api/sii/sync
 *
 * Importa datos del SII (compras y/o ventas) para un periodo dado.
 * Flujo: Railway (descarga SII con certificado) → esta API route (parsea → Supabase)
 *
 * POST body: { periodo: "YYYYMM", tipo: "compras" | "ventas" | "ambos" }
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

// URL del servidor RCV SII (Railway o local)
const SII_SERVER_URL = process.env.SII_SERVER_URL || "http://localhost:8080";
const SII_API_KEY = process.env.SII_API_KEY || "banva-rcv-2026";
const RUT_EMPRESA = "77994007-1";

// ==================== PARSEO ====================

function safeDate(val: unknown): string | null {
  if (!val) return null;
  let v = String(val).trim();
  if (!v) return null;
  // Quitar hora si viene como "05/02/2026 21:43:10"
  if (v.includes(" ")) v = v.split(" ")[0];
  // DD/MM/YYYY → YYYY-MM-DD
  if (v.includes("/")) {
    const parts = v.split("/");
    if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  }
  // Ya es YYYY-MM-DD
  if (v.length === 10 && v[4] === "-") return v;
  return null;
}

function safeFloat(val: unknown): number {
  try {
    const v = String(val || "0").trim().replace(/\./g, "").replace(",", ".");
    return parseFloat(v) || 0;
  } catch {
    return 0;
  }
}

interface SiiCompraItem {
  detRutDoc?: string;
  detDvDoc?: string;
  detNroDoc?: string;
  detRznSoc?: string;
  detFchDoc?: string;
  detMntExe?: number;
  detMntNeto?: number;
  detMntIVA?: number;
  detMntTotal?: number;
  detFecRecepcion?: string;
  detEventoReceptor?: string;
}

function parseCompras(dataByEstado: Record<string, { data?: SiiCompraItem[] }>, empresaId: string, periodo: string) {
  const rows: Record<string, unknown>[] = [];
  for (const [key, data] of Object.entries(dataByEstado)) {
    if (!data) continue;
    const parts = key.split("_");
    const estado = parts[0];
    const tipoDoc = parts.length > 1 ? parseInt(parts[1]) : 33;
    const registros = data.data || [];
    if (!Array.isArray(registros)) continue;
    for (const item of registros) {
      if (!item || typeof item !== "object") continue;
      const rut = `${item.detRutDoc || ""}-${item.detDvDoc || ""}`;
      rows.push({
        empresa_id: empresaId,
        periodo,
        estado,
        tipo_doc: tipoDoc,
        nro_doc: String(item.detNroDoc || ""),
        rut_proveedor: rut,
        razon_social: item.detRznSoc || "",
        fecha_docto: safeDate(item.detFchDoc),
        monto_exento: parseFloat(String(item.detMntExe || 0)) || 0,
        monto_neto: parseFloat(String(item.detMntNeto || 0)) || 0,
        monto_iva: parseFloat(String(item.detMntIVA || 0)) || 0,
        monto_total: parseFloat(String(item.detMntTotal || 0)) || 0,
        fecha_recepcion: safeDate(item.detFecRecepcion),
        evento_receptor: String(item.detEventoReceptor || ""),
      });
    }
  }
  return rows;
}

function parseVentas(dataByTipo: Record<string, { data?: string[] }>, empresaId: string, periodo: string) {
  const rows: Record<string, unknown>[] = [];
  for (const [tipoDoc, data] of Object.entries(dataByTipo)) {
    if (!data) continue;
    const registros = data.data || [];
    if (!Array.isArray(registros)) continue;
    for (const line of registros) {
      if (typeof line !== "string") continue;
      if (line.startsWith("Nro")) continue; // header CSV
      const cols = line.split(";");
      if (cols.length < 8) continue;
      rows.push({
        empresa_id: empresaId,
        periodo,
        tipo_doc: String(tipoDoc),
        nro: cols[0]?.trim() || null,
        rut_emisor: cols[1]?.trim() || null,
        folio: cols[2]?.trim() || null,
        fecha_docto: safeDate(cols[3]),
        monto_neto: safeFloat(cols[4]),
        monto_exento: safeFloat(cols[5]),
        monto_iva: safeFloat(cols[6]),
        monto_total: safeFloat(cols[7]),
        fecha_recepcion: cols.length > 8 ? safeDate(cols[8]) : null,
        evento_receptor: cols.length > 9 ? cols[9]?.trim() || null : null,
      });
    }
  }
  return rows;
}

// ==================== HANDLER ====================

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { periodo, tipo = "ambos" } = body as { periodo?: string; tipo?: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "Periodo inválido (YYYYMM)" }, { status: 400 });
    }
    if (!["compras", "ventas", "ambos"].includes(tipo)) {
      return NextResponse.json({ error: "Tipo debe ser: compras, ventas, ambos" }, { status: 400 });
    }

    const sb = getServerSupabase();
    if (!sb) {
      return NextResponse.json({ error: "Supabase no configurado" }, { status: 500 });
    }

    // 1. Obtener empresa_id
    const { data: empresas } = await sb.from("empresas").select("id,razon_social").eq("rut", RUT_EMPRESA);
    if (!empresas || empresas.length === 0) {
      return NextResponse.json({ error: `Empresa ${RUT_EMPRESA} no encontrada` }, { status: 404 });
    }
    const empresaId = empresas[0].id;

    // 2. Llamar al servidor SII (Railway) para obtener datos crudos
    const siiUrl = `${SII_SERVER_URL}/sync-data?periodo=${periodo}&tipo=${tipo}&key=${SII_API_KEY}`;
    console.log(`[SII Sync] Llamando a ${SII_SERVER_URL}/sync-data periodo=${periodo} tipo=${tipo}`);

    const siiRes = await fetch(siiUrl, { signal: AbortSignal.timeout(120000) }); // 2 min timeout
    if (!siiRes.ok) {
      const errText = await siiRes.text();
      return NextResponse.json({ error: `Error del servidor SII: ${siiRes.status} ${errText.slice(0, 200)}` }, { status: 502 });
    }

    const siiData = await siiRes.json();
    if (siiData.status === "error") {
      return NextResponse.json({ error: `SII error: ${siiData.error}` }, { status: 502 });
    }

    const result: { compras: number; ventas: number } = { compras: 0, ventas: 0 };

    // 3. Parsear y subir compras
    if (tipo === "compras" || tipo === "ambos") {
      const comprasRows = parseCompras(siiData.compras || {}, empresaId, periodo);
      if (comprasRows.length > 0) {
        // Upsert en batches de 500
        for (let i = 0; i < comprasRows.length; i += 500) {
          const batch = comprasRows.slice(i, i + 500);
          const { error } = await sb.from("rcv_compras").upsert(batch, {
            onConflict: "empresa_id,periodo,tipo_doc,nro_doc,rut_proveedor",
          });
          if (error) console.error(`[SII Sync] Error upsert compras batch ${i}:`, error.message);
        }
        result.compras = comprasRows.length;

        // Registrar en sync_log
        await sb.from("sync_log").insert({
          empresa_id: empresaId,
          periodo,
          tipo: "compras",
          registros: comprasRows.length,
        });
      }
    }

    // 4. Parsear y subir ventas
    if (tipo === "ventas" || tipo === "ambos") {
      const ventasRows = parseVentas(siiData.ventas || {}, empresaId, periodo);
      if (ventasRows.length > 0) {
        for (let i = 0; i < ventasRows.length; i += 500) {
          const batch = ventasRows.slice(i, i + 500);
          const { error } = await sb.from("rcv_ventas").upsert(batch, {
            onConflict: "empresa_id,periodo,tipo_doc,folio",
          });
          if (error) console.error(`[SII Sync] Error upsert ventas batch ${i}:`, error.message);
        }
        result.ventas = ventasRows.length;

        await sb.from("sync_log").insert({
          empresa_id: empresaId,
          periodo,
          tipo: "ventas",
          registros: ventasRows.length,
        });
      }
    }

    console.log(`[SII Sync] OK — compras: ${result.compras}, ventas: ${result.ventas}`);
    return NextResponse.json({ status: "ok", ...result });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SII Sync] Error:", msg);
    // Distinguir timeout del servidor SII
    if (msg.includes("timeout") || msg.includes("abort")) {
      return NextResponse.json({ error: "Timeout: el servidor SII tardó más de 2 minutos. Intenta de nuevo." }, { status: 504 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
