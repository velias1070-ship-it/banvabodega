"use client";

// Sprint 7 cierre — Comparador motor viejo vs motor nuevo (read-only).
// No promueve nada en producción: dashboard de auditoría para Vicente
// antes de matar /admin/reposicion-suggestions en Sprint 8.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Row = {
  sku_origen: string;
  nombre: string | null;
  proveedor_nombre: string | null;
  cell: string | null;
  accion_viejo: string | null;
  mandar_full_viejo: number;
  pedir_proveedor_viejo: number;
  accion_nuevo: string | null;
  prioridad_nuevo: number;
  mandar_full_nuevo: number;
  qty_a_comprar_nuevo: number;
  stock_bodega: number;
  stock_full: number;
  stock_total: number;
  in_transit_oc: number;
  in_transit_picking_full: number;
  reserva_flex_target: number;
  pre_full_target: number;
  reorder_point: number;
  dio: number | null;
  dias_en_quiebre: number | null;
  vel_decl_dia: number | null;
  vel_real_dia: number | null;
  vel_drift_status: string | null;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number | null;
  alertas: string[];
  alertas_count: number;
  divergencia_accion: boolean;
  divergencia_compra: boolean;
  divergencia_full: boolean;
};

type Summary = {
  total_skus: number;
  div_accion: number;
  div_compra: number;
  div_full: number;
  paridad_total: number;
};

type Filter = "todo" | "div_accion" | "div_compra" | "div_full" | "div_cualquiera";

export default function MotorComparePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("div_cualquiera");
  const [search, setSearch] = useState("");
  const [skuExplain, setSkuExplain] = useState<string | null>(null);
  const [explainText, setExplainText] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/motor-compare", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data: Row[]; summary: Summary };
        setRows(json.data);
        setSummary(json.summary);
      } catch (e) {
        setError(String((e as Error).message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    let r = rows;
    if (filter === "div_accion") r = r.filter((x) => x.divergencia_accion);
    if (filter === "div_compra") r = r.filter((x) => x.divergencia_compra);
    if (filter === "div_full") r = r.filter((x) => x.divergencia_full);
    if (filter === "div_cualquiera")
      r = r.filter((x) => x.divergencia_accion || x.divergencia_compra || x.divergencia_full);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(
        (x) =>
          x.sku_origen.toLowerCase().includes(q) ||
          (x.nombre || "").toLowerCase().includes(q) ||
          (x.proveedor_nombre || "").toLowerCase().includes(q)
      );
    }
    return [...r].sort((a, b) => b.prioridad_nuevo - a.prioridad_nuevo);
  }, [rows, filter, search]);

  async function loadExplanation(sku: string) {
    setSkuExplain(sku);
    setExplainText("Cargando narrativa...");
    try {
      const res = await fetch(
        `/api/admin/sku-explanation/${encodeURIComponent(sku)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const j = (await res.json()) as { explicacion_texto?: string };
        setExplainText(j.explicacion_texto || "(vacío)");
        return;
      }
      setExplainText(
        `No disponible (HTTP ${res.status}). Consultá: SELECT explicacion_texto FROM v_sku_explanation WHERE sku_origen = '${sku}';`
      );
    } catch (e) {
      setExplainText(`Error: ${String((e as Error).message || e)}`);
    }
  }

  return (
    <div style={{ padding: 16, color: "var(--txt)", minHeight: "100vh" }}>
      <div className="topbar" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Link href="/admin" style={{ color: "var(--cyan)" }}>← Admin</Link>
        <h1 style={{ fontSize: 18, margin: 0 }}>Motor viejo vs motor nuevo</h1>
        <span style={{ fontSize: 12, color: "var(--txt2)" }}>
          read-only · Sprint 7 cierre · auditoría pre-promoción
        </span>
      </div>

      {loading && <div className="card" style={{ padding: 16 }}>Cargando...</div>}
      {error && (
        <div className="card" style={{ padding: 16, color: "var(--red)" }}>
          Error: {error}
        </div>
      )}

      {summary && (
        <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Stat label="Total SKUs" value={summary.total_skus} />
          <Stat label="Paridad total" value={summary.paridad_total} color="var(--green)" />
          <Stat label="Div. acción" value={summary.div_accion} color="var(--amber)" />
          <Stat label="Div. compra" value={summary.div_compra} color="var(--amber)" />
          <Stat label="Div. mandar Full" value={summary.div_full} color="var(--amber)" />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        {(["div_cualquiera", "div_accion", "div_compra", "div_full", "todo"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: `1px solid ${filter === f ? "var(--cyan)" : "var(--bg4)"}`,
              background: filter === f ? "var(--bg3)" : "var(--bg2)",
              color: "var(--txt)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {labelFor(f)}
          </button>
        ))}
        <input
          placeholder="Buscar SKU / nombre / proveedor"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--bg4)",
            background: "var(--bg3)",
            color: "var(--txt)",
            minWidth: 280,
            fontSize: 12,
          }}
        />
        <span style={{ alignSelf: "center", fontSize: 12, color: "var(--txt2)" }}>
          {filtered.length} filas
        </span>
      </div>

      <div className="card" style={{ overflowX: "auto", padding: 0 }}>
        <table className="tbl" style={{ width: "100%", fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
          <thead>
            <tr style={{ background: "var(--bg3)" }}>
              <th style={th}>SKU</th>
              <th style={th}>Cell</th>
              <th style={th}>Stock B/F/T</th>
              <th style={th}>OC/Picking</th>
              <th style={{ ...th, color: "var(--amber)" }}>Acción VIEJO</th>
              <th style={{ ...th, color: "var(--cyan)" }}>Acción NUEVO</th>
              <th style={{ ...th, color: "var(--amber)" }}>Pedir VIEJO</th>
              <th style={{ ...th, color: "var(--cyan)" }}>Comprar NUEVO</th>
              <th style={{ ...th, color: "var(--amber)" }}>Full VIEJO</th>
              <th style={{ ...th, color: "var(--cyan)" }}>Full NUEVO</th>
              <th style={th}>DIO</th>
              <th style={th}>Liq.</th>
              <th style={th}>Alertas</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.sku_origen} style={{ borderTop: "1px solid var(--bg4)" }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{r.sku_origen}</div>
                  <div style={{ fontSize: 10, color: "var(--txt3)" }}>
                    {r.nombre?.slice(0, 40) || "—"}
                  </div>
                </td>
                <td style={td}>{r.cell || "—"}</td>
                <td style={td}>
                  {r.stock_bodega} / {r.stock_full} / <strong>{r.stock_total}</strong>
                </td>
                <td style={td}>
                  <span title="OC bodega">OC:{r.in_transit_oc}</span>{" "}
                  <span title="picking → Full">P:{r.in_transit_picking_full}</span>
                </td>
                <td style={{ ...td, color: r.divergencia_accion ? "var(--red)" : "var(--txt)" }}>
                  {r.accion_viejo || "—"}
                </td>
                <td style={{ ...td, color: r.divergencia_accion ? "var(--red)" : "var(--green)" }}>
                  {r.accion_nuevo || "—"}
                  {r.prioridad_nuevo > 0 && (
                    <span style={{ fontSize: 10, color: "var(--txt3)" }}> p{r.prioridad_nuevo}</span>
                  )}
                </td>
                <td style={{ ...td, color: r.divergencia_compra ? "var(--red)" : "var(--txt)" }}>
                  {r.pedir_proveedor_viejo}
                </td>
                <td style={{ ...td, color: r.divergencia_compra ? "var(--red)" : "var(--green)" }}>
                  {r.qty_a_comprar_nuevo}
                </td>
                <td style={{ ...td, color: r.divergencia_full ? "var(--red)" : "var(--txt)" }}>
                  {r.mandar_full_viejo}
                </td>
                <td style={{ ...td, color: r.divergencia_full ? "var(--red)" : "var(--green)" }}>
                  {r.mandar_full_nuevo}
                </td>
                <td style={td}>{r.dio == null ? "—" : r.dio.toFixed(1)}</td>
                <td style={td}>
                  {r.liquidacion_accion ? (
                    <span style={{ color: "var(--amber)" }}>
                      {r.liquidacion_accion}
                      {r.liquidacion_descuento_sugerido != null
                        ? ` ${Math.round(r.liquidacion_descuento_sugerido * 100)}%`
                        : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={td}>
                  {r.alertas_count > 0 ? (
                    <span style={{ color: "var(--red)" }} title={r.alertas.join(", ")}>
                      ⚠ {r.alertas_count}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={td}>
                  <button
                    onClick={() => loadExplanation(r.sku_origen)}
                    style={{
                      padding: "2px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--bg4)",
                      background: "var(--bg3)",
                      color: "var(--cyan)",
                      cursor: "pointer",
                      fontSize: 10,
                    }}
                  >
                    explicar
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={14} style={{ ...td, textAlign: "center", color: "var(--txt3)" }}>
                  Sin filas con el filtro actual.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {skuExplain && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
          onClick={() => setSkuExplain(null)}
        >
          <div
            className="card"
            style={{ padding: 16, maxWidth: 720, width: "100%", maxHeight: "80vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <strong style={{ color: "var(--cyan)" }}>{skuExplain}</strong>
              <button
                onClick={() => setSkuExplain(null)}
                style={{ border: "none", background: "none", color: "var(--txt2)", cursor: "pointer" }}
              >
                cerrar
              </button>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "JetBrains Mono, monospace", color: "var(--txt)" }}>
              {explainText}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: color || "var(--txt)" }}>{value}</span>
    </div>
  );
}

function labelFor(f: Filter): string {
  switch (f) {
    case "todo":
      return "Todos";
    case "div_cualquiera":
      return "Cualquier divergencia";
    case "div_accion":
      return "Div. acción";
    case "div_compra":
      return "Div. compra";
    case "div_full":
      return "Div. mandar Full";
  }
}

const th: React.CSSProperties = {
  padding: "8px 10px",
  textAlign: "left",
  fontSize: 10,
  textTransform: "uppercase",
  color: "var(--txt2)",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "6px 10px",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
