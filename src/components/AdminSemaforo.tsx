"use client";
import { useState, useEffect, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

// ============ TYPES ============

interface SemaforoRow {
  sku_origen: string;
  nombre: string | null;
  item_id: string | null;
  thumbnail: string | null;
  permalink: string | null;
  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  vel_ponderada: number;
  stock_total: number;
  stock_full: number;
  stock_bodega: number;
  cob_total: number;
  cob_full: number;
  dias_sin_venta: number;
  margen_full_30d: number;
  margen_flex_30d: number;
  cuadrante: string | null;
  precio_actual: number;
  costo_promedio: number;
  cantidad_publicaciones_ml: number;
  cubeta: string;
  antiguedad_muerto_bucket: string | null;
  impacto_clp: number;
  es_holdout: boolean;
  precio_markdown_sugerido: number | null;
  markdown_motivo: string | null;
  // Bridge intelligence (v65)
  accion: string | null;
  alertas: string[] | null;
  dias_sin_stock_full: number | null;
  venta_perdida_pesos: number;
  ingreso_perdido: number;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number | null;
  factor_rampup_aplicado: number;
  rampup_motivo: string | null;
  vel_pre_quiebre: number;
  dias_en_quiebre: number;
  abc_ingreso: string | null;
  tendencia_vel: string | null;
  tendencia_vel_pct: number;
  semana_calculo: string;
  ya_revisado?: boolean;
  persistente?: boolean;
  revision?: { causa: string; accion: string; revisado_at: string } | null;
}

interface CubetaSummary {
  count: number;
  impacto_total: number;
  revisados: number;
  pendientes: number;
}

interface CurrentData {
  semana: string;
  total_skus: number;
  cubetas: Record<string, CubetaSummary>;
  kpis: {
    unidades_semana: number | null;
    revenue_semana: number | null;
    delta_unidades_pct: number | null;
    delta_revenue_pct: number | null;
  };
}

interface HistorialEntry {
  id: string;
  semana: string;
  cubeta: string;
  causa_identificada: string;
  accion_tomada: string;
  causa_detalle: string | null;
  accion_detalle: string | null;
  revisado_por: string;
  revisado_at: string;
}

// ============ CONSTANTS ============

const CUBETA_CONFIG: Record<string, { label: string; icon: string; color: string; order: number }> = {
  cayo: { label: "Cayeron", icon: "🔴", color: "var(--red)", order: 1 },
  quiebre_inminente: { label: "Quiebre inminente", icon: "🔵", color: "var(--blue)", order: 2 },
  ya_quebrado: { label: "Ya quebrado", icon: "⚫", color: "#888", order: 3 },
  despegando: { label: "Despegando", icon: "🟢", color: "var(--green)", order: 4 },
  estancado: { label: "Estancado", icon: "🟡", color: "var(--amber)", order: 5 },
  muerto: { label: "Muerto", icon: "💀", color: "#666", order: 6 },
};

// Cuadrante ABC-XYZ — prioridad operativa segun los manuales (BANVA P2 §2.4)
// Dentro de una cubeta los ESTRELLA se revisan primero, REVISAR al ultimo.
const CUADRANTE_CONFIG: Record<string, { label: string; icon: string; color: string; priority: number }> = {
  ESTRELLA:  { label: "Estrella",  icon: "⭐", color: "var(--amber)", priority: 1 },
  VOLUMEN:   { label: "Volumen",   icon: "📦", color: "var(--cyan)",  priority: 2 },
  CASHCOW:   { label: "Cash Cow",  icon: "🐮", color: "var(--green)", priority: 3 },
  REVISAR:   { label: "Revisar",   icon: "🔍", color: "var(--txt3)",  priority: 4 },
};

const CAUSAS: Record<string, string> = {
  precio_propio_alto: "Precio propio alto",
  precio_competencia_bajo: "Competencia bajo precio",
  foto_o_titulo_debil: "Foto o titulo debil",
  stock_quiebre_o_full_vacio: "Quiebre / Full vacio",
  salio_de_campana: "Salio de campana",
  estacionalidad: "Estacionalidad",
  cambio_algoritmo_ml: "Cambio algoritmo ML",
  calidad_listado_basica: "Calidad de listado basica",
  producto_descontinuado: "Producto descontinuado",
  otro: "Otro",
  no_identificada: "No identificada",
};

const ACCIONES: Record<string, string> = {
  bajar_precio: "Bajar precio",
  subir_precio: "Subir precio",
  postular_campana: "Postular a campana",
  mejorar_foto: "Mejorar foto",
  mejorar_titulo: "Mejorar titulo",
  reposicion_urgente: "Reposicion urgente",
  pausar_publicacion: "Pausar publicacion",
  liquidar: "Liquidar",
  descontinuar: "Descontinuar",
  aumentar_ads: "Aumentar ads",
  reducir_ads: "Reducir ads",
  sin_accion_monitorear: "Sin accion, monitorear",
  otro: "Otro",
};

const fmt = (n: number) => n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`;
const fmtPct = (n: number | null) => n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

// ============ COMPONENT ============

export default function AdminSemaforo() {
  const [current, setCurrent] = useState<CurrentData | null>(null);
  const [selectedCubeta, setSelectedCubeta] = useState<string | null>(null);
  const [items, setItems] = useState<SemaforoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showRevisados, setShowRevisados] = useState(false);
  const [reviewModal, setReviewModal] = useState<SemaforoRow | null>(null);
  const [historial, setHistorial] = useState<HistorialEntry[]>([]);
  const [muertoExpanded, setMuertoExpanded] = useState(false);
  const [muertoFilter, setMuertoFilter] = useState<string | null>(null);
  const [cuadranteFilter, setCuadranteFilter] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Review form state
  const [causa, setCausa] = useState("no_identificada");
  const [causaDetalle, setCausaDetalle] = useState("");
  const [accion, setAccion] = useState("sin_accion_monitorear");
  const [accionDetalle, setAccionDetalle] = useState("");
  const [saving, setSaving] = useState(false);

  const loadCurrent = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/semaforo/current?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) setCurrent(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const loadCubeta = useCallback(async (nombre: string) => {
    setLoadingItems(true);
    try {
      const res = await fetch(`/api/semaforo/cubeta/${nombre}?incluir_revisados=${showRevisados}&t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch { /* ignore */ }
    setLoadingItems(false);
  }, [showRevisados]);

  const loadHistorial = useCallback(async (sku: string) => {
    try {
      const res = await fetch(`/api/semaforo/historial/${encodeURIComponent(sku)}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setHistorial(data.revisiones || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadCurrent(); }, [loadCurrent]);
  useEffect(() => { if (selectedCubeta) loadCubeta(selectedCubeta); }, [selectedCubeta, loadCubeta]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/semaforo/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manual: true }), cache: "no-store" });
      await loadCurrent();
      if (selectedCubeta) await loadCubeta(selectedCubeta);
    } catch { /* ignore */ }
    setRefreshing(false);
  };

  const openReview = (row: SemaforoRow) => {
    setReviewModal(row);
    setCausa("no_identificada");
    setCausaDetalle("");
    setAccion("sin_accion_monitorear");
    setAccionDetalle("");
    loadHistorial(row.sku_origen);
  };

  const saveReview = async () => {
    if (!reviewModal) return;
    setSaving(true);
    try {
      const res = await fetch("/api/semaforo/revisar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku_origen: reviewModal.sku_origen,
          causa_identificada: causa,
          causa_detalle: causaDetalle || null,
          accion_tomada: accion,
          accion_detalle: accionDetalle || null,
          revisado_por: "vicente",
        }),
      });
      if (res.ok) {
        setReviewModal(null);
        if (selectedCubeta) loadCubeta(selectedCubeta);
        loadCurrent();
      }
    } catch { /* ignore */ }
    setSaving(false);
  };

  if (loading) return <div className="card" style={{ textAlign: "center", padding: 40 }}>Cargando semaforo...</div>;

  if (!current) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 40 }}>
        <p style={{ marginBottom: 16, color: "var(--txt2)" }}>El semaforo no ha sido ejecutado aun.</p>
        <button onClick={handleRefresh} disabled={refreshing} style={{ padding: "12px 24px", borderRadius: 8, background: "var(--cyan)", color: "#fff", fontWeight: 700, fontSize: 14 }}>
          {refreshing ? "Calculando..." : "Ejecutar ahora"}
        </button>
      </div>
    );
  }

  const cubetaOrder = ["cayo", "quiebre_inminente", "ya_quebrado", "despegando", "estancado", "muerto"];
  const semanaNum = getISOWeek(current.semana);

  // Items to show for muerto cubeta (filter by antiguedad + cuadrante)
  const baseFiltered = items.filter(i => {
    if (cuadranteFilter && i.cuadrante !== cuadranteFilter) return false;
    return true;
  });
  const muertoItems = selectedCubeta === "muerto"
    ? baseFiltered.filter(i => !muertoFilter || i.antiguedad_muerto_bucket === muertoFilter)
    : baseFiltered;
  // Ordenar: primero por prioridad de cuadrante (ESTRELLA arriba), luego por impacto desc
  const sortedItems = [...muertoItems].sort((a, b) => {
    const pa = CUADRANTE_CONFIG[a.cuadrante || "REVISAR"]?.priority ?? 99;
    const pb = CUADRANTE_CONFIG[b.cuadrante || "REVISAR"]?.priority ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.impacto_clp || 0) - (a.impacto_clp || 0);
  });
  const displayItems = selectedCubeta === "muerto" && !muertoExpanded
    ? sortedItems.slice(0, 20)
    : sortedItems;

  return (
    <div>
      {/* Header */}
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Semaforo BANVA — Semana {semanaNum}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>{formatSemanaRange(current.semana)}</div>
        </div>
        <button onClick={handleRefresh} disabled={refreshing} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--cyan)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)" }}>
          {refreshing ? "..." : "Refresh"}
        </button>
      </div>

      {/* Cubeta Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginTop: 8 }}>
        {cubetaOrder.map(c => {
          const cfg = CUBETA_CONFIG[c];
          const data = current.cubetas[c];
          if (!cfg || !data) return null;
          const isSelected = selectedCubeta === c;
          return (
            <div key={c} onClick={() => setSelectedCubeta(isSelected ? null : c)} className="card" style={{ cursor: "pointer", textAlign: "center", padding: "12px 8px", border: isSelected ? `2px solid ${cfg.color}` : "1px solid var(--bg4)", transition: "border 0.15s" }}>
              <div style={{ fontSize: 24 }}>{cfg.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: cfg.color }}>{data.count}</div>
              <div style={{ fontSize: 10, color: "var(--txt2)", fontWeight: 600 }}>{cfg.label}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>{fmt(data.impacto_total)}</div>
              {data.pendientes > 0 && (
                <div style={{ fontSize: 9, color: cfg.color, marginTop: 2 }}>{data.pendientes} pendientes</div>
              )}
            </div>
          );
        })}
      </div>

      {/* KPIs */}
      <div className="card" style={{ display: "flex", gap: 24, marginTop: 8 }}>
        <div>
          <span style={{ fontSize: 11, color: "var(--txt3)" }}>Unidades semana: </span>
          <span className="mono" style={{ fontWeight: 700 }}>{current.kpis.unidades_semana ?? "—"}</span>
          <span style={{ fontSize: 11, color: (current.kpis.delta_unidades_pct ?? 0) < 0 ? "var(--red)" : "var(--green)", marginLeft: 6 }}>{fmtPct(current.kpis.delta_unidades_pct)}</span>
        </div>
        <div>
          <span style={{ fontSize: 11, color: "var(--txt3)" }}>Revenue semana: </span>
          <span className="mono" style={{ fontWeight: 700 }}>{current.kpis.revenue_semana ? fmt(current.kpis.revenue_semana) : "—"}</span>
          <span style={{ fontSize: 11, color: (current.kpis.delta_revenue_pct ?? 0) < 0 ? "var(--red)" : "var(--green)", marginLeft: 6 }}>{fmtPct(current.kpis.delta_revenue_pct)}</span>
        </div>
      </div>

      {/* Selected cubeta items */}
      {selectedCubeta && (
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {CUBETA_CONFIG[selectedCubeta]?.icon} {CUBETA_CONFIG[selectedCubeta]?.label} ({current.cubetas[selectedCubeta]?.count || 0})
              </div>
              {/* Breakdown por cuadrante — muestra urgencia diferenciada */}
              {items.length > 0 && (
                <div style={{ display: "flex", gap: 10, marginTop: 4, fontSize: 10, color: "var(--txt3)" }}>
                  {Object.entries(CUADRANTE_CONFIG).map(([k, cfg]) => {
                    const cnt = items.filter(i => (i.cuadrante || "REVISAR") === k).length;
                    if (cnt === 0) return null;
                    return (
                      <span key={k} style={{ color: cfg.color, fontWeight: 600 }}>
                        {cfg.icon} {cnt}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {/* Filtro por cuadrante ABC-XYZ */}
              <div style={{ display: "flex", gap: 4 }}>
                <button onClick={() => setCuadranteFilter(null)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: cuadranteFilter === null ? "var(--cyan)" : "var(--bg3)", color: cuadranteFilter === null ? "#fff" : "var(--txt2)", border: "1px solid var(--bg4)" }}>
                  Todos
                </button>
                {Object.entries(CUADRANTE_CONFIG).map(([k, cfg]) => (
                  <button key={k} onClick={() => setCuadranteFilter(cuadranteFilter === k ? null : k)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: cuadranteFilter === k ? cfg.color : "var(--bg3)", color: cuadranteFilter === k ? "#0a0e17" : "var(--txt2)", border: "1px solid var(--bg4)" }}>
                    {cfg.icon} {cfg.label}
                  </button>
                ))}
              </div>
              {selectedCubeta === "muerto" && (
                <div style={{ display: "flex", gap: 4 }}>
                  {[null, "reciente", "cronico", "fosil"].map(f => (
                    <button key={f || "all"} onClick={() => setMuertoFilter(f)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: muertoFilter === f ? "var(--cyan)" : "var(--bg3)", color: muertoFilter === f ? "#fff" : "var(--txt2)", border: "1px solid var(--bg4)" }}>
                      {f === null ? "Todos" : f === "reciente" ? "60-120d" : f === "cronico" ? "120-365d" : ">365d"}
                    </button>
                  ))}
                </div>
              )}
              <label style={{ fontSize: 11, color: "var(--txt3)", display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" checked={showRevisados} onChange={e => { setShowRevisados(e.target.checked); if (selectedCubeta) loadCubeta(selectedCubeta); }} />
                Mostrar revisados
              </label>
            </div>
          </div>

          {loadingItems ? (
            <div style={{ textAlign: "center", padding: 20, color: "var(--txt3)" }}>Cargando...</div>
          ) : (
            <>
              <div style={{ overflowX: "auto" }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}></th>
                      <th>SKU</th>
                      <th style={{ width: 30 }} title="Cuadrante ABC-XYZ"></th>
                      <th>Nombre</th>
                      <th style={{ textAlign: "right" }}>Vel 7d</th>
                      <th style={{ textAlign: "right" }}>Vel 30d</th>
                      <th style={{ textAlign: "right" }}>Delta</th>
                      <th style={{ textAlign: "right" }}>Stock</th>
                      <th style={{ textAlign: "right" }}>Cob dias</th>
                      <th style={{ textAlign: "right" }}>Precio</th>
                      <th style={{ textAlign: "right" }}>Impacto</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayItems.map(row => {
                      const delta = row.vel_30d > 0 ? ((row.vel_7d / row.vel_30d - 1) * 100) : 0;
                      const deltaColor = delta > 0 ? "var(--green)" : delta < -20 ? "var(--red)" : "var(--txt2)";
                      return (
                        <tr key={row.sku_origen} style={{ opacity: row.ya_revisado ? 0.5 : 1 }}>
                          <td>
                            {row.thumbnail && <img src={row.thumbnail} alt="" style={{ width: 28, height: 28, borderRadius: 4, objectFit: "cover" }} />}
                          </td>
                          <td className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
                            {row.permalink ? <a href={row.permalink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan)", textDecoration: "none" }}>{row.sku_origen}</a> : row.sku_origen}
                            {(row.dias_sin_stock_full ?? 0) > 14 && (
                              <span title={`Full con bajo stock ${row.dias_sin_stock_full}d — velocidad contaminada`} style={{ marginLeft: 4, fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "var(--red)20", color: "var(--red)", fontWeight: 700 }}>
                                ⚠ {row.dias_sin_stock_full}d s/Full
                              </span>
                            )}
                            {row.factor_rampup_aplicado < 1 && (
                              <span title={`Ramp-up post-quiebre (${row.rampup_motivo || ""})`} style={{ marginLeft: 4, fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "var(--cyan)20", color: "var(--cyan)", fontWeight: 700 }}>
                                ⏳ ramp-up
                              </span>
                            )}
                            {row.cantidad_publicaciones_ml > 1 && (
                              <span style={{ marginLeft: 4, fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "var(--amber)20", color: "var(--amber)", fontWeight: 700 }}>{row.cantidad_publicaciones_ml} pub</span>
                            )}
                            {row.persistente && (
                              <span style={{ marginLeft: 4, fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "var(--red)20", color: "var(--red)", fontWeight: 700 }}>persistente</span>
                            )}
                            {row.ya_revisado && <span style={{ marginLeft: 4 }}>✅</span>}
                          </td>
                          <td style={{ textAlign: "center", fontSize: 14 }} title={CUADRANTE_CONFIG[row.cuadrante || "REVISAR"]?.label || "—"}>
                            {CUADRANTE_CONFIG[row.cuadrante || "REVISAR"]?.icon || "·"}
                          </td>
                          <td style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.nombre || "—"}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{row.vel_7d.toFixed(1)}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{row.vel_30d.toFixed(1)}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: deltaColor, fontWeight: 600 }}>
                            {row.vel_30d > 0 ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%` : "—"}
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }} title={`Full: ${row.stock_full} | Bodega: ${row.stock_bodega}`}>
                            {row.stock_total}
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: row.cob_total < 14 ? "var(--red)" : row.cob_total > 60 ? "var(--amber)" : "var(--txt)" }}>
                            {row.cob_total > 900 ? "999+" : Math.round(row.cob_total)}
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                            {row.precio_actual > 0 ? `$${row.precio_actual.toLocaleString()}` : "—"}
                            {row.precio_markdown_sugerido != null && row.precio_actual > 0 && (
                              <div style={{ fontSize: 10, marginTop: 2, color: "var(--amber)" }} title={row.markdown_motivo || ""}>
                                → ${row.precio_markdown_sugerido.toLocaleString()}
                                <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700 }}>
                                  {Math.round(((row.precio_markdown_sugerido - row.precio_actual) / row.precio_actual) * 100)}%
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: CUBETA_CONFIG[selectedCubeta]?.color }}>
                            {fmt(row.impacto_clp)}
                            {(row.venta_perdida_pesos ?? 0) > 10000 && (
                              <div title="Lost sales acumulado por falta de stock" style={{ fontSize: 9, color: "var(--red)", marginTop: 2 }}>
                                + perdido {fmt(row.venta_perdida_pesos)}
                              </div>
                            )}
                          </td>
                          <td>
                            {!row.ya_revisado && (
                              <button onClick={() => openReview(row)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--cyan)", color: "#fff", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer" }}>
                                Revisar
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {selectedCubeta === "muerto" && !muertoExpanded && muertoItems.length > 20 && (
                <button onClick={() => setMuertoExpanded(true)} style={{ marginTop: 8, padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt2)", fontSize: 12, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer", width: "100%" }}>
                  Ver {muertoItems.length - 20} muertos mas...
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Review Modal */}
      {reviewModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--bg2)", borderRadius: 16, padding: 24, width: 520, maxHeight: "90vh", overflow: "auto", border: "1px solid var(--bg4)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                <span>Revisar: {reviewModal.sku_origen}</span>
                <span style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 10,
                  background: CUADRANTE_CONFIG[reviewModal.cuadrante || "REVISAR"]?.color || "var(--bg3)",
                  color: "#0a0e17",
                  fontWeight: 700,
                }}>
                  {CUADRANTE_CONFIG[reviewModal.cuadrante || "REVISAR"]?.icon} {CUADRANTE_CONFIG[reviewModal.cuadrante || "REVISAR"]?.label || "—"}
                </span>
              </div>
              <button onClick={() => setReviewModal(null)} style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>

            {/* Thumbnail + name */}
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              {reviewModal.thumbnail && <img src={reviewModal.thumbnail} alt="" style={{ width: 60, height: 60, borderRadius: 8, objectFit: "cover" }} />}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{reviewModal.nombre || "—"}</div>
                {reviewModal.permalink && <a href={reviewModal.permalink} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: "var(--cyan)" }}>Ver en ML</a>}
              </div>
            </div>

            {/* Metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16, background: "var(--bg3)", borderRadius: 8, padding: 12 }}>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Vel 7d</div><div className="mono" style={{ fontWeight: 700 }}>{reviewModal.vel_7d.toFixed(1)}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Vel 30d</div><div className="mono" style={{ fontWeight: 700 }}>{reviewModal.vel_30d.toFixed(1)}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Delta</div><div className="mono" style={{ fontWeight: 700, color: reviewModal.vel_7d < reviewModal.vel_30d ? "var(--red)" : "var(--green)" }}>{reviewModal.vel_30d > 0 ? `${((reviewModal.vel_7d / reviewModal.vel_30d - 1) * 100).toFixed(0)}%` : "—"}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Stock</div><div className="mono" style={{ fontWeight: 700 }}>{reviewModal.stock_total}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Cob</div><div className="mono" style={{ fontWeight: 700 }}>{Math.round(reviewModal.cob_total)}d</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Precio</div><div className="mono" style={{ fontWeight: 700 }}>${reviewModal.precio_actual.toLocaleString()}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Margen Full</div><div className="mono" style={{ fontWeight: 700 }}>${Math.round(reviewModal.margen_full_30d).toLocaleString()}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Dias sin venta</div><div className="mono" style={{ fontWeight: 700 }}>{reviewModal.dias_sin_venta === 999 ? "—" : reviewModal.dias_sin_venta}</div></div>
              <div><div style={{ fontSize: 9, color: "var(--txt3)" }}>Impacto</div><div className="mono" style={{ fontWeight: 700, color: "var(--amber)" }}>{fmt(reviewModal.impacto_clp)}</div></div>
            </div>

            {/* Diagnóstico automatico del motor de inteligencia */}
            {(reviewModal.accion || (reviewModal.alertas && reviewModal.alertas.length > 0) || (reviewModal.dias_sin_stock_full ?? 0) > 14) && (
              <div style={{ marginBottom: 16, padding: 10, borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
                <div style={{ fontSize: 10, color: "var(--txt3)", fontWeight: 600, marginBottom: 6 }}>
                  DIAGNOSTICO AUTOMATICO (motor de inteligencia)
                </div>
                {reviewModal.accion && (
                  <div style={{ fontSize: 12, marginBottom: 6 }}>
                    <span style={{ color: "var(--txt3)" }}>Accion recomendada: </span>
                    <span style={{ fontWeight: 700, color: "var(--cyan)" }}>{reviewModal.accion}</span>
                  </div>
                )}
                {(reviewModal.dias_sin_stock_full ?? 0) > 14 && (
                  <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 6 }}>
                    ⚠️ Velocidad contaminada: Full con bajo stock {reviewModal.dias_sin_stock_full} días. Esperar 2-4 sem. antes de decidir.
                  </div>
                )}
                {reviewModal.factor_rampup_aplicado < 1 && (
                  <div style={{ fontSize: 11, color: "var(--cyan)", marginBottom: 6 }}>
                    ⏳ Ramp-up post-quiebre activo (factor {reviewModal.factor_rampup_aplicado.toFixed(2)}). Motivo: {reviewModal.rampup_motivo || "—"}
                  </div>
                )}
                {(reviewModal.venta_perdida_pesos ?? 0) > 0 && (
                  <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 6 }}>
                    💸 Lost sales estimado: <span className="mono" style={{ fontWeight: 700 }}>{fmt(reviewModal.venta_perdida_pesos)}</span>
                    {(reviewModal.ingreso_perdido ?? 0) > 0 && (
                      <span style={{ color: "var(--txt3)" }}> (ingreso perdido {fmt(reviewModal.ingreso_perdido)})</span>
                    )}
                  </div>
                )}
                {reviewModal.alertas && reviewModal.alertas.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {reviewModal.alertas.map(a => (
                      <span key={a} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "var(--amber)20", color: "var(--amber)", fontWeight: 600 }}>
                        {a}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Markdown sugerido */}
            {reviewModal.precio_markdown_sugerido != null && reviewModal.precio_actual > 0 && (
              <div style={{ marginBottom: 16, padding: 10, borderRadius: 8, background: "var(--amber)20", border: "1px solid var(--amber)50" }}>
                <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, fontWeight: 600 }}>
                  SUGERENCIA AUTOMATICA — {describirMotivoMarkdown(reviewModal.markdown_motivo)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--txt3)", textDecoration: "line-through" }}>
                    ${reviewModal.precio_actual.toLocaleString()}
                  </span>
                  <span style={{ fontSize: 14, color: "var(--amber)" }}>→</span>
                  <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: "var(--amber)" }}>
                    ${reviewModal.precio_markdown_sugerido.toLocaleString()}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--amber)" }}>
                    {Math.round(((reviewModal.precio_markdown_sugerido - reviewModal.precio_actual) / reviewModal.precio_actual) * 100)}%
                  </span>
                </div>
              </div>
            )}

            {/* Causa */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: "block" }}>Cual es la causa?</label>
              <select className="form-select" value={causa} onChange={e => setCausa(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)" }}>
                {Object.entries(CAUSAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4, display: "block" }}>Detalle (opcional)</label>
              <input className="form-input" value={causaDetalle} onChange={e => setCausaDetalle(e.target.value)} placeholder="Ej: Dia de la madre 2025 cerro el viernes" style={{ width: "100%", fontSize: 12 }} />
            </div>

            {/* Accion */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: "block" }}>Que accion vas a tomar?</label>
              <select className="form-select" value={accion} onChange={e => setAccion(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)" }}>
                {Object.entries(ACCIONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4, display: "block" }}>Detalle (opcional)</label>
              <input className="form-input" value={accionDetalle} onChange={e => setAccionDetalle(e.target.value)} placeholder="Ej: Postulado a Dia de la Madre 2026" style={{ width: "100%", fontSize: 12 }} />
            </div>

            {/* Historial */}
            {historial.length > 0 && (
              <div style={{ marginBottom: 16, padding: 10, background: "var(--bg3)", borderRadius: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 6 }}>Historial ({historial.length} revisiones)</div>
                {historial.slice(0, 3).map(h => (
                  <div key={h.id} style={{ fontSize: 10, color: "var(--txt2)", marginBottom: 4 }}>
                    <span style={{ color: "var(--txt3)" }}>{h.semana}</span> — {CUBETA_CONFIG[h.cubeta]?.icon || ""} {CAUSAS[h.causa_identificada] || h.causa_identificada} → {ACCIONES[h.accion_tomada] || h.accion_tomada}
                  </div>
                ))}
              </div>
            )}

            {/* Buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setReviewModal(null)} style={{ flex: 1, padding: 10, borderRadius: 8, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, border: "1px solid var(--bg4)" }}>Cancelar</button>
              <button onClick={saveReview} disabled={saving} style={{ flex: 2, padding: 10, borderRadius: 8, background: "var(--green)", color: "#fff", fontWeight: 700, border: "none" }}>
                {saving ? "Guardando..." : "Guardar revision"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function describirMotivoMarkdown(motivo: string | null): string {
  if (!motivo) return "";
  const m = motivo.match(/^(liquidar|markdown_\d+)_(\d+)d$/);
  if (!m) return motivo;
  const [, tipo, dias] = m;
  if (tipo === "liquidar") return `Liquidar (${dias} dias sin venta, >180d)`;
  const pct = tipo.replace("markdown_", "");
  return `Markdown -${pct}% (${dias} dias sin venta)`;
}

function getISOWeek(dateStr: string): number {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function formatSemanaRange(dateStr: string): string {
  const d = new Date(dateStr);
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d.getDate()} al ${end.getDate()} de ${months[end.getMonth()]} ${end.getFullYear()}`;
}
