"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchEmpresaDefault, fetchRcvCompras, fetchRecepciones, fetchOrdenesCompra,
  fetchDiscrepanciasGlobal,
} from "@/lib/db";
import type { DBRcvCompra, DBRecepcion, DBOrdenCompra, DBDiscrepanciaCosto } from "@/lib/db";

const fmtInt = (n: number | null | undefined) => n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" });
};
const normProv = (s: string): string => (s || "").toUpperCase().trim()
  .replace(/\s+(S\.?A\.?|SPA|LTDA\.?|LIMITADA|SRL|EIRL)\.?$/i, "")
  .replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

const TIPO_DOC: Record<number, string> = {
  33: "FC", 34: "FCE", 46: "FC", 52: "GUIA", 56: "ND", 61: "NC", 71: "BHE",
};

type SubTab = "facturas" | "ncs" | "sin_factura";

export default function AdminConciliacionDocs() {
  const [loading, setLoading] = useState(true);
  const [rcv, setRcv] = useState<DBRcvCompra[]>([]);
  const [recepciones, setRecepciones] = useState<DBRecepcion[]>([]);
  const [ocs, setOcs] = useState<DBOrdenCompra[]>([]);
  const [discs, setDiscs] = useState<DBDiscrepanciaCosto[]>([]);
  const [periodoFiltro, setPeriodoFiltro] = useState<string>(new Date().toISOString().slice(0, 7));
  const [subTab, setSubTab] = useState<SubTab>("facturas");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const empresa = await fetchEmpresaDefault();
      const [rcvData, recData, ocData, dData] = await Promise.all([
        empresa?.id ? fetchRcvCompras(empresa.id) : Promise.resolve([]),
        fetchRecepciones(),
        fetchOrdenesCompra(),
        fetchDiscrepanciasGlobal(),
      ]);
      setRcv(rcvData);
      setRecepciones(recData);
      setOcs(ocData);
      setDiscs(dData);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const toggleExp = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  // Filtrar por periodo (YYYY-MM)
  const rcvPeriodo = useMemo(() => rcv.filter(r => {
    if (!r.fecha_docto) return false;
    return r.fecha_docto.slice(0, 7) === periodoFiltro;
  }), [rcv, periodoFiltro]);

  const recPeriodo = useMemo(() => recepciones.filter(r => {
    const d = r.created_at || "";
    return d.slice(0, 7) === periodoFiltro && r.estado !== "ANULADA";
  }), [recepciones, periodoFiltro]);

  // Map de recepción por folio+proveedor normalizado
  const recByFolio = useMemo(() => {
    const m = new Map<string, DBRecepcion[]>();
    for (const r of recPeriodo) {
      if (!r.folio) continue;
      const key = `${r.folio}|${normProv(r.proveedor || "")}`;
      const arr = m.get(key) || [];
      arr.push(r);
      m.set(key, arr);
    }
    return m;
  }, [recPeriodo]);

  // Map de NC por folio factura de ref
  const ncByFacturaRef = useMemo(() => {
    const m = new Map<string, DBRcvCompra[]>();
    for (const r of rcv) {
      if (r.tipo_doc !== 61 || !r.factura_ref_folio) continue;
      const key = `${r.factura_ref_folio}|${normProv(r.razon_social || "")}`;
      const arr = m.get(key) || [];
      arr.push(r);
      m.set(key, arr);
    }
    return m;
  }, [rcv]);

  // Enriquecer facturas con matches
  type FacturaRow = {
    rcv: DBRcvCompra;
    recepciones: DBRecepcion[];
    ncs: DBRcvCompra[];
    ocNumero: string | null;
    discrepancias: DBDiscrepanciaCosto[];
  };
  const facturasEnriched: FacturaRow[] = useMemo(() => {
    const onlyFacturas = rcvPeriodo.filter(r => r.tipo_doc === 33 || r.tipo_doc === 34 || r.tipo_doc === 46);
    const enriched = onlyFacturas.map(rc => {
      const key = `${rc.nro_doc}|${normProv(rc.razon_social || "")}`;
      const recs = recByFolio.get(key) || [];
      const ncs = ncByFacturaRef.get(key) || [];
      const oc = recs[0]?.orden_compra_id
        ? ocs.find(o => o.id === recs[0].orden_compra_id) : undefined;
      const recIds = recs.map(r => r.id).filter(Boolean) as string[];
      const ds = discs.filter(d => recIds.includes(d.recepcion_id) && d.estado === "PENDIENTE");
      return {
        rcv: rc, recepciones: recs, ncs,
        ocNumero: oc?.numero || null,
        discrepancias: ds,
      };
    });
    // Solo mostrar las que matchean con al menos una recepción (inventario).
    // Facturas de servicios/honorarios/otros gastos se excluyen.
    return enriched.filter(f => f.recepciones.length > 0);
  }, [rcvPeriodo, recByFolio, ncByFacturaRef, ocs, discs]);

  // NCs del período — solo las que linkean a una recepción (inventario)
  const ncsRows: FacturaRow[] = useMemo(() => {
    const ncs = rcvPeriodo.filter(r => r.tipo_doc === 61);
    const enriched = ncs.map(nc => {
      const key = nc.factura_ref_folio
        ? `${nc.factura_ref_folio}|${normProv(nc.razon_social || "")}` : "";
      const recs = key ? (recByFolio.get(key) || []) : [];
      const recIds = recs.map(r => r.id).filter(Boolean) as string[];
      const ds = discs.filter(d => recIds.includes(d.recepcion_id) && d.estado === "PENDIENTE");
      return { rcv: nc, recepciones: recs, ncs: [], ocNumero: null, discrepancias: ds };
    });
    return enriched.filter(n => n.recepciones.length > 0);
  }, [rcvPeriodo, recByFolio, discs]);

  // Recepciones sin factura en RCV
  const recSinFactura = useMemo(() => {
    return recPeriodo.filter(r => {
      if (!r.folio) return true;
      const existe = rcvPeriodo.some(rc =>
        rc.tipo_doc === 33 && rc.nro_doc === r.folio &&
        normProv(rc.razon_social || "") === normProv(r.proveedor || "")
      );
      return !existe;
    });
  }, [recPeriodo, rcvPeriodo]);

  // KPIs — solo inventario (facturas/NCs ya filtradas)
  const kpis = useMemo(() => {
    const facs = facturasEnriched; // ya filtrado a las con recepción
    const totalFacturado = facs.reduce((s, f) => s + (Number(f.rcv.monto_total) || 0), 0);
    const conDiscrepancia = facs.filter(f => f.discrepancias.length > 0).length;
    const ncsTotal = ncsRows.length;
    const ncsConPend = ncsRows.filter(n => n.discrepancias.length > 0).length;
    return {
      facturas: facs.length,
      conDiscrepancia,
      totalFacturado,
      ncs: ncsTotal,
      ncsConPend,
      recepciones: recPeriodo.length,
      recSinFactura: recSinFactura.length,
    };
  }, [facturasEnriched, ncsRows, recPeriodo, recSinFactura]);

  // Meses disponibles (para el select)
  const periodosDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const r of rcv) if (r.fecha_docto) set.add(r.fecha_docto.slice(0, 7));
    for (const r of recepciones) if (r.created_at) set.add(r.created_at.slice(0, 7));
    return Array.from(set).sort().reverse();
  }, [rcv, recepciones]);

  if (loading) return <div className="card" style={{ padding: 16 }}>Cargando conciliación…</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>🧾 Conciliación Documentaria</h2>
        <select value={periodoFiltro} onChange={e => setPeriodoFiltro(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
          {periodosDisponibles.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={cargar}
          style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600 }}>
          ⟳ Refrescar
        </button>
      </div>

      {/* KPIs — solo documentos de inventario (match con recepción) */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 12 }}>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Facturas inventario</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.facturas}</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>{fmtMoney(kpis.totalFacturado)}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--amber)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Con discrepancias</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)" }}>{kpis.conDiscrepancia}</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>pendientes de resolver</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--cyan)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>NCs inventario</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)" }}>{kpis.ncs}</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>{kpis.ncsConPend > 0 ? `${kpis.ncsConPend} con pendientes` : "sin pendientes"}</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--blue)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Recepciones</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.recepciones}</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>del período</div>
        </div>
        <div className="kpi" style={{ borderLeft: "3px solid var(--red)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase" }}>Sin factura RCV</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--red)" }}>{kpis.recSinFactura}</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>bodega sin DTE</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, borderBottom: "1px solid var(--bg4)" }}>
        {([
          ["facturas", `Facturas (${kpis.facturas})`],
          ["ncs", `NCs (${kpis.ncs})`],
          ["sin_factura", `Rec. sin factura (${kpis.recSinFactura})`],
        ] as const).map(([t, l]) => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{
              padding: "6px 12px", border: "none", background: "none",
              color: subTab === t ? "var(--cyan)" : "var(--txt3)",
              borderBottom: subTab === t ? "2px solid var(--cyan)" : "2px solid transparent",
              fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}>{l}</button>
        ))}
      </div>

      {subTab === "facturas" && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 10px" }}>Tipo</th>
                <th style={{ padding: "8px 10px" }}>Folio</th>
                <th style={{ padding: "8px 10px" }}>Proveedor</th>
                <th style={{ padding: "8px 10px" }}>Fecha</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Monto</th>
                <th style={{ padding: "8px 10px" }}>Recepción</th>
                <th style={{ padding: "8px 10px" }}>OC</th>
                <th style={{ padding: "8px 10px" }}>NC</th>
                <th style={{ padding: "8px 10px" }}>Discrep.</th>
              </tr>
            </thead>
            <tbody>
              {facturasEnriched.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 16, textAlign: "center", color: "var(--txt3)" }}>Sin facturas en este período.</td></tr>
              )}
              {facturasEnriched.map(f => {
                const id = f.rcv.id || `${f.rcv.nro_doc}-${f.rcv.rut_proveedor}`;
                const isExp = expanded.has(id);
                const matchRec = f.recepciones.length > 0;
                const montoRec = f.recepciones.reduce((s, r) => s + (r.costo_neto || 0), 0);
                const delta = matchRec ? Math.abs((Number(f.rcv.monto_neto) || 0) - montoRec) : 0;
                return (
                  <React.Fragment key={id}>
                    <tr style={{ borderTop: "1px solid var(--bg4)", cursor: "pointer" }} onClick={() => toggleExp(id)}>
                      <td style={{ padding: "7px 10px" }}>
                        <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)" }}>{TIPO_DOC[f.rcv.tipo_doc] || f.rcv.tipo_doc}</span>
                      </td>
                      <td className="mono" style={{ padding: "7px 10px", fontWeight: 600 }}>{f.rcv.nro_doc}</td>
                      <td style={{ padding: "7px 10px" }}>{f.rcv.razon_social}</td>
                      <td style={{ padding: "7px 10px", color: "var(--txt3)" }}>{fmtDate(f.rcv.fecha_docto)}</td>
                      <td className="mono" style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600 }}>{fmtMoney(f.rcv.monto_total)}</td>
                      <td style={{ padding: "7px 10px" }}>
                        {matchRec ? (
                          <span style={{ color: "var(--green)", fontSize: 10, fontWeight: 600 }}>
                            ✓ {f.recepciones.map(r => r.folio).join(", ")}
                            {delta > 100 && <span style={{ color: "var(--amber)", marginLeft: 6 }}>Δ {fmtMoney(delta)}</span>}
                          </span>
                        ) : (
                          <span style={{ color: "var(--amber)", fontSize: 10 }}>⚠ sin recepción</span>
                        )}
                      </td>
                      <td style={{ padding: "7px 10px", color: "var(--txt3)", fontSize: 10 }}>{f.ocNumero || "—"}</td>
                      <td style={{ padding: "7px 10px" }}>
                        {f.ncs.length > 0 ? (
                          <span style={{ color: "var(--cyan)", fontSize: 10, fontWeight: 600 }}>📋 {f.ncs.length} NC</span>
                        ) : <span style={{ color: "var(--txt3)", fontSize: 10 }}>—</span>}
                      </td>
                      <td style={{ padding: "7px 10px" }}>
                        {f.discrepancias.length > 0
                          ? <span style={{ color: "var(--amber)", fontSize: 10, fontWeight: 600 }}>⚠ {f.discrepancias.length}</span>
                          : <span style={{ color: "var(--txt3)", fontSize: 10 }}>—</span>}
                      </td>
                    </tr>
                    {isExp && (
                      <tr>
                        <td colSpan={9} style={{ padding: "10px 12px", background: "var(--bg3)", borderTop: "1px solid var(--bg4)" }}>
                          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 11 }}>
                            <div>
                              <div style={{ fontWeight: 700, marginBottom: 4 }}>Factura</div>
                              <div>Neto: {fmtMoney(f.rcv.monto_neto)}</div>
                              <div>IVA: {fmtMoney(f.rcv.monto_iva)}</div>
                              <div>Total: {fmtMoney(f.rcv.monto_total)}</div>
                            </div>
                            {f.recepciones.length > 0 && (
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4 }}>Recepción ({f.recepciones.length})</div>
                                {f.recepciones.map(r => (
                                  <div key={r.id}><span className="mono">{r.folio}</span> · {r.estado} · {fmtDate(r.created_at)} · {fmtMoney(r.costo_neto)}</div>
                                ))}
                              </div>
                            )}
                            {f.ncs.length > 0 && (
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--cyan)" }}>NCs asociadas ({f.ncs.length})</div>
                                {f.ncs.map(nc => (
                                  <div key={nc.id}><span className="mono">{nc.nro_doc}</span> · {fmtDate(nc.fecha_docto)} · {fmtMoney(nc.monto_total)}</div>
                                ))}
                              </div>
                            )}
                            {f.discrepancias.length > 0 && (
                              <div>
                                <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--amber)" }}>Discrepancias PENDIENTES ({f.discrepancias.length})</div>
                                {f.discrepancias.slice(0, 6).map(d => (
                                  <div key={d.id}><span className="mono">{d.sku}</span> · dic {fmtMoney(d.costo_diccionario)} vs fac {fmtMoney(d.costo_factura)}</div>
                                ))}
                                {f.discrepancias.length > 6 && <div style={{ color: "var(--txt3)" }}>+{f.discrepancias.length - 6} más…</div>}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "ncs" && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 10px" }}>Folio NC</th>
                <th style={{ padding: "8px 10px" }}>Proveedor</th>
                <th style={{ padding: "8px 10px" }}>Fecha</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Monto</th>
                <th style={{ padding: "8px 10px" }}>Ref. factura</th>
                <th style={{ padding: "8px 10px" }}>Recepción</th>
                <th style={{ padding: "8px 10px" }}>Discrep. pend.</th>
              </tr>
            </thead>
            <tbody>
              {ncsRows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: "center", color: "var(--txt3)" }}>Sin NCs en este período.</td></tr>
              )}
              {ncsRows.map(n => {
                const matchRec = n.recepciones.length > 0;
                return (
                  <tr key={n.rcv.id} style={{ borderTop: "1px solid var(--bg4)" }}>
                    <td className="mono" style={{ padding: "7px 10px", fontWeight: 600 }}>{n.rcv.nro_doc}</td>
                    <td style={{ padding: "7px 10px" }}>{n.rcv.razon_social}</td>
                    <td style={{ padding: "7px 10px", color: "var(--txt3)" }}>{fmtDate(n.rcv.fecha_docto)}</td>
                    <td className="mono" style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600, color: "var(--cyan)" }}>{fmtMoney(n.rcv.monto_total)}</td>
                    <td className="mono" style={{ padding: "7px 10px" }}>{n.rcv.factura_ref_folio || <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                    <td style={{ padding: "7px 10px" }}>
                      {matchRec
                        ? <span style={{ color: "var(--green)", fontSize: 10 }}>✓ {n.recepciones.map(r => r.folio).join(", ")}</span>
                        : <span style={{ color: "var(--amber)", fontSize: 10 }}>⚠ sin match</span>}
                    </td>
                    <td style={{ padding: "7px 10px" }}>
                      {n.discrepancias.length > 0
                        ? <span style={{ color: "var(--amber)", fontSize: 10, fontWeight: 600 }}>{n.discrepancias.length} pendientes</span>
                        : <span style={{ color: "var(--txt3)", fontSize: 10 }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "sin_factura" && (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          <p style={{ padding: "10px 12px", fontSize: 11, color: "var(--txt3)", margin: 0 }}>
            Recepciones ingresadas en bodega que no tienen DTE 33/34 en el RCV del SII del mismo período.
            Puede deberse a: factura aún no sincronizada (sync RCV no trajo), ingreso &quot;RAPIDO&quot; sin factura formal, o proveedor no ha emitido el DTE.
          </p>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "8px 10px" }}>Folio</th>
                <th style={{ padding: "8px 10px" }}>Proveedor</th>
                <th style={{ padding: "8px 10px" }}>Fecha</th>
                <th style={{ padding: "8px 10px" }}>Estado</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Neto</th>
                <th style={{ padding: "8px 10px", textAlign: "right" }}>Bruto</th>
              </tr>
            </thead>
            <tbody>
              {recSinFactura.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: "center", color: "var(--txt3)" }}>Todas las recepciones tienen factura RCV.</td></tr>
              )}
              {recSinFactura.map(r => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--bg4)" }}>
                  <td className="mono" style={{ padding: "7px 10px", fontWeight: 600 }}>{r.folio || <span style={{ color: "var(--txt3)" }}>(sin folio)</span>}</td>
                  <td style={{ padding: "7px 10px" }}>{r.proveedor}</td>
                  <td style={{ padding: "7px 10px", color: "var(--txt3)" }}>{fmtDate(r.created_at)}</td>
                  <td style={{ padding: "7px 10px" }}>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "var(--bg3)" }}>{r.estado}</span>
                  </td>
                  <td className="mono" style={{ padding: "7px 10px", textAlign: "right" }}>{fmtMoney(r.costo_neto)}</td>
                  <td className="mono" style={{ padding: "7px 10px", textAlign: "right" }}>{fmtMoney(r.costo_bruto)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mini leyenda */}
      <div style={{ marginTop: 10, padding: 10, background: "var(--bg3)", borderRadius: 6, fontSize: 10, color: "var(--txt3)" }}>
        <strong>Cómo funciona:</strong> solo se muestran facturas y NCs que matchean con una recepción en bodega (inventario). Se excluyen servicios/honorarios/gastos que no tienen recepción.
        Match: folio factura ↔ recepción.folio + proveedor normalizado (ignora SA/SPA/LTDA/puntuación). Para NCs vía <code>factura_ref_folio</code>. Delta de montos mostrado si &gt; $100.
      </div>
    </div>
  );
}
