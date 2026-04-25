/**
 * Sync final server-side del Google Sheet "Diccionario" → BANVA.
 *
 * Este endpoint replica la logica de syncDiccionarioFromSheet() de db.ts
 * pero usando el cliente server-side. Diseñado para la transicion de matar
 * el Sheet como fuente de verdad: permite forzar un sync final sin depender
 * de que un admin abra /admin.
 *
 * Adicionalmente devuelve un reporte de auditoria: filas del Sheet que
 * terminaron en diferencias contra BANVA, para revision manual.
 *
 * GET /api/admin/sync-diccionario-final?dry_run=1 → solo reporte, no escribe
 * GET /api/admin/sync-diccionario-final            → ejecuta sync + reporte
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const DICT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQZxKcXM-OaJ5_B-lEM87PPy9B4675FRFLfpWtL-ZhTqpalZNqODq18XFY2C4txj7fXc5n1jYZSTWrJ/pub?gid=348421726&single=true&output=csv";

function parseCSVLine(line: string): string[] {
  const cells: string[] = [];
  let current = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { cells.push(current.trim()); current = ""; }
    else current += ch;
  }
  cells.push(current.trim());
  return cells;
}

interface SheetRow {
  skuVenta: string; codigoMl: string; nombreOrigen: string;
  proveedor: string; skuOrigen: string; unidades: number;
  tamano: string; color: string; categoria: string; costo: number;
}

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";
  const sb = getServerSupabase();
  if (!sb) return NextResponse.json({ error: "no_db" }, { status: 500 });

  // 1. Descargar CSV
  let csvText: string;
  try {
    const resp = await fetch(DICT_CSV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    csvText = await resp.text();
  } catch (e) {
    return NextResponse.json({ error: `csv_fetch_failed: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }

  const lines = csvText.split("\n").map(l => l.replace(/\r/g, "").trim()).filter(l => l.length > 0);
  if (lines.length < 2) return NextResponse.json({ error: "csv_empty" }, { status: 400 });

  // 2. Parsear filas
  const rows: SheetRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCSVLine(lines[i]);
    const skuOrigen = (c[4] || "").trim().toUpperCase();
    const nombreOrigen = (c[2] || "").trim();
    if (!skuOrigen || !nombreOrigen) continue;
    rows.push({
      skuVenta: (c[0] || "").trim().toUpperCase(),
      codigoMl: (c[1] || "").trim(),
      nombreOrigen,
      proveedor: (c[3] || "").trim(),
      skuOrigen,
      unidades: parseInt(c[5] || "1") || 1,
      tamano: (c[6] || "").trim(),
      color: (c[7] || "").trim(),
      categoria: (c[8] || "").trim() || "Otros",
      costo: parseFloat(c[13] || "0") || 0,
    });
  }

  // 3. Snapshot BANVA
  const [{ data: prodsDB }, { data: compsDB }] = await Promise.all([
    sb.from("productos").select("sku, nombre, categoria, proveedor, costo, costo_promedio, tamano, color, codigo_ml, requiere_etiqueta"),
    sb.from("composicion_venta").select("sku_venta, sku_origen, unidades, tipo_relacion, nota_operativa"),
  ]);
  const prodMapDB = new Map((prodsDB || []).map(p => [(p.sku || "").toUpperCase(), p]));
  const compMapDB = new Map((compsDB || []).map(c => [
    `${(c.sku_venta || "").toUpperCase()}|${(c.sku_origen || "").toUpperCase()}`,
    c,
  ]));

  // 4. Construir productMap desde Sheet (mismo algoritmo de syncDiccionarioFromSheet)
  const productMap = new Map<string, SheetRow & { costoCalc: number }>();
  const codigosMlByOrigen = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!codigosMlByOrigen.has(row.skuOrigen)) codigosMlByOrigen.set(row.skuOrigen, new Set());
    if (row.codigoMl) codigosMlByOrigen.get(row.skuOrigen)!.add(row.codigoMl);

    if (!productMap.has(row.skuOrigen)) {
      productMap.set(row.skuOrigen, {
        ...row,
        costoCalc: row.unidades === 1 ? row.costo : (row.unidades > 0 ? Math.round(row.costo / row.unidades) : row.costo),
      });
    } else {
      const ex = productMap.get(row.skuOrigen)!;
      if (row.unidades === 1) {
        ex.costoCalc = row.costo;
        ex.nombreOrigen = row.nombreOrigen;
      } else if (row.skuVenta === row.skuOrigen && ex.nombreOrigen !== row.nombreOrigen) {
        ex.nombreOrigen = row.nombreOrigen;
      }
    }
  }

  // 5. Diff reporte
  const diffs: {
    productos_nuevos: string[];
    productos_con_cambios: Array<{ sku: string; cambios: string[] }>;
    productos_en_db_no_en_sheet: Array<{ sku: string; nombre: string; proveedor: string; costo: number }>;
    composiciones_nuevas: string[];
    composiciones_huerfanas_en_db: string[]; // en DB pero no en Sheet (serian borradas)
  } = {
    productos_nuevos: [],
    productos_con_cambios: [],
    productos_en_db_no_en_sheet: [],
    composiciones_nuevas: [],
    composiciones_huerfanas_en_db: [],
  };

  // Productos en DB que NO estan en Sheet (los "extras" auto-creados por syncStockFull
  // o manuales que nunca pasaron por el Sheet)
  prodMapDB.forEach((dbRow, skuOrigen) => {
    if (!productMap.has(skuOrigen)) {
      diffs.productos_en_db_no_en_sheet.push({
        sku: skuOrigen,
        nombre: dbRow.nombre || "(sin nombre)",
        proveedor: dbRow.proveedor || "(sin proveedor)",
        costo: dbRow.costo || 0,
      });
    }
  });

  const toUpsertProds: Record<string, unknown>[] = [];
  productMap.forEach((sheet, skuOrigen) => {
    const dbRow = prodMapDB.get(skuOrigen);
    const codigos = codigosMlByOrigen.get(skuOrigen);
    const codigoMlConcat = codigos ? Array.from(codigos).join(",") : "";
    const requiereEtiqueta = !!codigoMlConcat;

    // WAC protection: respetar costo_promedio
    const tieneWacReal = (dbRow?.costo_promedio || 0) > 0;
    const costoFinal = tieneWacReal ? dbRow!.costo : sheet.costoCalc;

    const target = {
      sku: skuOrigen,
      nombre: sheet.nombreOrigen,
      categoria: sheet.categoria,
      proveedor: sheet.proveedor,
      costo: costoFinal,
      tamano: sheet.tamano,
      color: sheet.color,
      codigo_ml: codigoMlConcat,
      requiere_etiqueta: requiereEtiqueta,
    };

    if (!dbRow) {
      diffs.productos_nuevos.push(skuOrigen);
      toUpsertProds.push({ ...target, precio: 0, reorder: 20 });
    } else {
      const cambios: string[] = [];
      if (dbRow.nombre !== target.nombre) cambios.push(`nombre: "${dbRow.nombre}" → "${target.nombre}"`);
      if (dbRow.categoria !== target.categoria) cambios.push(`categoria: "${dbRow.categoria}" → "${target.categoria}"`);
      if (dbRow.proveedor !== target.proveedor) cambios.push(`proveedor: "${dbRow.proveedor}" → "${target.proveedor}"`);
      if (dbRow.costo !== target.costo) cambios.push(`costo: ${dbRow.costo} → ${target.costo}${tieneWacReal ? " (bloqueado por WAC)" : ""}`);
      if ((dbRow.tamano || "") !== target.tamano) cambios.push(`tamano: "${dbRow.tamano || ""}" → "${target.tamano}"`);
      if ((dbRow.color || "") !== target.color) cambios.push(`color: "${dbRow.color || ""}" → "${target.color}"`);
      if ((dbRow.codigo_ml || "") !== target.codigo_ml) cambios.push(`codigo_ml: diff`);
      if (dbRow.requiere_etiqueta !== target.requiere_etiqueta) cambios.push(`requiere_etiqueta: ${dbRow.requiere_etiqueta} → ${target.requiere_etiqueta}`);

      if (cambios.length > 0) {
        diffs.productos_con_cambios.push({ sku: skuOrigen, cambios });
        toUpsertProds.push(target);
      }
    }
  });

  // Composicion diff
  const sheetCompKeys = new Set<string>();
  const toUpsertComps: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row.skuVenta) continue;
    const key = `${row.skuVenta}|${row.skuOrigen}`;
    if (sheetCompKeys.has(key)) continue;
    sheetCompKeys.add(key);
    const dbRow = compMapDB.get(key);
    if (!dbRow) {
      diffs.composiciones_nuevas.push(key);
      toUpsertComps.push({
        sku_venta: row.skuVenta, sku_origen: row.skuOrigen,
        unidades: row.unidades, codigo_ml: row.codigoMl,
        tipo_relacion: "componente",
      });
    } else if (dbRow.unidades !== row.unidades) {
      toUpsertComps.push({
        sku_venta: row.skuVenta, sku_origen: row.skuOrigen,
        unidades: row.unidades, codigo_ml: row.codigoMl,
        tipo_relacion: dbRow.tipo_relacion || "componente",
        nota_operativa: dbRow.nota_operativa || null,
      });
    }
  }
  compMapDB.forEach((dbRow, key) => {
    if (!sheetCompKeys.has(key) && dbRow.tipo_relacion !== "alternativo" && !dbRow.nota_operativa) {
      diffs.composiciones_huerfanas_en_db.push(key);
    }
  });

  // 6. Ejecutar (si no dry_run)
  let executed: { productos_upsert: number; composiciones_upsert: number; error?: string } = {
    productos_upsert: 0, composiciones_upsert: 0,
  };
  if (!dryRun) {
    if (toUpsertProds.length > 0) {
      for (let i = 0; i < toUpsertProds.length; i += 100) {
        const { error } = await sb.from("productos").upsert(toUpsertProds.slice(i, i + 100), { onConflict: "sku" });
        if (error) { executed.error = error.message; break; }
      }
      executed.productos_upsert = toUpsertProds.length;
    }
    if (toUpsertComps.length > 0 && !executed.error) {
      for (let i = 0; i < toUpsertComps.length; i += 100) {
        const { error } = await sb.from("composicion_venta").upsert(toUpsertComps.slice(i, i + 100), { onConflict: "sku_venta,sku_origen" });
        if (error) { executed.error = error.message; break; }
      }
      executed.composiciones_upsert = toUpsertComps.length;
    }
  }

  return NextResponse.json({
    ok: !executed.error,
    dry_run: dryRun,
    sheet_rows: rows.length,
    sheet_productos_unicos: productMap.size,
    db_productos: prodMapDB.size,
    db_composiciones: compMapDB.size,
    diffs: {
      productos_nuevos_count: diffs.productos_nuevos.length,
      productos_con_cambios_count: diffs.productos_con_cambios.length,
      productos_en_db_no_en_sheet_count: diffs.productos_en_db_no_en_sheet.length,
      composiciones_nuevas_count: diffs.composiciones_nuevas.length,
      composiciones_huerfanas_en_db_count: diffs.composiciones_huerfanas_en_db.length,
      productos_nuevos_sample: diffs.productos_nuevos.slice(0, 20),
      productos_con_cambios_sample: diffs.productos_con_cambios.slice(0, 20),
      productos_en_db_no_en_sheet: diffs.productos_en_db_no_en_sheet,
      composiciones_nuevas_sample: diffs.composiciones_nuevas.slice(0, 20),
      composiciones_huerfanas_sample: diffs.composiciones_huerfanas_en_db.slice(0, 20),
    },
    executed,
  });
}
