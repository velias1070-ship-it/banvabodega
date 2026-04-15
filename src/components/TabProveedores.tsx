"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchRcvCompras,
  fetchConciliaciones,
  fetchProveedorCuentas,
  upsertProveedorCuenta,
  fetchMovimientosBanco,
} from "@/lib/db";
import type {
  DBEmpresa, DBRcvCompra, DBConciliacion, DBProveedorCuenta, DBMovimientoBanco,
} from "@/lib/db";

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

function fmtRut(rut: string | null): string {
  if (!rut) return "—";
  const clean = rut.replace(/\./g, "").replace(/\s/g, "").trim();
  const dv = clean.slice(-1);
  const body = clean.slice(0, -2);
  if (body.length < 2) return rut;
  const formatted = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formatted}-${dv}`;
}

const TIPO_DOC_NAMES: Record<number | string, string> = {
  33: "Factura", 34: "Factura Exenta", 39: "Boleta", 41: "Boleta Exenta",
  46: "Factura Compra", 52: "Guía Despacho", 56: "Nota Débito", 61: "Nota Crédito", 71: "BHE",
};

interface ProveedorRow {
  rut: string;
  razon_social: string;
  facturas: number;
  total_neto: number;
  total_total: number;
  por_pagar: number;
  plazo_dias: number | null;
  direccion: string | null;
  comuna: string | null;
  contacto: string | null;
  cuenta_variable: boolean;
}

type SortKey = "rut" | "razon_social" | "plazo_dias" | "por_pagar";

export default function TabProveedores({ empresa, periodo }: { empresa: DBEmpresa; periodo: string }) {
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [movsBanco, setMovsBanco] = useState<DBMovimientoBanco[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("por_pagar");
  const [sortAsc, setSortAsc] = useState(false);
  const [viewRut, setViewRut] = useState<string | null>(null);
  const [editRut, setEditRut] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ rut: "", razon_social: "", comuna: "", direccion: "", contacto: "", plazo_dias: "", cuenta_variable: false });
  const [saving, setSaving] = useState(false);
  const [addMode, setAddMode] = useState(false);

  const isAnual = periodo.length === 4;

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const [conc, pc, movs] = await Promise.all([
      fetchConciliaciones(empresa.id),
      fetchProveedorCuentas(),
      fetchMovimientosBanco(empresa.id, { desde: undefined, hasta: undefined }),
    ]);
    setConciliaciones(conc);
    setProvCuentas(pc);
    setMovsBanco(movs);
    // Cargar compras del periodo
    if (isAnual) {
      const promises = [];
      for (let m = 1; m <= 12; m++) promises.push(fetchRcvCompras(empresa.id!, `${periodo}${String(m).padStart(2, "0")}`));
      const results = await Promise.all(promises);
      setCompras(results.flat());
    } else {
      setCompras(await fetchRcvCompras(empresa.id, periodo));
    }
    setLoading(false);
  }, [empresa.id, periodo, isAnual]);

  useEffect(() => { load(); }, [load]);

  const concCompraIds = useMemo(() => new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_compra_id).map(c => c.rcv_compra_id)), [conciliaciones]);

  // Construir lista de proveedores combinando compras + proveedor_cuenta
  const proveedores = useMemo(() => {
    const map = new Map<string, ProveedorRow>();
    // Desde compras
    for (const c of compras) {
      const rut = c.rut_proveedor || "";
      if (!rut) continue;
      const existing = map.get(rut);
      const isPagada = concCompraIds.has(c.id!);
      if (existing) {
        existing.facturas++;
        existing.total_neto += c.monto_neto || 0;
        existing.total_total += c.monto_total || 0;
        if (!isPagada) existing.por_pagar += c.monto_total || 0;
      } else {
        map.set(rut, {
          rut,
          razon_social: c.razon_social || "",
          facturas: 1,
          total_neto: c.monto_neto || 0,
          total_total: c.monto_total || 0,
          por_pagar: isPagada ? 0 : (c.monto_total || 0),
          plazo_dias: null, direccion: null, comuna: null, contacto: null, cuenta_variable: false,
        });
      }
    }
    // Desde proveedor_cuenta (puede haber proveedores sin compras en este periodo)
    for (const pc of provCuentas) {
      const existing = map.get(pc.rut_proveedor);
      if (existing) {
        existing.plazo_dias = pc.plazo_dias ?? null;
        existing.direccion = pc.direccion ?? null;
        existing.comuna = pc.comuna ?? null;
        existing.contacto = pc.contacto ?? null;
        existing.cuenta_variable = pc.cuenta_variable ?? false;
        if (!existing.razon_social && pc.razon_social) existing.razon_social = pc.razon_social;
      } else {
        map.set(pc.rut_proveedor, {
          rut: pc.rut_proveedor,
          razon_social: pc.razon_social || "",
          facturas: 0, total_neto: 0, total_total: 0, por_pagar: 0,
          plazo_dias: pc.plazo_dias ?? null,
          direccion: pc.direccion ?? null,
          comuna: pc.comuna ?? null,
          contacto: pc.contacto ?? null,
          cuenta_variable: pc.cuenta_variable ?? false,
        });
      }
    }
    return Array.from(map.values());
  }, [compras, provCuentas, concCompraIds]);

  // KPIs
  const totalNetoComprado = proveedores.reduce((s, p) => s + p.total_neto, 0);
  const totalPorPagar = proveedores.reduce((s, p) => s + p.por_pagar, 0);
  const promedioPago = (() => {
    const conPlazo = proveedores.filter(p => p.plazo_dias && p.facturas > 0);
    if (conPlazo.length === 0) return 0;
    return Math.round(conPlazo.reduce((s, p) => s + p.plazo_dias!, 0) / conPlazo.length);
  })();

  // Filtrar y ordenar
  const filtered = useMemo(() => {
    let list = proveedores;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.razon_social.toLowerCase().includes(q) || p.rut.includes(q));
    }
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "rut") cmp = a.rut.localeCompare(b.rut);
      else if (sortKey === "razon_social") cmp = a.razon_social.localeCompare(b.razon_social);
      else if (sortKey === "plazo_dias") cmp = (a.plazo_dias || 999) - (b.plazo_dias || 999);
      else if (sortKey === "por_pagar") cmp = a.por_pagar - b.por_pagar;
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [proveedores, search, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key === "rut" || key === "razon_social"); }
  };

  const openEdit = (p: ProveedorRow | null) => {
    setEditForm({
      rut: p?.rut || "",
      razon_social: p?.razon_social || "",
      comuna: p?.comuna || "",
      direccion: p?.direccion || "",
      contacto: p?.contacto || "",
      plazo_dias: p?.plazo_dias ? String(p.plazo_dias) : "",
      cuenta_variable: p?.cuenta_variable || false,
    });
    setEditRut(p?.rut || "__new__");
    setAddMode(!p);
  };

  const handleSave = async () => {
    if (!editForm.rut || !editForm.razon_social) return;
    setSaving(true);
    try {
      const plazo = editForm.plazo_dias ? parseInt(editForm.plazo_dias) : null;
      const pc = provCuentas.find(x => x.rut_proveedor === editForm.rut);
      await upsertProveedorCuenta(
        editForm.rut,
        pc?.categoria_cuenta_id || "",
        editForm.razon_social,
        plazo,
        editForm.cuenta_variable,
        { direccion: editForm.direccion || null, comuna: editForm.comuna || null, contacto: editForm.contacto || null }
      );
      setProvCuentas(await fetchProveedorCuentas());
      setEditRut(null);
      setAddMode(false);
    } finally {
      setSaving(false);
    }
  };

  const handleExport = () => {
    const headers = ["RUT", "Razón Social", "Comuna", "Dirección", "Contacto", "Plazo Pago", "Facturas", "Total Neto", "Por Pagar"];
    const rows = filtered.map(p => [
      p.rut, p.razon_social, p.comuna || "", p.direccion || "", p.contacto || "",
      p.plazo_dias ? `${p.plazo_dias}` : "", String(p.facturas), String(p.total_neto), String(p.por_pagar),
    ]);
    const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `proveedores_${periodo}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Facturas del proveedor seleccionado en "Ver"
  const viewProv = viewRut ? proveedores.find(p => p.rut === viewRut) : null;
  const viewFacturas = viewRut ? compras.filter(c => c.rut_proveedor === viewRut) : [];
  const viewPorPagar = viewFacturas.filter(c => !concCompraIds.has(c.id!));

  // Transferencias bancarias al proveedor: todas las conciliaciones confirmadas
  // con rcv_compra_id apuntando a alguna factura del proveedor, más su mov bancario
  const transferenciasBanco = useMemo(() => {
    if (!viewRut) return [];
    const facIds = new Set(viewFacturas.map(f => f.id!));
    const movById = new Map(movsBanco.map(m => [m.id!, m]));
    type Transfer = { mov: DBMovimientoBanco; factura: DBRcvCompra; monto_aplicado: number; concId: string };
    const transfers: Transfer[] = [];
    for (const c of conciliaciones) {
      if (c.estado !== "confirmado") continue;
      if (!c.rcv_compra_id || !c.movimiento_banco_id) continue;
      if (!facIds.has(c.rcv_compra_id)) continue;
      const mov = movById.get(c.movimiento_banco_id);
      const factura = viewFacturas.find(f => f.id === c.rcv_compra_id);
      if (!mov || !factura) continue;
      transfers.push({ mov, factura, monto_aplicado: c.monto_aplicado || 0, concId: c.id! });
    }
    return transfers.sort((a, b) => (b.mov.fecha || "").localeCompare(a.mov.fecha || ""));
  }, [viewRut, viewFacturas, conciliaciones, movsBanco]);
  // Facturación por mes para el gráfico
  const facturacionPorMes = useMemo(() => {
    if (!viewRut) return [];
    const map = new Map<string, number>();
    for (const c of viewFacturas) {
      const mes = c.fecha_docto?.slice(0, 7) || c.periodo?.slice(0, 4) + "-" + c.periodo?.slice(4, 6) || "?";
      map.set(mes, (map.get(mes) || 0) + (c.monto_neto || 0));
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [viewRut, viewFacturas]);
  const maxFactMes = Math.max(...facturacionPorMes.map(([, v]) => v), 1);

  const sortIcon = (key: SortKey) => sortKey === key ? (sortAsc ? " \u2191" : " \u2193") : " \u2195";

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  // ==================== VISTA DETALLE ====================
  if (viewProv && viewRut) {
    const pc = provCuentas.find(x => x.rut_proveedor === viewRut);
    const viewTotalNeto = viewFacturas.reduce((s, c) => s + (c.monto_neto || 0), 0);
    const viewPorPagarTotal = viewPorPagar.reduce((s, c) => s + (c.monto_total || 0), 0);
    return (
      <div>
        <button onClick={() => setViewRut(null)} style={{ background: "none", border: "none", color: "var(--cyan)", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>
          &larr; Volver a Proveedores
        </button>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {/* Datos del Proveedor */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Datos del Proveedor</h3>
              <button onClick={() => openEdit(viewProv)} style={{ padding: "5px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer" }}>Editar</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px", fontSize: 13 }}>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>RUT:</span>
              <span className="mono">{fmtRut(viewRut)}</span>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>Razón social:</span>
              <span>{viewProv.razon_social}</span>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>Dirección:</span>
              <span>{pc?.direccion || "—"}</span>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>Comuna:</span>
              <span>{pc?.comuna || "—"}</span>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>Contacto:</span>
              <span>{pc?.contacto || "—"}</span>
              <span style={{ color: "var(--txt3)", fontWeight: 600 }}>Plazo pago:</span>
              <span>{viewProv.plazo_dias ? `${viewProv.plazo_dias} días` : "—"}</span>
            </div>
          </div>

          {/* KPIs del proveedor */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 12 }}>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(viewTotalNeto)}</div>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>Total neto comprado</div>
            </div>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: viewPorPagarTotal > 0 ? "var(--amber)" : "var(--green)" }}>{fmtMoney(viewPorPagarTotal)}</div>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>Total por pagar</div>
            </div>
            <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", justifyContent: "center", gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{viewProv.plazo_dias || 0} días</div>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>Plazo de pago</div>
            </div>
          </div>
        </div>

        {/* Gráficos */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {/* Facturas por pagar */}
          <div className="card" style={{ padding: 20 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Facturas por pagar por mes de emisión</h4>
            {viewPorPagar.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--txt3)", fontSize: 13 }}>Sin compras por pagar</div>
            ) : (
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {viewPorPagar.map((c, i) => (
                  <div key={c.id || i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--bg4)", fontSize: 12 }}>
                    <span>{TIPO_DOC_NAMES[c.tipo_doc]?.slice(0, 3) || "DOC"} {c.nro_doc} — {fmtDate(c.fecha_docto)}</span>
                    <span className="mono" style={{ fontWeight: 600, color: "var(--amber)" }}>{fmtMoney(c.monto_total || 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Facturación Histórica */}
          <div className="card" style={{ padding: 20 }}>
            <h4 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px" }}>Facturación Histórica (neto)</h4>
            {facturacionPorMes.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--txt3)", fontSize: 13 }}>Sin datos</div>
            ) : (
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 160, paddingTop: 8 }}>
                {facturacionPorMes.map(([mes, val]) => (
                  <div key={mes} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div style={{ width: "100%", maxWidth: 40, background: "var(--cyan)", borderRadius: "4px 4px 0 0", height: `${Math.max((val / maxFactMes) * 140, 4)}px` }} title={fmtMoney(val)} />
                    <span style={{ fontSize: 9, color: "var(--txt3)", writingMode: "vertical-rl", transform: "rotate(180deg)", maxHeight: 50, overflow: "hidden" }}>{mes}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Transferencias bancarias al proveedor */}
        <div className="card" style={{ overflow: "hidden", padding: 0, marginBottom: 20 }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h4 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Transferencias bancarias al proveedor</h4>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                {transferenciasBanco.length === 0
                  ? "Sin transferencias registradas"
                  : `${transferenciasBanco.length} movimiento${transferenciasBanco.length !== 1 ? "s" : ""} — Total ${fmtMoney(transferenciasBanco.reduce((s, t) => s + t.monto_aplicado, 0))}`}
              </div>
            </div>
          </div>
          {transferenciasBanco.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>
              No hay movimientos bancarios conciliados a facturas de este proveedor.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--bg4)", background: "var(--bg3)" }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Fecha</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Banco</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Descripción</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Factura</th>
                  <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Aplicado</th>
                </tr>
              </thead>
              <tbody>
                {transferenciasBanco.map((t, i) => (
                  <tr key={t.concId || i} style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <td className="mono" style={{ padding: "10px 12px" }}>{fmtDate(t.mov.fecha)}</td>
                    <td style={{ padding: "10px 12px", fontSize: 11 }}>
                      <span style={{ padding: "2px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600 }}>{t.mov.banco || "—"}</span>
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.mov.descripcion || ""}>{t.mov.descripcion || "—"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "var(--cyanBg)", color: "var(--cyan)" }}>
                        {(TIPO_DOC_NAMES[t.factura.tipo_doc] || "DOC").slice(0, 3).toUpperCase()} {t.factura.nro_doc}
                      </span>
                    </td>
                    <td className="mono" style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: "var(--green)" }}>
                      {fmtMoney(t.monto_aplicado)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--bg3)", fontWeight: 700 }}>
                  <td colSpan={4} style={{ padding: "10px 12px" }}>Total transferido</td>
                  <td className="mono" style={{ padding: "10px 12px", textAlign: "right", color: "var(--green)" }}>
                    {fmtMoney(transferenciasBanco.reduce((s, t) => s + t.monto_aplicado, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Tabla de facturas */}
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--cyan)" }}>Folio</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Razón Social</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--cyan)" }}>Fecha Emisión</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Pago Est.</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--cyan)" }}>Período SII</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Monto Total</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontSize: 11, color: "var(--cyan)" }}>Estado de Pago</th>
              </tr>
            </thead>
            <tbody>
              {viewFacturas.map((c, i) => {
                const isPagada = concCompraIds.has(c.id!);
                const plazo = viewProv.plazo_dias;
                let pagoEst = "—";
                if (plazo && c.fecha_docto) {
                  const venc = new Date(new Date(c.fecha_docto + "T12:00:00").getTime() + plazo * 86400000);
                  pagoEst = fmtDate(venc.toISOString().slice(0, 10));
                }
                const tipoAbrev = TIPO_DOC_NAMES[c.tipo_doc]?.slice(0, 3).toUpperCase() || "DOC";
                return (
                  <tr key={c.id || i} style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 5, background: "var(--cyan)", color: "#fff" }}>{tipoAbrev}-EL</span>
                      <span className="mono" style={{ fontWeight: 600, marginLeft: 6 }}>{c.nro_doc}</span>
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.razon_social || "—"}</td>
                    <td className="mono" style={{ padding: "10px 12px" }}>{fmtDate(c.fecha_docto)}</td>
                    <td className="mono" style={{ padding: "10px 12px" }}>{pagoEst}</td>
                    <td className="mono" style={{ padding: "10px 12px" }}>{c.periodo}</td>
                    <td className="mono" style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600 }}>{fmtMoney(c.monto_total || 0)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>
                      {isPagada ? (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)" }}>Pagado</span>
                      ) : (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)" }}>Pendiente</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, background: "var(--bg3)" }}>
                <td colSpan={5} style={{ padding: "10px 12px" }}>Total</td>
                <td className="mono" style={{ padding: "10px 12px", textAlign: "right" }}>{fmtMoney(viewFacturas.reduce((s, c) => s + (c.monto_total || 0), 0))}</td>
                <td className="mono" style={{ padding: "10px 12px", textAlign: "right", color: "var(--amber)" }}>{fmtMoney(viewPorPagarTotal)} por pagar</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    );
  }

  // ==================== MODAL EDITAR / AGREGAR ====================
  const editModal = editRut && (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => !saving && setEditRut(null)}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 520, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
        <div style={{ padding: "18px 24px", background: "var(--cyan)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{addMode ? "Agregar Proveedor" : "Editar Proveedor"}</span>
          <button onClick={() => setEditRut(null)} disabled={saving} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>&times;</button>
        </div>
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>RUT *</label>
              <input value={editForm.rut} onChange={e => setEditForm({ ...editForm, rut: e.target.value })} disabled={!addMode}
                placeholder="76.123.456-7"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: addMode ? "var(--bg3)" : "var(--bg4)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Razón Social *</label>
              <input value={editForm.razon_social} onChange={e => setEditForm({ ...editForm, razon_social: e.target.value })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Comuna</label>
              <input value={editForm.comuna} onChange={e => setEditForm({ ...editForm, comuna: e.target.value })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Dirección</label>
              <input value={editForm.direccion} onChange={e => setEditForm({ ...editForm, direccion: e.target.value })}
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Contacto factura</label>
              <input value={editForm.contacto} onChange={e => setEditForm({ ...editForm, contacto: e.target.value })}
                placeholder="Email o teléfono"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Plazo de pago (días)</label>
              <input value={editForm.plazo_dias} onChange={e => setEditForm({ ...editForm, plazo_dias: e.target.value.replace(/\D/g, "") })}
                inputMode="numeric" placeholder="30"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer", padding: "4px 0" }}>
            <input type="checkbox" checked={editForm.cuenta_variable} onChange={e => setEditForm({ ...editForm, cuenta_variable: e.target.checked })}
              style={{ accentColor: "var(--cyan)", width: 16, height: 16 }} />
            <span>Aplicar plazo a todas las facturas de compra de este proveedor</span>
          </label>
        </div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={() => setEditRut(null)} disabled={saving}
            style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)" }}>
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving || !editForm.rut || !editForm.razon_social}
            style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer", background: "var(--cyan)", color: "#fff", border: "none", opacity: saving || !editForm.rut ? 0.5 : 1 }}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );

  // ==================== LISTA PRINCIPAL ====================
  return (
    <div>
      {editModal}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
        <div className="card" style={{ padding: 20 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(totalNetoComprado)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>Total neto comprado</div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: totalPorPagar > 0 ? "var(--amber)" : "var(--green)" }}>{fmtMoney(totalPorPagar)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>Total por pagar</div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{promedioPago} días</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>Promedio pago</div>
        </div>
      </div>

      {/* Toolbar: search + actions */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: "var(--txt3)" }}>{filtered.length} proveedores</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <input placeholder="Buscar proveedor..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ padding: "7px 12px 7px 30px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 12, width: 200, boxSizing: "border-box" }} />
            <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--txt3)", pointerEvents: "none" }}>&#x1F50D;</span>
          </div>
          <button onClick={() => openEdit(null)} title="Agregar proveedor"
            style={{ width: 32, height: 32, borderRadius: 8, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          <button onClick={handleExport} title="Exportar CSV"
            style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{"\u2193"}</button>
        </div>
      </div>

      {/* Tabla */}
      <div className="card" style={{ overflow: "hidden", padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
              <th onClick={() => handleSort("rut")} style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)", cursor: "pointer", userSelect: "none" }}>RUT{sortIcon("rut")}</th>
              <th onClick={() => handleSort("razon_social")} style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)", cursor: "pointer", userSelect: "none" }}>Razón Social{sortIcon("razon_social")}</th>
              <th onClick={() => handleSort("plazo_dias")} style={{ padding: "12px 14px", textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--cyan)", cursor: "pointer", userSelect: "none" }}>Plazo Pago{sortIcon("plazo_dias")}</th>
              <th onClick={() => handleSort("por_pagar")} style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600, fontSize: 12, color: "var(--cyan)", cursor: "pointer", userSelect: "none" }}>Saldo por Pagar{sortIcon("por_pagar")}</th>
              <th style={{ padding: "12px 14px", textAlign: "right", fontWeight: 600, fontSize: 12, color: "var(--txt3)" }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Sin proveedores</td></tr>
            ) : filtered.map(p => (
              <tr key={p.rut} style={{ borderBottom: "1px solid var(--bg4)" }}>
                <td className="mono" style={{ padding: "12px 14px", fontSize: 12 }}>{fmtRut(p.rut)}</td>
                <td style={{ padding: "12px 14px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.razon_social || "—"}</td>
                <td style={{ padding: "12px 14px" }}>{p.plazo_dias ? `${p.plazo_dias} días` : <span style={{ color: "var(--txt3)" }}>—</span>}</td>
                <td className="mono" style={{ padding: "12px 14px", textAlign: "right" }}>
                  {p.por_pagar > 0 ? (
                    <span style={{ fontWeight: 600, color: "var(--amber)" }}>{fmtMoney(p.por_pagar)}</span>
                  ) : (
                    <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 600 }}>Todo Pagado</span>
                  )}
                </td>
                <td style={{ padding: "12px 14px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <button onClick={() => setViewRut(p.rut)}
                    style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyan)", cursor: "pointer", marginRight: 6 }}>
                    Ver
                  </button>
                  <button onClick={() => openEdit(p)}
                    style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer" }}>
                    Editar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
