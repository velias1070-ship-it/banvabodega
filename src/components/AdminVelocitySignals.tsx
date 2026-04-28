"use client";
import { useEffect, useState } from "react";

/**
 * AdminVelocitySignals — Detectores de cambio de velocidad para sugerir
 * ajustes de precio. Manual: Comparada:269-279 + 235 + Engines:544.
 *
 * 3 señales:
 *  - caída (rojo): vel_30d < vel_60d × X% → markdown anticipado
 *  - aceleración (verde): vel_30d > vel_60d × X% → subir precio gradual
 *  - estabilidad post-markdown (azul): no revertir, nuevo baseline
 */

type Senal = "caida" | "aceleracion" | "estabilidad_post_markdown" | "en_evaluacion";
type Sugerencia = {
  sku: string; nombre: string;
  cuadrante: string | null; abc: string | null;
  vel_7d: number; vel_30d: number; vel_60d: number;
  tendencia_pct: number;
  dias_sin_movimiento: number | null;
  stock_full: number;
  cobertura_dias: number | null;
  precio_actual: number;
  precio_lista: number;
  margen_pct: number;
  costo: number;
  senal: Senal;
  delta_pct_sugerido: number;
  precio_propuesto: number;
  motivo: string;
  bloqueado_por: string[];
};

type Resp = {
  rule_set: { version_label: string; content_hash: string | null; using_fallback: boolean };
  cfg: {
    caida_ratio_30d_vs_60d: number;
    caida_descuento_pct: number;
    aceleracion_ratio_30d_vs_60d: number;
    aceleracion_subida_pct: number;
    estabilidad_post_markdown_dias: number;
    estabilidad_recovery_pct_pre_quiebre: number;
  };
  stats: {
    total_evaluados: number; total_sugerencias: number;
    caidas: number; aceleraciones: number; estabilidades: number; bloqueadas: number;
  };
  sugerencias: Sugerencia[];
};

const fmtCLP = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;
const truncHash = (h: string | null | undefined) => (h ? `${h.slice(0, 7)}…` : "—");

const SENAL_META: Record<Senal, { titulo: string; icon: string; color: string; bg: string; bd: string }> = {
  caida:                       { titulo: "Caída de velocidad",        icon: "📉", color: "var(--red)",   bg: "var(--redBg)",   bd: "var(--redBd)" },
  aceleracion:                 { titulo: "Aceleración",                icon: "📈", color: "var(--green)", bg: "var(--greenBg)", bd: "var(--greenBd)" },
  estabilidad_post_markdown:   { titulo: "Estabilidad post-markdown",  icon: "🧊", color: "var(--cyan)",  bg: "var(--cyanBg)",  bd: "var(--cyanBd)" },
  en_evaluacion:               { titulo: "En evaluación post-MD",      icon: "⏳", color: "var(--amber)", bg: "var(--amberBg)", bd: "var(--amberBd)" },
};

// ─── M5-B/C: estado de seguimiento ─────────────────────────────────────
type EstadoSeg = "en_eval" | "exitoso" | "marginal" | "sin_lift" | "indeterminado" | "expirado";
type RecAccion = "esperar" | "mantener_baseline" | "subir_precio" | "esperar_fin_promo" | "profundizar" | "salir_deal" | "ninguna";
type SeguimientoRow = {
  sku: string; titulo: string | null; cuadrante: string | null; abc: string | null;
  precio_pre: number; precio_post: number; delta_pct: number;
  fuente_cambio: string; ejecutado_por: string | null;
  t0: string; dias_desde_md: number; dias_restantes_lift: number; dias_restantes_eval: number;
  uds_pre_14d: number; uds_post_actuales: number; uds_post_14d: number | null;
  vel_pre: number; vel_post: number | null; lift: number | null;
  stock_al_t0: number; stock_actual: number; sell_through: number | null;
  estado: EstadoSeg; recomendacion: string; recomendacion_accion: RecAccion;
  margen_pct_actual: number | null;
  tiene_promo_activa: boolean; promo_activa_nombre: string | null; promo_activa_tier: number;
  cob_actual_dias: number | null; lead_time_dias: number | null; safety_stock_dias: number | null;
  stock_critico: boolean; reposicion_disponible: boolean;
};
type SegResp = {
  ventana_eval_dias: number; ventana_lift_dias: number;
  total: number;
  breakdown: Record<EstadoSeg, number>;
  seguimiento: SeguimientoRow[];
};
const ESTADO_META: Record<EstadoSeg, { color: string; bg: string; bd: string; label: string; icon: string }> = {
  en_eval:       { color: "var(--amber)", bg: "var(--amberBg)", bd: "var(--amberBd)", label: "En evaluación", icon: "⏳" },
  exitoso:       { color: "var(--green)", bg: "var(--greenBg)", bd: "var(--greenBd)", label: "Lift ≥1.5×",     icon: "✅" },
  marginal:      { color: "var(--cyan)",  bg: "var(--cyanBg)",  bd: "var(--cyanBd)",  label: "Marginal",        icon: "🟦" },
  sin_lift:      { color: "var(--red)",   bg: "var(--redBg)",   bd: "var(--redBd)",   label: "Sin lift",        icon: "❌" },
  indeterminado: { color: "var(--txt3)",  bg: "var(--bg3)",     bd: "var(--bg4)",     label: "Indeterminado",  icon: "❔" },
  expirado:      { color: "var(--txt3)",  bg: "var(--bg3)",     bd: "var(--bg4)",     label: "Expirado",        icon: "⏹️" },
};

const ACCION_META: Record<RecAccion, { color: string; label: string }> = {
  esperar:           { color: "var(--amber)", label: "⏳ Esperar" },
  mantener_baseline: { color: "var(--green)", label: "✅ Mantener" },
  subir_precio:     { color: "var(--cyan)",  label: "↑ Subir precio" },
  esperar_fin_promo: { color: "var(--amber)", label: "⏰ Esperar fin promo" },
  profundizar:       { color: "var(--red)",   label: "↓ Profundizar" },
  salir_deal:        { color: "var(--red)",   label: "✗ Salir DEAL" },
  ninguna:           { color: "var(--txt3)",  label: "—" },
};

export default function AdminVelocitySignals() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tipoFilter, setTipoFilter] = useState<Senal | "todas">("todas");
  const [tab, setTab] = useState<"sugerencias" | "seguimiento">("sugerencias");
  const [seg, setSeg] = useState<SegResp | null>(null);
  const [segLoading, setSegLoading] = useState(false);
  const [segError, setSegError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const url = tipoFilter === "todas" ? "/api/pricing/velocity-signals" : `/api/pricing/velocity-signals?tipo=${tipoFilter}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "load_failed");
      setData(j);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadSeguimiento() {
    setSegLoading(true); setSegError(null);
    try {
      const r = await fetch("/api/pricing/seguimiento");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "load_failed");
      setSeg(j);
    } catch (e: any) { setSegError(e.message); }
    finally { setSegLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tipoFilter]);
  useEffect(() => { if (tab === "seguimiento" && !seg) loadSeguimiento(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab]);

  if (!data && loading) return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ margin: 0, fontSize: 16 }}>📊 Pulsos de velocidad</h3>
      <div style={{ marginTop: 8, color: "var(--txt2)", fontSize: 13 }}>Cargando…</div>
    </div>
  );

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 18 }}>📊 Pulsos de velocidad — sugerencias de precio</h3>
          <div style={{ fontSize: 12, color: "var(--txt2)", marginTop: 4 }}>
            Detecta SKUs con cambio significativo de velocidad y propone ajuste. Manual: <span className="mono">Comparada:269-279, 235</span>.
            Rule set <strong>{data?.rule_set.version_label || "—"}</strong>{data?.rule_set.using_fallback && " (fallback)"} · hash <span className="mono">{truncHash(data?.rule_set.content_hash)}</span>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          style={{ padding: "6px 12px", border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt2)", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>
          {loading ? "..." : "🔄"}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, borderBottom: "1px solid var(--bg4)" }}>
        <button onClick={() => setTab("sugerencias")}
          style={{
            padding: "8px 14px", border: "none", background: "transparent",
            color: tab === "sugerencias" ? "var(--cyan)" : "var(--txt2)",
            borderBottom: tab === "sugerencias" ? "2px solid var(--cyan)" : "2px solid transparent",
            cursor: "pointer", fontSize: 13, fontWeight: 600,
          }}>
          🚦 Sugerencias activas
        </button>
        <button onClick={() => setTab("seguimiento")}
          style={{
            padding: "8px 14px", border: "none", background: "transparent",
            color: tab === "seguimiento" ? "var(--amber)" : "var(--txt2)",
            borderBottom: tab === "seguimiento" ? "2px solid var(--amber)" : "2px solid transparent",
            cursor: "pointer", fontSize: 13, fontWeight: 600,
          }}>
          ⏳ En seguimiento {seg && seg.total > 0 ? `(${seg.total})` : ""}
        </button>
      </div>

      {error && tab === "sugerencias" && (
        <div style={{ padding: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", color: "var(--red)", borderRadius: 6, fontSize: 12 }}>
          ❌ {error}
        </div>
      )}

      {tab === "seguimiento" && (
        <SeguimientoPanel data={seg} loading={segLoading} error={segError} onReload={loadSeguimiento} />
      )}

      {tab === "sugerencias" && data && (
        <>
          {/* Stats + filtros */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {(["todas", "caida", "aceleracion", "estabilidad_post_markdown"] as const).map((t) => {
              const count = t === "todas" ? data.stats.total_sugerencias
                          : t === "caida" ? data.stats.caidas
                          : t === "aceleracion" ? data.stats.aceleraciones
                          : data.stats.estabilidades;
              const isActive = tipoFilter === t;
              const meta = t !== "todas" ? SENAL_META[t] : null;
              return (
                <button key={t} onClick={() => setTipoFilter(t)}
                  style={{
                    padding: "6px 10px",
                    border: isActive ? `1px solid ${meta?.color || "var(--cyan)"}` : "1px solid var(--bg4)",
                    background: isActive ? (meta?.bg || "var(--cyanBg)") : "var(--bg3)",
                    color: isActive ? (meta?.color || "var(--cyan)") : "var(--txt2)",
                    borderRadius: 6, fontSize: 12, cursor: "pointer",
                  }}>
                  {meta ? `${meta.icon} ${meta.titulo}` : "Todas"} <span style={{ opacity: 0.7 }}>({count})</span>
                </button>
              );
            })}
            <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--txt3)" }}>
              {data.stats.total_evaluados} SKUs evaluados · umbrales: caída &lt;{Math.round((1-data.cfg.caida_ratio_30d_vs_60d)*100)}% (-{data.cfg.caida_descuento_pct}pp) · aceleración &gt;+{Math.round((data.cfg.aceleracion_ratio_30d_vs_60d-1)*100)}% (+{data.cfg.aceleracion_subida_pct}pp)
            </div>
          </div>

          {/* Tabla */}
          {data.sugerencias.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--txt3)", fontSize: 13 }}>
              Sin sugerencias para este filtro.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Señal</th>
                    <th>SKU</th>
                    <th style={{ textAlign: "right" }}>vel 30d</th>
                    <th style={{ textAlign: "right" }}>vel 60d</th>
                    <th style={{ textAlign: "right" }}>Δ%</th>
                    <th style={{ textAlign: "right" }}>Stock</th>
                    <th style={{ textAlign: "right" }}>Cob d</th>
                    <th style={{ textAlign: "right" }}>Precio actual</th>
                    <th style={{ textAlign: "right" }}>Margen %</th>
                    <th style={{ textAlign: "right" }}>Sugerencia</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sugerencias.slice(0, 100).map((s) => {
                    const meta = SENAL_META[s.senal];
                    const bloq = s.bloqueado_por.length > 0;
                    const deltaSign = s.delta_pct_sugerido > 0 ? "+" : s.delta_pct_sugerido < 0 ? "" : "±";
                    return (
                      <tr key={s.sku + s.senal} style={{ opacity: bloq ? 0.6 : 1 }}>
                        <td>
                          <span style={{
                            display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10,
                            background: meta.bg, color: meta.color, border: `1px solid ${meta.bd}`
                          }}>
                            {meta.icon} {meta.titulo}
                          </span>
                        </td>
                        <td>
                          <div className="mono" style={{ fontWeight: 600 }}>{s.sku}</div>
                          <div style={{ fontSize: 10, color: "var(--txt3)", maxWidth: 200, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.nombre}</div>
                          <div style={{ fontSize: 10, color: "var(--txt3)" }}>{s.cuadrante || "—"} · ABC {s.abc || "—"}</div>
                        </td>
                        <td style={{ textAlign: "right" }} className="mono">{s.vel_30d.toFixed(2)}</td>
                        <td style={{ textAlign: "right" }} className="mono">{s.vel_60d.toFixed(2)}</td>
                        <td style={{ textAlign: "right" }} className="mono"
                            title={`tendencia ${s.tendencia_pct.toFixed(1)}%`}>
                          <span style={{ color: s.vel_30d > s.vel_60d ? "var(--green)" : "var(--red)" }}>
                            {s.vel_60d > 0 ? `${Math.round((s.vel_30d/s.vel_60d - 1) * 100)}%` : "—"}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }} className="mono">{s.stock_full}</td>
                        <td style={{ textAlign: "right" }} className="mono">{s.cobertura_dias ?? "—"}</td>
                        <td style={{ textAlign: "right" }} className="mono">{fmtCLP(s.precio_actual)}</td>
                        <td style={{ textAlign: "right" }} className="mono"
                            title={`costo ${fmtCLP(s.costo)}`}>
                          <span style={{ color: s.margen_pct < 10 ? "var(--red)" : s.margen_pct < 20 ? "var(--amber)" : "var(--green)" }}>
                            {s.margen_pct.toFixed(1)}%
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {s.delta_pct_sugerido !== 0 ? (
                            <>
                              <div className="mono" style={{ fontWeight: 600 }}>{deltaSign}{s.delta_pct_sugerido}%</div>
                              <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{fmtCLP(s.precio_propuesto)}</div>
                            </>
                          ) : (
                            <span style={{ color: "var(--cyan)", fontSize: 11 }}>mantener</span>
                          )}
                        </td>
                        <td style={{ fontSize: 10, maxWidth: 360 }}>
                          {s.motivo}
                          {bloq && (
                            <div style={{ marginTop: 4, color: "var(--amber)" }}>
                              ⚠ Bloqueado por: {s.bloqueado_por.join(", ")}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {data.sugerencias.length > 100 && (
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
                  Mostrando 100 de {data.sugerencias.length}. Filtrar por tipo para ver más.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── M5-C: Panel "En seguimiento" ───────────────────────────────────────
function SeguimientoPanel({
  data, loading, error, onReload,
}: {
  data: SegResp | null; loading: boolean; error: string | null; onReload: () => void;
}) {
  if (loading && !data) {
    return <div style={{ padding: 16, color: "var(--txt2)", fontSize: 13 }}>Cargando seguimiento…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", color: "var(--red)", borderRadius: 6, fontSize: 12 }}>
        ❌ {error} <button onClick={onReload} style={{ marginLeft: 8 }}>retry</button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <>
      <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
        Cambios de precio en últimos {data.ventana_eval_dias}d. Lift evaluado a {data.ventana_lift_dias}d post-MD (Op_Limpieza KPI #4).
        <button onClick={onReload} disabled={loading}
          style={{ marginLeft: 12, padding: "3px 8px", border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt2)", borderRadius: 6, fontSize: 11, cursor: "pointer" }}>
          {loading ? "..." : "🔄"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {(["en_eval", "exitoso", "marginal", "sin_lift", "indeterminado"] as EstadoSeg[]).map(e => {
          const m = ESTADO_META[e];
          const n = data.breakdown[e];
          if (!n) return null;
          return (
            <div key={e}
              style={{
                padding: "4px 8px", border: `1px solid ${m.bd}`, background: m.bg, color: m.color,
                borderRadius: 6, fontSize: 11, display: "flex", gap: 6, alignItems: "center",
              }}>
              <span>{m.icon}</span><span>{m.label}</span><span style={{ opacity: 0.7 }}>({n})</span>
            </div>
          );
        })}
      </div>

      {data.seguimiento.length === 0 ? (
        <div style={{ padding: 16, textAlign: "center", color: "var(--txt3)", fontSize: 13 }}>
          Ningún SKU con cambio de precio en los últimos {data.ventana_eval_dias} días.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th>Estado</th>
                <th>SKU</th>
                <th>Cambio</th>
                <th style={{ textAlign: "right" }}>Día</th>
                <th style={{ textAlign: "right" }}>vel pre</th>
                <th style={{ textAlign: "right" }}>vel post</th>
                <th style={{ textAlign: "right" }}>Lift</th>
                <th style={{ textAlign: "right" }}>ST 14d</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Cob</th>
                <th>Promo</th>
                <th style={{ textAlign: "right" }}>Margen</th>
                <th>Acción</th>
                <th>Recomendación</th>
              </tr>
            </thead>
            <tbody>
              {data.seguimiento.map(r => {
                const m = ESTADO_META[r.estado];
                return (
                  <tr key={r.sku + r.t0}>
                    <td>
                      <span style={{
                        display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10,
                        background: m.bg, color: m.color, border: `1px solid ${m.bd}`,
                      }}>
                        {m.icon} {m.label}
                      </span>
                    </td>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{r.sku}</div>
                      <div style={{ fontSize: 10, color: "var(--txt3)", maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.titulo || "—"}</div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>{r.cuadrante || "—"} · ABC {r.abc || "—"}</div>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      <div>{fmtCLP(r.precio_pre)} → {fmtCLP(r.precio_post)}</div>
                      <div style={{ color: "var(--red)" }}>{r.delta_pct.toFixed(1)}%</div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>{r.fuente_cambio} · {r.ejecutado_por || "—"}</div>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      <div>d{r.dias_desde_md}</div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>
                        {r.dias_restantes_lift > 0 ? `lift en ${r.dias_restantes_lift}d` : `eval en ${r.dias_restantes_eval}d`}
                      </div>
                    </td>
                    <td className="mono" style={{ textAlign: "right" }} title={`${r.uds_pre_14d} uds en 14d pre`}>{r.vel_pre.toFixed(2)}</td>
                    <td className="mono" style={{ textAlign: "right" }} title={`${r.uds_post_actuales} uds en ${r.dias_desde_md}d post${r.uds_post_14d != null ? ` · proy 14d=${r.uds_post_14d}` : ""}`}>
                      {r.vel_post != null ? r.vel_post.toFixed(2) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.lift != null ? (
                        <span style={{ color: r.lift >= 1.5 ? "var(--green)" : r.lift >= 1.0 ? "var(--cyan)" : "var(--red)", fontWeight: 600 }}>
                          {r.lift.toFixed(2)}×
                        </span>
                      ) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.sell_through != null ? `${(r.sell_through * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.stock_actual}
                      {r.reposicion_disponible && <div style={{ fontSize: 9, color: "var(--green)" }}>+ prov</div>}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}
                        title={r.lead_time_dias != null ? `lead_time ${r.lead_time_dias}d + ss ${r.safety_stock_dias?.toFixed(1) ?? "—"}d` : ""}>
                      {r.cob_actual_dias != null ? (
                        <span style={{ color: r.stock_critico ? "var(--red)" : "var(--txt)" }}>
                          {r.cob_actual_dias}d
                        </span>
                      ) : "—"}
                      {r.stock_critico && <div style={{ fontSize: 9, color: "var(--red)" }}>crítico</div>}
                    </td>
                    <td style={{ fontSize: 10 }}>
                      {r.tiene_promo_activa ? (
                        <div title={`tier ${r.promo_activa_tier}`} style={{ color: r.promo_activa_tier >= 4 ? "var(--green)" : "var(--cyan)" }}>
                          {r.promo_activa_nombre || "—"}
                        </div>
                      ) : <span style={{ color: "var(--txt3)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.margen_pct_actual != null ? (
                        <span style={{ color: r.margen_pct_actual < 10 ? "var(--red)" : r.margen_pct_actual < 20 ? "var(--amber)" : "var(--green)" }}>
                          {r.margen_pct_actual.toFixed(1)}%
                        </span>
                      ) : "—"}
                    </td>
                    <td style={{ fontSize: 10 }}>
                      {(() => {
                        const a = ACCION_META[r.recomendacion_accion];
                        return <span style={{ color: a.color, fontWeight: 600 }}>{a.label}</span>;
                      })()}
                    </td>
                    <td style={{ fontSize: 10, maxWidth: 320, color: "var(--txt2)" }}>{r.recomendacion}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
