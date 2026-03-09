"use client";
import { useState, useRef } from "react";
import * as XLSX from "xlsx";
import { insertMpLiquidacion, fetchMpLiquidacionFolios, deleteMpLiquidacionByFolio } from "@/lib/db";
import type { DBEmpresa, DBMpLiquidacionDetalle } from "@/lib/db";

// ==================== HELPERS ====================
const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

interface ParsedLiquidacion {
  folio: string;
  fechaDesde: string | null;
  fechaHasta: string | null;
  items: DBMpLiquidacionDetalle[];
  totals: {
    productos: number;
    envios: number;
    notasCredito: number;
    total: number;
    iva: number;
  };
}

// ==================== PARSER ====================

function parseExcelDate(val: unknown): string | null {
  if (!val) return null;
  // Si es número (serial date de Excel)
  if (typeof val === "number") {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
  }
  const s = String(val).trim();
  // DD/MM/YYYY
  if (s.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
    const [d, m, y] = s.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // DD-MM-YYYY
  if (s.match(/^\d{1,2}-\d{1,2}-\d{4}$/)) {
    const [d, m, y] = s.split("-");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // YYYY-MM-DD
  if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.slice(0, 10);
  return null;
}

function parseHeaderFolio(firstRow: unknown[]): { folio: string; fechaDesde: string | null; fechaHasta: string | null } {
  // Buscar en la primera fila el texto "Liquidación de Factura: Folio {folio}, ..."
  // o "Folio {folio}" o simplemente un número de folio
  const text = firstRow.map(c => String(c || "")).join(" ");

  let folio = "";
  let fechaDesde: string | null = null;
  let fechaHasta: string | null = null;

  // Patrón: "Folio 12345" o "Folio: 12345"
  const folioMatch = text.match(/Folio[:\s]*(\d+)/i);
  if (folioMatch) folio = folioMatch[1];

  // Patrón: "(DD/MM/YYYY hasta DD/MM/YYYY)" o "desde DD/MM al DD/MM"
  const rangeMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:hasta|al|a|→|-)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (rangeMatch) {
    fechaDesde = parseExcelDate(rangeMatch[1]);
    fechaHasta = parseExcelDate(rangeMatch[2]);
  }

  return { folio, fechaDesde, fechaHasta };
}

function parseLiquidacionExcel(workbook: XLSX.WorkBook, empresaId: string): ParsedLiquidacion | null {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  // Leer todas las filas como array de arrays
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (rows.length < 3) return null;

  // Fila 1: header con folio y rango de fechas
  const headerInfo = parseHeaderFolio(rows[0]);
  if (!headerInfo.folio) {
    // Intentar fila 0 o buscar en todas las filas
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const info = parseHeaderFolio(rows[i]);
      if (info.folio) {
        headerInfo.folio = info.folio;
        headerInfo.fechaDesde = info.fechaDesde || headerInfo.fechaDesde;
        headerInfo.fechaHasta = info.fechaHasta || headerInfo.fechaHasta;
        break;
      }
    }
  }

  // Si aún no hay folio, usar nombre del archivo o un timestamp
  if (!headerInfo.folio) headerInfo.folio = `MP-${Date.now()}`;

  // Buscar fila de headers de columnas
  let headerRowIdx = -1;
  const headerKeywords = ["fecha", "tipo documento", "dte", "folio", "venta", "descripcion", "cantidad", "monto"];
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowText = rows[i].map(c => String(c || "").toLowerCase()).join("|");
    const matches = headerKeywords.filter(k => rowText.includes(k));
    if (matches.length >= 3) {
      headerRowIdx = i;
      break;
    }
  }

  if (headerRowIdx === -1) headerRowIdx = 1; // fallback

  // Mapear headers a índices de columnas
  const headers = rows[headerRowIdx].map(h => String(h || "").toLowerCase().trim());
  const colMap: Record<string, number> = {};

  const mappings: [string, string[]][] = [
    ["fecha", ["fecha", "date", "fecha operacion", "fecha operación"]],
    ["tipo_documento", ["tipo documento", "tipo doc", "tipo"]],
    ["dte", ["dte", "cod dte", "código dte"]],
    ["folio_dte", ["folio", "folio dte", "nro folio"]],
    ["venta_id", ["venta", "venta id", "id venta", "nro venta"]],
    ["descripcion", ["descripcion", "descripción", "detalle", "concepto"]],
    ["cantidad", ["cantidad", "qty", "cant"]],
    ["monto", ["monto", "monto neto", "total", "valor"]],
    ["iva", ["iva", "impuesto"]],
    ["sku", ["sku", "código sku"]],
    ["codigo_producto", ["codigo producto", "código producto", "cod producto"]],
    ["folio_asociado", ["folio asociado", "folio nc"]],
    ["tipo_devolucion", ["devolucion", "devolución", "tipo devolucion", "tipo devolución"]],
  ];

  for (const [key, aliases] of mappings) {
    for (let ci = 0; ci < headers.length; ci++) {
      if (aliases.some(a => headers[ci].includes(a))) {
        colMap[key] = ci;
        break;
      }
    }
  }

  // Parsear filas de datos
  const items: DBMpLiquidacionDetalle[] = [];
  let totalProductos = 0;
  let totalEnvios = 0;
  let totalNC = 0;
  let totalMonto = 0;
  let totalIva = 0;

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    // Saltar filas vacías o de totales
    const rowText = row.map(c => String(c || "")).join("");
    if (!rowText.trim()) continue;
    if (rowText.toLowerCase().includes("total") && rowText.toLowerCase().includes("factura")) continue;

    const getVal = (key: string): string => {
      const idx = colMap[key];
      return idx !== undefined ? String(row[idx] || "").trim() : "";
    };
    const getNum = (key: string): number => {
      const idx = colMap[key];
      if (idx === undefined) return 0;
      const v = row[idx];
      if (typeof v === "number") return v;
      return parseFloat(String(v || "0").replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0;
    };

    const fecha = parseExcelDate(colMap["fecha"] !== undefined ? row[colMap["fecha"]] : null);
    const monto = getNum("monto");
    const iva = getNum("iva");
    const desc = getVal("descripcion");
    const tipoDoc = getVal("tipo_documento");
    const dte = getNum("dte") || null;

    // Saltar filas sin datos significativos
    if (!fecha && !desc && monto === 0) continue;

    items.push({
      empresa_id: empresaId,
      factura_folio: headerInfo.folio,
      fecha_desde: headerInfo.fechaDesde,
      fecha_hasta: headerInfo.fechaHasta,
      fecha_operacion: fecha,
      tipo_documento: tipoDoc || null,
      dte: dte ? Math.round(dte) : null,
      folio_dte: getVal("folio_dte") || null,
      venta_id: getVal("venta_id") || null,
      descripcion: desc || null,
      cantidad: Math.round(getNum("cantidad")) || 1,
      monto,
      iva,
      sku: getVal("sku") || null,
      codigo_producto: getVal("codigo_producto") || null,
      folio_asociado: getVal("folio_asociado") || null,
      tipo_devolucion: getVal("tipo_devolucion") || null,
    });

    // Clasificar para totales
    totalMonto += monto;
    totalIva += iva;
    if (tipoDoc.toLowerCase().includes("nota de cr") || (dte && [61, 56].includes(dte))) {
      totalNC++;
    } else if (desc.toLowerCase().includes("envío") || desc.toLowerCase().includes("envio") || desc.toLowerCase().includes("flete")) {
      totalEnvios++;
    } else {
      totalProductos++;
    }
  }

  return {
    folio: headerInfo.folio,
    fechaDesde: headerInfo.fechaDesde,
    fechaHasta: headerInfo.fechaHasta,
    items,
    totals: {
      productos: totalProductos,
      envios: totalEnvios,
      notasCredito: totalNC,
      total: totalMonto,
      iva: totalIva,
    },
  };
}

// ==================== COMPONENTE ====================

export default function MpLiquidacionUpload({ empresa }: { empresa: DBEmpresa }) {
  const [parsed, setParsed] = useState<ParsedLiquidacion | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [existingFolios, setExistingFolios] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cargar folios existentes al montar
  const checkExisting = async (folio: string) => {
    if (!empresa.id) return false;
    const folios = await fetchMpLiquidacionFolios(empresa.id);
    setExistingFolios(folios);
    return folios.includes(folio);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !empresa.id) return;

    setLoading(true);
    setResult(null);
    setParsed(null);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const data = parseLiquidacionExcel(wb, empresa.id);

      if (!data || data.items.length === 0) {
        setResult({ ok: false, msg: "No se encontraron datos en el archivo. Verifica el formato." });
        setLoading(false);
        return;
      }

      // Verificar si ya existe
      const exists = await checkExisting(data.folio);
      if (exists) {
        setResult({ ok: false, msg: `La factura Folio ${data.folio} ya fue importada. Elimínala primero si quieres reimportar.` });
      }

      setParsed(data);
    } catch (err) {
      setResult({ ok: false, msg: `Error leyendo archivo: ${err}` });
    }

    setLoading(false);
  };

  const handleImport = async () => {
    if (!parsed || !empresa.id) return;
    setImporting(true);
    setResult(null);

    try {
      // Si ya existe, eliminar primero
      if (existingFolios.includes(parsed.folio)) {
        await deleteMpLiquidacionByFolio(empresa.id, parsed.folio);
      }

      const n = await insertMpLiquidacion(parsed.items);
      setResult({ ok: true, msg: `${n} registros importados de Factura Folio ${parsed.folio}` });
      setParsed(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      setResult({ ok: false, msg: `Error importando: ${err}` });
    }

    setImporting(false);
  };

  return (
    <div>
      {/* Upload */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <label className="scan-btn blue" style={{ padding: "8px 16px", fontSize: 12, cursor: "pointer" }}>
          {loading ? "Leyendo..." : "Subir Liquidación MP (.xlsx)"}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFile}
            style={{ display: "none" }}
            disabled={loading}
          />
        </label>
        <span style={{ fontSize: 11, color: "var(--txt3)" }}>
          Archivo Excel de liquidación de factura MercadoPago
        </span>
      </div>

      {/* Resultado */}
      {result && (
        <div style={{
          padding: "8px 14px", borderRadius: 8, fontSize: 12, marginBottom: 12,
          background: result.ok ? "var(--greenBg)" : "var(--redBg)",
          border: `1px solid ${result.ok ? "var(--greenBd)" : "var(--redBd)"}`,
          color: result.ok ? "var(--green)" : "var(--red)",
        }}>
          {result.ok ? "✅" : "❌"} {result.msg}
        </div>
      )}

      {/* Preview antes de importar */}
      {parsed && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Factura Folio: {parsed.folio}</div>
              {parsed.fechaDesde && parsed.fechaHasta && (
                <div style={{ fontSize: 11, color: "var(--txt3)" }}>
                  Periodo: {parsed.fechaDesde} — {parsed.fechaHasta}
                </div>
              )}
            </div>
            <button
              onClick={handleImport}
              className="scan-btn green"
              style={{ padding: "8px 20px", fontSize: 12 }}
              disabled={importing}
            >
              {importing ? "Importando..." : `Importar ${parsed.items.length} registros`}
            </button>
          </div>

          {/* KPIs */}
          <div className="kpi-grid" style={{ marginBottom: 12 }}>
            <div className="kpi">
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--cyan)" }}>
                {parsed.items.length}
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Líneas totales</div>
            </div>
            <div className="kpi">
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--green)" }}>
                {parsed.totals.productos}
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Productos</div>
            </div>
            <div className="kpi">
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--blue)" }}>
                {parsed.totals.envios}
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Envíos</div>
            </div>
            <div className="kpi">
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--red)" }}>
                {parsed.totals.notasCredito}
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Notas Crédito</div>
            </div>
          </div>

          {/* Total */}
          <div style={{
            display: "flex", justifyContent: "space-between", padding: "8px 12px",
            background: "var(--bg3)", borderRadius: 8, fontSize: 13,
          }}>
            <span>Total Neto: <span className="mono" style={{ fontWeight: 700 }}>{fmtMoney(parsed.totals.total)}</span></span>
            <span>IVA: <span className="mono" style={{ fontWeight: 700 }}>{fmtMoney(parsed.totals.iva)}</span></span>
          </div>

          {/* Preview tabla (primeras 10 filas) */}
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table className="tbl" style={{ fontSize: 10 }}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>DTE</th>
                  <th>Folio</th>
                  <th>Venta</th>
                  <th>Descripción</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                  <th>SKU</th>
                </tr>
              </thead>
              <tbody>
                {parsed.items.slice(0, 15).map((item, i) => (
                  <tr key={i}>
                    <td className="mono">{item.fecha_operacion?.slice(0, 10) || "—"}</td>
                    <td>{item.tipo_documento || "—"}</td>
                    <td className="mono">{item.dte || "—"}</td>
                    <td className="mono">{item.folio_dte || "—"}</td>
                    <td className="mono" style={{ fontSize: 9 }}>{item.venta_id || "—"}</td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.descripcion || "—"}
                    </td>
                    <td className="mono" style={{
                      textAlign: "right",
                      color: (item.monto || 0) < 0 ? "var(--red)" : "var(--green)",
                    }}>
                      {fmtMoney(item.monto || 0)}
                    </td>
                    <td className="mono" style={{ fontSize: 9 }}>{item.sku || "—"}</td>
                  </tr>
                ))}
                {parsed.items.length > 15 && (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", color: "var(--txt3)", fontSize: 10, padding: 8 }}>
                      ... y {parsed.items.length - 15} registros más
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
