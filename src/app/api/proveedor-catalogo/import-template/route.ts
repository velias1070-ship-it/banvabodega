import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/proveedor-catalogo/import-template
 *
 * Body: multipart/form-data con campo "file" = Excel template lleno
 *       (el generado por scripts/generate-catalogo-template.mjs)
 *
 * Query:
 *   ?dry_run=true → no escribe, solo valida y devuelve resumen + alertas
 *   ?apply=true   → escribe a proveedor_catalogo (default si no se pasa dry_run)
 *
 * Validaciones por fila:
 *   - sku no vacío y existe en productos
 *   - precio_neto numérico > 0 (sino se omite + se loggea)
 *   - inner_pack >= 1 (default 1)
 *   - precio_bruto = round(precio_neto * 1.19)
 *   - alerta si abs(precio_neto - wac_actual) / wac_actual > 0.20
 *
 * Respuesta:
 *   {
 *     ok: true,
 *     dry_run: boolean,
 *     procesados: N,
 *     omitidos: [{ sku, razon }],
 *     alertas_diff_grande: [{ sku, precio_neto, wac, diff_pct }],
 *     escritos: N (0 si dry_run),
 *     por_proveedor: { [prov]: count }
 *   }
 */
export async function POST(req: NextRequest) {
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  // 1. Recibir archivo
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

  // 2. Parsear Excel — buscar la hoja y la fila header
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });

  // Buscar fila header (contiene "sku" en col 0)
  const headerIdx = aoa.findIndex(row => Array.isArray(row) && String(row[0] || "").toLowerCase().trim() === "sku");
  if (headerIdx < 0) {
    return NextResponse.json({ error: "No se encontró fila header con columna 'sku'" }, { status: 400 });
  }
  const header = aoa[headerIdx].map(c => String(c || "").trim().toLowerCase());
  const colIdx = (name: string) => header.indexOf(name);
  const idxSku = colIdx("sku");
  const idxProveedor = colIdx("proveedor");
  const idxInnerPack = colIdx("inner_pack");
  const idxPrecioNeto = colIdx("precio_neto");
  const idxWac = colIdx("wac_actual_referencia");

  if (idxSku < 0 || idxProveedor < 0 || idxPrecioNeto < 0) {
    return NextResponse.json({
      error: "Faltan columnas obligatorias (sku, proveedor, precio_neto)",
      header_encontrado: header,
    }, { status: 400 });
  }

  // 3. Cargar SKUs válidos desde productos para validar existencia
  const { data: prodData } = await sb.from("productos").select("sku");
  const skusValidos = new Set((prodData || []).map((p: { sku: string }) => p.sku.toUpperCase()));

  // 4. Procesar filas
  const dataRows = aoa.slice(headerIdx + 1);
  const omitidos: { sku: string; razon: string }[] = [];
  const alertas: { sku: string; precio_neto: number; wac: number; diff_pct: number }[] = [];
  const aUpsertear: {
    proveedor: string;
    sku_origen: string;
    precio_neto: number;
    inner_pack: number;
    stock_disponible: number | null;
  }[] = [];
  const porProveedor: Record<string, number> = {};

  for (const row of dataRows) {
    if (!Array.isArray(row)) continue;
    const skuRaw = String(row[idxSku] || "").trim();
    if (!skuRaw) continue;
    const sku = skuRaw.toUpperCase();
    const proveedor = String(row[idxProveedor] || "").trim();
    const precioNetoRaw = row[idxPrecioNeto];
    const precioNeto = Number(precioNetoRaw);
    const innerPack = idxInnerPack >= 0 ? Number(row[idxInnerPack]) || 1 : 1;
    const wac = idxWac >= 0 ? Number(row[idxWac]) || 0 : 0;

    // Validaciones
    if (!proveedor) { omitidos.push({ sku, razon: "proveedor vacío" }); continue; }
    if (!skusValidos.has(sku)) { omitidos.push({ sku, razon: "SKU no existe en productos" }); continue; }
    if (!Number.isFinite(precioNeto) || precioNeto <= 0) {
      omitidos.push({ sku, razon: "precio_neto vacío o ≤ 0" });
      continue;
    }

    // Alerta diff > 20% vs WAC
    if (wac > 0) {
      const diffPct = Math.round(1000 * (precioNeto - wac) / wac) / 10;
      if (Math.abs(diffPct) > 20) {
        alertas.push({ sku, precio_neto: precioNeto, wac, diff_pct: diffPct });
      }
    }

    aUpsertear.push({
      proveedor,
      sku_origen: sku,
      precio_neto: precioNeto,
      inner_pack: innerPack >= 1 ? innerPack : 1,
      stock_disponible: null, // no se carga desde este template
    });
    porProveedor[proveedor] = (porProveedor[proveedor] || 0) + 1;
  }

  // 5. Aplicar (si no es dry_run)
  let escritos = 0;
  if (!dryRun && aUpsertear.length > 0) {
    const now = new Date().toISOString();
    const rows = aUpsertear.map(r => ({ ...r, updated_at: now }));
    const { error } = await sb.from("proveedor_catalogo")
      .upsert(rows, { onConflict: "proveedor,sku_origen" });
    if (error) {
      return NextResponse.json({
        error: `Error escribiendo: ${error.message}`,
        procesados: aUpsertear.length,
        omitidos,
        alertas_diff_grande: alertas,
      }, { status: 500 });
    }
    escritos = rows.length;
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    procesados: aUpsertear.length,
    omitidos,
    alertas_diff_grande: alertas,
    escritos,
    por_proveedor: porProveedor,
  });
}
