import { NextRequest, NextResponse } from "next/server";

/**
 * API Route: /api/sii/rcv
 * Autentica con el SII y descarga el RCV (Registro de Compras y Ventas) de un período.
 *
 * POST body: { rut, clave, periodo, tipo: "COMPRA"|"VENTA" }
 * - rut: RUT de la empresa con DV (ej: "77994007-1")
 * - clave: Clave tributaria del SII
 * - periodo: Período en formato YYYYMM (ej: "202603")
 * - tipo: "COMPRA" o "VENTA"
 */

const SII_AUTH_URL = "https://herculesr.sii.cl/cgi_AUT2000/CAutInWor498.cgi";
const SII_RCV_BASE = "https://www4.sii.cl/conaborrcvinternetui/services/data/facadeService";

// Tipos de documentos a consultar
const TIPOS_DOC_COMPRAS = [33, 34, 46, 52, 56, 61]; // Factura, Exenta, FC, Guía, ND, NC
const TIPOS_DOC_VENTAS  = [33, 34, 39, 41, 52, 56, 61]; // + Boleta, Boleta Exenta

function splitRut(rutCompleto: string): { rut: string; dv: string } {
  const clean = rutCompleto.replace(/\./g, "").replace(/\s/g, "").trim();
  const parts = clean.split("-");
  return { rut: parts[0], dv: (parts[1] || "").toUpperCase() };
}

// ==================== AUTH SII ====================

async function autenticarSII(rut: string, dv: string, clave: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      rut,
      dv,
      referession: "",
      cession: clave,
    });

    const resp = await fetch(SII_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body.toString(),
      redirect: "manual",
    });

    // El SII devuelve una cookie TOKEN en el set-cookie header
    const cookies = resp.headers.getSetCookie?.() || [];
    let token = "";
    for (const c of cookies) {
      const match = c.match(/TOKEN=([^;]+)/);
      if (match) { token = match[1]; break; }
    }

    // Fallback: buscar en headers raw
    if (!token) {
      const setCookieRaw = resp.headers.get("set-cookie") || "";
      const match = setCookieRaw.match(/TOKEN=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      console.error("[SII Auth] No se obtuvo TOKEN. Status:", resp.status);
      return null;
    }

    return token;
  } catch (err) {
    console.error("[SII Auth] Error:", err);
    return null;
  }
}

// ==================== FETCH RCV ====================

interface RcvDocCompra {
  detRutDoc: string;
  detDvDoc: string;
  detRznSoc: string;
  detNroDoc: number;
  detFchDoc: string;
  detMntExe: number;
  detMntNeto: number;
  detMntIVA: number;
  detMntTotal: number;
  detFecRecepcion: string;
  detTipoDoc: number;
  detEventoReceptor: string;
}

interface RcvDocVenta {
  detRutDoc: string;
  detDvDoc: string;
  detNroDoc: number;
  detFchDoc: string;
  detMntExe: number;
  detMntNeto: number;
  detMntIVA: number;
  detMntTotal: number;
  detFecRecepcion: string;
  detTipoDoc: number;
  detFolio: number;
}

interface RcvResponse {
  data?: RcvDocCompra[] | RcvDocVenta[] | null;
  metaData?: { pagina?: number; totalPaginas?: number; totalRegistros?: number };
}

async function fetchRcvPagina(
  token: string,
  rutEmpresa: string,
  dvEmpresa: string,
  periodo: string,
  tipo: "COMPRA" | "VENTA",
  tipoDoc: number,
  pagina: number,
): Promise<RcvResponse> {
  const endpoint = tipo === "COMPRA"
    ? `${SII_RCV_BASE}/getDetalleRegistroCompra`
    : `${SII_RCV_BASE}/getDetalleRegistroVenta`;

  const params = new URLSearchParams({
    ...(tipo === "COMPRA"
      ? { rutReceptor: rutEmpresa, dvReceptor: dvEmpresa }
      : { rutEmisor: rutEmpresa, dvEmisor: dvEmpresa }),
    periodo,
    codTipoDoc: String(tipoDoc),
    estadoContab: "REGISTRO",
    pagina: String(pagina),
  });

  try {
    const resp = await fetch(`${endpoint}?${params.toString()}`, {
      headers: {
        "Cookie": `TOKEN=${token}`,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!resp.ok) {
      console.error(`[SII RCV] HTTP ${resp.status} para tipo ${tipoDoc}, página ${pagina}`);
      return { data: null };
    }

    const json = await resp.json();
    return json as RcvResponse;
  } catch (err) {
    console.error(`[SII RCV] Error fetch tipo ${tipoDoc} pág ${pagina}:`, err);
    return { data: null };
  }
}

async function fetchRcvCompleto(
  token: string,
  rutEmpresa: string,
  dvEmpresa: string,
  periodo: string,
  tipo: "COMPRA" | "VENTA",
): Promise<{ compras: CompraItem[]; ventas: VentaItem[] }> {
  const tiposDocs = tipo === "COMPRA" ? TIPOS_DOC_COMPRAS : TIPOS_DOC_VENTAS;
  const compras: CompraItem[] = [];
  const ventas: VentaItem[] = [];

  for (const tipoDoc of tiposDocs) {
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const resp = await fetchRcvPagina(token, rutEmpresa, dvEmpresa, periodo, tipo, tipoDoc, pagina);

      if (resp.metaData?.totalPaginas) {
        totalPaginas = resp.metaData.totalPaginas;
      }

      if (resp.data && Array.isArray(resp.data)) {
        if (tipo === "COMPRA") {
          for (const doc of resp.data as RcvDocCompra[]) {
            compras.push({
              periodo,
              estado: "REGISTRO",
              tipo_doc: doc.detTipoDoc || tipoDoc,
              nro_doc: String(doc.detNroDoc || ""),
              rut_proveedor: doc.detRutDoc ? `${doc.detRutDoc}-${doc.detDvDoc || ""}` : null,
              razon_social: doc.detRznSoc || null,
              fecha_docto: doc.detFchDoc || null,
              monto_exento: doc.detMntExe || 0,
              monto_neto: doc.detMntNeto || 0,
              monto_iva: doc.detMntIVA || 0,
              monto_total: doc.detMntTotal || 0,
              fecha_recepcion: doc.detFecRecepcion || null,
              evento_receptor: doc.detEventoReceptor || null,
            });
          }
        } else {
          for (const doc of resp.data as RcvDocVenta[]) {
            ventas.push({
              periodo,
              tipo_doc: String(doc.detTipoDoc || tipoDoc),
              nro: String(doc.detNroDoc || ""),
              rut_emisor: doc.detRutDoc ? `${doc.detRutDoc}-${doc.detDvDoc || ""}` : null,
              folio: String(doc.detFolio || doc.detNroDoc || ""),
              fecha_docto: doc.detFchDoc || null,
              monto_neto: doc.detMntNeto || 0,
              monto_exento: doc.detMntExe || 0,
              monto_iva: doc.detMntIVA || 0,
              monto_total: doc.detMntTotal || 0,
              fecha_recepcion: doc.detFecRecepcion || null,
              evento_receptor: null,
            });
          }
        }
      }

      pagina++;
      // Pequeña pausa para no saturar el SII
      if (pagina <= totalPaginas) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  return { compras, ventas };
}

// Tipos intermedios para la respuesta
interface CompraItem {
  periodo: string;
  estado: string;
  tipo_doc: number;
  nro_doc: string;
  rut_proveedor: string | null;
  razon_social: string | null;
  fecha_docto: string | null;
  monto_exento: number;
  monto_neto: number;
  monto_iva: number;
  monto_total: number;
  fecha_recepcion: string | null;
  evento_receptor: string | null;
}

interface VentaItem {
  periodo: string;
  tipo_doc: string;
  nro: string;
  rut_emisor: string | null;
  folio: string;
  fecha_docto: string | null;
  monto_neto: number;
  monto_exento: number;
  monto_iva: number;
  monto_total: number;
  fecha_recepcion: string | null;
  evento_receptor: string | null;
}

// ==================== ROUTE HANDLER ====================

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { rut: rutCompleto, clave, periodo, tipo } = body as {
      rut: string;
      clave: string;
      periodo: string;
      tipo: "COMPRA" | "VENTA";
    };

    // Validaciones básicas
    if (!rutCompleto || !clave || !periodo || !tipo) {
      return NextResponse.json(
        { error: "Faltan parámetros: rut, clave, periodo, tipo" },
        { status: 400 },
      );
    }

    if (!["COMPRA", "VENTA"].includes(tipo)) {
      return NextResponse.json(
        { error: "tipo debe ser COMPRA o VENTA" },
        { status: 400 },
      );
    }

    if (!/^\d{6}$/.test(periodo)) {
      return NextResponse.json(
        { error: "periodo debe tener formato YYYYMM" },
        { status: 400 },
      );
    }

    const { rut, dv } = splitRut(rutCompleto);

    // 1. Autenticar con SII
    console.log(`[SII RCV] Autenticando RUT ${rut}-${dv}...`);
    const token = await autenticarSII(rut, dv, clave);

    if (!token) {
      return NextResponse.json(
        { error: "No se pudo autenticar con el SII. Verifica el RUT y la clave tributaria." },
        { status: 401 },
      );
    }

    console.log(`[SII RCV] Token obtenido. Descargando RCV ${tipo} período ${periodo}...`);

    // 2. Descargar RCV
    const resultado = await fetchRcvCompleto(token, rut, dv, periodo, tipo);

    const registros = tipo === "COMPRA" ? resultado.compras : resultado.ventas;

    console.log(`[SII RCV] ${tipo}: ${registros.length} registros descargados`);

    return NextResponse.json({
      ok: true,
      tipo,
      periodo,
      registros: registros.length,
      data: registros,
    });
  } catch (err) {
    console.error("[SII RCV] Error:", err);
    return NextResponse.json(
      { error: "Error interno al consultar el SII" },
      { status: 500 },
    );
  }
}
