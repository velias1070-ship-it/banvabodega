"use client";
import { useCallback, useState } from "react";

type CacheRow = {
  item_id: string;
  sku: string;
  titulo: string | null;
  price_ml: number | null;
  precio_venta: number | null;
  tiene_promo: boolean;
  promo_name: string | null;
  promo_type: string | null;
  promo_pct: number | null;
  status_ml: string | null;
  comision_pct: number | null;
  envio_clp: number | null;
  margen_clp: number | null;
  margen_pct: number | null;
  synced_at: string;
};

type TimelineRow = {
  detected_at: string;
  precio_anterior: number | null;
  precio: number;
  delta_pct: number | null;
  promo_name: string | null;
  promo_pct: number | null;
  fuente: string;
  motivo: string | null;
  actor: string | null;
  evento_tag: string | null;
  evento_subtag: string | null;
};

type VentaRow = {
  order_id: string;
  fecha_date: string;
  sku_venta: string;
  cantidad: number;
  precio_unitario: number;
  promo_name_aplicada: string | null;
  promo_pct_aplicada: number | null;
  evento_tag?: string | null;
  evento_subtag?: string | null;
};

type EstadoAlDia = {
  fecha: string;
  precio: number | null;
  promo_name: string | null;
  promo_pct: number | null;
  fuente: string | null;
  desde: string | null;
  evento_tag?: string | null;
  evento_subtag?: string | null;
  costo?: number | null;
  fuente_costo?: string | null;
  margen_estimado?: number | null;
  margen_pct_estimado?: number | null;
  nota: string;
};

function eventoTagLabel(tag: string | null | undefined, subtag?: string | null): { label: string; color: string } | null {
  if (!tag) return null;
  const colors: Record<string, string> = {
    dia_madre: "var(--red)",
    dia_padre: "var(--blue)",
    navidad: "var(--green)",
    black_cyber: "var(--amber)",
    hot_sale: "var(--amber)",
    banva_periodica: "var(--cyan)",
    segmento_producto: "var(--cyan)",
    ml_campaign_raw: "var(--txt3)",
    otra: "var(--txt3)",
  };
  const labels: Record<string, string> = {
    dia_madre: "Día Madre",
    dia_padre: "Día Padre",
    navidad: "Navidad",
    black_cyber: "Black/Cyber",
    hot_sale: "Hot Sale",
    banva_periodica: "BANVA",
    segmento_producto: "Segmento",
    ml_campaign_raw: "ML Campaign",
    otra: "Otra",
  };
  const baseLabel = labels[tag] || tag;
  return {
    label: subtag ? `${baseLabel} ${subtag}` : baseLabel,
    color: colors[tag] || "var(--txt3)",
  };
}

type StateHistoryRow = {
  detected_at: string;
  item_id: string;
  campo: string;
  valor_anterior: string | null;
  valor_nuevo: string;
  fuente: string;
};

type ApiResp = {
  sku: string;
  producto: { sku: string; nombre: string | null; costo_promedio: number | null; precio_piso: number | null } | null;
  estado_actual_cache: CacheRow[];
  timeline: TimelineRow[];
  ventas: VentaRow[];
  estado_al_dia: EstadoAlDia | null;
  skus_venta_relacionados: string[];
  state_history: StateHistoryRow[];
};

function fmtCLP(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return sign + "$" + abs.toLocaleString("es-CL");
}

function fuenteLabel(f: string): { label: string; color: string } {
  if (f === "sync_diff") return { label: "auto-sync", color: "var(--txt2)" };
  if (f === "promo_join") return { label: "promo postulada", color: "var(--cyan)" };
  if (f === "item_update_api") return { label: "manual API", color: "var(--amber)" };
  if (f === "daily_snapshot") return { label: "snapshot diario", color: "var(--txt3)" };
  return { label: f, color: "var(--txt3)" };
}

export default function AdminSkuHistory() {
  const [skuInput, setSkuInput] = useState("");
  const [fechaInput, setFechaInput] = useState("");
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!skuInput.trim()) return;
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const params = new URLSearchParams({ sku: skuInput.trim() });
      if (fechaInput.trim()) params.set("fecha", fechaInput.trim());
      const r = await fetch(`/api/sku-history?${params}`);
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error || `Error ${r.status}`);
      } else {
        setData(j as ApiResp);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [skuInput, fechaInput]);

  const numStyle: React.CSSProperties = { fontFamily: "var(--font-mono, JetBrains Mono, monospace)" };

  return (
    <div style={{ padding: 16, maxWidth: 1200 }}>
      <h2 style={{ margin: 0, marginBottom: 4 }}>Histórico de SKU</h2>
      <div style={{ color: "var(--txt3)", fontSize: 13, marginBottom: 16 }}>
        Timeline completa de cambios de precio + promo + ventas para un SKU origen. Opcionalmente reconstruye el estado al cierre de un día específico.
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 10, alignItems: "end" }}>
          <div>
            <div className="form-label" style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>SKU</div>
            <input
              className="form-input"
              placeholder="Ej: TXMTFIL1315RS"
              value={skuInput}
              onChange={e => setSkuInput(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === "Enter") fetchData(); }}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <div className="form-label" style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>Estado al día (opcional)</div>
            <input
              type="date"
              className="form-input"
              value={fechaInput}
              onChange={e => setFechaInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") fetchData(); }}
              style={{ width: "100%" }}
            />
          </div>
          <button
            onClick={fetchData}
            disabled={loading || !skuInput.trim()}
            className="scan-btn blue"
            style={{ padding: "10px 18px", fontSize: 13, opacity: loading || !skuInput.trim() ? 0.6 : 1 }}
          >
            {loading ? "Buscando..." : "Buscar"}
          </button>
        </div>
        {err && <div style={{ marginTop: 10, padding: 8, background: "var(--redBg)", color: "var(--red)", borderRadius: 6, fontSize: 12 }}>{err}</div>}
      </div>

      {data && (
        <>
          {data.producto && (
            <div className="card" style={{ padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{data.producto.nombre || data.producto.sku}</div>
              <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 12, color: "var(--txt3)" }}>
                <span>SKU: <span className="mono" style={{ color: "var(--txt)" }}>{data.producto.sku}</span></span>
                <span>Costo prom: <span style={numStyle}>{fmtCLP(data.producto.costo_promedio)}</span></span>
                <span>Precio piso: <span style={numStyle}>{fmtCLP(data.producto.precio_piso)}</span></span>
                {data.skus_venta_relacionados.length > 1 && (
                  <span>Sku venta: {data.skus_venta_relacionados.join(", ")}</span>
                )}
              </div>
            </div>
          )}

          {data.estado_al_dia && (
            <div className="card" style={{ padding: 14, marginBottom: 14, background: "var(--cyanBg)", border: "1px solid var(--cyanBd)" }}>
              <div style={{ fontSize: 11, color: "var(--cyan)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Estado al cierre del {data.estado_al_dia.fecha}
              </div>
              {data.estado_al_dia.precio !== null ? (
                <>
                  <div style={{ display: "flex", gap: 24, marginTop: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>Precio</div>
                      <div style={{ ...numStyle, fontSize: 22, fontWeight: 700 }}>{fmtCLP(data.estado_al_dia.precio)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>Promo</div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{data.estado_al_dia.promo_name || "(sin promo)"} {data.estado_al_dia.promo_pct ? `(${data.estado_al_dia.promo_pct}%)` : ""}</div>
                    </div>
                    {data.estado_al_dia.evento_tag && (() => {
                      const ev = eventoTagLabel(data.estado_al_dia.evento_tag, data.estado_al_dia.evento_subtag);
                      return ev ? (
                        <div>
                          <div style={{ fontSize: 10, color: "var(--txt3)" }}>Evento</div>
                          <div style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "var(--bg3)", color: ev.color, display: "inline-block", fontWeight: 600 }}>{ev.label}</div>
                        </div>
                      ) : null;
                    })()}
                    <div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>Fuente</div>
                      <div style={{ fontSize: 12, color: fuenteLabel(data.estado_al_dia.fuente || "").color }}>{fuenteLabel(data.estado_al_dia.fuente || "").label}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--txt3)" }}>Desde</div>
                      <div style={{ fontSize: 12 }}>{data.estado_al_dia.desde ? new Date(data.estado_al_dia.desde).toLocaleString("es-CL") : "—"}</div>
                    </div>
                    {data.estado_al_dia.costo !== null && data.estado_al_dia.costo !== undefined && (
                      <div>
                        <div style={{ fontSize: 10, color: "var(--txt3)" }}>Costo a la fecha</div>
                        <div style={{ ...numStyle, fontSize: 14 }}>{fmtCLP(data.estado_al_dia.costo)}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)" }}>{data.estado_al_dia.fuente_costo}</div>
                      </div>
                    )}
                    {data.estado_al_dia.margen_pct_estimado !== null && data.estado_al_dia.margen_pct_estimado !== undefined && (
                      <div>
                        <div style={{ fontSize: 10, color: "var(--txt3)" }}>Margen bruto est.</div>
                        <div style={{ ...numStyle, fontSize: 14, color: data.estado_al_dia.margen_pct_estimado < 0 ? "var(--red)" : "var(--green)" }}>
                          {fmtCLP(data.estado_al_dia.margen_estimado)} ({data.estado_al_dia.margen_pct_estimado.toFixed(1)}%)
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 8, fontStyle: "italic" }}>{data.estado_al_dia.nota} (margen bruto = precio - costo, sin descontar comisión/envío)</div>
                </>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--amber)" }}>{data.estado_al_dia.nota}</div>
              )}
            </div>
          )}

          {data.estado_actual_cache.length > 0 && (
            <div className="card" style={{ padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Estado actual (ml_margin_cache)</div>
              <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>item_id</th>
                    <th style={{ textAlign: "right" }}>Precio lista</th>
                    <th style={{ textAlign: "right" }}>Precio venta</th>
                    <th style={{ textAlign: "left" }}>Promo</th>
                    <th style={{ textAlign: "left" }}>Status</th>
                    <th style={{ textAlign: "right" }}>Margen %</th>
                    <th style={{ textAlign: "left" }}>Synced</th>
                  </tr>
                </thead>
                <tbody>
                  {data.estado_actual_cache.map(r => (
                    <tr key={r.item_id}>
                      <td className="mono" style={{ fontWeight: 600 }}>{r.item_id}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{fmtCLP(r.price_ml)}</td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: r.tiene_promo ? 600 : undefined }}>{fmtCLP(r.precio_venta)}</td>
                      <td>{r.tiene_promo ? <span style={{ color: "var(--cyan)" }}>{r.promo_name} {r.promo_pct ? `(${r.promo_pct}%)` : ""}</span> : <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                      <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: r.status_ml === "active" ? "var(--greenBg)" : "var(--bg3)", color: r.status_ml === "active" ? "var(--green)" : "var(--txt3)" }}>{r.status_ml}</span></td>
                      <td className="mono" style={{ textAlign: "right" }}>{r.margen_pct?.toFixed(1)}%</td>
                      <td style={{ fontSize: 11, color: "var(--txt3)" }}>{new Date(r.synced_at).toLocaleString("es-CL")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
              Timeline de cambios — {data.timeline.length} eventos
            </div>
            {data.timeline.length === 0 ? (
              <div style={{ color: "var(--txt3)", fontSize: 12, padding: 12, textAlign: "center" }}>
                Sin cambios capturados. El cron arrancó alrededor del 27-abr-2026.
              </div>
            ) : (
              <div style={{ maxHeight: 500, overflowY: "auto" }}>
                <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg2)" }}>
                    <tr>
                      <th style={{ textAlign: "left" }}>Cuándo</th>
                      <th style={{ textAlign: "right" }}>Precio anterior</th>
                      <th style={{ textAlign: "right" }}>Precio</th>
                      <th style={{ textAlign: "right" }}>Δ %</th>
                      <th style={{ textAlign: "left" }}>Promo</th>
                      <th style={{ textAlign: "left" }}>Evento</th>
                      <th style={{ textAlign: "left" }}>Fuente</th>
                      <th style={{ textAlign: "left" }}>Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeline.map((r, i) => {
                      const f = fuenteLabel(r.fuente);
                      const ev = eventoTagLabel(r.evento_tag, r.evento_subtag);
                      return (
                        <tr key={i} style={r.fuente === "daily_snapshot" ? { background: "var(--bg3)", color: "var(--txt3)" } : undefined}>
                          <td style={{ fontSize: 11 }}>{new Date(r.detected_at).toLocaleString("es-CL")}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{fmtCLP(r.precio_anterior)}</td>
                          <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtCLP(r.precio)}</td>
                          <td className="mono" style={{ textAlign: "right", color: r.delta_pct && r.delta_pct < 0 ? "var(--green)" : r.delta_pct && r.delta_pct > 0 ? "var(--amber)" : undefined }}>
                            {r.delta_pct ? `${r.delta_pct > 0 ? "+" : ""}${Number(r.delta_pct).toFixed(1)}%` : "—"}
                          </td>
                          <td>{r.promo_name || <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                          <td>{ev ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: ev.color, fontWeight: 600 }}>{ev.label}</span> : <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                          <td><span style={{ color: f.color, fontSize: 11 }}>{f.label}</span></td>
                          <td style={{ fontSize: 11, color: "var(--txt3)" }}>{r.motivo || "—"} {r.actor ? `· ${r.actor}` : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.state_history.length > 0 && (
            <div className="card" style={{ padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                Cambios de estado — {data.state_history.length} eventos (status_ml, listing_type, etc)
              </div>
              <div style={{ maxHeight: 240, overflowY: "auto" }}>
                <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Cuándo</th>
                      <th style={{ textAlign: "left" }}>Item</th>
                      <th style={{ textAlign: "left" }}>Campo</th>
                      <th style={{ textAlign: "left" }}>Antes</th>
                      <th style={{ textAlign: "left" }}>Después</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.state_history.map((s, i) => (
                      <tr key={i}>
                        <td style={{ fontSize: 11 }}>{new Date(s.detected_at).toLocaleString("es-CL")}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{s.item_id}</td>
                        <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)" }}>{s.campo}</span></td>
                        <td className="mono" style={{ color: "var(--txt3)" }}>{s.valor_anterior || "—"}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{s.valor_nuevo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 14 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
              Ventas — {data.ventas.length} órdenes
            </div>
            {data.ventas.length === 0 ? (
              <div style={{ color: "var(--txt3)", fontSize: 12, padding: 12, textAlign: "center" }}>Sin ventas registradas en ventas_ml_cache para este SKU.</div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                <table className="tbl" style={{ width: "100%", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg2)" }}>
                    <tr>
                      <th style={{ textAlign: "left" }}>Fecha</th>
                      <th style={{ textAlign: "left" }}>Order ID</th>
                      <th style={{ textAlign: "left" }}>SKU venta</th>
                      <th style={{ textAlign: "right" }}>Uds</th>
                      <th style={{ textAlign: "right" }}>Precio unit</th>
                      <th style={{ textAlign: "left" }}>Promo aplicada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ventas.map((v) => {
                      const ev = eventoTagLabel(v.evento_tag, v.evento_subtag);
                      return (
                        <tr key={v.order_id + v.sku_venta}>
                          <td style={{ fontSize: 11 }}>{v.fecha_date}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{v.order_id}</td>
                          <td className="mono">{v.sku_venta}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{v.cantidad}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{fmtCLP(v.precio_unitario)}</td>
                          <td>
                            {v.promo_name_aplicada ? (
                              <span style={{ color: "var(--cyan)" }}>{v.promo_name_aplicada} {v.promo_pct_aplicada ? `(${v.promo_pct_aplicada}%)` : ""}</span>
                            ) : (
                              <span style={{ color: "var(--txt3)" }}>(no capturada — pre-v108)</span>
                            )}
                            {ev && <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "var(--bg3)", color: ev.color, fontWeight: 600 }}>{ev.label}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
