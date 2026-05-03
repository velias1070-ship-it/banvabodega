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
  target_dias_flex_template: number | null;
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
  reserva_flex_target: number | null;
  xyz_confidence: string | null;
  stock_bodega: number;
  stock_full: number;
  stock_total: number;
  in_transit_bodega: number;
  fecha_entrada_quiebre: string | null;
  dias_en_quiebre: number | null;
  // Sprint 4.2.1 — quiebre por nodo
  quiebre_bodega_estado: "OK" | "EN_QUIEBRE";
  quiebre_bodega_fecha: string | null;
  quiebre_bodega_dias: number | null;
  quiebre_full_estado: "OK" | "EN_QUIEBRE";
  quiebre_full_fecha: string | null;
  quiebre_full_dias: number | null;
  alerta_operativa: string | null;
  costo_promedio: number | null;
  manual_override: boolean | null;
  policy_status: string | null;
  seasonal_match_source: string | null;
  margen_neto_30d_imputed: boolean | null;
  qty_a_comprar: number | null;
  clp_estimado: number | null;
  dias_cobertura_actual: number | null;
  bajo_rop: boolean | null;
  // Sprint 4.3a — motor viejo importado
  accion: string | null;
  es_quiebre_proveedor: boolean | null;
  vel_pre_quiebre: number | null;
  factor_rampup_aplicado: number | null;
  rampup_motivo: string | null;
  evento_activo: boolean | null;
  multiplicador_evento: number | null;
  mandar_full: number | null;
  pedir_proveedor_motor_viejo: number | null;
  pedir_proveedor_sin_rampup: number | null;
  target_dias_flex: number | null;
  flex_priority: string | null;
  d_avg_sem_efectivo: number | null;
  // Sprint 4.3b — tendencia + promoción
  tendencia: string | null;
  cell_original: string | null;
  cell_efectiva: string | null;
  promocion_activa: boolean | null;
  promocion_motivo: string | null;
  tendencia_updated_at: string | null;
  vel_28d_recent: number | null;
  vel_28d_previous: number | null;
  vel_baseline_90d: number | null;
  ratio_recent_vs_previous: number | null;
  ratio_recent_vs_baseline: number | null;
  uds_ultimas_4_semanas: number | null;
  uds_4_semanas_previas: number | null;
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

            {/* 3.4 TENDENCIA (Sprint 4.3b) */}
            <Section title="📈 Tendencia">
              <KV
                label="Estado"
                value={<TendenciaBadge tendencia={data.tendencia} />}
              />
              <Formula
                label="Velocidad últimas 4 sem (28d)"
                value={`${fmtNum(data.vel_28d_recent, 2)} uds/sem`}
                detail={`= ${fmtNum(data.uds_ultimas_4_semanas, 0)} uds en 28 días / 4 sem.`}
              />
              <Formula
                label="Velocidad 4 sem previas (29-56d)"
                value={`${fmtNum(data.vel_28d_previous, 2)} uds/sem`}
                detail={`= ${fmtNum(data.uds_4_semanas_previas, 0)} uds en días 29-56 / 4 sem. Comparación reciente vs previa detecta cambios en 4-7 días.`}
              />
              <Formula
                label="Velocidad baseline (90d)"
                value={`${fmtNum(data.vel_baseline_90d, 2)} uds/sem`}
                detail="Promedio últimos 90 días. Punto de referencia histórico para confirmar aceleración real."
              />
              <Formula
                label="Ratio reciente vs previa"
                value={data.ratio_recent_vs_previous != null ? `${fmtNum(data.ratio_recent_vs_previous, 2)}×` : "—"}
                detail={(() => {
                  const r = data.ratio_recent_vs_previous;
                  if (r == null) return "Sin previas (28d previas = 0).";
                  if (r >= 2.0) return "≥ 2.0× → acelerando_fuerte (si uds_28d ≥ 5).";
                  if (r >= 1.5) return "≥ 1.5× → posible aceleración (necesita ratio_baseline ≥ 1.3 para confirmar).";
                  if (r <= 0.3) return "≤ 0.3× → desacelerando_fuerte (si previas ≥ 5).";
                  if (r <= 0.5) return "≤ 0.5× → posible desaceleración (necesita ratio_baseline ≤ 0.7).";
                  return "Estable: cambio dentro de banda 0.5×–1.5×.";
                })()}
              />
              <Formula
                label="Ratio reciente vs baseline 90d"
                value={data.ratio_recent_vs_baseline != null ? `${fmtNum(data.ratio_recent_vs_baseline, 2)}×` : "—"}
                detail="Confirma que la aceleración no es un rebote sobre 4 semanas anómalas. Aceleración requiere ambos ratios alineados."
              />
              {data.promocion_activa === true && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "#10b98120",
                    border: "1px solid #10b98155",
                    color: "#10b981",
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
                    ⭐ POLÍTICA PROMOVIDA POR ACELERACIÓN
                  </div>
                  <div className="mono" style={{ marginBottom: 4 }}>
                    Celda original: {data.cell_original ?? "—"} → efectiva: {data.cell_efectiva ?? "—"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt2)", marginBottom: 4 }}>
                    {data.promocion_motivo}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt2)", lineHeight: 1.5 }}>
                    El sistema detectó que el SKU está acelerando y aplica política de{" "}
                    <span className="mono">{data.cell_efectiva}</span> (más agresiva: más z y más
                    días de cobertura Full) en lugar de{" "}
                    <span className="mono">{data.cell_original}</span>. Cuando se desacelere o
                    el cron mensual lo reclasifique oficialmente, se vuelve a la celda original.
                  </div>
                </div>
              )}
              <KV
                label="Última actualización"
                value={<span className="mono" style={{ fontSize: 11 }}>{fmtDateTime(data.tendencia_updated_at)}</span>}
              />
            </Section>

            {/* 3.5 INTELIGENCIA OPERATIVA (Sprint 4.3a) */}
            <Section title="🧠 Inteligencia operativa (motor)">
              <KV
                label="Acción del motor"
                value={<AccionBadge accion={data.accion} />}
              />
              <Formula
                label="Velocidad efectiva (d_avg_sem)"
                value={`${fmtNum(data.d_avg_sem_efectivo ?? data.d_avg_sem, 2)} uds/sem`}
                detail={(() => {
                  if (data.es_quiebre_proveedor && data.vel_pre_quiebre && data.vel_pre_quiebre > 0 && data.vel_pre_quiebre > (data.vel_decl_sem || 0) * 2) {
                    return `Usa vel_pre_quiebre=${fmtNum(data.vel_pre_quiebre, 2)} (proveedor en quiebre, vel histórica > 2× actual). El motor protege la velocidad pre-quiebre para no subdimensionar la reposición.`;
                  }
                  if ((data.multiplicador_evento || 1) > 1) {
                    return `Usa vel_ponderada × multiplicador_evento = ${fmtNum(data.vel_decl_sem, 2)} × ${fmtNum(data.multiplicador_evento, 2)} (evento activo).`;
                  }
                  return `Usa vel_ponderada = ${fmtNum(data.vel_decl_sem, 2)} uds/sem. Sin protección de quiebre ni evento activo.`;
                })()}
              />
              {(data.factor_rampup_aplicado != null && data.factor_rampup_aplicado !== 1) && (
                <Formula
                  label={`Factor rampup aplicado: ${fmtNum(data.factor_rampup_aplicado, 2)}×`}
                  value={data.rampup_motivo || "—"}
                  detail={`Ajusta vel × ${fmtNum(data.factor_rampup_aplicado, 2)} por contexto de rampa post-quiebre o cuadrante. Sin rampup pediría ${fmtNum(data.pedir_proveedor_sin_rampup, 0)} uds.`}
                />
              )}
              {data.evento_activo === true && (
                <Formula
                  label="Evento estacional activo"
                  value={`× ${fmtNum(data.multiplicador_evento, 2)}`}
                  detail="Multiplicador de evento aplicado a la velocidad para anticipar demanda estacional."
                />
              )}
              <Formula
                label="mandar_full (push WMS → Full)"
                value={data.mandar_full != null ? `${fmtNum(data.mandar_full, 0)} uds` : "—"}
                detail="Cantidad que el motor sugiere enviar de bodega a Full ML para cubrir target_dias_full. Calculado por intelligence.ts."
              />
              <Formula
                label="Comparación motor viejo vs dashboard nuevo"
                value={`viejo=${fmtNum(data.pedir_proveedor_motor_viejo, 0)} · nuevo=${fmtNum(data.qty_a_comprar, 0)}`}
                detail={(() => {
                  const viejo = data.pedir_proveedor_motor_viejo || 0;
                  const nuevo = data.qty_a_comprar || 0;
                  const delta = nuevo - viejo;
                  if (Math.abs(delta) <= 2) return `Coinciden (Δ=${delta}). Dashboard reproduce el motor viejo.`;
                  if (delta > 0) return `Dashboard sugiere ${delta} más. Diferencia probablemente por reserva_flex_target=${fmtNum(data.reserva_flex_target, 0)} (multi-canal Sprint 4.3a) o redondeo.`;
                  return `Dashboard sugiere ${Math.abs(delta)} menos. Revisar — el motor viejo (intelligence.ts) es el oráculo en quiebre proveedor.`;
                })()}
              />
            </Section>

            {/* 3.6 MULTI-CANAL FULL/FLEX (Sprint 4.3a) */}
            <Section title="🚚 Multi-canal Full / Flex">
              <KV
                label="Prioridad de canal"
                value={<FlexPriorityBadge priority={data.flex_priority} />}
              />
              <Formula
                label="Cobertura objetivo Full ML"
                value={`${fmtNum(data.target_dias_template, 0)} días → ${fmtNum(data.pre_full_target, 0)} uds`}
                detail={`pre_full_target = round(vel_dia × target_dias_full) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.target_dias_template, 0)}) = ${fmtNum(data.pre_full_target, 0)} uds pre-posicionados en Full.`}
              />
              <Formula
                label="Cobertura objetivo Flex (bodega)"
                value={`${fmtNum(data.target_dias_flex_template ?? data.target_dias_flex, 0)} días → ${fmtNum(data.reserva_flex_target, 0)} uds`}
                detail={`reserva_flex_target = round(vel_dia × target_dias_flex) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.target_dias_flex_template ?? data.target_dias_flex, 0)}) = ${fmtNum(data.reserva_flex_target, 0)} uds reservados en bodega para venta Flex (no se mandan a Full).`}
              />
              <Formula
                label="Desglose stock_objetivo"
                value={`${fmtNum((data.safety_stock || 0) + (data.pre_full_target || 0) + (data.reserva_flex_target || 0), 0)} uds`}
                detail={`= safety(${fmtNum(data.safety_stock, 0)}) + pre_full(${fmtNum(data.pre_full_target, 0)}) + reserva_flex(${fmtNum(data.reserva_flex_target, 0)}). cycle_stock(${fmtNum(data.cycle_stock, 0)}) ya está cubierto dentro de target_dias_full (LT supplier ≤ target_dias_full), por eso no se suma para evitar doble conteo.`}
              />
            </Section>

            {/* 4. CÁLCULOS DEL MOTOR */}
            <Section title="Cálculos del motor">
              <Formula
                label="cycle_stock (informativo)"
                value={`${fmtNum(data.cycle_stock, 0)} uds`}
                detail={`= round(vel_dia × LT) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.lt_decl, 0)}) = ${fmtNum(data.cycle_stock, 0)}. Cubre demanda durante el LT del proveedor. Ya implícito en target_dias_full → NO se suma a stock_objetivo (Sprint 4.3a evita doble conteo).`}
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
                detail={`= round(vel_dia × target_dias_full) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.target_dias_template, 0)}) = ${fmtNum(data.pre_full_target, 0)}. Lo que hay que pre-posicionar en Full ML.`}
              />
              <Formula
                label="reserva_flex_target"
                value={`${fmtNum(data.reserva_flex_target, 0)} uds`}
                detail={`= round(vel_dia × target_dias_flex) = round(${fmtNum(data.vel_decl_dia, 3)} × ${fmtNum(data.target_dias_flex_template ?? data.target_dias_flex, 0)}) = ${fmtNum(data.reserva_flex_target, 0)}. Reserva en bodega para venta Flex multi-canal (Sprint 4.3a).`}
              />
              <Formula
                label="stock_objetivo"
                value={`${fmtNum((data.safety_stock || 0) + (data.pre_full_target || 0) + (data.reserva_flex_target || 0), 0)} uds`}
                detail={`= safety_stock + pre_full_target + reserva_flex_target = ${fmtNum(data.safety_stock, 0)} + ${fmtNum(data.pre_full_target, 0)} + ${fmtNum(data.reserva_flex_target, 0)}. Sprint 4.3a: cycle_stock NO se suma (implícito en pre_full_target cuando LT ≤ target_dias_full).`}
              />
              <Formula
                label="qty_a_comprar"
                value={`${fmtNum(data.qty_a_comprar, 0)} uds`}
                detail={`= max(0, stock_objetivo − stock_total − in_transit) = max(0, ${(data.safety_stock || 0) + (data.pre_full_target || 0) + (data.reserva_flex_target || 0)} − ${fmtNum(data.stock_total, 0)} − ${fmtNum(data.in_transit_bodega, 0)}) = ${fmtNum(data.qty_a_comprar, 0)}.`}
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

            {/* 6. QUIEBRE POR NODO (Sprint 4.2.1) */}
            <Section title="⚠️ Estado de quiebre">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {/* Bodega */}
                <div style={{ borderLeft: "2px solid var(--bg4)", paddingLeft: 10 }}>
                  <div style={{ color: "var(--txt2)", fontSize: 12, marginBottom: 4 }}>Bodega central</div>
                  <QuiebreBadge estado={data.quiebre_bodega_estado} />
                  {data.quiebre_bodega_estado === "EN_QUIEBRE" && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--txt3)" }}>
                      <div className="mono">Desde: {fmtDate(data.quiebre_bodega_fecha)}</div>
                      <div className="mono">Días: {data.quiebre_bodega_dias ?? "—"}</div>
                    </div>
                  )}
                </div>
                {/* Full ML */}
                <div style={{ borderLeft: "2px solid var(--bg4)", paddingLeft: 10 }}>
                  <div style={{ color: "var(--txt2)", fontSize: 12, marginBottom: 4 }}>Full ML</div>
                  <QuiebreBadge estado={data.quiebre_full_estado} />
                  {data.quiebre_full_estado === "EN_QUIEBRE" && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--txt3)" }}>
                      <div className="mono">Desde: {fmtDate(data.quiebre_full_fecha)}</div>
                      <div className="mono">Días: {data.quiebre_full_dias ?? "—"}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Alerta operativa contextual */}
              {data.alerta_operativa && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "#f59e0b15",
                    border: "1px solid #f59e0b40",
                    color: "#fbbf24",
                    fontSize: 12,
                  }}
                >
                  <strong style={{ marginRight: 6 }}>💡 Acción sugerida:</strong>
                  {data.alerta_operativa}
                </div>
              )}

              {/* Legacy quiebre (deprecado, se muestra solo si hay valor — debug) */}
              {(data.dias_en_quiebre != null || data.fecha_entrada_quiebre) && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: "pointer", color: "var(--txt3)", fontSize: 11 }}>
                    Legacy (sku_intelligence.fecha_entrada_quiebre)
                  </summary>
                  <div style={{ paddingLeft: 12, marginTop: 6, fontSize: 11, color: "var(--txt3)" }}>
                    <div className="mono">Fecha: {fmtDate(data.fecha_entrada_quiebre)}</div>
                    <div className="mono">Días: {data.dias_en_quiebre ?? "—"}</div>
                    <div style={{ marginTop: 4, fontStyle: "italic" }}>
                      Sprint 4.2.1 reemplazó este cálculo con quiebre por nodo. Este campo se
                      preserva por compat hasta que el cron lo recalcule.
                    </div>
                  </div>
                </details>
              )}
            </Section>

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

function TendenciaBadge({ tendencia }: { tendencia: string | null }) {
  if (!tendencia) return <span style={{ color: "var(--txt3)" }}>—</span>;
  const map: Record<string, { color: string; bg: string; label: string }> = {
    acelerando_fuerte: { color: "#10b981", bg: "#10b98120", label: "🚀 ACELERANDO FUERTE (≥2×)" },
    acelerando: { color: "#10b981", bg: "#10b98115", label: "🟢 ACELERANDO (≥1.5×)" },
    estable: { color: "#94a3b8", bg: "#94a3b815", label: "🟡 ESTABLE" },
    desacelerando: { color: "#f59e0b", bg: "#f59e0b15", label: "🟠 DESACELERANDO (≤0.5×)" },
    desacelerando_fuerte: { color: "#ef4444", bg: "#ef444415", label: "🔴 DESACELERANDO FUERTE (≤0.3×)" },
    insuficiente_data: { color: "#64748b", bg: "#64748b15", label: "⚪ INSUFICIENTE DATA (<5 uds en 90d)" },
  };
  const info = map[tendencia] || { color: "#64748b", bg: "#64748b15", label: tendencia };
  return (
    <span
      className="mono"
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 4,
        background: info.bg,
        border: `1px solid ${info.color}40`,
        color: info.color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {info.label}
    </span>
  );
}

function AccionBadge({ accion }: { accion: string | null }) {
  if (!accion) return <span style={{ color: "var(--txt3)" }}>—</span>;
  const map: Record<string, { color: string; bg: string; label: string }> = {
    AGOTADO_SIN_PROVEEDOR: { color: "#ef4444", bg: "#ef444415", label: "🔴 AGOTADO SIN PROVEEDOR" },
    PEDIR_PROVEEDOR: { color: "#f59e0b", bg: "#f59e0b15", label: "🟠 PEDIR PROVEEDOR" },
    MANDAR_FULL: { color: "#3b82f6", bg: "#3b82f615", label: "🔵 MANDAR FULL" },
    OK: { color: "#10b981", bg: "#10b98115", label: "✓ OK" },
  };
  const info = map[accion] || { color: "#64748b", bg: "#64748b15", label: accion };
  return (
    <span
      className="mono"
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 4,
        background: info.bg,
        border: `1px solid ${info.color}40`,
        color: info.color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {info.label}
    </span>
  );
}

function FlexPriorityBadge({ priority }: { priority: string | null }) {
  if (!priority) return <span style={{ color: "var(--txt3)" }}>—</span>;
  const map: Record<string, { color: string; label: string }> = {
    default: { color: "#64748b", label: "default — multi-canal balanceado" },
    only_flex: { color: "#f59e0b", label: "only_flex — solo bodega/Flex" },
    only_full: { color: "#3b82f6", label: "only_full — solo Full ML" },
    manual_split: { color: "#a855f7", label: "manual_split — split definido por admin" },
  };
  const info = map[priority] || { color: "#64748b", label: priority };
  return (
    <span
      className="mono"
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        background: `${info.color}15`,
        border: `1px solid ${info.color}40`,
        color: info.color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {info.label}
    </span>
  );
}

function QuiebreBadge({ estado }: { estado: "OK" | "EN_QUIEBRE" }) {
  const ok = estado === "OK";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        background: ok ? "#10b98115" : "#ef444415",
        border: `1px solid ${ok ? "#10b98140" : "#ef444440"}`,
        color: ok ? "#10b981" : "#ef4444",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {ok ? "✓ OK" : "⚠ EN QUIEBRE"}
    </span>
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
