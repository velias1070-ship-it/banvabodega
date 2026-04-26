"use client";

import { useEffect, useState } from "react";

/**
 * Dashboard de auto-postulación: visibilidad de las decisiones del cron
 * sin queries SQL. Manual: BANVA_Pricing_Investigacion_Comparada §6.1
 * (operación humana en el loop = revisar log diario antes de escalar).
 */

type Stats = { postular: number; skipear: number; error: number; baseline_warming: number; otras: number };
type Motivo = { tipo: string; count: number };
type DiaHist = { dia: string; postular: number; skipear: number; error: number; baseline_warming: number; total: number };
type Decision = {
  fecha: string; sku: string; promo_name: string | null; promo_type: string | null;
  decision: string; motivo: string;
  precio_objetivo: number | null; precio_actual: number | null; floor: number | null;
  margen_pct: number | null; modo: string;
};

type Summary = {
  last_run: string | null;
  stats_24h: Stats;
  top_motivos: Motivo[];
  historico_7d: DiaHist[];
  recientes: Decision[];
  skus_auto_postular: number;
};

const MOTIVO_LABELS: Record<string, string> = {
  degrada_vitrina: "Degrada vitrina (tier candidata ≤ activa)",
  promo_lejana: "Promo arranca en >14 días",
  promo_casi_vencida: "Promo termina en <24h",
  promo_vencida: "Promo ya terminó",
  promo_misma: "Ya está en esa misma promo",
  bajo_floor: "Precio bajo el piso de margen",
  valle_muerte: "Precio en valle muerte $19.990–$23.000",
  descuento_max_cuadrante: "Descuento > máximo del cuadrante",
  cooldown: "Cooldown anti race-to-the-bottom",
  sin_costo: "Sin costo configurado",
  lightning_stock: "Stock fuera de rango LIGHTNING (5–15)",
  promo_rango: "Precio fuera del rango de la promo",
  kvi_descuento_excesivo: "KVI con descuento >20%",
  politica_defender: "Política defender no acepta >10% off",
};

export default function AdminAutoPostularDashboard() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/pricing/auto-postular-summary").then(r => r.json());
      setData(r);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const dispararManual = async () => {
    if (!confirm("Disparar cron auto-postular ahora? Solo procesa SKUs con auto_postular=true.")) return;
    setRunning(true);
    try {
      const r = await fetch("/api/ml/auto-postular/cron?manual=1&limit=50");
      const j = await r.json();
      alert(`Corrida OK\n${JSON.stringify(j.result?.decisiones || j, null, 2)}`);
      await load();
    } catch (e) {
      alert("Error: " + String(e));
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div style={{ padding: 20, color: "var(--txt2)" }}>Cargando dashboard…</div>;
  if (!data) return <div style={{ padding: 20, color: "var(--red)" }}>No se pudo cargar</div>;

  const lastRunStr = data.last_run
    ? new Date(data.last_run).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" })
    : "—";
  const minutosDesde = data.last_run
    ? Math.round((Date.now() - new Date(data.last_run).getTime()) / 60000)
    : null;

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--txt)" }}>🤖 Motor auto-postulación</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>
            Cron cada 4h (10/14/18/22). Solo procesa los <b>{data.skus_auto_postular}</b> SKUs con <code style={{ color: "var(--cyan)" }}>auto_postular=true</code>.
          </div>
        </div>
        <button
          onClick={dispararManual}
          disabled={running}
          style={{
            padding: "8px 16px",
            background: "var(--cyanBg)",
            border: "1px solid var(--cyanBd)",
            color: "var(--cyan)",
            borderRadius: 6,
            cursor: running ? "wait" : "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {running ? "Ejecutando…" : "▶ Disparar manual"}
        </button>
      </div>

      {/* KPIs 24h */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
        <Kpi label="Última corrida" value={lastRunStr} sub={minutosDesde != null ? `hace ${minutosDesde}min` : ""} />
        <Kpi label="Postuladas 24h" value={data.stats_24h.postular} color="var(--green)" />
        <Kpi label="Skipeadas 24h" value={data.stats_24h.skipear} color="var(--amber)" />
        <Kpi label="Errores 24h" value={data.stats_24h.error} color="var(--red)" />
        <Kpi label="Baseline 24h" value={data.stats_24h.baseline_warming} color="var(--txt3)" sub="recálculo de pisos" />
      </div>

      {/* Top motivos de skip */}
      {data.top_motivos.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--txt2)" }}>
            Motivos de skip más frecuentes (24h)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.top_motivos.map(m => {
              const max = data.top_motivos[0]?.count || 1;
              const pct = (m.count / max) * 100;
              return (
                <div key={m.tipo} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <div style={{ width: 220, color: "var(--txt2)" }}>{MOTIVO_LABELS[m.tipo] || m.tipo}</div>
                  <div style={{ flex: 1, background: "var(--bg3)", borderRadius: 4, height: 16, position: "relative" }}>
                    <div style={{
                      position: "absolute",
                      left: 0, top: 0, bottom: 0,
                      width: `${pct}%`,
                      background: "var(--amber)",
                      opacity: 0.6,
                      borderRadius: 4,
                    }} />
                  </div>
                  <div style={{ width: 40, textAlign: "right", color: "var(--txt)", fontWeight: 600 }}>{m.count}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Histórico 7d */}
      {data.historico_7d.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--txt2)" }}>
            Histórico últimos 7 días
          </div>
          <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Día</th>
                <th style={{ textAlign: "right", color: "var(--green)" }}>Postuladas</th>
                <th style={{ textAlign: "right", color: "var(--amber)" }}>Skipeadas</th>
                <th style={{ textAlign: "right", color: "var(--red)" }}>Errores</th>
                <th style={{ textAlign: "right", color: "var(--txt3)" }}>Baseline</th>
                <th style={{ textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.historico_7d.map(d => (
                <tr key={d.dia}>
                  <td>{d.dia}</td>
                  <td style={{ textAlign: "right", color: "var(--green)" }}>{d.postular}</td>
                  <td style={{ textAlign: "right", color: "var(--amber)" }}>{d.skipear}</td>
                  <td style={{ textAlign: "right", color: "var(--red)" }}>{d.error}</td>
                  <td style={{ textAlign: "right", color: "var(--txt3)" }}>{d.baseline_warming}</td>
                  <td style={{ textAlign: "right", fontWeight: 600 }}>{d.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Últimas decisiones */}
      {data.recientes.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--txt2)" }}>
            Últimas {data.recientes.length} decisiones (postular/skipear)
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Hora</th>
                  <th style={{ textAlign: "left" }}>SKU</th>
                  <th style={{ textAlign: "left" }}>Promo</th>
                  <th style={{ textAlign: "left" }}>Decisión</th>
                  <th style={{ textAlign: "right" }}>Precio obj</th>
                  <th style={{ textAlign: "right" }}>Piso</th>
                  <th style={{ textAlign: "right" }}>Margen%</th>
                  <th style={{ textAlign: "left" }}>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {data.recientes.map((r, i) => {
                  const decClean = r.decision.replace("dry_run_", "");
                  const color = decClean === "postular" ? "var(--green)" : decClean === "error" ? "var(--red)" : "var(--amber)";
                  return (
                    <tr key={i}>
                      <td style={{ color: "var(--txt3)" }}>{new Date(r.fecha).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="mono">{r.sku}</td>
                      <td>{r.promo_name || r.promo_type || "—"}</td>
                      <td style={{ color, fontWeight: 600 }}>{decClean}</td>
                      <td style={{ textAlign: "right" }} className="mono">${(r.precio_objetivo || 0).toLocaleString("es-CL")}</td>
                      <td style={{ textAlign: "right", color: "var(--txt3)" }} className="mono">${(r.floor || 0).toLocaleString("es-CL")}</td>
                      <td style={{ textAlign: "right" }} className="mono">{r.margen_pct != null ? `${r.margen_pct}%` : "—"}</td>
                      <td style={{ color: "var(--txt3)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{r.motivo}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div style={{ background: "var(--bg3)", borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "var(--txt)", marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
