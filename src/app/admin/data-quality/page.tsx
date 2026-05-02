"use client";

// Sprint 4.2 (2026-05-03) — Reporte global de calidad de datos.
// Lee /api/admin/data-quality que sirve v_data_quality_drift.
// Filtros por status, click ⓘ → SkuExplainPanel.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import SkuExplainPanel from "@/components/admin/SkuExplainPanel";

type Row = {
  sku_origen: string;
  nombre: string | null;
  cell: string | null;
  proveedor_nombre: string | null;
  vel_decl_sem: number | null;
  vel_real_sem: number | null;
  vel_drift_pct: number | null;
  vel_drift_status: string;
  lt_decl: number | null;
  lt_real_ultimo_oc_dias: number | null;
  lt_drift_status: string;
  data_quality_status: string;
  policy_status: string | null;
  xyz_confidence: string | null;
  qty_a_comprar: number | null;
  clp_estimado: number | null;
};

type Summary = {
  total_skus: number;
  drift_both: number;
  drift_vel: number;
  drift_lt: number;
  drift_moderate: number;
  blocked_cost: number;
  blocked_history: number;
  sin_baseline: number;
  ok: number;
};

const STATUS_COLOR: Record<string, string> = {
  DRIFT_BOTH: "#dc2626",
  DRIFT_VEL: "#ef4444",
  DRIFT_LT: "#f59e0b",
  DRIFT_MODERATE: "#facc15",
  BLOCKED_COST: "#7c3aed",
  BLOCKED_HISTORY: "#7c3aed",
  SIN_BASELINE: "#64748b",
  OK: "#10b981",
};

const fmtNum = (n: number | null | undefined, dec = 0) =>
  n == null ? "—" : Number(n).toLocaleString("es-CL", { minimumFractionDigits: dec, maximumFractionDigits: dec });

const fmtCLP = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CL");

const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(1)}%`;

export default function DataQualityPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("ALL");
  const [explainSku, setExplainSku] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/data-quality")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        setRows(j.data || []);
        setSummary(j.summary || null);
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (filter === "ALL") return rows;
    return rows.filter((r) => r.data_quality_status === filter);
  }, [rows, filter]);

  return (
    <div className="app-admin" style={{ padding: 20 }}>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/admin" style={{ color: "var(--cyan)", fontSize: 12 }}>← Admin</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>Calidad de datos — Reposición</h1>
      </div>

      <p style={{ fontSize: 13, color: "var(--txt2)", marginBottom: 16, maxWidth: 800 }}>
        Reporte global de drift de velocidad (declarada vs medición 30d real) y lead time
        (declarado vs último OC recibido). Auditá inputs antes de tomar decisiones de compra.
        Click ⓘ para ver el detalle completo de un SKU.
      </p>

      {summary && (
        <div className="kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 16 }}>
          <Kpi label="Total SKUs" value={fmtNum(summary.total_skus)} color="var(--txt)" onClick={() => setFilter("ALL")} active={filter === "ALL"} />
          <Kpi label="OK" value={fmtNum(summary.ok)} color={STATUS_COLOR.OK} onClick={() => setFilter("OK")} active={filter === "OK"} />
          <Kpi label="Drift Both" value={fmtNum(summary.drift_both)} color={STATUS_COLOR.DRIFT_BOTH} onClick={() => setFilter("DRIFT_BOTH")} active={filter === "DRIFT_BOTH"} />
          <Kpi label="Drift Vel" value={fmtNum(summary.drift_vel)} color={STATUS_COLOR.DRIFT_VEL} onClick={() => setFilter("DRIFT_VEL")} active={filter === "DRIFT_VEL"} />
          <Kpi label="Drift LT" value={fmtNum(summary.drift_lt)} color={STATUS_COLOR.DRIFT_LT} onClick={() => setFilter("DRIFT_LT")} active={filter === "DRIFT_LT"} />
          <Kpi label="Drift Moderado" value={fmtNum(summary.drift_moderate)} color={STATUS_COLOR.DRIFT_MODERATE} onClick={() => setFilter("DRIFT_MODERATE")} active={filter === "DRIFT_MODERATE"} />
          <Kpi label="Sin Baseline" value={fmtNum(summary.sin_baseline)} color={STATUS_COLOR.SIN_BASELINE} onClick={() => setFilter("SIN_BASELINE")} active={filter === "SIN_BASELINE"} />
          <Kpi label="Blocked Cost" value={fmtNum(summary.blocked_cost)} color={STATUS_COLOR.BLOCKED_COST} onClick={() => setFilter("BLOCKED_COST")} active={filter === "BLOCKED_COST"} />
        </div>
      )}

      {loading && <div style={{ padding: 16 }}>Cargando…</div>}
      {error && <div style={{ padding: 16, color: "var(--red)" }}>Error: {error}</div>}

      {!loading && !error && (
        <div className="card" style={{ overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--bg3)" }}>
              <tr>
                <th style={{ padding: 4, textAlign: "left" }}></th>
                <th style={{ padding: 4, textAlign: "left" }}>Status</th>
                <th style={{ padding: 4, textAlign: "left" }}>SKU</th>
                <th style={{ padding: 4, textAlign: "left" }}>Nombre</th>
                <th style={{ padding: 4, textAlign: "left" }}>Cell</th>
                <th style={{ padding: 4, textAlign: "right" }}>Vel decl</th>
                <th style={{ padding: 4, textAlign: "right" }}>Vel real</th>
                <th style={{ padding: 4, textAlign: "right" }}>Drift</th>
                <th style={{ padding: 4, textAlign: "right" }}>LT decl</th>
                <th style={{ padding: 4, textAlign: "right" }}>LT real</th>
                <th style={{ padding: 4, textAlign: "right" }}>qty</th>
                <th style={{ padding: 4, textAlign: "right" }}>CLP</th>
                <th style={{ padding: 4, textAlign: "left" }}>Proveedor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.sku_origen} style={{ borderTop: "1px solid var(--bg4)" }}>
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
                        background: (STATUS_COLOR[r.data_quality_status] || "#64748b") + "33",
                        color: STATUS_COLOR[r.data_quality_status] || "#64748b",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {r.data_quality_status}
                    </span>
                  </td>
                  <td className="mono" style={{ padding: 4 }}>{r.sku_origen}</td>
                  <td style={{ padding: 4, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.nombre || "—"}
                  </td>
                  <td className="mono" style={{ padding: 4 }}>{r.cell || "—"}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.vel_decl_sem, 2)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.vel_real_sem, 2)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtPct(r.vel_drift_pct)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.lt_decl)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtNum(r.lt_real_ultimo_oc_dias)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right", color: "var(--cyan)" }}>{fmtNum(r.qty_a_comprar)}</td>
                  <td className="mono" style={{ padding: 4, textAlign: "right" }}>{fmtCLP(r.clp_estimado)}</td>
                  <td style={{ padding: 4 }}>{r.proveedor_nombre || "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={13} style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>
                    Sin SKUs con este status.
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

function Kpi({
  label,
  value,
  color,
  onClick,
  active,
}: {
  label: string;
  value: string;
  color: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="card"
      style={{
        padding: 10,
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        border: active ? `2px solid ${color}` : "1px solid var(--bg4)",
        background: active ? `${color}10` : "var(--bg2)",
      }}
    >
      <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </button>
  );
}
