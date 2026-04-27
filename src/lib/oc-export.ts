import * as XLSX from "xlsx";
import type { DBOrdenCompra, DBOrdenCompraLinea } from "./db";

/**
 * Exporta una OC a Excel con el formato estándar para enviar al proveedor.
 *
 * - Header: número OC, proveedor, fechas, estado, notas
 * - Tabla: SKU, descripción, cantidad, precio unit. neto, subtotal, notas línea
 * - Footer: subtotal neto, IVA 19%, total bruto
 *
 * Usa precio_acordado_neto si está congelado (OC confirmada), sino fallback a
 * costo_unitario (OC en borrador).
 *
 * El nombre del archivo: OC-{numero}-{proveedor}.xlsx
 */
export function exportarOCExcel(oc: DBOrdenCompra, lineas: DBOrdenCompraLinea[]): void {
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
    ["SKU", "Descripción", "Pedida", "Recibida", "Pendiente", "Precio Unit. Neto", "Subtotal Neto", "Fuente Precio", "Notas línea"],
    ...lineas.map(l => {
      const precio = l.precio_acordado_neto ?? l.costo_unitario;
      const recibida = l.cantidad_recibida ?? 0;
      const pendiente = l.cantidad_pedida - recibida;
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
        precio,
        l.cantidad_pedida * precio,
        fuente,
        "",
      ];
    }),
    [],
    ["", "", "", "", "", "Subtotal Neto:", totalNeto, "", ""],
    ["", "", "", "", "", "IVA 19%:", iva, "", ""],
    ["", "", "", "", "", "TOTAL BRUTO:", totalBruto, "", ""],
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 18 }, { wch: 35 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 25 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "OC");
  XLSX.writeFile(wb, `OC-${oc.numero}-${oc.proveedor.replace(/\s+/g, "_")}.xlsx`);
}
