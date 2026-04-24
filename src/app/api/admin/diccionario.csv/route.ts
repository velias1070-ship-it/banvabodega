/**
 * GET /api/admin/diccionario.csv
 *
 * Devuelve el diccionario de productos+composiciones en formato CSV
 * compatible con el que App Etiquetas (banva1) consumia desde Google Sheet.
 *
 * Reemplazo del flujo Sheet → CSV publico → App Etiquetas. Ahora BANVA es la
 * fuente de verdad y este endpoint emula el formato del Sheet para que
 * App Etiquetas funcione sin cambios al parser.
 *
 * Columnas (orden CRITICO, ver index.html parseCSV linea 552-605):
 *   A: SKU Venta
 *   B: Codigo ML
 *   C: Nombre Origen
 *   D: Proveedor (informativo, App Etiquetas lo ignora)
 *   E: SKU Origen
 *   F: Unidades (cantPack)
 *   G: Tamano (informativo)
 *   H: Color (informativo)
 *   I: Categoria (informativo)
 *
 * Una fila por (sku_venta, sku_origen). Si un sku_origen tiene multiples
 * sku_venta (packs/combos), aparecen multiples filas. Si un producto NO
 * tiene composicion_venta, no aparece (igual que el Sheet original).
 */
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

function csvEscape(value: string | null | undefined): string {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function GET() {
  const sb = getServerSupabase();
  if (!sb) {
    return new NextResponse("error: no_db\n", { status: 500, headers: { "content-type": "text/csv; charset=utf-8" } });
  }

  // Fetch productos + composicion_venta en paralelo
  const [{ data: productos, error: pErr }, { data: comps, error: cErr }] = await Promise.all([
    sb.from("productos").select("sku, nombre, proveedor, tamano, color, categoria"),
    sb.from("composicion_venta").select("sku_venta, sku_origen, codigo_ml, unidades, tipo_relacion"),
  ]);

  if (pErr || cErr) {
    return new NextResponse(`error: ${pErr?.message || cErr?.message}\n`, {
      status: 500,
      headers: { "content-type": "text/csv; charset=utf-8" },
    });
  }

  const prodMap = new Map<string, { nombre: string; proveedor: string; tamano: string; color: string; categoria: string }>();
  for (const p of productos || []) {
    prodMap.set((p.sku || "").toUpperCase(), {
      nombre: p.nombre || "",
      proveedor: p.proveedor || "",
      tamano: p.tamano || "",
      color: p.color || "",
      categoria: p.categoria || "",
    });
  }

  const lines: string[] = [];
  lines.push("SKU Venta,Codigo ML,Nombre Origen,Proveedor,SKU Origen,Unidades,Tamano,Color,Categoria");

  // Una fila por composicion. Filtrar tipo_relacion='alternativo' para que
  // las alternativas no contaminen el diccionario principal de etiquetas
  // (esas son swaps operativos, no la composicion canonica del pack).
  for (const c of comps || []) {
    if (c.tipo_relacion === "alternativo") continue;
    const skuOrigenUp = (c.sku_origen || "").toUpperCase();
    const prod = prodMap.get(skuOrigenUp);
    if (!prod) continue; // skip composiciones huerfanas
    lines.push([
      csvEscape(c.sku_venta || ""),
      csvEscape(c.codigo_ml || ""),
      csvEscape(prod.nombre),
      csvEscape(prod.proveedor),
      csvEscape(c.sku_origen || ""),
      csvEscape(c.unidades || 1),
      csvEscape(prod.tamano),
      csvEscape(prod.color),
      csvEscape(prod.categoria),
    ].join(","));
  }

  const csv = lines.join("\n") + "\n";

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "public, max-age=60", // 1 min cache para reducir carga
      "access-control-allow-origin": "*", // App Etiquetas vive en otro dominio
      "access-control-allow-methods": "GET",
    },
  });
}

export async function OPTIONS() {
  // Preflight CORS para App Etiquetas (otro dominio)
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}
