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

type Senal = "caida" | "aceleracion" | "estabilidad_post_markdown";
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
};

export default function AdminVelocitySignals() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tipoFilter, setTipoFilter] = useState<Senal | "todas">("todas");

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

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tipoFilter]);

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

      {error && (
        <div style={{ padding: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", color: "var(--red)", borderRadius: 6, fontSize: 12 }}>
          ❌ {error}
        </div>
      )}

      {data && (
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
