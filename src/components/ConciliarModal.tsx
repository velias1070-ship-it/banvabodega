"use client";
import { useState, useMemo } from "react";
import {
  upsertConciliacion,
  syncEstadoConciliacion,
  insertConciliacionItems,
  categorizarMovimiento,
  upsertProveedorCuenta,
} from "@/lib/db";
import type {
  DBMovimientoBanco, DBRcvCompra, DBRcvVenta, DBConciliacion,
  DBConciliacionItem, DBPlanCuentas, DBProveedorCuenta,
} from "@/lib/db";

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const TIPO_DOC: Record<number | string, string> = {
  33: "FAC-EL", 34: "FAC-EX", 39: "BOL", 41: "BOL-EX",
  46: "FC", 52: "GUIA", 56: "ND", 61: "NC", 71: "BHE",
};

interface DocSeleccionado {
  id: string;
  tipo: "rcv_compra" | "rcv_venta";
  tipo_doc: string;
  tipo_doc_num: number | string;
  nro: string;
  rut: string;
  razon_social: string;
  fecha: string;
  monto_total: number;
  monto_aplicado: number;
}

interface Props {
  mov: DBMovimientoBanco;
  compras: DBRcvCompra[];
  ventas: DBRcvVenta[];
  conciliaciones: DBConciliacion[];
  cuentasHoja: DBPlanCuentas[];
  provCuentas: DBProveedorCuenta[];
  empresaId: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function ConciliarModal({ mov, compras, ventas, conciliaciones, cuentasHoja, provCuentas, empresaId, onClose, onSaved }: Props) {
  const [selected, setSelected] = useState<DocSeleccionado[]>([]);
  const [search, setSearch] = useState("");
  const [tipoFiltro, setTipoFiltro] = useState<"compras" | "ventas" | "todos">(mov.monto < 0 ? "compras" : "ventas");
  const [sortBy, setSortBy] = useState<"cercania" | "monto" | "fecha" | "descripcion">("cercania");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);

  const movAbs = Math.abs(mov.monto);
  const yaConc = mov.monto_conciliado || 0;
  const disponible = movAbs - yaConc;
  const totalAsignado = selected.reduce((s, d) => s + d.monto_aplicado, 0);
  const saldoPorAsignar = disponible - totalAsignado;

  // IDs ya conciliados
  const concCompraIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_compra_id).map(c => c.rcv_compra_id));
  const concVentaIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_venta_id).map(c => c.rcv_venta_id));
  const selectedIds = new Set(selected.map(d => d.id));

  // Documentos disponibles
  const docsDisponibles = useMemo(() => {
    const docs: { id: string; tipo: "rcv_compra" | "rcv_venta"; tipo_doc: string; tipo_doc_num: number | string; nro: string; rut: string; razon_social: string; fecha: string; monto_total: number }[] = [];

    if (tipoFiltro !== "ventas") {
      for (const c of compras) {
        if (concCompraIds.has(c.id!) || selectedIds.has(c.id!)) continue;
        docs.push({
          id: c.id!, tipo: "rcv_compra", tipo_doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
          tipo_doc_num: c.tipo_doc,
          nro: c.nro_doc || "", rut: c.rut_proveedor || "", razon_social: c.razon_social || "",
          fecha: c.fecha_docto || "", monto_total: c.monto_total || 0,
        });
      }
    }
    if (tipoFiltro !== "compras") {
      for (const v of ventas) {
        if (concVentaIds.has(v.id!) || selectedIds.has(v.id!)) continue;
        docs.push({
          id: v.id!, tipo: "rcv_venta", tipo_doc: TIPO_DOC[v.tipo_doc] || String(v.tipo_doc),
          tipo_doc_num: v.tipo_doc,
          nro: v.folio || v.nro || "", rut: v.rut_emisor || "", razon_social: "",
          fecha: v.fecha_docto || "", monto_total: v.monto_total || 0,
        });
      }
    }

    const target = saldoPorAsignar > 0 ? saldoPorAsignar : movAbs;
    const movFecha = new Date(mov.fecha + "T12:00:00").getTime();
    const movDesc = (mov.descripcion || "").toLowerCase();
    // Mapa de plazos por RUT
    const plazoByRut = new Map(provCuentas.filter(p => p.plazo_dias).map(p => [p.rut_proveedor, p.plazo_dias!]));

    let filteredDocs = docs;
    if (search) {
      const q = search.toLowerCase();
      filteredDocs = docs.filter(d => d.razon_social.toLowerCase().includes(q) || d.rut.includes(q) || d.nro.includes(q));
    }

    // Score inteligente: menor = mejor match
    const isMP = mov.banco === "MercadoPago" || movDesc.startsWith("retiro mp");
    const scoreDoc = (d: typeof docs[0]): { score: number; diasDiff: number; montoDiff: number } => {
      // 1. Monto -- diferencia porcentual al target (0 = match perfecto)
      const montoScore = target > 0 ? Math.abs(d.monto_total - target) / target : 1;
      const montoDiff = Math.abs(d.monto_total - target);

      // 2. Proveedor -- si la descripcion del movimiento menciona al proveedor
      let provMatch = 1;
      if (!isMP) {
        const nombreProv = d.razon_social.toLowerCase();
        const palabras = nombreProv.split(/\s+/).filter(p => p.length > 3);
        provMatch = palabras.some(p => movDesc.includes(p)) ? 0 : 1;
      }

      // 3. Plazo de pago -- la fecha del movimiento deberia ser ~plazo dias despues de la factura
      let fechaScore = 1;
      let diasDiff = 0;
      if (d.fecha) {
        const docFecha = new Date(d.fecha + "T12:00:00").getTime();
        diasDiff = Math.round((movFecha - docFecha) / 86400000);
        const plazo = plazoByRut.get(d.rut) || 30;
        fechaScore = Math.abs(diasDiff - plazo) / plazo;
        if (diasDiff < 0) fechaScore = 3;
      }

      // Pesos: MP → fecha 55% + monto 45% (proveedor no aporta). Normal → fecha 40% + monto 35% + proveedor 25%
      const score = isMP
        ? Math.min(fechaScore, 3) * 0.55 + montoScore * 0.45
        : Math.min(fechaScore, 3) * 0.4 + montoScore * 0.35 + provMatch * 0.25;
      return { score, diasDiff, montoDiff };
    };

    // Pre-compute scores for sorting and display
    const scored = filteredDocs.map(d => ({ ...d, ...scoreDoc(d) }));
    scored.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "cercania") cmp = a.score - b.score;
      else if (sortBy === "fecha") cmp = (a.fecha || "").localeCompare(b.fecha || "");
      else if (sortBy === "monto") cmp = a.monto_total - b.monto_total;
      else if (sortBy === "descripcion") cmp = (a.razon_social || "").localeCompare(b.razon_social || "");
      return sortDir === "desc" ? -cmp : cmp;
    });
    return scored;
  }, [compras, ventas, tipoFiltro, search, concCompraIds, concVentaIds, selectedIds, sortBy, sortDir, saldoPorAsignar, movAbs, mov.fecha, mov.descripcion, provCuentas]);

  const toggleSort = (key: typeof sortBy) => {
    if (sortBy === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(key); setSortDir("desc"); }
  };
  const sortIcon = (key: typeof sortBy) => sortBy === key ? (sortDir === "desc" ? " \u2193" : " \u2191") : "";

  const handleSelect = (doc: typeof docsDisponibles[0]) => {
    const montoAplicar = saldoPorAsignar > 0 ? Math.min(doc.monto_total, saldoPorAsignar) : doc.monto_total;
    setSelected(prev => [...prev, { ...doc, monto_aplicado: montoAplicar }]);
  };

  const handleRemove = (id: string) => {
    setSelected(prev => prev.filter(d => d.id !== id));
  };

  const handleEditMonto = (id: string, monto: number) => {
    setSelected(prev => prev.map(d => d.id === id ? { ...d, monto_aplicado: monto } : d));
  };

  const handleSave = async () => {
    if (selected.length === 0) return;
    setSaving(true);
    try {
      const c: DBConciliacion = {
        empresa_id: empresaId,
        movimiento_banco_id: mov.id!,
        rcv_compra_id: selected.length === 1 && selected[0].tipo === "rcv_compra" ? selected[0].id : null,
        rcv_venta_id: selected.length === 1 && selected[0].tipo === "rcv_venta" ? selected[0].id : null,
        confianza: 1,
        estado: "confirmado",
        tipo_partida: selected.length === 1 ? "match" : "multi_doc",
        metodo: "manual",
        notas: nota.trim() || null,
        created_by: "admin",
        monto_aplicado: totalAsignado,
      };
      await upsertConciliacion(c);

      const { getSupabase } = await import("@/lib/supabase");
      const sb = getSupabase();
      let concId = "";
      if (sb) {
        const { data } = await sb.from("conciliaciones").select("id")
          .eq("movimiento_banco_id", mov.id!).eq("estado", "confirmado")
          .order("created_at", { ascending: false }).limit(1);
        concId = data?.[0]?.id || "";
      }

      if (concId && selected.length > 0) {
        const items: DBConciliacionItem[] = selected.map(d => ({
          conciliacion_id: concId,
          documento_tipo: d.tipo,
          documento_id: d.id,
          monto_aplicado: d.monto_aplicado,
        }));
        await insertConciliacionItems(items);
      }

      await syncEstadoConciliacion(mov.id!, mov.monto);

      if (selected.length > 0 && selected[0].rut) {
        const pc = provCuentas.find(p => p.rut_proveedor === selected[0].rut);
        if (pc?.categoria_cuenta_id && !pc.cuenta_variable) {
          await categorizarMovimiento(mov.id!, pc.categoria_cuenta_id);
        }
      }

      onSaved();
    } catch (err) {
      console.error("Error guardando conciliación:", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ width: "95%", maxWidth: 1000, maxHeight: "92vh", background: "var(--bg2)", borderRadius: 16, border: "1px solid var(--bg4)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "14px 20px", background: "var(--bg3)", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Conciliar</h3>
          <button onClick={onClose} disabled={saving} style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        {/* 3 columnas: Movimiento → Montos → Facturas */}
        <div style={{ display: "grid", gridTemplateColumns: "280px 1fr 320px", gap: 0, flex: 1, overflow: "hidden" }}>

          {/* IZQUIERDA: Movimiento Bancario */}
          <div style={{ padding: 16, borderRight: "1px solid var(--bg4)", display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 8 }}>Movimiento Bancario</div>
            <div className="card" style={{ padding: 12, flex: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 11 }}>{fmtDate(mov.fecha)}</span>
                <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, background: mov.monto < 0 ? "var(--redBg)" : "var(--greenBg)", color: mov.monto < 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>
                  {mov.monto < 0 ? "Egreso" : "Ingreso"}
                </span>
              </div>
              <div style={{ fontSize: 12, marginBottom: 6, color: "var(--txt2)" }}>{mov.descripcion || "—"}</div>
              <div className="mono" style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(disponible)}</div>
              {yaConc > 0 && <div style={{ fontSize: 10, color: "var(--amber)", marginTop: 2 }}>Total {fmtMoney(movAbs)} &middot; ya conciliado {fmtMoney(yaConc)}</div>}
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>{mov.banco}</div>
            </div>
            <div style={{
              marginTop: 12, padding: "8px 12px", borderRadius: 8, textAlign: "center",
              fontSize: 13, fontWeight: 700,
              background: saldoPorAsignar === 0 ? "var(--greenBg)" : saldoPorAsignar < 0 ? "var(--redBg)" : "var(--amberBg)",
              color: saldoPorAsignar === 0 ? "var(--green)" : saldoPorAsignar < 0 ? "var(--red)" : "var(--amber)",
            }}>
              Saldo por asignar {fmtMoney(Math.max(0, saldoPorAsignar))} {saldoPorAsignar === 0 && "✓"}
            </div>

            {/* Nota */}
            <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Nota opcional..."
              style={{ marginTop: 12, width: "100%", padding: "6px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, boxSizing: "border-box" }} />

            {/* Botón guardar */}
            <button onClick={handleSave} disabled={selected.length === 0 || saving}
              className="scan-btn green" style={{ marginTop: 12, width: "100%", padding: "10px 0", fontSize: 13, opacity: selected.length === 0 ? 0.5 : 1 }}>
              {saving ? "Guardando..." : "Guardar conciliación"}
            </button>
          </div>

          {/* CENTRO: Montos a asignar (conectores) */}
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, justifyContent: selected.length > 0 ? "flex-start" : "center", alignItems: "center", overflow: "auto" }}>
            {selected.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>→</div>
                Selecciona facturas de la derecha
              </div>
            ) : selected.map(d => (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <div style={{ textAlign: "center", flex: 1 }}>
                  <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 4 }}>Monto a asignar</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                    <span style={{ fontSize: 12, color: "var(--txt3)" }}>$</span>
                    <input type="text" value={d.monto_aplicado.toLocaleString("es-CL")}
                      onChange={e => {
                        const val = parseInt(e.target.value.replace(/\D/g, "")) || 0;
                        handleEditMonto(d.id, val);
                      }}
                      className="mono"
                      style={{ width: 110, padding: "6px 8px", fontSize: 14, fontWeight: 700, textAlign: "right", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
                  </div>
                </div>
                <span style={{ fontSize: 16, color: "var(--txt3)" }}>→</span>
              </div>
            ))}
          </div>

          {/* DERECHA: Documentos de respaldo (seleccionados + lista) */}
          <div style={{ borderLeft: "1px solid var(--bg4)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", padding: "12px 12px 8px" }}>Documentos de respaldo</div>

            {/* Facturas seleccionadas */}
            {selected.length > 0 && (
              <div style={{ padding: "0 12px 8px", borderBottom: "1px solid var(--bg4)" }}>
                {selected.map(d => {
                  const saldoPorPagar = d.monto_total - d.monto_aplicado;
                  return (
                    <div key={d.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--bg4)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span className="mono" style={{ fontSize: 10 }}>{fmtDate(d.fecha)}</span>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "var(--redBg)", color: "var(--red)" }}>
                              {d.tipo_doc} {d.nro}
                            </span>
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 600 }}>{d.razon_social || d.rut}</div>
                          <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{d.rut}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <button onClick={() => handleRemove(d.id)}
                            style={{ background: "none", border: "none", color: "var(--txt3)", cursor: "pointer", fontSize: 14 }}>✕</button>
                          <div className="mono" style={{ fontSize: 16, fontWeight: 800 }}>{fmtMoney(d.monto_total)}</div>
                        </div>
                      </div>
                      <div style={{ textAlign: "right", fontSize: 11, fontWeight: 600, marginTop: 2, color: saldoPorPagar === 0 ? "var(--green)" : "var(--cyan)" }}>
                        Saldo por pagar {fmtMoney(Math.max(0, saldoPorPagar))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Buscador + filtros */}
            <div style={{ padding: "8px 12px", display: "flex", gap: 6, alignItems: "center" }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar RUT, nombre, N°..."
                style={{ flex: 1, padding: "5px 8px", fontSize: 10, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }} />
              <select value={tipoFiltro} onChange={e => setTipoFiltro(e.target.value as typeof tipoFiltro)}
                style={{ padding: "5px 6px", fontSize: 10, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 4 }}>
                <option value="compras">Compras</option>
                <option value="ventas">Ventas</option>
                <option value="todos">Todos</option>
              </select>
            </div>

            {/* Lista de facturas */}
            <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <th onClick={() => toggleSort("cercania")} style={{ textAlign: "left", padding: "4px 0", color: sortBy === "cercania" ? "var(--green)" : "var(--cyan)", fontWeight: 600, cursor: "pointer" }}>{sortBy === "cercania" ? "\u2248 Saldo" : "Saldo"}{sortIcon("cercania")}</th>
                    <th onClick={() => toggleSort("fecha")} style={{ textAlign: "left", padding: "4px 0", color: "var(--cyan)", fontWeight: 600, cursor: "pointer" }}>Fecha{sortIcon("fecha")}</th>
                    <th style={{ textAlign: "left", padding: "4px 0", color: "var(--txt3)", fontWeight: 600 }}>Tipo</th>
                    <th onClick={() => toggleSort("descripcion")} style={{ textAlign: "left", padding: "4px 0", color: "var(--cyan)", fontWeight: 600, cursor: "pointer" }}>Descripci&oacute;n{sortIcon("descripcion")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {docsDisponibles.slice(0, 50).map(d => {
                    const isAlta = d.score < 0.15;
                    const isMedia = d.score >= 0.15 && d.score < 0.5;
                    return (
                      <tr key={d.id} style={{ borderBottom: "1px solid var(--bg4)", background: isAlta ? "var(--greenBg)" : "transparent" }}>
                        <td className="mono" style={{ padding: "6px 0", fontWeight: 700 }}>
                          {fmtMoney(d.monto_total)}
                          {d.montoDiff > 0 && <div style={{ fontSize: 8, color: "var(--amber)" }}>diff {fmtMoney(d.montoDiff)}</div>}
                        </td>
                        <td className="mono" style={{ padding: "6px 0" }}>
                          {fmtDate(d.fecha)}
                          {d.fecha && <div style={{ fontSize: 8, color: d.diasDiff < 0 ? "var(--red)" : d.diasDiff <= 45 ? "var(--green)" : "var(--amber)" }}>{d.diasDiff}d</div>}
                        </td>
                        <td>
                          <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3, background: d.tipo === "rcv_compra" ? "var(--redBg)" : "var(--greenBg)", color: d.tipo === "rcv_compra" ? "var(--red)" : "var(--green)" }}>
                            {d.tipo_doc} {d.nro}
                          </span>
                          {(isAlta || isMedia) && <span style={{ fontSize: 7, fontWeight: 700, marginLeft: 3, padding: "1px 4px", borderRadius: 3, background: isAlta ? "var(--greenBg)" : "var(--amberBg)", color: isAlta ? "var(--green)" : "var(--amber)" }}>{isAlta ? "ALTA" : "MEDIA"}</span>}
                        </td>
                        <td style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "6px 4px" }}>
                          {d.razon_social || d.rut || "\u2014"}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button onClick={() => handleSelect(d)}
                            style={{ padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: isAlta ? "var(--greenBg)" : "var(--amberBg)", color: isAlta ? "var(--green)" : "var(--amber)", border: "none", cursor: "pointer" }}>
                            Seleccionar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {docsDisponibles.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: "center", padding: 20, color: "var(--txt3)" }}>Sin documentos</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
