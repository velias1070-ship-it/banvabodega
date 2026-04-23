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
  updateConciliacion,
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
    ? montoScore * 0.75 + Math.min(fechaScore, 3) * 0.25
    : montoScore * 0.70 + Math.min(fechaScore, 3) * 0.20 + provMatch * 0.10;
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

  // Período viene del selector principal de la página

  // Modal
  const [conciliarMov, setConciliarMov] = useState<DBMovimientoBanco | null>(null);
  // Dropdown acciones
  const [showActions, setShowActions] = useState<string | null>(null);
  const [actionsPos, setActionsPos] = useState({ top: 0, right: 0 });
  // Agregar Egreso
  const [clasificarMov, setClasificarMov] = useState<DBMovimientoBanco | null>(null);
  const [clasificarCuenta, setClasificarCuenta] = useState("");
  const [egresoTipo, setEgresoTipo] = useState("");
  const [egresoProveedor, setEgresoProveedor] = useState("");
  const [egresoDescripcion, setEgresoDescripcion] = useState("");
  const [egresoNumDoc, setEgresoNumDoc] = useState("");
  const [egresoPeriodo, setEgresoPeriodo] = useState("");
  const [egresoArchivo, setEgresoArchivo] = useState<File | null>(null);
  const [egresoSaving, setEgresoSaving] = useState(false);
  // Detalle conciliación
  const [editingConcId, setEditingConcId] = useState<string | null>(null);
  const [detalleConcMov, setDetalleConcMov] = useState<string | null>(null);
  const [detalleConcData, setDetalleConcData] = useState<{
    concs: DBConciliacion[];
    docs: { doc: DBRcvCompra | DBRcvVenta; monto_aplicado: number; conc: DBConciliacion }[];
    totalAplicado: number;
  } | null>(null);
  const [detalleConcLoading, setDetalleConcLoading] = useState(false);
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


  const load = useCallback(async () => {
    if (!empresa.id) return;
    setLoading(true);
    const y = parseInt(periodo.slice(0, 4));
    let minDesde: string, maxHasta: string;
    if (periodo.length === 4) {
      minDesde = `${y}-01-01`;
      maxHasta = `${y}-12-31`;
    } else {
      const m = parseInt(periodo.slice(4, 6));
      minDesde = `${y}-${String(m).padStart(2, "0")}-01`;
      maxHasta = `${y}-${String(m).padStart(2, "0")}-${new Date(y, m, 0).getDate()}`;
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
  }, [empresa.id, periodo]);

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
        if ((m.notas || "").toLowerCase().includes(q)) return true;
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


  // Agregar / Editar Egreso
  const handleAgregarEgreso = async () => {
    if (!clasificarMov || !clasificarCuenta || !egresoTipo || !empresa.id) return;
    setEgresoSaving(true);
    try {
      let archivoUrl: string | null = null;
      if (egresoArchivo) {
        const { getSupabase } = await import("@/lib/supabase");
        const sb = getSupabase();
        if (sb) {
          const ext = egresoArchivo.name.split(".").pop() || "pdf";
          const path = `conciliacion/${clasificarMov.id}_${Date.now()}.${ext}`;
          const { error } = await sb.storage.from("banva").upload(path, egresoArchivo, { upsert: true });
          if (!error) {
            const { data } = sb.storage.from("banva").getPublicUrl(path);
            archivoUrl = data?.publicUrl || null;
          }
        }
      }
      const metadata = { tipo: egresoTipo, proveedor: egresoProveedor, descripcion: egresoDescripcion, num_documento: egresoNumDoc, periodo: egresoPeriodo };
      if (editingConcId) {
        const updates: Partial<DBConciliacion> = { metadata, notas: null };
        if (archivoUrl) updates.archivo_url = archivoUrl;
        await updateConciliacion(editingConcId, updates);
        await categorizarMovimiento(clasificarMov.id!, clasificarCuenta);
      } else {
        const montoAplicar = Math.abs(clasificarMov.monto) - (clasificarMov.monto_conciliado || 0);
        await upsertConciliacion({
          empresa_id: empresa.id, movimiento_banco_id: clasificarMov.id!,
          rcv_compra_id: null, rcv_venta_id: null, confianza: 1,
          estado: "confirmado", tipo_partida: "egreso",
          metodo: "manual", notas: null, created_by: "admin",
          monto_aplicado: montoAplicar,
          metadata,
          archivo_url: archivoUrl,
        });
        const { estado, monto_conciliado } = await syncEstadoConciliacion(clasificarMov.id!, clasificarMov.monto);
        await categorizarMovimiento(clasificarMov.id!, clasificarCuenta);
        setMovBanco(prev => prev.map(m => m.id === clasificarMov.id ? { ...m, estado_conciliacion: estado, monto_conciliado } : m));
      }
      setClasificarMov(null); setEditingConcId(null); setClasificarCuenta(""); setEgresoTipo(""); setEgresoProveedor(""); setEgresoDescripcion(""); setEgresoNumDoc(""); setEgresoPeriodo(""); setEgresoArchivo(null);
      load();
    } catch (err) { console.error("Error guardando egreso:", err); }
    setEgresoSaving(false);
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
      // Expandir periodo anual (YYYY) a meses (YYYYMM)
      const periodosExp: string[] = [];
      if (periodo.length === 4) {
        for (let m = 1; m <= 12; m++) periodosExp.push(`${periodo}${String(m).padStart(2, "0")}`);
      } else {
        periodosExp.push(periodo);
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
          <button onClick={async () => {
            setSyncMsg("Limpiando movimientos con monto 0...");
            try {
              const cleanup = await fetch("/api/mp/cleanup-live", { method: "POST" });
              const cd = await cleanup.json();
              setSyncMsg(`Limpieza: ${cd.eliminados || 0} eliminados\nConsultando API directa de MP...`);
              const res = await fetch("/api/mp/sync-live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dias: 7 }) });
              const d = await res.json();
              if (d.error) setSyncMsg(`Error: ${d.error}`);
              else setSyncMsg(`${cd.eliminados || 0} eliminados\n${d.retiros_nuevos || 0} nuevos retiros (de ${d.total_encontrados || 0} encontrados)\n${(d.log || []).join("\n")}`);
              load();
            } catch (e) {
              setSyncMsg(`Error: ${e instanceof Error ? e.message : "?"}`);
            }
          }} disabled={syncingMP}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)" }}
            title="Limpia movimientos con monto 0 y trae retiros reales de la API de MP">
            Sync MP en vivo
          </button>
          <button onClick={async () => {
            const periodosReq: string[] = [];
            if (periodo.length === 4) {
              for (let m = 1; m <= 12; m++) periodosReq.push(`${periodo}${String(m).padStart(2, "0")}`);
            } else {
              periodosReq.push(periodo);
            }
            setSyncMsg("Solicitando reportes a MP...");
            const mensajes: string[] = [];
            for (const p of periodosReq) {
              try {
                const res = await fetch("/api/mp/request-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: p }) });
                const d = await res.json();
                mensajes.push(`${p}: ${d.error || d.mensaje || "solicitado"}`);
              } catch (e) {
                mensajes.push(`${p}: ${e instanceof Error ? e.message : "error"}`);
              }
            }
            // Polling automático cada 30s hasta 6 min
            const pollPeriodos = periodosReq.filter((_, i) => !mensajes[i]?.includes("error"));
            if (pollPeriodos.length === 0) {
              setSyncMsg(mensajes.join("\n"));
              return;
            }
            const startTime = Date.now();
            const maxWait = 6 * 60_000;
            const checkAll = async (): Promise<boolean> => {
              const results: string[] = [];
              let allReady = true;
              for (const p of pollPeriodos) {
                try {
                  const res = await fetch("/api/mp/check-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodo: p }) });
                  const d = await res.json();
                  if (d.listos > 0) results.push(`${p}: ✓ ${d.listos} reporte(s) listo(s)`);
                  else { results.push(`${p}: ⏳ ${d.pendientes} pendientes...`); allReady = false; }
                } catch { allReady = false; }
              }
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              setSyncMsg(`Esperando reportes (${elapsed}s)...\n${results.join("\n")}`);
              return allReady;
            };
            // Check inmediato + cada 30s
            await new Promise(r => setTimeout(r, 30000));
            while (Date.now() - startTime < maxWait) {
              const ready = await checkAll();
              if (ready) {
                setSyncMsg(`Reportes listos. Sincronizando...`);
                await handleSyncMP();
                return;
              }
              await new Promise(r => setTimeout(r, 30000));
            }
            setSyncMsg(`Timeout (6 min). Presiona Sync MP cuando los reportes estén listos.`);
          }} disabled={syncingMP}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)" }}
            title="Solicita a MP que genere un release report para este período">
            Pedir reporte MP
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
                    <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap", position: "relative" }}>
                      {isConciliado ? (
                        <span onClick={async () => {
                          setDetalleConcMov(m.id!); setDetalleConcLoading(true); setDetalleConcData(null);
                          const concs = conciliaciones.filter(x => x.estado === "confirmado" && x.movimiento_banco_id === m.id);
                          const docs: { doc: DBRcvCompra | DBRcvVenta; monto_aplicado: number; conc: DBConciliacion }[] = [];
                          const { getSupabase } = await import("@/lib/supabase");
                          const sb = getSupabase();
                          const concIds = concs.map(c => c.id!).filter(Boolean) as string[];
                          let allItems: { conciliacion_id: string; documento_tipo: string; documento_id: string; monto_aplicado: number }[] = [];
                          if (sb && concIds.length > 0) {
                            const { data } = await sb.from("conciliacion_items").select("*").in("conciliacion_id", concIds);
                            allItems = data || [];
                          }
                          for (const conc of concs) {
                            const thisItems = allItems.filter(it => it.conciliacion_id === conc.id);
                            if (thisItems.length > 0) {
                              for (const it of thisItems) {
                                let doc: DBRcvCompra | DBRcvVenta | undefined;
                                if (it.documento_tipo === "rcv_compra") doc = compras.find(c => c.id === it.documento_id);
                                else if (it.documento_tipo === "rcv_venta") doc = ventas.find(v => v.id === it.documento_id);
                                if (doc) docs.push({ doc, monto_aplicado: it.monto_aplicado || 0, conc });
                              }
                            } else if (conc.rcv_compra_id) {
                              const doc = compras.find(c => c.id === conc.rcv_compra_id);
                              if (doc) docs.push({ doc, monto_aplicado: conc.monto_aplicado || doc.monto_total || 0, conc });
                            } else if (conc.rcv_venta_id) {
                              const doc = ventas.find(v => v.id === conc.rcv_venta_id);
                              if (doc) docs.push({ doc, monto_aplicado: conc.monto_aplicado || doc.monto_total || 0, conc });
                            }
                          }
                          const totalAplicado = concs.reduce((s, c) => s + (c.monto_aplicado || 0), 0);
                          setDetalleConcData({ concs, docs, totalAplicado });
                          setDetalleConcLoading(false);
                        }}
                          style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "var(--greenBg)", color: "var(--green)", cursor: "pointer" }}
                          title="Ver detalle">
                          Conciliado
                        </span>
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
                          <button onClick={(e) => { setShowActions(isActionsOpen ? null : m.id!); setActionsPos({ top: e.currentTarget.getBoundingClientRect().bottom + 4, right: window.innerWidth - e.currentTarget.getBoundingClientRect().right }); }}
                            style={{ padding: "4px 6px", borderRadius: 6, fontSize: 11, cursor: "pointer", background: "var(--green)", color: "#fff", border: "none" }}>
                            ▾
                          </button>
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

      {/* Dropdown acciones flotante */}
      {showActions && (() => {
        const m = movBanco.find(x => x.id === showActions);
        if (!m) return null;
        return (
          <>
            <div onClick={() => setShowActions(null)} style={{ position: "fixed", inset: 0, zIndex: 9990 }} />
            <div style={{
              position: "fixed", zIndex: 9991, top: actionsPos.top, right: actionsPos.right,
              background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)", minWidth: 200, overflow: "hidden",
            }}>
              <button onClick={() => { setConciliarMov(m); setShowActions(null); }}
                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, cursor: "pointer" }}>
                Conciliar con factura
              </button>
              <button onClick={() => { setClasificarMov(m); setClasificarCuenta(""); setEgresoTipo(""); setEgresoProveedor(""); setEgresoDescripcion(""); setEgresoNumDoc(""); setEgresoPeriodo(""); setEgresoArchivo(null); setShowActions(null); }}
                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, cursor: "pointer" }}>
                Agregar Egreso
              </button>
              <button onClick={() => { handleIgnorar(m); setShowActions(null); }}
                style={{ width: "100%", padding: "10px 14px", textAlign: "left", background: "none", border: "none", color: "var(--txt3)", fontSize: 12, cursor: "pointer" }}>
                Ignorar
              </button>
            </div>
          </>
        );
      })()}

      {/* Modal Agregar Egreso */}
      {clasificarMov && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { if (!egresoSaving) { setClasificarMov(null); setEditingConcId(null); } }}>
          <div className="card" style={{ padding: 0, maxWidth: 520, width: "90%", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{editingConcId ? "Editar Egreso" : "Agregar Egreso"}</h3>
              <button onClick={() => { setClasificarMov(null); setEditingConcId(null); }} disabled={egresoSaving} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--txt3)" }}>&times;</button>
            </div>
            <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--bg4)", fontSize: 12, color: "var(--txt3)" }}>
              <span style={{ fontWeight: 600, color: "var(--txt)" }}>{clasificarMov.descripcion}</span> · {fmtMoney(Math.abs(clasificarMov.monto))} · {clasificarMov.fecha}
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
              {/* Datos básicos */}
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 8, textTransform: "uppercase" }}>Datos básicos</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <div>
                  <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 3 }}>Tipo *</label>
                  <select value={egresoTipo} onChange={e => setEgresoTipo(e.target.value)}
                    style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }}>
                    <option value="">Selecciona un tipo</option>
                    <optgroup label="Documentos">
                      <option value="boleta">Boleta</option>
                      <option value="invoice">Invoice</option>
                      <option value="gasto">Gasto general</option>
                      <option value="remuneracion">Remuneración</option>
                    </optgroup>
                    <optgroup label="Impuestos">
                      <option value="F20">F20 - Declaración mensual</option>
                      <option value="F21">F21 - Declaración anual</option>
                      <option value="F22">F22 - Impuesto renta</option>
                      <option value="F29">F29 - IVA mensual</option>
                      <option value="F30">F30 - Cambio de sujeto</option>
                      <option value="F45">F45 - Retención 2da categoría</option>
                      <option value="F50">F50 - Declaración anual AT</option>
                      <option value="IVA">IVA</option>
                      <option value="contribuciones">Contribuciones</option>
                      <option value="postergacion_iva">Postergación IVA</option>
                      <option value="timbre">Timbre y Estampilla</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 3 }}>Num Documento</label>
                  <input value={egresoNumDoc} onChange={e => setEgresoNumDoc(e.target.value)} placeholder="Opcional"
                    style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 3 }}>Proveedor</label>
                  <input value={egresoProveedor} onChange={e => setEgresoProveedor(e.target.value)} placeholder="Nombre proveedor"
                    style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 3 }}>Descripción</label>
                  <input value={egresoDescripcion} onChange={e => setEgresoDescripcion(e.target.value)} placeholder="Detalle del egreso"
                    style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }} />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "var(--txt3)", display: "block", marginBottom: 3 }}>Período</label>
                  <select value={egresoPeriodo} onChange={e => setEgresoPeriodo(e.target.value)}
                    style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }}>
                    <option value="">— Sin período —</option>
                    {(() => {
                      const opts: { value: string; label: string }[] = [];
                      const now = new Date();
                      for (let i = 0; i < 24; i++) {
                        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                        const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                        const label = d.toLocaleDateString("es-CL", { month: "long", year: "numeric" });
                        opts.push({ value: val, label: label.charAt(0).toUpperCase() + label.slice(1) });
                      }
                      return opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>);
                    })()}
                  </select>
                </div>
              </div>

              {/* Archivo */}
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 8, textTransform: "uppercase" }}>Archivo de respaldo</div>
              <div style={{ marginBottom: 16 }}>
                {egresoArchivo ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--bg3)", borderRadius: 6, fontSize: 11 }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{egresoArchivo.name}</span>
                    <span style={{ color: "var(--txt3)", fontSize: 10 }}>{(egresoArchivo.size / 1024 / 1024).toFixed(1)} MB</span>
                    <button onClick={() => setEgresoArchivo(null)} style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 12 }}>&times;</button>
                  </div>
                ) : (
                  <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "12px", border: "1px dashed var(--bg4)", borderRadius: 6, cursor: "pointer", fontSize: 11, color: "var(--txt3)" }}>
                    Adjuntar PDF o imagen (max 16 MB)
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" hidden onChange={e => {
                      const f = e.target.files?.[0];
                      if (f && f.size <= 16 * 1024 * 1024) setEgresoArchivo(f);
                      else if (f) alert("Archivo muy grande (max 16 MB)");
                    }} />
                  </label>
                )}
              </div>

              {/* Clasificación */}
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", marginBottom: 8, textTransform: "uppercase" }}>Clasificación</div>
              <select value={clasificarCuenta} onChange={e => setClasificarCuenta(e.target.value)}
                style={{ width: "100%", padding: "7px 8px", fontSize: 11, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", borderRadius: 6 }}>
                <option value="">— Seleccionar cuenta —</option>
                {cuentasHoja.map(c => <option key={c.id} value={c.id!}>{c.codigo} — {c.nombre}</option>)}
              </select>
            </div>
            <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bg4)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setClasificarMov(null); setEditingConcId(null); }} disabled={egresoSaving}
                style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Cancelar
              </button>
              <button onClick={handleAgregarEgreso} disabled={!clasificarCuenta || !egresoTipo || egresoSaving}
                className="scan-btn green" style={{ padding: "8px 20px", fontSize: 12, opacity: (!clasificarCuenta || !egresoTipo || egresoSaving) ? 0.5 : 1 }}>
                {egresoSaving ? "Guardando..." : editingConcId ? "Guardar cambios" : "Guardar Egreso"}
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
          editingConcId={editingConcId}
          onClose={() => { setConciliarMov(null); setEditingConcId(null); }}
          onSaved={() => {
            setConciliarMov(null);
            setEditingConcId(null);
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

      {/* Modal detalle conciliación del movimiento */}
      {detalleConcMov && (() => {
        const mov = movBanco.find(x => x.id === detalleConcMov);
        if (!mov) return null;
        const movTotal = Math.abs(mov.monto);
        const aplicado = detalleConcData?.totalAplicado ?? 0;
        const saldo = movTotal - aplicado;
        const concs = detalleConcData?.concs || [];
        const docs = detalleConcData?.docs || [];
        const primary = concs[0];
        const allSameTipo = concs.length > 0 && concs.every(c => c.tipo_partida === primary?.tipo_partida);
        const tipoLabel = !allSameTipo ? "Mixto"
          : primary?.tipo_partida === "egreso" ? "Egreso"
          : primary?.tipo_partida === "clasificacion_directa" ? "Clasificación"
          : primary?.tipo_partida === "multi_pago" ? "Multi-pago"
          : primary?.tipo_partida === "multi_doc" ? "Multi-documento"
          : primary?.tipo_partida === "anulacion" ? "Anulación"
          : "Match";
        const metodo = primary?.metodo || "manual";
        const tipoDocLabel = (t: number | string) => typeof t === "number"
          ? (({ 33: "FAC-EL", 34: "FAC-EX", 46: "FC", 52: "GUIA", 56: "ND", 61: "NC", 71: "BHE" } as Record<number, string>)[t] || String(t))
          : String(t);
        const notasUniq = Array.from(new Set(concs.map(c => c.notas).filter(Boolean)));
        const adjuntos = concs.map(c => c.archivo_url).filter(Boolean) as string[];
        const handleDeshacerTodo = async () => {
          if (!confirm(`¿Deshacer ${concs.length > 1 ? `las ${concs.length} conciliaciones` : "esta conciliación"} del movimiento? El movimiento vuelve a pendiente.`)) return;
          for (const c of concs) {
            await updateConciliacion(c.id!, { estado: "rechazado" });
          }
          await syncEstadoConciliacion(mov.id!, mov.monto);
          setDetalleConcMov(null);
          load();
        };
        const handleEditar = () => {
          if (concs.length !== 1) return;
          const conc = concs[0];
          setDetalleConcMov(null);
          if (conc.tipo_partida === "egreso") {
            const md = (conc.metadata || {}) as Record<string, string>;
            setEditingConcId(conc.id!);
            setEgresoTipo(md.tipo || "");
            setEgresoProveedor(md.proveedor || "");
            setEgresoDescripcion(md.descripcion || "");
            setEgresoNumDoc(md.num_documento || "");
            setEgresoPeriodo(md.periodo || "");
            setClasificarCuenta(mov.categoria_cuenta_id || "");
            setEgresoArchivo(null);
            setClasificarMov(mov);
          } else {
            setEditingConcId(conc.id!);
            setConciliarMov(mov);
          }
        };
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={() => setDetalleConcMov(null)}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 680, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }}>
              <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Detalle de conciliación</div>
                  <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>
                    {mov.descripcion || "Movimiento"} &mdash; {fmtDate(mov.fecha)} · {mov.banco || "Banco"}
                  </div>
                </div>
                <button onClick={() => setDetalleConcMov(null)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--txt3)" }}>&times;</button>
              </div>
              <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
                {detalleConcLoading ? (
                  <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>Cargando...</div>
                ) : (
                  <>
                    {/* KPI cards */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Movimiento</div>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: mov.monto < 0 ? "var(--red)" : "var(--green)" }}>{fmtMoney(movTotal)}</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Aplicado</div>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: "var(--cyan)" }}>{fmtMoney(aplicado)}</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Saldo</div>
                        <div className="mono" style={{ fontSize: 14, fontWeight: 800, color: Math.abs(saldo) < 1 ? "var(--green)" : "var(--amber)" }}>{fmtMoney(Math.max(0, saldo))}</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Tipo</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--txt)" }}>{tipoLabel}</div>
                        <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", marginTop: 2 }}>{metodo}</div>
                      </div>
                    </div>

                    {/* Egreso metadata (solo si hay 1 conc de tipo egreso) */}
                    {concs.length === 1 && primary?.tipo_partida === "egreso" && primary.metadata && (() => {
                      const md = primary.metadata as Record<string, string>;
                      return (
                        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 8 }}>Egreso</div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                            {md.tipo && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "var(--amberBg)", color: "var(--amber)", fontWeight: 600 }}>{md.tipo}</span>}
                            {md.periodo && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 600 }}>{md.periodo}</span>}
                            {md.num_documento && <span className="mono" style={{ fontSize: 11, color: "var(--txt3)" }}>#{md.num_documento}</span>}
                          </div>
                          {md.proveedor && <div style={{ fontSize: 12, fontWeight: 600 }}>{md.proveedor}</div>}
                          {md.descripcion && <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 2 }}>{md.descripcion}</div>}
                        </div>
                      );
                    })()}

                    {/* Documentos aplicados */}
                    {docs.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 8 }}>Documentos aplicados ({docs.length})</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {docs.map((d, idx) => {
                            const tipoDoc = "tipo_doc" in d.doc ? d.doc.tipo_doc : "";
                            const nroDoc = "nro_doc" in d.doc ? d.doc.nro_doc : ("nro" in d.doc ? d.doc.nro : "");
                            const razon = "razon_social" in d.doc ? d.doc.razon_social : "";
                            const fecha = "fecha_docto" in d.doc ? d.doc.fecha_docto : null;
                            const total = d.doc.monto_total || 0;
                            const isPartial = Math.abs(d.monto_aplicado - total) > 1;
                            return (
                              <div key={idx} className="card" style={{ padding: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                                    {tipoDoc !== "" && <span className="mono" style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "var(--cyanBg)", color: "var(--cyan)", marginRight: 6 }}>{tipoDocLabel(tipoDoc)}</span>}
                                    Nº {nroDoc}
                                  </div>
                                  <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 2 }}>{razon}</div>
                                  <div className="mono" style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>{fmtDate(fecha)}</div>
                                </div>
                                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                  <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--green)" }}>{fmtMoney(d.monto_aplicado)}</div>
                                  {isPartial && <div className="mono" style={{ fontSize: 9, color: "var(--txt3)", fontWeight: 400 }}>de {fmtMoney(total)}</div>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {docs.length === 0 && primary?.tipo_partida === "clasificacion_directa" && (
                      <div className="card" style={{ padding: 12, marginBottom: 16, fontSize: 11, color: "var(--txt3)" }}>
                        Sin documento — clasificación por cuenta contable.
                      </div>
                    )}

                    {/* Notas */}
                    {notasUniq.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 6 }}>Notas</div>
                        {notasUniq.map((n, i) => (
                          <div key={i} style={{ fontSize: 11, color: "var(--cyan)", marginBottom: 4 }}>{n}</div>
                        ))}
                      </div>
                    )}

                    {/* Adjuntos */}
                    {adjuntos.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                        style={{ display: "block", padding: "8px 12px", background: "var(--bg3)", borderRadius: 6, marginBottom: 6, fontSize: 11, color: "var(--cyan)", textDecoration: "none", fontWeight: 600 }}>
                        Ver documento adjunto {adjuntos.length > 1 ? `(${i + 1})` : ""}
                      </a>
                    ))}
                  </>
                )}
              </div>
              <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {concs.length === 1 && (
                  <button onClick={handleEditar}
                    style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: "pointer" }}>
                    Editar
                  </button>
                )}
                <button onClick={() => setDetalleConcMov(null)}
                  style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cerrar
                </button>
                <button onClick={handleDeshacerTodo}
                  style={{ padding: "8px 18px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", cursor: "pointer" }}>
                  {concs.length > 1 ? `Deshacer todo (${concs.length})` : "Deshacer conciliación"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
