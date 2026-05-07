import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/dimensiones/import-excel
 *
 * Body: multipart/form-data
 *   - file (xlsx): primer hoja, header en alguna fila con columna "sku" más
 *     largo_cm, ancho_cm, alto_cm, peso_real_gr (acepta variantes razonables).
 *
 * Query:
 *   - dry_run=true → no escribe, solo valida y devuelve preview
 *
 * Validaciones por fila:
 *   - sku no vacío y existe en productos
 *   - cada dim > 0 (si vacío, queda NULL → no pisa lo existente)
 *   - peso_real_gr > 0 (idem)
 *
 * Response observable (regla 4):
 *   { ok, dry_run, procesados, escritos, omitidos[], errores[], header_detectado }
 */

// Orden importante: el primer alias que matchee gana. Por eso 'sku origen'
// va antes que 'sku venta' (queremos productos.sku = sku_origen, no sku_venta).
const HEADER_ALIASES: Record<string, string[]> = {
  sku: ["sku origen", "sku_origen", "sku", "sku venta", "sku_venta", "código", "codigo", "code"],
  largo_cm: ["largo_cm", "largo", "length_cm", "length", "l"],
  ancho_cm: ["ancho_cm", "ancho", "width_cm", "width", "w"],
  alto_cm: ["alto_cm", "alto", "height_cm", "height", "h", "altura"],
  peso_real_gr: ["peso_real_gr", "peso_gr", "peso_g", "peso_real", "peso", "peso (g)", "peso(g)", "weight_g", "weight_gr"],
  peso_real_kg: ["peso_kg", "peso_real_kg", "weight_kg", "peso (kg)", "peso(kg)"],
};

function findColIdx(header: string[], aliases: string[]): number {
  for (const a of aliases) {
    const idx = header.indexOf(a);
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";
  const sheetParam = url.searchParams.get("sheet"); // nombre o índice opcional
  const originParam = url.searchParams.get("origin") || "excel"; // bodega|excel|manual
  const ALLOWED_ORIGINS = ["excel", "bodega", "manual"] as const;
  if (!ALLOWED_ORIGINS.includes(originParam as (typeof ALLOWED_ORIGINS)[number])) {
    return NextResponse.json({ error: `origin inválido: ${originParam}. Permitidos: ${ALLOWED_ORIGINS.join(",")}` }, { status: 400 });
  }
  const origen = originParam as "excel" | "bodega" | "manual";

  let buf: Buffer;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Falta campo 'file' (Excel)" }, { status: 400 });
    }
    const arrBuf = await file.arrayBuffer();
    buf = Buffer.from(arrBuf);
  } catch (err) {
    return NextResponse.json({ error: `Error leyendo archivo: ${String(err)}` }, { status: 400 });
  }

  const wb = XLSX.read(buf, { type: "buffer" });
  // Resolver hoja a usar: param explícito (nombre o índice), default primera.
  let sheetName: string;
  if (sheetParam) {
    if (/^\d+$/.test(sheetParam)) {
      const idx = Number(sheetParam);
      if (idx < 0 || idx >= wb.SheetNames.length) {
        return NextResponse.json({ error: `Índice de hoja fuera de rango (0..${wb.SheetNames.length - 1})`, available_sheets: wb.SheetNames }, { status: 400 });
      }
      sheetName = wb.SheetNames[idx];
    } else if (wb.SheetNames.includes(sheetParam)) {
      sheetName = sheetParam;
    } else {
      return NextResponse.json({ error: `Hoja '${sheetParam}' no existe`, available_sheets: wb.SheetNames }, { status: 400 });
    }
  } else {
    sheetName = wb.SheetNames[0];
  }
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });

  // Buscar fila header (contiene un alias de "sku")
  const skuAliases = HEADER_ALIASES.sku;
  const headerIdx = aoa.findIndex(row => {
    if (!Array.isArray(row)) return false;
    return row.some(c => skuAliases.includes(String(c || "").toLowerCase().trim()));
  });
  if (headerIdx < 0) {
    return NextResponse.json({ error: "No se encontró fila header con columna 'sku'" }, { status: 400 });
  }
  const header = aoa[headerIdx].map(c => String(c || "").trim().toLowerCase());

  const idxSku = findColIdx(header, HEADER_ALIASES.sku);
  const idxLargo = findColIdx(header, HEADER_ALIASES.largo_cm);
  const idxAncho = findColIdx(header, HEADER_ALIASES.ancho_cm);
  const idxAlto  = findColIdx(header, HEADER_ALIASES.alto_cm);
  const idxPesoGr = findColIdx(header, HEADER_ALIASES.peso_real_gr);
  const idxPesoKg = findColIdx(header, HEADER_ALIASES.peso_real_kg);

  if (idxSku < 0) {
    return NextResponse.json({ error: "Falta columna SKU", header_detectado: header }, { status: 400 });
  }
  if (idxLargo < 0 && idxAncho < 0 && idxAlto < 0 && idxPesoGr < 0 && idxPesoKg < 0) {
    return NextResponse.json({
      error: "Sin columnas de dimensiones reconocidas (largo_cm, ancho_cm, alto_cm, peso_real_gr/peso_kg)",
      header_detectado: header,
    }, { status: 400 });
  }

  // SKUs válidos
  const { data: prodData, error: prodErr } = await sb.from("productos").select("sku");
  if (prodErr) {
    console.error("[dim-import] productos query failed:", prodErr.message);
    return NextResponse.json({ error: prodErr.message }, { status: 500 });
  }
  const skusValidos = new Set((prodData || []).map((p: { sku: string }) => p.sku.toUpperCase()));

  type Update = {
    sku: string;
    largo_cm: number | null;
    ancho_cm: number | null;
    alto_cm: number | null;
    peso_real_gr: number | null;
  };
  const updates: Update[] = [];
  const omitidos: { sku: string; razon: string }[] = [];

  const dataRows = aoa.slice(headerIdx + 1);
  const nowIso = new Date().toISOString();

  for (const row of dataRows) {
    if (!Array.isArray(row)) continue;
    const skuRaw = String(row[idxSku] || "").trim();
    if (!skuRaw) continue;
    const sku = skuRaw.toUpperCase();
    if (!skusValidos.has(sku)) {
      omitidos.push({ sku, razon: "no existe en productos" });
      continue;
    }
    const num = (idx: number): number | null => {
      if (idx < 0) return null;
      const v = row[idx];
      if (v === null || v === undefined || v === "") return null;
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const largo = num(idxLargo);
    const ancho = num(idxAncho);
    const alto  = num(idxAlto);
    let pesoGr: number | null = num(idxPesoGr);
    if (pesoGr === null) {
      const pesoKg = num(idxPesoKg);
      if (pesoKg !== null) pesoGr = Math.round(pesoKg * 1000);
    } else {
      pesoGr = Math.round(pesoGr);
    }

    if (largo === null && ancho === null && alto === null && pesoGr === null) {
      omitidos.push({ sku, razon: "todas las medidas vacías o inválidas" });
      continue;
    }
    updates.push({ sku, largo_cm: largo, ancho_cm: ancho, alto_cm: alto, peso_real_gr: pesoGr });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      procesados: dataRows.length,
      a_escribir: updates.length,
      omitidos,
      preview: updates.slice(0, 10),
      header_detectado: header,
      available_sheets: wb.SheetNames,
      sheet_used: sheetName,
    });
  }

  // Escribir. update por sku, solo seteamos los campos no-null más metadata.
  let escritos = 0;
  const errores: { sku: string; error: string }[] = [];
  for (const u of updates) {
    const payload: Record<string, unknown> = {
      dimensiones_origen: origen,
      dimensiones_updated_at: nowIso,
      dimensiones_updated_by: `excel-import (${origen})`,
    };
    if (u.largo_cm !== null) payload.largo_cm = u.largo_cm;
    if (u.ancho_cm !== null) payload.ancho_cm = u.ancho_cm;
    if (u.alto_cm !== null)  payload.alto_cm = u.alto_cm;
    if (u.peso_real_gr !== null) payload.peso_real_gr = u.peso_real_gr;

    const { error: upErr } = await sb.from("productos").update(payload).eq("sku", u.sku);
    if (upErr) {
      errores.push({ sku: u.sku, error: upErr.message });
      continue;
    }
    escritos += 1;
  }

  return NextResponse.json({
    ok: true,
    dry_run: false,
    procesados: dataRows.length,
    escritos,
    omitidos,
    errores,
    header_detectado: header,
    sheet_used: sheetName,
  });
}
