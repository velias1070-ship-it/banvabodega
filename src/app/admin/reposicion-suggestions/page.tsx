"use client";

// Sprint 4 (2026-05-03) — Dashboard humano de reposición (Camino 1).
// Lee /api/admin/reposicion-suggestions que sirve v_reposicion_dashboard.
// Sin auto-refresh: la decisión humana se toma cuando el operador entra.
// Ver /docs/operations/reposicion-manual.md.

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import SkuExplainPanel from "@/components/admin/SkuExplainPanel";

type Row = {
  sku_origen: string;
  nombre: string | null;
  cell: string | null;
  policy_action: string | null;
  xyz_confidence: string | null;
  seasonal_match_source: string | null;
  proveedor_nombre: string | null;
  proveedor_id: string | null;
  stock_bodega: number;
  stock_full: number;
  stock_total: number;
  in_transit_bodega: number;
  cycle_stock: number;
  safety_stock: number;
  reorder_point: number;
  pre_full_target: number;
  stock_objetivo: number;
  qty_a_comprar: number;
  clp_estimado: number | null;
  dias_cobertura_actual: number | null;
  bajo_rop: boolean;
  nivel_alerta: "QUIEBRE_TOTAL" | "CRITICO" | "URGENTE" | "ATENCION" | "OK";
  prioridad: number;
  lt_dias: number;
  z: number;
  d_avg_dia: number;
};

type Summary = {
  quiebre_total: number;
  critico: number;
  urgente: number;
  atencion: number;
  total_skus: number;
  total_clp: number;
};

const NIVEL_COLOR: Record<string, string> = {
  QUIEBRE_TOTAL: "#ef4444",
  CRITICO: "#f59e0b",
  URGENTE: "#facc15",
  ATENCION: "#06b6d4",
  OK: "#64748b",
};

const fmtCLP = (n: number | null) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CL");
const fmtNum = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(n).toLocaleString("es-CL");

type SortKey = keyof Row;

export default function ReposicionSuggestionsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [filterAlertas, setFilterAlertas] = useState<Set<string>>(
    new Set(["QUIEBRE_TOTAL", "CRITICO", "URGENTE", "ATENCION", "OK"])
  );
  const [filterCells, setFilterCells] = useState<Set<string>>(new Set());
  const [filterProveedor, setFilterProveedor] = useState<string>("");
  const [onlyBajoRop, setOnlyBajoRop] = useState(false);

  // Orden
  const [sortKey, setSortKey] = useState<SortKey>("prioridad");
  const [sortAsc, setSortAsc] = useState(true);

  // Columnas opcionales
  const [showOptional, setShowOptional] = useState(false);

  // Selección para "Copiar para OC"
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Sprint 4.2 — panel "¿De dónde sale este número?"
  const [explainSku, setExplainSku] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/reposicion-suggestions")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setRows(data.data || []);
          setSummary(data.summary || null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const cells = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.cell && s.add(r.cell));
    return Array.from(s).sort();
  }, [rows]);

  const proveedores = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => r.proveedor_nombre && s.add(r.proveedor_nombre));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows
      .filter((r) => filterAlertas.has(r.nivel_alerta))
      .filter((r) => filterCells.size === 0 || (r.cell && filterCells.has(r.cell)))
      .filter(
        (r) =>
          !filterProveedor ||
          (r.proveedor_nombre && r.proveedor_nombre === filterProveedor)
      )
      .filter((r) => !onlyBajoRop || r.bajo_rop)
      .sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return sortAsc ? 1 : -1;
        if (bv == null) return sortAsc ? -1 : 1;
        if (av < bv) return sortAsc ? -1 : 1;
        if (av > bv) return sortAsc ? 1 : -1;
        return 0;
      });
  }, [rows, filterAlertas, filterCells, filterProveedor, onlyBajoRop, sortKey, sortAsc]);

  const toggleAlerta = (n: string) => {
    const next = new Set(filterAlertas);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setFilterAlertas(next);
  };
  const toggleCell = (c: string) => {
    const next = new Set(filterCells);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setFilterCells(next);
  };
  const toggleSel = (sku: string) => {
    const next = new Set(selected);
    if (next.has(sku)) next.delete(sku);
    else next.add(sku);
    setSelected(next);
  };
  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc(!sortAsc);
    else {
      setSortKey(k);
      setSortAsc(true);
    }
  };

  const exportCSV = () => {
    const cols: SortKey[] = [
      "sku_origen", "nombre", "cell", "policy_action", "proveedor_nombre",
      "stock_bodega", "stock_full", "stock_total", "in_transit_bodega",
      "cycle_stock", "safety_stock", "reorder_point", "pre_full_target",
      "stock_objetivo", "qty_a_comprar", "clp_estimado",
      "dias_cobertura_actual", "nivel_alerta", "lt_dias", "z", "d_avg_dia",
    ];
    const header = cols.join(",");
    const lines = filtered.map((r) =>
      cols
        .map((c) => {
          const v = r[c];
          if (v == null) return "";
          if (typeof v === "string" && (v.includes(",") || v.includes('"')))
            return '"' + v.replace(/"/g, '""') + '"';
          return String(v);
        })
        .join(",")
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reposicion-suggestions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyOC = async () => {
    const lines = filtered
      .filter((r) => selected.has(r.sku_origen))
      .map((r) => `${r.sku_origen}\t${r.qty_a_comprar}\t${r.proveedor_nombre || ""}`);
    if (lines.length === 0) {
      alert("Seleccioná al menos un SKU primero (checkbox).");
      return;
    }
    const text = ["SKU\tQty\tProveedor", ...lines].join("\n");
    await navigator.clipboard.writeText(text);
    alert(`${lines.length} SKUs copiados al clipboard (formato SKU\\tQty\\tProveedor).`);
  };

  return (
    <div className="app-admin" style={{ padding: 16 }}>
      <div className="topbar" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/admin" style={{ color: "var(--cyan)", textDecoration: "none" }}>
          ← Admin
        </Link>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Reposición — Sugerencias (Camino 1, humano)
        </h1>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--txt3)" }}>
          Sprint 4 · v_reposicion_dashboard · refresh manual
        </span>
      </div>

      {/* Banner */}
      {summary && (
        <div
          className="card"
          style={{
            padding: 12,
            marginBottom: 12,
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
          }}
        >
          <Kpi label="Quiebre total" value={summary.quiebre_total} color={NIVEL_COLOR.QUIEBRE_TOTAL} />
          <Kpi label="Crítico (≤3d)" value={summary.critico} color={NIVEL_COLOR.CRITICO} />
          <Kpi label="Urgente (≤7d)" value={summary.urgente} color={NIVEL_COLOR.URGENTE} />
          <Kpi label="Atención (≤14d)" value={summary.atencion} color={NIVEL_COLOR.ATENCION} />
          <Kpi label="Total CLP sugerido" value={fmtCLP(summary.total_clp)} color="var(--cyan)" />
        </div>
      )}

      {/* Filtros */}
      <div className="card" style={{ padding: 12, marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <div>
          <strong style={{ fontSize: 11, color: "var(--txt2)" }}>Alerta:</strong>{" "}
          {(["QUIEBRE_TOTAL", "CRITICO", "URGENTE", "ATENCION", "OK"] as const).map((n) => (
            <Chip
              key={n}
              label={n}
              active={filterAlertas.has(n)}
              color={NIVEL_COLOR[n]}
              onClick={() => toggleAlerta(n)}
            />
          ))}
        </div>
        <div>
          <strong style={{ fontSize: 11, color: "var(--txt2)" }}>Celda:</strong>{" "}
          {cells.map((c) => (
            <Chip
              key={c}
              label={c}
              active={filterCells.has(c)}
              color="var(--blue)"
              onClick={() => toggleCell(c)}
            />
          ))}
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--txt2)" }}>Proveedor:</label>{" "}
          <select
            value={filterProveedor}
            onChange={(e) => setFilterProveedor(e.target.value)}
            className="form-input"
            style={{ display: "inline", padding: "2px 6px", fontSize: 12 }}
          >
            <option value="">— Todos —</option>
            {proveedores.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={onlyBajoRop} onChange={(e) => setOnlyBajoRop(e.target.checked)} />{" "}
          solo bajo ROP
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={showOptional} onChange={(e) => setShowOptional(e.target.checked)} />{" "}
          columnas extra
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={exportCSV} className="scan-btn blue" style={{ padding: "6px 12px", fontSize: 12 }}>
            Exportar CSV
          </button>
          <button onClick={copyOC} className="scan-btn green" style={{ padding: "6px 12px", fontSize: 12 }}>
            Copiar para OC ({selected.size})
          </button>
        </div>
      </div>

      {/* Tabla */}
      {loading && <div style={{ padding: 16 }}>Cargando…</div>}
      {error && <div style={{ padding: 16, color: "var(--red)" }}>Error: {error}</div>}
      {!loading && !error && (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg3)" }}>
              <tr>
                <Th label="" />
                <Th label="" />
                <Th label="Alerta" k="nivel_alerta" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} />
                <Th label="SKU" k="sku_origen" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} />
                <Th label="Nombre" k="nombre" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} />
                <Th label="Celda" k="cell" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} />
                <Th label="Stock total" k="stock_total" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="In transit" k="in_transit_bodega" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="Cobertura (d)" k="dias_cobertura_actual" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="ROP" k="reorder_point" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="Qty a comprar" k="qty_a_comprar" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="CLP estimado" k="clp_estimado" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                <Th label="Proveedor" k="proveedor_nombre" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} />
                {showOptional && (
                  <>
                    <Th label="Stock bodega" k="stock_bodega" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="Stock full" k="stock_full" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="SS" k="safety_stock" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="Cycle" k="cycle_stock" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="Pre Full" k="pre_full_target" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="LT" k="lt_dias" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                    <Th label="z" k="z" sortKey={sortKey} sortAsc={sortAsc} onClick={setSort} num />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.sku_origen} style={{ borderTop: "1px solid var(--bg4)" }}>
                  <td style={{ padding: 4 }}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.sku_origen)}
                      onChange={() => toggleSel(r.sku_origen)}
                    />
                  </td>
                  <td style={{ padding: 4 }}>
                    <button
                      onClick={() => setExplainSku(r.sku_origen)}
                      title="¿De dónde sale este número?"
                      style={{
                        background: "transparent",
                        border: "1px solid var(--bg4)",
                        color: "var(--cyan)",
                        borderRadius: 4,
                        padding: "1px 6px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      ⓘ
                    </button>
                  </td>
                  <td style={{ padding: 4 }}>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: NIVEL_COLOR[r.nivel_alerta] + "33",
                        color: NIVEL_COLOR[r.nivel_alerta],
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {r.nivel_alerta}
                    </span>
                  </td>
                  <td className="mono" style={{ padding: 4 }}>{r.sku_origen}</td>
                  <td style={{ padding: 4, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.nombre || "—"}
                  </td>
                  <td className="mono" style={{ padding: 4 }}>{r.cell || "—"}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.stock_total)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.in_transit_bodega)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.dias_cobertura_actual)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.reorder_point)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right", color: "var(--cyan)" }}>
                    {fmtNum(r.qty_a_comprar)}
                  </td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtCLP(r.clp_estimado)}</td>
                  <td style={{ padding: 4 }}>{r.proveedor_nombre || "—"}</td>
                  {showOptional && (
                    <>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.stock_bodega)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.stock_full)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.safety_stock)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.cycle_stock)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.pre_full_target)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.lt_dias)}</td>
                      <td className="mono" style={{ padding: 4, textAlign: "right" }}>{r.z?.toFixed(2) || "—"}</td>
                    </>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={21} style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>
                    Sin resultados con los filtros actuales.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <SkuExplainPanel sku={explainSku} onClose={() => setExplainSku(null)} />
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function Chip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        marginRight: 4,
        padding: "2px 8px",
        borderRadius: 4,
        border: `1px solid ${active ? color : "var(--bg4)"}`,
        background: active ? color + "22" : "transparent",
        color: active ? color : "var(--txt2)",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortAsc,
  onClick,
  num,
}: {
  label: string;
  k?: SortKey;
  sortKey?: SortKey;
  sortAsc?: boolean;
  onClick?: (k: SortKey) => void;
  num?: boolean;
}) {
  const active = k && sortKey === k;
  return (
    <th
      onClick={() => k && onClick && onClick(k)}
      style={{
        padding: 6,
        textAlign: num ? "right" : "left",
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        cursor: k ? "pointer" : "default",
        color: active ? "var(--cyan)" : "var(--txt2)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {active && (sortAsc ? " ↑" : " ↓")}
    </th>
  );
}
