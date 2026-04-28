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
  sku: string; item_id: string; nombre: string;
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
type Confianza = "nula" | "baja" | "media" | "alta";
type SeguimientoRow = {
  sku: string; titulo: string | null; cuadrante: string | null; abc: string | null;
  precio_pre: number; precio_post: number; delta_pct: number;
  fuente_cambio: string; motivo: string | null;
  promo_name_at_change: string | null; correlation_id: string | null;
  ejecutado_por: string | null;
  t0: string; dias_desde_md: number; dias_restantes_lift: number; dias_restantes_eval: number;
  uds_pre_14d: number; uds_post_actuales: number; uds_post_14d: number | null;
  vel_pre: number; vel_post: number | null; lift: number | null;
  stock_al_t0: number; stock_actual: number; sell_through: number | null;
  estado: EstadoSeg; confianza: Confianza; confianza_motivo: string;
  recomendacion: string; recomendacion_accion: RecAccion;
  alerta_stock_temprana: boolean;
  margen_pct_actual: number | null;
  tiene_promo_activa: boolean; promo_activa_nombre: string | null; promo_activa_tier: number;
  cob_actual_dias: number | null; lead_time_dias: number | null; safety_stock_dias: number | null;
  stock_critico: boolean; reposicion_disponible: boolean;
};

const CONFIANZA_META: Record<Confianza, { color: string; label: string; icon: string }> = {
  nula:  { color: "var(--txt3)",  label: "muy temprano", icon: "—" },
  baja:  { color: "var(--amber)", label: "preliminar",   icon: "◔" },
  media: { color: "var(--cyan)",  label: "early-stop",   icon: "◑" },
  alta:  { color: "var(--green)", label: "completa",     icon: "●" },
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

// ─── Filtros por motivo (taxonomía v95) — Engines:432, Op_Limpieza:89 ──
const MOTIVO_TAB_META: Record<string, { label: string; icon: string; color: string }> = {
  todos:                   { label: "Todos",        icon: "•",  color: "var(--txt2)" },
  senal_pulsos_velocidad:  { label: "Hipótesis Pulsos", icon: "📊", color: "var(--cyan)" },
  ajuste_margen_manual:    { label: "Ajustes margen", icon: "✏️", color: "var(--amber)" },
  postular_evento:         { label: "Eventos DEAL",  icon: "🎯", color: "var(--green)" },
  markdown_aging:          { label: "Aging",         icon: "⏳", color: "var(--red)" },
  ml_obliga_precio:        { label: "ML obliga",     icon: "🔒", color: "var(--txt3)" },
  revertir:                { label: "Revertir",      icon: "↩",  color: "var(--txt3)" },
  correccion_operativa:    { label: "Correc. op.",   icon: "🔧", color: "var(--txt3)" },
  sync_externo:            { label: "Externo (sin clasif)", icon: "❔", color: "var(--txt3)" },
  sin_motivo:              { label: "Sin motivo",    icon: "—",  color: "var(--txt3)" },
};
type MotivoTab = keyof typeof MOTIVO_TAB_META;

// Agrupación promo masiva: N≥3 SKUs con MISMO motivo + MISMO promo_name dentro
// de 5min se pliegan como 1 evento. Reduce ruido cuando se postula un DEAL bulk.
const PROMO_GROUP_WINDOW_MS = 5 * 60 * 1000;
const PROMO_GROUP_MIN_N = 3;

type GroupedItem =
  | { kind: "row"; row: SeguimientoRow }
  | { kind: "group"; rows: SeguimientoRow[]; promo_name: string; motivo: string; t0_min: string; t0_max: string };

function agruparPromoMasiva(rows: SeguimientoRow[]): GroupedItem[] {
  // Agrupa por (motivo, promo_name) dentro de ventana 5min. Solo agrupa si N≥3.
  type Bucket = { motivo: string; promo_name: string; rows: SeguimientoRow[]; t0_min: number; t0_max: number };
  const buckets: Bucket[] = [];
  for (const r of rows) {
    if (!r.motivo || !r.promo_name_at_change) continue;
    const t = new Date(r.t0).getTime();
    const fit = buckets.find(b =>
      b.motivo === r.motivo &&
      b.promo_name === r.promo_name_at_change &&
      Math.abs(t - b.t0_min) <= PROMO_GROUP_WINDOW_MS &&
      Math.abs(t - b.t0_max) <= PROMO_GROUP_WINDOW_MS
    );
    if (fit) {
      fit.rows.push(r);
      fit.t0_min = Math.min(fit.t0_min, t);
      fit.t0_max = Math.max(fit.t0_max, t);
    } else {
      buckets.push({ motivo: r.motivo, promo_name: r.promo_name_at_change!, rows: [r], t0_min: t, t0_max: t });
    }
  }
  const grouped = new Set<SeguimientoRow>();
  const result: GroupedItem[] = [];
  for (const b of buckets) {
    if (b.rows.length >= PROMO_GROUP_MIN_N) {
      for (const r of b.rows) grouped.add(r);
      result.push({
        kind: "group",
        rows: b.rows,
        promo_name: b.promo_name,
        motivo: b.motivo,
        t0_min: new Date(b.t0_min).toISOString(),
        t0_max: new Date(b.t0_max).toISOString(),
      });
    }
  }
  for (const r of rows) {
    if (!grouped.has(r)) result.push({ kind: "row", row: r });
  }
  // Orden: más reciente arriba (group por t0_max, row por t0).
  result.sort((a, b) => {
    const ta = a.kind === "group" ? a.t0_max : a.row.t0;
    const tb = b.kind === "group" ? b.t0_max : b.row.t0;
    return tb.localeCompare(ta);
  });
  return result;
}

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
  const [applyingSku, setApplyingSku] = useState<string | null>(null);
  const [appliedMap, setAppliedMap] = useState<Record<string, { ok: boolean; msg: string }>>({});

  async function aplicar(s: Sugerencia) {
    if (s.delta_pct_sugerido === 0) return;
    const conf = window.confirm(
      `Aplicar sugerencia para ${s.sku}?\n\n` +
      `${fmtCLP(s.precio_actual)} → ${fmtCLP(s.precio_propuesto)} ` +
      `(${s.delta_pct_sugerido > 0 ? "+" : ""}${s.delta_pct_sugerido}%)\n\n` +
      `Motivo: senal_pulsos_velocidad`
    );
    if (!conf) return;
    setApplyingSku(s.sku);
    try {
      const r = await fetch("/api/pricing/aplicar-sugerencia", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: s.item_id,
          sku: s.sku,
          precio_propuesto: s.precio_propuesto,
          senal: s.senal,
          actor: "admin",
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setAppliedMap(m => ({ ...m, [s.sku]: { ok: false, msg: j.error || j.message || "error" } }));
      } else {
        setAppliedMap(m => ({ ...m, [s.sku]: { ok: true, msg: `Aplicado · ${fmtCLP(j.applied_price)} (${j.branch})` } }));
      }
    } catch (e: any) {
      setAppliedMap(m => ({ ...m, [s.sku]: { ok: false, msg: e?.message || "network_error" } }));
    } finally {
      setApplyingSku(null);
    }
  }

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
                    <th style={{ textAlign: "center" }}>Acción</th>
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
                        <td style={{ textAlign: "center" }}>
                          {appliedMap[s.sku] ? (
                            <span style={{
                              fontSize: 10,
                              color: appliedMap[s.sku].ok ? "var(--green)" : "var(--red)",
                            }} title={appliedMap[s.sku].msg}>
                              {appliedMap[s.sku].ok ? "✓ aplicado" : "✗ error"}
                            </span>
                          ) : s.delta_pct_sugerido === 0 || bloq ? (
                            <span style={{ fontSize: 10, color: "var(--txt3)" }}>—</span>
                          ) : (
                            <button
                              onClick={() => aplicar(s)}
                              disabled={applyingSku === s.sku}
                              style={{
                                padding: "4px 8px",
                                fontSize: 11,
                                background: "var(--cyanBg)",
                                color: "var(--cyan)",
                                border: "1px solid var(--cyanBd)",
                                borderRadius: 4,
                                cursor: applyingSku === s.sku ? "wait" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                              title={`Aplicar ${fmtCLP(s.precio_propuesto)} con motivo=senal_pulsos_velocidad`}
                            >
                              {applyingSku === s.sku ? "..." : `Aplicar`}
                            </button>
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
  const [motivoTab, setMotivoTab] = useState<MotivoTab>("todos");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
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

  // Conteo por motivo (sobre el universo total, sin filtrar por estado).
  const motivoCounts: Record<string, number> = {};
  for (const r of data.seguimiento) {
    const k = r.motivo || "sin_motivo";
    motivoCounts[k] = (motivoCounts[k] ?? 0) + 1;
  }
  const motivoCountTodos = data.seguimiento.length;

  const filteredByMotivo = motivoTab === "todos"
    ? data.seguimiento
    : data.seguimiento.filter(r => (r.motivo || "sin_motivo") === motivoTab);
  const grouped = agruparPromoMasiva(filteredByMotivo);

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <>
      <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
        Cambios de precio en últimos {data.ventana_eval_dias}d. Lift evaluado a {data.ventana_lift_dias}d post-MD (Op_Limpieza KPI #4).
        <button onClick={onReload} disabled={loading}
          style={{ marginLeft: 12, padding: "3px 8px", border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt2)", borderRadius: 6, fontSize: 11, cursor: "pointer" }}>
          {loading ? "..." : "🔄"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
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

      {/* Filtros por motivo (taxonomía v95). Tab "todos" + uno por motivo presente. */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12, paddingBottom: 8, borderBottom: "1px solid var(--bg4)" }}>
        {(Object.keys(MOTIVO_TAB_META) as MotivoTab[])
          .filter(k => k === "todos" || (motivoCounts[k] ?? 0) > 0)
          .map(k => {
            const meta = MOTIVO_TAB_META[k];
            const n = k === "todos" ? motivoCountTodos : (motivoCounts[k] ?? 0);
            const isActive = motivoTab === k;
            return (
              <button key={k}
                onClick={() => setMotivoTab(k)}
                style={{
                  padding: "4px 8px",
                  border: isActive ? `1px solid ${meta.color}` : "1px solid var(--bg4)",
                  background: isActive ? "var(--bg3)" : "transparent",
                  color: isActive ? meta.color : "var(--txt2)",
                  borderRadius: 4, fontSize: 11, cursor: "pointer",
                }}>
                {meta.icon} {meta.label} <span style={{ opacity: 0.6 }}>({n})</span>
              </button>
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
                <th>Conf</th>
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
              {grouped.map((g, idx) => {
                if (g.kind === "group") {
                  const key = `grp-${g.motivo}-${g.promo_name}-${g.t0_min}`;
                  const isOpen = expandedGroups.has(key);
                  const motivoMeta = MOTIVO_TAB_META[g.motivo] ?? MOTIVO_TAB_META.sin_motivo;
                  const liftBuenos = g.rows.filter(r => r.lift != null && r.lift >= 1.5).length;
                  const sinLift = g.rows.filter(r => r.estado === "sin_lift").length;
                  const enEval = g.rows.filter(r => r.estado === "en_eval").length;
                  const alertas = g.rows.filter(r => r.alerta_stock_temprana).length;
                  return (
                    <>
                      <tr key={key} style={{ background: "var(--bg3)", cursor: "pointer" }} onClick={() => toggleGroup(key)}>
                        <td colSpan={15} style={{ padding: "8px 6px", fontSize: 12 }}>
                          <span style={{ display: "inline-block", marginRight: 8, color: motivoMeta.color, fontWeight: 600 }}>
                            {isOpen ? "▼" : "▶"} {motivoMeta.icon} {motivoMeta.label} · {g.promo_name}
                          </span>
                          <span style={{ color: "var(--txt2)" }}>
                            {g.rows.length} SKUs ·{" "}
                            {liftBuenos > 0 && <span style={{ color: "var(--green)" }}>{liftBuenos} con lift ≥1.5×</span>}
                            {liftBuenos > 0 && (sinLift > 0 || enEval > 0) && " · "}
                            {sinLift > 0 && <span style={{ color: "var(--red)" }}>{sinLift} sin lift</span>}
                            {sinLift > 0 && enEval > 0 && " · "}
                            {enEval > 0 && <span style={{ color: "var(--amber)" }}>{enEval} en eval</span>}
                            {alertas > 0 && <> · <span style={{ color: "var(--red)" }}>⚠️ {alertas} stock crítico</span></>}
                          </span>
                          <span style={{ float: "right", fontSize: 10, color: "var(--txt3)" }}>
                            {new Date(g.t0_min).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </td>
                      </tr>
                      {isOpen && g.rows.map(r => renderSeguimientoRow(r))}
                    </>
                  );
                }
                return renderSeguimientoRow(g.row, idx);
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function renderSeguimientoRow(r: SeguimientoRow, idx?: number) {
  const m = ESTADO_META[r.estado];
  return (
                  <tr key={r.sku + r.t0 + (idx ?? "")} style={r.alerta_stock_temprana ? { background: "var(--redBg)" } : undefined}>
                    <td>
                      <span style={{
                        display: "inline-block", padding: "2px 6px", borderRadius: 4, fontSize: 10,
                        background: m.bg, color: m.color, border: `1px solid ${m.bd}`,
                      }}>
                        {m.icon} {m.label}
                      </span>
                      {r.alerta_stock_temprana && (
                        <div style={{ fontSize: 9, color: "var(--red)", marginTop: 2, fontWeight: 600 }}>⚠️ stock</div>
                      )}
                    </td>
                    <td title={r.confianza_motivo} style={{ fontSize: 10 }}>
                      {(() => {
                        const c = CONFIANZA_META[r.confianza];
                        return <span style={{ color: c.color }}>{c.icon} {c.label}</span>;
                      })()}
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
}
