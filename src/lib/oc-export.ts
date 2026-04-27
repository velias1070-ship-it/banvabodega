import * as XLSX from "xlsx";
import type { DBOrdenCompra, DBOrdenCompraLinea } from "./db";
import { fetchRecepcionesDeOC, fetchLineasDeRecepciones } from "./db";

/**
 * Item recibido para una OC: una entrada por (recepción, sku) con folio,
 * fecha, cantidad y descripción. Una línea de OC puede generar N items si
 * se recibió en varias recepciones.
 */
export interface OCRecepcionItem {
  sku: string;
  nombre: string;
  cantidad: number;
  fecha: string; // YYYY-MM-DD o ISO; se formatea a DD/MM
  folio: string;
}

/**
 * Construye la lista de eventos de recepción para una OC.
 *
 * Fecha preferida: ts_conteo (cuando el operario confirmó el conteo).
 * Fallback: recepciones.completed_at o created_at.
 */
export async function fetchOCRecepcionesItems(ocId: string): Promise<OCRecepcionItem[]> {
  const recepciones = await fetchRecepcionesDeOC(ocId);
  if (recepciones.length === 0) return [];
  const recIds = recepciones.map(r => r.id!).filter(Boolean);
  const lineas = await fetchLineasDeRecepciones(recIds);
  const recById = new Map(recepciones.map(r => [r.id, r]));
  return lineas
    .filter(l => (l.qty_recibida || 0) > 0)
    .map(l => {
      const rec = recById.get(l.recepcion_id);
      const fecha = l.ts_conteo || rec?.completed_at || rec?.created_at || "";
      return {
        sku: l.sku,
        nombre: l.nombre || "",
        cantidad: l.qty_recibida,
        fecha,
        folio: rec?.folio || "",
      };
    })
    .filter(r => !!r.fecha);
}

function formatFecha(fecha: string): string {
  // Acepta ISO o YYYY-MM-DD. Devuelve DD/MM/YYYY.
  const ymd = fecha.slice(0, 10);
  const [y, m, d] = ymd.split("-");
  return y && m && d ? `${d}/${m}/${y}` : ymd;
}

/**
 * Exporta una OC a Excel con dos hojas:
 *
 * - Hoja "OC": resumen por SKU (pedida / recibida / pendiente).
 * - Hoja "Recepciones": detalle plano de eventos (Folio, Fecha, SKU,
 *   Descripción, Cantidad). Una fila por evento real, ordenado por fecha.
 *
 * Recibida y Pendiente se calculan sumando los eventos de "recepciones"
 * (recepcion_lineas.qty_recibida es la fuente canónica;
 * ordenes_compra_lineas.cantidad_recibida está siempre en 0 y se ignora
 * cuando hay datos de recepciones).
 *
 * El nombre del archivo: OC-{numero}-{proveedor}.xlsx
 */
export function exportarOCExcel(
  oc: DBOrdenCompra,
  lineas: DBOrdenCompraLinea[],
  recepciones: OCRecepcionItem[] = [],
): void {
  // ── Hoja 1: OC (resumen) ──
  const ocAoa: (string | number)[][] = [
    [`ORDEN DE COMPRA ${oc.numero}`],
    [],
    [`Proveedor:`, oc.proveedor],
    [`Fecha emisión:`, oc.fecha_emision || ""],
    [`Fecha esperada:`, oc.fecha_esperada || "—"],
    [`Estado:`, oc.estado || ""],
    ...(oc.notas ? [[`Notas:`, oc.notas]] : []),
    [],
    ["SKU", "Descripción", "Pedida", "Recibida", "Pendiente"],
    ...lineas.map(l => {
      const recibidaSum = recepciones
        .filter(r => r.sku === l.sku_origen)
        .reduce((s, r) => s + r.cantidad, 0);
      const recibida = recepciones.length > 0 ? recibidaSum : (l.cantidad_recibida ?? 0);
      const pendiente = l.cantidad_pedida - recibida;
      return [
        l.sku_origen,
        l.nombre || "",
        l.cantidad_pedida,
        recibida,
        pendiente,
      ];
    }),
  ];
  const wsOC = XLSX.utils.aoa_to_sheet(ocAoa);
  wsOC["!cols"] = [
    { wch: 18 }, { wch: 40 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
  ];

  // ── Hoja 2: Recepciones (detalle plano, una fila por evento) ──
  const recOrdenadas = [...recepciones].sort((a, b) => {
    const f = a.fecha.localeCompare(b.fecha);
    if (f !== 0) return f;
    const fol = a.folio.localeCompare(b.folio);
    if (fol !== 0) return fol;
    return a.sku.localeCompare(b.sku);
  });
  const recAoa: (string | number)[][] = [
    [`RECEPCIONES OC ${oc.numero}`],
    [],
    ["Folio", "Fecha", "SKU", "Descripción", "Cantidad"],
    ...recOrdenadas.map(r => [
      r.folio,
      formatFecha(r.fecha),
      r.sku,
      r.nombre,
      r.cantidad,
    ]),
  ];
  if (recOrdenadas.length === 0) {
    recAoa.push(["—", "—", "—", "Sin recepciones registradas", 0]);
  }
  const wsRec = XLSX.utils.aoa_to_sheet(recAoa);
  wsRec["!cols"] = [
    { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 10 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsOC, "OC");
  XLSX.utils.book_append_sheet(wb, wsRec, "Recepciones");
  XLSX.writeFile(wb, `OC-${oc.numero}-${oc.proveedor.replace(/\s+/g, "_")}.xlsx`);
}
