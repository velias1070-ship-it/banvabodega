"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchDiscrepanciasGlobal, fetchProductos, fetchRecepciones } from "@/lib/db";
import type { DBDiscrepanciaCosto, DBProduct, DBRecepcion } from "@/lib/db";
import { aprobarNuevoCosto, rechazarNuevoCosto, marcarPendienteNC, congelarCostoDiscrepancia } from "@/lib/store";
import type { CongelarCostoPreview } from "@/lib/store";

// ============================================
// Helpers
// ============================================

const fmtInt = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) =>
  n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : (n >= 0 ? "+" : "") + Number(n).toFixed(1) + "%";
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
};
const daysSince = (d: string | null | undefined): number => {
  if (!d) return 0;
  const ms = Date.now() - new Date(d).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
};

const ESTADO_COLORS: Record<string, string> = {
  PENDIENTE: "var(--amber)",
  APROBADO: "var(--green)",
  RECHAZADO: "var(--red)",
  PENDIENTE_NC: "var(--cyan)",
};

type Estado = "PENDIENTE" | "APROBADO" | "RECHAZADO" | "PENDIENTE_NC";
type EstadoFiltro = "TODAS" | Estado;
type AntiguedadFiltro = "TODAS" | "7d" | "15d" | "30d" | "60d";

type Row = DBDiscrepanciaCosto & {
  _sku_nombre: string;
  _sku_proveedor: string;
  _folio: string;
  _proveedor_rec: string;
  _fecha_rec: string | null;
  _dias_abierta: number;
};

// ============================================
// Component
// ============================================

export default function AdminDiscrepancias() {
  const [discs, setDiscs] = useState<DBDiscrepanciaCosto[]>([]);
  const [productos, setProductos] = useState<Map<string, DBProduct>>(new Map());
  const [recepciones, setRecepciones] = useState<Map<string, DBRecepcion>>(new Map());
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);
  const [congelarModal, setCongelarModal] = useState<{ row: Row; preview: CongelarCostoPreview | null; costoInput: string } | null>(null);

  // Filtros
  const [filtroEstado, setFiltroEstado] = useState<EstadoFiltro>("PENDIENTE");
  const [filtroAntiguedad, setFiltroAntiguedad] = useState<AntiguedadFiltro>("TODAS");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");
  const [search, setSearch] = useState("");

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p, r] = await Promise.all([
        fetchDiscrepanciasGlobal(),
        fetchProductos(),
        fetchRecepciones(),
      ]);
      setDiscs(d);
      setProductos(new Map(p.map(x => [x.sku.toUpperCase().trim(), x])));
      setRecepciones(new Map(r.map(x => [x.id!, x])));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Rows enriquecidas con producto + recepción
  const rows: Row[] = useMemo(() => {
    return discs.map(d => {
      const p = productos.get(d.sku.toUpperCase().trim());
      const r = recepciones.get(d.recepcion_id);
      return {
        ...d,
        _sku_nombre: p?.nombre || "",
        _sku_proveedor: p?.proveedor || "",
        _folio: r?.folio || "",
        _proveedor_rec: r?.proveedor || "",
        _fecha_rec: r?.created_at || null,
        _dias_abierta: daysSince(d.created_at),
      };
    });
  }, [discs, productos, recepciones]);

  // Lista de proveedores únicos (desde recepciones de las discrepancias)
  const proveedores = useMemo(() => {
    const s = new Set<string>();
    for (const row of rows) if (row._proveedor_rec) s.add(row._proveedor_rec);
    return Array.from(s).sort();
  }, [rows]);

  // Aplicar filtros
  const filtered: Row[] = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter(row => {
      if (filtroEstado !== "TODAS" && row.estado !== filtroEstado) return false;
      if (filtroProveedor !== "todos" && row._proveedor_rec !== filtroProveedor) return false;
      if (filtroAntiguedad !== "TODAS") {
        const minDias = filtroAntiguedad === "7d" ? 7
          : filtroAntiguedad === "15d" ? 15
          : filtroAntiguedad === "30d" ? 30
          : 60;
        if (row._dias_abierta < minDias) return false;
      }
      if (q) {
        const hit =
          row.sku.toUpperCase().includes(q) ||
          row._sku_nombre.toUpperCase().includes(q) ||
          row._folio.toUpperCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, filtroEstado, filtroProveedor, filtroAntiguedad, search]);

  // KPIs
  const kpis = useMemo(() => {
    const pendientes = rows.filter(r => r.estado === "PENDIENTE");
    const aprobadas = rows.filter(r => r.estado === "APROBADO");
    const rechazadas = rows.filter(r => r.estado === "RECHAZADO");
    const pend_7d = pendientes.filter(r => r._dias_abierta >= 7).length;
    const pend_30d = pendientes.filter(r => r._dias_abierta >= 30).length;
    const impacto = pendientes.reduce((a, r) => a + Math.abs(r.diferencia || 0), 0);
    return {
      total: rows.length,
      pendientes: pendientes.length,
      aprobadas: aprobadas.length,
      rechazadas: rechazadas.length,
      pend_7d,
      pend_30d,
      impacto,
    };
  }, [rows]);

  const doAprobar = async (row: Row) => {
    const nuevo = prompt(
      `Aprobar nuevo costo para ${row.sku}\n\nCosto diccionario (catálogo): ${fmtMoney(row.costo_diccionario)}\nCosto factura (lo tipeado): ${fmtMoney(row.costo_factura)}\n\nIngrese el costo a aprobar (normalmente el de factura):`,
      String(row.costo_factura),
    );
    if (nuevo === null) return;
    const n = Number(nuevo);
    if (!Number.isFinite(n) || n <= 0) {
      alert("Costo inválido");
      return;
    }
    setActioning(row.id!);
    try {
      await aprobarNuevoCosto(row.id!, row.sku, n);
      await cargar();
    } catch (e) {
      alert("Error al aprobar: " + (e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  };

  const doRechazar = async (row: Row) => {
    const nota = prompt(
      `Rechazar discrepancia de ${row.sku}\n\nMotivo del rechazo (factura mal emitida, esperando NC, etc):`,
      "Error de proveedor - reclamar",
    );
    if (nota === null) return;
    setActioning(row.id!);
    try {
      await rechazarNuevoCosto(row.id!, nota);
      await cargar();
    } catch (e) {
      alert("Error al rechazar: " + (e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  };

  const doPendienteNC = async (row: Row) => {
    const sugerido = row.costo_diccionario && row.costo_diccionario > 0
      ? String(row.costo_diccionario)
      : String(Math.round((row.costo_factura || 0) / 2));
    const costo = prompt(
      `⏳ Esperando NC del proveedor — ${row.sku}\n\n`
      + `Costo facturado (incorrecto): ${fmtMoney(row.costo_factura)}\n`
      + `Costo histórico (referencia): ${fmtMoney(row.costo_diccionario)}\n\n`
      + `Ingrese el costo REAL esperado luego de la NC:`,
      sugerido,
    );
    if (costo === null) return;
    const n = Number(costo);
    if (!Number.isFinite(n) || n <= 0) {
      alert("Costo inválido");
      return;
    }
    const notas = prompt(
      `Notas obligatorias (qué pasó, cuándo confirmó el proveedor la NC):`,
      `Idetex confirmó NC por diferencia de ${fmtMoney((row.costo_factura || 0) - n)}/ud el ${new Date().toLocaleDateString("es-CL")}. Esperando emisión.`,
    );
    if (!notas || notas.trim().length === 0) {
      alert("Las notas son obligatorias");
      return;
    }
    const diffPorUnidad = (row.costo_factura || 0) - n;
    const confirma = window.confirm(
      `Confirmar acción:\n\n`
      + `• Marca discrepancia como PENDIENTE_NC\n`
      + `• Override WAC: ${fmtMoney(row.costo_factura)} → ${fmtMoney(n)}\n`
      + `• Diferencia esperada: ${fmtMoney(diffPorUnidad)}/ud\n`
      + `• Audit log con motivo override_pre_nc\n\n`
      + `¿Continuar?`
    );
    if (!confirma) return;
    setActioning(row.id!);
    try {
      const res = await marcarPendienteNC(row.id!, row.sku, n, notas);
      alert(`WAC actualizado: ${fmtMoney(res.wac_anterior)} → ${fmtMoney(res.wac_nuevo)}`);
      await cargar();
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  };

  const abrirCongelar = async (row: Row) => {
    const sugerido = row.costo_diccionario && row.costo_diccionario > 0 ? row.costo_diccionario : 0;
    setCongelarModal({ row, preview: null, costoInput: String(sugerido) });
  };

  const previewCongelar = async () => {
    if (!congelarModal) return;
    const n = Number(congelarModal.costoInput);
    if (!Number.isFinite(n) || n <= 0) { alert("Costo inválido"); return; }
    setActioning(congelarModal.row.id!);
    try {
      const preview = await congelarCostoDiscrepancia(congelarModal.row.id!, n, true);
      setCongelarModal({ ...congelarModal, preview });
    } catch (e) {
      alert("Error preview: " + (e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  };

  const confirmarCongelar = async () => {
    if (!congelarModal || !congelarModal.preview) return;
    const n = Number(congelarModal.costoInput);
    if (!window.confirm(`Aplicar costo ${fmtMoney(n)} al WAC y recomputar ${congelarModal.preview.ventasAfectadas} ventas?\n\nLa discrepancia queda PENDIENTE.`)) return;
    setActioning(congelarModal.row.id!);
    try {
      await congelarCostoDiscrepancia(congelarModal.row.id!, n, false);
      setCongelarModal(null);
      await cargar();
      alert("Costo congelado y ventas recomputadas.");
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : e));
    } finally {
      setActioning(null);
    }
  };

  if (loading) return <div className="card" style={{ padding: 16 }}>Cargando discrepancias…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>💰 Discrepancias de costo</h2>
        <button
          onClick={cargar}
          style={{ padding: "6px 14px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)" }}
        >
          ⟳ Recargar
        </button>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 12 }}>
        <div className="kpi" style={{ borderLeft: "3px solid var(--amber)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Pendientes</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{kpis.pendientes}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--red)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Pend &gt; 7d</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--red)" }}>{kpis.pend_7d}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--red)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Pend &gt; 30d</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--red)" }}>{kpis.pend_30d}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Impacto pend.</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)" }}>{fmtMoney(kpis.impacto)}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--green)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Aprobadas</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--green)" }}>{kpis.aprobadas}</div>
        </div>
        <div className="kpi">
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Rechazadas</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--txt2)" }}>{kpis.rechazadas}</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase" }}>Estado</div>
            <select
              value={filtroEstado}
              onChange={e => setFiltroEstado(e.target.value as EstadoFiltro)}
              className="form-input"
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="TODAS">Todas</option>
              <option value="PENDIENTE">Pendientes</option>
              <option value="APROBADO">Aprobadas</option>
              <option value="RECHAZADO">Rechazadas</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase" }}>Antigüedad mín.</div>
            <select
              value={filtroAntiguedad}
              onChange={e => setFiltroAntiguedad(e.target.value as AntiguedadFiltro)}
              className="form-input"
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="TODAS">Todas</option>
              <option value="7d">&gt; 7 días</option>
              <option value="15d">&gt; 15 días</option>
              <option value="30d">&gt; 30 días</option>
              <option value="60d">&gt; 60 días</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase" }}>Proveedor</div>
            <select
              value={filtroProveedor}
              onChange={e => setFiltroProveedor(e.target.value)}
              className="form-input"
              style={{ padding: "6px 10px", fontSize: 12 }}
            >
              <option value="todos">Todos</option>
              {proveedores.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4, textTransform: "uppercase" }}>Buscar</div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="SKU, nombre o folio"
              className="form-input"
              style={{ padding: "6px 10px", fontSize: 12, width: "100%" }}
            />
          </div>
          <div style={{ alignSelf: "flex-end", fontSize: 11, color: "var(--txt3)" }}>
            {filtered.length} de {rows.length}
          </div>
        </div>
      </div>

      {/* Tabla */}
      {filtered.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)" }}>
          Sin discrepancias con los filtros actuales.
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>SKU</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Producto</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Recepción</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Proveedor</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>Costo dicc</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>Costo factura</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>Diferencia</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }}>%</th>
                <th style={{ textAlign: "center", padding: "8px 10px" }}>Días</th>
                <th style={{ textAlign: "center", padding: "8px 10px" }}>Estado</th>
                <th style={{ textAlign: "left", padding: "8px 10px" }}>Notas</th>
                <th style={{ textAlign: "center", padding: "8px 10px" }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const isWorking = actioning === row.id;
                const pctColor = (row.porcentaje || 0) > 0 ? "var(--red)" : "var(--green)";
                return (
                  <tr key={row.id} style={{ borderTop: "1px solid var(--bg4)" }}>
                    <td className="mono" style={{ padding: "8px 10px" }}>{row.sku}</td>
                    <td style={{ padding: "8px 10px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row._sku_nombre || "—"}
                    </td>
                    <td className="mono" style={{ padding: "8px 10px" }}>{row._folio || "—"}</td>
                    <td style={{ padding: "8px 10px" }}>{row._proveedor_rec || "—"}</td>
                    <td className="mono" style={{ padding: "8px 10px", textAlign: "right" }}>{fmtMoney(row.costo_diccionario)}</td>
                    <td className="mono" style={{ padding: "8px 10px", textAlign: "right" }}>{fmtMoney(row.costo_factura)}</td>
                    <td className="mono" style={{ padding: "8px 10px", textAlign: "right", color: pctColor, fontWeight: 600 }}>
                      {row.diferencia >= 0 ? "+" : ""}{fmtInt(row.diferencia)}
                    </td>
                    <td className="mono" style={{ padding: "8px 10px", textAlign: "right", color: pctColor, fontWeight: 600 }}>
                      {fmtPct(row.porcentaje)}
                    </td>
                    <td className="mono" style={{ padding: "8px 10px", textAlign: "center", color: row._dias_abierta >= 30 ? "var(--red)" : row._dias_abierta >= 7 ? "var(--amber)" : "var(--txt2)" }}>
                      {row._dias_abierta}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "center" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLORS[row.estado] || "var(--txt2)", padding: "2px 8px", borderRadius: 4, background: "var(--bg3)", border: `1px solid ${ESTADO_COLORS[row.estado] || "var(--bg4)"}` }}>
                        {row.estado}
                      </span>
                    </td>
                    <td style={{ padding: "8px 10px", maxWidth: 180, fontSize: 10, color: "var(--txt3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.notas || (row.resuelto_at ? fmtDate(row.resuelto_at) : "—")}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                      {row.estado === "PENDIENTE" ? (
                        <>
                          <button
                            disabled={isWorking}
                            onClick={() => doAprobar(row)}
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--green)", color: "#0a0e17", fontSize: 10, fontWeight: 700, border: "none", marginRight: 4, cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            Aprobar
                          </button>
                          <button
                            disabled={isWorking}
                            onClick={() => doPendienteNC(row)}
                            title="Esperando NC del proveedor: corrige WAC al costo real esperado y deja la discrepancia abierta"
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--cyan)", fontSize: 10, fontWeight: 700, border: "1px solid var(--cyan)", marginRight: 4, cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            ⏳ Esperando NC
                          </button>
                          <button
                            disabled={isWorking}
                            onClick={() => abrirCongelar(row)}
                            title="Congela el WAC al costo del diccionario (o uno manual) y recomputa márgenes de ventas post-recepción. La discrepancia queda PENDIENTE."
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--blue)", fontSize: 10, fontWeight: 700, border: "1px solid var(--blue)", marginRight: 4, cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            🔒 Congelar
                          </button>
                          <button
                            disabled={isWorking}
                            onClick={() => doRechazar(row)}
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--red)", fontSize: 10, fontWeight: 700, border: "1px solid var(--red)", cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            Rechazar
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--txt3)" }}>
                          {row.resuelto_por ? `${row.resuelto_por}` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {congelarModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => !actioning && setCongelarModal(null)}>
          <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 720, width: "100%", maxHeight: "85vh", overflow: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>🔒 Congelar costo — {congelarModal.row.sku}</h3>
            <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 14 }}>
              Aplica un costo &quot;confiable&quot; al WAC (override de movimientos) y recomputa márgenes de ventas posteriores a la recepción. La discrepancia queda PENDIENTE.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14, fontSize: 11 }}>
              <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                <div style={{ color: "var(--txt3)", fontSize: 10 }}>Diccionario</div>
                <div className="mono" style={{ fontWeight: 700 }}>{fmtMoney(congelarModal.row.costo_diccionario)}</div>
              </div>
              <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                <div style={{ color: "var(--txt3)", fontSize: 10 }}>Facturado (en duda)</div>
                <div className="mono" style={{ fontWeight: 700, color: "var(--amber)" }}>{fmtMoney(congelarModal.row.costo_factura)}</div>
              </div>
              <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                <div style={{ color: "var(--txt3)", fontSize: 10 }}>Recepción</div>
                <div className="mono" style={{ fontWeight: 600 }}>{congelarModal.row._folio || "—"}</div>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Costo a aplicar al WAC (neto, sin IVA)</label>
              <input type="number" value={congelarModal.costoInput}
                onChange={e => setCongelarModal({ ...congelarModal, costoInput: e.target.value, preview: null })}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 14 }} />
            </div>
            {!congelarModal.preview ? (
              <button disabled={actioning === congelarModal.row.id}
                onClick={previewCongelar}
                style={{ width: "100%", padding: "10px 16px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 700, fontSize: 12, border: "1px solid var(--blueBd)", cursor: "pointer" }}>
                {actioning === congelarModal.row.id ? "Calculando…" : "Previsualizar impacto"}
              </button>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10, fontSize: 11 }}>
                  <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                    <div style={{ color: "var(--txt3)", fontSize: 10 }}>WAC</div>
                    <div className="mono">{fmtMoney(congelarModal.preview.wacAnterior)} → <span style={{ color: "var(--green)" }}>{fmtMoney(congelarModal.preview.wacSimulado)}</span></div>
                  </div>
                  <div style={{ padding: 8, background: "var(--bg3)", borderRadius: 6 }}>
                    <div style={{ color: "var(--txt3)", fontSize: 10 }}>Ventas afectadas</div>
                    <div className="mono" style={{ fontWeight: 700 }}>
                      {congelarModal.preview.ventasAfectadas}
                      <span style={{ marginLeft: 8, fontSize: 10, color: congelarModal.preview.margenDelta >= 0 ? "var(--green)" : "var(--red)" }}>
                        Δ margen: {congelarModal.preview.margenDelta >= 0 ? "+" : ""}{fmtMoney(congelarModal.preview.margenDelta)}
                      </span>
                    </div>
                  </div>
                </div>
                {congelarModal.preview.detalles.length > 0 && (
                  <div style={{ maxHeight: 280, overflow: "auto", border: "1px solid var(--bg4)", borderRadius: 6, marginBottom: 12 }}>
                    <table style={{ width: "100%", fontSize: 10, borderCollapse: "collapse" }}>
                      <thead style={{ background: "var(--bg3)", position: "sticky", top: 0 }}>
                        <tr>
                          <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--txt3)" }}>Orden</th>
                          <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--txt3)" }}>SKU venta</th>
                          <th style={{ padding: "6px 8px", textAlign: "left", color: "var(--txt3)" }}>Fecha</th>
                          <th style={{ padding: "6px 8px", textAlign: "right", color: "var(--txt3)" }}>Costo ant→nuevo</th>
                          <th style={{ padding: "6px 8px", textAlign: "right", color: "var(--txt3)" }}>Margen ant→nuevo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {congelarModal.preview.detalles.map(d => (
                          <tr key={d.order_id + "/" + d.sku_venta} style={{ borderTop: "1px solid var(--bg4)" }}>
                            <td className="mono" style={{ padding: "5px 8px" }}>{d.order_id}</td>
                            <td className="mono" style={{ padding: "5px 8px" }}>{d.sku_venta}</td>
                            <td style={{ padding: "5px 8px", color: "var(--txt3)" }}>{fmtDate(d.fecha)}</td>
                            <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>
                              {fmtMoney(d.costo_anterior)} → <span style={{ color: d.costo_nuevo < d.costo_anterior ? "var(--green)" : "var(--red)" }}>{fmtMoney(d.costo_nuevo)}</span>
                            </td>
                            <td className="mono" style={{ padding: "5px 8px", textAlign: "right" }}>
                              {fmtMoney(d.margen_anterior)} → <span style={{ color: d.margen_nuevo >= d.margen_anterior ? "var(--green)" : "var(--red)" }}>{fmtMoney(d.margen_nuevo)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setCongelarModal(null)} disabled={!!actioning}
                    style={{ padding: "8px 14px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                    Cancelar
                  </button>
                  <button onClick={confirmarCongelar} disabled={!!actioning}
                    style={{ padding: "8px 14px", borderRadius: 6, background: "var(--blue)", color: "#0a0e17", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer" }}>
                    {actioning ? "Aplicando…" : "Aplicar y recomputar"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
