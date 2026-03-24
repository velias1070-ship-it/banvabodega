import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/sii/bhe
 * Body: { rut, clave, periodo }
 * Descarga boletas de honorarios electrónicas (BHE) recibidas del SII.
 * Usa autenticación por clave tributaria (misma que /api/sii/rcv).
 */

export const maxDuration = 60;

const SII_AUTH_URL = "https://herculesr.sii.cl/cgi_AUT2000/CAutInWor498.cgi";
const BHE_CGI_URL = "https://palena.sii.cl/cgi_IMT/TMBCOC_InformeMensualBheRec.cgi";

// ==================== AUTH ====================

async function autenticarSII(rut: string, dv: string, clave: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({ rut, dv, referession: "", cession: clave });
    const resp = await fetch(SII_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body.toString(),
      redirect: "manual",
    });

    const cookies = resp.headers.getSetCookie?.() || [];
    let token = "";
    for (const c of cookies) {
      const match = c.match(/TOKEN=([^;]+)/);
      if (match) { token = match[1]; break; }
    }
    if (!token) {
      const raw = resp.headers.get("set-cookie") || "";
      const match = raw.match(/TOKEN=([^;]+)/);
      if (match) token = match[1];
    }
    if (!token) {
      console.error(`[BHE Auth] No TOKEN. Status: ${resp.status}, headers: ${JSON.stringify(Object.fromEntries(resp.headers.entries()))}`);
    }
    return token || null;
  } catch (err) {
    console.error("[BHE Auth] Error:", err);
    return null;
  }
}

// ==================== FETCH & PARSE BHE ====================

interface BHEBoleta {
  nro_boleta: string;
  rut_emisor: string;
  nombre_emisor: string;
  fecha: string;
  monto_bruto: number;
  retencion: number;
  monto_liquido: number;
}

async function fetchBHE(token: string, rutEmpresa: string, dvEmpresa: string, anio: string, mes: string): Promise<{ boletas: BHEBoleta[]; total: number; pages: number }> {
  const allBoletas: BHEBoleta[] = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const url = `${BHE_CGI_URL}?cbanoinformemensual=${anio}&cbmesinformemensual=${mes}&dv_arrastre=${dvEmpresa}&pagina_solicitada=${page}&rut_arrastre=${rutEmpresa}`;

    const resp = await fetch(url, {
      headers: {
        "Cookie": `TOKEN=${token}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!resp.ok) {
      throw new Error(`BHE HTTP ${resp.status}`);
    }

    const html = await resp.text();

    // Verificar si fue rechazado
    if (html.includes("Transaccion Rechazada")) {
      throw new Error("Transacción rechazada por el SII. Verifica las credenciales.");
    }

    // Extraer CantidadFilas
    const cantMatch = html.match(/CantidadFilas\s*=\s*(\d+)/);
    const cant = cantMatch ? parseInt(cantMatch[1]) : 0;

    // Extraer total de boletas para paginación
    const totalMatch = html.match(/xml_values\['total_boletas'\]\s*=\s*"(\d+)"/);
    const totalBoletas = totalMatch ? parseInt(totalMatch[1]) : cant;
    totalPages = Math.ceil(totalBoletas / 100); // MAXFILAS=100 en el CGI

    for (let i = 1; i <= cant; i++) {
      const extract = (key: string): string => {
        const pattern = new RegExp(`arr_informe_mensual\\['${key}_${i}'\\]\\s*=\\s*"([^"]*)"`);
        const m = html.match(pattern);
        return m ? m[1].trim() : "";
      };

      const extractMonto = (key: string): number => {
        const pattern = new RegExp(`arr_informe_mensual\\['${key}_${i}'\\]\\s*=\\s*formatMiles\\("(\\d+)"`);
        const m = html.match(pattern);
        return m ? parseInt(m[1]) : 0;
      };

      const estado = extract("estado");
      if (estado === "A") continue; // Anulada

      const rutEmisor = extract("rutemisor");
      const dvEmisor = extract("dvemisor");

      // Convertir fecha DD/MM/YYYY → YYYY-MM-DD
      const fechaRaw = extract("fecha_boleta");
      let fecha = fechaRaw;
      if (fechaRaw.includes("/")) {
        const parts = fechaRaw.split("/");
        if (parts.length === 3) {
          fecha = `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
        }
      }

      allBoletas.push({
        nro_boleta: extract("nroboleta"),
        rut_emisor: `${rutEmisor}-${dvEmisor}`,
        nombre_emisor: extract("nombre_emisor"),
        fecha,
        monto_bruto: extractMonto("totalhonorarios"),
        retencion: extractMonto("retencion_receptor"),
        monto_liquido: extractMonto("honorariosliquidos"),
      });
    }

    page++;
    if (page < totalPages) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return { boletas: allBoletas, total: allBoletas.length, pages: totalPages };
}

// ==================== ROUTE HANDLER ====================

function splitRut(rutCompleto: string): { rut: string; dv: string } {
  const clean = rutCompleto.replace(/\./g, "").replace(/\s/g, "").trim();
  const parts = clean.split("-");
  return { rut: parts[0], dv: (parts[1] || "").toUpperCase() };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { rut: rutCompleto, clave, periodo } = body as { rut: string; clave: string; periodo: string };

    if (!rutCompleto || !clave || !periodo) {
      return NextResponse.json({ error: "Faltan parámetros: rut, clave, periodo" }, { status: 400 });
    }
    if (!/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "periodo debe ser YYYYMM" }, { status: 400 });
    }

    const { rut, dv } = splitRut(rutCompleto);
    const anio = periodo.slice(0, 4);
    const mes = periodo.slice(4, 6);

    // 1. Autenticar
    console.log(`[BHE] Autenticando RUT ${rut}-${dv}...`);
    const token = await autenticarSII(rut, dv, clave);
    if (!token) {
      return NextResponse.json({ error: "No se pudo autenticar con el SII. Verifica RUT y clave tributaria de la empresa." }, { status: 401 });
    }
    console.log(`[BHE] Token obtenido: ${token.slice(0, 8)}...`);

    // 2. Descargar BHE
    console.log(`[BHE] Descargando BHE ${anio}-${mes}...`);
    const { boletas, total } = await fetchBHE(token, rut, dv, anio, mes);
    console.log(`[BHE] ${total} boletas encontradas`);

    if (boletas.length === 0) {
      return NextResponse.json({ ok: true, periodo, registros: 0, data: [] });
    }

    // 3. Formatear para respuesta (el frontend guarda en Supabase)
    const data = boletas.map(b => ({
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
      evento_receptor: "BHE",
    }));

    return NextResponse.json({ ok: true, periodo, registros: data.length, data });
  } catch (err) {
    console.error("[BHE] Error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Error consultando BHE" }, { status: 500 });
  }
}
