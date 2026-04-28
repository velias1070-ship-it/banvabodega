"use client";
import { useEffect, useState } from "react";

/**
 * AdminMarkdownPilot — UI para correr markdown-auto en modo dry_run y
 * aplicar markdown a 1 SKU específico (piloto).
 *
 * Manual: BANVA_Pricing_Investigacion_Comparada:197 (90/120/180 + descuentos).
 *
 * Flujo:
 *  1. GET /api/pricing/markdown-auto?manual=1 → lista de candidatos
 *  2. User revisa precio actual, precio markdown, days sin venta, dec
 *  3. Click "Aplicar markdown a este SKU" → confirm() → POST con
 *     ?modo=apply&sku=X&confirm=1&manual=1
 *  4. Backend hace PUT a ML, persiste log, devuelve resultado
 *  5. UI muestra precio anterior → nuevo
 */

type Candidato = {
  sku: string;
  nombre: string;
  cuadrante: string | null;
  stock: number;
  ultima_venta: string;
  dias_sin_venta: number;
  nivel_markdown: number;
  precio_actual: number;
  precio_markdown: number;
  motivo: string;
  bloqueado_por: string[];
  decision: "candidato" | "skip";
};

type RuleSetMeta = {
  version_label: string;
  content_hash: string | null;
  channel: string | null;
  using_fallback: boolean;
};

type LadderNivel = { dias_min: number; descuento_pct: number };
type Ladder = { min_dias_para_postular: number; niveles: LadderNivel[] };

type DryRunResp = {
  modo: string;
  rule_set: RuleSetMeta;
  ladder_aplicado: Ladder;
  valle_muerte_aplicado: { min_clp: number; max_clp: number };
  duration_ms: number;
  stats: Record<string, number>;
  candidatos: Candidato[];
};

type ApplyResp = {
  modo: string;
  rule_set: RuleSetMeta;
  pilot_apply?: {
    sku: string;
    item_id: string;
    precio_anterior: number;
    precio_aplicado: number;
    precio_target: number;
    nivel_markdown: number;
    dias_sin_venta: number;
    ml_status: string;
  };
  candidato?: Candidato;
  error?: string;
  nota?: string;
};

const fmtCLP = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

export default function AdminMarkdownPilot() {
  const [data, setData] = useState<DryRunResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResp | null>(null);
  const [applyingSku, setApplyingSku] = useState<string | null>(null);
  const [showBlq, setShowBlq] = useState(false);

  async function loadDryRun() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/pricing/markdown-auto?manual=1", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setData(j);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDryRun();
  }, []);

  async function applyToSku(c: Candidato) {
    const confirmMsg = `Confirmar markdown:\n\n` +
      `SKU: ${c.sku}\n` +
      `${c.nombre}\n\n` +
      `Precio actual: ${fmtCLP(c.precio_actual)}\n` +
      `Precio nuevo:  ${fmtCLP(c.precio_markdown)} (${c.nivel_markdown}%)\n` +
      `Diferencia:    ${fmtCLP(c.precio_actual - c.precio_markdown)}\n\n` +
      `Días sin venta: ${c.dias_sin_venta}\n` +
      `Cuadrante: ${c.cuadrante || "—"}\n` +
      `Stock: ${c.stock}\n\n` +
      `Esto cambia el precio en ML directamente. ¿Continuar?`;
    if (!window.confirm(confirmMsg)) return;

    setApplyingSku(c.sku);
    setApplyResult(null);
    try {
      const url = `/api/pricing/markdown-auto?manual=1&modo=apply&sku=${encodeURIComponent(c.sku)}&confirm=1`;
      const r = await fetch(url, { method: "POST", cache: "no-store" });
      const j = (await r.json()) as ApplyResp;
      setApplyResult(j);
      if (r.ok && j.pilot_apply) {
        await loadDryRun();
      }
    } catch (e) {
      setApplyResult({ modo: "apply", rule_set: { version_label: "?", content_hash: null, channel: null, using_fallback: true }, error: String(e) });
    } finally {
      setApplyingSku(null);
    }
  }

  const rs = data?.rule_set;
  const ladder = data?.ladder_aplicado;
  const valle = data?.valle_muerte_aplicado;
  const cands = data?.candidatos ?? [];
  const ok = cands.filter(c => c.decision === "candidato");
  const blq = cands.filter(c => c.decision === "skip");

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--txt)" }}>🪙 Markdown automático — piloto SKU por SKU</h2>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>
            Aging del manual: <code style={{ color: "var(--cyan)" }}>Investigacion_Comparada:197</code>. Las reglas vienen del rule set activo (DB), no de constantes.
          </div>
        </div>
        <button
          className="scan-btn"
          style={{ padding: "6px 12px", fontSize: 12 }}
          onClick={loadDryRun}
          disabled={loading}
        >
          {loading ? "..." : "Refrescar"}
        </button>
      </div>

      {/* Rule set + ladder */}
      {rs && ladder && valle && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <div style={{ background: "var(--bg3)", padding: 10, borderRadius: 8, fontSize: 11 }}>
            <div style={{ color: "var(--txt3)", marginBottom: 4 }}>Rule set activo (production)</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              <span style={{ color: rs.using_fallback ? "var(--amber)" : "var(--cyan)" }}>{rs.version_label}</span>
              {rs.content_hash && <span style={{ color: "var(--txt3)", marginLeft: 8 }}>#{rs.content_hash}</span>}
            </div>
            <div style={{ marginTop: 6, color: "var(--txt2)" }}>
              Ladder:{" "}
              {ladder.niveles.map((n, i) => (
                <span key={i} style={{ marginRight: 8 }}>
                  ≥{n.dias_min}d → -{n.descuento_pct}%
                </span>
              ))}
            </div>
            <div style={{ color: "var(--txt2)", marginTop: 2 }}>
              Min postular: {ladder.min_dias_para_postular}d &nbsp; · &nbsp;
              Valle muerte: {fmtCLP(valle.min_clp)}-{fmtCLP(valle.max_clp)}
            </div>
          </div>
          <div style={{ background: "var(--bg3)", padding: 10, borderRadius: 8, fontSize: 11 }}>
            <div style={{ color: "var(--txt3)", marginBottom: 4 }}>Stats del último dry-run</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {data && Object.entries(data.stats).map(([k, v]) => (
                <span key={k}>
                  <span style={{ color: "var(--txt3)" }}>{k}:</span>{" "}
                  <span style={{ color: "var(--txt)", fontFamily: "var(--mono)" }}>{v}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Resultado del último apply */}
      {applyResult && (
        <div style={{
          marginBottom: 12,
          padding: 12,
          borderRadius: 8,
          background: applyResult.pilot_apply ? "var(--greenBg)" : "var(--redBg)",
          border: `1px solid ${applyResult.pilot_apply ? "var(--greenBd)" : "var(--redBd)"}`,
          fontSize: 12,
        }}>
          {applyResult.pilot_apply ? (
            <>
              <div style={{ fontWeight: 600, color: "var(--green)", marginBottom: 4 }}>
                ✓ Markdown aplicado a {applyResult.pilot_apply.sku}
              </div>
              <div style={{ color: "var(--txt)", fontFamily: "var(--mono)" }}>
                {fmtCLP(applyResult.pilot_apply.precio_anterior)} → {fmtCLP(applyResult.pilot_apply.precio_aplicado)}{" "}
                ({applyResult.pilot_apply.nivel_markdown}%, {applyResult.pilot_apply.dias_sin_venta}d sin venta)
              </div>
              <div style={{ color: "var(--txt2)", marginTop: 4 }}>
                ML status: {applyResult.pilot_apply.ml_status} · item: {applyResult.pilot_apply.item_id}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, color: "var(--red)", marginBottom: 4 }}>
                ✗ Apply falló
              </div>
              <div style={{ color: "var(--txt2)" }}>{applyResult.error || applyResult.nota || "sin detalle"}</div>
            </>
          )}
        </div>
      )}

      {error && (
        <div style={{ padding: 10, color: "var(--red)", fontSize: 12 }}>Error cargando: {error}</div>
      )}

      {!data && loading && <div style={{ padding: 16, color: "var(--txt3)", fontSize: 12 }}>Cargando…</div>}

      {data && cands.length === 0 && (
        <div style={{ padding: 16, fontSize: 12, color: "var(--txt2)", background: "var(--bg3)", borderRadius: 8 }}>
          No hay SKUs evaluables hoy. Esperar que acumulen días sin venta o ajustar <code>min_dias_para_postular</code> en el rule set.
        </div>
      )}

      {data && cands.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 8, fontSize: 12 }}>
            <span style={{ color: "var(--green)", fontWeight: 600 }}>✓ {ok.length} aplicables</span>
            <span style={{ color: "var(--txt3)" }}>·</span>
            <span style={{ color: "var(--amber)" }}>⚠ {blq.length} bloqueados</span>
          </div>

          {ok.length > 0 ? (
            <div style={{ overflowX: "auto", marginBottom: 16 }}>
              <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>SKU</th>
                    <th style={{ textAlign: "left" }}>Nombre</th>
                    <th>Cuad.</th>
                    <th>Stock</th>
                    <th>Días s/v</th>
                    <th>Nivel</th>
                    <th style={{ textAlign: "right" }}>Precio actual</th>
                    <th style={{ textAlign: "right" }}>Precio markdown</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {ok.map(c => (
                    <tr key={c.sku}>
                      <td style={{ fontFamily: "var(--mono)" }}>{c.sku}</td>
                      <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nombre}</td>
                      <td style={{ textAlign: "center" }}>{c.cuadrante || "—"}</td>
                      <td style={{ textAlign: "center" }}>{c.stock}</td>
                      <td style={{ textAlign: "center", color: c.dias_sin_venta >= 180 ? "var(--red)" : c.dias_sin_venta >= 120 ? "var(--amber)" : "var(--txt2)" }}>{c.dias_sin_venta}</td>
                      <td style={{ textAlign: "center", color: "var(--cyan)" }}>{c.nivel_markdown}%</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{fmtCLP(c.precio_actual)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--cyan)" }}>{fmtCLP(c.precio_markdown)}</td>
                      <td style={{ textAlign: "center" }}>
                        <button
                          className="scan-btn"
                          style={{ padding: "4px 10px", fontSize: 11 }}
                          onClick={() => applyToSku(c)}
                          disabled={applyingSku === c.sku}
                        >
                          {applyingSku === c.sku ? "..." : "Aplicar"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 12, fontSize: 12, color: "var(--txt2)", background: "var(--bg3)", borderRadius: 8, marginBottom: 12 }}>
              Sin candidatos aplicables hoy. {blq.length > 0 ? "Hay SKUs evaluados pero todos bloqueados — ver detalle abajo." : ""}
            </div>
          )}

          {blq.length > 0 && (
            <div>
              <button
                onClick={() => setShowBlq(s => !s)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--bg4)",
                  color: "var(--txt2)",
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 11,
                  cursor: "pointer",
                  marginBottom: 8,
                }}
              >
                {showBlq ? "▾" : "▸"} Bloqueados ({blq.length})
              </button>
              {showBlq && (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>SKU</th>
                        <th style={{ textAlign: "left" }}>Nombre</th>
                        <th>Cuad.</th>
                        <th>Stock</th>
                        <th>Días s/v</th>
                        <th>Nivel</th>
                        <th style={{ textAlign: "right" }}>Precio actual</th>
                        <th style={{ textAlign: "left" }}>Bloqueado por</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blq.map(c => (
                        <tr key={c.sku} style={{ opacity: 0.7 }}>
                          <td style={{ fontFamily: "var(--mono)" }}>{c.sku}</td>
                          <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.nombre}</td>
                          <td style={{ textAlign: "center" }}>{c.cuadrante || "—"}</td>
                          <td style={{ textAlign: "center" }}>{c.stock}</td>
                          <td style={{ textAlign: "center" }}>{c.dias_sin_venta}</td>
                          <td style={{ textAlign: "center", color: "var(--txt3)" }}>{c.nivel_markdown}%</td>
                          <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{fmtCLP(c.precio_actual)}</td>
                          <td style={{ fontSize: 10, color: "var(--amber)", maxWidth: 360 }}>{c.bloqueado_por.join(" · ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
