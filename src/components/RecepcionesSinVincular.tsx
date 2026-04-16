"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRecepcionesSinVincular,
  fetchOrdenesAbiertasParaVincular,
  fetchRecepcionLineas,
  fetchOrdenCompraLineas,
  vincularRecepcionOC,
  insertAdminActionLog,
} from "@/lib/db";
import type { DBRecepcion, DBRecepcionLinea, DBOrdenCompra, DBOrdenCompraLinea } from "@/lib/db";

const VENTANAS: { label: string; dias: number }[] = [
  { label: "7 días", dias: 7 },
  { label: "30 días", dias: 30 },
  { label: "90 días", dias: 90 },
  { label: "365 días", dias: 365 },
];

function fmtMoney(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  return "$" + Math.round(n).toLocaleString("es-CL");
}
function fmtFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export default function RecepcionesSinVincular() {
  const [ventana, setVentana] = useState(30);
  const [loading, setLoading] = useState(false);
  const [recepciones, setRecepciones] = useState<DBRecepcion[]>([]);
  const [modalRec, setModalRec] = useState<DBRecepcion | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    const recs = await fetchRecepcionesSinVincular(ventana);
    setRecepciones(recs);
    setLoading(false);
  }, [ventana]);

  useEffect(() => { cargar(); }, [cargar]);

  const total = recepciones.length;
  const totalMonto = useMemo(() => recepciones.reduce((s, r) => s + (r.costo_neto || 0), 0), [recepciones]);

  const cerrarModal = useCallback(() => setModalRec(null), []);
  const onVinculado = useCallback(async () => {
    cerrarModal();
    await cargar();
  }, [cerrarModal, cargar]);

  return (
    <div className="app">
      <div className="topbar">
        <button className="back-btn" onClick={() => window.history.back()}>← Atrás</button>
        <h1>Recepciones sin OC</h1>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>
          {total} {total === 1 ? "recepción" : "recepciones"} · {fmtMoney(totalMonto)} neto
        </div>
      </div>

      <div style={{ padding: 16 }}>
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--txt3)", marginRight: 6 }}>Ventana:</span>
            {VENTANAS.map(v => (
              <button
                key={v.dias}
                onClick={() => setVentana(v.dias)}
                style={{
                  padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${ventana === v.dias ? "var(--cyan)" : "var(--bg4)"}`,
                  background: ventana === v.dias ? "var(--cyan)" : "var(--bg3)",
                  color: ventana === v.dias ? "#000" : "var(--txt3)",
                  cursor: "pointer",
                }}
              >
                {v.label}
              </button>
            ))}
            <button
              onClick={cargar}
              style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 10, fontWeight: 600, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", borderRadius: 4, cursor: "pointer" }}
            >
              ↻ Refrescar
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Cargando…</div>
        ) : total === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>
            No hay recepciones sin OC en los últimos {ventana} días.
          </div>
        ) : (
          <div style={{ overflowX: "auto", border: "1px solid var(--bg4)", borderRadius: 6 }}>
            <table className="tbl" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Proveedor</th>
                  <th>Folio</th>
                  <th style={{ textAlign: "right" }}>Total neto</th>
                  <th style={{ textAlign: "right" }}>Líneas</th>
                  <th>Estado</th>
                  <th>OC</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recepciones.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 11 }}>{fmtFecha(r.created_at)}</td>
                    <td style={{ fontSize: 11 }}>{r.proveedor || "—"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.folio}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(r.costo_neto)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                      <LineaCount recepcionId={r.id!} />
                    </td>
                    <td style={{ fontSize: 10 }}>
                      <span style={{ padding: "2px 6px", borderRadius: 3, background: "var(--bg3)", color: "var(--txt2)" }}>
                        {r.estado}
                      </span>
                    </td>
                    <td>
                      <span style={{ padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 600, background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)" }}>
                        Sin OC
                      </span>
                    </td>
                    <td>
                      <button
                        onClick={() => setModalRec(r)}
                        style={{ padding: "4px 10px", fontSize: 10, fontWeight: 600, background: "var(--cyan)", color: "#000", border: "none", borderRadius: 4, cursor: "pointer" }}
                      >
                        Vincular a OC
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalRec && (
        <ModalVincular recepcion={modalRec} onClose={cerrarModal} onDone={onVinculado} />
      )}
    </div>
  );
}

function LineaCount({ recepcionId }: { recepcionId: string }) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    fetchRecepcionLineas(recepcionId).then(ls => setN(ls.length));
  }, [recepcionId]);
  return <span>{n ?? "…"}</span>;
}

// ============================================
// Modal de vinculación
// ============================================

function ModalVincular({
  recepcion,
  onClose,
  onDone,
}: {
  recepcion: DBRecepcion;
  onClose: () => void;
  onDone: () => void;
}) {
  const [recLineas, setRecLineas] = useState<DBRecepcionLinea[]>([]);
  const [ocsDisponibles, setOcsDisponibles] = useState<DBOrdenCompra[]>([]);
  const [anyProveedor, setAnyProveedor] = useState(false);
  const [selectedOC, setSelectedOC] = useState<DBOrdenCompra | null>(null);
  const [ocLineas, setOcLineas] = useState<DBOrdenCompraLinea[]>([]);
  // matching: recepcion_linea_id → oc_linea_id | null (si null, no vincula)
  const [matching, setMatching] = useState<Map<string, string | null>>(new Map());
  const [procesando, setProcesando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  // 1) Cargar líneas de la recepción + OCs candidatas
  useEffect(() => {
    let alive = true;
    (async () => {
      const [ls, ocs] = await Promise.all([
        fetchRecepcionLineas(recepcion.id!),
        fetchOrdenesAbiertasParaVincular(recepcion.proveedor, anyProveedor),
      ]);
      if (!alive) return;
      setRecLineas(ls);
      setOcsDisponibles(ocs);
    })();
    return () => { alive = false; };
  }, [recepcion, anyProveedor]);

  // 2) Al elegir OC, cargar sus líneas y auto-match por SKU
  useEffect(() => {
    if (!selectedOC) { setOcLineas([]); setMatching(new Map()); return; }
    let alive = true;
    (async () => {
      const ocL = await fetchOrdenCompraLineas(selectedOC.id!);
      if (!alive) return;
      setOcLineas(ocL);
      // auto-match
      const map = new Map<string, string | null>();
      for (const rl of recLineas) {
        const hit = ocL.find(ol => ol.sku_origen.toUpperCase() === (rl.sku || "").toUpperCase());
        map.set(rl.id!, hit ? hit.id! : null);
      }
      setMatching(map);
    })();
    return () => { alive = false; };
  }, [selectedOC, recLineas]);

  const totalRec = useMemo(
    () => recLineas.reduce((s, l) => s + (l.qty_recibida || 0) * (l.costo_unitario || 0), 0),
    [recLineas],
  );
  const totalOC = selectedOC ? selectedOC.total_neto || 0 : 0;
  const diffPct = totalOC > 0 ? Math.abs(totalRec - totalOC) / totalOC * 100 : 0;

  // Validaciones
  const fechaOC = selectedOC?.fecha_emision ? new Date(selectedOC.fecha_emision) : null;
  const fechaRec = recepcion.created_at ? new Date(recepcion.created_at) : null;
  const fechaInvalida = fechaOC && fechaRec && fechaRec < fechaOC;
  const lineasMarcadas = Array.from(matching.values()).filter(v => v !== null).length;

  const toggleMatch = useCallback((recLineId: string, ocLineId: string | null) => {
    setMatching(prev => {
      const next = new Map(prev);
      next.set(recLineId, ocLineId);
      return next;
    });
  }, []);

  const confirmar = useCallback(async () => {
    if (!selectedOC || lineasMarcadas === 0) return;
    setProcesando(true);
    setMensaje(null);
    try {
      const lineMapping: Record<string, string> = {};
      Array.from(matching.entries()).forEach(([recLineId, ocLineId]) => {
        if (ocLineId) lineMapping[recLineId] = ocLineId;
      });
      const res = await vincularRecepcionOC(recepcion.id!, selectedOC.id!, lineMapping);
      await insertAdminActionLog("vincular_recepcion_oc_v2", "recepciones", recepcion.id!, {
        oc_id: selectedOC.id,
        oc_numero: selectedOC.numero,
        lineas: Object.keys(lineMapping).length,
        estado_cabecera: res?.estado_cabecera,
      });
      setMensaje(`OK: ${res?.lineas_actualizadas || 0} líneas OC actualizadas, estado cabecera: ${res?.estado_cabecera}`);
      setTimeout(onDone, 800);
    } catch (e) {
      setMensaje(`Error: ${(e as Error).message || e}`);
    } finally {
      setProcesando(false);
    }
  }, [selectedOC, matching, lineasMarcadas, recepcion, onDone]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999, padding: 16 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--bg2)", borderRadius: 10, padding: 18, maxWidth: 1200, width: "100%", maxHeight: "90vh", overflowY: "auto", border: "1px solid var(--bg4)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Vincular recepción a OC</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {/* Panel izquierdo: recepción */}
          <div style={{ padding: 10, background: "var(--bg3)", borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>RECEPCIÓN</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {recepcion.proveedor} — Folio {recepcion.folio}
            </div>
            <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 4 }}>
              Fecha: {fmtFecha(recepcion.created_at)} · Estado: {recepcion.estado}
            </div>
            <div style={{ fontSize: 11, color: "var(--txt2)" }}>
              Total neto: <strong>{fmtMoney(recepcion.costo_neto)}</strong> · {recLineas.length} líneas
            </div>
          </div>

          {/* Panel derecho: seleccionar OC */}
          <div style={{ padding: 10, background: "var(--bg3)", borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>OC DESTINO</div>
            <select
              value={selectedOC?.id || ""}
              onChange={e => setSelectedOC(ocsDisponibles.find(oc => oc.id === e.target.value) || null)}
              style={{ width: "100%", padding: "5px 8px", fontSize: 12, background: "var(--bg4)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }}
            >
              <option value="">— Seleccionar OC abierta —</option>
              {ocsDisponibles.map(oc => (
                <option key={oc.id} value={oc.id}>
                  {oc.numero} — {fmtFecha(oc.fecha_emision)} — {fmtMoney(oc.total_neto)} ({oc.estado})
                </option>
              ))}
            </select>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 10, color: "var(--txt3)", cursor: "pointer" }}>
              <input type="checkbox" checked={anyProveedor} onChange={e => setAnyProveedor(e.target.checked)} />
              Mostrar todas las OCs abiertas (sin filtro proveedor)
            </label>
            {ocsDisponibles.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 6 }}>
                {anyProveedor
                  ? "No hay OCs en estado PENDIENTE/EN_TRANSITO/RECIBIDA_PARCIAL."
                  : `No hay OCs abiertas de "${recepcion.proveedor}". Marcá la casilla para ver todas.`}
              </div>
            )}
          </div>
        </div>

        {/* Tabla de matching */}
        {selectedOC && (
          <>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 6 }}>MATCHING DE LÍNEAS (auto por SKU)</div>
            <div style={{ overflowX: "auto", border: "1px solid var(--bg4)", borderRadius: 4, marginBottom: 10 }}>
              <table className="tbl" style={{ minWidth: 800 }}>
                <thead>
                  <tr>
                    <th>SKU recepción</th>
                    <th style={{ textAlign: "right" }}>Rec cant</th>
                    <th style={{ textAlign: "right" }}>Rec $</th>
                    <th>→ OC línea</th>
                    <th style={{ textAlign: "right" }}>OC cant</th>
                    <th style={{ textAlign: "right" }}>OC $</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {recLineas.map(rl => {
                    const ocLineId = matching.get(rl.id!) ?? null;
                    const ocL = ocLineas.find(ol => ol.id === ocLineId);
                    const sobreCumple = ocL && rl.qty_recibida > ocL.cantidad_pedida;
                    const pendiente = ocL && rl.qty_recibida < ocL.cantidad_pedida;
                    return (
                      <tr key={rl.id}>
                        <td className="mono" style={{ fontSize: 11 }}>{rl.sku}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{rl.qty_recibida}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(rl.costo_unitario)}</td>
                        <td>
                          <select
                            value={ocLineId || ""}
                            onChange={e => toggleMatch(rl.id!, e.target.value || null)}
                            style={{ width: "100%", padding: "3px 6px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 3 }}
                          >
                            <option value="">— sin match —</option>
                            {ocLineas.map(ol => (
                              <option key={ol.id} value={ol.id}>
                                {ol.sku_origen} ({ol.cantidad_pedida} pedidas)
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{ocL?.cantidad_pedida ?? "—"}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{ocL ? fmtMoney(ocL.costo_unitario) : "—"}</td>
                        <td style={{ fontSize: 10 }}>
                          {sobreCumple && <span style={{ color: "var(--amber)" }}>+sobrecumple</span>}
                          {pendiente && <span style={{ color: "var(--cyan)" }}>−{ocL!.cantidad_pedida - rl.qty_recibida} pend</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Warnings */}
            <div style={{ marginBottom: 10 }}>
              {fechaInvalida && (
                <div style={{ padding: "6px 10px", background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", borderRadius: 4, fontSize: 11, marginBottom: 4 }}>
                  ⚠ Fecha de recepción ({fmtFecha(recepcion.created_at)}) es anterior a la emisión de la OC ({fmtFecha(selectedOC.fecha_emision)}). Imposible.
                </div>
              )}
              {!fechaInvalida && diffPct > 10 && (
                <div style={{ padding: "6px 10px", background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)", borderRadius: 4, fontSize: 11, marginBottom: 4 }}>
                  ⚠ Diferencia de {diffPct.toFixed(1)}% entre totales (Rec: {fmtMoney(totalRec)} · OC: {fmtMoney(totalOC)})
                </div>
              )}
            </div>
          </>
        )}

        {mensaje && (
          <div style={{ padding: "6px 10px", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4, fontSize: 11, marginBottom: 10 }}>
            {mensaje}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "8px 16px", fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", borderRadius: 4, cursor: "pointer" }}>
            Cancelar
          </button>
          <button
            onClick={confirmar}
            disabled={!selectedOC || lineasMarcadas === 0 || procesando || !!fechaInvalida}
            style={{
              padding: "8px 16px", fontSize: 12, fontWeight: 700,
              background: !selectedOC || lineasMarcadas === 0 || !!fechaInvalida ? "var(--bg3)" : "var(--green)",
              color: !selectedOC || lineasMarcadas === 0 || !!fechaInvalida ? "var(--txt3)" : "#000",
              border: "none", borderRadius: 4,
              cursor: !selectedOC || lineasMarcadas === 0 || !!fechaInvalida ? "not-allowed" : "pointer",
            }}
          >
            {procesando ? "Procesando…" : `Confirmar vinculación (${lineasMarcadas} líneas)`}
          </button>
        </div>
      </div>
    </div>
  );
}
