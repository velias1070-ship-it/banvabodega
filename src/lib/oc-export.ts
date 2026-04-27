import * as XLSX from "xlsx";
import type { DBOrdenCompra, DBOrdenCompraLinea } from "./db";
import { fetchRecepcionesDeOC, fetchLineasDeRecepciones } from "./db";

/**
 * Construye la lista de recepciones por SKU para una OC.
 * Cada item es un evento de recepción (recepcion x sku) con la fecha y
 * la cantidad recibida. Si una línea de OC se recibió en N recepciones,
 * aparecen N items con el mismo SKU.
 *
 * Fecha preferida: ts_conteo (cuando el operario confirmó el conteo).
 * Fallback: recepciones.created_at.
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
      return { sku: l.sku, cantidad: l.qty_recibida, fecha };
    })
    .filter(r => !!r.fecha);
}

/**
 * Item recibido para una OC: una entrada por (recepción, sku) con la fecha y
 * cantidad que llegó. Permite que el Excel muestre "12/04: 60u + 15/04: 40u"
 * en la columna Recepciones.
 */
export interface OCRecepcionItem {
  sku: string;
  cantidad: number;
  fecha: string; // YYYY-MM-DD o ISO; se formatea a DD/MM
}

function formatFecha(fecha: string): string {
  // Acepta ISO o YYYY-MM-DD. Devuelve DD/MM.
  const ymd = fecha.slice(0, 10);
  const [, m, d] = ymd.split("-");
  return d && m ? `${d}/${m}` : ymd;
}

/**
 * Exporta una OC a Excel con el formato estándar para enviar al proveedor.
 *
 * - Header: número OC, proveedor, fechas, estado, notas
 * - Tabla: SKU, descripción, cantidades (pedida/recibida/pendiente),
 *          recepciones (fecha+cantidad por evento), precio, subtotal, fuente
 * - Footer: subtotal neto, IVA 19%, total bruto
 *
 * Usa precio_acordado_neto si está congelado (OC confirmada), sino fallback a
 * costo_unitario (OC en borrador).
 *
 * El nombre del archivo: OC-{numero}-{proveedor}.xlsx
 */
export function exportarOCExcel(
  oc: DBOrdenCompra,
  lineas: DBOrdenCompraLinea[],
  recepciones: OCRecepcionItem[] = [],
): void {
  const totalNeto = lineas.reduce((s, l) => s + l.cantidad_pedida * (l.precio_acordado_neto ?? l.costo_unitario), 0);
  const iva = Math.round(totalNeto * 0.19);
  const totalBruto = totalNeto + iva;

  const aoa: (string | number)[][] = [
    [`ORDEN DE COMPRA ${oc.numero}`],
    [],
    [`Proveedor:`, oc.proveedor],
    [`Fecha emisión:`, oc.fecha_emision || ""],
    [`Fecha esperada:`, oc.fecha_esperada || "—"],
    [`Estado:`, oc.estado || ""],
    ...(oc.notas ? [[`Notas:`, oc.notas]] : []),
    [],
    ["SKU", "Descripción", "Pedida", "Recibida", "Pendiente", "Recepciones", "Precio Unit. Neto", "Subtotal Neto", "Fuente Precio", "Notas línea"],
    ...lineas.map(l => {
      const precio = l.precio_acordado_neto ?? l.costo_unitario;
      const recibida = l.cantidad_recibida ?? 0;
      const pendiente = l.cantidad_pedida - recibida;
      const recepcionesSku = recepciones
        .filter(r => r.sku === l.sku_origen)
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      const detalleRecepciones = recepcionesSku
        .map(r => `${formatFecha(r.fecha)}: ${r.cantidad}u`)
        .join(" + ");
      const fuente = l.precio_fuente === "catalogo" ? "Catálogo" :
                     l.precio_fuente === "ultima_recepcion" ? "Última recepción" :
                     l.precio_fuente === "wac_fallback" ? "WAC histórico" :
                     l.precio_fuente === "sin_precio" ? "SIN PRECIO" :
                     l.precio_fuente === "manual" ? "Manual" : "—";
      return [
        l.sku_origen,
        l.nombre || "",
        l.cantidad_pedida,
        recibida,
        pendiente,
        detalleRecepciones,
        precio,
        l.cantidad_pedida * precio,
        fuente,
        "",
      ];
    }),
    [],
    ["", "", "", "", "", "", "Subtotal Neto:", totalNeto, "", ""],
    ["", "", "", "", "", "", "IVA 19%:", iva, "", ""],
    ["", "", "", "", "", "", "TOTAL BRUTO:", totalBruto, "", ""],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 18 }, { wch: 35 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 28 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 25 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "OC");
  XLSX.writeFile(wb, `OC-${oc.numero}-${oc.proveedor.replace(/\s+/g, "_")}.xlsx`);
}
