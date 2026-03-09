"use client";
import { useState, useRef } from "react";

export interface CsvRow {
  fecha: string;       // YYYY-MM-DD
  descripcion: string;
  monto: number;       // positivo=ingreso, negativo=egreso
  saldo: number | null;
  referencia: string;
}

interface CsvUploaderProps {
  banco: string;
  onImport: (rows: CsvRow[]) => void;
}

type ColMapping = {
  fecha: number | null;
  descripcion: number | null;
  monto: number | null;     // columna única de monto (si no hay cargo/abono separados)
  cargo: number | null;     // egreso
  abono: number | null;     // ingreso
  saldo: number | null;
  referencia: number | null;
};

// Detectar separador (;  o ,)
function detectSep(text: string): string {
  const firstLines = text.split("\n").slice(0, 5).join("\n");
  const semis = (firstLines.match(/;/g) || []).length;
  const commas = (firstLines.match(/,/g) || []).length;
  return semis >= commas ? ";" : ",";
}

// Detectar filas de header del banco (nombre cuenta, RUT, etc) y saltar
function detectDataStart(rows: string[][], minCols: number): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    // Fila con suficientes columnas no vacías = probable header de datos o datos
    const nonEmpty = row.filter(c => c.trim().length > 0).length;
    if (nonEmpty >= minCols) return i;
  }
  return 0;
}

// Parsear fecha DD/MM/YYYY → YYYY-MM-DD
function parseDate(val: string): string | null {
  const v = val.trim();
  // DD/MM/YYYY o DD-MM-YYYY
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // YYYY-MM-DD (ya correcto)
  const m2 = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return v;
  return null;
}

// Parsear monto numérico (limpiar puntos de miles, reemplazar coma decimal)
function parseMonto(val: string): number {
  let v = val.trim().replace(/\$/g, "").replace(/\s/g, "");
  if (!v || v === "-") return 0;
  // Si tiene punto y coma: "1.234.567,89" → "1234567.89"
  if (v.includes(",") && v.includes(".")) {
    v = v.replace(/\./g, "").replace(",", ".");
  } else if (v.includes(",") && !v.includes(".")) {
    // "1234,56" o "1,234,567" — si hay más de una coma es separador de miles
    const commaCount = (v.match(/,/g) || []).length;
    if (commaCount === 1 && v.split(",")[1].length <= 2) {
      v = v.replace(",", ".");
    } else {
      v = v.replace(/,/g, "");
    }
  }
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Campos disponibles para mapear
const FIELD_OPTIONS = [
  { value: "", label: "— No usar —" },
  { value: "fecha", label: "Fecha" },
  { value: "descripcion", label: "Descripción" },
  { value: "monto", label: "Monto (único)" },
  { value: "cargo", label: "Cargo (egreso)" },
  { value: "abono", label: "Abono (ingreso)" },
  { value: "saldo", label: "Saldo" },
  { value: "referencia", label: "Referencia / Nro Op." },
];

export default function CsvUploader({ banco, onImport }: CsvUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataStartIdx, setDataStartIdx] = useState(0);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [parsedRows, setParsedRows] = useState<CsvRow[]>([]);
  const [error, setError] = useState("");

  // Paso 1: leer archivo
  const handleFile = (file: File) => {
    setError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (!text || text.trim().length === 0) {
        setError("Archivo vacío");
        return;
      }
      const sep = detectSep(text);
      const lines = text.split("\n").filter(l => l.trim().length > 0);
      const rows = lines.map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, "")));

      if (rows.length < 2) {
        setError("El archivo debe tener al menos 2 filas");
        return;
      }

      // Detectar inicio de datos (saltar headers del banco)
      const startIdx = detectDataStart(rows, 3);
      const hdrs = rows[startIdx] || [];

      setRawRows(rows);
      setHeaders(hdrs);
      setDataStartIdx(startIdx);

      // Auto-mapeo por nombre de columna
      const autoMap: Record<number, string> = {};
      hdrs.forEach((h, i) => {
        const hl = h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (hl.includes("fecha")) autoMap[i] = "fecha";
        else if (hl.includes("descripcion") || hl.includes("detalle") || hl.includes("glosa")) autoMap[i] = "descripcion";
        else if (hl === "monto" || hl === "importe") autoMap[i] = "monto";
        else if (hl.includes("cargo") || hl.includes("debito") || hl.includes("egreso")) autoMap[i] = "cargo";
        else if (hl.includes("abono") || hl.includes("credito") || hl.includes("ingreso")) autoMap[i] = "abono";
        else if (hl.includes("saldo")) autoMap[i] = "saldo";
        else if (hl.includes("referencia") || hl.includes("operacion") || hl.includes("nro")) autoMap[i] = "referencia";
      });
      setMapping(autoMap);
      setStep("map");
    };
    // Intentar leer como ISO-8859-1 primero (Santander Chile), fallback a UTF-8
    reader.readAsText(file, banco === "santander" ? "ISO-8859-1" : "UTF-8");
  };

  // Paso 2: aplicar mapeo y generar preview
  const applyMapping = () => {
    // Construir ColMapping desde mapping
    const colMap: ColMapping = { fecha: null, descripcion: null, monto: null, cargo: null, abono: null, saldo: null, referencia: null };
    Object.entries(mapping).forEach(([colStr, field]) => {
      if (field && field in colMap) {
        (colMap as Record<string, number | null>)[field] = parseInt(colStr);
      }
    });

    if (colMap.fecha === null) {
      setError("Debes mapear la columna Fecha");
      return;
    }
    if (colMap.monto === null && (colMap.cargo === null && colMap.abono === null)) {
      setError("Debes mapear Monto, o Cargo + Abono");
      return;
    }

    const dataRows = rawRows.slice(dataStartIdx + 1); // +1 para saltar header
    const rows: CsvRow[] = [];

    for (const row of dataRows) {
      const fechaRaw = colMap.fecha !== null ? row[colMap.fecha] || "" : "";
      const fecha = parseDate(fechaRaw);
      if (!fecha) continue; // Saltar filas sin fecha válida

      let monto = 0;
      if (colMap.monto !== null) {
        monto = parseMonto(row[colMap.monto] || "0");
      } else {
        const cargo = colMap.cargo !== null ? parseMonto(row[colMap.cargo] || "0") : 0;
        const abono = colMap.abono !== null ? parseMonto(row[colMap.abono] || "0") : 0;
        monto = abono - cargo;
      }

      if (monto === 0) continue; // Saltar filas con monto 0

      const descripcion = colMap.descripcion !== null ? row[colMap.descripcion] || "" : "";
      const saldo = colMap.saldo !== null ? parseMonto(row[colMap.saldo] || "0") : null;
      const referencia = colMap.referencia !== null ? row[colMap.referencia] || "" : "";

      rows.push({ fecha, descripcion, monto, saldo: saldo || null, referencia });
    }

    if (rows.length === 0) {
      setError("No se encontraron filas válidas con el mapeo actual");
      return;
    }

    setError("");
    setParsedRows(rows);
    setStep("preview");
  };

  // Paso 3: confirmar importación
  const confirmImport = () => {
    onImport(parsedRows);
    setStep("upload");
    setRawRows([]);
    setHeaders([]);
    setMapping({});
    setParsedRows([]);
  };

  const reset = () => {
    setStep("upload");
    setRawRows([]);
    setHeaders([]);
    setMapping({});
    setParsedRows([]);
    setError("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

  return (
    <div>
      {/* Paso 1: Upload */}
      {step === "upload" && (
        <div style={{ textAlign: "center", padding: 32, border: "2px dashed var(--bg4)", borderRadius: 14, background: "var(--bg2)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Subir archivo CSV</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 16 }}>Formatos: CSV con separador ; o ,</div>
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }} style={{ display: "none" }} />
          <button onClick={() => fileRef.current?.click()} className="scan-btn blue" style={{ padding: "10px 24px", fontSize: 13 }}>
            Seleccionar archivo
          </button>
        </div>
      )}

      {/* Paso 2: Mapeo de columnas */}
      {step === "map" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Mapear columnas</h3>
            <button onClick={reset} style={{ fontSize: 12, color: "var(--txt3)", background: "none", border: "none", cursor: "pointer" }}>Cancelar</button>
          </div>

          {/* Preview de primeras filas raw */}
          <div style={{ overflowX: "auto", marginBottom: 16 }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rawRows.slice(dataStartIdx + 1, dataStartIdx + 4).map((row, ri) => (
                  <tr key={ri}>{headers.map((_, ci) => <td key={ci} className="mono">{row[ci] || ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Dropdowns de mapeo */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {headers.map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--bg3)", borderRadius: 8, fontSize: 12 }}>
                <span style={{ fontWeight: 600, minWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h}</span>
                <select value={mapping[i] || ""} onChange={e => setMapping(prev => ({ ...prev, [i]: e.target.value }))}
                  style={{ flex: 1, background: "var(--bg4)", color: "var(--txt)", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
                  {FIELD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            ))}
          </div>

          {error && <div style={{ color: "var(--red)", fontSize: 12, marginBottom: 8 }}>{error}</div>}

          <button onClick={applyMapping} className="scan-btn blue" style={{ padding: "10px 24px", fontSize: 13, width: "100%" }}>
            Aplicar mapeo y previsualizar
          </button>
        </div>
      )}

      {/* Paso 3: Preview y confirmar */}
      {step === "preview" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{parsedRows.length} movimientos detectados</h3>
            <button onClick={() => setStep("map")} style={{ fontSize: 12, color: "var(--txt3)", background: "none", border: "none", cursor: "pointer" }}>Volver al mapeo</button>
          </div>

          {/* Resumen */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div style={{ padding: 12, background: "var(--greenBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--green)" }}>Ingresos</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--green)" }}>
                {fmtMoney(parsedRows.filter(r => r.monto > 0).reduce((s, r) => s + r.monto, 0))}
              </div>
            </div>
            <div style={{ padding: 12, background: "var(--redBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--red)" }}>Egresos</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--red)" }}>
                {fmtMoney(parsedRows.filter(r => r.monto < 0).reduce((s, r) => s + r.monto, 0))}
              </div>
            </div>
            <div style={{ padding: 12, background: "var(--blueBg)", borderRadius: 10, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--blue)" }}>Neto</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--blue)" }}>
                {fmtMoney(parsedRows.reduce((s, r) => s + r.monto, 0))}
              </div>
            </div>
          </div>

          {/* Tabla preview */}
          <div style={{ overflowX: "auto", maxHeight: 300, marginBottom: 16 }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr><th>Fecha</th><th>Descripción</th><th style={{ textAlign: "right" }}>Monto</th><th style={{ textAlign: "right" }}>Saldo</th></tr>
              </thead>
              <tbody>
                {parsedRows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.fecha}</td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.descripcion}</td>
                    <td className="mono" style={{ textAlign: "right", color: r.monto >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(r.monto)}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{r.saldo !== null ? fmtMoney(r.saldo) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsedRows.length > 50 && <div style={{ textAlign: "center", fontSize: 11, color: "var(--txt3)", padding: 8 }}>... y {parsedRows.length - 50} más</div>}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={reset} style={{ flex: 1, padding: 10, borderRadius: 10, background: "var(--bg3)", color: "var(--txt)", fontSize: 13, fontWeight: 600, border: "1px solid var(--bg4)" }}>
              Cancelar
            </button>
            <button onClick={confirmImport} className="scan-btn green" style={{ flex: 2, padding: 10, fontSize: 13 }}>
              Importar {parsedRows.length} movimientos
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
