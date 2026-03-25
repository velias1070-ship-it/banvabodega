"use client";
import { useState, useMemo } from "react";
import {
  upsertConciliacion,
  updateMovimientoBanco,
  insertConciliacionItems,
  categorizarMovimiento,
  fetchProveedorCuentas,
  upsertProveedorCuenta,
} from "@/lib/db";
import type {
  DBMovimientoBanco, DBRcvCompra, DBRcvVenta, DBConciliacion,
  DBConciliacionItem, DBPlanCuentas, DBProveedorCuenta,
} from "@/lib/db";

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const TIPO_DOC: Record<number | string, string> = {
  33: "FAC", 34: "FAC-EX", 39: "BOL", 41: "BOL-EX",
  46: "FC", 52: "GUIA", 56: "ND", 61: "NC", 71: "BHE",
};

interface DocSeleccionado {
  id: string;
  tipo: "rcv_compra" | "rcv_venta";
  tipo_doc: string;
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
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);

  const movAbs = Math.abs(mov.monto);
  const totalAsignado = selected.reduce((s, d) => s + d.monto_aplicado, 0);
  const saldoPorAsignar = movAbs - totalAsignado;

  // IDs ya conciliados (de otras conciliaciones)
  const concCompraIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_compra_id).map(c => c.rcv_compra_id));
  const concVentaIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_venta_id).map(c => c.rcv_venta_id));
  const selectedIds = new Set(selected.map(d => d.id));

  // Documentos disponibles
  const docsDisponibles = useMemo(() => {
    const docs: { id: string; tipo: "rcv_compra" | "rcv_venta"; tipo_doc: string; nro: string; rut: string; razon_social: string; fecha: string; monto_total: number }[] = [];

    if (tipoFiltro !== "ventas") {
      for (const c of compras) {
        if (concCompraIds.has(c.id!) || selectedIds.has(c.id!)) continue;
        docs.push({
          id: c.id!, tipo: "rcv_compra", tipo_doc: TIPO_DOC[c.tipo_doc] || String(c.tipo_doc),
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
          nro: v.folio || v.nro || "", rut: v.rut_emisor || "", razon_social: "",
          fecha: v.fecha_docto || "", monto_total: v.monto_total || 0,
        });
      }
    }

    // Filtro de búsqueda
    if (search) {
      const q = search.toLowerCase();
      return docs.filter(d =>
        d.razon_social.toLowerCase().includes(q) ||
        d.rut.includes(q) ||
        d.nro.includes(q)
      );
    }

    // Ordenar por monto más cercano al saldo
    return docs.sort((a, b) => {
      const diffA = Math.abs(a.monto_total - saldoPorAsignar);
      const diffB = Math.abs(b.monto_total - saldoPorAsignar);
      return diffA - diffB;
    });
  }, [compras, ventas, tipoFiltro, search, concCompraIds, concVentaIds, selectedIds, saldoPorAsignar]);

  // Seleccionar documento
  const handleSelect = (doc: typeof docsDisponibles[0]) => {
    const montoAplicar = Math.min(doc.monto_total, saldoPorAsignar);
    setSelected(prev => [...prev, { ...doc, monto_aplicado: montoAplicar > 0 ? montoAplicar : doc.monto_total }]);
  };

  // Quitar documento
  const handleRemove = (id: string) => {
    setSelected(prev => prev.filter(d => d.id !== id));
  };

  // Editar monto aplicado
  const handleEditMonto = (id: string, monto: number) => {
    setSelected(prev => prev.map(d => d.id === id ? { ...d, monto_aplicado: monto } : d));
  };

  // Guardar
  const handleSave = async () => {
    if (selected.length === 0) return;
    setSaving(true);

    try {
      // 1. Crear conciliación principal
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
      };
      await upsertConciliacion(c);

      // 2. Obtener el ID de la conciliación creada (buscar la más reciente)
      const { getSupabase } = await import("@/lib/supabase");
      const sb = getSupabase();
      let concId = "";
      if (sb) {
        const { data } = await sb.from("conciliaciones").select("id")
          .eq("movimiento_banco_id", mov.id!)
          .eq("estado", "confirmado")
          .order("created_at", { ascending: false })
          .limit(1);
        concId = data?.[0]?.id || "";
      }

      // 3. Crear items si hay múltiples documentos
      if (concId && selected.length > 0) {
        const items: DBConciliacionItem[] = selected.map(d => ({
          conciliacion_id: concId,
          documento_tipo: d.tipo,
          documento_id: d.id,
          monto_aplicado: d.monto_aplicado,
        }));
        await insertConciliacionItems(items);
      }

      // 4. Marcar movimiento como conciliado
      await updateMovimientoBanco(mov.id!, { estado_conciliacion: "conciliado" } as Partial<DBMovimientoBanco>);

      // 5. Asignar cuenta contable si el proveedor tiene una
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
      <div style={{ width: "95%", maxWidth: 900, maxHeight: "90vh", background: "var(--bg2)", borderRadius: 16, border: "1px solid var(--bg4)", display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "16px 20px", background: "var(--bg3)", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Conciliar</h3>
          <button onClick={onClose} disabled={saving}
            style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        {/* Top: Movimiento + Documentos seleccionados */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: 16 }}>
          {/* Movimiento bancario */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 6 }}>Movimiento Bancario</div>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 11 }}>{fmtDate(mov.fecha)}</span>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: mov.monto < 0 ? "var(--redBg)" : "var(--greenBg)", color: mov.monto < 0 ? "var(--red)" : "var(--green)", fontWeight: 600 }}>
                  {mov.monto < 0 ? "Egreso" : "Ingreso"}
                </span>
              </div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>{mov.descripcion || "—"}</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 800 }}>{fmtMoney(movAbs)}</div>
              <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: saldoPorAsignar === 0 ? "var(--green)" : "var(--amber)" }}>
                Saldo por asignar: {fmtMoney(Math.max(0, saldoPorAsignar))}
              </div>
            </div>
          </div>

          {/* Documentos seleccionados */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 6 }}>Documentos de respaldo</div>
            <div className="card" style={{ padding: 12, minHeight: 100 }}>
              {selected.length === 0 ? (
                <div style={{ color: "var(--txt3)", fontSize: 12, textAlign: "center", padding: 20 }}>
                  Selecciona documentos abajo para conciliar
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {selected.map(d => (
                    <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 6, background: "var(--bg3)" }}>
                      <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 4px", borderRadius: 3, background: "var(--cyanBg)", color: "var(--cyan)" }}>
                        {d.tipo_doc} {d.nro}
                      </span>
                      <span style={{ fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.razon_social || d.rut}
                      </span>
                      <input type="number" value={d.monto_aplicado} onChange={e => handleEditMonto(d.id, Number(e.target.value))}
                        className="mono" style={{ width: 90, padding: "2px 4px", fontSize: 11, textAlign: "right", background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 4, color: "var(--txt)" }} />
                      <button onClick={() => handleRemove(d.id)}
                        style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
                    </div>
                  ))}
                  <div className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginTop: 4 }}>
                    Total: {fmtMoney(totalAsignado)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Nota opcional */}
        <div style={{ padding: "0 16px 8px" }}>
          <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Nota opcional..."
            style={{ width: "100%", padding: "6px 10px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
        </div>

        {/* Botón guardar */}
        <div style={{ padding: "0 16px 12px", display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={handleSave} disabled={selected.length === 0 || saving}
            className="scan-btn green" style={{ padding: "8px 24px", fontSize: 12, opacity: selected.length === 0 ? 0.5 : 1 }}>
            {saving ? "Guardando..." : saldoPorAsignar === 0 ? "Guardar conciliación" : `Guardar (saldo: ${fmtMoney(saldoPorAsignar)})`}
          </button>
        </div>

        {/* Filtros + lista de documentos */}
        <div style={{ borderTop: "1px solid var(--bg4)", padding: "12px 16px 0", flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por RUT, razón social, N° doc..."
              style={{ flex: 1, padding: "6px 10px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
            <div style={{ display: "flex", gap: 2, background: "var(--bg3)", borderRadius: 6, padding: 2 }}>
              {(["compras", "ventas", "todos"] as const).map(f => (
                <button key={f} onClick={() => setTipoFiltro(f)}
                  style={{
                    padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer", border: "none",
                    background: tipoFiltro === f ? "var(--cyanBg)" : "transparent",
                    color: tipoFiltro === f ? "var(--cyan)" : "var(--txt3)",
                  }}>
                  {f === "compras" ? "Facturas Compra" : f === "ventas" ? "Facturas Venta" : "Todos"}
                </button>
              ))}
            </div>
          </div>

          {/* Tabla de documentos */}
          <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
            <table className="tbl" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>Saldo</th><th>Monto</th><th>Fecha</th><th>Tipo</th><th>Proveedor/Cliente</th><th>RUT</th><th></th>
                </tr>
              </thead>
              <tbody>
                {docsDisponibles.slice(0, 50).map(d => (
                  <tr key={d.id} style={{ background: Math.abs(d.monto_total - saldoPorAsignar) < 100 ? "var(--greenBg)" : "transparent" }}>
                    <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(d.monto_total)}</td>
                    <td className="mono">{fmtMoney(d.monto_total)}</td>
                    <td className="mono">{fmtDate(d.fecha)}</td>
                    <td>
                      <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 3, background: d.tipo === "rcv_compra" ? "var(--redBg)" : "var(--greenBg)", color: d.tipo === "rcv_compra" ? "var(--red)" : "var(--green)" }}>
                        {d.tipo_doc} {d.nro}
                      </span>
                    </td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.razon_social || "—"}
                    </td>
                    <td className="mono" style={{ fontSize: 10 }}>{d.rut}</td>
                    <td>
                      <button onClick={() => handleSelect(d)}
                        style={{ padding: "3px 12px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--amberBg)", color: "var(--amber)", border: "none", cursor: "pointer" }}>
                        Seleccionar
                      </button>
                    </td>
                  </tr>
                ))}
                {docsDisponibles.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: "center", padding: 20, color: "var(--txt3)" }}>Sin documentos disponibles</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
