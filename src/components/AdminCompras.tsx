"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchOrdenesCompra, fetchOrdenCompra, fetchOrdenCompraLineas,
  updateOrdenCompra, deleteOrdenCompra, fetchRecepcionesDeOC,
  fetchRecepcionesSinOC, vincularRecepcionOC, fetchRecepcionLineas,
  insertAdminActionLog,
} from "@/lib/db";
import type { DBOrdenCompra, DBOrdenCompraLinea, DBRecepcion, OCEstado } from "@/lib/db";

// ============================================
// Helpers
// ============================================

const fmtInt = (n: number | null | undefined) => n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtK = (n: number) => {
  if (Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n).toLocaleString("es-CL");
};
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: undefined });
};

const ESTADO_COLORS: Record<string, string> = {
  BORRADOR: "var(--txt3)",
  PENDIENTE: "var(--amber)",
  EN_TRANSITO: "var(--cyan)",
  RECIBIDA_PARCIAL: "#f97316",
  RECIBIDA: "var(--green)",
  CERRADA: "#16a34a",
  ANULADA: "var(--red)",
};

// ============================================
// Component
// ============================================

export default function AdminCompras() {
  const [ocs, setOcs] = useState<DBOrdenCompra[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");

  // Detail view
  const [selectedOC, setSelectedOC] = useState<DBOrdenCompra | null>(null);
  const [ocLineas, setOcLineas] = useState<DBOrdenCompraLinea[]>([]);
  const [ocRecepciones, setOcRecepciones] = useState<DBRecepcion[]>([]);
  const [recibidoPorSku, setRecibidoPorSku] = useState<Map<string, number>>(new Map());

  // Modals
  const [modalEnviar, setModalEnviar] = useState(false);
  const [fechaEsperada, setFechaEsperada] = useState("");
  const [modalVincular, setModalVincular] = useState(false);
  const [recepcionesSinOC, setRecepcionesSinOC] = useState<DBRecepcion[]>([]);
  const [procesando, setProcesando] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    const data = await fetchOrdenesCompra();
    setOcs(data);
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Proveedores únicos
  const proveedores = useMemo(() => Array.from(new Set(ocs.map(o => o.proveedor))).sort(), [ocs]);

  // Filtrar
  const filtered = useMemo(() => {
    let rows = ocs;
    if (filtroEstado !== "todos") rows = rows.filter(o => o.estado === filtroEstado);
    if (filtroProveedor !== "todos") rows = rows.filter(o => o.proveedor === filtroProveedor);
    return rows;
  }, [ocs, filtroEstado, filtroProveedor]);

  // Open detail
  const openDetail = useCallback(async (oc: DBOrdenCompra) => {
    setSelectedOC(oc);
    const [lineas, recepciones] = await Promise.all([
      fetchOrdenCompraLineas(oc.id!),
      fetchRecepcionesDeOC(oc.id!),
    ]);
    setOcLineas(lineas);
    setOcRecepciones(recepciones);

    // Calcular recibido por SKU desde recepciones vinculadas
    const recMap = new Map<string, number>();
    if (recepciones.length > 0) {
      for (const rec of recepciones) {
        const recLineas = await fetchRecepcionLineas(rec.id!);
        for (const rl of recLineas) {
          const sku = (rl.sku || "").toUpperCase();
          recMap.set(sku, (recMap.get(sku) || 0) + (rl.qty_recibida || 0));
        }
      }
    }
    setRecibidoPorSku(recMap);
  }, []);

  // Back to list
  const backToList = useCallback(() => {
    setSelectedOC(null);
    setOcLineas([]);
    setOcRecepciones([]);
    setRecibidoPorSku(new Map());
    cargar();
  }, [cargar]);

  // ── Actions ──

  const confirmarOC = useCallback(async () => {
    if (!selectedOC) return;
    await updateOrdenCompra(selectedOC.id!, { estado: "PENDIENTE" });
    await insertAdminActionLog("confirmar_oc", "ordenes_compra", selectedOC.id!, { numero: selectedOC.numero });
    backToList();
  }, [selectedOC, backToList]);

  const eliminarOC = useCallback(async () => {
    if (!selectedOC) return;
    if (!window.confirm(`Eliminar OC ${selectedOC.numero}? Esta acción no se puede deshacer.`)) return;
    await deleteOrdenCompra(selectedOC.id!);
    await insertAdminActionLog("eliminar_oc", "ordenes_compra", selectedOC.id!, { numero: selectedOC.numero });
    backToList();
  }, [selectedOC, backToList]);

  const anularOC = useCallback(async () => {
    if (!selectedOC) return;
    const motivo = window.prompt("Motivo de anulación:");
    if (motivo === null) return;
    await updateOrdenCompra(selectedOC.id!, { estado: "ANULADA", notas: `${selectedOC.notas || ""}\nAnulada: ${motivo}` });
    await insertAdminActionLog("anular_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, numero: selectedOC.numero, motivo });
    backToList();
  }, [selectedOC, backToList]);

  const marcarEnviada = useCallback(async () => {
    if (!selectedOC || !fechaEsperada) return;
    setProcesando(true);
    await updateOrdenCompra(selectedOC.id!, { estado: "EN_TRANSITO", fecha_esperada: fechaEsperada });
    await insertAdminActionLog("enviar_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, numero: selectedOC.numero, fecha_esperada: fechaEsperada });
    setModalEnviar(false);
    setProcesando(false);
    backToList();
  }, [selectedOC, fechaEsperada, backToList]);

  const abrirVincular = useCallback(async () => {
    if (!selectedOC) return;
    const recs = await fetchRecepcionesSinOC(selectedOC.proveedor);
    setRecepcionesSinOC(recs);
    setModalVincular(true);
  }, [selectedOC]);

  const vincular = useCallback(async (recId: string) => {
    if (!selectedOC) return;
    setProcesando(true);
    await vincularRecepcionOC(recId, selectedOC.id!);
    await insertAdminActionLog("vincular_recepcion_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, recepcion_id: recId });
    setModalVincular(false);
    setProcesando(false);
    // Refresh detail
    openDetail(selectedOC);
  }, [selectedOC, openDetail]);

  const cerrarOC = useCallback(async () => {
    if (!selectedOC) return;
    if (!window.confirm(`Cerrar OC ${selectedOC.numero}? Se calculará lead time y cumplimiento.`)) return;
    setProcesando(true);

    // Calcular métricas de cierre
    const totalPedido = ocLineas.reduce((s, l) => s + l.cantidad_pedida, 0);
    const totalRecibido = ocLineas.reduce((s, l) => s + (recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0), 0);
    const pctCumplimiento = totalPedido > 0 ? Math.round((totalRecibido / totalPedido) * 1000) / 10 : 0;

    // Lead time: días entre emisión y última recepción
    let leadTimeReal: number | null = null;
    if (selectedOC.fecha_emision && ocRecepciones.length > 0) {
      const ultimaRec = ocRecepciones.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
      if (ultimaRec.created_at) {
        const emision = new Date(selectedOC.fecha_emision);
        const recepcion = new Date(ultimaRec.created_at);
        leadTimeReal = Math.max(0, Math.round((recepcion.getTime() - emision.getTime()) / 86400000));
      }
    }

    await updateOrdenCompra(selectedOC.id!, {
      estado: "CERRADA",
      fecha_recepcion: new Date().toISOString().slice(0, 10),
      lead_time_real: leadTimeReal,
      total_recibido: totalRecibido,
      pct_cumplimiento: pctCumplimiento,
    });

    await insertAdminActionLog("cerrar_oc", "ordenes_compra", selectedOC.id!, {
      oc_id: selectedOC.id, numero: selectedOC.numero,
      lead_time_real: leadTimeReal, total_recibido: totalRecibido, pct_cumplimiento: pctCumplimiento,
    });

    // Disparar recálculo de inteligencia
    try { await fetch("/api/intelligence/recalcular", { method: "POST" }); } catch { /* silenciar */ }

    setProcesando(false);
    backToList();
  }, [selectedOC, ocLineas, ocRecepciones, recibidoPorSku, backToList]);

  // Auto-calculate OC status from receptions
  const calcEstadoAuto = useCallback((): OCEstado | null => {
    if (!selectedOC || ocLineas.length === 0) return null;
    const currentEstado = selectedOC.estado;
    if (currentEstado === "BORRADOR" || currentEstado === "PENDIENTE" || currentEstado === "CERRADA" || currentEstado === "ANULADA") return null;

    let todasRecibidas = true;
    let algunaRecibida = false;
    for (const l of ocLineas) {
      const recibido = recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0;
      if (recibido >= l.cantidad_pedida) algunaRecibida = true;
      else todasRecibidas = false;
      if (recibido > 0) algunaRecibida = true;
    }

    if (todasRecibidas && algunaRecibida) return "RECIBIDA";
    if (algunaRecibida) return "RECIBIDA_PARCIAL";
    return null;
  }, [selectedOC, ocLineas, recibidoPorSku]);

  // Update estado if auto-calc differs
  useEffect(() => {
    const nuevoEstado = calcEstadoAuto();
    if (nuevoEstado && selectedOC && nuevoEstado !== selectedOC.estado) {
      updateOrdenCompra(selectedOC.id!, { estado: nuevoEstado }).then(() => {
        setSelectedOC(prev => prev ? { ...prev, estado: nuevoEstado } : prev);
      });
    }
  }, [calcEstadoAuto, selectedOC]);

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando órdenes de compra...</div>;

  // ══════════════════════
  // DETAIL VIEW
  // ══════════════════════
  if (selectedOC) {
    const estado = selectedOC.estado;
    const estadoColor = ESTADO_COLORS[estado] || "var(--txt3)";
    const totalPedido = ocLineas.reduce((s, l) => s + l.cantidad_pedida, 0);
    const totalRecibidoCalc = ocLineas.reduce((s, l) => s + (recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0), 0);
    const pctProgreso = totalPedido > 0 ? Math.round((totalRecibidoCalc / totalPedido) * 100) : 0;

    return (
      <div style={{ padding: "0 4px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <button onClick={backToList} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer" }}>
            ← Volver
          </button>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{selectedOC.numero}</h2>
            <span style={{ fontSize: 12, color: "var(--txt3)" }}>{selectedOC.proveedor} — {fmtDate(selectedOC.fecha_emision || selectedOC.created_at)}</span>
          </div>
          <span style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: estadoColor + "22", color: estadoColor, border: `1px solid ${estadoColor}44` }}>
            {estado}
          </span>
          {selectedOC.fecha_esperada && (
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>Esperada: {fmtDate(selectedOC.fecha_esperada)}</span>
          )}
        </div>

        {/* KPIs */}
        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Líneas</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{ocLineas.length}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Pedido</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmtInt(totalPedido)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Recibido</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: totalRecibidoCalc > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtInt(totalRecibidoCalc)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Neto</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(selectedOC.total_neto)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Progreso</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: pctProgreso >= 100 ? "var(--green)" : pctProgreso > 0 ? "var(--amber)" : "var(--txt3)" }}>{pctProgreso}%</div>
          </div>
          {selectedOC.lead_time_real != null && (
            <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Lead time real</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{selectedOC.lead_time_real}d</div>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {estado === "BORRADOR" && (
            <>
              <button onClick={confirmarOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--amber)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>Confirmar</button>
              <button onClick={eliminarOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Eliminar</button>
            </>
          )}
          {estado === "PENDIENTE" && (
            <>
              <button onClick={() => { setFechaEsperada(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)); setModalEnviar(true); }}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
                Marcar enviada
              </button>
              <button onClick={anularOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Anular</button>
            </>
          )}
          {(estado === "EN_TRANSITO" || estado === "RECIBIDA_PARCIAL") && (
            <>
              <button onClick={abrirVincular} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 700, fontSize: 12, border: "1px solid var(--blueBd)", cursor: "pointer" }}>Vincular recepción</button>
              {estado === "EN_TRANSITO" && <button onClick={anularOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Anular</button>}
              {estado === "RECIBIDA_PARCIAL" && <button onClick={cerrarOC} disabled={procesando} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontWeight: 700, fontSize: 12, border: "1px solid var(--greenBd)", cursor: "pointer" }}>Cerrar</button>}
            </>
          )}
          {estado === "RECIBIDA" && (
            <button onClick={cerrarOC} disabled={procesando} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--green)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
              {procesando ? "Cerrando..." : "Cerrar OC"}
            </button>
          )}
        </div>

        {/* Líneas */}
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>SKU Origen</th>
                <th>Nombre</th>
                <th style={{ textAlign: "right" }}>Pedido</th>
                <th style={{ textAlign: "right" }}>Recibido</th>
                <th style={{ textAlign: "right" }}>Pendiente</th>
                <th style={{ textAlign: "right" }}>Costo Unit</th>
                <th style={{ textAlign: "right" }}>Subtotal</th>
                <th>ABC</th>
                <th style={{ textAlign: "right" }}>Vel</th>
                <th style={{ textAlign: "right" }}>Cob al pedir</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {ocLineas.map(l => {
                const recibido = recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0;
                const pendiente = Math.max(0, l.cantidad_pedida - recibido);
                const estadoLinea = recibido >= l.cantidad_pedida ? "RECIBIDA" : recibido > 0 ? "PARCIAL" : "PENDIENTE";
                const estadoLineaColor = estadoLinea === "RECIBIDA" ? "var(--green)" : estadoLinea === "PARCIAL" ? "#f97316" : "var(--txt3)";
                return (
                  <tr key={l.id}>
                    <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{l.sku_origen}</td>
                    <td style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.nombre}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(l.cantidad_pedida)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, color: recibido > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtInt(recibido)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, color: pendiente > 0 ? "var(--amber)" : "var(--green)" }}>{fmtInt(pendiente)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(l.costo_unitario)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtMoney(l.cantidad_pedida * l.costo_unitario)}</td>
                    <td style={{ textAlign: "center" }}><span style={{ fontWeight: 700, fontSize: 11, color: l.abc === "A" ? "var(--green)" : l.abc === "B" ? "var(--amber)" : "var(--txt3)" }}>{l.abc || "—"}</span></td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>{l.vel_ponderada != null ? Number(l.vel_ponderada).toFixed(1) : "—"}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>{l.cob_total_al_pedir != null ? Number(l.cob_total_al_pedir).toFixed(0) + "d" : "—"}</td>
                    <td>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: estadoLineaColor + "22", color: estadoLineaColor, border: `1px solid ${estadoLineaColor}44` }}>
                        {estadoLinea}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Recepciones vinculadas */}
        {ocRecepciones.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: "var(--txt2)" }}>Recepciones vinculadas</h4>
            {ocRecepciones.map(r => (
              <div key={r.id} style={{ padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", marginBottom: 4, fontSize: 11, display: "flex", gap: 12, alignItems: "center" }}>
                <span className="mono" style={{ fontWeight: 600 }}>{r.folio}</span>
                <span style={{ color: "var(--txt3)" }}>{fmtDate(r.created_at)}</span>
                <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, color: r.estado === "CERRADA" || r.estado === "COMPLETADA" ? "var(--green)" : "var(--amber)" }}>
                  {r.estado}
                </span>
              </div>
            ))}
          </div>
        )}

        {selectedOC.notas && (
          <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", fontSize: 11, color: "var(--txt3)", whiteSpace: "pre-wrap" }}>
            {selectedOC.notas}
          </div>
        )}

        {/* Modal Marcar Enviada */}
        {modalEnviar && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={() => !procesando && setModalEnviar(false)}>
            <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 400, width: "100%" }}
              onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>Marcar como enviada</h3>
              <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Fecha esperada de recepción</label>
              <input
                type="date"
                value={fechaEsperada}
                onChange={e => setFechaEsperada(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 14, marginBottom: 16 }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setModalEnviar(false)} disabled={procesando}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cancelar
                </button>
                <button onClick={marcarEnviada} disabled={procesando || !fechaEsperada}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
                  {procesando ? "Guardando..." : "Confirmar"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal Vincular Recepción */}
        {modalVincular && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={() => !procesando && setModalVincular(false)}>
            <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 500, width: "100%", maxHeight: "70vh", overflow: "auto" }}
              onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>Vincular recepción</h3>
              <p style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>Recepciones de {selectedOC.proveedor} sin OC vinculada:</p>
              {recepcionesSinOC.length === 0 ? (
                <div style={{ textAlign: "center", padding: 20, color: "var(--txt3)", fontSize: 12 }}>No hay recepciones disponibles para vincular.</div>
              ) : (
                recepcionesSinOC.map(rec => (
                  <div key={rec.id} style={{ padding: "10px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{rec.folio}</span>
                      <span style={{ fontSize: 11, color: "var(--txt3)", marginLeft: 8 }}>{fmtDate(rec.created_at)}</span>
                      <span style={{ fontSize: 10, marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "var(--bg4)", color: "var(--txt3)" }}>{rec.estado}</span>
                    </div>
                    <button onClick={() => vincular(rec.id!)} disabled={procesando}
                      style={{ padding: "6px 12px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 600, fontSize: 11, border: "1px solid var(--blueBd)", cursor: "pointer" }}>
                      Vincular
                    </button>
                  </div>
                ))
              )}
              <div style={{ marginTop: 12, textAlign: "right" }}>
                <button onClick={() => setModalVincular(false)}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ══════════════════════
  // LIST VIEW
  // ══════════════════════
  return (
    <div style={{ padding: "0 4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Compras — Órdenes de Compra</h2>
        <button onClick={cargar} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 11, border: "1px solid var(--bg4)", cursor: "pointer" }}>
          Refrescar
        </button>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11 }}>
          <option value="todos">Todos los estados</option>
          {["BORRADOR","PENDIENTE","EN_TRANSITO","RECIBIDA_PARCIAL","RECIBIDA","CERRADA","ANULADA"].map(e => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <select value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11 }}>
          <option value="todos">Todos los proveedores</option>
          {proveedores.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <span style={{ fontSize: 11, color: "var(--txt3)", alignSelf: "center" }}>{filtered.length} órdenes</span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🛒</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No hay órdenes de compra</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Crea una desde Inteligencia → Pedido a Proveedor</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Proveedor</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th style={{ textAlign: "right" }}>Líneas</th>
                <th style={{ textAlign: "right" }}>Monto Neto</th>
                <th>Esperada</th>
                <th>Progreso</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(oc => {
                const color = ESTADO_COLORS[oc.estado] || "var(--txt3)";
                return (
                  <tr key={oc.id} onClick={() => openDetail(oc)} style={{ cursor: "pointer" }}>
                    <td className="mono" style={{ fontSize: 11, fontWeight: 600 }}>{oc.numero}</td>
                    <td style={{ fontSize: 11 }}>{oc.proveedor}</td>
                    <td style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtDate(oc.fecha_emision || oc.created_at)}</td>
                    <td>
                      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: color + "22", color: color, border: `1px solid ${color}44` }}>
                        {oc.estado}
                      </span>
                    </td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>—</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtK(oc.total_neto)}</td>
                    <td style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtDate(oc.fecha_esperada)}</td>
                    <td>
                      {oc.pct_cumplimiento != null ? (
                        <span className="mono" style={{ fontSize: 11, color: oc.pct_cumplimiento >= 100 ? "var(--green)" : "var(--amber)" }}>{oc.pct_cumplimiento}%</span>
                      ) : oc.estado === "CERRADA" ? (
                        <span style={{ fontSize: 10, color: "var(--green)" }}>100%</span>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--txt3)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
