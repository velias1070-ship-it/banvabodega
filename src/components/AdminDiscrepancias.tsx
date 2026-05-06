"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchDiscrepanciasGlobal, fetchProductos, fetchRecepciones, fetchRcvCompras, fetchEmpresaDefault, getSupabase } from "@/lib/db";
import type { DBDiscrepanciaCosto, DBProduct, DBRecepcion, DBRcvCompra, DBRecepcionLinea } from "@/lib/db";
import { aprobarNuevoCosto } from "@/lib/store";
import DiscrepanciaActionsModal from "./DiscrepanciaActionsModal";

// Normaliza nombre de proveedor/razon social para match flexible
const normProv = (s: string): string => (s || "").toUpperCase().trim()
  .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
  .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

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
  const [lineas, setLineas] = useState<Map<string, DBRecepcionLinea>>(new Map()); // key = linea_id
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<string | null>(null);
  const [actionModal, setActionModal] = useState<{ row: Row; modo: "aprobar" | "rechazar" | "revertir" } | null>(null);
  const [ncs, setNcs] = useState<DBRcvCompra[]>([]);
  const [ncBulkOpen, setNcBulkOpen] = useState<string | null>(null); // nc.id abierto para confirmar cierre

  // Filtros
  const [filtroEstado, setFiltroEstado] = useState<EstadoFiltro>("PENDIENTE");
  const [filtroAntiguedad, setFiltroAntiguedad] = useState<AntiguedadFiltro>("TODAS");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");
  const [search, setSearch] = useState("");

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p, r, empresa] = await Promise.all([
        fetchDiscrepanciasGlobal(),
        fetchProductos(),
        fetchRecepciones(),
        fetchEmpresaDefault(),
      ]);
      setDiscs(d);
      setProductos(new Map(p.map(x => [x.sku.toUpperCase().trim(), x])));
      setRecepciones(new Map(r.map(x => [x.id!, x])));
      // Traer líneas de recepción de las discrepancias para calcular Δ esperado real
      const lineaIds = Array.from(new Set(d.map(x => x.linea_id).filter(Boolean))) as string[];
      if (lineaIds.length > 0) {
        const sb = getSupabase();
        if (sb) {
          const lineasMap = new Map<string, DBRecepcionLinea>();
          for (let i = 0; i < lineaIds.length; i += 500) {
            const { data: lns } = await sb.from("recepcion_lineas")
              .select("*").in("id", lineaIds.slice(i, i + 500));
            for (const l of (lns || []) as DBRecepcionLinea[]) lineasMap.set(l.id!, l);
          }
          setLineas(lineasMap);
        }
      }
      if (empresa?.id) {
        const rcv = await fetchRcvCompras(empresa.id);
        setNcs(rcv.filter(x => x.tipo_doc === 61));
      }
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

  // Acciones unificadas (Chunk 6): abren el modal compartido
  const abrir = (row: Row, modo: "aprobar" | "rechazar" | "revertir") =>
    setActionModal({ row, modo });

  // Cross-match NCs ↔ recepciones con discrepancias PENDIENTES
  const ncsLinkables = useMemo(() => {
    type NcMatch = {
      nc: DBRcvCompra;
      recepcionId: string;
      folioFactura: string;
      proveedorRec: string;
      discrepancias: Row[];
    };
    const out: NcMatch[] = [];
    for (const nc of ncs) {
      if (!nc.factura_ref_folio) continue;
      const provNc = normProv(nc.razon_social || "");
      // Buscar recepcion con folio=factura_ref_folio y proveedor matcheando razon_social
      const entries = Array.from(recepciones.entries());
      for (const [recId, rec] of entries) {
        if (rec.folio !== nc.factura_ref_folio) continue;
        if (normProv(rec.proveedor || "") !== provNc) continue;
        const pend = rows.filter(r => r.recepcion_id === recId && r.estado === "PENDIENTE");
        if (pend.length === 0) continue;
        out.push({ nc, recepcionId: recId, folioFactura: rec.folio, proveedorRec: rec.proveedor || "", discrepancias: pend });
      }
    }
    return out;
  }, [ncs, recepciones, rows]);

  const cerrarConNC = async (match: typeof ncsLinkables[number]) => {
    if (!match.discrepancias.length) return;
    const notas = `NC ${match.nc.nro_doc} del ${match.nc.fecha_docto?.slice(0,10) || ""} por ${fmtMoney(match.nc.monto_total)}`;
    setActioning(match.nc.id || match.recepcionId);
    try {
      for (const d of match.discrepancias) {
        const prod = productos.get(d.sku);
        const wac = prod?.costo_promedio || 0;
        const costoFinal = wac > 0 ? wac : d.costo_diccionario || d.costo_factura;
        await aprobarNuevoCosto(d.id!, d.sku, Number(costoFinal));
      }
      // Marcar notas de las que se cerraron con esta NC (post-approve)
      const sb = (await import("@/lib/supabase")).getSupabase();
      if (sb) {
        await sb.from("discrepancias_costo")
          .update({ notas })
          .in("id", match.discrepancias.map(d => d.id!));
      }
      setNcBulkOpen(null);
      await cargar();
      alert(`Cerradas ${match.discrepancias.length} discrepancias con NC ${match.nc.nro_doc}`);
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

      {/* NCs Recibidas con match a discrepancias pendientes */}
      {ncsLinkables.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>📋 NCs recibidas con discrepancias pendientes ({ncsLinkables.length})</h3>
            <span style={{ fontSize: 10, color: "var(--txt3)" }}>Match automático rcv_compras ↔ recepciones</span>
          </div>
          {ncsLinkables.map(m => {
            // Δ esperado = Σ (diferencia_unitaria × qty_recibida) × 1.19 (IVA)
            // para comparar contra NC.monto_total (bruto del SII).
            const deltaNeto = m.discrepancias.reduce((s, d) => {
              const linea = lineas.get(d.linea_id);
              const qty = linea?.qty_recibida || 0;
              return s + Math.abs((d.diferencia || 0) * qty);
            }, 0);
            const deltaEsperado = Math.round(deltaNeto * 1.19);
            const ncMonto = Number(m.nc.monto_total) || 0;
            const coincide = Math.abs(deltaEsperado - ncMonto) < 100;
            const isWorking = actioning === (m.nc.id || m.recepcionId);
            return (
              <div key={(m.nc.id || "") + "-" + m.recepcionId} style={{ padding: 10, borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>
                      <span className="mono">NC #{m.nc.nro_doc}</span>
                      <span style={{ color: "var(--txt3)", marginLeft: 8, fontSize: 11 }}>{fmtDate(m.nc.fecha_docto)}</span>
                      <span style={{ marginLeft: 8, color: "var(--cyan)" }}>{fmtMoney(ncMonto)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                      {m.proveedorRec} · ref factura <span className="mono">{m.folioFactura}</span>
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      <span style={{ color: "var(--amber)", fontWeight: 600 }}>{m.discrepancias.length} discrepancias PENDIENTES</span>
                      <span style={{ color: "var(--txt3)", marginLeft: 8 }}>· Δ esperado: {fmtMoney(deltaEsperado)}</span>
                      <span style={{ marginLeft: 8, fontSize: 10, color: coincide ? "var(--green)" : "var(--amber)" }}>
                        {coincide ? "✓ coincide con NC" : "⚠ no coincide con NC"}
                      </span>
                    </div>
                  </div>
                  <button
                    disabled={isWorking}
                    onClick={() => {
                      const skus = m.discrepancias.map(d => d.sku).join(", ");
                      if (!window.confirm(
                        `Cerrar ${m.discrepancias.length} discrepancias con NC ${m.nc.nro_doc}?\n\n`
                        + `SKUs: ${skus.slice(0, 150)}${skus.length > 150 ? "..." : ""}\n\n`
                        + `Cada una se aprobará con el WAC actual (lo que ya congelaste).\n`
                        + `Notas: "NC ${m.nc.nro_doc}..."`
                      )) return;
                      cerrarConNC(m);
                    }}
                    style={{ padding: "6px 14px", borderRadius: 6, background: "var(--cyan)", color: "#0a0e17", fontWeight: 700, fontSize: 11, border: "none", cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                  >
                    {isWorking ? "Cerrando..." : "Cerrar con NC"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
                      {row.estado === "PENDIENTE" && (
                        <>
                          <button
                            disabled={isWorking}
                            onClick={() => abrir(row, "aprobar")}
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--green)", color: "#0a0e17", fontSize: 10, fontWeight: 700, border: "none", marginRight: 4, cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            ✅ Aprobar
                          </button>
                          <button
                            disabled={isWorking}
                            onClick={() => abrir(row, "rechazar")}
                            style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--red)", fontSize: 10, fontWeight: 700, border: "1px solid var(--red)", cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                          >
                            ❌ Rechazar
                          </button>
                        </>
                      )}
                      {row.estado === "APROBADO" && (
                        <button
                          disabled={isWorking}
                          onClick={() => abrir(row, "revertir")}
                          title="Restaura el precio_neto al snapshot, recalcula WAC y deja la disc en PENDIENTE."
                          style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--amber)", fontSize: 10, fontWeight: 700, border: "1px solid var(--amberBd)", cursor: isWorking ? "wait" : "pointer", opacity: isWorking ? 0.5 : 1 }}
                        >
                          ↩ Revertir aprobación
                        </button>
                      )}
                      {row.estado !== "PENDIENTE" && row.estado !== "APROBADO" && (
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

      {actionModal && (
        <DiscrepanciaActionsModal
          modo={actionModal.modo}
          discId={actionModal.row.id!}
          sku={actionModal.row.sku}
          costoFactura={actionModal.row.costo_factura}
          costoCatalogo={actionModal.row.costo_diccionario}
          onCerrar={() => setActionModal(null)}
          onResuelto={cargar}
        />
      )}
    </div>
  );
}
