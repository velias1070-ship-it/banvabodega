"use client";

// Sprint 4.2 (2026-05-03) — Panel lateral "¿De dónde sale este número?".
// Slide-in drawer activado por botón ⓘ en /admin/reposicion-suggestions.
// Lee /api/admin/sku-explain/[sku]. Read-only — Sprint 4.3 agrega edición LT.

import { useEffect, useState } from "react";

type ExplainData = {
  sku_origen: string;
  nombre: string | null;
  categoria: string | null;
  proveedor_id: string | null;
  proveedor_nombre: string | null;
  cell: string | null;
  policy_action: string | null;
  sl_template: number | null;
  z_template: number | null;
  target_dias_template: number | null;
  template_fuente: string | null;
  vel_decl_sem: number | null;
  vel_7d_decl: number | null;
  vel_30d_decl: number | null;
  vel_60d_decl: number | null;
  vel_decl_dia: number | null;
  vel_real_dia: number | null;
  vel_real_sem: number | null;
  uds_30d_real: number | null;
  num_ordenes_30d: number | null;
  vel_drift_pct: number | null;
  vel_drift_status: string;
  lt_decl: number | null;
  sigma_lt_decl: number | null;
  lt_real_ultimo_oc_dias: number | null;
  ultimo_oc_fecha_emision: string | null;
  ultimo_oc_fecha_recepcion: string | null;
  ultimo_oc_numero: string | null;
  lt_drift_status: string;
  z: number | null;
  d_avg_sem: number | null;
  sigma_sem: number | null;
  sigma_dia: number | null;
  cycle_stock: number | null;
  safety_stock: number | null;
  reorder_point: number | null;
  pre_full_target: number | null;
  xyz_confidence: string | null;
  stock_bodega: number;
  stock_full: number;
  stock_total: number;
  in_transit_bodega: number;
  fecha_entrada_quiebre: string | null;
  dias_en_quiebre: number | null;
  costo_promedio: number | null;
  manual_override: boolean | null;
  policy_status: string | null;
  seasonal_match_source: string | null;
  margen_neto_30d_imputed: boolean | null;
  qty_a_comprar: number | null;
  clp_estimado: number | null;
  dias_cobertura_actual: number | null;
  bajo_rop: boolean | null;
  sku_intelligence_updated_at: string | null;
  policy_updated_at: string | null;
};

const fmtNum = (n: number | null | undefined, decimals = 0): string =>
  n == null ? "—" : Number(n).toLocaleString("es-CL", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtCLP = (n: number | null | undefined): string =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CL");

const fmtPct = (n: number | null | undefined): string =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(1)}%`;

const fmtDate = (s: string | null | undefined): string => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("es-CL");
  } catch {
    return s;
  }
};

const fmtDateTime = (s: string | null | undefined): string => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("es-CL");
  } catch {
    return s;
  }
};

const driftBadge = (status: string): { label: string; color: string; bg: string } => {
  switch (status) {
    case "aligned":
      return { label: "✓ Alineado", color: "#10b981", bg: "#10b98115" };
    case "drift_moderate":
      return { label: "± Drift moderado (10–30%)", color: "#f59e0b", bg: "#f59e0b15" };
    case "drift_high":
      return { label: "⚠ Drift alto (>30%)", color: "#ef4444", bg: "#ef444415" };
    case "drift":
      return { label: "⚠ Drift (>2 días)", color: "#ef4444", bg: "#ef444415" };
    case "sin_baseline":
      return { label: "— Sin baseline (vel_ponderada=0)", color: "#64748b", bg: "#64748b15" };
    case "sin_data":
      return { label: "— Sin data (no hay OC con LT real)", color: "#64748b", bg: "#64748b15" };
    default:
      return { label: status, color: "#64748b", bg: "#64748b15" };
  }
};

type Props = {
  sku: string | null;
  onClose: () => void;
};

export default function SkuExplainPanel({ sku, onClose }: Props) {
  const [data, setData] = useState<ExplainData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sku) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/admin/sku-explain/${encodeURIComponent(sku)}`)
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((j) => setData(j.data))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [sku]);

  if (!sku) return null;

  const velDrift = data ? driftBadge(data.vel_drift_status) : null;
  const ltDrift = data ? driftBadge(data.lt_drift_status) : null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 100,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(720px, 100vw)",
          background: "var(--bg2)",
          borderLeft: "1px solid var(--bg4)",
          zIndex: 101,
          overflowY: "auto",
          padding: "20px 24px",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>¿De dónde sale este número?</h2>
          <button
            onClick={onClose}
            style={{
              background: "var(--bg3)",
              border: "1px solid var(--bg4)",
              color: "var(--txt)",
              borderRadius: 6,
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            ✕ Cerrar
          </button>
        </div>

        {loading && <div style={{ padding: 40, textAlign: "center", color: "var(--txt2)" }}>Cargando…</div>}
        {error && (
          <div style={{ padding: 16, background: "#ef444415", border: "1px solid #ef444440", borderRadius: 8, color: "#ef4444" }}>
            Error: {error}
          </div>
        )}

        {data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* 1. IDENTIDAD */}
            <Section title="Identidad">
              <KV label="SKU" value={<span className="mono">{data.sku_origen}</span>} />
              <KV label="Nombre" value={data.nombre} />
              <KV label="Categoría" value={data.categoria} />
              <KV label="Proveedor" value={data.proveedor_nombre} />
              <KV label="Célula ABC×XYZ" value={<span className="mono">{data.cell}</span>} />
              <KV label="Acción de política" value={<span className="mono">{data.policy_action}</span>} />
              <KV label="Confianza XYZ" value={<span className="mono">{data.xyz_confidence}</span>} />
            </Section>

            {/* 2. VELOCIDAD DECLARADA VS REAL */}
            <Section title="Velocidad — declarada vs real (30d)">
              {velDrift && (
                <DriftBadge status={data.vel_drift_status} pct={data.vel_drift_pct} info={velDrift} />
              )}
              <Formula
                label="Declarada (motor, ponderada)"
                value={`${fmtNum(data.vel_decl_sem, 2)} uds/sem`}
                detail={`= ${fmtNum(data.vel_decl_dia, 3)} uds/día. Combina vel_7d, vel_30d, vel_60d con TSB. Fuente: sku_intelligence.vel_ponderada.`}
              />
              <Formula
                label="Real (medición directa)"
                value={`${fmtNum(data.vel_real_sem, 2)} uds/sem`}
                detail={`= ${fmtNum(data.uds_30d_real, 0)} uds en ${fmtNum(data.num_ordenes_30d, 0)} órdenes / 30 días × 7 = ${fmtNum(data.vel_real_sem, 2)} uds/sem. Fuente: ventas_ml_cache (anulada=false).`}
              />
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--txt2)" }}>Ver breakdown 7d / 30d / 60d</summary>
                <div style={{ paddingLeft: 12, marginTop: 8 }}>
                  <KV label="vel_7d" value={`${fmtNum(data.vel_7d_decl, 2)} uds/sem`} />
                  <KV label="vel_30d" value={`${fmtNum(data.vel_30d_decl, 2)} uds/sem`} />
                  <KV label="vel_60d" value={`${fmtNum(data.vel_60d_decl, 2)} uds/sem`} />
                </div>
              </details>
            </Section>

            {/* 3. LEAD TIME */}
            <Section title="Lead time del proveedor">
              {ltDrift && <DriftBadge status={data.lt_drift_status} info={ltDrift} />}
              <Formula
                label="Declarado"
                value={`${fmtNum(data.lt_decl, 0)} días`}
                detail={`σ = ${fmtNum(data.sigma_lt_decl, 0)} días. Fuente: proveedores.lead_time_dias (fallback productos.lead_time_dias, default 14).`}
              />
              <Formula
                label="Real (último OC recibido)"
                value={data.lt_real_ultimo_oc_dias != null ? `${data.lt_real_ultimo_oc_dias} días` : "Sin data"}
                detail={
                  data.ultimo_oc_numero
                    ? `OC ${data.ultimo_oc_numero}: emisión ${fmtDate(data.ultimo_oc_fecha_emision)} → recepción ${fmtDate(data.ultimo_oc_fecha_recepcion)}.`
                    : "No hay OC RECIBIDA_PARCIAL con lead_time_real computado para este SKU. Sprint 4.3 expondrá edición manual."
                }
              />
              <button
                disabled
                style={{
                  background: "var(--bg3)",
                  border: "1px solid var(--bg4)",
                  color: "var(--txt3)",
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                  cursor: "not-allowed",
                  alignSelf: "flex-start",
                  marginTop: 4,
                }}
                title="Sprint 4.3"
              >
                ✏️ Editar lead time (Sprint 4.3)
              </button>
            </Section>

            {/* 4. CÁLCULOS DEL MOTOR */}
            <Section title="Cálculos del motor">
              <Formula
                label="cycle_stock"
                value={`${fmtNum(data.cycle_stock, 0)} uds`}
                detail={`= round(vel_dia × LT) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.lt_decl, 0)}) = ${fmtNum(data.cycle_stock, 0)}. Cubre demanda durante el LT.`}
              />
              <Formula
                label="safety_stock"
                value={`${fmtNum(data.safety_stock, 0)} uds`}
                detail={`= z × σ_dia × √LT × 1.075 (σ_LT<2) o fórmula combinada (σ_LT≥2). z=${fmtNum(data.z, 2)}, σ_dia=${fmtNum(data.sigma_dia, 2)}. King Method, margen 7.5% por return rate.`}
              />
              <Formula
                label="reorder_point (ROP)"
                value={`${fmtNum(data.reorder_point, 0)} uds`}
                detail={`= cycle_stock + safety_stock = ${fmtNum(data.cycle_stock, 0)} + ${fmtNum(data.safety_stock, 0)}. Si stock_total + en_tránsito < ROP+pre_full_target → bajo_rop.`}
              />
              <Formula
                label="pre_full_target"
                value={`${fmtNum(data.pre_full_target, 0)} uds`}
                detail={`= round(vel_dia × target_dias_full) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.target_dias_template, 0)}) = ${fmtNum(data.pre_full_target, 0)}. Lo que hay que pre-posicionar en Full ML. Sprint 4.1: ahora se suma al stock_objetivo de bodega.`}
              />
              <Formula
                label="stock_objetivo"
                value={`${fmtNum((data.cycle_stock || 0) + (data.safety_stock || 0) + (data.pre_full_target || 0), 0)} uds`}
                detail="= cycle_stock + safety_stock + pre_full_target. Lo que debería haber siempre disponible (bodega + Full)."
              />
              <Formula
                label="qty_a_comprar"
                value={`${fmtNum(data.qty_a_comprar, 0)} uds`}
                detail={`= max(0, stock_objetivo − stock_total − in_transit) = max(0, ${(data.cycle_stock || 0) + (data.safety_stock || 0) + (data.pre_full_target || 0)} − ${fmtNum(data.stock_total, 0)} − ${fmtNum(data.in_transit_bodega, 0)}) = ${fmtNum(data.qty_a_comprar, 0)}.`}
              />
            </Section>

            {/* 5. STOCK ACTUAL */}
            <Section title="Stock actual">
              <KV label="Bodega central" value={`${fmtNum(data.stock_bodega, 0)} uds`} />
              <KV label="Full ML" value={`${fmtNum(data.stock_full, 0)} uds`} />
              <KV label="Total" value={`${fmtNum(data.stock_total, 0)} uds`} />
              <KV label="En tránsito a bodega" value={`${fmtNum(data.in_transit_bodega, 0)} uds`} />
              <KV
                label="Días de cobertura"
                value={data.dias_cobertura_actual != null ? `${data.dias_cobertura_actual} días` : "—"}
              />
              <KV label="¿Bajo ROP?" value={data.bajo_rop ? "SÍ" : "NO"} />
            </Section>

            {/* 6. QUIEBRE */}
            {(data.dias_en_quiebre != null || data.fecha_entrada_quiebre) && (
              <Section title="Quiebre">
                <KV label="Fecha entrada quiebre" value={fmtDate(data.fecha_entrada_quiebre)} />
                <KV label="Días en quiebre" value={data.dias_en_quiebre != null ? `${data.dias_en_quiebre} días` : "—"} />
              </Section>
            )}

            {/* 7. POLÍTICA */}
            <Section title="Política activa">
              <KV label="Status" value={<span className="mono">{data.policy_status}</span>} />
              <KV label="Plantilla (cell)" value={<span className="mono">{data.cell}</span>} />
              <KV label="Service level (template)" value={fmtNum(data.sl_template, 2)} />
              <KV label="z_value (template)" value={fmtNum(data.z_template, 2)} />
              <KV label="target_dias_full (template)" value={`${fmtNum(data.target_dias_template, 0)} días`} />
              <KV label="Fuente template" value={data.template_fuente} />
              <KV label="Manual override" value={data.manual_override ? "SÍ" : "NO"} />
              <KV label="Seasonal match source" value={data.seasonal_match_source} />
              <KV
                label="Margen 30d imputado"
                value={data.margen_neto_30d_imputed ? "SÍ (estimado)" : "NO (real)"}
              />
            </Section>

            {/* 8. SUGERENCIA */}
            <Section title="Sugerencia de compra">
              <KV label="qty a comprar" value={`${fmtNum(data.qty_a_comprar, 0)} uds`} />
              <KV label="CLP estimado" value={fmtCLP(data.clp_estimado)} />
              <KV label="Costo unitario" value={fmtCLP(data.costo_promedio)} />
              <KV
                label="Notas"
                value={
                  data.qty_a_comprar == null || data.qty_a_comprar === 0
                    ? "Sin sugerencia activa (no está bajo ROP)."
                    : "Suma a la OC del proveedor en /admin/oc-nueva."
                }
              />
            </Section>

            {/* 9. ÚLTIMA ACTUALIZACIÓN */}
            <Section title="Última actualización">
              <KV label="sku_intelligence" value={fmtDateTime(data.sku_intelligence_updated_at)} />
              <KV label="política" value={fmtDateTime(data.policy_updated_at)} />
            </Section>
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <h3 style={{ margin: "0 0 10px 0", fontSize: 13, color: "var(--cyan)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, fontSize: 12 }}>
      <div style={{ color: "var(--txt2)" }}>{label}</div>
      <div style={{ color: "var(--txt)" }}>{value ?? "—"}</div>
    </div>
  );
}

function Formula({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div style={{ borderLeft: "2px solid var(--bg4)", paddingLeft: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ color: "var(--txt2)", fontSize: 12 }}>{label}</span>
        <span className="mono" style={{ color: "var(--txt)", fontWeight: 600, fontSize: 13 }}>{value}</span>
      </div>
      <div className="mono" style={{ color: "var(--txt3)", fontSize: 11, marginTop: 3, lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}

function DriftBadge({
  status,
  pct,
  info,
}: {
  status: string;
  pct?: number | null;
  info: { label: string; color: string; bg: string };
}) {
  return (
    <div
      style={{
        background: info.bg,
        border: `1px solid ${info.color}40`,
        color: info.color,
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {info.label}
      {pct != null && status !== "aligned" && status !== "sin_baseline" && (
        <span className="mono" style={{ marginLeft: 8 }}>({fmtPct(pct)})</span>
      )}
    </div>
  );
}
