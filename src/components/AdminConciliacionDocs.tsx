"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchEmpresaDefault, fetchRcvCompras, fetchRecepciones, fetchOrdenesCompra,
  fetchDiscrepanciasGlobal, fetchLineasDeRecepciones, fetchProductos, fetchProveedorCatalogo,
  updateRecepcion,
} from "@/lib/db";
import type { DBRcvCompra, DBRecepcion, DBOrdenCompra, DBDiscrepanciaCosto, DBRecepcionLinea, DBProduct, DBProveedorCatalogo } from "@/lib/db";

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
  const [lineasPorRec, setLineasPorRec] = useState<Map<string, DBRecepcionLinea[]>>(new Map());
  const [lineasPorLineaId, setLineasPorLineaId] = useState<Map<string, DBRecepcionLinea>>(new Map());
  const [productos, setProductos] = useState<Map<string, DBProduct>>(new Map());
  const [catalogo, setCatalogo] = useState<Map<string, number>>(new Map()); // key = proveedor_norm|sku
  const [periodoFiltro, setPeriodoFiltro] = useState<string>(new Date().toISOString().slice(0, 7));
  const [subTab, setSubTab] = useState<SubTab>("facturas");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [asignarModal, setAsignarModal] = useState<{ recepcion: DBRecepcion; proveedor: string; folio: string } | null>(null);
  const [asignando, setAsignando] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const empresa = await fetchEmpresaDefault();
      const [rcvData, recData, ocData, dData, pData, catData] = await Promise.all([
        empresa?.id ? fetchRcvCompras(empresa.id) : Promise.resolve([]),
        fetchRecepciones(),
        fetchOrdenesCompra(),
        fetchDiscrepanciasGlobal(),
        fetchProductos(),
        fetchProveedorCatalogo(),
      ]);
      setRcv(rcvData);
      setRecepciones(recData);
      setOcs(ocData);
      setDiscs(dData);
      setProductos(new Map(pData.map(p => [p.sku.toUpperCase().trim(), p])));
      const catMap = new Map<string, number>();
      for (const c of catData as DBProveedorCatalogo[]) {
        const precio = (c.precio_neto as number) || 0;
        if (precio > 0) {
          catMap.set(`${normProv(c.proveedor || "")}|${(c.sku_origen || "").toUpperCase().trim()}`, precio);
        }
      }
      setCatalogo(catMap);
      // Cargar líneas de recepción (para calcular qty y NC esperada)
      const recIds = recData.map(r => r.id!).filter(Boolean);
      if (recIds.length > 0) {
        const lineas = await fetchLineasDeRecepciones(recIds);
        const byRec = new Map<string, DBRecepcionLinea[]>();
        const byLinea = new Map<string, DBRecepcionLinea>();
        for (const l of lineas) {
          if (l.id) byLinea.set(l.id, l);
          const arr = byRec.get(l.recepcion_id) || [];
          arr.push(l);
          byRec.set(l.recepcion_id, arr);
        }
        setLineasPorRec(byRec);
        setLineasPorLineaId(byLinea);
      }
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

  // Proveedores únicos en RCV del período (para el select al asignar)
  const proveedoresRcvPeriodo = useMemo(() => {
    const set = new Set<string>();
    for (const r of rcvPeriodo) {
      if ((r.tipo_doc === 33 || r.tipo_doc === 34 || r.tipo_doc === 46) && r.razon_social) {
        set.add(r.razon_social);
      }
    }
    return Array.from(set).sort();
  }, [rcvPeriodo]);

  // Inferir proveedor probable desde los SKUs de la recepción (el más común entre productos con proveedor)
  const sugerencias = useMemo(() => {
    if (!asignarModal?.recepcion.id) return { proveedorInferido: "", montoTeoricoNeto: 0, montoTeoricoBruto: 0 };
    const lineas = lineasPorRec.get(asignarModal.recepcion.id) || [];
    const conteoProv: Map<string, number> = new Map();
    let montoTeorico = 0;
    for (const l of lineas) {
      const prod = productos.get((l.sku || "").toUpperCase().trim());
      if (prod?.proveedor && prod.proveedor !== "Otro" && prod.proveedor !== "Desconocido") {
        conteoProv.set(prod.proveedor, (conteoProv.get(prod.proveedor) || 0) + 1);
      }
      const costo = (prod?.costo as number) || 0;
      montoTeorico += (l.qty_recibida || 0) * costo;
    }
    let proveedorInferido = "";
    let maxCount = 0;
    for (const [prov, cnt] of Array.from(conteoProv.entries())) {
      if (cnt > maxCount) { maxCount = cnt; proveedorInferido = prov; }
    }
    return {
      proveedorInferido,
      montoTeoricoNeto: Math.round(montoTeorico),
      montoTeoricoBruto: Math.round(montoTeorico * 1.19),
    };
  }, [asignarModal, lineasPorRec, productos]);

  // Proveedores rankeados: el inferido primero
  const proveedoresRanked = useMemo(() => {
    const lista = [...proveedoresRcvPeriodo];
    const inferNorm = normProv(sugerencias.proveedorInferido);
    if (inferNorm) {
      lista.sort((a, b) => {
        const aMatch = normProv(a) === inferNorm ? -1 : 0;
        const bMatch = normProv(b) === inferNorm ? -1 : 0;
        return aMatch - bMatch || a.localeCompare(b);
      });
    }
    return lista;
  }, [proveedoresRcvPeriodo, sugerencias.proveedorInferido]);

  // Folios del proveedor, rankeados por match de monto (el más cercano al teórico primero)
  const foliosDelProveedor = useMemo(() => {
    if (!asignarModal?.proveedor) return [] as Array<{ folio: string; monto: number; fecha: string; scoreMatch: number; pctDiff: number }>;
    const provNorm = normProv(asignarModal.proveedor);
    const foliosUsados = new Set<string>();
    for (const rec of recepciones) {
      if (!rec.folio || rec.estado === "ANULADA") continue;
      if (rec.id === asignarModal.recepcion.id) continue;
      if (normProv(rec.proveedor || "") === provNorm) foliosUsados.add(rec.folio);
    }
    const teorico = sugerencias.montoTeoricoBruto;
    return rcvPeriodo
      .filter(r => (r.tipo_doc === 33 || r.tipo_doc === 34 || r.tipo_doc === 46))
      .filter(r => normProv(r.razon_social || "") === provNorm)
      .filter(r => r.nro_doc && !foliosUsados.has(r.nro_doc))
      .map(r => {
        const monto = Number(r.monto_total) || 0;
        const pctDiff = teorico > 0 ? Math.abs(monto - teorico) / teorico : 1;
        let scoreMatch = 0;
        if (teorico > 0) {
          if (pctDiff <= 0.02) scoreMatch = 3; // match casi exacto
          else if (pctDiff <= 0.05) scoreMatch = 2; // match cercano
          else if (pctDiff <= 0.15) scoreMatch = 1; // match lejano
        }
        return { folio: r.nro_doc || "", monto, fecha: r.fecha_docto || "", scoreMatch, pctDiff };
      })
      .sort((a, b) => b.scoreMatch - a.scoreMatch || b.fecha.localeCompare(a.fecha));
  }, [asignarModal, rcvPeriodo, recepciones, sugerencias.montoTeoricoBruto]);

  // Auto-seleccionar al abrir el modal: proveedor inferido + folio con mejor score
  useEffect(() => {
    if (!asignarModal) return;
    if (!asignarModal.proveedor && sugerencias.proveedorInferido) {
      const match = proveedoresRcvPeriodo.find(p => normProv(p) === normProv(sugerencias.proveedorInferido));
      if (match) setAsignarModal({ ...asignarModal, proveedor: match });
    }
  }, [asignarModal, proveedoresRcvPeriodo, sugerencias.proveedorInferido]);

  useEffect(() => {
    if (!asignarModal?.proveedor || asignarModal.folio) return;
    const top = foliosDelProveedor[0];
    if (top && top.scoreMatch >= 3) {
      setAsignarModal(prev => prev ? { ...prev, folio: top.folio } : null);
    }
  }, [asignarModal?.proveedor, foliosDelProveedor, asignarModal?.folio, asignarModal]);

  const ejecutarAsignacion = async () => {
    if (!asignarModal || !asignarModal.proveedor || !asignarModal.folio || !asignarModal.recepcion.id) return;
    if (!window.confirm(
      `Asignar recepción ${asignarModal.recepcion.folio || "(sin folio)"} a:\n\n`
      + `Proveedor: ${asignarModal.proveedor}\n`
      + `Factura: ${asignarModal.folio}\n\n`
      + `Esto cambia folio y proveedor de la recepción.`
    )) return;
    setAsignando(true);
    try {
      await updateRecepcion(asignarModal.recepcion.id, {
        folio: asignarModal.folio,
        proveedor: asignarModal.proveedor,
      });
      setAsignarModal(null);
      await cargar();
      alert("Recepción asignada a factura.");
    } catch (e) {
      alert("Error: " + (e instanceof Error ? e.message : e));
    } finally {
      setAsignando(false);
    }
  };

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
                <th style={{ padding: "8px 10px", textAlign: "right" }}>NC esperada</th>
              </tr>
            </thead>
            <tbody>
              {facturasEnriched.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 16, textAlign: "center", color: "var(--txt3)" }}>Sin facturas en este período.</td></tr>
              )}
              {facturasEnriched.map(f => {
                const id = f.rcv.id || `${f.rcv.nro_doc}-${f.rcv.rut_proveedor}`;
                const isExp = expanded.has(id);
                const matchRec = f.recepciones.length > 0;
                const montoRec = f.recepciones.reduce((s, r) => s + (r.costo_neto || 0), 0);
                const netoFac = Number(f.rcv.monto_neto) || 0;
                const deltaSign = netoFac - montoRec; // positivo = factura > recepción (falta mercadería)
                const delta = Math.abs(deltaSign);
                // Clasificar el estado del match:
                // - "completa": delta neto <= 1% o <= $500
                // - "parcial": factura > recepción (falta mercadería por llegar) o discrepancias pendientes
                // - "excedente": recepción > factura (raro, revisar)
                const umbralDelta = Math.max(500, netoFac * 0.01);
                let estadoMatch: "completa" | "parcial" | "excedente" = "completa";
                if (matchRec) {
                  if (deltaSign > umbralDelta) estadoMatch = "parcial";
                  else if (deltaSign < -umbralDelta) estadoMatch = "excedente";
                }
                // NC esperada: por cada discrepancia PENDIENTE, delta = (fac - precio real) × qty
                // Precio real: 1º catálogo del proveedor (pactado), 2º WAC (fallback)
                const provNorm = normProv(f.rcv.razon_social || "");
                const ncItems = f.discrepancias.map(d => {
                  const linea = d.linea_id ? lineasPorLineaId.get(d.linea_id) : undefined;
                  const qty = linea?.qty_recibida || 0;
                  const skuUp = (d.sku || "").toUpperCase().trim();
                  const precioCat = catalogo.get(`${provNorm}|${skuUp}`) || 0;
                  const prod = productos.get(skuUp);
                  const wac = (prod?.costo_promedio as number) || 0;
                  const precioRef = precioCat > 0 ? precioCat : wac;
                  const fuente: "catalogo" | "wac" = precioCat > 0 ? "catalogo" : "wac";
                  const deltaUd = (Number(d.costo_factura) || 0) - precioRef;
                  return { sku: d.sku, qty, deltaUd, subtotal: deltaUd * qty, precioRef, fuente };
                }).filter(x => x.deltaUd > 0 && x.qty > 0);
                const fuenteMix = ncItems.length > 0
                  ? (ncItems.every(x => x.fuente === "catalogo") ? "catálogo"
                    : ncItems.every(x => x.fuente === "wac") ? "WAC (sin catálogo)"
                    : "mixto")
                  : "—";
                const ncNeto = Math.round(ncItems.reduce((s, x) => s + x.subtotal, 0));
                const ncIva = Math.round(ncNeto * 0.19);
                const ncTotal = ncNeto + ncIva;
                const ncCovered = f.ncs.reduce((s, nc) => s + (Number(nc.monto_total) || 0), 0);
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
                          estadoMatch === "completa" ? (
                            <span style={{ color: "var(--green)", fontSize: 10, fontWeight: 600 }}>
                              ✓ {f.recepciones.map(r => r.folio).join(", ")}
                            </span>
                          ) : estadoMatch === "parcial" ? (
                            <span style={{ fontSize: 10, fontWeight: 600 }}>
                              <span style={{ color: "var(--amber)" }}>🟡 Parcial</span>
                              <span style={{ color: "var(--txt3)", marginLeft: 4 }}>{f.recepciones.map(r => r.folio).join(", ")}</span>
                              <br />
                              <span style={{ color: "var(--amber)", fontSize: 9 }}>Falta {fmtMoney(delta)}</span>
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, fontWeight: 600 }}>
                              <span style={{ color: "var(--red)" }}>🔴 Excedente</span>
                              <span style={{ color: "var(--txt3)", marginLeft: 4 }}>{f.recepciones.map(r => r.folio).join(", ")}</span>
                              <br />
                              <span style={{ color: "var(--red)", fontSize: 9 }}>Sobra {fmtMoney(delta)}</span>
                            </span>
                          )
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
                      <td className="mono" style={{ padding: "7px 10px", textAlign: "right" }}>
                        {ncTotal > 0 ? (
                          <span style={{ color: ncCovered >= ncTotal - 100 ? "var(--green)" : "var(--cyan)", fontSize: 11, fontWeight: 700 }}>
                            {fmtMoney(ncTotal)}
                          </span>
                        ) : <span style={{ color: "var(--txt3)", fontSize: 10 }}>—</span>}
                      </td>
                    </tr>
                    {isExp && (
                      <tr>
                        <td colSpan={10} style={{ padding: "10px 12px", background: "var(--bg3)", borderTop: "1px solid var(--bg4)" }}>
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
                                {estadoMatch === "parcial" && (
                                  <div style={{ marginTop: 6, padding: 8, borderRadius: 4, background: "var(--amberBg)", border: "1px solid var(--amberBd)", fontSize: 10, color: "var(--amber)" }}>
                                    🟡 <strong>Recepción parcial.</strong> Factura: {fmtMoney(netoFac)} · Recibido: {fmtMoney(montoRec)} · <strong>Falta: {fmtMoney(delta)}</strong> neto
                                    <div style={{ color: "var(--txt3)", marginTop: 3 }}>
                                      Cuando llegue el resto de la mercadería, ingresá otra recepción con el mismo folio {f.rcv.nro_doc} y proveedor {f.rcv.razon_social}.
                                    </div>
                                  </div>
                                )}
                                {estadoMatch === "excedente" && (
                                  <div style={{ marginTop: 6, padding: 8, borderRadius: 4, background: "var(--redBg)", border: "1px solid var(--redBd)", fontSize: 10, color: "var(--red)" }}>
                                    🔴 <strong>Recepción excede factura.</strong> Factura: {fmtMoney(netoFac)} · Recibido: {fmtMoney(montoRec)} · <strong>Sobra: {fmtMoney(delta)}</strong> — revisar duplicados o doble ingreso.
                                  </div>
                                )}
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
                            {ncTotal > 0 && (
                              <div style={{ minWidth: 240, padding: 10, background: "var(--bg2)", borderRadius: 6, borderLeft: "3px solid var(--cyan)" }}>
                                <div style={{ fontWeight: 700, color: "var(--cyan)", marginBottom: 6 }}>📋 NC esperada del proveedor</div>
                                <div style={{ fontSize: 11 }}>Neto: <strong>{fmtMoney(ncNeto)}</strong></div>
                                <div style={{ fontSize: 11 }}>IVA: <strong>{fmtMoney(ncIva)}</strong></div>
                                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, color: "var(--cyan)" }}>
                                  Total: {fmtMoney(ncTotal)}
                                </div>
                                <div style={{ fontSize: 10, marginTop: 4, color: fuenteMix === "catálogo" ? "var(--green)" : fuenteMix === "mixto" ? "var(--amber)" : "var(--amber)" }}>
                                  Base: {fuenteMix}
                                  {fuenteMix !== "catálogo" && fuenteMix !== "—" && <span style={{ color: "var(--txt3)" }}> — cargar en proveedor_catalogo para mayor precisión</span>}
                                </div>
                                {ncCovered > 0 && (
                                  <div style={{ fontSize: 10, marginTop: 4, color: ncCovered >= ncTotal - 100 ? "var(--green)" : "var(--amber)" }}>
                                    {ncCovered >= ncTotal - 100 ? "✓ " : "⚠ "}
                                    NCs emitidas: {fmtMoney(ncCovered)} ({Math.round(ncCovered / ncTotal * 100)}%)
                                  </div>
                                )}
                                <details style={{ marginTop: 6 }}>
                                  <summary style={{ cursor: "pointer", fontSize: 10, color: "var(--txt3)" }}>Ver desglose por SKU</summary>
                                  <div style={{ marginTop: 6, maxHeight: 200, overflow: "auto", fontSize: 10 }}>
                                    {ncItems.map(x => (
                                      <div key={x.sku} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: "var(--txt2)", gap: 6 }}>
                                        <span className="mono" style={{ minWidth: 100 }}>{x.sku}</span>
                                        <span title={`Precio ${x.fuente}: ${fmtMoney(x.precioRef)}`}>
                                          {x.qty} × {fmtMoney(x.deltaUd)} = <strong>{fmtMoney(x.subtotal)}</strong>
                                          <span style={{ marginLeft: 4, color: x.fuente === "catalogo" ? "var(--green)" : "var(--amber)", fontSize: 9 }}>
                                            {x.fuente === "catalogo" ? "cat" : "wac"}
                                          </span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </details>
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
                <th style={{ padding: "8px 10px" }}></th>
              </tr>
            </thead>
            <tbody>
              {recSinFactura.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 16, textAlign: "center", color: "var(--txt3)" }}>Todas las recepciones tienen factura RCV.</td></tr>
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
                  <td style={{ padding: "7px 10px" }}>
                    <button onClick={() => setAsignarModal({ recepcion: r, proveedor: "", folio: "" })}
                      style={{ padding: "4px 10px", borderRadius: 4, background: "var(--blueBg)", color: "var(--blue)", fontSize: 10, fontWeight: 700, border: "1px solid var(--blueBd)", cursor: "pointer" }}>
                      Asignar factura
                    </button>
                  </td>
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
        <br />
        <strong>NC esperada:</strong> <code>(costo_factura − precio_referencia) × qty_recibida</code> por cada discrepancia PENDIENTE + IVA 19%.
        Precio referencia: 1º <code>proveedor_catalogo.precio_neto</code> (pactado), 2º <code>productos.costo_promedio</code> (WAC, fallback).
        Si la base muestra &quot;WAC&quot; o &quot;mixto&quot;, falta cargar precios en catálogo para que el cálculo sea más preciso.
      </div>

      {/* Modal Asignar factura */}
      {asignarModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => !asignando && setAsignarModal(null)}>
          <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 600, width: "100%", maxHeight: "85vh", overflow: "auto" }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>Asignar factura a recepción</h3>
            <p style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 14 }}>
              Vincular la recepción a una factura real del RCV. Esto cambia el folio y proveedor de la recepción.
            </p>
            <div style={{ padding: 10, background: "var(--bg3)", borderRadius: 6, marginBottom: 14, fontSize: 11 }}>
              <div><strong>Recepción actual:</strong></div>
              <div className="mono" style={{ marginTop: 2 }}>
                {asignarModal.recepcion.folio || "(sin folio)"} · {asignarModal.recepcion.proveedor || "(sin proveedor)"} · {fmtDate(asignarModal.recepcion.created_at)}
              </div>
              {sugerencias.montoTeoricoNeto > 0 && (
                <div style={{ marginTop: 6, fontSize: 10, color: "var(--txt3)" }}>
                  💡 Monto teórico (sum qty × productos.costo): <strong style={{ color: "var(--cyan)" }}>{fmtMoney(sugerencias.montoTeoricoBruto)}</strong> bruto ({fmtMoney(sugerencias.montoTeoricoNeto)} neto)
                  {sugerencias.proveedorInferido && (
                    <span> · Proveedor inferido por SKUs: <strong style={{ color: "var(--cyan)" }}>{sugerencias.proveedorInferido}</strong></span>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4, fontWeight: 600 }}>
                1. Proveedor (según RCV del período)
                {sugerencias.proveedorInferido && proveedoresRcvPeriodo.some(p => normProv(p) === normProv(sugerencias.proveedorInferido)) &&
                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--cyan)" }}>· 💡 sugerido: {sugerencias.proveedorInferido}</span>}
              </label>
              <select value={asignarModal.proveedor}
                onChange={e => setAsignarModal({ ...asignarModal, proveedor: e.target.value, folio: "" })}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }}>
                <option value="">— elegir proveedor —</option>
                {proveedoresRanked.map(p => {
                  const esInferido = normProv(p) === normProv(sugerencias.proveedorInferido);
                  return <option key={p} value={p}>{esInferido ? "💡 " : ""}{p}</option>;
                })}
              </select>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 3 }}>
                {proveedoresRanked.length} proveedores con facturas en {periodoFiltro}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: "var(--txt2)", display: "block", marginBottom: 4, fontWeight: 600 }}>
                2. Folio de factura (del proveedor, sin recepción asignada)
                {foliosDelProveedor[0]?.scoreMatch >= 3 && asignarModal.proveedor &&
                  <span style={{ marginLeft: 6, fontSize: 10, color: "var(--green)" }}>· ✓ match exacto: {foliosDelProveedor[0].folio}</span>}
              </label>
              <select value={asignarModal.folio} disabled={!asignarModal.proveedor}
                onChange={e => setAsignarModal({ ...asignarModal, folio: e.target.value })}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13, opacity: asignarModal.proveedor ? 1 : 0.5 }}>
                <option value="">— elegir folio —</option>
                {foliosDelProveedor.map(f => {
                  const marker = f.scoreMatch === 3 ? "✓" : f.scoreMatch === 2 ? "~" : f.scoreMatch === 1 ? "?" : "";
                  const pct = f.scoreMatch > 0 ? ` (${(f.pctDiff * 100).toFixed(1)}% diff)` : "";
                  return (
                    <option key={f.folio} value={f.folio}>
                      {marker ? marker + " " : ""}{f.folio} · {fmtDate(f.fecha)} · {fmtMoney(f.monto)}{pct}
                    </option>
                  );
                })}
              </select>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 3 }}>
                {asignarModal.proveedor
                  ? <>
                      {foliosDelProveedor.length} facturas disponibles.
                      {sugerencias.montoTeoricoBruto > 0 && <span> Match ranking por monto vs teórico ({fmtMoney(sugerencias.montoTeoricoBruto)}).</span>}
                    </>
                  : "Elegí un proveedor primero"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setAsignarModal(null)} disabled={asignando}
                style={{ padding: "8px 14px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Cancelar
              </button>
              <button onClick={ejecutarAsignacion} disabled={asignando || !asignarModal.proveedor || !asignarModal.folio}
                style={{ padding: "8px 14px", borderRadius: 6, background: "var(--blue)", color: "#0a0e17", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", opacity: (asignando || !asignarModal.proveedor || !asignarModal.folio) ? 0.5 : 1 }}>
                {asignando ? "Asignando..." : "Asignar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
