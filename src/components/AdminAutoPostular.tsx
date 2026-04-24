"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtCLP } from "@/lib/ml-shipping";

type Fila = {
  id: string;
  fecha: string;
  sku: string;
  item_id: string | null;
  promo_name: string | null;
  promo_type: string | null;
  decision: string;
  motivo: string;
  precio_objetivo: number | null;
  precio_actual: number | null;
  floor_calculado: number | null;
  margen_proyectado_pct: number | null;
  modo: string;
  contexto: Record<string, unknown> | null;
};

type Motivo = { tipo: string; count: number };

type RunData = {
  last_run: string | null;
  total: number;
  decisiones: { postular: number; skipear: number; error: number };
  motivos: Motivo[];
  filas: Fila[];
};

type DecisionFilter = "all" | "postular" | "skipear" | "error";

const MOTIVO_LABELS: Record<string, string> = {
  valle_muerte: "Valle de muerte ($19.990-$23.000)",
  sin_costo: "Sin costo registrado",
  bajo_floor: "Bajo floor económico",
  cobertura_baja: "Cobertura < 28 días",
  lightning_stock: "Stock fuera de 5-15 (LIGHTNING)",
  promo_rango: "Fuera de rango de promo",
  kvi_descuento_excesivo: "KVI con descuento >20%",
  politica_defender: "Política 'defender' con desc >10%",
  ok: "OK (postularía)",
};

const MOTIVO_COLORS: Record<string, string> = {
  valle_muerte: "var(--amber)",
  sin_costo: "var(--red)",
  bajo_floor: "var(--red)",
  cobertura_baja: "var(--amber)",
  lightning_stock: "var(--amber)",
  promo_rango: "var(--txt3)",
  kvi_descuento_excesivo: "var(--cyan)",
  politica_defender: "var(--cyan)",
  ok: "var(--green)",
};

export default function AdminAutoPostular() {
  const [data, setData] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filtroDecision, setFiltroDecision] = useState<DecisionFilter>("all");
  const [filtroMotivo, setFiltroMotivo] = useState<string>("all");
  const [filtroPromo, setFiltroPromo] = useState<string>("all");
  const [search, setSearch] = useState("");

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ml/auto-postular", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "fallo carga");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const correrDryRun = async () => {
    if (!confirm("Correr dry-run del motor sobre todos los items activos? (no modifica ML, solo loguea decisiones)")) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/ml/auto-postular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modo: "dry_run", scope: "all", limit: 1000 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "fallo run");
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown");
    } finally {
      setRunning(false);
    }
  };

  const promos = useMemo(() => {
    if (!data) return [];
    const s = new Set<string>();
    for (const f of data.filas) {
      const n = f.promo_name || f.promo_type;
      if (n) s.add(n);
    }
    return Array.from(s).sort();
  }, [data]);

  const filas = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.filas.filter(f => {
      const dec = f.decision.replace("dry_run_", "");
      if (filtroDecision !== "all" && dec !== filtroDecision) return false;
      if (filtroMotivo !== "all") {
        const tipo = f.motivo.split(":")[0]?.trim() || "otro";
        if (tipo !== filtroMotivo && !(filtroMotivo === "ok" && dec === "postular")) return false;
      }
      if (filtroPromo !== "all") {
        const n = f.promo_name || f.promo_type;
        if (n !== filtroPromo) return false;
      }
      if (q && !(f.sku.toLowerCase().includes(q) || (f.promo_name || "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [data, filtroDecision, filtroMotivo, filtroPromo, search]);

  // Agrupar por sku para render
  const grupos = useMemo(() => {
    const m = new Map<string, Fila[]>();
    for (const f of filas) {
      if (!m.has(f.sku)) m.set(f.sku, []);
      m.get(f.sku)!.push(f);
    }
    return Array.from(m.entries()).slice(0, 200); // cap para evitar renders enormes
  }, [filas]);

  const totalSkipear = data ? data.decisiones.skipear : 0;
  const pctOk = data && data.total > 0 ? Math.round((data.decisiones.postular / data.total) * 100) : 0;
  const lastRunAgo = data?.last_run ? timeAgo(data.last_run) : null;

  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--cyan)", marginBottom: 2 }}>🤖 Motor de postulación automática</div>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>
              {lastRunAgo
                ? `Último run: ${lastRunAgo} · ${data?.total || 0} decisiones · modo dry_run (no modifica ML)`
                : "Sin corridas aún. Dale al botón para generar el primer plan."}
            </div>
          </div>
          <button
            onClick={correrDryRun}
            disabled={running || loading}
            style={{
              padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyan)",
              cursor: running ? "wait" : "pointer", opacity: running ? 0.6 : 1,
            }}
          >{running ? "Procesando..." : "🚀 Correr dry-run"}</button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 10, marginBottom: 14, background: "var(--redBg)", color: "var(--red)", fontSize: 11, border: "1px solid var(--redBd)" }}>
          ⚠ {error}
        </div>
      )}

      {/* KPIs */}
      {data && data.total > 0 && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
            <Kpi label="Evaluados" value={String(data.total)} color="var(--txt2)" />
            <Kpi label="Postular ✅" value={String(data.decisiones.postular)} color="var(--green)" sub={`${pctOk}% del total`} />
            <Kpi label="Skipear ❌" value={String(data.decisiones.skipear)} color="var(--amber)" sub={`${100 - pctOk}% del total`} />
            <Kpi label="Errores" value={String(data.decisiones.error)} color={data.decisiones.error > 0 ? "var(--red)" : "var(--txt3)"} />
          </div>

          {/* Breakdown de motivos */}
          {totalSkipear > 0 && (
            <div className="card" style={{ padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: "var(--txt)" }}>
                Motivos de skipeo ({totalSkipear} casos)
              </div>
              {data.motivos.map(m => {
                const pct = (m.count / totalSkipear) * 100;
                return (
                  <div key={m.tipo} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginBottom: 6 }}>
                    <div style={{ flex: "0 0 180px", color: "var(--txt2)" }}>{MOTIVO_LABELS[m.tipo] || m.tipo}</div>
                    <div style={{ flex: 1, height: 14, background: "var(--bg3)", borderRadius: 4, overflow: "hidden", position: "relative" }}>
                      <div style={{
                        height: "100%", width: `${pct}%`,
                        background: MOTIVO_COLORS[m.tipo] || "var(--txt3)",
                        opacity: 0.8,
                        transition: "width 0.3s",
                      }} />
                    </div>
                    <div className="mono" style={{ flex: "0 0 80px", textAlign: "right", color: MOTIVO_COLORS[m.tipo] || "var(--txt2)" }}>
                      {m.count} ({pct.toFixed(0)}%)
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Filtros */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "center" }}>
            <select value={filtroDecision} onChange={e => setFiltroDecision(e.target.value as DecisionFilter)} className="form-input" style={{ flex: "0 0 auto" }}>
              <option value="all">Todas las decisiones</option>
              <option value="postular">Solo postular</option>
              <option value="skipear">Solo skipear</option>
              <option value="error">Solo error</option>
            </select>
            <select value={filtroMotivo} onChange={e => setFiltroMotivo(e.target.value)} className="form-input" style={{ flex: "0 0 auto" }}>
              <option value="all">Todos los motivos</option>
              {data.motivos.map(m => (
                <option key={m.tipo} value={m.tipo}>{MOTIVO_LABELS[m.tipo] || m.tipo} ({m.count})</option>
              ))}
            </select>
            <select value={filtroPromo} onChange={e => setFiltroPromo(e.target.value)} className="form-input" style={{ flex: "0 0 auto" }}>
              <option value="all">Todas las promos</option>
              {promos.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <input
              type="text"
              placeholder="Buscar SKU..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="form-input"
              style={{ flex: "1 1 200px", minWidth: 160 }}
            />
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>{filas.length} de {data.total}</div>
          </div>

          {/* Tabla agrupada por SKU */}
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {grupos.map(([sku, rows]) => (
              <GrupoSku key={sku} sku={sku} filas={rows} />
            ))}
            {grupos.length === 0 && (
              <div className="card" style={{ padding: 20, textAlign: "center", color: "var(--txt3)", fontSize: 11 }}>
                Sin resultados para los filtros actuales.
              </div>
            )}
          </div>
        </>
      )}

      {data && data.total === 0 && !loading && (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 13, color: "var(--txt2)", marginBottom: 4 }}>Sin corridas del motor aún</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Dale al botón "🚀 Correr dry-run" para generar el primer plan de postulación.</div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontSize: 9, textTransform: "uppercase", color: "var(--txt3)", marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function GrupoSku({ sku, filas }: { sku: string; filas: Fila[] }) {
  const titulo = (filas[0].contexto?.titulo as string) || "";
  const cuadrante = (filas[0].contexto?.cuadrante as string) || "";
  const coberturaDias = filas[0].contexto?.cobertura_dias as number | null | undefined;
  const stockTotal = filas[0].contexto?.stock_total as number | null | undefined;
  const esKvi = filas[0].contexto?.es_kvi as boolean | undefined;

  return (
    <div className="card" style={{ padding: 10, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--cyan)" }}>{sku}</span>
            {esKvi && <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)" }}>⭐ KVI</span>}
            {cuadrante && <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, background: "var(--bg4)", color: "var(--txt3)" }}>{cuadrante}</span>}
          </div>
          <div style={{ fontSize: 10, color: "var(--txt2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titulo}</div>
        </div>
        <div style={{ fontSize: 10, color: "var(--txt3)", textAlign: "right" }}>
          {typeof stockTotal === "number" && <div>stock {stockTotal}</div>}
          {typeof coberturaDias === "number" && <div>cob {coberturaDias.toFixed(0)}d</div>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {filas.map(f => {
          const dec = f.decision.replace("dry_run_", "");
          const color = dec === "postular" ? "var(--green)" : dec === "error" ? "var(--red)" : "var(--amber)";
          const icon = dec === "postular" ? "✅" : dec === "error" ? "❌" : "⚠";
          return (
            <div key={f.id} style={{ display: "flex", gap: 8, fontSize: 10, alignItems: "center", padding: "4px 0", borderTop: "1px dashed var(--bg4)" }}>
              <span style={{ flex: "0 0 20px" }}>{icon}</span>
              <span style={{ flex: "0 0 180px", color: "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.promo_name || f.promo_type}
              </span>
              <span className="mono" style={{ flex: "0 0 80px", textAlign: "right", color: "var(--txt2)" }}>
                {f.precio_objetivo != null ? fmtCLP(f.precio_objetivo) : "—"}
              </span>
              {f.margen_proyectado_pct != null && (
                <span className="mono" style={{ flex: "0 0 60px", textAlign: "right", color: f.margen_proyectado_pct >= 15 ? "var(--green)" : f.margen_proyectado_pct >= 0 ? "var(--amber)" : "var(--red)" }}>
                  {f.margen_proyectado_pct.toFixed(1)}%
                </span>
              )}
              <span style={{ flex: 1, color, fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.motivo}>
                {f.motivo}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "hace segundos";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} días`;
}
