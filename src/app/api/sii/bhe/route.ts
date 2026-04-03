import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/sii/bhe
 * Body: { periodo } (credenciales desde env vars)
 * Descarga BTE (Boletas de Prestación de Servicios de Terceros) del SII.
 * Auth: RUT empresa + clave empresa en zeusr.sii.cl
 * Data: zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2
 */

export const maxDuration = 60;

const SII_AUTH_URL = "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi";
const BTE_URL = "https://zeus.sii.cl/cvc_cgi/bte/bte_indiv_cons2";
const SII_RUT = process.env.SII_BHE_RUT || "77994007";
const SII_DV = process.env.SII_BHE_DV || "1";
const SII_CLAVE = process.env.SII_BHE_CLAVE || "";
const SII_RUTCNTR = process.env.SII_BHE_RUTCNTR || "77.994.007-1";

// ==================== AUTH ====================

async function login(): Promise<string | null> {
  const body = new URLSearchParams({
    rut: SII_RUT,
    dv: SII_DV,
    referencia: BTE_URL,
    "411": "",
    rutcntr: SII_RUTCNTR,
    clave: SII_CLAVE,
  });

  const resp = await fetch(SII_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    body: body.toString(),
    redirect: "manual",
  });

  // Extraer todas las cookies
  const cookies: string[] = [];
  const setCookies = resp.headers.getSetCookie?.() || [];
  for (const c of setCookies) {
    const nv = c.split(";")[0];
    if (nv && !nv.includes("=DEL") && nv.includes("=")) cookies.push(nv);
  }
  if (!setCookies.length) {
    const raw = resp.headers.get("set-cookie") || "";
    for (const part of raw.split(/,(?=[A-Z])/)) {
      const nv = part.trim().split(";")[0];
      if (nv && !nv.includes("=DEL") && nv.includes("=")) cookies.push(nv);
    }
  }

  // Verificar login
  const html = await resp.text();
  if (html.includes("Rechazada")) {
    console.error(`[BHE] Login rechazado. Status: ${resp.status}. RUT: ${SII_RUT}. Clave length: ${SII_CLAVE.length}`);
    console.error(`[BHE] Response snippet: ${html.slice(0, 200)}`);
    return null;
  }

  const cookieStr = cookies.join("; ");
  const hasToken = cookies.some(c => c.startsWith("TOKEN="));
  console.log(`[BHE] Login OK. ${cookies.length} cookies, TOKEN=${hasToken}`);
  return hasToken ? cookieStr : null;
}

// ==================== FETCH & PARSE ====================

interface BTE {
  nro: string;
  estado: string;
  fecha_emision: string;
  rut_receptor: string;
  nombre_receptor: string;
  monto_bruto: number;
  retencion: number;
  monto_liquido: number;
}

async function fetchBTE(cookieStr: string, anio: number, mes: number): Promise<BTE[]> {
  const allBoletas: BTE[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const body = new URLSearchParams({
      TIPO: "mensual",
      CNTR: "1",
      AUTEN: "RUTCLAVE",
      PAGINA: String(page),
      MESM: String(mes).padStart(2, "0"),
      ANOM: String(anio),
    });

    const resp = await fetch(BTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieStr,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": BTE_URL,
      },
      body: body.toString(),
    });

    const html = await resp.text();

    if (html.includes("Rechazada")) {
      console.error("[BHE] BTE fetch rechazada");
      break;
    }

    // Extraer total de paginas
    const pageMatch = html.match(/P[aá]gina\s+(\d+)\s+de\s+(\d+)/);
    if (pageMatch) {
      totalPages = parseInt(pageMatch[2]);
    }

    // Parsear filas
    const rows = html.split("</tr>");
    for (const row of rows) {
      const cellMatches: string[] = [];
      const cellRegex = /<font class="reporte">([\s\S]*?)<\/font>/g;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(row)) !== null) {
        const val = cellMatch[1].trim();
        if (val.length > 0) cellMatches.push(val);
      }
      const cells = cellMatches;

      if (cells.length >= 8 && /^\d+$/.test(cells[0])) {
        // cells: [nro, estado_link, fecha_emi, rut_emi, nombre_emi, fecha_rec, rut_rec, nombre_rec, bruto, ret, pago]
        const nro = cells[0];

        // Extraer estado del link
        const estadoMatch = row.match(/overlib\('(\w+)'/);
        const estado = estadoMatch ? estadoMatch[1] : cells[1];

        // Fecha emisión (cells[2] o cells[3])
        const fechaIdx = cells.findIndex((c, i) => i > 0 && /^\d{2}-\d{2}-\d{4}$/.test(c));
        const fecha = fechaIdx >= 0 ? cells[fechaIdx] : "";

        // RUT y nombre receptor (después del emisor)
        let rutRec = "", nombreRec = "";
        let foundEmitter = false;
        for (let i = 1; i < cells.length; i++) {
          if (/^\d+-[0-9Kk]$/.test(cells[i]) || /^\d{7,8}-[0-9Kk]$/.test(cells[i])) {
            if (!foundEmitter) {
              foundEmitter = true; // primer RUT es emisor
            } else {
              rutRec = cells[i];
              nombreRec = i + 1 < cells.length ? cells[i + 1] : "";
              break;
            }
          }
        }

        // Montos: últimos 3 valores numéricos
        const montos: number[] = [];
        for (let i = cells.length - 1; i >= 0 && montos.length < 3; i--) {
          const clean = cells[i].replace(/\./g, "").replace(/,/g, "");
          if (/^\d+$/.test(clean) && clean.length > 2) {
            montos.unshift(parseInt(clean));
          }
        }

        // Convertir fecha DD-MM-YYYY → YYYY-MM-DD
        let fechaISO = fecha;
        if (fecha && fecha.includes("-")) {
          const parts = fecha.split("-");
          if (parts.length === 3 && parts[2].length === 4) {
            fechaISO = `${parts[2]}-${parts[1]}-${parts[0]}`;
          }
        }

        allBoletas.push({
          nro,
          estado,
          fecha_emision: fechaISO,
          rut_receptor: rutRec,
          nombre_receptor: nombreRec,
          monto_bruto: montos[0] || 0,
          retencion: montos[1] || 0,
          monto_liquido: montos[2] || 0,
        });
      }
    }

    console.log(`[BHE] Pagina ${page}/${totalPages}: ${allBoletas.length} boletas acumuladas`);
    page++;

    if (page <= totalPages) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return allBoletas;
}

// ==================== HANDLER ====================

export async function POST(req: NextRequest) {
  if (!SII_CLAVE) {
    return NextResponse.json({ error: "SII_BHE_CLAVE no configurada en variables de entorno" }, { status: 500 });
  }

  const sb = getServerSupabase();

  try {
    const body = await req.json();
    const { periodo } = body as { periodo: string };

    if (!periodo || !/^\d{6}$/.test(periodo)) {
      return NextResponse.json({ error: "periodo debe ser YYYYMM" }, { status: 400 });
    }

    const anio = parseInt(periodo.slice(0, 4));
    const mes = parseInt(periodo.slice(4, 6));

    // 1. Login
    console.log(`[BHE] Autenticando empresa ${SII_RUT}-${SII_DV}...`);
    const cookieStr = await login();
    if (!cookieStr) {
      return NextResponse.json({
        error: "No se pudo autenticar con el SII",
        debug: { rut: SII_RUT, dv: SII_DV, claveLen: SII_CLAVE.length, rutcntr: SII_RUTCNTR }
      }, { status: 401 });
    }

    // 2. Fetch BTE
    console.log(`[BHE] Descargando BTE ${anio}-${String(mes).padStart(2, "0")}...`);
    const boletas = await fetchBTE(cookieStr, anio, mes);
    console.log(`[BHE] ${boletas.length} boletas encontradas`);

    if (boletas.length === 0) {
      return NextResponse.json({ ok: true, periodo, registros: 0, data: [] });
    }

    // 3. Formatear para Supabase
    const data = boletas.map(b => ({
      periodo,
      estado: "REGISTRO",
      tipo_doc: 71,
      nro_doc: b.nro,
      rut_proveedor: b.rut_receptor,
      razon_social: b.nombre_receptor,
      fecha_docto: b.fecha_emision,
      monto_exento: 0,
      monto_neto: b.monto_bruto,
      monto_iva: b.retencion,
      monto_total: b.monto_liquido,
      fecha_recepcion: b.fecha_emision,
      evento_receptor: "BTE",
    }));

    // 4. Upsert a Supabase si hay conexión
    if (sb) {
      const empresas = await sb.from("empresas").select("id").limit(1);
      const empresaId = empresas.data?.[0]?.id;
      if (empresaId) {
        const records = data.map(d => ({ ...d, empresa_id: empresaId }));
        for (let i = 0; i < records.length; i += 500) {
          await sb.from("rcv_compras").upsert(records.slice(i, i + 500), {
            onConflict: "empresa_id,periodo,tipo_doc,nro_doc,rut_proveedor",
          });
        }
        await sb.from("sync_log").insert({
          empresa_id: empresaId, periodo, tipo: "compras", registros: records.length,
        });
        console.log(`[BHE] ${records.length} boletas guardadas en Supabase`);
      }
    }

    return NextResponse.json({ ok: true, periodo, registros: data.length, data });
  } catch (err) {
    console.error("[BHE] Error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
  }
}
