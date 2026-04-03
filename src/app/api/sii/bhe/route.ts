import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/sii/bhe
 * Body: { rut, clave, periodo }
 * Descarga boletas de honorarios electrónicas (BHE) recibidas del SII.
 * Usa autenticación por clave tributaria (misma que /api/sii/rcv).
 */

export const maxDuration = 60;

const SII_AUTH_URL = "https://zeusr.sii.cl/cgi_AUT2000/CAutInWor498.cgi";
const BHE_CGI_URL = "https://palena.sii.cl/cgi_IMT/TMBCOC_InformeMensualBheRec.cgi";

// ==================== AUTH ====================

/**
 * Auth SII real: 2 pasos
 * 1. POST CAutInicio.cgi con rut, dv, referencia, rutcntr, clave → obtiene cookies de sesion
 * 2. POST AutTknData.cgi → obtiene cookie token (TSdf5d7d41027=...)
 * Retorna el string de cookies para usar en requests posteriores.
 */
async function autenticarSII(rut: string, dv: string, clave: string): Promise<string | null> {
  try {
    const rutFmt = `${rut.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`;

    // Paso 1: CAutInicio.cgi
    const loginBody = new URLSearchParams({
      rut,
      dv,
      referencia: "https://misiir.sii.cl/cgi_misii/siihome.cgi",
      "411": "",
      rutcntr: rutFmt,
      clave,
    });

    console.log(`[BHE Auth] Paso 1: CAutInicio.cgi rut=${rut}-${dv}`);
    const loginResp = await fetch(SII_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: loginBody.toString(),
      redirect: "manual",
    });

    // Recoger cookies del paso 1
    const allCookies: string[] = [];
    const setCookies1 = loginResp.headers.getSetCookie?.() || [];
    for (const c of setCookies1) {
      const nameVal = c.split(";")[0];
      if (nameVal && !nameVal.includes("=DEL")) allCookies.push(nameVal);
    }
    if (!setCookies1.length) {
      const raw = loginResp.headers.get("set-cookie") || "";
      for (const part of raw.split(",")) {
        const nameVal = part.trim().split(";")[0];
        if (nameVal && nameVal.includes("=") && !nameVal.includes("=DEL")) allCookies.push(nameVal);
      }
    }

    // Verificar si el login falló
    const loginHtml = await loginResp.text();
    if (loginHtml.includes("Transaccion Rechazada")) {
      console.error("[BHE Auth] Transaccion Rechazada en CAutInicio");
      return null;
    }

    console.log(`[BHE Auth] Paso 1 OK. Cookies: ${allCookies.length}`);

    // Paso 2: AutTknData.cgi — obtener token de sesion
    const rnd = Math.random();
    const tknUrl = `https://zeusr.sii.cl/cgi_AUT2000/AutTknData.cgi?rnd=${rnd}`;
    const cookieStr = allCookies.join("; ");

    const tknResp = await fetch(tknUrl, {
      method: "POST",
      headers: {
        "Cookie": cookieStr,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });

    // Recoger cookie token del paso 2
    const setCookies2 = tknResp.headers.getSetCookie?.() || [];
    for (const c of setCookies2) {
      const nameVal = c.split(";")[0];
      if (nameVal && !nameVal.includes("=DEL") && nameVal.includes("=")) allCookies.push(nameVal);
    }
    if (!setCookies2.length) {
      const raw = tknResp.headers.get("set-cookie") || "";
      for (const part of raw.split(",")) {
        const nameVal = part.trim().split(";")[0];
        if (nameVal && nameVal.includes("=") && !nameVal.includes("=DEL")) allCookies.push(nameVal);
      }
    }

    const finalCookies = allCookies.join("; ");
    console.log(`[BHE Auth] Paso 2 OK. Total cookies: ${allCookies.length}`);

    if (allCookies.length < 2) {
      console.error("[BHE Auth] Pocas cookies, auth probablemente fallo");
      return null;
    }

    return finalCookies;
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

async function fetchBHE(cookieStr: string, rutEmpresa: string, dvEmpresa: string, anio: string, mes: string): Promise<{ boletas: BHEBoleta[]; total: number; pages: number }> {
  const allBoletas: BHEBoleta[] = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    const url = `${BHE_CGI_URL}?cbanoinformemensual=${anio}&cbmesinformemensual=${mes}&dv_arrastre=${dvEmpresa}&pagina_solicitada=${page}&rut_arrastre=${rutEmpresa}`;

    const resp = await fetch(url, {
      headers: {
        "Cookie": cookieStr,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
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
    const { rut: rutCompleto, clave, periodo, rutEmpresa: rutEmpresaParam } = body as { rut: string; clave: string; periodo: string; rutEmpresa?: string };

    if (!rutCompleto || !clave || !periodo) {
      return NextResponse.json({ error: "Faltan parámetros: rut, clave, periodo" }, { status: 400 });
    }
    if (!/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "periodo debe ser YYYYMM" }, { status: 400 });
    }

    // RUT de login (persona que se autentica)
    const { rut: rutLogin, dv: dvLogin } = splitRut(rutCompleto);
    // RUT de empresa (para consultar BHE recibidas — puede ser diferente al de login)
    const rutEmpresaStr = rutEmpresaParam || rutCompleto;
    const { rut: rutEmpresa, dv: dvEmpresa } = splitRut(rutEmpresaStr);
    const anio = periodo.slice(0, 4);
    const mes = periodo.slice(4, 6);

    // 1. Autenticar con RUT de la persona
    console.log(`[BHE] Autenticando RUT ${rutLogin}-${dvLogin}...`);
    const cookieStr = await autenticarSII(rutLogin, dvLogin, clave);
    if (!cookieStr) {
      return NextResponse.json({ error: "No se pudo autenticar con el SII. Verifica RUT y clave tributaria." }, { status: 401 });
    }
    console.log(`[BHE] Auth OK. Cookies: ${cookieStr.slice(0, 40)}...`);

    // 2. Descargar BHE de la empresa
    console.log(`[BHE] Descargando BHE empresa ${rutEmpresa}-${dvEmpresa} ${anio}-${mes}...`);
    const { boletas, total } = await fetchBHE(cookieStr, rutEmpresa, dvEmpresa, anio, mes);
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
