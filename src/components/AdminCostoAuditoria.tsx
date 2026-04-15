"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getSupabase, fetchProductos } from "@/lib/db";
import type { DBProduct } from "@/lib/db";

// ============================================
// Helpers
// ============================================

const fmtInt = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtDateTime = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleString("es-CL", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
};
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
};

// ============================================
// Event model
// ============================================

type EventType =
  | "recepcion"
  | "linea_editada"
  | "movimiento_entrada"
  | "movimiento_salida"
  | "discrepancia_detectada"
  | "discrepancia_aprobada"
  | "discrepancia_rechazada"
  | "audit_costo_batch"
  | "audit_override"
  | "audit_sync"
  | "audit_cleanup"
  | "audit_otro";

type TimelineEvent = {
  ts: string;           // ISO timestamp
  tipo: EventType;
  titulo: string;
  subtitulo: string;
  valor?: number | null;
  valor_anterior?: number | null;
  valor_nuevo?: number | null;
  actor?: string;
  fuente: string;       // de qué tabla viene
  refId?: string;       // ID de la fila en la tabla origen
  nota?: string;
  color: string;
  icon: string;
};

const TIPO_META: Record<EventType, { color: string; icon: string; label: string }> = {
  recepcion:              { color: "var(--cyan)",  icon: "📥", label: "Recepción creada" },
  linea_editada:          { color: "var(--amber)", icon: "✏️", label: "Línea editada (UI admin)" },
  movimiento_entrada:     { color: "var(--green)", icon: "📦", label: "Entrada a stock" },
  movimiento_salida:      { color: "var(--txt3)",  icon: "📤", label: "Salida de stock" },
  discrepancia_detectada: { color: "var(--amber)", icon: "⚠️", label: "Discrepancia detectada" },
  discrepancia_aprobada:  { color: "var(--green)", icon: "✅", label: "Discrepancia aprobada" },
  discrepancia_rechazada: { color: "var(--red)",   icon: "❌", label: "Discrepancia rechazada" },
  audit_costo_batch:      { color: "var(--cyan)",  icon: "🔄", label: "Batch de costos" },
  audit_override:         { color: "var(--amber)", icon: "🔧", label: "Override WAC manual" },
  audit_sync:             { color: "var(--cyan)",  icon: "🔗", label: "Sync costo↔WAC" },
  audit_cleanup:          { color: "#a855f7",      icon: "🧹", label: "Cleanup manual" },
  audit_otro:             { color: "var(--txt3)",  icon: "ℹ️", label: "Audit log" },
};

// ============================================
// Component
// ============================================

export default function AdminCostoAuditoria() {
  const [productos, setProductos] = useState<DBProduct[]>([]);
  const [loadingProds, setLoadingProds] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [producto, setProducto] = useState<DBProduct | null>(null);
  const [stockActual, setStockActual] = useState<number>(0);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loadingSku, setLoadingSku] = useState(false);

  // Precargar lista de productos (para autocomplete)
  useEffect(() => {
    (async () => {
      setLoadingProds(true);
      try {
        const p = await fetchProductos();
        setProductos(p);
      } finally {
        setLoadingProds(false);
      }
    })();
  }, []);

  // Matches para autocomplete
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q || q.length < 2) return [];
    return productos
      .filter(p =>
        p.sku.toUpperCase().includes(q) ||
        (p.nombre || "").toUpperCase().includes(q),
      )
      .slice(0, 12);
  }, [query, productos]);

  // Cargar detalle de un SKU
  const cargarSku = useCallback(async (sku: string) => {
    const skuUp = sku.toUpperCase().trim();
    setSelectedSku(skuUp);
    setLoadingSku(true);
    setEvents([]);
    setProducto(null);
    setStockActual(0);

    const sb = getSupabase();
    if (!sb) { setLoadingSku(false); return; }

    try {
      // 1. Producto actual
      const [{ data: prodRows }, { data: stockRows }] = await Promise.all([
        sb.from("productos").select("*").eq("sku", skuUp).limit(1),
        sb.from("stock").select("cantidad").eq("sku", skuUp).gt("cantidad", 0),
      ]);
      const prod = (prodRows?.[0] as DBProduct | undefined) || null;
      setProducto(prod);
      setStockActual(((stockRows as Array<{ cantidad: number }>) || []).reduce((a, r) => a + r.cantidad, 0));

      // 2. Fetchs paralelos de las 5 fuentes de eventos
      const [
        { data: recLineas },
        { data: movs },
        { data: discs },
        { data: ajustes },
        { data: audits },
      ] = await Promise.all([
        sb.from("recepcion_lineas")
          .select("id, recepcion_id, sku, nombre, qty_factura, costo_unitario")
          .eq("sku", skuUp),
        sb.from("movimientos")
          .select("id, tipo, motivo, cantidad, costo_unitario, operario, nota, created_at, recepcion_id, posicion_id")
          .eq("sku", skuUp)
          .order("created_at", { ascending: false })
          .limit(200),
        sb.from("discrepancias_costo")
          .select("*")
          .eq("sku", skuUp)
          .order("created_at", { ascending: false }),
        sb.from("recepcion_ajustes")
          .select("*")
          .or(`sku_original.eq.${skuUp},sku_nuevo.eq.${skuUp}`)
          .order("created_at", { ascending: false }),
        sb.from("audit_log")
          .select("*")
          .eq("entidad_id", skuUp)
          .in("accion", [
            "sincronizarCostoMovimientosRecepcion",
            "costo_batch_movs_sin_recepcion",
            "regularizacion_historica_costo",
            "regularizacion_costo_sin_stock",
            "override_wac_manual",
            "sync_costo_to_costo_promedio",
            "sync_costo_to_costo_promedio_bulk",
            "cleanup_discrepancias_falso_positivo",
            "cleanup_productos_costo_contaminado",
            "costo_batch_error",
          ])
          .order("created_at", { ascending: false })
          .limit(200),
      ]);

      // 3. Fetch de recepciones para obtener folio + created_at
      const recIds = Array.from(new Set(((recLineas || []) as Array<{ recepcion_id: string }>).map(l => l.recepcion_id)));
      const recMap = new Map<string, { folio: string; created_at: string; estado?: string }>();
      if (recIds.length > 0) {
        const { data: recs } = await sb.from("recepciones").select("id, folio, created_at, estado").in("id", recIds);
        for (const r of (recs || []) as Array<{ id: string; folio: string; created_at: string; estado?: string }>) {
          recMap.set(r.id, { folio: r.folio, created_at: r.created_at, estado: r.estado });
        }
      }

      // 4. Construir eventos consolidados
      const ev: TimelineEvent[] = [];

      for (const l of ((recLineas || []) as Array<{
        id: string; recepcion_id: string; costo_unitario: number | null; qty_factura: number;
      }>)) {
        const r = recMap.get(l.recepcion_id);
        if (!r) continue;
        ev.push({
          ts: r.created_at,
          tipo: "recepcion",
          titulo: `Recepción folio ${r.folio}`,
          subtitulo: `qty: ${l.qty_factura} · estado: ${r.estado || "—"}`,
          valor: l.costo_unitario,
          actor: "—",
          fuente: "recepcion_lineas",
          refId: l.id,
          color: TIPO_META.recepcion.color,
          icon: TIPO_META.recepcion.icon,
        });
      }

      for (const a of ((ajustes || []) as Array<{
        id: string; tipo: string; campo: string; valor_anterior: string | null;
        valor_nuevo: string | null; motivo: string; admin: string; created_at: string;
      }>)) {
        if (a.campo !== "costo_unitario") continue;
        ev.push({
          ts: a.created_at,
          tipo: "linea_editada",
          titulo: "Edición manual de costo_unitario",
          subtitulo: a.motivo || "—",
          valor_anterior: a.valor_anterior ? Number(a.valor_anterior) : null,
          valor_nuevo: a.valor_nuevo ? Number(a.valor_nuevo) : null,
          actor: a.admin || "—",
          fuente: "recepcion_ajustes",
          refId: a.id,
          color: TIPO_META.linea_editada.color,
          icon: TIPO_META.linea_editada.icon,
        });
      }

      for (const m of ((movs || []) as Array<{
        id: string; tipo: string; motivo: string; cantidad: number;
        costo_unitario: number | null; operario: string; nota: string;
        created_at: string; recepcion_id: string | null; posicion_id: string;
      }>)) {
        const isEntrada = m.tipo === "entrada";
        const eventoTipo: EventType = isEntrada ? "movimiento_entrada" : "movimiento_salida";
        const meta = TIPO_META[eventoTipo];
        const r = m.recepcion_id ? recMap.get(m.recepcion_id) : null;
        ev.push({
          ts: m.created_at,
          tipo: eventoTipo,
          titulo: `${m.tipo} · ${m.motivo}${r ? ` · folio ${r.folio}` : ""}`,
          subtitulo: `${m.cantidad} unds en ${m.posicion_id}${m.nota ? " · " + m.nota.slice(0, 80) : ""}`,
          valor: m.costo_unitario,
          actor: m.operario || "—",
          fuente: "movimientos",
          refId: m.id,
          color: meta.color,
          icon: meta.icon,
        });
      }

      for (const d of ((discs || []) as Array<{
        id: string; estado: string; costo_diccionario: number; costo_factura: number;
        diferencia: number; porcentaje: number; notas: string | null;
        resuelto_por: string | null; resuelto_at: string | null; created_at: string;
        recepcion_id: string;
      }>)) {
        const r = recMap.get(d.recepcion_id);
        // Evento de detección
        ev.push({
          ts: d.created_at,
          tipo: "discrepancia_detectada",
          titulo: `Discrepancia detectada${r ? ` · folio ${r.folio}` : ""}`,
          subtitulo: `dicc ${fmtMoney(d.costo_diccionario)} → factura ${fmtMoney(d.costo_factura)} · ${d.porcentaje}%`,
          valor_anterior: d.costo_diccionario,
          valor_nuevo: d.costo_factura,
          fuente: "discrepancias_costo",
          refId: d.id,
          color: TIPO_META.discrepancia_detectada.color,
          icon: TIPO_META.discrepancia_detectada.icon,
        });
        // Evento de resolución si existe
        if (d.resuelto_at && d.estado !== "PENDIENTE") {
          const eventoTipo: EventType =
            d.estado === "APROBADO" ? "discrepancia_aprobada" : "discrepancia_rechazada";
          const meta = TIPO_META[eventoTipo];
          ev.push({
            ts: d.resuelto_at,
            tipo: eventoTipo,
            titulo: `${d.estado}${r ? ` · folio ${r.folio}` : ""}`,
            subtitulo: d.notas || "(sin nota)",
            actor: d.resuelto_por || "—",
            fuente: "discrepancias_costo",
            refId: d.id,
            color: meta.color,
            icon: meta.icon,
            nota: d.notas || undefined,
          });
        }
      }

      for (const a of ((audits || []) as Array<{
        id: string; accion: string; params: Record<string, unknown>;
        resultado: Record<string, unknown> | null; operario: string;
        created_at: string; error: string | null;
      }>)) {
        const tipoEvento: EventType =
          a.accion === "override_wac_manual" ? "audit_override"
          : a.accion.startsWith("sync_costo") ? "audit_sync"
          : a.accion.startsWith("cleanup_") ? "audit_cleanup"
          : a.accion.startsWith("costo_batch") || a.accion === "sincronizarCostoMovimientosRecepcion" || a.accion.startsWith("regularizacion_") ? "audit_costo_batch"
          : "audit_otro";
        const meta = TIPO_META[tipoEvento];
        const p = a.params || {};
        const valorAnt = (p.valor_anterior ?? p.costo_anterior) as number | undefined;
        const valorNue = (p.valor_nuevo ?? p.costo_nuevo ?? p.nuevoCostoUnitario ?? p.costo_neto) as number | undefined;
        const nota = (p.nota ?? p.razon ?? p.motivo) as string | undefined;
        ev.push({
          ts: a.created_at,
          tipo: tipoEvento,
          titulo: a.accion,
          subtitulo: nota || "",
          valor_anterior: valorAnt != null ? Number(valorAnt) : null,
          valor_nuevo: valorNue != null ? Number(valorNue) : null,
          actor: a.operario || "sistema",
          fuente: "audit_log",
          refId: a.id,
          color: meta.color,
          icon: meta.icon,
          nota: a.error || (typeof nota === "string" ? nota : undefined),
        });
      }

      ev.sort((a, b) => b.ts.localeCompare(a.ts));
      setEvents(ev);
    } finally {
      setLoadingSku(false);
    }
  }, []);

  const selectSku = (sku: string) => {
    setQuery(sku);
    cargarSku(sku);
  };

  const wac = Number(producto?.costo_promedio || 0);
  const costoCat = Number(producto?.costo || 0);
  const divergencia = costoCat - wac;
  const tieneDivergencia = wac > 0 && Math.abs(divergencia) > 100;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>📊 Auditoría de costo por SKU</h2>
        <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>
          Consolida todas las fuentes que tocan el costo de un producto: recepciones, ediciones manuales, movimientos, discrepancias y audits. Útil para entender cómo llegó al valor actual y quién lo tocó.
        </div>
      </div>

      {/* Buscador */}
      <div className="card" style={{ padding: 12, marginBottom: 12, position: "relative" }}>
        <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase" }}>Buscar SKU</div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && matches.length > 0) selectSku(matches[0].sku);
          }}
          placeholder={loadingProds ? "Cargando productos…" : "SKU o nombre del producto"}
          className="form-input"
          style={{ padding: "8px 12px", fontSize: 13, width: "100%" }}
          disabled={loadingProds}
        />
        {matches.length > 0 && query.length >= 2 && (
          <div style={{ position: "absolute", top: "100%", left: 12, right: 12, background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 6, zIndex: 10, marginTop: 2, maxHeight: 300, overflow: "auto" }}>
            {matches.map(p => (
              <div
                key={p.sku}
                onClick={() => selectSku(p.sku)}
                style={{ padding: "8px 12px", borderBottom: "1px solid var(--bg3)", cursor: "pointer", fontSize: 12 }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <div className="mono" style={{ fontWeight: 700 }}>{p.sku}</div>
                <div style={{ color: "var(--txt3)", fontSize: 10 }}>{p.nombre}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sin selección */}
      {!selectedSku && (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>
          Escribí un SKU o parte del nombre arriba para ver su historial completo de costo.
        </div>
      )}

      {/* Con selección — cargando */}
      {selectedSku && loadingSku && (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>
          Cargando historial de {selectedSku}…
        </div>
      )}

      {/* Con selección — listo */}
      {selectedSku && !loadingSku && producto && (
        <>
          {/* Header: costo actual */}
          <div className="card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{producto.sku}</div>
                <div style={{ fontSize: 13, color: "var(--txt2)" }}>{producto.nombre}</div>
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                  {producto.proveedor} · {producto.categoria} · stock: <strong>{stockActual}</strong>
                </div>
              </div>
              {tieneDivergencia && (
                <div style={{ padding: "6px 12px", background: "var(--amberBg)", border: "1px solid var(--amber)", borderRadius: 6, fontSize: 11, color: "var(--amber)", fontWeight: 700 }}>
                  ⚠ Divergencia costo vs WAC: {fmtMoney(divergencia)}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ padding: 14, background: "var(--greenBg)", border: "2px solid var(--green)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Costo promedio (WAC) · fuente de verdad
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: "var(--green)", marginTop: 4 }} className="mono">
                  {fmtMoney(wac)}
                </div>
                <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>
                  Reconstruido desde movimientos reales vía registrar_movimiento_stock. Es el costo que usan las ventas (ventas_ml_cache), el agente rentabilidad, el semáforo y la detección de discrepancias nuevas.
                </div>
              </div>
              <div style={{ padding: 14, background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 8 }}>
                <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Costo de catálogo
                </div>
                <div style={{ fontSize: 24, fontWeight: 700, color: tieneDivergencia ? "var(--amber)" : "var(--txt)", marginTop: 4 }} className="mono">
                  {fmtMoney(costoCat)}
                </div>
                <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>
                  Referencia visual del producto, usado como fallback cuando no existe WAC. Idealmente debe coincidir con el WAC (se sincroniza en batch post-fix).
                </div>
              </div>
            </div>
          </div>

          {/* Explicación contextual */}
          <div className="card" style={{ padding: 12, marginBottom: 12, fontSize: 11, color: "var(--txt2)" }}>
            <strong style={{ color: "var(--cyan)" }}>💡 Cuál es el costo final.</strong>{" "}
            El costo contable real de este SKU es <strong className="mono">{fmtMoney(wac)}</strong> (WAC). Ese es el número que se usa para costear ventas y detectar anomalías. El "costo catálogo" es una referencia visual que debería coincidir con el WAC — si no coincide, hay que revisar qué pasó (probablemente contaminación del Sheet o aprobación errónea en el histórico que ves abajo).
          </div>

          {/* Timeline */}
          {events.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>
              Sin eventos históricos registrados para este SKU.
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bg4)", fontSize: 11, fontWeight: 700, color: "var(--txt2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Timeline consolidado ({events.length} eventos)
              </div>
              <div style={{ maxHeight: 600, overflow: "auto" }}>
                {events.map((ev, idx) => {
                  const tieneDelta = ev.valor_anterior != null && ev.valor_nuevo != null;
                  return (
                    <div
                      key={`${ev.fuente}-${ev.refId}-${idx}`}
                      style={{
                        padding: "10px 14px",
                        borderBottom: "1px solid var(--bg3)",
                        display: "grid",
                        gridTemplateColumns: "100px 28px 1fr auto",
                        gap: 10,
                        alignItems: "flex-start",
                      }}
                    >
                      <div style={{ fontSize: 10, color: "var(--txt3)" }} className="mono">
                        {fmtDateTime(ev.ts)}
                      </div>
                      <div style={{ fontSize: 18, textAlign: "center" }} title={TIPO_META[ev.tipo].label}>
                        {ev.icon}
                      </div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: ev.color }}>{ev.titulo}</div>
                        <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{ev.subtitulo}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4, fontFamily: "monospace" }}>
                          {ev.fuente}{ev.actor ? ` · ${ev.actor}` : ""}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", minWidth: 120 }}>
                        {tieneDelta ? (
                          <>
                            <div style={{ fontSize: 10, color: "var(--txt3)" }}>de {fmtMoney(ev.valor_anterior)}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: ev.color }} className="mono">
                              → {fmtMoney(ev.valor_nuevo)}
                            </div>
                          </>
                        ) : ev.valor != null ? (
                          <div style={{ fontSize: 13, fontWeight: 700, color: ev.color }} className="mono">
                            {fmtMoney(ev.valor)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
