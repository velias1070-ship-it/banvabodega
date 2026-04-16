// Genera template Excel para que Vicente cargue precios de catálogo
// de proveedores no-Idetex (Verbo Divino, Container, Materos).
//
// Uso: node scripts/generate-catalogo-template.mjs
//
// Output: ./template-catalogo-proveedores.xlsx

import * as XLSX from "xlsx";
import { writeFileSync } from "fs";
import { resolve } from "path";

// 23 SKUs A/B sin catálogo, ordenados por proveedor + margen.
// Datos extraídos de Supabase 2026-04-16 (snapshot al armar template).
const FILAS = [
  // Verbo Divino (13)
  { sku: "9788481693263", nombre: "La Biblia Latinoamericana Bolsillo Tapa Dura Color Editorial Verbo Divino", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 8194, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "9788471511348", nombre: "Biblia Normal", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 10925, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "9788490736609", nombre: "Biblia Catolica Para Jovenes Edicion Dos Tintas T.dura", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 18572, abc: "A", cuadrante: "CASHCOW" },
  { sku: "9788481693232", nombre: "Biblia Letra grande Sin uñero", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 14202, abc: "B", cuadrante: "REVISAR" },
  { sku: "9788433030467", nombre: "Biblia De Jerusalen 5ta Edicion - Desclee", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 31955, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788499451114", nombre: "Biblia Latinoamerica De Bolsillo Bernardo con uñero", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 11198, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788490736630", nombre: "Biblia Catolica Para Jovenes Chica", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 12353, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788481693294", nombre: "Biblia Bolsillo Blanca", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 8403, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788433031075", nombre: "Biblia De Jerusalen Latinoamericana - La Gran Aventura", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 40966, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788490734599", nombre: "Biblia Verbo Divino", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 2521, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788481693270", nombre: "Biblia Bolsillo Nacarina", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 6118, abc: "C", cuadrante: "REVISAR" },
  { sku: "9788471510211", nombre: "La Biblia Del Niño / The Bible For Children", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 2731, abc: "C", cuadrante: "REVISAR" },
  { sku: "BIB-LA-11", nombre: "Biblia Letra Grande con uñero", proveedor: "Verbo Divino", inner_pack: 1, precio_neto: "", wac_actual_referencia: 17647, abc: "C", cuadrante: "REVISAR" },
  // Container (4)
  { sku: "PRO-LUX-27", nombre: "Caja Protector Termostato", proveedor: "Container", inner_pack: 1, precio_neto: "", wac_actual_referencia: 2983, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "XYCMN405", nombre: "Botella Kit Niña Manualidades", proveedor: "Container", inner_pack: 1, precio_neto: "", wac_actual_referencia: 4370, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "GR002", nombre: "Cubre Colchon Cuna Impermeable", proveedor: "Container", inner_pack: 1, precio_neto: "", wac_actual_referencia: 3700, abc: "A", cuadrante: "CASHCOW" },
  { sku: "MAN-FRA-ROS-00022", nombre: "Frazada saquito bebe", proveedor: "Container", inner_pack: 1, precio_neto: "", wac_actual_referencia: 1471, abc: "C", cuadrante: "REVISAR" },
  // Materos (6)
  { sku: "BOLMATCUERNEGX4", nombre: "Bolso Matero Negro 4 compartimientos", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 22000, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "BOLMATCUERCAFX4", nombre: "Bolso Matero Cafe 4 compartimientos", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 22000, abc: "A", cuadrante: "ESTRELLA" },
  { sku: "BOLMATCUERNEG2", nombre: "Bolso Matero Negro 2 compartimientos Chico", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 16807, abc: "A", cuadrante: "CASHCOW" },
  { sku: "BOLMATCUERCAF2", nombre: "Bolso Matero Cafe 2 compartimientos Chico", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 16807, abc: "B", cuadrante: "REVISAR" },
  { sku: "BOLMATCUERCAF2L", nombre: "Bolso Matero Cafe 2 compartimientos Grande", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 20000, abc: "C", cuadrante: "REVISAR" },
  { sku: "BOLMATCUERNEG2L", nombre: "Bolso Matero Negro 2 compartimientos Grande", proveedor: "Materos", inner_pack: 1, precio_neto: "", wac_actual_referencia: 20000, abc: "C", cuadrante: "REVISAR" },
];

const aoa = [
  // Header con instrucciones
  ["TEMPLATE CARGA DE PRECIOS — Catálogo Proveedor (no Idetex)"],
  [],
  ["INSTRUCCIONES:"],
  ["1. Completar SOLO la columna 'precio_neto' (en pesos, sin IVA)."],
  ["2. NO modificar las columnas sku, nombre, proveedor, inner_pack."],
  ["3. La columna 'wac_actual_referencia' es informativa: muestra el costo promedio actual del sistema."],
  ["4. Si el precio nuevo difiere >15% del WAC, revisar si hubo cambio real de precio o error de carga."],
  ["5. Dejar VACÍO si no se conoce — esos SKUs quedan en cascada (última recepción → WAC) hasta que cargues."],
  [],
  // Tabla
  ["sku", "nombre", "proveedor", "inner_pack", "precio_neto", "wac_actual_referencia", "abc", "cuadrante", "diff_vs_wac_pct"],
  ...FILAS.map(f => [
    f.sku,
    f.nombre,
    f.proveedor,
    f.inner_pack,
    f.precio_neto,
    f.wac_actual_referencia,
    f.abc,
    f.cuadrante,
    "", // se llena con fórmula
  ]),
];

const ws = XLSX.utils.aoa_to_sheet(aoa);

// Anchos de columna
ws["!cols"] = [
  { wch: 22 }, // sku
  { wch: 50 }, // nombre
  { wch: 16 }, // proveedor
  { wch: 12 }, // inner_pack
  { wch: 14 }, // precio_neto
  { wch: 22 }, // wac_actual_referencia
  { wch: 6 },  // abc
  { wch: 14 }, // cuadrante
  { wch: 18 }, // diff_vs_wac_pct
];

// Agregar fórmula a diff_vs_wac_pct para cada fila de datos
// Header de tabla está en fila 10 (1-indexed), datos arrancan en 11
const dataStartRow = 11;
FILAS.forEach((_, i) => {
  const row = dataStartRow + i;
  const cellAddr = XLSX.utils.encode_cell({ r: row - 1, c: 8 }); // col I (diff_vs_wac_pct)
  ws[cellAddr] = {
    t: "n",
    f: `IF(AND(E${row}>0,F${row}>0),ROUND(100*(E${row}-F${row})/F${row},1),"")`,
    z: '0.0"%"',
  };
});

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Catalogo");

const outPath = resolve(process.cwd(), "template-catalogo-proveedores.xlsx");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
writeFileSync(outPath, buf);

console.log(`✓ Template generado: ${outPath}`);
console.log(`  ${FILAS.length} SKUs pre-rellenados (Verbo Divino: 13, Container: 4, Materos: 6)`);
