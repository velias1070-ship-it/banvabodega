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
  syncEstadoConciliacion,
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

// Scoring inteligente: monto exacto domina, fecha por proximidad o plazo
function scoreDoc(
  doc: { monto_total: number; razon_social: string; rut: string; fecha: string },
  target: number, movFechaMs: number, movDescLower: string, plazoByRut: Map<string, number>, isMP: boolean
): { score: number; diasDiff: number } {
  const montoPct = target > 0 ? Math.abs(doc.monto_total - target) / target : 1;
  const montoScore = montoPct < 0.01 ? 0 : montoPct < 0.05 ? 0.1 + montoPct : 0.3 + montoPct;
  let provMatch = 0;
  if (!isMP) {
    const palabras = (doc.razon_social || "").toLowerCase().split(/\s+/).filter(p => p.length > 3);
    provMatch = palabras.some(p => movDescLower.includes(p)) ? 0 : 1;
  }
  let fechaScore = 1;
  let diasDiff = 0;
  if (doc.fecha) {
    const docFechaMs = new Date(doc.fecha + "T12:00:00").getTime();
    diasDiff = Math.round((movFechaMs - docFechaMs) / 86400000);
    const plazo = plazoByRut.get(doc.rut);
    if (diasDiff < 0) {
      fechaScore = 3;
    } else if (!isMP && plazo) {
      fechaScore = Math.abs(diasDiff - plazo) / plazo;
    } else {
      fechaScore = Math.min(diasDiff / 60, 3);
    }
  }
  const score = isMP
    ? montoScore * 0.55 + Math.min(fechaScore, 3) * 0.45
    : montoScore * 0.50 + Math.min(fechaScore, 3) * 0.30 + provMatch * 0.20;
  return { score, diasDiff };
}

interface ConcRapidaMatch {
  mov: DBMovimientoBanco;
  doc: { id: string; tipo: "rcv_compra" | "rcv_venta"; nro: string; rut: string; razon_social: string; fecha: string; monto_total: number; tipo_doc_label: string };
  score: number;
  diasDiff: number;
  estado: "pendiente" | "aprobado" | "rechazado";
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
  // Notas / comentarios por movimiento
  const [editingNota, setEditingNota] = useState<string | null>(null);
  const [notaText, setNotaText] = useState("");
  // Sync MP
  const [syncingMP, setSyncingMP] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Conciliación rápida
  const [showConcRapida, setShowConcRapida] = useState(false);
  const [concRapidaResults, setConcRapidaResults] = useState<ConcRapidaMatch[]>([]);
  const [concRapidaSaving, setConcRapidaSaving] = useState(false);

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
    if (soloPendientes) list = list.filter(m => m.estado_conciliacion !== "ignorado" && m.estado_conciliacion !== "conciliado");
    if (tab === "abonos") list = list.filter(m => m.monto > 0);
    else if (tab === "cargos") list = list.filter(m => m.monto < 0);
    if (search) {
      const q = search.toLowerCase();
      const qNum = q.replace(/[.,]/g, "");
      const isNum = qNum !== "" && !isNaN(Number(qNum));
      list = list.filter(m => {
        if ((m.descripcion || "").toLowerCase().includes(q)) return true;
        if ((m.referencia || "").toLowerCase().includes(q)) return true;
        if (isNum && Math.abs(m.monto).toString().includes(qNum)) return true;
        return false;
      });
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
    const montoAplicar = Math.abs(clasificarMov.monto) - (clasificarMov.monto_conciliado || 0);
    await upsertConciliacion({
      empresa_id: empresa.id, movimiento_banco_id: clasificarMov.id!,
      rcv_compra_id: null, rcv_venta_id: null, confianza: 1,
      estado: "confirmado", tipo_partida: "clasificacion_directa",
      metodo: "manual", notas: null, created_by: "admin",
      monto_aplicado: montoAplicar,
    });
    const { estado, monto_conciliado } = await syncEstadoConciliacion(clasificarMov.id!, clasificarMov.monto);
    await categorizarMovimiento(clasificarMov.id!, clasificarCuenta);
    setMovBanco(prev => prev.map(m => m.id === clasificarMov.id ? { ...m, estado_conciliacion: estado, monto_conciliado } : m));
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
      let totalRetiros = 0;
      const allLogs: string[] = [];
      // Expandir periodos anuales (YYYY) a meses (YYYYMM)
      const periodosExp: string[] = [];
      for (const p of periodos) {
        if (p.length === 4) {
          for (let m = 1; m <= 12; m++) periodosExp.push(`${p}${String(m).padStart(2, "0")}`);
        } else {
          periodosExp.push(p);
        }
      }
      for (const p of periodosExp) {
        setSyncMsg(`Sincronizando ${p.slice(0,4)}-${p.slice(4)}... (generando reporte en MP, puede tardar hasta 90s)`);
        const res = await fetch("/api/mp/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: p }), signal: AbortSignal.timeout(120_000) });
        const d = await res.json();
        if (d.log) allLogs.push(...d.log);
        if (d.error) { allLogs.push(`ERROR: ${d.error}`); break; }
        totalRetiros += d.retiros_nuevos || 0;
      }
      const logText = allLogs.join("\n");
      if (totalRetiros > 0) {
        setSyncMsg(`${totalRetiros} retiros importados\n${logText}`);
      } else {
        setSyncMsg(logText || "Sin retiros nuevos");
      }
      load();
    } catch (e) {
      setSyncMsg(`Error: ${e instanceof Error ? e.message : "sin detalles"}`);
    } finally {
      setSyncingMP(false);
    }
  };

  // --- Conciliación Rápida ---
  const tipoDocLabel = (tipo: number | string) => {
    const map: Record<string, string> = { "33": "FAC", "34": "FAC EX", "39": "BOL", "41": "BOL EX", "46": "FC", "56": "ND", "61": "NC", "71": "BHE" };
    return map[String(tipo)] || String(tipo);
  };

  const runConciliacionRapida = () => {
    const pendList = movBanco.filter(m =>
      isMovReal(m) && m.estado_conciliacion !== "ignorado" && m.estado_conciliacion !== "conciliado"
    );
    const cCompraIds = new Set(conciliaciones.filter(c => c.estado !== "rechazado" && c.rcv_compra_id).map(c => c.rcv_compra_id));
    const cVentaIds = new Set(conciliaciones.filter(c => c.estado !== "rechazado" && c.rcv_venta_id).map(c => c.rcv_venta_id));
    const plazoByRut = new Map(provCuentas.filter(p => p.plazo_dias).map(p => [p.rut_proveedor, p.plazo_dias!]));

    const pairs: { mov: DBMovimientoBanco; doc: ConcRapidaMatch["doc"]; score: number; diasDiff: number }[] = [];

    for (const mov of pendList) {
      const movAbs = Math.abs(mov.monto);
      const movFechaMs = new Date(mov.fecha + "T12:00:00").getTime();
      const movDescLower = (mov.descripcion || "").toLowerCase();
      const isMP = mov.banco === "MercadoPago" || movDescLower.startsWith("retiro mp");

      if (mov.monto < 0) {
        // Cargos -> compras
        for (const c of compras) {
          if (cCompraIds.has(c.id!)) continue;
          const doc = { id: c.id!, tipo: "rcv_compra" as const, nro: c.nro_doc || "", rut: c.rut_proveedor || "", razon_social: c.razon_social || "", fecha: c.fecha_docto || "", monto_total: c.monto_total || 0, tipo_doc_label: tipoDocLabel(c.tipo_doc) };
          const { score, diasDiff } = scoreDoc(doc, movAbs, movFechaMs, movDescLower, plazoByRut, isMP);
          if (score < 0.5) pairs.push({ mov, doc, score, diasDiff });
        }
      } else {
        // Abonos -> ventas
        for (const v of ventas) {
          if (cVentaIds.has(v.id!)) continue;
          const doc = { id: v.id!, tipo: "rcv_venta" as const, nro: v.nro || v.folio || "", rut: v.rut_receptor || "", razon_social: v.razon_social || "", fecha: v.fecha_docto || "", monto_total: v.monto_total || 0, tipo_doc_label: v.tipo_doc || "FAC" };
          const { score, diasDiff } = scoreDoc(doc, movAbs, movFechaMs, movDescLower, plazoByRut, isMP);
          if (score < 0.5) pairs.push({ mov, doc, score, diasDiff });
        }
      }
    }

    // Greedy 1:1 assignment (best score first)
    pairs.sort((a, b) => a.score - b.score);
    const usedMovIds = new Set<string>();
    const usedDocIds = new Set<string>();
    const results: ConcRapidaMatch[] = [];
    for (const p of pairs) {
      if (usedMovIds.has(p.mov.id!) || usedDocIds.has(p.doc.id)) continue;
      usedMovIds.add(p.mov.id!);
      usedDocIds.add(p.doc.id);
      results.push({ ...p, estado: "pendiente" });
    }

    setConcRapidaResults(results);
    setShowConcRapida(true);
  };

  const handleAprobarMatch = async (match: ConcRapidaMatch) => {
    try {
      await upsertConciliacion({
        empresa_id: empresa.id!, movimiento_banco_id: match.mov.id!,
        rcv_compra_id: match.doc.tipo === "rcv_compra" ? match.doc.id : null,
        rcv_venta_id: match.doc.tipo === "rcv_venta" ? match.doc.id : null,
        confianza: Math.round((1 - match.score) * 100) / 100,
        estado: "confirmado", tipo_partida: "match", metodo: "auto_rapida", notas: null, created_by: "admin",
        monto_aplicado: Math.abs(match.mov.monto),
      });
      const { estado, monto_conciliado } = await syncEstadoConciliacion(match.mov.id!, match.mov.monto);
      if (match.doc.rut) {
        const pc = provCuentas.find(p => p.rut_proveedor === match.doc.rut);
        if (pc?.categoria_cuenta_id && !pc.cuenta_variable) {
          await categorizarMovimiento(match.mov.id!, pc.categoria_cuenta_id);
        }
      }
      setConcRapidaResults(prev => prev.map(r => r.mov.id === match.mov.id ? { ...r, estado: "aprobado" } : r));
      setMovBanco(prev => prev.map(m => m.id === match.mov.id ? { ...m, estado_conciliacion: estado, monto_conciliado } : m));
    } catch (e) { console.error("Error aprobando:", e); }
  };

  const handleRechazarMatch = (movId: string) => {
    setConcRapidaResults(prev => prev.map(r => r.mov.id === movId ? { ...r, estado: "rechazado" } : r));
  };

  const handleAprobarAlta = async () => {
    const alta = concRapidaResults.filter(r => r.score < 0.15 && r.estado === "pendiente");
    if (alta.length === 0) return;
    setConcRapidaSaving(true);
    for (const match of alta) {
      await handleAprobarMatch(match);
    }
    setConcRapidaSaving(false);
  };

  const handleCloseConcRapida = () => {
    setShowConcRapida(false);
    if (concRapidaResults.some(r => r.estado === "aprobado")) load();
    setConcRapidaResults([]);
  };

  const concRapidaStats = useMemo(() => {
    const total = concRapidaResults.length;
    const alta = concRapidaResults.filter(r => r.score < 0.15).length;
    const media = concRapidaResults.filter(r => r.score >= 0.15).length;
    const revisados = concRapidaResults.filter(r => r.estado !== "pendiente").length;
    const aprobados = concRapidaResults.filter(r => r.estado === "aprobado").length;
    const altaPend = concRapidaResults.filter(r => r.score < 0.15 && r.estado === "pendiente").length;
    return { total, alta, media, revisados, aprobados, altaPend };
  }, [concRapidaResults]);

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
          <button onClick={runConciliacionRapida} disabled={pendientes.length === 0}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: pendientes.length === 0 ? "not-allowed" : "pointer", background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", opacity: pendientes.length === 0 ? 0.5 : 1 }}>
            Conciliacion Rapida
          </button>
        </div>
      </div>

      {/* Mensaje sync */}
      {syncMsg && (
        <div style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 8, fontSize: 11,
          whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto",
          background: syncMsg.includes("ERROR") ? "var(--redBg)" : "var(--greenBg)",
          color: syncMsg.includes("ERROR") ? "var(--red)" : "var(--green)",
          border: `1px solid ${syncMsg.includes("ERROR") ? "var(--redBd)" : "var(--greenBd)"}` }}>
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
                const isConciliado = m.estado_conciliacion === "conciliado";
                const isParcial = m.estado_conciliacion === "parcial";
                const isIgnorado = m.estado_conciliacion === "ignorado";
                const restante = Math.abs(m.monto) - (m.monto_conciliado || 0);
                const isActionsOpen = showActions === m.id;
                return (
                  <tr key={m.id} style={{ borderBottom: "1px solid var(--bg4)", opacity: isIgnorado ? 0.4 : 1 }}>
                    <td className="mono" style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>{m.fecha}</td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: "var(--txt3)" }}>
                      <div>{m.banco}</div>
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 300, position: "relative" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{m.descripcion || "—"}</span>
                        <span onClick={() => { setEditingNota(m.id!); setNotaText(m.notas || ""); }}
                          title={m.notas || "Agregar comentario"}
                          style={{ width: 24, height: 24, borderRadius: 5, background: m.notas ? "var(--cyanBg)" : "var(--bg3)", border: `1px solid ${m.notas ? "var(--cyanBd)" : "var(--bg4)"}`, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11, color: m.notas ? "var(--cyan)" : "var(--txt3)", flexShrink: 0 }}>
                          &#9776;
                        </span>
                      </div>
                      {m.notas && <div style={{ fontSize: 10, color: "var(--cyan)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.notas}</div>}
                      {editingNota === m.id && (
                        <div style={{ position: "absolute", left: 12, top: "100%", marginTop: 4, zIndex: 50, background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", width: 260 }}
                          onClick={e => e.stopPropagation()}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 6 }}>Comentario</div>
                          <textarea value={notaText} onChange={e => setNotaText(e.target.value)} autoFocus placeholder="Agregar un comentario..."
                            style={{ width: "100%", padding: "8px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", resize: "vertical", minHeight: 60 }} />
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
                            <button onClick={() => setEditingNota(null)}
                              style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Cancelar</button>
                            <button onClick={async () => {
                              await updateMovimientoBanco(m.id!, { notas: notaText.trim() || null } as Partial<DBMovimientoBanco>);
                              setMovBanco(prev => prev.map(x => x.id === m.id ? { ...x, notas: notaText.trim() || null } : x));
                              setEditingNota(null);
                            }}
                              style={{ padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer" }}>Guardar</button>
                          </div>
                        </div>
                      )}
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
                          <div style={{ fontSize: 10, color: isParcial ? "var(--amber)" : "var(--txt3)", marginRight: 4 }}>
                            {isParcial && <div style={{ fontSize: 9, fontWeight: 600, color: "var(--amber)", marginBottom: 2 }}>Parcial {fmtMoney(m.monto_conciliado || 0)}/{fmtMoney(Math.abs(m.monto))}</div>}
                            <span className="mono">{fmtMoney(restante)}</span>
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
            load();
          }}
        />
      )}

      {/* Click fuera cierra dropdown */}
      {showActions && (
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setShowActions(null)} />
      )}

      {/* Modal Conciliación Rápida */}
      {showConcRapida && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !concRapidaSaving && handleCloseConcRapida()}>
          <div className="card" style={{ width: "95%", maxWidth: 960, maxHeight: "90vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>Conciliacion Rapida</div>
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                  {concRapidaStats.total} sugerencias - {concRapidaStats.alta} alta confianza, {concRapidaStats.media} media - {concRapidaStats.aprobados} aprobadas
                </div>
              </div>
              <button onClick={handleCloseConcRapida} disabled={concRapidaSaving} style={{ background: "none", border: "none", color: "#fff", fontSize: 22, cursor: "pointer" }}>&times;</button>
            </div>

            {/* Bulk action bar */}
            {concRapidaStats.altaPend > 0 && (
              <div style={{ padding: "10px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", alignItems: "center", gap: 12, background: "var(--greenBg)" }}>
                <button onClick={handleAprobarAlta} disabled={concRapidaSaving}
                  style={{ padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: concRapidaSaving ? "wait" : "pointer", background: "var(--green)", color: "#fff", border: "none" }}>
                  {concRapidaSaving ? "Aprobando..." : `Aprobar todas de alta confianza (${concRapidaStats.altaPend})`}
                </button>
                <span style={{ fontSize: 11, color: "var(--green)" }}>Monto exacto + proveedor coincide</span>
              </div>
            )}

            {/* Empty state */}
            {concRapidaResults.length === 0 ? (
              <div style={{ padding: 48, textAlign: "center", color: "var(--txt3)" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>--</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Sin sugerencias de conciliacion</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>No se encontraron matches con suficiente confianza</div>
              </div>
            ) : (
              /* Scrollable list */
              <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
                {concRapidaResults.map((r, i) => {
                  const isAlta = r.score < 0.15;
                  const isDone = r.estado !== "pendiente";
                  return (
                    <div key={r.mov.id! + r.doc.id} style={{
                      padding: "12px 24px", borderBottom: "1px solid var(--bg4)",
                      opacity: isDone ? 0.45 : 1, display: "flex", gap: 12, alignItems: "center",
                    }}>
                      {/* Numero */}
                      <div style={{ fontSize: 10, color: "var(--txt3)", minWidth: 20, textAlign: "center" }}>{i + 1}</div>

                      {/* Movimiento banco */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.mov.descripcion || "--"}</div>
                        <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{r.mov.fecha} - {r.mov.banco}</div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
                          <span className="mono" style={{ fontSize: 14, fontWeight: 700, color: r.mov.monto < 0 ? "var(--red)" : "var(--green)" }}>
                            {fmtMoney(Math.abs(r.mov.monto))}
                          </span>
                          {Math.abs(r.mov.monto) !== r.doc.monto_total && (
                            <span className="mono" style={{ fontSize: 10, color: "var(--amber)" }}>
                              diff {fmtMoney(Math.abs(Math.abs(r.mov.monto) - r.doc.monto_total))}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Confianza badge */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 60 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4, textTransform: "uppercase",
                          background: isAlta ? "var(--greenBg)" : "var(--amberBg)",
                          color: isAlta ? "var(--green)" : "var(--amber)",
                          border: `1px solid ${isAlta ? "var(--greenBd)" : "var(--amberBd)"}`,
                        }}>
                          {isAlta ? "Alta" : "Media"}
                        </span>
                        <span className="mono" style={{ fontSize: 9, color: "var(--txt3)", marginTop: 2 }}>{(r.score * 100).toFixed(0)}%</span>
                      </div>

                      {/* Flecha */}
                      <div style={{ fontSize: 16, color: "var(--txt3)" }}>→</div>

                      {/* Documento */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "var(--bg4)", marginRight: 4 }}>{r.doc.tipo_doc_label}</span>
                          N{"\u00B0"} {r.doc.nro} - {r.doc.razon_social}
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{r.doc.fecha} - {r.doc.rut}</div>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
                          <span className="mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmtMoney(r.doc.monto_total)}</span>
                          <span className="mono" style={{ fontSize: 10, color: r.diasDiff < 0 ? "var(--red)" : r.diasDiff <= 45 ? "var(--green)" : "var(--amber)" }}>
                            {r.diasDiff}d {r.diasDiff < 0 ? "(antes)" : "despues"}
                          </span>
                        </div>
                      </div>

                      {/* Acciones */}
                      <div style={{ display: "flex", gap: 6, minWidth: 100, justifyContent: "flex-end" }}>
                        {r.estado === "pendiente" ? (
                          <>
                            <button onClick={() => handleAprobarMatch(r)} disabled={concRapidaSaving}
                              style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer", background: "var(--green)", color: "#fff", border: "none" }}>
                              Aprobar
                            </button>
                            <button onClick={() => handleRechazarMatch(r.mov.id!)}
                              style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--bg3)", color: "var(--red)", border: "1px solid var(--bg4)" }}>
                              X
                            </button>
                          </>
                        ) : (
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 4,
                            background: r.estado === "aprobado" ? "var(--greenBg)" : "var(--redBg)",
                            color: r.estado === "aprobado" ? "var(--green)" : "var(--red)",
                          }}>
                            {r.estado === "aprobado" ? "Aprobado" : "Rechazado"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Footer */}
            <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: "var(--txt3)" }}>
                {concRapidaStats.revisados} de {concRapidaStats.total} revisados
              </div>
              <button onClick={handleCloseConcRapida} disabled={concRapidaSaving}
                style={{ padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)" }}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
