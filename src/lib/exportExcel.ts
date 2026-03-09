"use client";
import * as XLSX from "xlsx";

// Configuración para exportar un archivo Excel
interface ExcelHoja {
  nombre: string;           // Nombre de la hoja
  columnas: string[];       // Headers
  filas: (string | number | null)[][]; // Datos
  anchos?: number[];        // Ancho de columnas en caracteres
}

interface ExcelConfig {
  titulo: string;           // "Estado de Resultados"
  empresa: string;          // "BANVA SPA"
  periodo: string;          // "Marzo 2026"
  hojas: ExcelHoja[];
  nombreArchivo: string;    // "estado_resultados_202603.xlsx"
}

// Genera y descarga un archivo .xlsx
export function exportToExcel(config: ExcelConfig) {
  const wb = XLSX.utils.book_new();

  for (const hoja of config.hojas) {
    // Filas de header con info de la empresa
    const headerRows: (string | number | null)[][] = [
      [config.empresa],
      [config.titulo],
      [`Periodo: ${config.periodo}`],
      [], // fila vacía de separación
      hoja.columnas,
    ];

    const wsData = [...headerRows, ...hoja.filas];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Anchos de columna (auto o explícito)
    if (hoja.anchos) {
      ws["!cols"] = hoja.anchos.map(w => ({ wch: w }));
    } else {
      // Auto: calcular ancho basado en contenido
      const maxCols = Math.max(hoja.columnas.length, ...hoja.filas.map(f => f.length));
      ws["!cols"] = Array.from({ length: maxCols }, (_, ci) => {
        const headerLen = (hoja.columnas[ci] || "").length;
        const maxDataLen = Math.max(...hoja.filas.map(f => String(f[ci] ?? "").length), 0);
        return { wch: Math.max(headerLen, maxDataLen, 8) + 2 };
      });
    }

    XLSX.utils.book_append_sheet(wb, ws, hoja.nombre.slice(0, 31)); // max 31 chars
  }

  XLSX.writeFile(wb, config.nombreArchivo);
}

// Formato moneda CLP para Excel (string legible)
export function fmtMoneyExcel(n: number): string {
  return n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
}
