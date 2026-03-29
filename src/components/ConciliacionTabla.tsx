"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchMovimientosBanco,
  fetchRcvCompras,
  fetchRcvVentas,
  fetchConciliaciones,
  updateMovimientoBanco,
  fetchPlanCuentasHojas,
  fetchProveedorCuentas,
  upsertConciliacion,
  categorizarMovimiento,
} from "@/lib/db";
import type {
  DBEmpresa, DBMovimientoBanco, DBRcvCompra, DBRcvVenta, DBConciliacion,
  DBPlanCuentas, DBProveedorCuenta,
} from "@/lib/db";
import dynamic from "next/dynamic";
const ConciliarModal = dynamic(() => import("@/components/ConciliarModal"), { ssr: false });

const fmtMoney = (n: number) => n.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const fmtDate = (d: string | null) => d ? new Date(d + "T12:00:00").toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

// Filtrar movimientos reales
function isMovReal(m: DBMovimientoBanco): boolean {
  const desc = (m.descripcion || "").toUpperCase();
  if (desc.startsWith("VENTA ML") || desc.startsWith("BONIFICACION") || desc.startsWith("DEVOLUCION") || desc.startsWith("PAGO MP #")) return false;
  if ((desc.startsWith("COMPRA ML") || desc.startsWith("COMPRA MP"))) {
    try {
      const meta = typeof m.metadata === "string" ? JSON.parse(m.metadata) : m.metadata;
      const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
      if (parsed?.medio_pago && parsed.medio_pago !== "account_money") return false;
    } catch { /* keep */ }
  }
  return true;
}

type SortKey = "fecha" | "descripcion" | "monto";
type SortDir = "asc" | "desc";
type TabFilter = "todos" | "abonos" | "cargos";

export default function ConciliacionTabla({ empresa, periodo, initialFilter }: { empresa: DBEmpresa; periodo: string; initialFilter?: string }) {
  const [movBanco, setMovBanco] = useState<DBMovimientoBanco[]>([]);
  const [compras, setCompras] = useState<DBRcvCompra[]>([]);
  const [ventas, setVentas] = useState<DBRcvVenta[]>([]);
  const [conciliaciones, setConciliaciones] = useState<DBConciliacion[]>([]);
  const [cuentasHoja, setCuentasHoja] = useState<DBPlanCuentas[]>([]);
  const [provCuentas, setProvCuentas] = useState<DBProveedorCuenta[]>([]);
  const [loading, setLoading] = useState(true);

  // Filtros
  const [tab, setTab] = useState<TabFilter>((initialFilter === "abonos" || initialFilter === "cargos") ? initialFilter : "todos");
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("fecha");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Períodos seleccionados
  const [periodos, setPeriodos] = useState<string[]>([periodo]);

  // Modal
  const [conciliarMov, setConciliarMov] = useState<DBMovimientoBanco | null>(null);
  // Dropdown acciones
  const [showActions, setShowActions] = useState<string | null>(null);
  // Clasificar sin documento
  const [clasificarMov, setClasificarMov] = useState<DBMovimientoBanco | null>(null);
  const [clasificarCuenta, setClasificarCuenta] = useState("");
  // Sync MP
  const [syncingMP, setSyncingMP] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const periodoOpts = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const val = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("es-CL", { month: "short", year: "numeric" }).replace(/^./, c => c.toUpperCase());
      opts.push({ value: val, label });
    }
    return opts;
  }, []);

  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const allPeriods = periodos.length > 0 ? periodos : [periodo];
    let minDesde = "9999-12-31", maxHasta = "0000-01-01";
    for (const p of allPeriods) {
      const y = parseInt(p.slice(0, 4));
      const m = parseInt(p.slice(4, 6));
      const desde = `${y}-${String(m).padStart(2, "0")}-01`;
      const hasta = `${y}-${String(m).padStart(2, "0")}-${new Date(y, m, 0).getDate()}`;
      if (desde < minDesde) minDesde = desde;
      if (hasta > maxHasta) maxHasta = hasta;
    }
    const [m, c, v, conc, ctas, pc] = await Promise.all([
      fetchMovimientosBanco(empresa.id, { desde: minDesde, hasta: maxHasta }),
      fetchRcvCompras(empresa.id),
      fetchRcvVentas(empresa.id, periodo),
      fetchConciliaciones(empresa.id),
      fetchPlanCuentasHojas(),
      fetchProveedorCuentas(),
    ]);
    setMovBanco(m); setCompras(c); setVentas(v); setConciliaciones(conc); setCuentasHoja(ctas); setProvCuentas(pc);
    setLoading(false);
  }, [empresa.id, periodo, periodos]);

  useEffect(() => { load(); }, [load]);

  const concMovIds = useMemo(() => new Set(conciliaciones.filter(c => c.estado !== "rechazado").map(c => c.movimiento_banco_id)), [conciliaciones]);

  // Filtrar y ordenar
  const filtered = useMemo(() => {
    let list = movBanco.filter(isMovReal);
    if (soloPendientes) list = list.filter(m => !concMovIds.has(m.id!) && m.estado_conciliacion !== "ignorado" && m.estado_conciliacion !== "conciliado");
    if (tab === "abonos") list = list.filter(m => m.monto > 0);
    else if (tab === "cargos") list = list.filter(m => m.monto < 0);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(m => (m.descripcion || "").toLowerCase().includes(q) || (m.referencia || "").toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "fecha") cmp = (a.fecha || "").localeCompare(b.fecha || "");
      else if (sortKey === "descripcion") cmp = (a.descripcion || "").localeCompare(b.descripcion || "");
      else if (sortKey === "monto") cmp = a.monto - b.monto;
      return sortDir === "desc" ? -cmp : cmp;
    });
    return list;
  }, [movBanco, tab, soloPendientes, search, sortKey, sortDir, concMovIds]);

  // Contadores
  const movReales = movBanco.filter(isMovReal);
  const pendientes = movReales.filter(m => !concMovIds.has(m.id!) && m.estado_conciliacion !== "ignorado" && m.estado_conciliacion !== "conciliado");
  const abonosPend = pendientes.filter(m => m.monto > 0);
  const cargosPend = pendientes.filter(m => m.monto < 0);

  // KPIs
  const concCompraIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_compra_id).map(c => c.rcv_compra_id));
  const concVentaIds = new Set(conciliaciones.filter(c => c.estado === "confirmado" && c.rcv_venta_id).map(c => c.rcv_venta_id));
  const porCobrar = ventas.filter(v => !concVentaIds.has(v.id!)).reduce((s, v) => s + (v.monto_total || 0), 0);
  const porPagar = compras.filter(c => !concCompraIds.has(c.id!)).reduce((s, c) => s + (c.monto_total || 0), 0);
  const totalCargos = filtered.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);
  const totalAbonos = filtered.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  const togglePeriodo = (p: string) => {
    setPeriodos(prev => {
      if (prev.includes(p)) {
        const next = prev.filter(x => x !== p);
        return next.length === 0 ? [periodo] : next;
      }
      return [...prev, p];
    });
  };

  // Clasificar sin documento
  const handleClasificar = async () => {
    if (!clasificarMov || !clasificarCuenta || !empresa.id) return;
    await upsertConciliacion({
      empresa_id: empresa.id, movimiento_banco_id: clasificarMov.id!,
      rcv_compra_id: null, rcv_venta_id: null, confianza: 1,
      estado: "confirmado", tipo_partida: "clasificacion_directa",
      metodo: "manual", notas: null, created_by: "admin",
    });
    await updateMovimientoBanco(clasificarMov.id!, { estado_conciliacion: "conciliado" } as Partial<DBMovimientoBanco>);
    await categorizarMovimiento(clasificarMov.id!, clasificarCuenta);
    setMovBanco(prev => prev.map(m => m.id === clasificarMov.id ? { ...m, estado_conciliacion: "conciliado" } : m));
    setClasificarMov(null); setClasificarCuenta("");
  };

  // Ignorar
  const handleIgnorar = async (m: DBMovimientoBanco) => {
    await updateMovimientoBanco(m.id!, { estado_conciliacion: "ignorado" } as Partial<DBMovimientoBanco>);
    setMovBanco(prev => prev.map(x => x.id === m.id ? { ...x, estado_conciliacion: "ignorado" } : x));
    setShowActions(null);
  };

  // Sync MP retiros
  const handleSyncMP = async () => {
    setSyncingMP(true);
    setSyncMsg(null);
    try {
      // Sync para cada período seleccionado
      let totalRetiros = 0;
      for (const p of periodos) {
        const res = await fetch("/api/mp/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: p }) });
        const d = await res.json();
        if (d.error) { setSyncMsg(`Error: ${d.error}`); break; }
        totalRetiros += d.retiros_nuevos || 0;
      }
      if (!syncMsg?.startsWith("Error")) {
        setSyncMsg(totalRetiros > 0 ? `${totalRetiros} retiros importados` : "Sin retiros nuevos");
      }
      load();
    } catch (e) {
      setSyncMsg(`Error: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncingMP(false);
    }
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: "var(--green)" }}>{fmtMoney(porCobrar)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>Por Cobrar <span style={{ fontSize: 10 }}>(incluye IVA)</span></div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: "var(--red)" }}>{fmtMoney(porPagar)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>Por Pagar <span style={{ fontSize: 10 }}>(incluye IVA)</span></div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="mono" style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(porCobrar - porPagar)}</div>
          <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>Saldo Neto</div>
        </div>
      </div>

      {/* Períodos */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--txt3)", marginRight: 4 }}>Períodos:</span>
        {periodoOpts.map(o => (
          <button key={o.value} onClick={() => togglePeriodo(o.value)}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: "pointer",
              background: periodos.includes(o.value) ? "var(--cyanBg)" : "var(--bg3)",
              color: periodos.includes(o.value) ? "var(--cyan)" : "var(--txt3)",
              border: periodos.includes(o.value) ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)",
            }}>
            {o.label}
          </button>
        ))}
      </div>

      {/* Tabs + filtros */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 0, background: "var(--bg3)", borderRadius: 8, overflow: "hidden" }}>
          {([
            { key: "todos" as TabFilter, label: "Todos", count: pendientes.length },
            { key: "abonos" as TabFilter, label: "Abonos", count: abonosPend.length },
            { key: "cargos" as TabFilter, label: "Cargos", count: cargosPend.length },
          ]).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: "8px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", border: "none",
                background: tab === t.key ? "var(--cyanBg)" : "transparent",
                color: tab === t.key ? "var(--cyan)" : "var(--txt3)",
              }}>
              {t.label} {t.count > 0 && <span className="mono" style={{ marginLeft: 4, fontSize: 10, padding: "1px 5px", borderRadius: 8, background: tab === t.key ? "var(--cyan)" : "var(--bg4)", color: tab === t.key ? "#000" : "var(--txt3)" }}>{t.count}</span>}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--txt3)" }}>
            <input type="checkbox" checked={soloPendientes} onChange={e => setSoloPendientes(e.target.checked)} style={{ accentColor: "var(--cyan)" }} />
            Por conciliar
          </label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar..."
            style={{ padding: "5px 10px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, width: 160 }} />
          <button onClick={handleSyncMP} disabled={syncingMP}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: syncingMP ? "wait" : "pointer", background: "var(--blueBg)", color: "var(--blue)", border: "1px solid var(--blueBd)", opacity: syncingMP ? 0.6 : 1 }}>
            {syncingMP ? "Sync MP..." : "Sync MP"}
          </button>
        </div>
      </div>

      {/* Mensaje sync */}
      {syncMsg && (
        <div style={{ padding: "6px 12px", borderRadius: 6, marginBottom: 8, fontSize: 11, fontWeight: 600,
          background: syncMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
          {syncMsg}
        </div>
      )}

      {/* Tabla */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <th onClick={() => toggleSort("fecha")} style={{ padding: "10px 12px", textAlign: "left", cursor: "pointer", color: "var(--cyan)", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" }}>
                  Fecha{sortIcon("fecha")}
                </th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Banco</th>
                <th onClick={() => toggleSort("descripcion")} style={{ padding: "10px 12px", textAlign: "left", cursor: "pointer", color: "var(--cyan)", fontWeight: 600, fontSize: 11 }}>
                  Descripción{sortIcon("descripcion")}
                </th>
                <th onClick={() => toggleSort("monto")} style={{ padding: "10px 12px", textAlign: "right", cursor: "pointer", color: "var(--cyan)", fontWeight: 600, fontSize: 11 }}>
                  Cargo{sortIcon("monto")}
                </th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Abono</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, fontSize: 11, color: "var(--txt3)" }}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--txt3)" }}>
                  {soloPendientes ? "Todos los movimientos están conciliados" : "Sin movimientos"}
                </td></tr>
              ) : filtered.map(m => {
                const isConciliado = concMovIds.has(m.id!) || m.estado_conciliacion === "conciliado";
                const isIgnorado = m.estado_conciliacion === "ignorado";
                const isActionsOpen = showActions === m.id;
                return (
                  <tr key={m.id} style={{ borderBottom: "1px solid var(--bg4)", opacity: isIgnorado ? 0.4 : 1 }}>
                    <td className="mono" style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>{m.fecha}</td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: "var(--txt3)" }}>
                      <div>{m.banco}</div>
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.descripcion || "—"}
                    </td>
                    <td className="mono" style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "var(--red)" }}>
                      {m.monto < 0 ? fmtMoney(Math.abs(m.monto)) : ""}
                    </td>
                    <td className="mono" style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "var(--green)" }}>
                      {m.monto > 0 ? fmtMoney(m.monto) : ""}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                      {isConciliado ? (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "var(--greenBg)", color: "var(--green)" }}>Conciliado</span>
                      ) : isIgnorado ? (
                        <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt3)" }}>Ignorado</span>
                      ) : (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", alignItems: "center", position: "relative" }}>
                          <div style={{ fontSize: 10, color: "var(--txt3)", marginRight: 4 }}>
                            <span className="mono">{fmtMoney(Math.abs(m.monto))}</span>
                            <span style={{ marginLeft: 2 }}>por conciliar</span>
                          </div>
                          <button onClick={() => setConciliarMov(m)}
                            style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "var(--green)", color: "#fff", border: "none" }}>
                            Conciliar
                          </button>
                          <button onClick={() => setShowActions(isActionsOpen ? null : m.id!)}
                            style={{ padding: "4px 6px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--green)", color: "#fff", border: "none" }}>
                            ▾
                          </button>
                          {/* Dropdown acciones */}
                          {isActionsOpen && (
                            <div style={{
                              position: "absolute", top: "100%", right: 0, zIndex: 50, marginTop: 4,
                              background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8,
                              boxShadow: "0 8px 24px rgba(0,0,0,0.4)", minWidth: 200, overflow: "hidden",
                            }}>
                              <button onClick={() => { setConciliarMov(m); setShowActions(null); }}
                                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, cursor: "pointer" }}>
                                Conciliar con factura
                              </button>
                              <button onClick={() => { setClasificarMov(m); setClasificarCuenta(""); setShowActions(null); }}
                                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, cursor: "pointer" }}>
                                Clasificar sin documento
                              </button>
                              <button onClick={() => handleIgnorar(m)}
                                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", color: "var(--txt3)", fontSize: 12, cursor: "pointer" }}>
                                Ignorar
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid var(--bg4)", fontWeight: 700 }}>
                  <td colSpan={3} style={{ padding: "10px 12px" }}>Total CLP</td>
                  <td className="mono" style={{ padding: "10px 12px", textAlign: "right", color: "var(--red)" }}>
                    {totalCargos !== 0 ? fmtMoney(Math.abs(totalCargos)) : "$0"}
                    <div style={{ fontSize: 9, fontWeight: 400, color: "var(--txt3)" }}>Total cargos</div>
                  </td>
                  <td className="mono" style={{ padding: "10px 12px", textAlign: "right", color: "var(--green)" }}>
                    {totalAbonos !== 0 ? fmtMoney(totalAbonos) : "$0"}
                    <div style={{ fontSize: 9, fontWeight: 400, color: "var(--txt3)" }}>Total abonos</div>
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Modal clasificar sin documento */}
      {clasificarMov && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setClasificarMov(null)}>
          <div className="card" style={{ padding: 24, maxWidth: 420, width: "90%" }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Clasificar sin documento</h3>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>
              {clasificarMov.descripcion} · {fmtMoney(Math.abs(clasificarMov.monto))}
            </div>
            <select value={clasificarCuenta} onChange={e => setClasificarCuenta(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", fontSize: 12, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6, marginBottom: 12 }}>
              <option value="">— Seleccionar cuenta —</option>
              {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
            </select>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setClasificarMov(null)}
                style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Cancelar
              </button>
              <button onClick={handleClasificar} disabled={!clasificarCuenta}
                className="scan-btn green" style={{ padding: "8px 20px", fontSize: 12 }}>
                Clasificar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal conciliar */}
      {conciliarMov && (
        <ConciliarModal
          mov={conciliarMov}
          compras={compras}
          ventas={ventas}
          conciliaciones={conciliaciones}
          cuentasHoja={cuentasHoja}
          provCuentas={provCuentas}
          empresaId={empresa.id!}
          onClose={() => setConciliarMov(null)}
          onSaved={() => {
            setConciliarMov(null);
            setMovBanco(prev => prev.map(m => m.id === conciliarMov.id ? { ...m, estado_conciliacion: "conciliado" } : m));
            load();
          }}
        />
      )}

      {/* Click fuera cierra dropdown */}
      {showActions && (
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setShowActions(null)} />
      )}
    </div>
  );
}
