"use client";
/* v3.1 — conteos + pedidos ML + cron fix */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, resetStore, skuTotal, skuPositions, posContents, skuStockDetalle, SIN_ETIQUETAR, activePositions, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS, getCategorias, saveCategorias, getProveedores, saveProveedores, getLastSyncTime, recordMovement, recordBulkMovements, findProduct, importStockFromSheet, wasStockImported, getUnassignedStock, assignPosition, isSupabaseConfigured, getCloudStatus, initStore, isStoreReady, getRecepciones, getRecepcionLineas, crearRecepcion, actualizarRecepcion, actualizarLineaRecepcion, getOperarios, anularRecepcion, pausarRecepcion, reactivarRecepcion, cerrarRecepcion, asignarOperariosRecepcion, parseRecepcionMeta, encodeRecepcionMeta, eliminarLineaRecepcion, agregarLineaRecepcion, getMapConfig, getSkusVenta, getComponentesPorML, getComponentesPorSkuVenta, getVentasPorSkuOrigen, buildPickingLineas, crearPickingSession, getPickingsByDate, getActivePickings, actualizarPicking, eliminarPicking, findSkuVenta, recordMovementAsync, getLineasDeRecepciones, desbloquearLinea, isLineaBloqueada, getRecepcionesActivas, detectarDiscrepancias, getDiscrepancias, aprobarNuevoCosto, rechazarNuevoCosto, tieneDiscrepanciasPendientes, recalcularDiscrepancias, auditarRecepcion, repararRecepcion, ajustarLineaAdmin, detectarDiscrepanciasQty, getDiscrepanciasQty, recalcularDiscrepanciasQty, resolverDiscrepanciaQty, crearDiscrepanciaQtyManual, tieneDiscrepanciasQtyPendientes, getResolucionesQty, reasignarFormato, updateMovementNote, reconciliarStock, aplicarReconciliacion, editarStockVariante, sustituirProducto, getRecepcionAjustes, registrarAjuste, backfillFacturaOriginal } from "@/lib/store";
import type { AuditResult, DBDiscrepanciaQty, DiscrepanciaQtyTipo, StockDiscrepancia } from "@/lib/store";
import type { Product, Movement, Position, InReason, OutReason, DBRecepcion, DBRecepcionLinea, DBOperario, ComposicionVenta, DBPickingSession, PickingLinea, RecepcionMeta } from "@/lib/store";
import type { DBDiscrepanciaCosto, DBRecepcionAjuste, FacturaOriginal } from "@/lib/db";
import { fetchConteos, createConteo, updateConteo, deleteConteo, fetchPedidosFlex, fetchAllPedidosFlex, fetchPedidosFlexByEstado, updatePedidosFlex, fetchMLConfig, upsertMLConfig, fetchMLItemsMap, fetchShipmentsToArm, fetchAllShipments, fetchStoreIds, fetchActiveFlexShipments, fetchMovimientosBySku } from "@/lib/db";
import type { DBConteo, ConteoLinea, DBPedidoFlex, DBMLConfig, DBMLItemMap, ShipmentWithItems } from "@/lib/db";
import { getOAuthUrl } from "@/lib/ml";
import Link from "next/link";
import SheetSync from "@/components/SheetSync";
import AdminReposicion from "@/components/AdminReposicion";
import AdminAgentes from "@/components/AdminAgentes";

const ADMIN_PIN = "1234"; // Change this
const AUTH_KEY = "banva_admin_auth";

function useAuth() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const saved = sessionStorage.getItem(AUTH_KEY);
    if (saved === "1") setOk(true);
  }, []);
  const login = (pin: string) => {
    if (pin === ADMIN_PIN) { sessionStorage.setItem(AUTH_KEY, "1"); setOk(true); return true; }
    return false;
  };
  const logout = () => { sessionStorage.removeItem(AUTH_KEY); setOk(false); };
  return { ok, login, logout };
}

function LoginGate({ onLogin }: { onLogin: (pin: string) => boolean }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  const submit = () => {
    if (!onLogin(pin)) { setErr(true); setPin(""); setTimeout(() => setErr(false), 1500); }
  };
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)",padding:24}}>
      <div style={{width:"100%",maxWidth:360,textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",color:"var(--cyan)",textTransform:"uppercase",marginBottom:6}}>BANVA WMS</div>
        <div style={{fontSize:24,fontWeight:800,marginBottom:4}}>Administrador</div>
        <div style={{fontSize:13,color:"var(--txt3)",marginBottom:32}}>Ingresa el PIN de acceso</div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input type="password" inputMode="numeric" className="form-input mono" value={pin} onChange={e=>setPin(e.target.value.replace(/\D/g,""))}
            onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="PIN" maxLength={6} autoFocus
            style={{fontSize:24,textAlign:"center",letterSpacing:8,padding:16,flex:1}}/>
        </div>
        <button onClick={submit} disabled={pin.length<4}
          style={{width:"100%",padding:14,borderRadius:10,background:pin.length>=4?"var(--cyan)":"var(--bg3)",color:pin.length>=4?"#000":"var(--txt3)",fontWeight:700,fontSize:14,opacity:pin.length>=4?1:0.5}}>
          Entrar
        </button>
        {err && <div style={{marginTop:12,color:"var(--red)",fontWeight:600,fontSize:13}}>PIN incorrecto</div>}
        <Link href="/" style={{display:"inline-block",marginTop:24,color:"var(--txt3)",fontSize:12}}>&#8592; Volver al inicio</Link>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const [tab, setTab] = useState<"dash"|"rec"|"picking"|"pedidos"|"ops"|"inv"|"mov"|"prod"|"reposicion"|"agentes"|"config">("dash");
  const [,setTick] = useState(0);
  const r = useCallback(()=>setTick(t=>t+1),[]);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const auth = useAuth();
  useEffect(()=>{
    setMounted(true);
    initStore().then(()=>setLoading(false));
  },[]);
  if(!mounted) return null;
  if(!auth.ok) return <LoginGate onLogin={auth.login}/>;
  if(loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}><div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA WMS</div><div style={{color:"var(--txt3)"}}>Cargando datos...</div></div></div>;

  return (
    <div className="app-admin">
      <div className="admin-topbar">
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <Link href="/"><button className="back-btn">&#8592;</button></Link>
          <div>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--cyan)",textTransform:"uppercase"}}>BANVA WMS</div>
            <h1 style={{fontSize:16,fontWeight:700,margin:0}}>Panel Administrador</h1>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:11,color:"var(--txt3)"}}>{new Date().toLocaleDateString("es-CL",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</span>
          <button onClick={auth.logout} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>Cerrar sesión</button>
        </div>
      </div>
      <SheetSync onSynced={r}/>
      <div className="admin-layout">
        <nav className="admin-sidebar">
          {([["dash","Dashboard","📊"],["rec","Recepciones","📦"],["picking","Picking Flex","🏷️"],["pedidos","Pedidos ML","🛒"],["ops","Operaciones","⚡"],["inv","Inventario","📦"],["mov","Movimientos","📋"],["prod","Productos","🏷️"],["reposicion","Reposición","🔄"],["agentes","Agentes IA","🤖"],["config","Configuración","⚙️"]] as const).map(([key,label,icon])=>(
            <button key={key} className={`sidebar-btn ${tab===key?"active":""}`} onClick={()=>setTab(key as any)}>
              <span className="sidebar-icon">{icon}</span>
              <span className="sidebar-label">{label}</span>
            </button>
          ))}
          <div style={{flex:1}}/>

          <Link href="/admin/qr-codes"><button className="sidebar-btn"><span className="sidebar-icon">🖨️</span><span className="sidebar-label">Imprimir QRs</span></button></Link>
          <button className="sidebar-btn" onClick={()=>{if(confirm("Resetear todos los datos a demo?")){resetStore();window.location.reload();}}}><span className="sidebar-icon">🔄</span><span className="sidebar-label" style={{color:"var(--amber)"}}>Reset Demo</span></button>
        </nav>

        <main className="admin-main">
          {/* Mobile tabs fallback */}
          <div className="admin-mobile-tabs">
            {([["dash","Dashboard"],["rec","Recepción"],["picking","Picking"],["pedidos","Pedidos ML"],["ops","Ops"],["inv","Inventario"],["mov","Movim."],["prod","Productos"],["reposicion","Reposición"],["agentes","Agentes IA"],["config","Config"]] as const).map(([key,label])=>(
              <button key={key} className={`tab ${tab===key?"active-cyan":""}`} onClick={()=>setTab(key as any)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {tab==="dash"&&<Dashboard/>}
            {tab==="rec"&&<AdminRecepciones refresh={r}/>}
            {tab==="picking"&&<AdminPicking refresh={r}/>}
            {tab==="pedidos"&&<AdminPedidosFlex refresh={r}/>}
            {tab==="ops"&&<Operaciones refresh={r}/>}
            {tab==="inv"&&<Inventario/>}
            {tab==="mov"&&<Movimientos/>}
            {tab==="prod"&&<Productos refresh={r}/>}
            {tab==="reposicion"&&<AdminReposicion/>}
            {tab==="agentes"&&<AdminAgentes/>}
            {tab==="config"&&<Configuracion refresh={r}/>}
          </div>
        </main>
      </div>
    </div>
  );
}

// ==================== ADMIN RECEPCIONES ====================
const ESTADO_COLORS_A: Record<string, string> = {
  CREADA: "var(--amber)", EN_PROCESO: "var(--blue)", COMPLETADA: "var(--green)",
  CERRADA: "var(--txt3)", ANULADA: "var(--red)", PAUSADA: "#8b5cf6",
};
const ESTADO_LABELS_A: Record<string, string> = {
  CREADA: "Nueva", EN_PROCESO: "En proceso", COMPLETADA: "Completada",
  CERRADA: "Cerrada", ANULADA: "Anulada", PAUSADA: "Pausada",
};

type RecFilter = "activas"|"pausadas"|"completadas"|"anuladas"|"todas";
type RecView = "dia"|"facturas";

const LINEA_ESTADO_COLORS: Record<string, string> = {
  PENDIENTE: "var(--red)", CONTADA: "var(--amber)", EN_ETIQUETADO: "var(--blue)",
  ETIQUETADA: "var(--green)", UBICADA: "var(--green)",
};

function AdminRecepciones({ refresh }: { refresh: () => void }) {
  const [view, setView] = useState<RecView>("dia");
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<RecFilter>("activas");
  const [selRec, setSelRec] = useState<DBRecepcion|null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [operarios, setOperarios] = useState<DBOperario[]>([]);
  const [discrepancias, setDiscrepancias] = useState<DBDiscrepanciaCosto[]>([]);
  const [discrepanciasQty, setDiscrepanciasQty] = useState<DBDiscrepanciaQty[]>([]);

  // Factura original & ajustes
  const [facturaOrig, setFacturaOrig] = useState<FacturaOriginal|null>(null);
  const [ajustes, setAjustes] = useState<DBRecepcionAjuste[]>([]);
  const [showAjustes, setShowAjustes] = useState(false);

  // Day view state
  const [dayLineas, setDayLineas] = useState<DBRecepcionLinea[]>([]);
  const [dayFilter, setDayFilter] = useState<"todas"|"pendientes"|"diferencia">("todas");

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editFolio, setEditFolio] = useState("");
  const [editProv, setEditProv] = useState("");
  const [editNotas, setEditNotas] = useState("");
  const [editAsignados, setEditAsignados] = useState<string[]>([]);
  const [editCostoNeto, setEditCostoNeto] = useState(0);
  const [editIva, setEditIva] = useState(0);
  const [editCostoBruto, setEditCostoBruto] = useState(0);

  // Inline line editing
  const [editLineaId, setEditLineaId] = useState<string|null>(null);
  const [editLineaData, setEditLineaData] = useState<{qty_factura:number;qty_recibida:number;qty_etiquetada:number;qty_ubicada:number;costo_unitario:number;nombre:string;sku:string;estado:string}>({qty_factura:0,qty_recibida:0,qty_etiquetada:0,qty_ubicada:0,costo_unitario:0,nombre:"",sku:"",estado:"PENDIENTE"});

  // Audit & repair
  const [auditResults, setAuditResults] = useState<AuditResult[]|null>(null);
  const [auditing, setAuditing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairPos, setRepairPos] = useState("SIN_ASIGNAR");

  // Anular dialog
  const [showAnular, setShowAnular] = useState(false);
  const [anularMotivo, setAnularMotivo] = useState("");

  // Error report modal
  const [errorLinea, setErrorLinea] = useState<DBRecepcionLinea|null>(null);
  const [errorMode, setErrorMode] = useState<"menu"|"conteo"|"sku"|"sustitucion">("menu");
  const [errorQty, setErrorQty] = useState(0);
  const [errorSkuSearch, setErrorSkuSearch] = useState("");
  const [errorSkuResults, setErrorSkuResults] = useState<Product[]>([]);
  const [errorSaving, setErrorSaving] = useState(false);
  const [sustQty, setSustQty] = useState(0);
  const [sustCostoMode, setSustCostoMode] = useState<"factura"|"diccionario">("factura");
  const [sustSelected, setSustSelected] = useState<Product|null>(null);

  // Create form
  const [newFolio, setNewFolio] = useState("");
  const [newProv, setNewProv] = useState("");
  const [newLineas, setNewLineas] = useState<{sku:string;nombre:string;codigoML:string;cantidad:number;costo:number;requiereEtiqueta:boolean}[]>([]);
  const [newSku, setNewSku] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [newCostoNeto, setNewCostoNeto] = useState(0);
  const [newIva, setNewIva] = useState(0);
  const [newCostoBruto, setNewCostoBruto] = useState(0);

  // Add line to existing
  const [addSku, setAddSku] = useState("");
  const [addQty, setAddQty] = useState(1);

  const loadRecs = async () => {
    setLoading(true);
    const [allRecs, ops] = await Promise.all([getRecepciones(), getOperarios()]);
    setRecs(allRecs);
    setOperarios(ops);
    // Load day view lines from active receptions
    const activeIds = allRecs.filter(r => ["CREADA","EN_PROCESO"].includes(r.estado)).map(r => r.id!).filter(Boolean);
    if (activeIds.length > 0) {
      setDayLineas(await getLineasDeRecepciones(activeIds));
    } else {
      setDayLineas([]);
    }
    setLoading(false);
  };
  useEffect(() => { loadRecs(); }, []);

  const counts: Record<RecFilter, number> = {
    activas: recs.filter(r=>["CREADA","EN_PROCESO"].includes(r.estado)).length,
    pausadas: recs.filter(r=>r.estado==="PAUSADA").length,
    completadas: recs.filter(r=>["COMPLETADA","CERRADA"].includes(r.estado)).length,
    anuladas: recs.filter(r=>r.estado==="ANULADA").length,
    todas: recs.length,
  };

  const filteredRecs = recs.filter(r => {
    if (filter==="activas") return ["CREADA","EN_PROCESO"].includes(r.estado);
    if (filter==="pausadas") return r.estado==="PAUSADA";
    if (filter==="completadas") return ["COMPLETADA","CERRADA"].includes(r.estado);
    if (filter==="anuladas") return r.estado==="ANULADA";
    return true;
  });

  const openRec = async (rec: DBRecepcion) => {
    setSelRec(rec);
    const recLineas = await getRecepcionLineas(rec.id!);
    setLineas(recLineas);
    const [discs, discsQty, recAjustes] = await Promise.all([
      detectarDiscrepancias(rec.id!, recLineas),
      detectarDiscrepanciasQty(rec.id!, recLineas),
      getRecepcionAjustes(rec.id!),
    ]);
    setDiscrepancias(discs);
    setDiscrepanciasQty(discsQty);
    setAjustes(recAjustes);
    // Backfill factura_original si no existe
    if (rec.factura_original) {
      setFacturaOrig(rec.factura_original);
    } else if (recLineas.length > 0) {
      const snapshot = await backfillFacturaOriginal(rec.id!, recLineas, rec);
      setFacturaOrig(snapshot);
    } else {
      setFacturaOrig(null);
    }
    const meta = parseRecepcionMeta(rec.notas || "");
    setEditFolio(rec.folio); setEditProv(rec.proveedor);
    setEditNotas(meta.notas); setEditAsignados(meta.asignados);
    setEditCostoNeto(rec.costo_neto || 0); setEditIva(rec.iva || 0); setEditCostoBruto(rec.costo_bruto || 0);
    setEditing(false); setShowAnular(false); setAuditResults(null); setEditLineaId(null); setShowAjustes(false);
  };

  const refreshDetail = async () => {
    if (!selRec) return;
    const updatedRecs = await getRecepciones();
    setRecs(updatedRecs);
    const updated = updatedRecs.find(r => r.id === selRec.id);
    if (updated) { setSelRec(updated); const m = parseRecepcionMeta(updated.notas||""); setEditNotas(m.notas); setEditAsignados(m.asignados); }
    setLineas(await getRecepcionLineas(selRec.id!));
    const [dc, dq, aj] = await Promise.all([
      getDiscrepancias(selRec.id!),
      getDiscrepanciasQty(selRec.id!),
      getRecepcionAjustes(selRec.id!),
    ]);
    setDiscrepancias(dc);
    setDiscrepanciasQty(dq);
    setAjustes(aj);
  };

  // ---- Status actions ----
  const doAnular = async () => {
    if (!selRec) return; setLoading(true);
    await anularRecepcion(selRec.id!, anularMotivo);
    setShowAnular(false); setAnularMotivo("");
    await loadRecs(); setSelRec(null); setLoading(false);
  };
  const doPausar = async () => { if (!selRec) return; setLoading(true); await pausarRecepcion(selRec.id!); await loadRecs(); setSelRec(null); setLoading(false); };
  const doReactivar = async () => { if (!selRec) return; setLoading(true); await reactivarRecepcion(selRec.id!); await loadRecs(); setSelRec(null); setLoading(false); };
  const doCerrar = async () => {
    if (!selRec) return; setLoading(true);
    const result = await cerrarRecepcion(selRec.id!);
    if (!result.ok) {
      const msgs: string[] = [];
      if (result.pendientes) msgs.push(`${result.pendientes} discrepancia(s) de costo`);
      if (result.pendientesQty) msgs.push(`${result.pendientesQty} discrepancia(s) de cantidad`);
      alert(`No se puede cerrar: hay ${msgs.join(" y ")} sin resolver. Resuelve todas antes de cerrar.`);
      setLoading(false); return;
    }
    await loadRecs(); setSelRec(null); setLoading(false);
  };

  // ---- Edit save ----
  const doSaveEdit = async () => {
    if (!selRec) return; setLoading(true);
    const meta: RecepcionMeta = { notas: editNotas, asignados: editAsignados };
    await actualizarRecepcion(selRec.id!, { folio: editFolio, proveedor: editProv, notas: encodeRecepcionMeta(meta), costo_neto: editCostoNeto, iva: editIva, costo_bruto: editCostoBruto });
    setEditing(false); await refreshDetail(); setLoading(false);
  };

  // ---- Discrepancy actions ----
  const doAprobar = async (disc: DBDiscrepanciaCosto) => {
    if (!confirm(`Aprobar nuevo costo para ${disc.sku}?\nDiccionario: ${fmtMoney(disc.costo_diccionario)} → Factura: ${fmtMoney(disc.costo_factura)}\nEl diccionario se actualizará con el nuevo costo.`)) return;
    setLoading(true);
    try {
      const result = await aprobarNuevoCosto(disc.id!, disc.sku, disc.costo_factura);
      const sr = result.sheetResult;
      if (sr?.ok) {
        alert(`Costo aprobado y actualizado.\nDB: OK\nGoogle Sheet: fila ${sr.row}, celda ${sr.cell}`);
      } else {
        alert(`Costo aprobado en DB.\nGoogle Sheet: ${sr?.error || JSON.stringify(sr)}\n\nRevisa /api/sheet/update-cost en el navegador para diagnosticar.`);
      }
      await refreshDetail();
    } catch (e: unknown) {
      console.error("Error aprobando costo:", e);
      alert(`Error al aprobar: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };
  const doRechazar = async (disc: DBDiscrepanciaCosto) => {
    const nota = prompt("Motivo del rechazo (error proveedor, etc):", "Error de proveedor - reclamar");
    if (nota === null) return;
    setLoading(true);
    try {
      await rechazarNuevoCosto(disc.id!, nota);
      await refreshDetail();
    } catch (e: unknown) {
      console.error("Error rechazando costo:", e);
      alert(`Error al rechazar: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };

  // ---- Line actions ----
  const doResetLinea = async (lineaId: string) => {
    if (!confirm("Resetear esta línea a PENDIENTE? Se perderán conteos y ubicaciones.")) return;
    await actualizarLineaRecepcion(lineaId, { estado: "PENDIENTE", qty_recibida: 0, qty_etiquetada: 0, qty_ubicada: 0, operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "" });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const doDeleteLinea = async (lineaId: string) => {
    if (!confirm("Eliminar esta línea de la recepción?")) return;
    const deletedLinea = lineas.find(l => l.id === lineaId);
    await eliminarLineaRecepcion(lineaId);
    if (deletedLinea && selRec) {
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "linea_eliminada",
        sku_original: deletedLinea.sku, campo: "eliminada",
        valor_anterior: `${deletedLinea.qty_factura} uds @ ${deletedLinea.costo_unitario || 0}`,
        motivo: "Línea eliminada por admin", admin: "admin",
      });
    }
    setLineas(await getRecepcionLineas(selRec!.id!));
    setAjustes(await getRecepcionAjustes(selRec!.id!));
  };
  const doUpdateLineQty = async (lineaId: string, val: string) => {
    const n = parseInt(val); if (isNaN(n) || n < 0) return;
    await actualizarLineaRecepcion(lineaId, { qty_factura: n });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const startEditLinea = (l: DBRecepcionLinea) => {
    setEditLineaId(l.id!);
    setEditLineaData({ qty_factura: l.qty_factura, qty_recibida: l.qty_recibida||0, qty_etiquetada: l.qty_etiquetada||0, qty_ubicada: l.qty_ubicada||0, costo_unitario: l.costo_unitario||0, nombre: l.nombre, sku: l.sku, estado: l.estado });
  };
  const saveEditLinea = async () => {
    if (!editLineaId || !selRec) return;
    setLoading(true);
    try {
      const originalLinea = lineas.find(l => l.id === editLineaId);
      const oldQtyUbicada = originalLinea?.qty_ubicada || 0;
      const newQtyUbicada = editLineaData.qty_ubicada;
      if (oldQtyUbicada !== newQtyUbicada) {
        await ajustarLineaAdmin(editLineaId, selRec.id!, editLineaData.sku, oldQtyUbicada, newQtyUbicada);
      }
      await actualizarLineaRecepcion(editLineaId, {
        qty_factura: editLineaData.qty_factura,
        qty_recibida: editLineaData.qty_recibida,
        qty_etiquetada: editLineaData.qty_etiquetada,
        qty_ubicada: editLineaData.qty_ubicada,
        costo_unitario: editLineaData.costo_unitario,
        nombre: editLineaData.nombre,
        sku: editLineaData.sku,
        estado: editLineaData.estado as DBRecepcionLinea["estado"],
      });
      // Log ajustes for changed fields
      if (originalLinea) {
        const oldQtyR = originalLinea.qty_recibida || 0;
        const newQtyR = editLineaData.qty_recibida;
        if (oldQtyR !== newQtyR) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "cantidad", sku_original: originalLinea.sku, campo: "qty_recibida", valor_anterior: String(oldQtyR), valor_nuevo: String(newQtyR), motivo: "Ajuste manual por admin", admin: "admin" });
        }
        const oldQtyF = originalLinea.qty_factura;
        if (oldQtyF !== editLineaData.qty_factura) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "cantidad", sku_original: originalLinea.sku, campo: "qty_factura", valor_anterior: String(oldQtyF), valor_nuevo: String(editLineaData.qty_factura), motivo: "Ajuste qty factura por admin", admin: "admin" });
        }
        const oldCosto = originalLinea.costo_unitario || 0;
        if (oldCosto !== editLineaData.costo_unitario) {
          await registrarAjuste({ recepcion_id: selRec.id!, tipo: "costo", sku_original: originalLinea.sku, campo: "costo_unitario", valor_anterior: String(oldCosto), valor_nuevo: String(editLineaData.costo_unitario), motivo: "Ajuste costo por admin", admin: "admin" });
        }
      }
    } catch (e: unknown) {
      alert(`Error al guardar: ${e instanceof Error ? e.message : e}`);
    }
    setEditLineaId(null);
    setLineas(await getRecepcionLineas(selRec!.id!));
    setAjustes(await getRecepcionAjustes(selRec!.id!));
    setLoading(false);
  };
  const doAddLinea = async () => {
    if (!addSku || !selRec) return;
    const prod = getStore().products[addSku.toUpperCase()];
    const skuUp = addSku.toUpperCase();
    const costo = prod?.cost || 0;
    await agregarLineaRecepcion(selRec.id!, {
      sku: skuUp, nombre: prod?.name || addSku, codigoML: prod?.mlCode || "",
      cantidad: addQty, costo, requiereEtiqueta: prod?.requiresLabel !== false,
    });
    await registrarAjuste({
      recepcion_id: selRec.id!, tipo: "linea_agregada",
      sku_nuevo: skuUp, campo: "nueva_linea",
      valor_nuevo: `${addQty} uds @ ${costo}`,
      motivo: "Línea agregada por admin", admin: "admin",
    });
    setAddSku(""); setAddQty(1);
    setLineas(await getRecepcionLineas(selRec.id!));
    setAjustes(await getRecepcionAjustes(selRec.id!));
  };

  // Toggle operator assignment
  const toggleOp = (nombre: string) => {
    setEditAsignados(prev => prev.includes(nombre) ? prev.filter(n=>n!==nombre) : [...prev, nombre]);
  };

  // ---- Error report modal helpers ----
  const openErrorReport = (l: DBRecepcionLinea) => {
    setErrorLinea(l);
    setErrorMode("menu");
    setErrorQty(l.qty_factura);
    setErrorSkuSearch("");
    setErrorSkuResults([]);
  };
  const closeErrorReport = () => { if (!errorSaving) setErrorLinea(null); };
  const doErrorAjusteConteo = async () => {
    if (!errorLinea || errorQty < 0 || !selRec) return;
    setErrorSaving(true);
    try {
      await actualizarLineaRecepcion(errorLinea.id!, {
        qty_factura: errorQty,
        notas: `${errorLinea.notas ? errorLinea.notas + " | " : ""}Ajuste conteo: ${errorLinea.qty_factura} → ${errorQty}`,
      });
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "cantidad",
        sku_original: errorLinea.sku, campo: "qty_factura",
        valor_anterior: String(errorLinea.qty_factura), valor_nuevo: String(errorQty),
        motivo: `Ajuste conteo: ${errorLinea.qty_factura} → ${errorQty}`, admin: "admin",
      });
      const updatedLineas = await getRecepcionLineas(selRec.id!);
      setLineas(updatedLineas);
      const dq = await recalcularDiscrepanciasQty(selRec.id!, updatedLineas);
      setDiscrepanciasQty(dq);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
    } catch (e: unknown) {
      console.error("Error ajuste conteo:", e);
      alert(`Error al ajustar conteo: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const doErrorCambioSku = async (newProduct: Product) => {
    if (!errorLinea || !selRec) return;
    setErrorSaving(true);
    try {
      const oldSku = errorLinea.sku;
      await actualizarLineaRecepcion(errorLinea.id!, {
        sku: newProduct.sku,
        nombre: newProduct.name,
        codigo_ml: newProduct.mlCode || "",
        requiere_etiqueta: newProduct.requiresLabel ?? errorLinea.requiere_etiqueta,
        notas: `${errorLinea.notas ? errorLinea.notas + " | " : ""}Cambio SKU: ${oldSku} → ${newProduct.sku}`,
      });
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "sustitucion",
        sku_original: oldSku, sku_nuevo: newProduct.sku,
        campo: "sku",
        valor_anterior: `${oldSku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        valor_nuevo: `${newProduct.sku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        motivo: "Corrección de SKU erróneo", admin: "admin",
      });
      const updatedLineas = await getRecepcionLineas(selRec.id!);
      setLineas(updatedLineas);
      const [dc, dq] = await Promise.all([
        recalcularDiscrepancias(selRec.id!, updatedLineas),
        recalcularDiscrepanciasQty(selRec.id!, updatedLineas),
      ]);
      setDiscrepancias(dc);
      setDiscrepanciasQty(dq);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
    } catch (e: unknown) {
      console.error("Error cambio SKU:", e);
      alert(`Error al cambiar SKU: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const doSustitucion = async () => {
    if (!errorLinea || !selRec || !sustSelected || sustQty <= 0) return;
    setErrorSaving(true);
    try {
      const costoSust = sustCostoMode === "factura" ? (errorLinea.costo_unitario || 0) : (sustSelected.cost || 0);
      const result = await sustituirProducto(
        selRec.id!,
        errorLinea.id!,
        {
          sku: sustSelected.sku,
          nombre: sustSelected.name,
          codigoML: sustSelected.mlCode || "",
          requiereEtiqueta: sustSelected.requiresLabel !== false,
          costoDiccionario: sustSelected.cost || 0,
        },
        sustQty,
        sustCostoMode === "factura",
      );
      await registrarAjuste({
        recepcion_id: selRec.id!, tipo: "sustitucion",
        sku_original: errorLinea.sku, sku_nuevo: sustSelected.sku,
        campo: "sku",
        valor_anterior: `${errorLinea.sku} × ${errorLinea.qty_factura} @ ${fmtMoney(errorLinea.costo_unitario||0)}`,
        valor_nuevo: `${sustSelected.sku} × ${sustQty} @ ${fmtMoney(costoSust)}`,
        motivo: "Proveedor envió producto distinto", admin: "admin",
      });
      setLineas(await getRecepcionLineas(selRec.id!));
      setDiscrepancias(result.discrepanciasCosto);
      setDiscrepanciasQty(result.discrepancias);
      setAjustes(await getRecepcionAjustes(selRec.id!));
      setErrorLinea(null);
      setSustSelected(null);
    } catch (e: unknown) {
      console.error("Error en sustitución:", e);
      alert(`Error al sustituir: ${e instanceof Error ? e.message : e}`);
    } finally {
      setErrorSaving(false);
    }
  };
  const handleErrorSkuSearch = (q: string) => {
    setErrorSkuSearch(q);
    setErrorSkuResults(q.trim().length >= 2 ? findProduct(q).slice(0, 15) : []);
  };

  const addLinea = () => {
    if (!newSku) return;
    const prod = getStore().products[newSku.toUpperCase()];
    setNewLineas(l => [...l, {
      sku: newSku.toUpperCase(), nombre: prod?.name || newSku, codigoML: prod?.mlCode || "",
      cantidad: newQty, costo: prod?.cost || 0, requiereEtiqueta: prod?.requiresLabel !== false,
    }]);
    setNewSku(""); setNewQty(1);
  };
  const doCreate = async () => {
    if (!newFolio || !newProv || newLineas.length === 0) return;
    setLoading(true);
    await crearRecepcion(newFolio, newProv, "", newLineas, { costo_neto: newCostoNeto || 0, iva: newIva || 0, costo_bruto: newCostoBruto || 0 });
    setNewFolio(""); setNewProv(""); setNewLineas([]); setNewCostoNeto(0); setNewIva(0); setNewCostoBruto(0); setShowCreate(false);
    await loadRecs(); setLoading(false);
  };

  // ==================== DETAIL VIEW ====================
  if (selRec) {
    const total = lineas.length;
    const ubicadas = lineas.filter(l => l.estado === "UBICADA").length;
    const progress = total > 0 ? Math.round((ubicadas / total) * 100) : 0;
    const meta = parseRecepcionMeta(selRec.notas || "");
    const isEditable = !["ANULADA","CERRADA"].includes(selRec.estado);
    const addSuggestions = addSku.length >= 2 ? findProduct(addSku).slice(0, 5) : [];

    return (
      <div>
        <button onClick={() => { setSelRec(null); loadRecs(); }} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver a lista
        </button>

        {/* Header card */}
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div className="card-title">{selRec.proveedor} — Folio {selRec.folio}</div>
              <div style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(selRec.created_at||"")} · {fmtTime(selRec.created_at||"")} · Creado por: {selRec.created_by}</div>
              {meta.asignados.length > 0 && (
                <div style={{fontSize:11,color:"var(--cyan)",marginTop:4}}>Asignado a: <strong>{meta.asignados.join(", ")}</strong></div>
              )}
              {meta.motivo_anulacion && selRec.estado === "ANULADA" && (
                <div style={{fontSize:11,color:"var(--red)",marginTop:4}}>Motivo anulación: {meta.motivo_anulacion}</div>
              )}
            </div>
            <span style={{padding:"4px 12px",borderRadius:6,background:ESTADO_COLORS_A[selRec.estado],color:"#fff",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
              {ESTADO_LABELS_A[selRec.estado]||selRec.estado}
            </span>
          </div>
          {selRec.estado !== "ANULADA" && (
            <>
              <div style={{marginTop:10,background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
                <div style={{width:`${progress}%`,height:"100%",background:progress===100?"var(--green)":"var(--blue)",borderRadius:6}}/>
              </div>
              <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>{ubicadas}/{total} líneas completadas</div>
            </>
          )}
          {/* Factura Original / Ajustada / Diferencia */}
          {(() => {
            // Factura ajustada: calculada dinámicamente de líneas actuales
            const netoAjustado = lineas.reduce((s, l) => s + (l.costo_unitario || 0) * (l.qty_recibida > 0 ? l.qty_recibida : l.qty_factura), 0);
            const ivaAjustado = Math.round(netoAjustado * 0.19);
            const brutoAjustado = netoAjustado + ivaAjustado;
            const hayRecibido = lineas.some(l => l.qty_recibida > 0);

            // Diferencia
            const netoOrig = facturaOrig?.neto || 0;
            const brutoOrig = facturaOrig?.bruto || 0;
            const diffNeto = hayRecibido ? netoAjustado - netoOrig : 0;
            const diffBruto = hayRecibido ? brutoAjustado - brutoOrig : 0;

            const costBlockStyle = {padding:"10px 12px",borderRadius:8,border:"1px solid var(--bg4)",marginTop:10};
            const rowStyle = {display:"flex",justifyContent:"space-between",marginBottom:2,fontSize:12};
            const totalRowStyle = {...rowStyle,borderTop:"1px solid var(--bg4)",paddingTop:4,marginTop:4,marginBottom:0};

            return (facturaOrig || netoAjustado > 0) ? (
              <div style={{marginTop:10}}>
                {/* Bloque 1: Factura Original */}
                {facturaOrig && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:8}}>Factura Original (N° {selRec.folio} — {selRec.proveedor})</div>
                    <div style={{marginBottom:8}}>
                      {facturaOrig.lineas.map((fl, i) => (
                        <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",color:"var(--txt2)"}}>
                          <span className="mono" style={{flex:1}}>{fl.sku}</span>
                          <span className="mono" style={{width:60,textAlign:"right"}}>×{fl.cantidad}</span>
                          <span className="mono" style={{width:80,textAlign:"right"}}>@{fmtMoney(fl.costo_unitario)}</span>
                          <span className="mono" style={{width:100,textAlign:"right",fontWeight:700}}>{fmtMoney(fl.cantidad * fl.costo_unitario)}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"6px 0",borderTop:"1px solid var(--bg4)"}}>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto:</span> <strong>{fmtMoney(facturaOrig.neto)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA:</span> <strong>{fmtMoney(facturaOrig.iva)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto:</span> <strong style={{color:"var(--cyan)"}}>{fmtMoney(facturaOrig.bruto)}</strong></div>
                    </div>
                  </div>
                )}

                {/* Bloque 2: Factura Ajustada */}
                {hayRecibido && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <div style={{fontSize:11,fontWeight:700,color:diffNeto!==0?"var(--amber)":"var(--green)",marginBottom:8}}>Factura Ajustada (Real)</div>
                    <div style={{marginBottom:8}}>
                      {lineas.map(l => {
                        const isOriginal = facturaOrig?.lineas.some(fl => fl.sku === l.sku);
                        const noLlego = l.qty_recibida === 0 && l.qty_factura > 0;
                        const esNueva = !isOriginal && l.qty_factura === 0;
                        const subtotal = (l.costo_unitario || 0) * (l.qty_recibida > 0 ? l.qty_recibida : 0);
                        return (
                          <div key={l.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",
                            color: noLlego ? "var(--txt3)" : esNueva ? "var(--cyan)" : "var(--txt2)",
                            textDecoration: noLlego ? "line-through" : "none"}}>
                            <span className="mono" style={{flex:1}}>{l.sku}</span>
                            <span className="mono" style={{width:60,textAlign:"right"}}>×{l.qty_recibida}</span>
                            <span className="mono" style={{width:80,textAlign:"right"}}>@{fmtMoney(l.costo_unitario||0)}</span>
                            <span className="mono" style={{width:100,textAlign:"right",fontWeight:700}}>{fmtMoney(subtotal)}</span>
                            <span style={{width:80,textAlign:"right",fontSize:9,fontWeight:600,color:noLlego?"var(--red)":esNueva?"var(--cyan)":"transparent"}}>
                              {noLlego ? "(no llegó)" : esNueva ? "(nuevo)" : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12,padding:"6px 0",borderTop:"1px solid var(--bg4)"}}>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Neto:</span> <strong>{fmtMoney(netoAjustado)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>IVA:</span> <strong>{fmtMoney(ivaAjustado)}</strong></div>
                      <div><span style={{color:"var(--txt3)",fontSize:10}}>Bruto:</span> <strong style={{color:diffNeto!==0?"var(--amber)":"var(--cyan)"}}>{fmtMoney(brutoAjustado)}</strong></div>
                    </div>
                  </div>
                )}

                {/* Bloque 3: Diferencia */}
                {hayRecibido && facturaOrig && (
                  <div style={{...costBlockStyle,
                    background: diffNeto === 0 ? "var(--greenBg)" : diffNeto > 0 ? "var(--amberBg)" : "var(--redBg)",
                    border: `1px solid ${diffNeto === 0 ? "var(--greenBd,var(--green))" : diffNeto > 0 ? "var(--amberBd)" : "var(--redBd,var(--red))"}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{fontSize:12}}>
                        <span style={{fontWeight:700,color:diffNeto===0?"var(--green)":diffNeto>0?"var(--amber)":"var(--red)"}}>
                          Diferencia: {diffNeto>=0?"+":""}{ fmtMoney(diffNeto)} neto | {diffBruto>=0?"+":""}{fmtMoney(diffBruto)} bruto
                        </span>
                      </div>
                    </div>
                    <div style={{fontSize:11,marginTop:4,fontWeight:600,color:diffNeto===0?"var(--green)":diffNeto>0?"var(--amber)":"var(--red)"}}>
                      {diffNeto === 0
                        ? "Factura cuadra perfectamente"
                        : diffNeto > 0
                        ? `Recibiste de más: ${fmtMoney(Math.abs(diffNeto))} neto (te deben)`
                        : `No llegó todo: te deben nota de crédito por ${fmtMoney(Math.abs(diffNeto))} neto`}
                    </div>
                  </div>
                )}

                {/* Historial de ajustes */}
                {ajustes.length > 0 && (
                  <div style={{...costBlockStyle,background:"var(--bg3)"}}>
                    <button onClick={()=>setShowAjustes(!showAjustes)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",cursor:"pointer",padding:0}}>
                      <span style={{fontSize:11,fontWeight:700,color:"var(--txt2)"}}>Historial de ajustes ({ajustes.length})</span>
                      <span style={{fontSize:12,color:"var(--txt3)"}}>{showAjustes ? "▲" : "▼"}</span>
                    </button>
                    {showAjustes && (
                      <div style={{marginTop:8}}>
                        {ajustes.map(a => (
                          <div key={a.id} style={{padding:"6px 0",borderBottom:"1px solid var(--bg4)",fontSize:11}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                              <span style={{fontWeight:700,color:
                                a.tipo==="sustitucion"?"var(--cyan)":
                                a.tipo==="linea_agregada"?"var(--green)":
                                a.tipo==="linea_eliminada"?"var(--red)":
                                a.tipo==="costo"?"var(--amber)":"var(--txt2)"}}>
                                {a.tipo==="sustitucion"?"Sustitución":a.tipo==="cantidad"?"Cantidad":a.tipo==="linea_agregada"?"Línea agregada":a.tipo==="linea_eliminada"?"Línea eliminada":a.tipo==="costo"?"Costo":a.tipo}
                              </span>
                              <span style={{color:"var(--txt3)",fontSize:10}}>{a.created_at ? `${fmtDate(a.created_at)} ${fmtTime(a.created_at)}` : ""} — {a.admin||""}</span>
                            </div>
                            {a.tipo==="sustitucion" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span> → <span className="mono">{a.sku_nuevo}</span></div>}
                            {a.tipo==="cantidad" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior} → {a.valor_nuevo}</div>}
                            {a.tipo==="linea_agregada" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_nuevo}</span>: {a.valor_nuevo}</div>}
                            {a.tipo==="linea_eliminada" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior}</div>}
                            {a.tipo==="costo" && <div style={{color:"var(--txt2)"}}><span className="mono">{a.sku_original}</span>: {a.valor_anterior} → {a.valor_nuevo}</div>}
                            {a.motivo && <div style={{color:"var(--txt3)",fontSize:10,marginTop:2}}>{a.motivo}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null;
          })()}
        </div>

        {/* Action bar */}
        <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap"}}>
          {isEditable && <button onClick={()=>setEditing(!editing)} style={{padding:"8px 14px",borderRadius:6,background:editing?"var(--cyan)":"var(--bg3)",color:editing?"#000":"var(--cyan)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>
            {editing ? "Cancelar edición" : "Editar"}
          </button>}
          {["CREADA","EN_PROCESO"].includes(selRec.estado) && <button onClick={doPausar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"#8b5cf6",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Pausar</button>}
          {selRec.estado === "PAUSADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reactivar</button>}
          {selRec.estado === "ANULADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reabrir</button>}
          {selRec.estado === "COMPLETADA" && <button onClick={doCerrar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Cerrar</button>}
          {selRec.estado === "CERRADA" && <button onClick={doReactivar} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Reabrir</button>}
          {selRec.estado !== "ANULADA" && <button onClick={()=>setShowAnular(!showAnular)} style={{padding:"8px 14px",borderRadius:6,background:showAnular?"var(--red)":"var(--bg3)",color:showAnular?"#fff":"var(--red)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Anular</button>}
          <button onClick={refreshDetail} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)"}}>Actualizar</button>
          <button disabled={auditing} onClick={async()=>{
            setAuditing(true); setAuditResults(null);
            try { const r = await auditarRecepcion(selRec.id!); setAuditResults(r); }
            finally { setAuditing(false); }
          }} style={{padding:"8px 14px",borderRadius:6,background:"var(--amberBg)",color:"var(--amber)",fontSize:11,fontWeight:700,border:"1px solid var(--amberBd)"}}>
            {auditing ? "Auditando..." : "Auditar inventario"}
          </button>
        </div>

        {/* Audit results */}
        {auditResults !== null && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--amber)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
              Resultado de auditoria — {auditResults.length === 0 ? "Todo OK" : `${auditResults.length} problemas encontrados`}
            </div>
            {auditResults.length === 0 ? (
              <div style={{padding:12,textAlign:"center",color:"var(--green)",fontWeight:600}}>
                Todas las lineas UBICADAS tienen stock y movimientos correctos.
              </div>
            ) : (
              <>
                <div style={{overflowX:"auto"}}>
                  <table className="tbl">
                    <thead><tr><th>SKU</th><th>Producto</th><th style={{textAlign:"right"}}>Ubicado</th><th style={{textAlign:"right"}}>Movimientos</th><th style={{textAlign:"right"}}>Stock actual</th><th>Problema</th><th>Estado</th></tr></thead>
                    <tbody>{auditResults.map(r => (
                      <tr key={r.linea_id} style={{background: r.reparado ? "var(--greenBg)" : "var(--redBg)"}}>
                        <td className="mono" style={{fontSize:11,fontWeight:700}}>{r.sku}</td>
                        <td style={{fontSize:11}}>{r.nombre}</td>
                        <td className="mono" style={{textAlign:"right"}}>{r.qty_ubicada}</td>
                        <td className="mono" style={{textAlign:"right",color:r.movimientos_encontrados===0?"var(--red)":"var(--txt1)"}}>{r.movimientos_encontrados}</td>
                        <td className="mono" style={{textAlign:"right",color:r.stock_actual===0?"var(--red)":"var(--txt1)"}}>{r.stock_actual}</td>
                        <td style={{fontSize:10,color:"var(--red)",fontWeight:600}}>{r.problema}</td>
                        <td>{r.reparado ? <span style={{fontSize:10,fontWeight:700,color:"var(--green)"}}>REPARADO: {r.detalle}</span> : <span style={{fontSize:10,color:"var(--txt3)"}}>{r.estado}</span>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {!auditResults.some(r => r.reparado) && (
                  <div style={{marginTop:12,padding:12,borderRadius:8,background:"var(--bg3)",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontWeight:600}}>Reparar: registrar stock faltante en</span>
                    <select className="form-select" value={repairPos} onChange={e=>setRepairPos(e.target.value)} style={{fontSize:11,padding:"4px 8px"}}>
                      {activePositions().map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <button disabled={repairing} onClick={async()=>{
                      if (!confirm(`Esto registrara el stock faltante en posicion "${repairPos}" y creara los movimientos. Continuar?`)) return;
                      setRepairing(true);
                      try {
                        const r = await repararRecepcion(selRec.id!, repairPos);
                        setAuditResults(r);
                        await refreshDetail();
                      } finally { setRepairing(false); }
                    }} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:11,fontWeight:700,border:"none",cursor:"pointer"}}>
                      {repairing ? "Reparando..." : "Reparar ahora"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Anular dialog */}
        {showAnular && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--red)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--red)",marginBottom:8}}>Anular recepción</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:8}}>Esta acción marcará la recepción como anulada. Los operadores ya no la verán.</div>
            <input className="form-input" value={anularMotivo} onChange={e=>setAnularMotivo(e.target.value)} placeholder="Motivo de anulación (opcional)" style={{marginBottom:8}}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={doAnular} disabled={loading} style={{padding:"8px 16px",borderRadius:6,background:"var(--red)",color:"#fff",fontSize:12,fontWeight:700}}>
                {loading ? "Anulando..." : "Confirmar anulación"}
              </button>
              <button onClick={()=>{setShowAnular(false);setAnularMotivo("");}} style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
            </div>
          </div>
        )}

        {/* Edit panel */}
        {editing && (
          <div className="card" style={{marginTop:12,border:"2px solid var(--cyan)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"var(--cyan)",marginBottom:10}}>Editar recepción</div>
            <div className="admin-grid-2" style={{marginBottom:10}}>
              <div>
                <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Folio</label>
                <input className="form-input" value={editFolio} onChange={e=>setEditFolio(e.target.value)} style={{marginTop:4}}/>
              </div>
              <div>
                <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Proveedor</label>
                <select className="form-select" value={editProv} onChange={e=>setEditProv(e.target.value)} style={{marginTop:4}}>
                  <option value="">Seleccionar...</option>
                  {getProveedores().map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:10}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Notas</label>
              <textarea className="form-input" value={editNotas} onChange={e=>setEditNotas(e.target.value)} rows={2} style={{marginTop:4,resize:"vertical"}}/>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Asignar operarios (vacío = visible para todos)</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {operarios.map(op => (
                  <button key={op.id} onClick={()=>toggleOp(op.nombre)}
                    style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                      background:editAsignados.includes(op.nombre)?"var(--cyan)":"var(--bg3)",
                      color:editAsignados.includes(op.nombre)?"#000":"var(--txt2)",
                      border:`1px solid ${editAsignados.includes(op.nombre)?"var(--cyan)":"var(--bg4)"}`}}>
                    {editAsignados.includes(op.nombre)?"✓ ":""}{op.nombre}
                  </button>
                ))}
                {operarios.length === 0 && <span style={{fontSize:11,color:"var(--txt3)"}}>No hay operarios registrados en el sistema</span>}
              </div>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Costos de factura</label>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>Neto</label>
                  <input type="number" className="form-input" value={editCostoNeto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setEditCostoNeto(v);setEditIva(Math.round(v*0.19));setEditCostoBruto(Math.round(v*1.19));}}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>IVA (19%)</label>
                  <input type="number" className="form-input" value={editIva||""} onChange={e=>setEditIva(parseFloat(e.target.value)||0)}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
                <div>
                  <label style={{fontSize:10,color:"var(--txt3)"}}>Bruto</label>
                  <input type="number" className="form-input" value={editCostoBruto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setEditCostoBruto(v);setEditCostoNeto(Math.round(v/1.19));setEditIva(Math.round(v-v/1.19));}}
                    placeholder="$0" style={{marginTop:2,fontSize:12}}/>
                </div>
              </div>
            </div>
            <button onClick={doSaveEdit} disabled={loading} style={{padding:"10px 20px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
              {loading ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        )}

        {/* Discrepancy panel */}
        {discrepancias.length > 0 && (
          <div className="card" style={{marginTop:12,border: tieneDiscrepanciasPendientes(discrepancias) ? "2px solid var(--amber)" : "1px solid var(--bg4)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700,color: tieneDiscrepanciasPendientes(discrepancias) ? "var(--amber)" : "var(--green)"}}>
                Discrepancias de costo ({discrepancias.filter(d=>d.estado==="PENDIENTE").length} pendientes)
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {tieneDiscrepanciasPendientes(discrepancias) && (
                  <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontWeight:700,border:"1px solid var(--amberBd)"}}>
                    Resolver antes de cerrar
                  </span>
                )}
                <button onClick={async()=>{if(!selRec)return;const d=await recalcularDiscrepancias(selRec.id!,lineas);setDiscrepancias(d);}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}} title="Recalcular discrepancias (borra pendientes y re-detecta)">
                  Recalcular
                </button>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th>
                  <th style={{textAlign:"right"}}>Diccionario</th>
                  <th style={{textAlign:"right"}}>Factura</th>
                  <th style={{textAlign:"right"}}>Diferencia</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr></thead>
                <tbody>{discrepancias.map(d => (
                  <tr key={d.id} style={{background: d.estado==="PENDIENTE" ? "var(--amberBg)" : d.estado==="APROBADO" ? "var(--greenBg)" : "var(--redBg)"}}>
                    <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12}}>{d.costo_diccionario > 0 ? fmtMoney(d.costo_diccionario) : <span style={{color:"var(--txt3)",fontSize:10}}>Sin costo</span>}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700}}>{fmtMoney(d.costo_factura)}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700,color:d.diferencia>0?"var(--red)":"var(--green)"}}>
                      {d.diferencia > 0 ? "+" : ""}{fmtMoney(d.diferencia)} ({d.porcentaje > 0 ? "+" : ""}{d.porcentaje}%)
                    </td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                        background: d.estado==="PENDIENTE" ? "var(--amberBg)" : d.estado==="APROBADO" ? "var(--greenBg)" : "var(--redBg)",
                        color: d.estado==="PENDIENTE" ? "var(--amber)" : d.estado==="APROBADO" ? "var(--green)" : "var(--red)",
                        border: `1px solid ${d.estado==="PENDIENTE" ? "var(--amberBd)" : d.estado==="APROBADO" ? "var(--greenBd,var(--green))" : "var(--redBd,var(--red))"}`}}>
                        {d.estado}
                      </span>
                      {d.notas && <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{d.notas}</div>}
                    </td>
                    <td style={{whiteSpace:"nowrap"}}>
                      {d.estado === "PENDIENTE" ? (
                        <div style={{display:"flex",gap:4}}>
                          <button onClick={()=>doAprobar(d)} disabled={loading}
                            style={{padding:"4px 8px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}
                            title="Aprobar: actualizar diccionario con nuevo costo">
                            Aprobar
                          </button>
                          <button onClick={()=>doRechazar(d)} disabled={loading}
                            style={{padding:"4px 8px",borderRadius:4,background:"var(--red)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}
                            title="Rechazar: error del proveedor, reclamar">
                            Rechazar
                          </button>
                        </div>
                      ) : (
                        <span style={{fontSize:10,color:"var(--txt3)"}}>{d.resuelto_at ? fmtDate(d.resuelto_at) : ""}</span>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Quantity discrepancy panel */}
        {discrepanciasQty.length > 0 && (
          <div className="card" style={{marginTop:12,border: tieneDiscrepanciasQtyPendientes(discrepanciasQty) ? "2px solid var(--amber)" : "1px solid var(--bg4)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700,color: tieneDiscrepanciasQtyPendientes(discrepanciasQty) ? "var(--amber)" : "var(--green)"}}>
                Discrepancias de cantidad ({discrepanciasQty.filter(d=>d.estado==="PENDIENTE").length} pendientes)
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {tieneDiscrepanciasQtyPendientes(discrepanciasQty) && (
                  <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontWeight:700,border:"1px solid var(--amberBd)"}}>
                    Resolver antes de cerrar
                  </span>
                )}
                <button onClick={async()=>{if(!selRec)return;const d=await recalcularDiscrepanciasQty(selRec.id!,lineas);setDiscrepanciasQty(d);}} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}} title="Recalcular discrepancias de cantidad">
                  Recalcular
                </button>
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th>
                  <th>Tipo</th>
                  <th style={{textAlign:"right"}}>Factura</th>
                  <th style={{textAlign:"right"}}>Recibido</th>
                  <th style={{textAlign:"right"}}>Diferencia</th>
                  <th>Estado</th>
                  <th>Resolución</th>
                </tr></thead>
                <tbody>{discrepanciasQty.map(d => {
                  const tipoLabel: Record<string,string> = { FALTANTE: "Faltante", SOBRANTE: "Sobrante", SKU_ERRONEO: "SKU erróneo", NO_EN_FACTURA: "No en factura" };
                  const tipoColor: Record<string,string> = { FALTANTE: "var(--red)", SOBRANTE: "var(--amber)", SKU_ERRONEO: "var(--red)", NO_EN_FACTURA: "var(--cyan)" };
                  const estadoLabel: Record<string,string> = { PENDIENTE: "Pendiente", ACEPTADO: "Aceptado", RECLAMADO: "Reclamado", NOTA_CREDITO: "Nota crédito", DEVOLUCION: "Devolución", SUSTITUCION: "Sustitución" };
                  const estadoColor: Record<string,string> = { PENDIENTE: "var(--amber)", ACEPTADO: "var(--green)", RECLAMADO: "var(--blue,var(--cyan))", NOTA_CREDITO: "var(--cyan)", DEVOLUCION: "var(--red)", SUSTITUCION: "var(--cyan)" };
                  return (
                  <tr key={d.id} style={{background: d.estado==="PENDIENTE" ? "var(--amberBg)" : "transparent"}}>
                    <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,color:tipoColor[d.tipo]||"var(--txt2)"}}>
                        {tipoLabel[d.tipo]||d.tipo}
                      </span>
                    </td>
                    <td className="mono" style={{textAlign:"right",fontSize:12}}>{d.qty_factura}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700}}>{d.qty_recibida}</td>
                    <td className="mono" style={{textAlign:"right",fontSize:12,fontWeight:700,color:d.diferencia>0?"var(--amber)":"var(--red)"}}>
                      {d.diferencia > 0 ? "+" : ""}{d.diferencia}
                    </td>
                    <td>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,color:estadoColor[d.estado]||"var(--txt2)"}}>
                        {estadoLabel[d.estado]||d.estado}
                      </span>
                      {d.notas && <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{d.notas}</div>}
                    </td>
                    <td style={{whiteSpace:"nowrap"}}>
                      {d.estado === "PENDIENTE" ? (
                        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                          {getResolucionesQty(d.tipo).map(r => (
                            <button key={r.valor} onClick={async()=>{
                              const nota = prompt(`${r.label} — Notas (opcional):`, "");
                              if (nota === null) return;
                              setLoading(true);
                              try {
                                await resolverDiscrepanciaQty(d.id!, r.valor, nota);
                                await refreshDetail();
                              } catch (e: unknown) {
                                console.error("Error resolviendo discrepancia qty:", e);
                                alert(`Error al resolver: ${e instanceof Error ? e.message : e}`);
                              } finally {
                                setLoading(false);
                              }
                            }} disabled={loading}
                              style={{padding:"4px 8px",borderRadius:4,background:r.valor==="ACEPTADO"?"var(--green)":r.valor==="DEVOLUCION"?"var(--red)":"var(--cyan)",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",border:"none"}}>
                              {r.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span style={{fontSize:10,color:"var(--txt3)"}}>{d.resuelto_at ? fmtDate(d.resuelto_at) : ""}{d.resuelto_por ? ` · ${d.resuelto_por}` : ""}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* Error report modal */}
        {errorLinea && (
          <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
            onClick={closeErrorReport}>
            <div style={{width:"100%",maxWidth:420,background:"var(--bg2)",borderRadius:14,border:"1px solid var(--bg4)",overflow:"hidden"}}
              onClick={e=>e.stopPropagation()}>

              {/* Menu */}
              {errorMode === "menu" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:16,fontWeight:800,marginBottom:4,textAlign:"center"}}>Reportar Error</div>
                  <div style={{fontSize:12,color:"var(--txt3)",textAlign:"center",marginBottom:16}}>
                    <span className="mono" style={{fontWeight:700}}>{errorLinea.sku}</span> — {errorLinea.nombre}
                  </div>
                  <button onClick={()=>{setErrorMode("conteo");setErrorQty(errorLinea.qty_factura);}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--bg4)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--amber)"}}>Diferencia en conteo</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>La cantidad real no coincide con la factura</div>
                  </button>
                  <button onClick={()=>{setErrorMode("sku");setErrorSkuSearch("");setErrorSkuResults([]);}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--bg4)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--red)"}}>SKU incorrecto</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>El producto fisico no corresponde al SKU de la factura</div>
                  </button>
                  <button onClick={()=>{setErrorMode("sustitucion");setErrorSkuSearch("");setErrorSkuResults([]);setSustSelected(null);setSustQty(errorLinea?.qty_factura||0);setSustCostoMode("factura");}}
                    style={{width:"100%",padding:"16px 14px",borderRadius:10,background:"var(--bg3)",border:"1px solid var(--cyan)",marginBottom:8,textAlign:"left",cursor:"pointer"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"var(--cyan)"}}>Sustitución de producto</div>
                    <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>El proveedor envió un producto distinto al facturado. Se registran ambos SKUs y se ajustan costos.</div>
                  </button>
                  <button onClick={closeErrorReport}
                    style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    Cancelar
                  </button>
                </div>
              )}

              {/* Ajuste conteo */}
              {errorMode === "conteo" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Ajustar cantidad de factura</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
                    <span className="mono" style={{fontWeight:700}}>{errorLinea.sku}</span> — {errorLinea.nombre}
                  </div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
                    Cantidad actual: <strong style={{color:"var(--amber)"}}>{errorLinea.qty_factura}</strong>
                  </div>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:8}}>Cantidad correcta:</div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:16}}>
                    <button onClick={()=>setErrorQty(q=>Math.max(0,q-1))}
                      style={{width:48,height:48,borderRadius:10,background:"var(--bg3)",fontSize:22,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                    <input type="number" value={errorQty} onFocus={e=>e.target.select()} onChange={e=>setErrorQty(Math.max(0,parseInt(e.target.value)||0))}
                      style={{width:90,textAlign:"center",fontSize:32,fontWeight:700,padding:10,borderRadius:10,background:"var(--bg)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                    <button onClick={()=>setErrorQty(q=>q+1)}
                      style={{width:48,height:48,borderRadius:10,background:"var(--bg3)",fontSize:22,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                  </div>
                  {errorQty !== errorLinea.qty_factura && (
                    <div style={{textAlign:"center",marginBottom:12,padding:"8px 12px",borderRadius:8,
                      background:errorQty > errorLinea.qty_factura ? "var(--greenBg)" : "var(--redBg)",
                      color:errorQty > errorLinea.qty_factura ? "var(--green)" : "var(--red)",
                      fontSize:13,fontWeight:700}}>
                      {errorQty > errorLinea.qty_factura
                        ? `+${errorQty - errorLinea.qty_factura} unidades mas`
                        : `${errorLinea.qty_factura - errorQty} unidades menos`}
                    </div>
                  )}
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setErrorMode("menu")}
                      style={{flex:1,padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                      Atras
                    </button>
                    <button onClick={doErrorAjusteConteo} disabled={errorSaving || errorQty === errorLinea.qty_factura}
                      style={{flex:2,padding:12,borderRadius:8,
                        background:(errorSaving || errorQty === errorLinea.qty_factura) ? "var(--bg3)" : "var(--green)",
                        color:(errorSaving || errorQty === errorLinea.qty_factura) ? "var(--txt3)" : "#fff",
                        fontSize:13,fontWeight:700}}>
                      {errorSaving ? "Guardando..." : "Confirmar ajuste"}
                    </button>
                  </div>
                </div>
              )}

              {/* Cambio SKU */}
              {errorMode === "sku" && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Cambiar SKU</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
                    SKU actual: <strong className="mono" style={{color:"var(--red)"}}>{errorLinea.sku}</strong> — {errorLinea.nombre}
                  </div>
                  <input type="text" className="form-input" value={errorSkuSearch} onChange={e=>handleErrorSkuSearch(e.target.value)}
                    placeholder="Buscar por SKU, nombre o codigo ML..." autoFocus style={{marginBottom:8,fontSize:13}} />
                  <div style={{maxHeight:280,overflowY:"auto",marginBottom:12}}>
                    {errorSkuSearch.trim().length >= 2 && errorSkuResults.length === 0 && (
                      <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
                    )}
                    {errorSkuResults.map(p => (
                      <div key={p.sku} onClick={()=>!errorSaving && doErrorCambioSku(p)}
                        style={{padding:"10px 12px",borderRadius:8,background:"var(--bg3)",border:"1px solid var(--bg4)",
                          marginBottom:4,cursor:"pointer",opacity:p.sku===errorLinea.sku?0.4:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{p.sku}</span>
                          {p.mlCode && <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{p.mlCode}</span>}
                        </div>
                        <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{p.name}</div>
                      </div>
                    ))}
                  </div>
                  <button onClick={()=>setErrorMode("menu")}
                    style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    Atras
                  </button>
                </div>
              )}

              {/* Sustitución de producto */}
              {errorMode === "sustitucion" && errorLinea && (
                <div style={{padding:24}}>
                  <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Sustitución de producto</div>
                  <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
                    Factura: <strong className="mono" style={{color:"var(--red)"}}>{errorLinea.sku}</strong> — {errorLinea.nombre}
                  </div>
                  <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>
                    Qty factura: <strong>{errorLinea.qty_factura}</strong> · Costo unit: <strong>{fmtMoney(errorLinea.costo_unitario||0)}</strong>
                  </div>

                  {/* Step 1: Search substitute product */}
                  {!sustSelected ? (
                    <>
                      <div style={{fontSize:12,fontWeight:700,color:"var(--cyan)",marginBottom:6}}>Producto que llegó realmente:</div>
                      <input type="text" className="form-input" value={errorSkuSearch} onChange={e=>handleErrorSkuSearch(e.target.value)}
                        placeholder="Buscar por SKU, nombre o codigo ML..." autoFocus style={{marginBottom:8,fontSize:13}} />
                      <div style={{maxHeight:220,overflowY:"auto",marginBottom:12}}>
                        {errorSkuSearch.trim().length >= 2 && errorSkuResults.length === 0 && (
                          <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
                        )}
                        {errorSkuResults.map(p => (
                          <div key={p.sku} onClick={()=>{setSustSelected(p);}}
                            style={{padding:"10px 12px",borderRadius:8,background:"var(--bg3)",border:"1px solid var(--bg4)",
                              marginBottom:4,cursor:"pointer",opacity:p.sku===errorLinea.sku?0.4:1}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{p.sku}</span>
                              <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{fmtMoney(p.cost||0)}</span>
                            </div>
                            <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{p.name}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Step 2: Confirm product, quantity, and cost */}
                      <div style={{padding:"10px 12px",borderRadius:8,background:"var(--cyanBg)",border:"1px solid var(--cyanBd)",marginBottom:12}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <span className="mono" style={{fontWeight:700,fontSize:13,color:"var(--cyan)"}}>{sustSelected.sku}</span>
                          <button onClick={()=>setSustSelected(null)} style={{fontSize:10,color:"var(--txt3)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Cambiar</button>
                        </div>
                        <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>{sustSelected.name}</div>
                        <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>Costo diccionario: {fmtMoney(sustSelected.cost||0)}</div>
                      </div>

                      {/* Quantity */}
                      <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Cantidad recibida:</div>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
                        <button onClick={()=>setSustQty(q=>Math.max(1,q-1))}
                          style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                        <input type="number" value={sustQty} onFocus={e=>e.target.select()} onChange={e=>setSustQty(Math.max(1,parseInt(e.target.value)||1))}
                          style={{width:80,textAlign:"center",fontSize:28,fontWeight:700,padding:8,borderRadius:8,background:"var(--bg)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                        <button onClick={()=>setSustQty(q=>q+1)}
                          style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                      </div>

                      {/* Cost mode */}
                      <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Costo unitario del sustituto:</div>
                      <div style={{display:"flex",gap:6,marginBottom:12}}>
                        <button onClick={()=>setSustCostoMode("factura")}
                          style={{flex:1,padding:"10px 8px",borderRadius:8,textAlign:"center",cursor:"pointer",
                            background:sustCostoMode==="factura"?"var(--cyanBg)":"var(--bg3)",
                            border:sustCostoMode==="factura"?"2px solid var(--cyan)":"1px solid var(--bg4)"}}>
                          <div style={{fontSize:12,fontWeight:700,color:sustCostoMode==="factura"?"var(--cyan)":"var(--txt2)"}}>Costo de factura</div>
                          <div className="mono" style={{fontSize:16,fontWeight:800,marginTop:2,color:sustCostoMode==="factura"?"var(--cyan)":"var(--txt3)"}}>{fmtMoney(errorLinea.costo_unitario||0)}</div>
                          <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>Lo que se pagó por unidad</div>
                        </button>
                        <button onClick={()=>setSustCostoMode("diccionario")}
                          style={{flex:1,padding:"10px 8px",borderRadius:8,textAlign:"center",cursor:"pointer",
                            background:sustCostoMode==="diccionario"?"var(--amberBg)":"var(--bg3)",
                            border:sustCostoMode==="diccionario"?"2px solid var(--amber)":"1px solid var(--bg4)"}}>
                          <div style={{fontSize:12,fontWeight:700,color:sustCostoMode==="diccionario"?"var(--amber)":"var(--txt2)"}}>Costo diccionario</div>
                          <div className="mono" style={{fontSize:16,fontWeight:800,marginTop:2,color:sustCostoMode==="diccionario"?"var(--amber)":"var(--txt3)"}}>{fmtMoney(sustSelected.cost||0)}</div>
                          <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>Costo registrado del producto</div>
                        </button>
                      </div>

                      {/* Summary */}
                      <div style={{padding:"10px 12px",borderRadius:8,background:"var(--bg)",border:"1px solid var(--bg4)",marginBottom:12,fontSize:11}}>
                        <div style={{fontWeight:700,marginBottom:4,color:"var(--txt2)"}}>Resumen de sustitución:</div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"var(--red)"}}>Factura ({errorLinea.sku}):</span>
                          <span className="mono">{errorLinea.qty_factura} × {fmtMoney(errorLinea.costo_unitario||0)} = {fmtMoney((errorLinea.qty_factura)*(errorLinea.costo_unitario||0))}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{color:"var(--cyan)"}}>Recibido ({sustSelected.sku}):</span>
                          <span className="mono">{sustQty} × {fmtMoney(sustCostoMode==="factura"?(errorLinea.costo_unitario||0):(sustSelected.cost||0))} = {fmtMoney(sustQty*(sustCostoMode==="factura"?(errorLinea.costo_unitario||0):(sustSelected.cost||0)))}</span>
                        </div>
                        {sustCostoMode==="factura" && (sustSelected.cost||0) !== (errorLinea.costo_unitario||0) && (
                          <div style={{marginTop:4,padding:"4px 8px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:600}}>
                            Nota: el costo diccionario ({fmtMoney(sustSelected.cost||0)}) difiere del costo factura. Se generará discrepancia de costo.
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{setSustSelected(null);setErrorSkuSearch("");setErrorSkuResults([]);}}
                          style={{flex:1,padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
                          Atras
                        </button>
                        <button onClick={doSustitucion} disabled={errorSaving || sustQty <= 0}
                          style={{flex:2,padding:12,borderRadius:8,
                            background:(errorSaving||sustQty<=0)?"var(--bg3)":"var(--cyan)",
                            color:(errorSaving||sustQty<=0)?"var(--txt3)":"#fff",
                            fontSize:13,fontWeight:700,border:"none",cursor:"pointer"}}>
                          {errorSaving ? "Procesando..." : "Confirmar sustitución"}
                        </button>
                      </div>
                    </>
                  )}

                  {/* Back to menu (when searching) */}
                  {!sustSelected && (
                    <button onClick={()=>setErrorMode("menu")}
                      style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)",marginTop:4}}>
                      Atras
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Lines table */}
        <div className="card" style={{marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:13,fontWeight:700}}>Líneas ({lineas.length})</div>
          </div>
          <div style={{overflowX:"auto"}}>
            <table className="tbl">
              <thead><tr><th>SKU</th><th>Producto</th><th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th><th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th><th style={{textAlign:"right"}}>C.Unit</th><th style={{textAlign:"right"}}>Subtotal</th><th>Estado</th>{isEditable&&<th>Acciones</th>}</tr></thead>
              <tbody>{lineas.map(l => {
                const lockInfo = isLineaBloqueada(l, "__admin__");
                const disc = discrepancias.find(d => d.linea_id === l.id && d.estado === "PENDIENTE");
                const discQty = discrepanciasQty.find(d => d.linea_id === l.id && d.estado === "PENDIENTE");
                const isEd = editLineaId === l.id;
                const inputStyle = {width:58,textAlign:"right" as const,padding:"3px 6px",borderRadius:4,border:"1px solid var(--cyan)",background:"var(--bg)",color:"var(--txt1)",fontSize:11,fontFamily:"inherit"};
                if (isEd) return (
                <tr key={l.id} style={{background:"var(--cyanBg, rgba(0,200,255,0.06))"}}>
                  <td className="mono" style={{fontSize:11,fontWeight:700}}>
                    <input style={{...inputStyle,width:90,textAlign:"left"}} value={editLineaData.sku} onChange={e=>setEditLineaData(d=>({...d,sku:e.target.value}))}/>
                  </td>
                  <td style={{fontSize:11}}>
                    <input style={{...inputStyle,width:"100%",textAlign:"left"}} value={editLineaData.nombre} onChange={e=>setEditLineaData(d=>({...d,nombre:e.target.value}))}/>
                  </td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_factura} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_factura:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_recibida} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_recibida:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_etiquetada} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_etiquetada:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" style={inputStyle} value={editLineaData.qty_ubicada} onFocus={e=>e.target.select()} onChange={e=>setEditLineaData(d=>({...d,qty_ubicada:parseInt(e.target.value)||0}))}/></td>
                  <td><input type="number" step="0.01" style={inputStyle} value={editLineaData.costo_unitario} onChange={e=>setEditLineaData(d=>({...d,costo_unitario:parseFloat(e.target.value)||0}))}/></td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,fontWeight:700}}>{editLineaData.costo_unitario?fmtMoney(editLineaData.costo_unitario*editLineaData.qty_factura):"—"}</td>
                  <td>
                    <select style={{padding:"3px 4px",borderRadius:4,border:"1px solid var(--cyan)",background:"var(--bg)",color:"var(--txt1)",fontSize:10,fontWeight:700}} value={editLineaData.estado} onChange={e=>setEditLineaData(d=>({...d,estado:e.target.value}))}>
                      {["PENDIENTE","CONTADA","EN_ETIQUETADO","ETIQUETADA","UBICADA"].map(s=><option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  {isEditable&&<td style={{whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",gap:4}}>
                      <button onClick={saveEditLinea} disabled={loading} style={{padding:"3px 8px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:700,border:"none",cursor:"pointer"}}>Guardar</button>
                      <button onClick={()=>setEditLineaId(null)} style={{padding:"3px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Cancelar</button>
                    </div>
                  </td>}
                </tr>
                );
                return (
                <tr key={l.id} style={{background: (disc||discQty) ? "var(--amberBg)" : l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                  <td className="mono" style={{fontSize:11,fontWeight:700}}>{disc && <span title="Discrepancia de costo pendiente" style={{color:"var(--amber)",marginRight:4}}>$</span>}{discQty && <span title={`Discrepancia de cantidad: ${discQty.tipo}`} style={{color:"var(--red)",marginRight:4}}>#</span>}{l.sku}</td>
                  <td style={{fontSize:11}}>{l.nombre}<br/><span className="mono" style={{fontSize:9,color:"var(--txt3)"}}>{l.codigo_ml||""}</span>
                    {lockInfo.blocked && <span style={{fontSize:10,color:"var(--amber)",fontWeight:600,display:"block"}}>🔒 {lockInfo.by}</span>}
                    {/* SKU venta selector + etiquetado toggle */}
                    {(() => {
                      const ventas = getVentasPorSkuOrigen(l.sku);
                      const uniqueVentas = ventas.filter((v, i, a) => a.findIndex(x => x.skuVenta === v.skuVenta) === i);
                      const skuVentaInfo = l.sku_venta ? ventas.find(v => v.skuVenta === l.sku_venta) : null;
                      const esPack = skuVentaInfo ? skuVentaInfo.unidades > 1 : false;
                      return (
                        <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
                          {/* SKU venta dropdown */}
                          {uniqueVentas.length > 0 && (
                            <select
                              value={l.sku_venta || ""}
                              onChange={async(e)=>{
                                const val = e.target.value;
                                const info = ventas.find(v => v.skuVenta === val);
                                await actualizarLineaRecepcion(l.id!, {
                                  sku_venta: val || undefined,
                                  requiere_etiqueta: !!val,
                                } as Partial<DBRecepcionLinea>);
                                setLineas(await getRecepcionLineas(selRec!.id!));
                              }}
                              style={{fontSize:10,padding:"2px 6px",borderRadius:4,border:"1px solid var(--bg4)",background:"var(--bg)",color:"var(--txt1)",fontWeight:600,maxWidth:160}}>
                              <option value="">Sin SKU venta (sin etiqueta)</option>
                              {uniqueVentas.map(v => (
                                <option key={v.skuVenta} value={v.skuVenta}>
                                  {v.skuVenta} [{v.codigoMl}]{v.unidades > 1 ? ` x${v.unidades}` : ""}
                                </option>
                              ))}
                            </select>
                          )}
                          {/* Etiquetado badge */}
                          {l.requiere_etiqueta ? (
                            l.sku_venta ? (
                              <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,background:l.etiqueta_impresa?"var(--greenBg)":"var(--amberBg)",color:l.etiqueta_impresa?"var(--green)":"var(--amber)"}}>
                                {l.etiqueta_impresa ? "✅" : "⏳"} {l.sku_venta}
                              </span>
                            ) : (
                              <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)"}}>
                                Requiere etiqueta
                              </span>
                            )
                          ) : (
                            <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)"}}>
                              Sin etiqueta
                            </span>
                          )}
                          {esPack && <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:4,background:"var(--cyanBg,var(--bg3))",color:"var(--cyan)"}}>📦 PACK x{skuVentaInfo!.unidades}</span>}
                          {uniqueVentas.length > 1 && <span style={{fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)"}}>{uniqueVentas.length} publicaciones</span>}
                          {/* Toggle etiquetado when no ventas exist */}
                          {uniqueVentas.length === 0 && isEditable && (
                            <button onClick={async()=>{
                              await actualizarLineaRecepcion(l.id!, { requiere_etiqueta: !l.requiere_etiqueta } as Partial<DBRecepcionLinea>);
                              setLineas(await getRecepcionLineas(selRec!.id!));
                            }} style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)",cursor:"pointer",fontWeight:600}}>
                              {l.requiere_etiqueta ? "Quitar etiquetado" : "Agregar etiquetado"}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                  <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                  <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,color:l.costo_unitario?"var(--txt2)":"var(--txt3)"}}>{l.costo_unitario?fmtMoney(l.costo_unitario):"—"}</td>
                  <td className="mono" style={{textAlign:"right",fontSize:11,fontWeight:700,color:l.costo_unitario?"var(--txt1)":"var(--txt3)"}}>{l.costo_unitario?fmtMoney(l.costo_unitario*l.qty_factura):"—"}</td>
                  <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                    background:l.estado==="UBICADA"?"var(--greenBg)":l.estado==="PENDIENTE"?"var(--redBg)":"var(--amberBg)",
                    color:l.estado==="UBICADA"?"var(--green)":l.estado==="PENDIENTE"?"var(--red)":"var(--amber)"}}>{l.estado}</span></td>
                  {isEditable&&<td style={{whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",gap:4}}>
                      {lockInfo.blocked && <button onClick={async()=>{await desbloquearLinea(l.id!);await refreshDetail();}} title="Desbloquear" style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>🔓</button>}
                      {l.estado !== "PENDIENTE" && <button onClick={()=>doResetLinea(l.id!)} title="Resetear a pendiente" style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>Reset</button>}
                      <button onClick={()=>openErrorReport(l)} title="Reportar error (conteo o SKU)" style={{padding:"3px 6px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer"}}>Error</button>
                      <button onClick={()=>startEditLinea(l)} title="Editar linea" style={{padding:"3px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
                      <button onClick={()=>doDeleteLinea(l.id!)} title="Eliminar linea" style={{padding:"3px 6px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer"}}>✕</button>
                    </div>
                  </td>}
                </tr>
                );
              })}</tbody>
            </table>
          </div>
          {/* Add line to existing reception */}
          {isEditable && (
            <div style={{marginTop:12,padding:"10px 12px",borderRadius:8,background:"var(--bg3)"}}>
              <div style={{fontSize:11,fontWeight:600,color:"var(--txt3)",marginBottom:6}}>Agregar línea</div>
              <div style={{display:"flex",gap:6}}>
                <div style={{flex:1,position:"relative"}}>
                  <input className="form-input" value={addSku} onChange={e=>setAddSku(e.target.value)} placeholder="SKU o nombre" onKeyDown={e=>e.key==="Enter"&&doAddLinea()} style={{fontSize:12}}/>
                  {addSuggestions.length > 0 && (
                    <div style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bg3)",borderRadius:6,zIndex:10,maxHeight:120,overflow:"auto"}}>
                      {addSuggestions.map(p => (
                        <div key={p.sku} onClick={()=>setAddSku(p.sku)} style={{padding:"5px 8px",fontSize:11,cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}>
                          <strong>{p.sku}</strong> — {p.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <input type="number" className="form-input" value={addQty} onFocus={e=>e.target.select()} onChange={e=>setAddQty(parseInt(e.target.value)||1)} style={{width:60,textAlign:"center",fontSize:12}}/>
                <button onClick={doAddLinea} style={{padding:"6px 12px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>+</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== CREATE FORM ====================
  if (showCreate) {
    const suggestions = newSku.length >= 2 ? findProduct(newSku).slice(0, 5) : [];
    return (
      <div>
        <button onClick={() => setShowCreate(false)} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>← Cancelar</button>
        <div className="card">
          <div className="card-title">Nueva recepción manual</div>
          <div className="admin-grid-2">
            <div>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Folio factura</label>
              <input className="form-input" value={newFolio} onChange={e=>setNewFolio(e.target.value)} placeholder="Ej: 12345" style={{marginTop:4}}/>
            </div>
            <div>
              <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Proveedor</label>
              <select className="form-select" value={newProv} onChange={e=>setNewProv(e.target.value)} style={{marginTop:4}}>
                <option value="">Seleccionar...</option>
                {getProveedores().map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div style={{marginTop:16}}>
            <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600,display:"block",marginBottom:6}}>Costos de factura</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>Neto</label>
                <input type="number" className="form-input" value={newCostoNeto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setNewCostoNeto(v);setNewIva(Math.round(v*0.19));setNewCostoBruto(Math.round(v*1.19));}}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>IVA (19%)</label>
                <input type="number" className="form-input" value={newIva||""} onChange={e=>setNewIva(parseFloat(e.target.value)||0)}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
              <div>
                <label style={{fontSize:10,color:"var(--txt3)"}}>Bruto</label>
                <input type="number" className="form-input" value={newCostoBruto||""} onChange={e=>{const v=parseFloat(e.target.value)||0;setNewCostoBruto(v);setNewCostoNeto(Math.round(v/1.19));setNewIva(Math.round(v-v/1.19));}}
                  placeholder="$0" style={{marginTop:2,fontSize:12}}/>
              </div>
            </div>
          </div>
          <div style={{marginTop:16}}>
            <label style={{fontSize:11,color:"var(--txt3)",fontWeight:600}}>Agregar producto</label>
            <div style={{display:"flex",gap:6,marginTop:4}}>
              <div style={{flex:1,position:"relative"}}>
                <input className="form-input" value={newSku} onChange={e=>setNewSku(e.target.value)} placeholder="SKU o nombre" onKeyDown={e=>e.key==="Enter"&&addLinea()}/>
                {suggestions.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bg3)",borderRadius:6,zIndex:10,maxHeight:150,overflow:"auto"}}>
                    {suggestions.map(p => (
                      <div key={p.sku} onClick={()=>{setNewSku(p.sku);}} style={{padding:"6px 10px",fontSize:11,cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}>
                        <strong>{p.sku}</strong> — {p.name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input type="number" className="form-input" value={newQty} onFocus={e=>e.target.select()} onChange={e=>setNewQty(parseInt(e.target.value)||1)} style={{width:70,textAlign:"center"}}/>
              <button onClick={addLinea} style={{padding:"8px 14px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>+</button>
            </div>
          </div>
          {newLineas.length > 0 && (
            <div style={{marginTop:12}}>
              {newLineas.map((l, i) => (
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
                  <span><strong>{l.sku}</strong> — {l.nombre}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span className="mono" style={{fontWeight:700}}>{l.cantidad}</span>
                    <button onClick={()=>setNewLineas(nl=>nl.filter((_,j)=>j!==i))} style={{color:"var(--red)",background:"none",border:"none",cursor:"pointer",fontSize:14}}>✕</button>
                  </div>
                </div>
              ))}
              <button onClick={doCreate} disabled={!newFolio||!newProv||loading}
                style={{width:"100%",marginTop:12,padding:12,borderRadius:8,background:"var(--green)",color:"#fff",fontSize:13,fontWeight:700}}>
                {loading ? "Creando..." : `Crear recepción (${newLineas.length} líneas)`}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== LIST VIEW ====================
  // Day view data
  const dayTotal = dayLineas.length;
  const dayUbicadas = dayLineas.filter(l => l.estado === "UBICADA").length;
  const dayProgress = dayTotal > 0 ? Math.round((dayUbicadas / dayTotal) * 100) : 0;

  const dayLineasFiltradas = dayFilter === "pendientes"
    ? dayLineas.filter(l => l.estado !== "UBICADA")
    : dayFilter === "diferencia"
    ? dayLineas.filter(l => l.qty_recibida > 0 && l.qty_recibida !== l.qty_factura)
    : dayLineas;

  const doDesbloquear = async (lineaId: string) => {
    await desbloquearLinea(lineaId);
    await loadRecs();
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div className="card-title" style={{margin:0}}>Recepciones</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadRecs} disabled={loading} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading?"...":"Actualizar"}
          </button>
          <button onClick={()=>setShowCreate(true)} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
            + Nueva recepcion
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div style={{display:"flex",gap:0,marginBottom:12}}>
        <button onClick={()=>setView("dia")}
          style={{padding:"8px 16px",borderRadius:"6px 0 0 6px",fontSize:12,fontWeight:700,cursor:"pointer",
            background:view==="dia"?"var(--cyan)":"var(--bg3)",color:view==="dia"?"#000":"var(--txt2)",
            border:`1px solid ${view==="dia"?"var(--cyan)":"var(--bg4)"}`}}>
          📅 Dia
        </button>
        <button onClick={()=>setView("facturas")}
          style={{padding:"8px 16px",borderRadius:"0 6px 6px 0",fontSize:12,fontWeight:700,cursor:"pointer",
            background:view==="facturas"?"var(--cyan)":"var(--bg3)",color:view==="facturas"?"#000":"var(--txt2)",
            border:`1px solid ${view==="facturas"?"var(--cyan)":"var(--bg4)"}`,borderLeft:"none"}}>
          📄 Facturas
        </button>
      </div>

      {/* ==================== DAY VIEW ==================== */}
      {view === "dia" && (
        <div>
          {/* Global progress bar */}
          <div className="card" style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <span style={{fontSize:14,fontWeight:700}}>Progreso global</span>
              <span style={{fontSize:13,fontWeight:700,color:dayProgress===100?"var(--green)":"var(--blue)"}}>{dayProgress}%</span>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:12,overflow:"hidden"}}>
              <div style={{width:`${dayProgress}%`,height:"100%",background:dayProgress===100?"var(--green)":"var(--blue)",borderRadius:6,transition:"width 0.3s"}}/>
            </div>
            <div style={{fontSize:12,color:"var(--txt3)",marginTop:6}}>{dayUbicadas}/{dayTotal} lineas completadas</div>
          </div>

          {/* Day filter */}
          <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
            {([["todas","Todas"],["pendientes","Pendientes"],["diferencia","Con diferencia"]] as [string,string][]).map(([key,label]) => (
              <button key={key} onClick={()=>setDayFilter(key as typeof dayFilter)}
                style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
                  background:dayFilter===key?"var(--cyan)":"var(--bg3)",color:dayFilter===key?"#000":"var(--txt2)",
                  border:`1px solid ${dayFilter===key?"var(--cyan)":"var(--bg4)"}`}}>
                {label} ({key==="todas"?dayTotal:key==="pendientes"?dayLineas.filter(l=>l.estado!=="UBICADA").length:dayLineas.filter(l=>l.qty_recibida>0&&l.qty_recibida!==l.qty_factura).length})
              </button>
            ))}
          </div>

          {dayLineasFiltradas.length === 0 && !loading && (
            <div className="card" style={{textAlign:"center",padding:32}}>
              <div style={{fontSize:13,color:"var(--txt3)"}}>Sin lineas en esta vista.</div>
            </div>
          )}

          {dayLineasFiltradas.length > 0 && (
            <div style={{overflowX:"auto"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th><th>Producto</th>
                  <th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th>
                  <th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th>
                  <th>Estado</th><th>Operario</th><th></th>
                </tr></thead>
                <tbody>{dayLineasFiltradas.map(l => {
                  const lock = isLineaBloqueada(l, "__admin__");
                  const operarioActual = l.bloqueado_por || l.operario_ubicacion || l.operario_etiquetado || l.operario_conteo || "";
                  return (
                    <tr key={l.id} style={{background:l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                      <td className="mono" style={{fontSize:11,fontWeight:700}}>{l.sku}</td>
                      <td style={{fontSize:11}}>{l.nombre}</td>
                      <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                      <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                      <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                      <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                      <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                        background:l.estado==="UBICADA"?"var(--greenBg)":l.estado==="PENDIENTE"?"var(--redBg)":"var(--amberBg)",
                        color:LINEA_ESTADO_COLORS[l.estado]||"var(--txt3)"}}>{l.estado}</span></td>
                      <td style={{fontSize:11}}>
                        {lock.blocked ? (
                          <span style={{color:"var(--amber)",fontWeight:600}}>🔒 {lock.by}</span>
                        ) : operarioActual ? (
                          <span style={{color:"var(--cyan)"}}>{operarioActual}</span>
                        ) : (
                          <span style={{color:"var(--txt3)"}}>—</span>
                        )}
                      </td>
                      <td>
                        {lock.blocked && (
                          <button onClick={()=>doDesbloquear(l.id!)} title="Desbloquear"
                            style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>
                            🔓
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ==================== FACTURAS VIEW (existing) ==================== */}
      {view === "facturas" && (<>
      {/* Filter tabs */}
      <div style={{display:"flex",gap:4,marginBottom:12,flexWrap:"wrap"}}>
        {(["activas","pausadas","completadas","anuladas","todas"] as RecFilter[]).map(f => (
          <button key={f} onClick={()=>setFilter(f)}
            style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,cursor:"pointer",
              background:filter===f?"var(--cyan)":"var(--bg3)",color:filter===f?"#000":"var(--txt2)",
              border:`1px solid ${filter===f?"var(--cyan)":"var(--bg4)"}`}}>
            {f==="activas"?"Activas":f==="pausadas"?"Pausadas":f==="completadas"?"Completadas":f==="anuladas"?"Anuladas":"Todas"}
            {counts[f]>0&&<span style={{marginLeft:4,opacity:0.7}}>({counts[f]})</span>}
          </button>
        ))}
      </div>

      {filteredRecs.length === 0 && !loading && (
        <div className="card" style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:13,color:"var(--txt3)"}}>Sin recepciones en esta categoria.</div>
        </div>
      )}

      <div className="desktop-only">
        <table className="tbl">
          <thead><tr><th>Folio</th><th>Proveedor</th><th>Fecha</th><th>Estado</th><th>Operarios</th><th></th></tr></thead>
          <tbody>{filteredRecs.map(rec => {
            const m = parseRecepcionMeta(rec.notas||"");
            return (
              <tr key={rec.id} onClick={()=>openRec(rec)} style={{cursor:"pointer",opacity:rec.estado==="ANULADA"?0.6:1}}>
                <td className="mono" style={{fontWeight:700}}>{rec.folio}</td>
                <td>{rec.proveedor}</td>
                <td style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(rec.created_at||"")} {fmtTime(rec.created_at||"")}</td>
                <td><span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{ESTADO_LABELS_A[rec.estado]||rec.estado}</span></td>
                <td style={{fontSize:11,color:m.asignados.length>0?"var(--cyan)":"var(--txt3)"}}>{m.asignados.length>0?m.asignados.join(", "):"Todos"}</td>
                <td><button style={{fontSize:10,padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)"}}>Ver</button></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>

      <div className="mobile-only">
        {filteredRecs.map(rec => {
          const m = parseRecepcionMeta(rec.notas||"");
          return (
            <div key={rec.id} onClick={()=>openRec(rec)} style={{padding:12,marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer",opacity:rec.estado==="ANULADA"?0.6:1}}>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <div style={{fontWeight:700,fontSize:13}}>{rec.proveedor}</div>
                <span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{ESTADO_LABELS_A[rec.estado]||rec.estado}</span>
              </div>
              <div style={{fontSize:11,color:"var(--txt3)"}}>Folio: {rec.folio} · {fmtDate(rec.created_at||"")}</div>
              {m.asignados.length > 0 && <div style={{fontSize:10,color:"var(--cyan)",marginTop:2}}>Asignado: {m.asignados.join(", ")}</div>}
            </div>
          );
        })}
      </div>
      </>)}
    </div>
  );
}

// ==================== OPERACIONES RÁPIDAS ====================
// ==================== ADMIN PICKING FLEX ====================
function AdminPicking({ refresh }: { refresh: () => void }) {
  const [sessions, setSessions] = useState<DBPickingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selSession, setSelSession] = useState<DBPickingSession | null>(null);

  const loadSessions = async () => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const active = await getActivePickings();
    const todaySessions = await getPickingsByDate(today);
    // Merge unique
    const map = new Map<string, DBPickingSession>();
    [...active, ...todaySessions].forEach(s => { if (s.id) map.set(s.id, s); });
    setSessions(Array.from(map.values()).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")));
    setLoading(false);
  };

  useEffect(() => { loadSessions(); }, []);

  if (selSession) {
    return <PickingSessionDetail session={selSession} onBack={() => { setSelSession(null); loadSessions(); }}/>;
  }

  if (showCreate) {
    return <CreatePickingSession onCreated={() => { setShowCreate(false); loadSessions(); }} onCancel={() => setShowCreate(false)}/>;
  }

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>Picking Flex</h2>
          <p style={{fontSize:12,color:"var(--txt3)",margin:0}}>Sesiones de picking diario para envíos Flex</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadSessions} disabled={loading} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading ? "..." : "🔄"}
          </button>
          <button onClick={() => setShowCreate(true)} style={{padding:"8px 18px",borderRadius:8,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none"}}>
            + Nueva sesión
          </button>
        </div>
      </div>

      {sessions.length === 0 && !loading && (
        <div style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:8}}>🏷️</div>
          <div style={{fontSize:14,fontWeight:600}}>No hay sesiones de picking</div>
          <div style={{fontSize:12,marginTop:4}}>Crea una nueva para el picking del día</div>
        </div>
      )}

      {sessions.map(sess => {
        const totalComps = sess.lineas.reduce((s, l) => s + l.componentes.length, 0);
        const doneComps = sess.lineas.reduce((s, l) => s + l.componentes.filter(c => c.estado === "PICKEADO").length, 0);
        const pct = totalComps > 0 ? Math.round((doneComps / totalComps) * 100) : 0;
        const totalUnits = sess.lineas.reduce((s, l) => s + l.componentes.reduce((s2, c) => s2 + c.unidades, 0), 0);

        return (
          <div key={sess.id} onClick={() => setSelSession(sess)}
            style={{padding:16,marginBottom:8,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>Picking {sess.fecha}</div>
                <div style={{fontSize:12,color:"var(--txt3)"}}>{sess.lineas.length} pedidos · {totalUnits} unidades · {doneComps}/{totalComps} items</div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,fontSize:10,fontWeight:700,
                background: pct === 100 ? "var(--greenBg)" : pct > 0 ? "var(--amberBg)" : "var(--redBg)",
                color: pct === 100 ? "var(--green)" : pct > 0 ? "var(--amber)" : "var(--red)"}}>
                {sess.estado === "COMPLETADA" ? "✅ COMPLETADA" : pct > 0 ? `${pct}%` : "PENDIENTE"}
              </div>
            </div>
            <div style={{marginTop:8,background:"var(--bg3)",borderRadius:4,height:4,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background:pct===100?"var(--green)":"var(--amber)",borderRadius:4}}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== CREATE PICKING SESSION ====================
// ==================== PRODUCT SEARCH FOR PICKING ====================
function PickingProductSearch({ onAdd }: { onAdd: (skuVenta: string, qty: number) => void }) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState(1);
  const [results, setResults] = useState<{ skuVenta: string; codigoMl: string; nombre: string; componentes: { skuVenta: string; codigoMl: string; skuOrigen: string; unidades: number }[] }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.length >= 2) {
      setResults(findSkuVenta(q));
    } else {
      setResults([]);
    }
  }, [q]);

  const handleAdd = (skuVenta: string) => {
    onAdd(skuVenta, qty);
    setQ("");
    setQty(1);
    setResults([]);
    inputRef.current?.focus();
  };

  return (
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input ref={inputRef} className="form-input" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Buscar producto por nombre o SKU..."
          style={{flex:1,fontSize:13,padding:10}}/>
        <div style={{display:"flex",alignItems:"center",gap:4,background:"var(--bg3)",borderRadius:8,padding:"0 8px",border:"1px solid var(--bg4)"}}>
          <button onClick={() => setQty(Math.max(1, qty - 1))}
            style={{width:24,height:24,borderRadius:4,background:"var(--bg4)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"22px"}}>−</button>
          <span className="mono" style={{fontSize:14,fontWeight:700,color:"var(--blue)",minWidth:24,textAlign:"center"}}>{qty}</span>
          <button onClick={() => setQty(qty + 1)}
            style={{width:24,height:24,borderRadius:4,background:"var(--bg4)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"22px"}}>+</button>
        </div>
      </div>

      {results.length > 0 && (
        <div style={{maxHeight:250,overflow:"auto",borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg)"}}>
          {results.map(r => (
            <button key={r.skuVenta} onClick={() => handleAdd(r.skuVenta)}
              style={{width:"100%",textAlign:"left",padding:"10px 12px",border:"none",borderBottom:"1px solid var(--bg3)",
                background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.nombre}</div>
                <div style={{fontSize:11,color:"var(--txt3)",display:"flex",gap:8}}>
                  <span className="mono">{r.skuVenta}</span>
                  {r.componentes.length > 1 && <span>({r.componentes.length} componentes)</span>}
                </div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,background:"var(--greenBg)",color:"var(--green)",fontSize:11,fontWeight:700,flexShrink:0}}>
                + {qty}
              </div>
            </button>
          ))}
        </div>
      )}

      {q.length >= 2 && results.length === 0 && (
        <div style={{textAlign:"center",padding:12,color:"var(--txt3)",fontSize:12}}>
          Sin resultados para &quot;{q}&quot;
        </div>
      )}
    </div>
  );
}

function CreatePickingSession({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [raw, setRaw] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<{ lineas: PickingLinea[]; errors: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputMode, setInputMode] = useState<"search" | "text">("search");
  const [searchOrders, setSearchOrders] = useState<{ skuVenta: string; qty: number; nombre: string }[]>([]);

  const parseOrders = () => {
    let orders: { skuVenta: string; qty: number }[] = [];

    if (inputMode === "text") {
      const lines = raw.trim().split("\n").filter(l => l.trim());
      for (const line of lines) {
        const parts = line.trim().split(/[\s,;\t]+/);
        const sku = parts[0]?.trim();
        const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
        if (sku) orders.push({ skuVenta: sku, qty });
      }
    } else {
      orders = searchOrders.map(o => ({ skuVenta: o.skuVenta, qty: o.qty }));
    }

    const result = buildPickingLineas(orders);
    setPreview(result);
  };

  const handleSearchAdd = (skuVenta: string, qty: number) => {
    // If already in list, increment qty
    const existing = searchOrders.find(o => o.skuVenta === skuVenta);
    if (existing) {
      setSearchOrders(searchOrders.map(o => o.skuVenta === skuVenta ? { ...o, qty: o.qty + qty } : o));
    } else {
      const found = findSkuVenta(skuVenta);
      const nombre = found.find(f => f.skuVenta === skuVenta)?.nombre || skuVenta;
      setSearchOrders([...searchOrders, { skuVenta, qty, nombre }]);
    }
    setPreview(null);
  };

  const removeSearchOrder = (skuVenta: string) => {
    setSearchOrders(searchOrders.filter(o => o.skuVenta !== skuVenta));
    setPreview(null);
  };

  const updateSearchOrderQty = (skuVenta: string, newQty: number) => {
    if (newQty < 1) return;
    setSearchOrders(searchOrders.map(o => o.skuVenta === skuVenta ? { ...o, qty: newQty } : o));
    setPreview(null);
  };

  const doCreate = async () => {
    if (!preview || preview.lineas.length === 0) return;
    setSaving(true);
    const id = await crearPickingSession(fecha, preview.lineas);
    setSaving(false);
    if (id) {
      onCreated();
    } else {
      alert("Error al crear la sesión de picking. Verificar que la tabla picking_sessions tenga las columnas 'tipo' y 'titulo' (ejecutar migración v10).");
    }
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h2 style={{fontSize:18,fontWeight:700,margin:0}}>Nueva sesión de picking</h2>
        <button onClick={onCancel} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Left: Input */}
        <div>
          <div style={{marginBottom:12}}>
            <label style={{fontSize:12,fontWeight:600,color:"var(--txt3)",display:"block",marginBottom:4}}>Fecha de picking</label>
            <input type="date" className="form-input" value={fecha} onChange={e => setFecha(e.target.value)} style={{fontSize:14,padding:10}}/>
          </div>

          {/* Mode toggle */}
          <div style={{display:"flex",gap:4,marginBottom:12,background:"var(--bg3)",borderRadius:8,padding:3}}>
            <button onClick={() => setInputMode("search")}
              style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
                background:inputMode==="search"?"var(--blue)":"transparent",
                color:inputMode==="search"?"#fff":"var(--txt3)"}}>
              Buscar producto
            </button>
            <button onClick={() => setInputMode("text")}
              style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
                background:inputMode==="text"?"var(--blue)":"transparent",
                color:inputMode==="text"?"#fff":"var(--txt3)"}}>
              Pegar texto
            </button>
          </div>

          {inputMode === "search" ? (
            <div>
              <PickingProductSearch onAdd={handleSearchAdd}/>

              {/* Search orders list */}
              {searchOrders.length > 0 && (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--txt3)",marginBottom:6}}>Pedidos agregados ({searchOrders.length}):</div>
                  <div style={{maxHeight:300,overflow:"auto"}}>
                    {searchOrders.map(o => (
                      <div key={o.skuVenta} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",marginBottom:4,
                        borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)"}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.nombre}</div>
                          <div className="mono" style={{fontSize:11,color:"var(--txt3)"}}>{o.skuVenta}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <button onClick={() => updateSearchOrderQty(o.skuVenta, o.qty - 1)}
                            style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>−</button>
                          <span className="mono" style={{fontSize:13,fontWeight:700,color:"var(--blue)",minWidth:20,textAlign:"center"}}>{o.qty}</span>
                          <button onClick={() => updateSearchOrderQty(o.skuVenta, o.qty + 1)}
                            style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>+</button>
                        </div>
                        <button onClick={() => removeSearchOrder(o.skuVenta)}
                          style={{width:22,height:22,borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"20px"}}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={parseOrders} disabled={searchOrders.length === 0}
                style={{width:"100%",padding:12,borderRadius:8,background:"var(--blue)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:searchOrders.length===0?0.4:1}}>
                Vista previa
              </button>
            </div>
          ) : (
            <div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:12,fontWeight:600,color:"var(--txt3)",display:"block",marginBottom:4}}>
                  Pedidos (SKU Venta + Cantidad, uno por línea)
                </label>
                <textarea className="form-input mono" value={raw} onChange={e => setRaw(e.target.value)}
                  placeholder={"TXV23QLAT25BE 1\nSAB180BL-PK2 2\nJUE2PCAM15GR 1"}
                  rows={12} style={{fontSize:12,lineHeight:1.6,resize:"vertical"}}/>
                <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>
                  Formato: <code>SKU_VENTA CANTIDAD</code> — Si no pones cantidad, asume 1.<br/>
                  Separadores válidos: espacio, tab, coma, punto y coma.
                </div>
              </div>

              <button onClick={parseOrders}
                style={{width:"100%",padding:12,borderRadius:8,background:"var(--blue)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer"}}>
                Vista previa
              </button>
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div>
          {!preview && (
            <div style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
              <div style={{fontSize:32,marginBottom:8}}>{inputMode === "search" ? "🔍" : "👈"}</div>
              <div style={{fontSize:13}}>{inputMode === "search" ? "Busca productos y agrégalos a la lista" : "Pega los pedidos y haz clic en \"Vista previa\""}</div>
            </div>
          )}

          {preview && (
            <div>
              <div style={{marginBottom:12,display:"flex",gap:12}}>
                <div style={{padding:"8px 14px",borderRadius:8,background:"var(--greenBg)",color:"var(--green)",fontSize:13,fontWeight:700}}>
                  {preview.lineas.length} pedidos OK
                </div>
                {preview.errors.length > 0 && (
                  <div style={{padding:"8px 14px",borderRadius:8,background:"var(--amberBg)",color:"var(--amber)",fontSize:13,fontWeight:700}}>
                    {preview.errors.length} advertencias
                  </div>
                )}
              </div>

              {/* Errors */}
              {preview.errors.length > 0 && (
                <div style={{padding:12,background:"var(--amberBg)",borderRadius:8,marginBottom:12,maxHeight:150,overflow:"auto"}}>
                  {preview.errors.map((e, i) => (
                    <div key={i} style={{fontSize:11,color:"var(--amber)",padding:"2px 0"}}>{e}</div>
                  ))}
                </div>
              )}

              {/* Lines */}
              <div style={{maxHeight:400,overflow:"auto"}}>
                {preview.lineas.map(linea => (
                  <div key={linea.id} style={{padding:10,marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span className="mono" style={{fontWeight:700,fontSize:12}}>{linea.skuVenta}</span>
                      <span style={{fontSize:11,color:"var(--txt3)"}}>×{linea.qtyPedida}</span>
                    </div>
                    {linea.componentes.map((comp, ci) => (
                      <div key={ci} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",color:"var(--txt2)"}}>
                        <span>{comp.nombre?.slice(0, 35) || comp.skuOrigen}</span>
                        <span>
                          <strong style={{color:"var(--green)"}}>{comp.posicion}</strong>
                          {" · "}{comp.unidades} uds
                          {comp.stockDisponible < comp.unidades && <span style={{color:"var(--red)"}}> bajo stock</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {preview.lineas.length > 0 && (
                <button onClick={doCreate} disabled={saving}
                  style={{width:"100%",marginTop:12,padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:saving?0.6:1}}>
                  {saving ? "Creando..." : `Crear sesión — ${preview.lineas.length} pedidos`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== PICKING SESSION DETAIL ====================
function PickingSessionDetail({ session: initialSession, onBack }: { session: DBPickingSession; onBack: () => void }) {
  const [session, setSession] = useState<DBPickingSession>(initialSession);
  const [editing, setEditing] = useState(false);
  const [addRaw, setAddRaw] = useState("");
  const [addMode, setAddMode] = useState<"search" | "text">("search");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  const isFull = session.tipo === "envio_full";
  const totalComps = session.lineas.reduce((s, l) => s + l.componentes.length, 0);
  const doneComps = session.lineas.reduce((s, l) => s + l.componentes.filter(c => c.estado === "PICKEADO").length, 0);
  const pct = totalComps > 0 ? Math.round((doneComps / totalComps) * 100) : 0;

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const doDelete = async () => {
    if (!confirm("¿Eliminar esta sesión de picking completa?")) return;
    await eliminarPicking(session.id!);
    onBack();
  };

  // Remove a single line
  const removeLine = async (lineaId: string) => {
    const linea = session.lineas.find(l => l.id === lineaId);
    if (linea?.estado === "PICKEADO") {
      if (!confirm("Esta línea ya fue pickeada. ¿Eliminar de todas formas? (no revierte el stock)")) return;
    }
    const newLineas = session.lineas.filter(l => l.id !== lineaId);
    setSaving(true);
    const allDone = newLineas.length > 0 && newLineas.every(l => l.estado === "PICKEADO");
    await actualizarPicking(session.id!, {
      lineas: newLineas,
      estado: newLineas.length === 0 ? "ABIERTA" : allDone ? "COMPLETADA" : session.estado,
    });
    setSession({ ...session, lineas: newLineas });
    setSaving(false);
    showToast(`Línea ${lineaId} eliminada`);
  };

  // Change quantity of a pending line
  const changeQty = async (lineaId: string, newQty: number) => {
    if (newQty < 1) return;
    const newLineas = session.lineas.map(l => {
      if (l.id !== lineaId) return l;
      if (l.estado === "PICKEADO") return l; // can't change picked
      // Rebuild components with new qty
      const result = buildPickingLineas([{ skuVenta: l.skuVenta, qty: newQty }]);
      if (result.lineas.length === 0) return l;
      return { ...result.lineas[0], id: l.id };
    });
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: newLineas });
    setSession({ ...session, lineas: newLineas });
    setSaving(false);
    showToast("Cantidad actualizada");
  };

  // Add new lines from text input
  const addLines = async () => {
    const lines = addRaw.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return;

    const orders: { skuVenta: string; qty: number }[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/[\s,;\t]+/);
      const sku = parts[0]?.trim();
      const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
      if (sku) orders.push({ skuVenta: sku, qty });
    }

    const result = buildPickingLineas(orders);
    if (result.lineas.length === 0) {
      showToast("No se pudo agregar ninguna línea");
      return;
    }

    // Re-number new lines to continue from existing
    const maxNum = session.lineas.reduce((max, l) => {
      const n = parseInt(l.id.replace("P", "")) || 0;
      return Math.max(max, n);
    }, 0);
    const newLineas = result.lineas.map((l, i) => ({ ...l, id: `P${String(maxNum + i + 1).padStart(3, "0")}` }));

    const allLineas = [...session.lineas, ...newLineas];
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: allLineas, estado: "ABIERTA" });
    setSession({ ...session, lineas: allLineas, estado: "ABIERTA" });
    setSaving(false);
    setAddRaw("");
    setEditing(false);
    showToast(`+${newLineas.length} pedidos agregados`);

    if (result.errors.length > 0) {
      alert("Advertencias:\n" + result.errors.join("\n"));
    }
  };

  return (
    <div>
      {toast && (
        <div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
          border:"2px solid var(--green)",color:"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:13,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
          {toast}
        </div>
      )}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <button onClick={onBack} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>← Volver</button>
        <div style={{display:"flex",gap:6}}>
          <button onClick={() => setEditing(!editing)} style={{padding:"6px 14px",borderRadius:6,background:editing?"var(--amberBg)":"var(--bg3)",color:editing?"var(--amber)":"var(--cyan)",fontSize:11,fontWeight:600,border:`1px solid ${editing?"var(--amber)33":"var(--bg4)"}`}}>
            {editing ? "✕ Cerrar edición" : "✏️ Editar"}
          </button>
          <button onClick={doDelete} style={{padding:"6px 14px",borderRadius:6,background:"var(--redBg)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--red)33"}}>Eliminar</button>
        </div>
      </div>

      {/* Header */}
      <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:16,fontWeight:700}}>{isFull ? (session.titulo || "Envío a Full") : `Picking ${session.fecha}`}</div>
          {isFull && <span style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:800,background:"#3b82f622",color:"#3b82f6",border:"1px solid #3b82f644"}}>FULL</span>}
        </div>
        <div style={{fontSize:12,color:"var(--txt3)"}}>Estado: <strong>{session.estado}</strong> · {session.lineas.length} {isFull ? "productos" : "pedidos"} · {doneComps}/{totalComps} items ({pct}%)</div>
        <div style={{marginTop:8,background:"var(--bg3)",borderRadius:4,height:6,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:pct===100?"var(--green)":"var(--amber)",borderRadius:4}}/>
        </div>
      </div>

      {/* Add lines panel */}
      {editing && (
        <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"2px solid var(--cyan)33",marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700,color:"var(--cyan)",marginBottom:8}}>➕ Agregar pedidos</div>

          {/* Mode toggle */}
          <div style={{display:"flex",gap:4,marginBottom:12,background:"var(--bg3)",borderRadius:8,padding:3}}>
            <button onClick={() => setAddMode("search")}
              style={{flex:1,padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
                background:addMode==="search"?"var(--blue)":"transparent",
                color:addMode==="search"?"#fff":"var(--txt3)"}}>
              Buscar producto
            </button>
            <button onClick={() => setAddMode("text")}
              style={{flex:1,padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
                background:addMode==="text"?"var(--blue)":"transparent",
                color:addMode==="text"?"#fff":"var(--txt3)"}}>
              Pegar texto
            </button>
          </div>

          {addMode === "search" ? (
            <PickingProductSearch onAdd={(skuVenta, qty) => {
              const found = findSkuVenta(skuVenta);
              const nombre = found.find(f => f.skuVenta === skuVenta)?.nombre || skuVenta;
              // Add directly via addLines logic
              const result = buildPickingLineas([{ skuVenta, qty }]);
              if (result.lineas.length === 0) {
                showToast("Producto no encontrado en diccionario");
                return;
              }
              // Re-number
              const maxNum = session.lineas.reduce((max, l) => {
                const n = parseInt(l.id.replace("P", "")) || 0;
                return Math.max(max, n);
              }, 0);
              const newLineas = result.lineas.map((l, i) => ({ ...l, id: `P${String(maxNum + i + 1).padStart(3, "0")}` }));
              const allLineas = [...session.lineas, ...newLineas];
              setSaving(true);
              actualizarPicking(session.id!, { lineas: allLineas, estado: "ABIERTA" }).then(() => {
                setSession({ ...session, lineas: allLineas, estado: "ABIERTA" });
                setSaving(false);
                showToast(`+ ${qty}× ${nombre}`);
                if (result.errors.length > 0) {
                  alert("Advertencias:\n" + result.errors.join("\n"));
                }
              });
            }}/>
          ) : (
            <>
              <textarea className="form-input mono" value={addRaw} onChange={e => setAddRaw(e.target.value)}
                placeholder={"TXV23QLAT25BE 1\nSAB180BL-PK2 2"} rows={4}
                style={{fontSize:12,lineHeight:1.6,resize:"vertical",marginBottom:8}}/>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addLines} disabled={saving || !addRaw.trim()}
                  style={{padding:"8px 18px",borderRadius:8,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",opacity:(!addRaw.trim()||saving)?0.4:1}}>
                  {saving ? "Guardando..." : "Agregar"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Lines table */}
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{borderBottom:"2px solid var(--bg3)"}}>
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>SKU Venta</th>
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>Componente</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Pos</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Qty</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Estado</th>
            {isFull && <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Armado</th>}
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>Operario</th>
            {editing && <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)",width:80}}>Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {session.lineas.map(linea => {
            const isPicked = linea.estado === "PICKEADO";
            return linea.componentes.map((comp, ci) => (
              <tr key={linea.id + "-" + ci} style={{borderBottom:"1px solid var(--bg3)",background:comp.estado==="PICKEADO"?"var(--greenBg)":"transparent"}}>
                {ci === 0 && (
                  <td rowSpan={linea.componentes.length} className="mono" style={{padding:"8px 6px",fontWeight:700,verticalAlign:"top"}}>
                    {linea.skuVenta}
                    {isFull && linea.tipoFull && linea.tipoFull !== "simple" && (
                      <span style={{display:"block",fontSize:9,fontWeight:700,color:"var(--amber)",marginTop:2}}>
                        {linea.tipoFull === "pack" ? `PACK x${linea.unidadesPorPack}` : "COMBO"}
                      </span>
                    )}
                    <br/>
                    {editing && !isPicked && !isFull ? (
                      <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
                        <button onClick={() => changeQty(linea.id, linea.qtyPedida - 1)} disabled={linea.qtyPedida <= 1 || saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>−</button>
                        <span style={{fontSize:13,fontWeight:700,color:"var(--blue)",minWidth:20,textAlign:"center"}}>{linea.qtyPedida}</span>
                        <button onClick={() => changeQty(linea.id, linea.qtyPedida + 1)} disabled={saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>+</button>
                      </div>
                    ) : (
                      <span style={{fontSize:10,color:"var(--txt3)"}}>×{linea.qtyPedida}{isFull && linea.qtyVenta !== undefined && linea.qtyVenta !== linea.qtyPedida ? ` (${linea.qtyVenta} venta)` : ""}</span>
                    )}
                  </td>
                )}
                <td style={{padding:"8px 6px"}}>{comp.nombre?.slice(0, 30) || comp.skuOrigen}</td>
                <td style={{textAlign:"center",padding:"8px 6px"}}><span className="mono" style={{fontWeight:700,color:"var(--green)"}}>{comp.posicion}</span></td>
                <td style={{textAlign:"center",padding:"8px 6px"}} className="mono">{comp.unidades}</td>
                <td style={{textAlign:"center",padding:"8px 6px"}}>
                  <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,
                    background:comp.estado==="PICKEADO"?"var(--greenBg)":"var(--amberBg)",
                    color:comp.estado==="PICKEADO"?"var(--green)":"var(--amber)"}}>
                    {comp.estado === "PICKEADO" ? "✅" : "⏳"}
                  </span>
                </td>
                {isFull && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{textAlign:"center",padding:"8px 6px",verticalAlign:"top"}}>
                    {linea.estadoArmado === null || linea.estadoArmado === undefined ? (
                      <span style={{fontSize:10,color:"var(--txt3)"}}>—</span>
                    ) : (
                      <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,
                        background:linea.estadoArmado==="COMPLETADO"?"var(--greenBg)":"var(--amberBg)",
                        color:linea.estadoArmado==="COMPLETADO"?"var(--green)":"var(--amber)"}}>
                        {linea.estadoArmado === "COMPLETADO" ? "✅" : "⏳"}
                      </span>
                    )}
                  </td>
                )}
                <td style={{padding:"8px 6px",fontSize:11,color:"var(--txt3)"}}>{comp.operario || "—"}</td>
                {editing && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{textAlign:"center",padding:"8px 6px",verticalAlign:"top"}}>
                    <button onClick={() => removeLine(linea.id)} disabled={saving}
                      style={{padding:"4px 10px",borderRadius:6,background:"var(--redBg)",color:"var(--red)",fontSize:11,fontWeight:700,border:"1px solid var(--red)33",cursor:"pointer"}}>
                      🗑️
                    </button>
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>

      {isFull && session.lineas.length > 0 && (
        <div style={{padding:12,background:"var(--bg2)",borderRadius:8,border:"1px solid var(--bg3)",marginTop:12,fontSize:12,color:"var(--txt3)"}}>
          <strong>Resumen:</strong> {session.lineas.length} SKUs · {session.lineas.reduce((s, l) => s + (l.qtyFisica || l.qtyPedida), 0)} uds físicas · {new Set(session.lineas.map(l => l.skuVenta)).size} SKUs Venta
        </div>
      )}

      {session.lineas.length === 0 && (
        <div style={{textAlign:"center",padding:24,color:"var(--txt3)",fontSize:13}}>
          Sin pedidos. Usa el botón &quot;Editar&quot; para agregar.
        </div>
      )}
    </div>
  );
}

// ==================== ADMIN ETIQUETAS ====================
function AdminEtiquetas() {
  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<{ code: string; name: string; sku: string; qty: number }[]>([]);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<"manual"|"recepcion">("manual");
  const [toast, setToast] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const s = getStore();
  const results = q.length >= 2 ? findProduct(q).slice(0, 10) : [];

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  // Get the ML barcode code for a product (the code on the label like YJIH30730)
  const getMLCode = (sku: string): string => {
    const prod = s.products[sku];
    if (!prod) return "";
    // Check composicion_venta for this SKU as skuOrigen
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.length > 0 && ventas[0].codigoMl) return ventas[0].codigoMl;
    if (prod.mlCode) return prod.mlCode;
    return "";
  };

  const getSkuVenta = (sku: string): string => {
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.length > 0 && ventas[0].skuVenta) return ventas[0].skuVenta;
    return sku;
  };

  const addToQueue = (sku: string, qty: number = 1) => {
    const prod = s.products[sku];
    if (!prod) return;
    const code = getMLCode(sku);
    const skuV = getSkuVenta(sku);
    const existing = queue.find(i => i.code === (code || sku) && i.sku === skuV);
    if (existing) {
      setQueue(queue.map(i => i === existing ? { ...i, qty: i.qty + qty } : i));
    } else {
      setQueue([...queue, { code: code || sku, name: prod.name, sku: skuV, qty }]);
    }
    showToast(`+${qty} ${prod.name.slice(0, 30)}`);
  };

  // Load from a recepcion
  const loadFromRecepcion = async () => {
    const recs = await getRecepciones();
    const active = recs.filter(r => r.estado !== "CERRADA");
    if (active.length === 0) { alert("No hay recepciones activas"); return; }
    const rec = active[0]; // latest
    const lineas = await getRecepcionLineas(rec.id!);
    const newQueue: typeof queue = [];
    for (const l of lineas) {
      const prod = s.products[l.sku];
      if (!prod) continue;
      const code = getMLCode(l.sku);
      const skuV = getSkuVenta(l.sku);
      const qty = l.qty_recibida || l.qty_factura || 0;
      if (qty > 0) {
        newQueue.push({ code: code || l.sku, name: prod.name, sku: skuV, qty });
      }
    }
    setQueue(newQueue);
    showToast(`Cargado ${newQueue.length} productos de ${rec.proveedor}`);
  };

  const totalLabels = queue.reduce((s, i) => s + i.qty, 0);

  const generateBarcode = (code: string): string => {
    try {
      const canvas = document.createElement("canvas");
      const JsBarcode = (window as any).JsBarcode;
      if (!JsBarcode) return "";
      JsBarcode(canvas, code, { format: "CODE128", width: 2.5, height: 80, displayValue: false, margin: 2 });
      return canvas.toDataURL("image/png");
    } catch { return ""; }
  };

  // Load JsBarcode on mount
  useEffect(() => {
    if (typeof window !== "undefined" && !(window as any).JsBarcode) {
      import("jsbarcode").then(mod => { (window as any).JsBarcode = mod.default || mod; });
    }
  }, []);

  const generatePDF = async (item: typeof queue[0]) => {
    // @ts-ignore
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [40, 60] });
    const barcodeImg = generateBarcode(item.code);
    if (barcodeImg) doc.addImage(barcodeImg, "PNG", 3, 2, 54, 16);
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text(item.code, 30, 22, { align: "center" });
    doc.setFontSize(6);
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(item.name, 54);
    doc.text(lines.slice(0, 3), 30, 26, { align: "center" });
    if (item.sku) {
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.text(`Cod. Universal: ${item.sku}`, 30, 37, { align: "center" });
    }
    return doc;
  };

  const downloadSingle = async (item: typeof queue[0]) => {
    const doc = await generatePDF(item);
    const safeName = item.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s-]/g, "").slice(0, 80).trim();
    doc.save(`${safeName}.pdf`);
  };

  const downloadAllZip = async () => {
    if (queue.length === 0) return;
    setGenerating(true);
    setProgress(0);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let count = 0;
      const total = queue.reduce((s, i) => s + i.qty, 0);
      for (const item of queue) {
        for (let c = 0; c < item.qty; c++) {
          const doc = await generatePDF(item);
          const blob = doc.output("blob");
          const safeName = item.name.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s-]/g, "").slice(0, 80).trim();
          const suffix = item.qty > 1 ? `_${c + 1}` : "";
          zip.file(`${safeName}${suffix}.pdf`, blob);
          count++;
          setProgress(Math.round((count / total) * 100));
        }
      }
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url; a.download = "etiquetas.zip"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert("Error generando etiquetas: " + e); }
    setGenerating(false);
  };

  const downloadAllSinglePDF = async () => {
    if (queue.length === 0) return;
    setGenerating(true);
    setProgress(0);
    try {
      // @ts-ignore
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [40, 60] });
      let pageIdx = 0;
      const total = queue.reduce((s, i) => s + i.qty, 0);
      let count = 0;
      for (const item of queue) {
        for (let c = 0; c < item.qty; c++) {
          if (pageIdx > 0) doc.addPage([60, 40], "landscape");
          const barcodeImg = generateBarcode(item.code);
          if (barcodeImg) doc.addImage(barcodeImg, "PNG", 3, 2, 54, 16);
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          doc.text(item.code, 30, 22, { align: "center" });
          doc.setFontSize(6);
          doc.setFont("helvetica", "normal");
          const lines = doc.splitTextToSize(item.name, 54);
          doc.text(lines.slice(0, 3), 30, 26, { align: "center" });
          if (item.sku) {
            doc.setFontSize(8);
            doc.setFont("helvetica", "bold");
            doc.text(`Cod. Universal: ${item.sku}`, 30, 37, { align: "center" });
          }
          pageIdx++;
          count++;
          setProgress(Math.round((count / total) * 100));
        }
      }
      doc.save("etiquetas.pdf");
    } catch (e) { alert("Error: " + e); }
    setGenerating(false);
  };

  return (
    <div>
      {toast && (
        <div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
          border:"2px solid var(--green)",color:"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:13,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
          {toast}
        </div>
      )}
      <canvas ref={canvasRef} style={{display:"none"}}/>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>🖨️ Etiquetas</h2>
          <p style={{fontSize:12,color:"var(--txt3)",margin:0}}>Genera etiquetas con código de barras para tus productos</p>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={loadFromRecepcion} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            📦 Cargar de recepción
          </button>
          <button onClick={()=>setQueue([])} disabled={queue.length===0} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)",opacity:queue.length===0?0.4:1}}>
            🗑️ Limpiar
          </button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* LEFT: Search & Add */}
        <div>
          <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Buscar producto</div>
            <input className="form-input" value={q} onChange={e=>setQ(e.target.value)}
              placeholder="SKU, nombre, código ML..." style={{fontSize:14,padding:12,marginBottom:8}}/>
            
            {results.length > 0 && (
              <div style={{maxHeight:400,overflow:"auto"}}>
                {results.map(p => {
                  const mlCode = getMLCode(p.sku);
                  const skuV = getSkuVenta(p.sku);
                  return (
                    <div key={p.sku} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 8px",borderBottom:"1px solid var(--bg3)",cursor:"pointer"}}
                      onClick={()=>addToQueue(p.sku, 1)}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                        <div style={{fontSize:11,color:"var(--txt3)"}}>
                          <span className="mono">{p.sku}</span>
                          {mlCode && <span> · ML: <strong style={{color:"var(--cyan)"}}>{mlCode}</strong></span>}
                          {skuV !== p.sku && <span> · Venta: <strong>{skuV}</strong></span>}
                        </div>
                      </div>
                      <button onClick={e=>{e.stopPropagation();addToQueue(p.sku, 1);}}
                        style={{padding:"6px 12px",borderRadius:6,background:"var(--greenBg)",color:"var(--green)",fontSize:11,fontWeight:700,border:"1px solid var(--green)33",cursor:"pointer",flexShrink:0}}>
                        + Agregar
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {q.length >= 2 && results.length === 0 && (
              <div style={{textAlign:"center",padding:16,color:"var(--txt3)",fontSize:12}}>Sin resultados</div>
            )}
          </div>

          {/* Bulk add */}
          <BulkAddEtiquetas onAdd={(items) => {
            for (const item of items) addToQueue(item.sku, item.qty);
          }}/>
        </div>

        {/* RIGHT: Queue & Download */}
        <div>
          <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div style={{fontSize:14,fontWeight:700}}>Cola de impresión</div>
              <div style={{padding:"4px 10px",borderRadius:6,background:"var(--cyanBg)",color:"var(--cyan)",fontSize:12,fontWeight:700}}>
                {queue.length} productos · {totalLabels} etiquetas
              </div>
            </div>

            {queue.length === 0 ? (
              <div style={{textAlign:"center",padding:24,color:"var(--txt3)"}}>
                <div style={{fontSize:32,marginBottom:8}}>🏷️</div>
                <div style={{fontSize:13}}>Busca productos y agrégalos</div>
              </div>
            ) : (
              <div style={{maxHeight:350,overflow:"auto"}}>
                {queue.map((item, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",borderBottom:"1px solid var(--bg3)"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                      <div style={{fontSize:10,color:"var(--txt3)"}}>
                        <span className="mono" style={{color:"var(--cyan)"}}>{item.code}</span>
                        {" · "}SKU: <span className="mono">{item.sku}</span>
                      </div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <button onClick={()=>setQueue(queue.map((q,j)=>j===i?{...q,qty:Math.max(1,q.qty-1)}:q))}
                        style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"22px"}}>−</button>
                      <input className="mono" value={item.qty}
                        onFocus={e=>e.target.select()} onChange={e=>setQueue(queue.map((q,j)=>j===i?{...q,qty:Math.max(1,parseInt(e.target.value)||1)}:q))}
                        style={{width:40,textAlign:"center",padding:4,borderRadius:4,background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bg4)",fontSize:13,fontWeight:700}}/>
                      <button onClick={()=>setQueue(queue.map((q,j)=>j===i?{...q,qty:q.qty+1}:q))}
                        style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"22px"}}>+</button>
                    </div>
                    <button onClick={()=>downloadSingle(item)} title="Descargar 1"
                      style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,border:"1px solid var(--bg4)",cursor:"pointer"}}>
                      📄
                    </button>
                    <button onClick={()=>setQueue(queue.filter((_,j)=>j!==i))}
                      style={{padding:"4px 8px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,border:"1px solid var(--red)33",cursor:"pointer"}}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Download buttons */}
          {queue.length > 0 && (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {generating && (
                <div style={{background:"var(--bg3)",borderRadius:8,height:8,overflow:"hidden"}}>
                  <div style={{width:`${progress}%`,height:"100%",background:"var(--cyan)",borderRadius:8,transition:"width 0.2s"}}/>
                </div>
              )}
              <button onClick={downloadAllSinglePDF} disabled={generating}
                style={{width:"100%",padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:generating?0.5:1}}>
                {generating ? `Generando... ${progress}%` : `📄 Un solo PDF — ${totalLabels} páginas`}
              </button>
              <button onClick={downloadAllZip} disabled={generating}
                style={{width:"100%",padding:12,borderRadius:10,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer",opacity:generating?0.5:1}}>
                {generating ? `Generando... ${progress}%` : `📥 ZIP de PDFs individuales`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Bulk add from text (paste SKU + QTY)
function BulkAddEtiquetas({ onAdd }: { onAdd: (items: { sku: string; qty: number }[]) => void }) {
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const s = getStore();

  const doParse = () => {
    const lines = raw.trim().split("\n").filter(l => l.trim());
    const items: { sku: string; qty: number }[] = [];
    const errors: string[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/[\s,;\t]+/);
      const sku = parts[0]?.trim();
      const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
      if (!sku) continue;
      // Try to find by SKU, SKU Venta, or ML code
      const found = findProduct(sku);
      if (found.length > 0) {
        items.push({ sku: found[0].sku, qty });
      } else {
        errors.push(`"${sku}" no encontrado`);
      }
    }
    if (items.length > 0) {
      onAdd(items);
      setRaw("");
      setOpen(false);
    }
    if (errors.length > 0) alert("No encontrados:\n" + errors.join("\n"));
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg2)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px dashed var(--bg4)",cursor:"pointer"}}>
        📋 Pegar lista de productos (SKU + Cantidad)
      </button>
    );
  }

  return (
    <div style={{padding:14,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Pegar lista</div>
      <textarea className="form-input mono" value={raw} onChange={e => setRaw(e.target.value)}
        placeholder={"QLRM-30-BC 15\nSAB-180-BL 10\nBOLMATCUERCAF2L 4"}
        rows={5} style={{fontSize:11,lineHeight:1.5,resize:"vertical",marginBottom:8}}/>
      <div style={{display:"flex",gap:6}}>
        <button onClick={doParse} disabled={!raw.trim()} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none",cursor:"pointer"}}>
          Agregar
        </button>
        <button onClick={() => setOpen(false)} style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,border:"1px solid var(--bg4)",cursor:"pointer"}}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function Operaciones({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"in"|"out"|"transfer"|"venta_ml">("in");
  const [sku, setSku] = useState("");
  const [skuResults, setSkuResults] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product|null>(null);
  const [pos, setPos] = useState("");
  const [posFrom, setPosFrom] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<string>("compra");
  const [note, setNote] = useState("");
  const [toast, setToast] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Venta ML state
  const [mlSearch, setMlSearch] = useState("");
  const [mlResults, setMlResults] = useState<{skuVenta:string;codigoMl:string;componentes:ComposicionVenta[]}[]>([]);
  const [selectedVenta, setSelectedVenta] = useState<{skuVenta:string;codigoMl:string;componentes:ComposicionVenta[]}|null>(null);
  const [ventaQty, setVentaQty] = useState(1);

  const positions = activePositions();

  const searchSku = (q: string) => {
    setSku(q);
    setSelected(null);
    if (q.length >= 2) setSkuResults(findProduct(q));
    else setSkuResults([]);
  };

  const selectProduct = (p: Product) => {
    setSelected(p); setSku(p.sku); setSkuResults([]);
  };

  // ML search
  const searchML = (q: string) => {
    setMlSearch(q);
    setSelectedVenta(null);
    if (q.length < 2) { setMlResults([]); return; }
    const ql = q.toLowerCase();
    const all = getSkusVenta();
    const filtered = all.filter(v =>
      v.skuVenta.toLowerCase().includes(ql) ||
      v.codigoMl.toLowerCase().includes(ql) ||
      v.componentes.some(c => {
        const prod = getStore().products[c.skuOrigen];
        return prod?.name.toLowerCase().includes(ql);
      })
    );
    setMlResults(filtered.slice(0, 10));
  };

  const selectVenta = (v: typeof mlResults[0]) => {
    setSelectedVenta(v);
    setMlSearch(v.codigoMl || v.skuVenta);
    setMlResults([]);
    setVentaQty(1);
  };

  // Calculate available packs for selected venta
  const getDisponibleVenta = (v: typeof selectedVenta): number => {
    if (!v) return 0;
    let min = Infinity;
    for (const comp of v.componentes) {
      const stockTotal = skuTotal(comp.skuOrigen);
      const available = Math.floor(stockTotal / comp.unidades);
      if (available < min) min = available;
    }
    return min === Infinity ? 0 : min;
  };

  // Auto-pick best positions for a component SKU
  const pickPositions = (skuOrigen: string, needed: number): {pos:string;qty:number}[] => {
    const picks: {pos:string;qty:number}[] = [];
    const posiciones = skuPositions(skuOrigen).sort((a,b) => b.qty - a.qty);
    let remaining = needed;
    for (const sp of posiciones) {
      if (remaining <= 0) break;
      const take = Math.min(sp.qty, remaining);
      picks.push({ pos: sp.pos, qty: take });
      remaining -= take;
    }
    return picks;
  };

  const doConfirm = () => {
    if (!selected || !pos || qty < 1) return;

    if (mode === "transfer") {
      if (!posFrom || posFrom === pos) return;
      recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason, sku: selected.sku, pos: posFrom, qty, who: "Admin", note: "Transferencia → " + pos });
      recordMovement({ ts: new Date().toISOString(), type: "in", reason: "transferencia_in" as InReason, sku: selected.sku, pos, qty, who: "Admin", note: "Transferencia ← " + posFrom });
      setLog(l => [`${qty}× ${selected.sku} | ${posFrom} → ${pos}`, ...l].slice(0, 10));
      setToast(`Transferido ${qty}× ${selected.sku}`);
    } else {
      recordMovement({ ts: new Date().toISOString(), type: mode as "in"|"out", reason: reason as any, sku: selected.sku, pos, qty, who: "Admin", note });
      setLog(l => [`${mode === "in" ? "+" : "-"}${qty}× ${selected.sku} | Pos ${pos}`, ...l].slice(0, 10));
      setToast(`${mode === "in" ? "+" : "-"}${qty} ${selected.sku}`);
    }

    setSelected(null); setSku(""); setPos(""); setPosFrom(""); setQty(1); setNote("");
    refresh();
    setTimeout(() => setToast(""), 2000);
  };

  const doConfirmVentaML = () => {
    if (!selectedVenta || ventaQty < 1) return;
    const disponible = getDisponibleVenta(selectedVenta);
    if (ventaQty > disponible) return;

    let totalMoved = 0;
    const logLines: string[] = [];

    for (const comp of selectedVenta.componentes) {
      const needed = comp.unidades * ventaQty;
      const picks = pickPositions(comp.skuOrigen, needed);

      for (const pick of picks) {
        recordMovement({
          ts: new Date().toISOString(), type: "out", reason: "venta_flex" as OutReason,
          sku: comp.skuOrigen, pos: pick.pos, qty: pick.qty, who: "Admin",
          note: `Venta ML: ${selectedVenta.codigoMl || selectedVenta.skuVenta} ×${ventaQty}`,
        });
        totalMoved += pick.qty;
      }
      logLines.push(`-${needed}× ${comp.skuOrigen}`);
    }

    setLog(l => [`🛒 ${selectedVenta.codigoMl} ×${ventaQty}: ${logLines.join(", ")}`, ...l].slice(0, 10));
    setToast(`Venta ML: ${totalMoved} unidades descontadas`);
    setSelectedVenta(null); setMlSearch(""); setVentaQty(1);
    refresh();
    setTimeout(() => setToast(""), 3000);
  };

  useEffect(() => {
    if (mode === "in") setReason("compra");
    else if (mode === "out") setReason("envio_full");
  }, [mode]);

  const maxQty = mode === "out" && selected && pos ? (getStore().stock[selected.sku]?.[pos] || 0) : 9999;
  const transferMax = mode === "transfer" && selected && posFrom ? (getStore().stock[selected.sku]?.[posFrom] || 0) : 9999;
  const ventaDisponible = getDisponibleVenta(selectedVenta);

  return (
    <div>
      {toast && <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:"2px solid var(--green)",color:"var(--green)",padding:"10px 24px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}

      <div className="admin-grid-2">
        <div className="card">
          {/* Mode */}
          <div style={{display:"flex",gap:4,marginBottom:14,flexWrap:"wrap"}}>
            <button onClick={()=>setMode("in")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="in"?"var(--greenBg)":"var(--bg3)",color:mode==="in"?"var(--green)":"var(--txt3)",border:mode==="in"?"2px solid var(--green)":"1px solid var(--bg4)"}}>Entrada</button>
            <button onClick={()=>setMode("out")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="out"?"var(--redBg)":"var(--bg3)",color:mode==="out"?"var(--red)":"var(--txt3)",border:mode==="out"?"2px solid var(--red)":"1px solid var(--bg4)"}}>Salida</button>
            <button onClick={()=>setMode("transfer")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="transfer"?"var(--cyanBg)":"var(--bg3)",color:mode==="transfer"?"var(--cyan)":"var(--txt3)",border:mode==="transfer"?"2px solid var(--cyan)":"1px solid var(--bg4)"}}>Transferir</button>
            <button onClick={()=>setMode("venta_ml")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="venta_ml"?"var(--amberBg)":"var(--bg3)",color:mode==="venta_ml"?"var(--amber)":"var(--txt3)",border:mode==="venta_ml"?"2px solid var(--amber)":"1px solid var(--bg4)"}}>🛒 Venta ML</button>
          </div>

          {mode === "venta_ml" ? (
            /* ===== VENTA ML MODE ===== */
            <>
              <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8}}>Busca por código ML, SKU Venta o nombre del producto</div>
              <div style={{position:"relative",marginBottom:10}}>
                <input className="form-input mono" value={mlSearch} onChange={e=>searchML(e.target.value.toUpperCase())} placeholder="MLC123456, SKU-PACK-001, almohada..." style={{fontSize:13}}/>
                {mlResults.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:"0 0 8px 8px",maxHeight:220,overflow:"auto",boxShadow:"0 6px 16px rgba(0,0,0,0.4)"}}>
                    {mlResults.map(v=>{
                      const disp = getDisponibleVenta(v);
                      const names = v.componentes.map(c=>getStore().products[c.skuOrigen]?.name||c.skuOrigen).join(" + ");
                      return(
                        <div key={v.skuVenta} onClick={()=>selectVenta(v)} style={{padding:"8px 12px",cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}
                          onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <div>
                              <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--amber)"}}>{v.codigoMl}</span>
                              <span className="mono" style={{fontSize:10,color:"var(--txt3)",marginLeft:8}}>{v.skuVenta}</span>
                            </div>
                            <span className="mono" style={{fontSize:12,color:disp>0?"var(--green)":"var(--red)",fontWeight:700}}>{disp} disp.</span>
                          </div>
                          <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>{names}</div>
                          {v.componentes.length > 1 && <div style={{fontSize:9,color:"var(--cyan)",marginTop:1}}>Pack de {v.componentes.length} componentes</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedVenta && (
                <>
                  {/* Selected publication card */}
                  <div style={{padding:"10px 12px",background:"var(--bg3)",borderRadius:8,marginBottom:12,border:"1px solid var(--amber)33"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <span className="mono" style={{fontWeight:800,fontSize:14,color:"var(--amber)"}}>{selectedVenta.codigoMl}</span>
                        <span className="mono" style={{fontSize:11,color:"var(--txt3)",marginLeft:8}}>{selectedVenta.skuVenta}</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div className="mono" style={{fontSize:18,fontWeight:800,color:ventaDisponible>0?"var(--green)":"var(--red)"}}>{ventaDisponible}</div>
                        <div style={{fontSize:9,color:"var(--txt3)"}}>disponibles</div>
                      </div>
                    </div>

                    {/* Components breakdown */}
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt3)",marginBottom:4}}>Componentes del pack:</div>
                    {selectedVenta.componentes.map(comp=>{
                      const prod = getStore().products[comp.skuOrigen];
                      const stockOrigen = skuTotal(comp.skuOrigen);
                      const posiciones = skuPositions(comp.skuOrigen);
                      return(
                        <div key={comp.skuOrigen} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"1px solid var(--bg4)"}}>
                          <div style={{flex:1}}>
                            <span className="mono" style={{fontWeight:700,fontSize:12}}>{comp.skuOrigen}</span>
                            <span style={{fontSize:10,color:"var(--txt3)",marginLeft:6}}>{prod?.name}</span>
                            <div style={{fontSize:9,color:"var(--txt3)",marginTop:1}}>
                              ×{comp.unidades} por pack · Stock: {stockOrigen} · En: {posiciones.map(p=>`${p.pos}(${p.qty})`).join(", ")}
                            </div>
                          </div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:stockOrigen>=comp.unidades*ventaQty?"var(--green)":"var(--red)"}}>
                            -{comp.unidades * ventaQty}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Qty selector */}
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
                    <span style={{fontSize:12,color:"var(--txt3)",minWidth:90}}>Packs a vender:</span>
                    <button onClick={()=>setVentaQty(Math.max(1,ventaQty-1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>−</button>
                    <input type="number" className="form-input mono" value={ventaQty} onFocus={e=>e.target.select()} onChange={e=>setVentaQty(Math.max(1,Math.min(ventaDisponible,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
                    <button onClick={()=>setVentaQty(Math.min(ventaDisponible,ventaQty+1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>+</button>
                    <div className="qty-presets" style={{flex:1}}>{[1,2,5,10].map(n=><button key={n} className={ventaQty===n?"sel":""} onClick={()=>setVentaQty(Math.min(ventaDisponible,n))} style={{fontSize:10,padding:"4px 8px"}}>{n}</button>)}</div>
                  </div>

                  <button onClick={doConfirmVentaML}
                    disabled={ventaQty < 1 || ventaQty > ventaDisponible}
                    style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#000",
                      background:"linear-gradient(135deg,#f59e0b,#eab308)",
                      opacity:(ventaQty<1||ventaQty>ventaDisponible)?0.4:1}}>
                    🛒 CONFIRMAR VENTA — {selectedVenta.componentes.reduce((s,c)=>s+c.unidades*ventaQty,0)} unidades
                  </button>
                </>
              )}
            </>
          ) : (
            /* ===== NORMAL MODES (in/out/transfer) ===== */
            <>
              {/* SKU search */}
              <div style={{position:"relative",marginBottom:10}}>
                <input className="form-input mono" value={sku} onChange={e=>searchSku(e.target.value.toUpperCase())} placeholder="SKU, nombre o código ML..." style={{fontSize:13}}/>
                {skuResults.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:"0 0 8px 8px",maxHeight:180,overflow:"auto",boxShadow:"0 6px 16px rgba(0,0,0,0.4)"}}>
                    {skuResults.slice(0,8).map(p=>(
                      <div key={p.sku} onClick={()=>selectProduct(p)} style={{padding:"8px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",borderBottom:"1px solid var(--bg3)"}}
                        onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div><span className="mono" style={{fontWeight:600,fontSize:12}}>{p.sku}</span> <span style={{fontSize:11,color:"var(--txt3)"}}>{p.name}</span></div>
                        <span className="mono" style={{fontSize:11,color:"var(--blue)"}}>{skuTotal(p.sku)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {selected && <div style={{padding:"6px 10px",background:"var(--bg3)",borderRadius:6,marginBottom:10,fontSize:12}}><span className="mono" style={{fontWeight:700}}>{selected.sku}</span> — {selected.name} <span className="mono" style={{color:"var(--blue)",marginLeft:8}}>Stock: {skuTotal(selected.sku)}</span></div>}

              {/* Position(s) */}
              {mode === "transfer" ? (
                <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:8,marginBottom:10,alignItems:"center"}}>
                  <select className="form-select" value={posFrom} onChange={e=>setPosFrom(e.target.value)} style={{fontSize:12}}>
                    <option value="">Origen...</option>
                    {selected ? skuPositions(selected.sku).map(sp=><option key={sp.pos} value={sp.pos}>{sp.pos} ({sp.qty} uds)</option>) : positions.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                  <span style={{color:"var(--cyan)",fontWeight:700,fontSize:16}}>→</span>
                  <select className="form-select" value={pos} onChange={e=>setPos(e.target.value)} style={{fontSize:12}}>
                    <option value="">Destino...</option>
                    {positions.filter(p=>p.id!==posFrom).map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                  </select>
                </div>
              ) : (
                <select className="form-select" value={pos} onChange={e=>setPos(e.target.value)} style={{fontSize:12,marginBottom:10}}>
                  <option value="">Seleccionar posición...</option>
                  {mode === "out" && selected
                    ? skuPositions(selected.sku).map(sp=><option key={sp.pos} value={sp.pos}>{sp.pos} — {sp.label} ({sp.qty} uds)</option>)
                    : positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)
                  }
                </select>
              )}

              {/* Qty */}
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:12,color:"var(--txt3)",minWidth:50}}>Cantidad:</span>
                <button onClick={()=>setQty(Math.max(1,qty-1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>−</button>
                <input type="number" className="form-input mono" value={qty} onFocus={e=>e.target.select()} onChange={e=>setQty(Math.max(1,Math.min(mode==="transfer"?transferMax:maxQty,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
                <button onClick={()=>setQty(Math.min(mode==="transfer"?transferMax:maxQty,qty+1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>+</button>
                <div className="qty-presets" style={{flex:1}}>{[5,10,20,50].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)} style={{fontSize:10,padding:"4px 8px"}}>{n}</button>)}</div>
              </div>

              {/* Reason (not for transfer) */}
              {mode !== "transfer" && (
                <select className="form-select" value={reason} onChange={e=>setReason(e.target.value)} style={{fontSize:12,marginBottom:10}}>
                  {(mode==="in"?Object.entries(IN_REASONS):Object.entries(OUT_REASONS)).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                </select>
              )}

              <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota / referencia (opcional)" style={{fontSize:12,marginBottom:12}}/>

              <button onClick={doConfirm}
                disabled={!selected || !pos || qty < 1 || (mode==="transfer" && (!posFrom || posFrom===pos))}
                style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",
                  background:mode==="in"?"linear-gradient(135deg,#059669,var(--green))":mode==="out"?"linear-gradient(135deg,#dc2626,var(--red))":"linear-gradient(135deg,#0891b2,var(--cyan))",
                  opacity:(!selected||!pos||qty<1||(mode==="transfer"&&(!posFrom||posFrom===pos)))?0.4:1}}>
                {mode==="in"?"CONFIRMAR ENTRADA":mode==="out"?"CONFIRMAR SALIDA":"CONFIRMAR TRANSFERENCIA"}
              </button>
            </>
          )}
        </div>

        {/* Mini map + position detail */}
        <div>
          {log.length > 0 && (
            <div className="card" style={{marginBottom:8}}>
              <div className="card-title" style={{fontSize:11}}>Registro sesión</div>
              {log.slice(0,5).map((l,i)=><div key={i} style={{padding:"4px 0",borderBottom:"1px solid var(--bg3)",fontSize:11,color:i===0?"var(--txt)":"var(--txt3)",fontFamily:"'JetBrains Mono',monospace"}}>{l}</div>)}
            </div>
          )}
          <MiniMapPanel
            positions={positions}
            onSelectProduct={(p,posId)=>{setMode("out");setSelected(p);setSku(p.sku);setPos(posId);setSkuResults([]);}}
            onSetMode={setMode}
            refresh={refresh}
          />
        </div>
      </div>
    </div>
  );
}

// ==================== MINI MAP PANEL ====================
function MiniMapPanel({ positions, onSelectProduct, onSetMode, refresh }: {
  positions: ReturnType<typeof activePositions>;
  onSelectProduct: (p: Product, posId: string) => void;
  onSetMode: (m: "in"|"out"|"transfer") => void;
  refresh: () => void;
}) {
  const [selectedPos, setSelectedPos] = useState<string|null>(null);
  const [checkedSkus, setCheckedSkus] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<""|"out"|"transfer">("");
  const [bulkQtyMap, setBulkQtyMap] = useState<Record<string,number>>({});
  const [transferDest, setTransferDest] = useState("");
  const [toast, setToast] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(22);
  const cfg = getMapConfig();

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        setCellSize(Math.max(14, Math.floor((w - 8) / cfg.gridW)));
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cfg.gridW]);

  const mapW = cfg.gridW * cellSize;
  const mapH = cfg.gridH * cellSize;
  const selItems = selectedPos ? posContents(selectedPos) : [];
  const selTotalQty = selItems.reduce((s,i) => s + i.qty, 0);

  const toggleCheck = (sku: string) => {
    const next = new Set(checkedSkus);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setCheckedSkus(next);
  };
  const toggleAll = () => {
    if (checkedSkus.size === selItems.length) setCheckedSkus(new Set());
    else setCheckedSkus(new Set(selItems.map(i=>i.sku)));
  };

  const initBulkQty = (items: typeof selItems) => {
    const m: Record<string,number> = {};
    items.forEach(i => { m[i.sku] = i.qty; });
    setBulkQtyMap(m);
  };

  const executeBulk = () => {
    if (!selectedPos || checkedSkus.size === 0) return;
    const items = selItems.filter(i => checkedSkus.has(i.sku));
    let count = 0;
    items.forEach(item => {
      const qty = bulkQtyMap[item.sku] || 0;
      if (qty <= 0) return;
      if (bulkAction === "out") {
        recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as any, sku: item.sku, pos: selectedPos, qty, who: "Admin", note: "Salida rápida desde mapa" });
        count += qty;
      } else if (bulkAction === "transfer" && transferDest && transferDest !== selectedPos) {
        recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as any, sku: item.sku, pos: selectedPos, qty, who: "Admin", note: "Transferencia → " + transferDest });
        recordMovement({ ts: new Date().toISOString(), type: "in", reason: "transferencia_in" as any, sku: item.sku, pos: transferDest, qty, who: "Admin", note: "Transferencia ← " + selectedPos });
        count += qty;
      }
    });
    if (count > 0) {
      setToast(`${bulkAction === "out" ? "Sacadas" : "Movidas"} ${count} uds`);
      setTimeout(() => setToast(""), 2000);
      setCheckedSkus(new Set());
      setBulkAction("");
      setBulkQtyMap({});
      setTransferDest("");
      refresh();
    }
  };

  return (
    <>
      {toast && <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:"2px solid var(--green)",color:"var(--green)",padding:"10px 24px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}

      <div className="card" style={{padding:8}}>
        <div className="card-title" style={{fontSize:11,marginBottom:6}}>🗺️ Mapa de bodega</div>
        <div ref={containerRef} style={{width:"100%",height:mapH,position:"relative",background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:6,overflow:"hidden"}}>
          {/* Grid lines */}
          <svg width={mapW} height={mapH} style={{position:"absolute",top:0,left:0,pointerEvents:"none",opacity:0.06}}>
            {Array.from({length:cfg.gridW+1}).map((_,i)=><line key={"v"+i} x1={i*cellSize} y1={0} x2={i*cellSize} y2={mapH} stroke="var(--txt3)" strokeWidth={1}/>)}
            {Array.from({length:cfg.gridH+1}).map((_,i)=><line key={"h"+i} x1={0} y1={i*cellSize} x2={mapW} y2={i*cellSize} stroke="var(--txt3)" strokeWidth={1}/>)}
          </svg>

          {/* Static objects */}
          {cfg.objects.map(o=>(
            <div key={o.id} style={{position:"absolute",left:o.mx*cellSize,top:o.my*cellSize,width:o.mw*cellSize,height:o.mh*cellSize,background:(o.color||"#64748b")+"18",border:`1px dashed ${o.color||"#64748b"}44`,borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:1}}>
              <div style={{fontSize:Math.max(7,cellSize*0.3),color:(o.color||"#64748b")+"88",fontWeight:600,textAlign:"center",overflow:"hidden"}}>{o.label}</div>
            </div>
          ))}

          {/* Position blocks */}
          {positions.filter(p=>p.active && p.mx !== undefined).map(p=>{
            const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
            const color=p.color||"#10b981";
            const isSel=selectedPos===p.id;
            const items=posContents(p.id);
            const tq=items.reduce((s,i)=>s+i.qty,0);
            const isEmpty=tq===0;
            return(
              <div key={p.id} onClick={(e)=>{e.stopPropagation();setSelectedPos(isSel?null:p.id);setCheckedSkus(new Set());setBulkAction("");}}
                style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                  background:isSel?color+"44":isEmpty?color+"08":color+"1a",
                  border:`2px solid ${isSel?"#fff":isEmpty?color+"33":color}`,borderRadius:4,
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",zIndex:isSel?20:10,
                  boxShadow:isSel?`0 0 0 2px ${color}, 0 0 12px ${color}44`:"none",
                  transition:"all .15s",userSelect:"none"}}>
                <div className="mono" style={{fontSize:Math.max(9,Math.min(14,cellSize*0.5)),fontWeight:800,color:isEmpty?color+"66":color,lineHeight:1}}>{p.id}</div>
                {tq>0 && mh*cellSize>28 && <div className="mono" style={{fontSize:Math.max(7,cellSize*0.28),color:"var(--blue)",fontWeight:600,marginTop:1}}>{tq}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Position detail panel */}
      {selectedPos && (
        <div className="card" style={{marginTop:8,padding:0,overflow:"hidden",border:"1px solid var(--cyan)33"}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",background:"var(--bg3)",borderBottom:"1px solid var(--bg4)"}}>
            <div>
              <span className="mono" style={{fontWeight:800,fontSize:16,color:"var(--cyan)"}}>{selectedPos}</span>
              <span style={{fontSize:12,color:"var(--txt3)",marginLeft:8}}>{selTotalQty} uds · {selItems.length} SKUs</span>
            </div>
            <button onClick={()=>setSelectedPos(null)} style={{background:"none",color:"var(--txt3)",fontSize:18,padding:"0 4px",border:"none",cursor:"pointer"}}>✕</button>
          </div>

          {selItems.length === 0 ? (
            <div style={{padding:20,textAlign:"center",color:"var(--txt3)",fontSize:13}}>Posición vacía</div>
          ) : (
            <>
              {/* Select all + actions bar */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--bg2)",borderBottom:"1px solid var(--bg4)"}}>
                <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:11,color:"var(--txt3)"}}>
                  <input type="checkbox" checked={checkedSkus.size===selItems.length && selItems.length>0} onChange={toggleAll} style={{accentColor:"var(--cyan)"}}/>
                  {checkedSkus.size>0 ? `${checkedSkus.size} seleccionados` : "Seleccionar todo"}
                </label>
                {checkedSkus.size > 0 && !bulkAction && (
                  <div style={{display:"flex",gap:4}}>
                    <button onClick={()=>{setBulkAction("out");initBulkQty(selItems.filter(i=>checkedSkus.has(i.sku)));}} style={{padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:600,background:"var(--redBg)",color:"var(--red)",border:"1px solid var(--red)"}}>🔻 Sacar</button>
                    <button onClick={()=>{setBulkAction("transfer");initBulkQty(selItems.filter(i=>checkedSkus.has(i.sku)));}} style={{padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:600,background:"var(--cyanBg)",color:"var(--cyan)",border:"1px solid var(--cyan)"}}>↗️ Mover</button>
                  </div>
                )}
              </div>

              {/* Bulk action panel */}
              {bulkAction && (
                <div style={{padding:"10px 12px",background:bulkAction==="out"?"var(--redBg)":"var(--cyanBg)",borderBottom:"1px solid var(--bg4)"}}>
                  <div style={{fontSize:12,fontWeight:700,color:bulkAction==="out"?"var(--red)":"var(--cyan)",marginBottom:8}}>
                    {bulkAction==="out"?"🔻 Sacar stock":"↗️ Mover a otra posición"}
                  </div>
                  {bulkAction==="transfer" && (
                    <select className="form-select" value={transferDest} onChange={e=>setTransferDest(e.target.value)} style={{fontSize:12,marginBottom:8,width:"100%"}}>
                      <option value="">Destino...</option>
                      {positions.filter(p=>p.id!==selectedPos).map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                    </select>
                  )}
                  {/* Per-SKU qty adjustment */}
                  {selItems.filter(i=>checkedSkus.has(i.sku)).map(item=>(
                    <div key={item.sku} style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:11}}>
                      <span className="mono" style={{flex:1,fontWeight:600}}>{item.sku}</span>
                      <button onClick={()=>setBulkQtyMap(m=>({...m,[item.sku]:Math.max(0,(m[item.sku]||0)-1)}))} style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)",fontSize:14}}>−</button>
                      <input type="number" className="form-input mono" value={bulkQtyMap[item.sku]||0} onFocus={e=>e.target.select()} onChange={e=>setBulkQtyMap(m=>({...m,[item.sku]:Math.max(0,Math.min(item.qty,parseInt(e.target.value)||0))}))} style={{width:50,textAlign:"center",fontSize:12,padding:4}}/>
                      <button onClick={()=>setBulkQtyMap(m=>({...m,[item.sku]:Math.min(item.qty,(m[item.sku]||0)+1)}))} style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)",fontSize:14}}>+</button>
                      <span style={{color:"var(--txt3)",fontSize:10,minWidth:28}}>/ {item.qty}</span>
                    </div>
                  ))}
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    <button onClick={()=>{setBulkAction("");setBulkQtyMap({});setTransferDest("");}} style={{flex:1,padding:8,borderRadius:6,fontSize:11,fontWeight:600,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)"}}>Cancelar</button>
                    <button onClick={executeBulk} disabled={bulkAction==="transfer"&&!transferDest}
                      style={{flex:1,padding:8,borderRadius:6,fontSize:11,fontWeight:700,color:"#fff",
                        background:bulkAction==="out"?"linear-gradient(135deg,#dc2626,var(--red))":"linear-gradient(135deg,#0891b2,var(--cyan))",
                        opacity:(bulkAction==="transfer"&&!transferDest)?0.4:1}}>
                      {bulkAction==="out"?"Confirmar salida":"Confirmar movimiento"}
                    </button>
                  </div>
                </div>
              )}

              {/* Stock list */}
              <div style={{maxHeight:280,overflow:"auto"}}>
                {selItems.map(item=>{
                  const product = findProduct(item.sku)[0];
                  return(
                    <div key={item.sku} onClick={()=>toggleCheck(item.sku)}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:"1px solid var(--bg3)",cursor:"pointer",
                        background:checkedSkus.has(item.sku)?"var(--bg3)":"transparent",transition:"background .1s"}}>
                      <input type="checkbox" checked={checkedSkus.has(item.sku)} onChange={()=>toggleCheck(item.sku)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--cyan)",flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="mono" style={{fontWeight:700,fontSize:12}}>{item.sku}</div>
                        <div style={{fontSize:10,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div className="mono" style={{fontWeight:700,fontSize:14,color:"var(--blue)"}}>{item.qty}</div>
                        {product?.cost ? <div style={{fontSize:9,color:"var(--txt3)"}}>{fmtMoney(product.cost * item.qty)}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ==================== DASHBOARD ====================
function Dashboard() {
  const s = getStore();
  const skusWithStock = Object.keys(s.stock).filter(sku => skuTotal(sku) > 0);
  const totalUnits = skusWithStock.reduce((sum, sku) => sum + skuTotal(sku), 0);
  const totalValue = skusWithStock.reduce((sum, sku) => { const p = s.products[sku]; return sum + (p ? p.cost * skuTotal(sku) : 0); }, 0);
  const usedPos = activePositions().filter(p => posContents(p.id).length > 0).length;
  const totalPos = activePositions().length;
  const today = fmtDate(new Date().toISOString());
  const todayMovs = s.movements.filter(m => fmtDate(m.ts) === today);
  const todayIn = todayMovs.filter(m=>m.type==="in").reduce((s,m)=>s+m.qty,0);
  const todayOut = todayMovs.filter(m=>m.type==="out").reduce((s,m)=>s+m.qty,0);

  // Movements by reason
  const reasonCounts: Record<string,number> = {};
  s.movements.slice(0,100).forEach(m => { reasonCounts[m.reason] = (reasonCounts[m.reason]||0) + m.qty; });

  return (
    <div>
      <div className="admin-kpi-grid">
        <div className="kpi"><div className="kpi-label">SKUs en bodega</div><div className="kpi-val">{skusWithStock.length}</div><div className="kpi-sub">de {Object.keys(s.products).length} registrados</div></div>
        <div className="kpi"><div className="kpi-label">Unidades totales</div><div className="kpi-val blue">{totalUnits.toLocaleString("es-CL")}</div></div>
        <div className="kpi"><div className="kpi-label">Valor inventario</div><div className="kpi-val green">{fmtMoney(totalValue)}</div><div className="kpi-sub">a costo</div></div>
        <div className="kpi"><div className="kpi-label">Posiciones</div><div className="kpi-val">{usedPos}<span style={{fontSize:14,color:"var(--txt3)"}}> / {totalPos}</span></div><div className="kpi-sub">{totalPos-usedPos} libres</div></div>
        <div className="kpi"><div className="kpi-label">Movimientos hoy</div><div className="kpi-val cyan">{todayMovs.length}</div></div>
        <div className="kpi"><div className="kpi-label">Flujo hoy</div><div className="kpi-val"><span style={{color:"var(--green)"}}>+{todayIn}</span> <span style={{color:"var(--red)"}}>-{todayOut}</span></div></div>
      </div>

      <div className="admin-grid-2">
        <div className="card">
          <div className="card-title">Últimos movimientos</div>
          {s.movements.slice(0,12).map(m => {
            const prod = s.products[m.sku];
            return (
              <div key={m.id} className="mov-row">
                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}>
                  <span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>
                    {m.type==="in"?"ENTRADA":"SALIDA"}
                  </span>
                  <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{m.id}</span>
                  <span style={{fontSize:10,color:"var(--txt3)"}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:12}}>{m.sku}</span>
                    <span style={{fontSize:11,color:"var(--txt3)",marginLeft:6}}>{prod?.name}</span>
                    <span style={{fontSize:10,color:"var(--txt3)",marginLeft:6}}>Pos {m.pos}</span>
                  </div>
                  <span className="mono" style={{fontWeight:700,fontSize:14,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</span>
                </div>
                {m.note && <div style={{fontSize:10,color:"var(--cyan)",marginTop:1}}>{m.note}</div>}
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-title">Resumen por motivo (últimos 100 mov.)</div>
          {Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1]).map(([reason,qty])=>(
            <div key={reason} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
              <span style={{color:"var(--txt2)"}}>{(IN_REASONS as any)[reason]||(OUT_REASONS as any)[reason]||reason}</span>
              <span className="mono" style={{fontWeight:700}}>{qty} uds</span>
            </div>
          ))}
          <div style={{marginTop:16}}>
            <div className="card-title">Top SKUs por volumen</div>
            {skusWithStock.sort((a,b)=>skuTotal(b)-skuTotal(a)).slice(0,8).map(sku=>{
              const prod=s.products[sku];
              return(
                <div key={sku} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
                  <div><span className="mono" style={{fontWeight:600}}>{sku}</span> <span style={{color:"var(--txt3)",fontSize:11}}>{prod?.name}</span></div>
                  <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{skuTotal(sku)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== INVENTARIO EN VIVO ====================
function Inventario() {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string|null>(null);
  const [viewMode, setViewMode] = useState<"fisico"|"ml">("fisico");
  const [soloSinEtiquetar, setSoloSinEtiquetar] = useState(false);
  const [,setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const s = getStore();
  const [skuMovs, setSkuMovs] = useState<Movement[]>([]);
  const [skuMovsLoading, setSkuMovsLoading] = useState(false);

  useEffect(() => {
    if (!expanded) { setSkuMovs([]); return; }
    let cancelled = false;
    setSkuMovsLoading(true);
    fetchMovimientosBySku(expanded).then(rows => {
      if (cancelled) return;
      setSkuMovs(rows.map(r => ({
        id: r.id || crypto.randomUUID(), sku: r.sku, pos: r.posicion_id, qty: r.cantidad,
        type: r.tipo === "entrada" ? "in" as const : "out" as const,
        reason: r.motivo as any, who: r.operario || "", note: r.nota || "",
        ts: r.created_at || "",
      })));
      setSkuMovsLoading(false);
    }).catch(() => { if (!cancelled) setSkuMovsLoading(false); });
    return () => { cancelled = true; };
  }, [expanded]);

  // Physical stock view (also search by sku_venta via composicion)
  // Include all products (even with 0 stock) + any SKUs in stock not in products
  const allProductSkus = new Set([...Object.keys(s.products), ...Object.keys(s.stock)]);
  const allSkus = Array.from(allProductSkus).filter(sku => {
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[sku];
    if (sku.toLowerCase().includes(ql)||prod?.name.toLowerCase().includes(ql)||prod?.cat?.toLowerCase().includes(ql)||prod?.prov?.toLowerCase().includes(ql)) return true;
    // Search by sku_venta (composicion)
    const ventas = getVentasPorSkuOrigen(sku);
    if (ventas.some(v => v.skuVenta.toLowerCase().includes(ql) || v.codigoMl.toLowerCase().includes(ql))) return true;
    // Search in stockDetalle sku_venta keys
    const detalle = skuStockDetalle(sku);
    if (detalle.some(d => d.skuVenta !== SIN_ETIQUETAR && d.skuVenta.toLowerCase().includes(ql))) return true;
    return false;
  }).sort((a,b)=>skuTotal(b)-skuTotal(a));

  // SKUs con stock sin etiquetar
  const skusSinEtiquetar = allSkus.filter(sku => {
    const detalle = skuStockDetalle(sku);
    return detalle.some(d => d.skuVenta === SIN_ETIQUETAR && d.qty > 0);
  });
  const filteredSkus = soloSinEtiquetar ? skusSinEtiquetar : allSkus;
  const grandTotal = filteredSkus.reduce((s,sku)=>s+skuTotal(sku),0);

  // KPIs de etiquetado global
  const etiqGlobal = (() => {
    let etiq = 0, sinEtiq = 0;
    for (const [, svMap] of Object.entries(s.stockDetalle)) {
      for (const [sv, posMap] of Object.entries(svMap)) {
        for (const qty of Object.values(posMap)) {
          if (qty <= 0) continue;
          if (sv === SIN_ETIQUETAR) sinEtiq += qty; else etiq += qty;
        }
      }
    }
    return { etiq, sinEtiq, total: etiq + sinEtiq, pct: etiq + sinEtiq > 0 ? Math.round((etiq / (etiq + sinEtiq)) * 100) : 0 };
  })();

  // ML publication view
  const allVentas = getSkusVenta();
  const ventasConStock = allVentas.map(v => {
    let minDisp = Infinity;
    const comps = v.componentes.map(c => {
      const stock = skuTotal(c.skuOrigen);
      const disp = Math.floor(stock / c.unidades);
      if (disp < minDisp) minDisp = disp;
      return { ...c, stock, disp, nombre: s.products[c.skuOrigen]?.name || c.skuOrigen };
    });
    return { ...v, disponible: minDisp === Infinity ? 0 : minDisp, comps };
  }).filter(v => {
    if (!q) return true;
    const ql = q.toLowerCase();
    return v.skuVenta.toLowerCase().includes(ql) ||
      v.codigoMl.toLowerCase().includes(ql) ||
      v.comps.some(c => c.nombre.toLowerCase().includes(ql) || c.skuOrigen.toLowerCase().includes(ql));
  }).sort((a,b) => b.disponible - a.disponible);
  const totalPublicaciones = ventasConStock.length;
  const conStock = ventasConStock.filter(v => v.disponible > 0).length;
  const sinStock = totalPublicaciones - conStock;

  const [exporting, setExporting] = useState(false);
  const [reclasificando, setReclasificando] = useState(false);
  const [reclasResult, setReclasResult] = useState<{reclasificados:number;detalles:Array<{sku:string;posicion:string;skuVenta:string;qty:number;metodo:string}>}|null>(null);

  // Reconciliación
  const [reconOpen, setReconOpen] = useState(false);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconDiscrep, setReconDiscrep] = useState<StockDiscrepancia[]|null>(null);
  const [reconFixing, setReconFixing] = useState(false);
  const [reconResult, setReconResult] = useState<{fixed:number;errors:string[]}|null>(null);

  const doReconciliar = async () => {
    setReconLoading(true); setReconDiscrep(null); setReconResult(null);
    try {
      const d = await reconciliarStock();
      setReconDiscrep(d);
    } catch (e: unknown) {
      alert("Error al analizar: " + (e instanceof Error ? e.message : String(e)));
    } finally { setReconLoading(false); }
  };

  const doAplicarRecon = async () => {
    if (!reconDiscrep || reconDiscrep.length === 0) return;
    if (!window.confirm(`Se corregirán ${reconDiscrep.length} discrepancias de stock. Los valores se ajustarán para coincidir con el historial de movimientos.\n\nEsta acción NO crea movimientos correctivos (solo ajusta la tabla de stock).\n\n¿Continuar?`)) return;
    setReconFixing(true);
    try {
      const res = await aplicarReconciliacion(reconDiscrep);
      setReconResult(res);
      setReconDiscrep(null);
      await initStore();
      refresh();
    } catch (e: unknown) {
      alert("Error al aplicar: " + (e instanceof Error ? e.message : String(e)));
    } finally { setReconFixing(false); }
  };

  const doReclasificar = async () => {
    if (!window.confirm("Esto reclasificará el stock 'Sin etiquetar' usando los datos de recepción y composiciones de venta. ¿Continuar?")) return;
    setReclasificando(true);
    setReclasResult(null);
    try {
      const res = await fetch("/api/reclasificar-stock", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error desconocido");
      setReclasResult({ reclasificados: data.reclasificados, detalles: data.detalles || [] });
      // Refresh store to reflect changes
      await initStore();
    } catch (e: unknown) {
      alert("Error al reclasificar: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setReclasificando(false);
    }
  };

  const doExportInventario = async () => {
    setExporting(true);
    try {
      const s = getStore();
      // Fetch active recepciones to calculate pending qty per SKU
      const recepciones = await getRecepciones();
      const activas = recepciones.filter(r => !["COMPLETADA","CERRADA","ANULADA"].includes(r.estado));
      const recIds = activas.map(r => r.id!).filter(Boolean);
      let allLineas: DBRecepcionLinea[] = [];
      if (recIds.length > 0) {
        allLineas = await getLineasDeRecepciones(recIds);
      }
      // Pending per SKU = sum of (qty_factura - qty_ubicada) for lines not fully ubicada
      const pendientePorSku: Record<string, number> = {};
      for (const l of allLineas) {
        if (l.estado === "UBICADA") continue;
        const pending = l.qty_factura - (l.qty_ubicada || 0);
        if (pending > 0) {
          pendientePorSku[l.sku] = (pendientePorSku[l.sku] || 0) + pending;
        }
      }

      const rows: string[] = [];
      rows.push(["sku_origen","nombre","sku_venta","etiquetado","unidades_pack","stock","posicion","pendiente_recepcion","stock_proyectado"].join(","));

      // Detailed rows from stockDetalle: one row per sku_origen + sku_venta + posicion
      const skusExported = new Set<string>();
      for (const [sku, svMap] of Object.entries(s.stockDetalle)) {
        const prod = s.products[sku];
        const name = prod?.name || "";
        const ventas = getVentasPorSkuOrigen(sku);
        skusExported.add(sku);

        for (const [skuVenta, posMap] of Object.entries(svMap)) {
          for (const [pos, qty] of Object.entries(posMap)) {
            if (qty <= 0) continue;
            const isSinEtiquetar = skuVenta === SIN_ETIQUETAR;
            const venta = ventas.find(v => v.skuVenta === skuVenta);
            rows.push([
              csvEscape(sku),
              csvEscape(name),
              csvEscape(isSinEtiquetar ? "" : skuVenta),
              isSinEtiquetar ? "Sin etiquetar" : "Etiquetado",
              venta ? String(venta.unidades) : "",
              String(qty),
              csvEscape(pos),
              "",
              "",
            ].join(","));
          }
        }
      }

      // SKUs in stock but not in stockDetalle (fallback)
      for (const [sku, posMap] of Object.entries(s.stock)) {
        if (s.stockDetalle[sku]) continue;
        const prod = s.products[sku];
        skusExported.add(sku);
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty <= 0) continue;
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "Sin etiquetar",
            "",
            String(qty),
            csvEscape(pos),
            "",
            "",
          ].join(","));
        }
      }

      // SKUs with pending reception but no current stock
      for (const [sku, pendiente] of Object.entries(pendientePorSku)) {
        if (skusExported.has(sku)) {
          // Add pending as a summary row for this SKU
          const prod = s.products[sku];
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "",
            "",
            "0",
            "",
            String(pendiente),
            String(pendiente),
          ].join(","));
        } else {
          // SKU only has pending, no stock at all
          const prod = s.products[sku];
          rows.push([
            csvEscape(sku),
            csvEscape(prod?.name || ""),
            "",
            "",
            "",
            "0",
            "",
            String(pendiente),
            String(pendiente),
          ].join(","));
        }
      }

      const csv = rows.join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `banva_inventario_proyectado_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4}}>
            <button onClick={()=>setViewMode("fisico")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="fisico"?"var(--cyanBg)":"var(--bg3)",color:viewMode==="fisico"?"var(--cyan)":"var(--txt3)",
              border:viewMode==="fisico"?"1px solid var(--cyan)":"1px solid var(--bg4)"}}>📦 Stock Fisico</button>
            <button onClick={()=>setViewMode("ml")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="ml"?"var(--amberBg)":"var(--bg3)",color:viewMode==="ml"?"var(--amber)":"var(--txt3)",
              border:viewMode==="ml"?"1px solid var(--amber)":"1px solid var(--bg4)"}}>🛒 Publicaciones ML</button>
          </div>
          {viewMode === "fisico" && (
            <button onClick={()=>setSoloSinEtiquetar(!soloSinEtiquetar)} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:soloSinEtiquetar?"var(--amberBg)":"var(--bg3)",color:soloSinEtiquetar?"var(--amber)":"var(--txt3)",
              border:soloSinEtiquetar?"1px solid var(--amber)":"1px solid var(--bg4)"}}>
              Sin etiquetar ({skusSinEtiquetar.length})
            </button>
          )}
          <button onClick={doExportInventario} disabled={exporting} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:"var(--bg3)",color:"var(--green)",border:"1px solid var(--bg4)",cursor:exporting?"wait":"pointer",opacity:exporting?0.6:1}}>
            {exporting ? "Exportando..." : "Exportar Inventario"}
          </button>
          <button onClick={doReclasificar} disabled={reclasificando} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
            background:reclasificando?"var(--bg3)":"var(--amberBg)",color:reclasificando?"var(--txt3)":"var(--amber)",border:"1px solid var(--amberBd)",cursor:reclasificando?"wait":"pointer",opacity:reclasificando?0.6:1}}>
            {reclasificando ? "Reclasificando..." : "Reclasificar formatos"}
          </button>
          <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder={viewMode==="fisico"?"Filtrar SKU, nombre, proveedor...":"Filtrar codigo ML, SKU venta, nombre..."} style={{fontSize:13,flex:1}}/>
          {viewMode === "fisico" && etiqGlobal.total > 0 && (
            <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:6,background:"var(--bg3)",border:"1px solid var(--bg4)"}}>
              <div style={{width:40,height:40,borderRadius:"50%",background:`conic-gradient(var(--green) ${etiqGlobal.pct*3.6}deg, var(--amber) ${etiqGlobal.pct*3.6}deg)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:800,color:"var(--txt)"}}>{etiqGlobal.pct}%</div>
              </div>
              <div style={{fontSize:10,lineHeight:1.4}}>
                <div style={{color:"var(--green)",fontWeight:700}}>{etiqGlobal.etiq.toLocaleString("es-CL")} etiq.</div>
                <div style={{color:"var(--amber)"}}>{etiqGlobal.sinEtiq.toLocaleString("es-CL")} sin etiq.</div>
              </div>
            </div>
          )}
          <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
            {viewMode === "fisico" ? (
              <>
                <div style={{fontSize:10,color:"var(--txt3)"}}>{filteredSkus.length} SKUs{soloSinEtiquetar ? " sin etiquetar" : ""}</div>
                <div className="mono" style={{fontSize:14,fontWeight:700,color:"var(--blue)"}}>{grandTotal.toLocaleString("es-CL")} uds</div>
              </>
            ) : (
              <>
                <div style={{fontSize:10,color:"var(--txt3)"}}>{totalPublicaciones} publicaciones</div>
                <div style={{fontSize:11}}><span style={{color:"var(--green)",fontWeight:700}}>{conStock} con stock</span> · <span style={{color:"var(--red)"}}>{sinStock} sin stock</span></div>
              </>
            )}
          </div>
        </div>
      </div>

      {reclasResult && (
        <div className="card" style={{background:"var(--bg2)",border:"1px solid var(--amberBd)"}}>
          <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
            Reclasificación completada — {reclasResult.reclasificados} registros actualizados
          </div>
          {reclasResult.detalles.length > 0 ? (
            <table className="tbl"><thead><tr><th>SKU</th><th>Posicion</th><th>Formato asignado</th><th style={{textAlign:"right"}}>Qty</th><th>Metodo</th></tr></thead>
              <tbody>{reclasResult.detalles.map((d,i) => (
                <tr key={i}>
                  <td className="mono" style={{fontSize:11}}>{d.sku}</td>
                  <td className="mono" style={{fontSize:11}}>{d.posicion}</td>
                  <td className="mono" style={{fontSize:11,fontWeight:700,color:"var(--cyan)"}}>{d.skuVenta}</td>
                  <td className="mono" style={{textAlign:"right",fontWeight:700}}>{d.qty}</td>
                  <td style={{fontSize:10,color:"var(--txt3)"}}>{d.metodo === "movimiento" ? "Por movimiento" : "Por composicion"}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : (
            <div style={{fontSize:11,color:"var(--txt3)"}}>No se encontraron registros para reclasificar (todo el stock ya tiene formato asignado o no hay datos de recepción)</div>
          )}
          <button onClick={() => setReclasResult(null)} style={{marginTop:8,padding:"4px 12px",borderRadius:4,fontSize:10,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)"}}>Cerrar</button>
        </div>
      )}

      {/* ===== RECONCILIACIÓN DE STOCK ===== */}
      <div className="card" style={{border: reconOpen ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setReconOpen(!reconOpen)}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>🔍</span>
            <span style={{fontSize:13,fontWeight:700}}>Reconciliar Stock vs Movimientos</span>
            <span style={{fontSize:10,color:"var(--txt3)",background:"var(--bg3)",padding:"2px 8px",borderRadius:4}}>
              Detecta y corrige discrepancias
            </span>
          </div>
          <span style={{fontSize:12,color:"var(--txt3)"}}>{reconOpen ? "▲" : "▼"}</span>
        </div>

        {reconOpen && (
          <div style={{marginTop:12}}>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button onClick={doReconciliar} disabled={reconLoading} style={{padding:"8px 20px",borderRadius:8,background:reconLoading?"var(--bg3)":"var(--cyan)",color:reconLoading?"var(--txt3)":"#fff",fontSize:12,fontWeight:700,cursor:reconLoading?"wait":"pointer"}}>
                {reconLoading ? "Analizando..." : "Analizar discrepancias"}
              </button>
              {reconDiscrep && reconDiscrep.length > 0 && (
                <button onClick={doAplicarRecon} disabled={reconFixing} style={{padding:"8px 20px",borderRadius:8,background:reconFixing?"var(--bg3)":"var(--red)",color:reconFixing?"var(--txt3)":"#fff",fontSize:12,fontWeight:700,cursor:reconFixing?"wait":"pointer"}}>
                  {reconFixing ? "Corrigiendo..." : `Corregir ${reconDiscrep.length} discrepancias`}
                </button>
              )}
            </div>

            {reconDiscrep !== null && reconDiscrep.length === 0 && (
              <div style={{padding:16,textAlign:"center",color:"var(--green)",fontSize:13,fontWeight:600}}>
                Todo OK — El stock coincide con los movimientos registrados
              </div>
            )}

            {reconDiscrep && reconDiscrep.length > 0 && (
              <div>
                <div style={{fontSize:11,color:"var(--amber)",marginBottom:8,fontWeight:600}}>
                  {reconDiscrep.length} discrepancias encontradas — Stock total erróneo: {reconDiscrep.reduce((s,d)=>s+Math.abs(d.diferencia),0)} uds
                </div>
                <div style={{maxHeight:400,overflow:"auto"}}>
                  <table className="tbl"><thead><tr>
                    <th>SKU</th><th>Producto</th><th>Posición</th>
                    <th style={{textAlign:"right"}}>Stock actual</th>
                    <th style={{textAlign:"right"}}>Según movim.</th>
                    <th style={{textAlign:"right"}}>Diferencia</th>
                  </tr></thead>
                  <tbody>{reconDiscrep.map((d,i)=>(
                    <tr key={i}>
                      <td className="mono" style={{fontSize:11,fontWeight:700}}>{d.sku}</td>
                      <td style={{fontSize:11,color:"var(--txt2)",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.nombre}</td>
                      <td className="mono" style={{fontSize:11}}>{d.posicion}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--red)"}}>{d.stockActual}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--green)"}}>{d.stockEsperado}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color:d.diferencia>0?"var(--green)":"var(--red)"}}>{d.diferencia>0?"+":""}{d.diferencia}</td>
                    </tr>
                  ))}</tbody></table>
                </div>
              </div>
            )}

            {reconResult && (
              <div style={{marginTop:12,padding:12,borderRadius:8,background:"var(--greenBg)",border:"1px solid var(--greenBd)"}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--green)"}}>
                  Reconciliación completada — {reconResult.fixed} correcciones aplicadas
                </div>
                {reconResult.errors.length > 0 && (
                  <div style={{marginTop:8}}>
                    <div style={{fontSize:11,color:"var(--red)",fontWeight:600}}>Errores ({reconResult.errors.length}):</div>
                    {reconResult.errors.map((e,i) => <div key={i} style={{fontSize:10,color:"var(--red)",fontFamily:"var(--font-mono)"}}>{e}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {viewMode === "ml" ? (
        /* ===== ML PUBLICATIONS VIEW ===== */
        <>
          <div className="desktop-only">
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <table className="tbl">
                <thead><tr>
                  <th>Código ML</th><th>SKU Venta</th><th>Componentes</th><th style={{textAlign:"center"}}>Pack</th><th style={{textAlign:"right"}}>Disponible</th>
                </tr></thead>
                <tbody>
                  {ventasConStock.map(v=>{
                    const isOpen = expanded === v.skuVenta;
                    return([
                      <tr key={v.skuVenta} onClick={()=>setExpanded(isOpen?null:v.skuVenta)} style={{cursor:"pointer",background:isOpen?"var(--bg3)":"transparent"}}>
                        <td className="mono" style={{fontWeight:700,fontSize:12,color:"var(--amber)"}}>{v.codigoMl}</td>
                        <td className="mono" style={{fontSize:11}}>{v.skuVenta}</td>
                        <td style={{fontSize:11}}>
                          {v.comps.map((c,i)=>(
                            <span key={c.skuOrigen}>
                              {i>0 && <span style={{color:"var(--txt3)"}}> + </span>}
                              {c.unidades > 1 && <span style={{color:"var(--cyan)"}}>{c.unidades}×</span>}
                              <span>{c.nombre}</span>
                            </span>
                          ))}
                        </td>
                        <td style={{textAlign:"center"}}>{v.comps.length > 1 || v.comps[0]?.unidades > 1 ? <span className="tag" style={{background:"var(--amberBg)",color:"var(--amber)"}}>Pack</span> : <span className="tag">Unitario</span>}</td>
                        <td className="mono" style={{textAlign:"right",fontWeight:700,fontSize:16,color:v.disponible>0?"var(--green)":"var(--red)"}}>{v.disponible}</td>
                      </tr>,
                      isOpen && <tr key={v.skuVenta+"-detail"}><td colSpan={5} style={{background:"var(--bg3)",padding:12}}>
                        <div style={{fontSize:11,fontWeight:700,marginBottom:6}}>Desglose de componentes:</div>
                        <table className="tbl"><thead><tr><th>SKU Origen</th><th>Producto</th><th style={{textAlign:"center"}}>Uds/Pack</th><th style={{textAlign:"right"}}>Stock Total</th><th style={{textAlign:"right"}}>Packs posibles</th></tr></thead>
                          <tbody>{v.comps.map(c=>(
                            <tr key={c.skuOrigen}>
                              <td className="mono" style={{fontWeight:700,fontSize:12}}>{c.skuOrigen}</td>
                              <td style={{fontSize:11}}>{c.nombre}</td>
                              <td className="mono" style={{textAlign:"center"}}>{c.unidades}</td>
                              <td className="mono" style={{textAlign:"right",color:"var(--blue)"}}>{c.stock}</td>
                              <td className="mono" style={{textAlign:"right",fontWeight:700,color:c.disp===v.disponible&&v.disponible>0?"var(--green)":c.disp===v.disponible?"var(--red)":"var(--txt2)"}}>{c.disp} {c.disp===v.disponible&&<span style={{fontSize:9}}>← limita</span>}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </td></tr>
                    ]);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mobile-only">
            {ventasConStock.map(v=>{
              const isOpen = expanded === v.skuVenta;
              return(
                <div key={v.skuVenta} className="card" style={{marginTop:6,cursor:"pointer"}} onClick={()=>setExpanded(isOpen?null:v.skuVenta)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div className="mono" style={{fontSize:13,fontWeight:700,color:"var(--amber)"}}>{v.codigoMl}</div>
                      <div className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{v.skuVenta}</div>
                      <div style={{fontSize:11,color:"var(--txt2)",marginTop:2}}>
                        {v.comps.map((c,i)=>(
                          <span key={c.skuOrigen}>{i>0?" + ":""}{c.unidades>1?`${c.unidades}× `:""}{c.nombre}</span>
                        ))}
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:22,fontWeight:800,color:v.disponible>0?"var(--green)":"var(--red)"}}>{v.disponible}</div>
                      <div style={{fontSize:9,color:"var(--txt3)"}}>disponibles</div>
                    </div>
                  </div>
                  {isOpen && <div style={{marginTop:8,borderTop:"1px solid var(--bg4)",paddingTop:8}}>
                    {v.comps.map(c=>(
                      <div key={c.skuOrigen} className="mini-row" style={{alignItems:"center"}}>
                        <span className="mono" style={{fontWeight:700,fontSize:12,minWidth:80}}>{c.skuOrigen}</span>
                        <span style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{c.nombre} ×{c.unidades}/pack</span>
                        <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--blue)"}}>{c.stock}</span>
                        <span style={{fontSize:9,color:"var(--txt3)",marginLeft:4}}>→ {c.disp} packs</span>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        /* ===== PHYSICAL STOCK VIEW (original) ===== */
        <>
          {/* Desktop: table view */}
          <div className="desktop-only">
            <div className="card" style={{padding:0,overflow:"hidden"}}>
              <table className="tbl">
                <thead><tr>
                  <th>SKU</th><th>Producto</th><th>Cat.</th><th>Proveedor</th><th>Etiquetado</th><th>Ubicaciones</th><th style={{textAlign:"right"}}>Total</th><th style={{textAlign:"right"}}>Valor</th>
                </tr></thead>
                <tbody>
                  {filteredSkus.map(sku=>{
                    const prod=s.products[sku];const total=skuTotal(sku);const positions=skuPositions(sku);
                    const isOpen=expanded===sku;
                    const det=skuStockDetalle(sku);
                    const etiqQty=det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
                    const sinEtQty=det.filter(d=>d.skuVenta===SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
                    const etiqStatus=total===0?"—":sinEtQty===0?"full":etiqQty===0?"none":"partial";
                    const etiqFormatos=Array.from(new Set(det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).map(d=>d.skuVenta)));
                    return([
                      <tr key={sku} onClick={()=>setExpanded(isOpen?null:sku)} style={{cursor:"pointer",background:isOpen?"var(--bg3)":"transparent"}}>
                        <td className="mono" style={{fontWeight:700,fontSize:12}}>{sku}</td>
                        <td style={{fontSize:12}}>{prod?.name||sku}</td>
                        <td><span className="tag">{prod?.cat}</span></td>
                        <td><span className="tag">{prod?.prov}</span></td>
                        <td>{etiqStatus==="full"?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--greenBg)",color:"var(--green)",border:"1px solid var(--greenBd)"}}>100%</span>
                            {etiqFormatos.length===1&&<span className="mono" style={{fontSize:9,color:"var(--cyan)"}}>{etiqFormatos[0]}</span>}
                            {etiqFormatos.length>1&&<span className="mono" style={{fontSize:9,color:"var(--cyan)"}}>{etiqFormatos.length} formatos</span>}
                          </span>
                        ):etiqStatus==="none"?(
                          <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--amberBg)",color:"var(--amber)",border:"1px solid var(--amberBd)"}}>Sin etiquetar</span>
                        ):etiqStatus==="partial"?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--blueBg)",color:"var(--blue)",border:"1px solid var(--blueBd)"}}>{etiqQty}/{total}</span>
                            <span style={{fontSize:9,color:"var(--amber)"}}>{sinEtQty} sin etiq.</span>
                          </span>
                        ):(
                          <span style={{fontSize:10,color:"var(--txt3)"}}>—</span>
                        )}</td>
                        <td>{positions.map(p=><span key={p.pos} className="mono" style={{fontSize:10,marginRight:6,padding:"2px 6px",background:"var(--bg3)",borderRadius:4}}>{p.pos}: {p.qty}</span>)}</td>
                        <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{total}</td>
                        <td className="mono" style={{textAlign:"right",fontSize:11}}>{prod?fmtMoney(prod.cost*total):"-"}</td>
                      </tr>,
                      isOpen && <tr key={sku+"-detail"}><td colSpan={8} style={{background:"var(--bg3)",padding:16}}>
                        {/* Detalle por formato de venta */}
                        {(()=>{const detalle=skuStockDetalle(sku);return detalle.length>0&&(
                          <div style={{marginBottom:16}}>
                            <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Detalle por formato de venta — {sku}</div>
                            <table className="tbl"><thead><tr><th>Formato</th><th>Posicion</th><th style={{textAlign:"right"}}>Cantidad</th><th style={{width:60}}></th></tr></thead>
                              <tbody>{detalle.map((d,i)=>(
                                <EditableStockRow key={`${d.skuVenta}-${d.pos}-${i}`} sku={sku} skuVenta={d.skuVenta} pos={d.pos} label={d.label} qty={d.qty} onDone={refresh} />
                              ))}</tbody>
                            </table>
                          </div>
                        );})()}
                        <ReasignarFormatoPanel sku={sku} onDone={refresh} />
                        <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Historial de movimientos — {sku} {skuMovsLoading ? <span style={{fontWeight:400,color:"var(--txt3)"}}>(cargando...)</span> : <span style={{fontWeight:400,color:"var(--txt3)",fontSize:10}}>({skuMovs.length} movimientos)</span>}</div>
                        <table className="tbl"><thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Pos</th><th>Quien</th><th>Nota</th><th style={{textAlign:"right"}}>Qty</th></tr></thead>
                          <tbody>{skuMovs.map(m=>(
                            <tr key={m.id}>
                              <td style={{fontSize:11}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</td>
                              <td><span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"IN":"OUT"}</span></td>
                              <td style={{fontSize:10}}>{(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]}</td>
                              <td className="mono">{m.pos}</td><td style={{fontSize:11}}>{m.who}</td><td style={{fontSize:10,color:"var(--cyan)"}}>{m.note}</td>
                              <td className="mono" style={{textAlign:"right",fontWeight:700,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </td></tr>
                    ]);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: card view */}
          <div className="mobile-only">
            {filteredSkus.map(sku=>{
              const prod=s.products[sku];const positions=skuPositions(sku);const total=skuTotal(sku);const isOpen=expanded===sku;
              const det=skuStockDetalle(sku);
              const etiqQty=det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
              const sinEtQty=det.filter(d=>d.skuVenta===SIN_ETIQUETAR).reduce((s,d)=>s+d.qty,0);
              const etiqFormatos=Array.from(new Set(det.filter(d=>d.skuVenta!==SIN_ETIQUETAR).map(d=>d.skuVenta)));
              return(
                <div key={sku} className="card" style={{marginTop:6,cursor:"pointer"}} onClick={()=>setExpanded(isOpen?null:sku)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div className="mono" style={{fontSize:14,fontWeight:700}}>{sku}</div>
                      <div style={{fontSize:12,color:"var(--txt2)"}}>{prod?.name||sku}</div>
                      <div style={{display:"flex",gap:4,marginTop:3,flexWrap:"wrap"}}>
                        {prod?.cat&&<span className="tag">{prod.cat}</span>}{prod?.prov&&<span className="tag">{prod.prov}</span>}
                        {total>0&&sinEtQty===0&&etiqQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--greenBg)",color:"var(--green)",border:"1px solid var(--greenBd)"}}>
                            {etiqFormatos.length===1?etiqFormatos[0]:`${etiqFormatos.length} formatos`}
                          </span>
                        ):total>0&&sinEtQty>0&&etiqQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--blueBg)",color:"var(--blue)",border:"1px solid var(--blueBd)"}}>{etiqQty}/{total} etiq.</span>
                        ):total>0&&sinEtQty>0?(
                          <span style={{padding:"1px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--amberBg)",color:"var(--amber)",border:"1px solid var(--amberBd)"}}>Sin etiquetar</span>
                        ):null}
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--blue)"}}>{total}</div>
                      <div style={{fontSize:9,color:"var(--txt3)"}}>en {positions.length} pos.</div>
                    </div>
                  </div>
                  <div style={{marginTop:8}}>{positions.map(sp=>(
                    <div key={sp.pos} className="mini-row"><span className="mono" style={{fontWeight:700,color:"var(--green)",minWidth:50,fontSize:13}}>{sp.pos}</span><span style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{sp.label}</span><span className="mono" style={{fontWeight:700,fontSize:13}}>{sp.qty}</span></div>
                  ))}</div>
                  {isOpen&&<div style={{marginTop:10,borderTop:"1px solid var(--bg4)",paddingTop:10}}>
                    {(()=>{const detalle=skuStockDetalle(sku);return detalle.length>0&&(
                      <div style={{marginBottom:10}}>
                        <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:6}}>Por formato de venta</div>
                        {detalle.map((d,i)=>(
                          <EditableStockRowMobile key={`${d.skuVenta}-${d.pos}-${i}`} sku={sku} skuVenta={d.skuVenta} pos={d.pos} label={d.label} qty={d.qty} onDone={refresh} />
                        ))}
                      </div>
                    );})()}
                    <ReasignarFormatoPanel sku={sku} onDone={refresh} />
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:6}}>Historial ({skuMovsLoading?"...":skuMovs.length} movimientos)</div>
                    {skuMovs.map(m=>(
                      <div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",fontSize:11}}>
                        <div><span style={{color:"var(--txt3)"}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</span><span style={{marginLeft:6,color:"var(--txt3)"}}>Pos {m.pos}</span><span style={{marginLeft:6,fontSize:10,color:"var(--txt3)"}}>({(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]})</span></div>
                        <span className="mono" style={{fontWeight:700,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</span>
                      </div>
                    ))}
                  </div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ==================== EDITAR STOCK POR VARIANTE (INLINE) ====================
function EditableStockRow({ sku, skuVenta, pos, label, qty, onDone }: { sku: string; skuVenta: string; pos: string; label: string; qty: number; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(qty);
  const [saving, setSaving] = useState(false);

  const doSave = async () => {
    if (val === qty) { setEditing(false); return; }
    setSaving(true);
    try {
      const realSkuVenta = skuVenta === SIN_ETIQUETAR ? null : skuVenta;
      await editarStockVariante(sku, pos, realSkuVenta, val);
      onDone();
      setEditing(false);
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally { setSaving(false); }
  };

  return (
    <tr>
      <td className="mono" style={{fontSize:11,fontWeight:700,color:skuVenta===SIN_ETIQUETAR?"var(--amber)":"var(--cyan)"}}>
        {skuVenta===SIN_ETIQUETAR?"Sin etiquetar":skuVenta}
      </td>
      <td className="mono" style={{fontSize:11}}>{pos} — {label}</td>
      <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>
        {editing ? (
          <input type="number" value={val} min={0} onFocus={e=>e.target.select()}
            onChange={e=>setVal(Math.max(0,parseInt(e.target.value)||0))}
            onKeyDown={e=>{if(e.key==="Enter")doSave();if(e.key==="Escape"){setEditing(false);setVal(qty);}}}
            style={{width:60,textAlign:"center",fontSize:12,fontWeight:700,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",border:"1px solid var(--cyan)",color:"var(--txt)"}} autoFocus />
        ) : qty}
      </td>
      <td style={{textAlign:"center"}}>
        {editing ? (
          <span style={{display:"flex",gap:4,justifyContent:"center"}}>
            <button onClick={doSave} disabled={saving} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--green)",color:"#fff",border:"none",cursor:"pointer",opacity:saving?0.5:1}}>{saving?"...":"OK"}</button>
            <button onClick={()=>{setEditing(false);setVal(qty);}} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>X</button>
          </span>
        ) : (
          <button onClick={()=>{setVal(qty);setEditing(true);}} style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
        )}
      </td>
    </tr>
  );
}

function EditableStockRowMobile({ sku, skuVenta, pos, label, qty, onDone }: { sku: string; skuVenta: string; pos: string; label: string; qty: number; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(qty);
  const [saving, setSaving] = useState(false);

  const doSave = async () => {
    if (val === qty) { setEditing(false); return; }
    setSaving(true);
    try {
      const realSkuVenta = skuVenta === SIN_ETIQUETAR ? null : skuVenta;
      await editarStockVariante(sku, pos, realSkuVenta, val);
      onDone();
      setEditing(false);
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally { setSaving(false); }
  };

  return (
    <div className="mini-row" style={{alignItems:"center"}}>
      <span className="mono" style={{fontWeight:700,fontSize:11,color:skuVenta===SIN_ETIQUETAR?"var(--amber)":"var(--cyan)",minWidth:80}}>
        {skuVenta===SIN_ETIQUETAR?"Sin etiquetar":skuVenta}
      </span>
      <span className="mono" style={{flex:1,fontSize:10,color:"var(--txt3)"}}>{pos}</span>
      {editing ? (
        <span style={{display:"flex",gap:4,alignItems:"center"}}>
          <input type="number" value={val} min={0} inputMode="numeric" onFocus={e=>e.target.select()}
            onChange={e=>setVal(Math.max(0,parseInt(e.target.value)||0))}
            onKeyDown={e=>{if(e.key==="Enter")doSave();if(e.key==="Escape"){setEditing(false);setVal(qty);}}}
            style={{width:50,textAlign:"center",fontSize:12,fontWeight:700,padding:"2px 4px",borderRadius:4,background:"var(--bg2)",border:"1px solid var(--cyan)",color:"var(--txt)"}} autoFocus />
          <button onClick={doSave} disabled={saving} style={{padding:"2px 6px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--green)",color:"#fff",border:"none",cursor:"pointer",opacity:saving?0.5:1}}>{saving?"...":"OK"}</button>
          <button onClick={()=>{setEditing(false);setVal(qty);}} style={{padding:"2px 6px",borderRadius:4,fontSize:10,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>X</button>
        </span>
      ) : (
        <span style={{display:"flex",gap:4,alignItems:"center"}}>
          <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--blue)"}}>{qty}</span>
          <button onClick={()=>{setVal(qty);setEditing(true);}} style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",cursor:"pointer"}}>Editar</button>
        </span>
      )}
    </div>
  );
}

// ==================== REASIGNAR FORMATO INLINE ====================
function ReasignarFormatoPanel({ sku, onDone }: { sku: string; onDone: () => void }) {
  const formatos = getVentasPorSkuOrigen(sku);
  const detalle = skuStockDetalle(sku);
  const sinEtiquetar = detalle.filter(d => d.skuVenta === SIN_ETIQUETAR && d.qty > 0);

  const [selFormato, setSelFormato] = useState<Record<string, string>>({});
  const [selQty, setSelQty] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);

  if (formatos.length === 0 || sinEtiquetar.length === 0) return null;

  const doReasignar = async (posId: string, maxQty: number) => {
    const formato = selFormato[posId];
    const qty = selQty[posId] || maxQty;
    if (!formato || qty <= 0) return;
    setSaving(true);
    try {
      await reasignarFormato(sku, posId, qty, formato);
      onDone();
    } catch (e: unknown) {
      alert("Error: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{marginBottom:16,padding:12,borderRadius:8,background:"var(--amberBg)",border:"1px solid var(--amberBd)"}}>
      <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:8}}>
        Reasignar stock sin etiquetar → formato de venta
      </div>
      {sinEtiquetar.map(d => (
        <div key={d.pos} style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8,padding:8,borderRadius:6,background:"var(--bg2)"}}>
          <div style={{minWidth:60}}>
            <div className="mono" style={{fontSize:11,fontWeight:700}}>{d.pos}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{d.label}</div>
            <div className="mono" style={{fontSize:12,fontWeight:700,color:"var(--amber)"}}>{d.qty} uds</div>
          </div>
          <select value={selFormato[d.pos] || ""} onChange={e => setSelFormato(p => ({...p, [d.pos]: e.target.value}))}
            style={{flex:1,padding:6,borderRadius:4,fontSize:11,background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bg4)",minWidth:120}}>
            <option value="">— Seleccionar formato —</option>
            {formatos.map(f => (
              <option key={f.skuVenta} value={f.skuVenta}>{f.skuVenta} {f.unidades > 1 ? `(x${f.unidades})` : "(individual)"}</option>
            ))}
          </select>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button onClick={() => setSelQty(p => ({...p, [d.pos]: Math.max(1, (p[d.pos] ?? d.qty) - 1)}))}
              style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",color:"var(--txt)"}}>−</button>
            <input type="number" value={selQty[d.pos] ?? d.qty}
              onFocus={e=>e.target.select()} onChange={e => setSelQty(p => ({...p, [d.pos]: Math.max(1, Math.min(d.qty, parseInt(e.target.value) || 0))}))}
              style={{width:50,textAlign:"center",fontSize:12,fontWeight:700,padding:4,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)"}} />
            <button onClick={() => setSelQty(p => ({...p, [d.pos]: Math.min(d.qty, (p[d.pos] ?? d.qty) + 1)}))}
              style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",fontSize:14,fontWeight:700,border:"1px solid var(--bg4)",color:"var(--txt)"}}>+</button>
          </div>
          <button onClick={() => doReasignar(d.pos, selQty[d.pos] ?? d.qty)} disabled={saving || !selFormato[d.pos]}
            style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:700,
              background:selFormato[d.pos]?"var(--green)":"var(--bg3)",color:selFormato[d.pos]?"#fff":"var(--txt3)",
              border:"none",cursor:selFormato[d.pos]?"pointer":"not-allowed",opacity:saving?0.5:1}}>
            {saving ? "..." : "Asignar"}
          </button>
        </div>
      ))}
    </div>
  );
}

// ==================== MOVIMIENTOS ====================
function Movimientos() {
  const [filterType, setFilterType] = useState<"all"|"in"|"out">("all");
  const [filterSku, setFilterSku] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterReason, setFilterReason] = useState("");
  const [editNoteId, setEditNoteId] = useState<string|null>(null);
  const [editNoteVal, setEditNoteVal] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [,setTick] = useState(0);
  const s = getStore();

  let movs = [...s.movements];
  if (filterType !== "all") movs = movs.filter(m => m.type === filterType);
  if (filterSku) { const q = filterSku.toLowerCase(); movs = movs.filter(m => m.sku.toLowerCase().includes(q) || s.products[m.sku]?.name.toLowerCase().includes(q)); }
  if (filterDate) movs = movs.filter(m => m.ts.startsWith(filterDate));
  if (filterReason) movs = movs.filter(m => m.reason === filterReason);

  const totalIn = movs.filter(m=>m.type==="in").reduce((s,m)=>s+m.qty,0);
  const totalOut = movs.filter(m=>m.type==="out").reduce((s,m)=>s+m.qty,0);

  const allReasons = [...Object.keys(IN_REASONS), ...Object.keys(OUT_REASONS)];

  const openEditNote = (m: Movement) => { setEditNoteId(m.id); setEditNoteVal(m.note || ""); };
  const saveNote = async () => {
    if (!editNoteId) return;
    setSavingNote(true);
    await updateMovementNote(editNoteId, editNoteVal);
    setSavingNote(false);
    setEditNoteId(null);
    setTick(t => t + 1);
  };

  return (
    <div>
      {/* Modal editar nota */}
      {editNoteId && (() => {
        const m = movs.find(x => x.id === editNoteId);
        return (
          <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
            onClick={() => !savingNote && setEditNoteId(null)}>
            <div style={{width:"100%",maxWidth:440,background:"var(--bg2)",borderRadius:14,border:"1px solid var(--bg4)",padding:24}}
              onClick={e => e.stopPropagation()}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:8}}>Editar nota</div>
              {m && (
                <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>
                  <span className="mono" style={{fontWeight:700}}>{m.sku}</span> — {m.type === "in" ? "Entrada" : "Salida"} {m.qty} uds — {fmtDate(m.ts)} {fmtTime(m.ts)}
                </div>
              )}
              <textarea className="form-input" value={editNoteVal} onChange={e => setEditNoteVal(e.target.value)}
                placeholder="Escribe una nota..." rows={3} autoFocus
                style={{width:"100%",marginBottom:12,resize:"vertical",fontSize:13}} />
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <button onClick={() => setEditNoteId(null)} disabled={savingNote}
                  style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
                  Cancelar
                </button>
                <button onClick={saveNote} disabled={savingNote}
                  style={{padding:"8px 16px",borderRadius:6,background:savingNote?"var(--bg3)":"var(--green)",color:savingNote?"var(--txt3)":"#fff",fontSize:12,fontWeight:700}}>
                  {savingNote ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card">
        <div className="admin-filter-row">
          <div style={{display:"flex",gap:6}}>
            {(["all","in","out"] as const).map(t=>(
              <button key={t} onClick={()=>setFilterType(t)} style={{padding:"8px 14px",borderRadius:8,fontSize:12,fontWeight:600,
                background:filterType===t?"var(--bg4)":"var(--bg3)",color:filterType===t?"var(--txt)":"var(--txt3)",border:"1px solid var(--bg4)"}}>
                {t==="all"?"Todos":t==="in"?"Entradas":"Salidas"}</button>
            ))}
          </div>
          <div style={{display:"flex",gap:6,flex:1}}>
            <input className="form-input mono" value={filterSku} onChange={e=>setFilterSku(e.target.value.toUpperCase())} placeholder="SKU o nombre..." style={{fontSize:12,padding:8,flex:1}}/>
            <input type="date" className="form-input" value={filterDate} onChange={e=>setFilterDate(e.target.value)} style={{fontSize:12,padding:8,width:140}}/>
            <select className="form-select" value={filterReason} onChange={e=>setFilterReason(e.target.value)} style={{fontSize:12,padding:8,width:160}}>
              <option value="">Todos los motivos</option>
              {allReasons.map(r=><option key={r} value={r}>{(IN_REASONS as any)[r]||(OUT_REASONS as any)[r]}</option>)}
            </select>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,fontSize:12}}>
          <span style={{color:"var(--txt3)"}}>{movs.length} movimientos</span>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <span><span style={{color:"var(--green)",fontWeight:600}}>+{totalIn.toLocaleString("es-CL")}</span> / <span style={{color:"var(--red)",fontWeight:600}}>-{totalOut.toLocaleString("es-CL")}</span></span>
            <button onClick={() => {
              const header = "ID,Fecha,Hora,Tipo,Motivo,SKU,Producto,Posición,Operador,Nota,Cantidad";
              const rows = movs.map(m => {
                const prod = s.products[m.sku];
                const reason = (IN_REASONS as any)[m.reason] || (OUT_REASONS as any)[m.reason] || m.reason;
                const escapeCsv = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? '"' + v.replace(/"/g, '""') + '"' : v;
                return [
                  m.id, fmtDate(m.ts), fmtTime(m.ts),
                  m.type === "in" ? "ENTRADA" : "SALIDA",
                  escapeCsv(reason), m.sku, escapeCsv(prod?.name || ""),
                  m.pos, escapeCsv(m.who || ""), escapeCsv(m.note || ""),
                  (m.type === "in" ? "" : "-") + m.qty
                ].join(",");
              });
              const csv = "\uFEFF" + header + "\n" + rows.join("\n");
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `movimientos_${filterDate || new Date().toISOString().slice(0,10)}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }} style={{padding:"4px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer"}}>
              Exportar CSV
            </button>
          </div>
        </div>
      </div>

      {/* Desktop table */}
      <div className="desktop-only">
        <div className="card" style={{padding:0,overflow:"hidden"}}>
          <table className="tbl">
            <thead><tr><th>ID</th><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>SKU</th><th>Producto</th><th>Pos</th><th>Operador</th><th>Nota/Ref</th><th style={{textAlign:"right"}}>Qty</th></tr></thead>
            <tbody>{movs.slice(0,100).map(m=>{
              const prod=s.products[m.sku];
              return(
                <tr key={m.id}>
                  <td className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{m.id}</td>
                  <td style={{fontSize:11,whiteSpace:"nowrap"}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</td>
                  <td><span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"ENTRADA":"SALIDA"}</span></td>
                  <td style={{fontSize:11}}>{(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]}</td>
                  <td className="mono" style={{fontWeight:600,fontSize:12}}>{m.sku}</td>
                  <td style={{fontSize:11,color:"var(--txt2)"}}>{prod?.name}</td>
                  <td className="mono">{m.pos}</td>
                  <td style={{fontSize:11}}>{m.who}</td>
                  <td onClick={() => openEditNote(m)} style={{fontSize:10,color:m.note?"var(--cyan)":"var(--txt3)",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",cursor:"pointer"}} title="Click para editar nota">{m.note || "—"}</td>
                  <td className="mono" style={{textAlign:"right",fontWeight:700,fontSize:14,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mobile-only">
        {movs.slice(0,50).map(m=>{
          const prod=s.products[m.sku];
          return(
            <div key={m.id} className="mov-row" style={{marginTop:4}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{display:"flex",gap:4,alignItems:"center",marginBottom:2}}>
                    <span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"ENTRADA":"SALIDA"}</span>
                    <span className="tag">{(IN_REASONS as any)[m.reason]||(OUT_REASONS as any)[m.reason]}</span>
                  </div>
                  <div className="mono" style={{fontWeight:700,fontSize:13}}>{m.sku} <span style={{fontWeight:400,color:"var(--txt3)"}}>{prod?.name}</span></div>
                  <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>Pos {m.pos} | {m.who} | {fmtDate(m.ts)} {fmtTime(m.ts)}</div>
                  <div onClick={() => openEditNote(m)} style={{fontSize:10,color:m.note?"var(--cyan)":"var(--txt3)",marginTop:1,cursor:"pointer"}}>{m.note || "Agregar nota..."}</div>
                </div>
                <div className="mono" style={{fontSize:18,fontWeight:700,color:m.type==="in"?"var(--green)":"var(--red)",whiteSpace:"nowrap"}}>{m.type==="in"?"+":"-"}{m.qty}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== PRODUCTOS ====================
function Productos({ refresh }: { refresh: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editSku, setEditSku] = useState<string|null>(null);
  const [q, setQ] = useState("");
  const s = getStore();
  const prods = Object.values(s.products).filter(p=>{
    if(!q)return true;const ql=q.toLowerCase();
    return p.sku.toLowerCase().includes(ql)||p.name.toLowerCase().includes(ql)||p.mlCode.toLowerCase().includes(ql)||p.cat.toLowerCase().includes(ql)||p.prov.toLowerCase().includes(ql);
  }).sort((a,b)=>a.sku.localeCompare(b.sku));

  const [form, setForm] = useState<Partial<Product>>({sku:"",name:"",mlCode:"",cat:getCategorias()[0],prov:getProveedores()[0],cost:0,price:0,reorder:20});
  const startEdit=(p:Product)=>{setForm({...p});setEditSku(p.sku);setShowAdd(true);};
  const startAdd=()=>{setForm({sku:"",name:"",mlCode:"",cat:getCategorias()[0],prov:getProveedores()[0],cost:0,price:0,reorder:20});setEditSku(null);setShowAdd(true);};
  const save=()=>{
    if(!form.sku||!form.name)return;
    const sku=form.sku.toUpperCase();
    s.products[sku]={sku,skuVenta:"",name:form.name!,mlCode:form.mlCode||"",cat:form.cat||"Otros",prov:form.prov||"Otro",cost:form.cost||0,price:form.price||0,reorder:form.reorder||20};
    saveStore();setShowAdd(false);setEditSku(null);refresh();
  };
  const remove=(sku:string)=>{
    const stock = skuTotal(sku);
    if(stock > 0){
      if(!confirm("⚠️ "+sku+" tiene "+stock+" unidades en stock.\n\nSi eliminas el producto, el stock quedará huérfano.\n\n¿Eliminar producto Y su stock?")) return;
      // Clean orphan stock
      delete s.stock[sku];
    } else {
      if(!confirm("Eliminar "+sku+"?")) return;
    }
    delete s.products[sku];
    saveStore();refresh();
  };

  return(
    <div>
      <div className="card">
        <div style={{display:"flex",gap:8}}>
          <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder="Buscar SKU, nombre, código ML..." style={{flex:1,fontSize:12}}/>
          <button onClick={startAdd} style={{padding:"10px 20px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13,whiteSpace:"nowrap"}}>+ Nuevo Producto</button>
        </div>
        <div style={{fontSize:11,color:"var(--txt3)",marginTop:6}}>{prods.length} productos en diccionario</div>
      </div>

      {showAdd&&(
        <div className="card" style={{border:"2px solid var(--cyan)"}}>
          <div className="card-title">{editSku?"Editar "+editSku:"Nuevo Producto"}</div>
          <div className="admin-form-grid">
            <div className="form-group"><label className="form-label">SKU *</label><input className="form-input mono" value={form.sku||""} onChange={e=>setForm({...form,sku:e.target.value.toUpperCase()})} disabled={!!editSku}/></div>
            <div className="form-group"><label className="form-label">Código ML</label><input className="form-input mono" value={form.mlCode||""} onChange={e=>setForm({...form,mlCode:e.target.value})}/></div>
            <div className="form-group" style={{gridColumn:"span 2"}}><label className="form-label">Nombre *</label><input className="form-input" value={form.name||""} onChange={e=>setForm({...form,name:e.target.value})}/></div>
            <div className="form-group"><label className="form-label">Categoría</label><select className="form-select" value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}>{getCategorias().map(c=><option key={c}>{c}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Proveedor</label><select className="form-select" value={form.prov} onChange={e=>setForm({...form,prov:e.target.value})}>{getProveedores().map(p=><option key={p}>{p}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Costo</label><input type="number" className="form-input mono" value={form.cost||""} onChange={e=>setForm({...form,cost:parseInt(e.target.value)||0})}/></div>
            <div className="form-group"><label className="form-label">Precio ML</label><input type="number" className="form-input mono" value={form.price||""} onChange={e=>setForm({...form,price:parseInt(e.target.value)||0})}/></div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={()=>{setShowAdd(false);setEditSku(null);}} style={{flex:1,padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
            <button onClick={save} disabled={!form.sku||!form.name} style={{flex:2,padding:10,borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700}}>Guardar</button>
          </div>
        </div>
      )}

      {/* Desktop table */}
      <div className="desktop-only">
        <div className="card" style={{padding:0,overflow:"hidden"}}>
          <table className="tbl">
            <thead><tr><th>SKU Origen</th><th>Nombre</th><th>Publicaciones ML</th><th>Cat.</th><th>Prov.</th><th style={{textAlign:"right"}}>Costo</th><th style={{textAlign:"right"}}>Stock</th><th style={{textAlign:"right"}}>Vendible</th><th></th></tr></thead>
            <tbody>{prods.map(p=>{
              const ventas = getVentasPorSkuOrigen(p.sku);
              const stock = skuTotal(p.sku);
              return (
              <tr key={p.sku}>
                <td className="mono" style={{fontWeight:700,fontSize:12}}>{p.sku}</td>
                <td style={{fontSize:12}}>{p.name}</td>
                <td style={{fontSize:11}}>
                  {ventas.length > 0 ? ventas.map((v, i) => (
                    <div key={i} style={{display:"flex",alignItems:"center",gap:4,marginBottom:i<ventas.length-1?2:0}}>
                      <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,whiteSpace:"nowrap",
                        background:v.unidades>1?"var(--amber)15":"var(--cyan)15",
                        color:v.unidades>1?"var(--amber)":"var(--cyan)"}}>
                        {v.unidades>1?`x${v.unidades}`:"x1"}
                      </span>
                      <span className="mono" style={{fontSize:10}}>{v.codigoMl}</span>
                      <span style={{fontSize:9,color:"var(--txt3)"}}>{v.skuVenta}</span>
                    </div>
                  )) : <span style={{color:"var(--txt3)"}}>Sin publicación</span>}
                </td>
                <td><span className="tag">{p.cat}</span></td>
                <td><span className="tag">{p.prov}</span></td>
                <td className="mono" style={{textAlign:"right",fontSize:11}}>{fmtMoney(p.cost)}</td>
                <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{stock}</td>
                <td style={{textAlign:"right",fontSize:11}}>
                  {ventas.length > 0 ? ventas.map((v, i) => {
                    const sellable = Math.floor(stock / v.unidades);
                    return (
                      <div key={i} style={{color:sellable>0?"var(--green)":"var(--red)",fontWeight:600}}>
                        {sellable}{v.unidades>1?` pack${sellable!==1?"s":""}`:""}</div>
                    );
                  }) : <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{stock}</span>}
                </td>
                <td style={{textAlign:"right"}}>
                  <button onClick={()=>startEdit(p)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)",marginRight:4}}>Editar</button>
                  <button onClick={()=>remove(p.sku)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </td>
              </tr>);
            })}</tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mobile-only">
        {prods.map(p=>{
          const ventas = getVentasPorSkuOrigen(p.sku);
          const stock = skuTotal(p.sku);
          return (
          <div key={p.sku} className="card" style={{marginTop:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <div className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</div>
                <div style={{fontSize:12,color:"var(--txt2)"}}>{p.name}</div>
                <div style={{display:"flex",gap:4,marginTop:3,flexWrap:"wrap"}}><span className="tag">{p.cat}</span><span className="tag">{p.prov}</span></div>
                <div style={{fontSize:10,color:"var(--txt3)",marginTop:3}}>Costo: {fmtMoney(p.cost)} | Stock: <strong style={{color:"var(--blue)"}}>{stock}</strong> uds</div>
                {ventas.length > 0 && (
                  <div style={{marginTop:4,borderTop:"1px solid var(--bg4)",paddingTop:4}}>
                    <div style={{fontSize:10,color:"var(--txt3)",fontWeight:600,marginBottom:2}}>Publicaciones:</div>
                    {ventas.map((v, i) => {
                      const sellable = Math.floor(stock / v.unidades);
                      return (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,marginBottom:1}}>
                          <span style={{fontWeight:700,padding:"1px 4px",borderRadius:3,
                            background:v.unidades>1?"var(--amber)15":"var(--cyan)15",
                            color:v.unidades>1?"var(--amber)":"var(--cyan)"}}>
                            {v.unidades>1?`Pack x${v.unidades}`:"x1"}
                          </span>
                          <span className="mono">{v.codigoMl}</span>
                          <span style={{color:sellable>0?"var(--green)":"var(--red)",fontWeight:600,marginLeft:"auto"}}>
                            {sellable} vendibles
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:4,marginLeft:8}}>
                <button onClick={()=>startEdit(p)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Editar</button>
                <button onClick={()=>remove(p.sku)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
              </div>
            </div>
          </div>);
        })}
      </div>
    </div>
  );
}

// ==================== POSICIONES ====================
function Posiciones({ refresh }: { refresh: () => void }) {
  const s = getStore();
  const [newId,setNewId]=useState("");const [newLabel,setNewLabel]=useState("");const [newType,setNewType]=useState<"pallet"|"shelf">("pallet");
  const addPos=()=>{
    if(!newId.trim())return;const id=newId.trim();
    if(s.positions.find(p=>p.id===id)){alert("Ya existe "+id);return;}
    s.positions.push({id,label:newLabel||("Posición "+id),type:newType,active:true});
    saveStore();setNewId("");setNewLabel("");refresh();
  };
  const toggleActive=(id:string)=>{const p=s.positions.find(x=>x.id===id);if(p){p.active=!p.active;saveStore();refresh();}};
  const removePos=(id:string)=>{
    const items=posContents(id);if(items.length>0){alert("Tiene stock, no se puede eliminar");return;}
    if(!confirm("Eliminar "+id+"?"))return;s.positions=s.positions.filter(p=>p.id!==id);saveStore();refresh();
  };
  const pallets=s.positions.filter(p=>p.type==="pallet");const shelves=s.positions.filter(p=>p.type==="shelf");

  return(
    <div>
      <div className="card">
        <div className="card-title">Agregar nueva posición</div>
        <div className="admin-form-grid">
          <div className="form-group"><label className="form-label">ID</label><input className="form-input mono" value={newId} onChange={e=>setNewId(e.target.value)} placeholder="ej: 21"/></div>
          <div className="form-group"><label className="form-label">Nombre</label><input className="form-input" value={newLabel} onChange={e=>setNewLabel(e.target.value)} placeholder="ej: Posición 21"/></div>
          <div className="form-group"><label className="form-label">Tipo</label><select className="form-select" value={newType} onChange={e=>setNewType(e.target.value as any)}><option value="pallet">Pallet</option><option value="shelf">Estante</option></select></div>
          <div className="form-group" style={{display:"flex",alignItems:"flex-end"}}><button onClick={addPos} disabled={!newId.trim()} style={{width:"100%",padding:10,borderRadius:8,background:newId.trim()?"var(--green)":"var(--bg3)",color:newId.trim()?"#fff":"var(--txt3)",fontWeight:700}}>+ Agregar</button></div>
        </div>
      </div>

      <div className="admin-grid-2">
        <div className="card">
          <div className="card-title">Pallets / Piso ({pallets.length})</div>
          {pallets.map(p=>{const items=posContents(p.id);const totalQ=items.reduce((s,i)=>s+i.qty,0);return(
            <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--bg3)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span className="mono" style={{fontWeight:700,fontSize:16,color:p.active?"var(--green)":"var(--txt3)",minWidth:40}}>{p.id}</span>
                <div><div style={{fontSize:12}}>{p.label}</div>{!p.active&&<span style={{fontSize:9,color:"var(--red)"}}>INACTIVA</span>}
                  {items.length>0&&<div style={{fontSize:10,color:"var(--txt3)"}}>{items.map(i=>i.sku+":"+i.qty).join(", ")}</div>}
                </div>
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                {totalQ>0&&<span className="mono" style={{fontSize:12,color:"var(--blue)",fontWeight:600}}>{totalQ}</span>}
                <button onClick={()=>toggleActive(p.id)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:p.active?"var(--amber)":"var(--green)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>{p.active?"Desact.":"Activar"}</button>
                <button onClick={()=>removePos(p.id)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
              </div>
            </div>
          );})}
        </div>
        <div className="card">
          <div className="card-title">Estantes ({shelves.length})</div>
          {shelves.map(p=>{const items=posContents(p.id);const totalQ=items.reduce((s,i)=>s+i.qty,0);return(
            <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--bg3)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span className="mono" style={{fontWeight:700,fontSize:16,color:p.active?"var(--blue)":"var(--txt3)",minWidth:50}}>{p.id}</span>
                <div><div style={{fontSize:12}}>{p.label}</div>{!p.active&&<span style={{fontSize:9,color:"var(--red)"}}>INACTIVA</span>}
                  {items.length>0&&<div style={{fontSize:10,color:"var(--txt3)"}}>{items.map(i=>i.sku+":"+i.qty).join(", ")}</div>}
                </div>
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                {totalQ>0&&<span className="mono" style={{fontSize:12,color:"var(--blue)",fontWeight:600}}>{totalQ}</span>}
                <button onClick={()=>toggleActive(p.id)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:p.active?"var(--amber)":"var(--green)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>{p.active?"Desact.":"Activar"}</button>
                <button onClick={()=>removePos(p.id)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
              </div>
            </div>
          );})}
          {shelves.length===0&&<div style={{fontSize:12,color:"var(--txt3)",padding:12}}>No hay estantes creados</div>}
        </div>
      </div>
    </div>
  );
}

// ==================== CARGA DE STOCK ====================
function CargaStock({ refresh }: { refresh: () => void }) {
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{imported:number;skipped:number;totalUnits:number}|null>(null);
  const [imported, setImported] = useState(false);
  const [,setTick] = useState(0);
  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");

  useEffect(() => { setImported(wasStockImported()); }, []);

  const doImport = async () => {
    if (!confirm("Esto importará las unidades de la columna K de tu Google Sheet y las dejará en posición 'SIN_ASIGNAR' para que luego les asignes ubicación.\n\n¿Continuar?")) return;
    setImporting(true);
    const result = await importStockFromSheet();
    setImportResult(result);
    setImported(true);
    setImporting(false);
    refresh();
  };

  const unassigned = getUnassignedStock();
  const totalUnassigned = unassigned.reduce((s, u) => s + u.qty, 0);

  // Split assign state: each SKU can have multiple {pos, qty} rows
  const [splits, setSplits] = useState<Record<string, {pos:string;qty:number}[]>>({});

  return (
    <div>
      {/* Step 1: Import */}
      <div className="card">
        <div className="card-title">Paso 1 — Importar stock desde Google Sheet</div>
        {!imported ? (
          <div>
            <p style={{fontSize:12,color:"var(--txt2)",marginBottom:12,lineHeight:1.6}}>
              Lee la columna K (unidades) de tu Sheet sincronizado y carga el stock actual de cada SKU.
              Las unidades quedarán en posición "SIN_ASIGNAR" hasta que les asignes ubicación en el Paso 2.
            </p>
            <button onClick={doImport} disabled={importing}
              style={{width:"100%",padding:14,borderRadius:10,background:importing?"var(--bg3)":"var(--green)",color:importing?"var(--txt3)":"#fff",fontWeight:700,fontSize:14}}>
              {importing ? "Importando..." : "Importar stock desde Sheet"}
            </button>
          </div>
        ) : (
          <div>
            <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,fontSize:12}}>
              <span style={{color:"var(--green)",fontWeight:700}}>Stock importado</span>
              {importResult && <span style={{color:"var(--txt2)",marginLeft:8}}>— {importResult.imported} SKUs, {importResult.totalUnits.toLocaleString()} unidades</span>}
            </div>
            <button onClick={()=>{
              if(!confirm("Reimportar? Esto reemplazará el stock en SIN_ASIGNAR con los datos actuales del Sheet (no duplica)."))return;
              if(typeof window!=="undefined")localStorage.removeItem("banva_stock_imported");
              setImported(false);setImportResult(null);
            }} style={{marginTop:8,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--amber)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              Reimportar (seguro, no duplica)
            </button>
          </div>
        )}
      </div>

      {/* Step 2: Assign positions */}
      {unassigned.length > 0 && (
        <div className="card" style={{marginTop:12}}>
          <div className="card-title">Paso 2 — Asignar posiciones ({unassigned.length} SKUs, {totalUnassigned.toLocaleString()} uds sin ubicación)</div>

          {/* Quick assign all to same position */}
          <div style={{padding:"10px 14px",background:"var(--bg2)",borderRadius:8,marginBottom:12,display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:600,color:"var(--txt3)"}}>Asignar todos (100%) a una posición:</span>
            <select className="form-select" id="bulkPos" style={{fontSize:11,padding:6,flex:"1",maxWidth:200}}>
              <option value="">— Posición —</option>
              {positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
            </select>
            <button onClick={()=>{
              const sel = (document.getElementById("bulkPos") as HTMLSelectElement)?.value;
              if(!sel) return;
              const newA: Record<string, {pos:string;qty:number}[]> = {};
              unassigned.forEach(u => { newA[u.sku] = [{pos:sel,qty:u.qty}]; });
              setSplits(newA);
            }} style={{padding:"6px 14px",borderRadius:6,background:"var(--blue)",color:"#fff",fontSize:11,fontWeight:700}}>Aplicar a todos</button>
          </div>

          {/* Confirm all button */}
          {(() => {
            const ready = unassigned.filter(u => {
              const sp = splits[u.sku];
              if(!sp || sp.length===0) return false;
              const total = sp.reduce((s,r)=>s+r.qty,0);
              return total === u.qty && sp.every(r=>r.pos && r.qty>0);
            });
            return ready.length > 0 ? (
              <button onClick={()=>{
                if(!confirm(`Asignar ${ready.length} SKUs a sus posiciones?`))return;
                let count=0;
                ready.forEach(u=>{
                  const sp = splits[u.sku];
                  sp.forEach(r=>{ if(assignPosition(u.sku,r.pos,r.qty)) count++; });
                });
                setSplits({});setTick(t=>t+1);refresh();
                alert(`${count} asignaciones realizadas`);
              }} style={{width:"100%",padding:12,borderRadius:10,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13,marginBottom:12}}>
                Confirmar {ready.length} SKUs listos para asignar
              </button>
            ) : null;
          })()}

          {/* SKU list */}
          {unassigned.map(u => {
            const sp = splits[u.sku] || [];
            const assigned = sp.reduce((s,r)=>s+r.qty,0);
            const remaining = u.qty - assigned;
            const isComplete = remaining === 0 && sp.every(r=>r.pos && r.qty>0);
            const isOver = remaining < 0;

            return (
              <div key={u.sku} style={{padding:"12px 14px",marginBottom:8,borderRadius:8,background:isComplete?"var(--greenBg)":isOver?"var(--redBg)":"var(--bg2)",border:`1px solid ${isComplete?"var(--greenBd)":isOver?"var(--red)":"var(--bg3)"}`}}>
                {/* Header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:sp.length>0?8:0}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:13}}>{u.sku}</span>
                    <span style={{fontSize:11,color:"var(--txt3)",marginLeft:8}}>{u.name}</span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span className="mono" style={{fontWeight:700,color:"var(--blue)",fontSize:15}}>{u.qty}</span>
                    <span style={{fontSize:10,color:"var(--txt3)",marginLeft:4}}>uds</span>
                    {sp.length > 0 && remaining !== 0 && (
                      <div style={{fontSize:10,color:isOver?"var(--red)":"var(--amber)",fontWeight:600}}>
                        {isOver ? `${Math.abs(remaining)} de más` : `${remaining} sin asignar`}
                      </div>
                    )}
                    {isComplete && <div style={{fontSize:10,color:"var(--green)",fontWeight:700}}>Listo</div>}
                  </div>
                </div>

                {/* Split rows */}
                {sp.map((row, idx) => (
                  <div key={idx} style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
                    <select className="form-select" value={row.pos} onChange={e=>{
                      const n=[...sp]; n[idx]={...n[idx],pos:e.target.value}; setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{fontSize:11,padding:6,flex:1}}>
                      <option value="">Posición...</option>
                      {positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                    </select>
                    <input type="number" min={1} max={u.qty} value={row.qty||""} onFocus={e=>e.target.select()} onChange={e=>{
                      const n=[...sp]; n[idx]={...n[idx],qty:Math.max(0,parseInt(e.target.value)||0)}; setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{width:70,textAlign:"center",padding:6,borderRadius:6,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt1)",fontSize:12,fontWeight:700}} placeholder="Cant"/>
                    <button onClick={()=>{
                      const n=sp.filter((_,i)=>i!==idx); setSplits(s=>({...s,[u.sku]:n}));
                    }} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)"}}>✕</button>
                  </div>
                ))}

                {/* Add row / quick buttons */}
                <div style={{display:"flex",gap:6,marginTop:sp.length>0?4:0,flexWrap:"wrap"}}>
                  {sp.length === 0 && (
                    <button onClick={()=>{
                      setSplits(s=>({...s,[u.sku]:[{pos:"",qty:u.qty}]}));
                    }} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--blue)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
                      Todo a 1 posición
                    </button>
                  )}
                  <button onClick={()=>{
                    const defQty = Math.max(0, remaining);
                    setSplits(s=>({...s,[u.sku]:[...sp,{pos:"",qty:defQty}]}));
                  }} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
                    + Dividir en otra posición
                  </button>
                  {isComplete && (
                    <button onClick={()=>{
                      sp.forEach(r=>{ assignPosition(u.sku,r.pos,r.qty); });
                      setSplits(s=>{const n={...s};delete n[u.sku];return n;});
                      setTick(t=>t+1);refresh();
                    }} style={{padding:"6px 14px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:11,fontWeight:700,marginLeft:"auto"}}>
                      Asignar
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {imported && unassigned.length === 0 && (
        <div className="card" style={{marginTop:12,textAlign:"center",padding:24}}>
          <div style={{fontSize:16,fontWeight:700,color:"var(--green)",marginBottom:4}}>Todo el stock tiene posición asignada</div>
          <div style={{fontSize:12,color:"var(--txt3)"}}>Puedes ver el inventario completo en la pestaña Inventario</div>
        </div>
      )}

      {/* Bulk paste with positions */}
      <CargaMasivaPosiciones refresh={refresh} />

      {/* Export / Import CSV */}
      <ExportImportCSV refresh={refresh} />
    </div>
  );
}

function CargaMasivaPosiciones({ refresh }: { refresh: () => void }) {
  const [pasteText, setPasteText] = useState("");
  const [parsed, setParsed] = useState<{pos:string;sku:string;qty:number;name:string;valid:boolean;error?:string}[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ok:number;err:number}|null>(null);

  const doParse = () => {
    if (!pasteText.trim()) return;
    const lines = pasteText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const items: typeof parsed = [];
    const s = getStore();
    const posSet = new Set(activePositions().map(p => p.id));

    for (const line of lines) {
      // Support tab, comma, semicolon, or multiple spaces as separator
      const parts = line.split(/[\t,;]+|\s{2,}/).map(p => p.trim()).filter(p => p);
      if (parts.length < 3) {
        items.push({ pos: "", sku: line, qty: 0, name: "", valid: false, error: "Formato: Posición | SKU | Cantidad" });
        continue;
      }
      const pos = parts[0].toUpperCase();
      const sku = parts[1].toUpperCase();
      const qty = parseInt(parts[2]) || 0;

      const prod = s.products[sku];
      const errors: string[] = [];
      if (!posSet.has(pos)) errors.push(`Posición "${pos}" no existe`);
      if (!prod) errors.push(`SKU "${sku}" no encontrado`);
      if (qty <= 0) errors.push("Cantidad inválida");

      items.push({
        pos, sku, qty, name: prod?.name || "?",
        valid: errors.length === 0, error: errors.join(", "),
      });
    }
    setParsed(items);
    setResult(null);
  };

  const doImport = async () => {
    const valid = parsed.filter(p => p.valid);
    if (valid.length === 0) return;
    if (!confirm(`Importar ${valid.length} líneas de stock con posición asignada?\n\nEsto AGREGA al stock existente (no reemplaza).`)) return;
    setLoading(true);
    let ok = 0, err = 0;
    for (const item of valid) {
      try {
        recordMovement({
          ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason,
          sku: item.sku, pos: item.pos, qty: item.qty,
          who: "Admin", note: "Carga masiva con posición",
        });
        ok++;
      } catch { err++; }
    }
    setResult({ ok, err });
    setLoading(false);
    setPasteText("");
    setParsed([]);
    refresh();
  };

  const validCount = parsed.filter(p => p.valid).length;
  const errorCount = parsed.filter(p => !p.valid).length;
  const totalUnits = parsed.filter(p => p.valid).reduce((s, p) => s + p.qty, 0);

  return (
    <div className="card" style={{marginTop:12}}>
      <div className="card-title">📋 Carga masiva con posiciones</div>
      <p style={{fontSize:12,color:"var(--txt3)",marginBottom:8,lineHeight:1.5}}>
        Pega datos con formato: <strong>Posición  SKU  Cantidad</strong> (separado por tab, coma o punto y coma). Una línea por entrada.
      </p>
      <div style={{padding:"8px 12px",background:"var(--bg2)",borderRadius:6,marginBottom:10,fontSize:11,fontFamily:"'JetBrains Mono',monospace",color:"var(--txt3)"}}>
        Ejemplo:<br/>
        1  SAB-180-BL  25<br/>
        1  ALM-VISCO  10<br/>
        3  TOA-70-GR  50<br/>
        E1-1  FUN-50-NE  12
      </div>
      <textarea
        value={pasteText} onChange={e => { setPasteText(e.target.value); setParsed([]); setResult(null); }}
        placeholder={"Posición\tSKU\tCantidad\n1\tSAB-180-BL\t25\n3\tTOA-70-GR\t50"}
        style={{width:"100%",minHeight:120,padding:10,borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",resize:"vertical",marginBottom:8}}
      />
      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <button onClick={doParse} disabled={!pasteText.trim()}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,background:pasteText.trim()?"var(--cyan)":"var(--bg3)",color:pasteText.trim()?"#000":"var(--txt3)"}}>
          Previsualizar ({pasteText.split("\n").filter(l=>l.trim()).length} líneas)
        </button>
        {parsed.length > 0 && <button onClick={()=>{setPasteText("");setParsed([]);}} style={{padding:"10px 16px",borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Limpiar</button>}
      </div>

      {result && (
        <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,marginBottom:12,fontSize:12}}>
          <span style={{color:"var(--green)",fontWeight:700}}>Importado: {result.ok} entradas, {totalUnits.toLocaleString()} unidades</span>
          {result.err > 0 && <span style={{color:"var(--red)",marginLeft:8}}>{result.err} errores</span>}
        </div>
      )}

      {parsed.length > 0 && (
        <>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:11}}>
              <span style={{color:"var(--green)",fontWeight:700}}>{validCount} OK</span>
              {errorCount > 0 && <span style={{color:"var(--red)",fontWeight:700,marginLeft:8}}>{errorCount} errores</span>}
              <span style={{color:"var(--txt3)",marginLeft:8}}>({totalUnits.toLocaleString()} uds)</span>
            </div>
          </div>
          <div style={{maxHeight:300,overflow:"auto",border:"1px solid var(--bg4)",borderRadius:8,marginBottom:12}}>
            {parsed.map((p, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--bg3)",background:p.valid?"transparent":"var(--redBg)",fontSize:11}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:p.valid?"var(--green)":"var(--red)",flexShrink:0}}/>
                <span className="mono" style={{fontWeight:700,color:"var(--cyan)",minWidth:40}}>{p.pos}</span>
                <span className="mono" style={{fontWeight:700,minWidth:100}}>{p.sku}</span>
                <span style={{flex:1,color:"var(--txt3)"}}>{p.name}</span>
                <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{p.qty}</span>
                {p.error && <span style={{color:"var(--red)",fontSize:10}}>⚠ {p.error}</span>}
              </div>
            ))}
          </div>
          {validCount > 0 && (
            <button onClick={doImport} disabled={loading}
              style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",background:"linear-gradient(135deg,#059669,var(--green))",opacity:loading?0.5:1}}>
              {loading ? "Importando..." : `IMPORTAR ${validCount} líneas — ${totalUnits.toLocaleString()} unidades`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ==================== EXPORT / IMPORT CSV INVENTARIO ====================
function ExportImportCSV({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"export"|"import">("export");
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<{sku:string;name:string;stock:number;pos:string;valid:boolean;error?:string;isNew?:boolean}[]>([]);
  const [importMode, setImportMode] = useState<"add"|"replace">("add");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ok:number;err:number;units:number}|null>(null);

  const doExport = () => {
    const s = getStore();
    const rows: string[] = [];
    rows.push(["sku_origen","nombre","sku_venta","etiquetado","unidades_pack","stock","posicion"].join(","));

    for (const [sku, svMap] of Object.entries(s.stockDetalle)) {
      const prod = s.products[sku];
      const name = prod?.name || "";
      const ventas = getVentasPorSkuOrigen(sku);

      for (const [skuVenta, posMap] of Object.entries(svMap)) {
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty <= 0) continue;
          const isSinEtiquetar = skuVenta === SIN_ETIQUETAR;
          const venta = ventas.find(v => v.skuVenta === skuVenta);
          rows.push([
            csvEscape(sku),
            csvEscape(name),
            csvEscape(isSinEtiquetar ? "" : skuVenta),
            isSinEtiquetar ? "Sin etiquetar" : "Etiquetado",
            venta ? String(venta.unidades) : "",
            String(qty),
            csvEscape(pos),
          ].join(","));
        }
      }
    }

    // SKUs in stock but not in stockDetalle (fallback)
    for (const [sku, posMap] of Object.entries(s.stock)) {
      if (s.stockDetalle[sku]) continue;
      const prod = s.products[sku];
      for (const [pos, qty] of Object.entries(posMap)) {
        if (qty <= 0) continue;
        rows.push([
          csvEscape(sku),
          csvEscape(prod?.name || ""),
          "",
          "Sin etiquetar",
          "",
          String(qty),
          csvEscape(pos),
        ].join(","));
      }
    }

    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `banva_inventario_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doExportSimple = () => {
    // Simplified: one row per (sku, pos), ventas joined
    const s = getStore();
    const rows: string[] = [];
    rows.push(["sku_origen","nombre","stock","posicion"].join(","));

    for (const [sku, posMap] of Object.entries(s.stock)) {
      const prod = s.products[sku];
      for (const [pos, qty] of Object.entries(posMap)) {
        if (qty <= 0) continue;
        rows.push([csvEscape(sku), csvEscape(prod?.name || ""), String(qty), csvEscape(pos)].join(","));
      }
    }

    const csv = rows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `banva_stock_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doParse = () => {
    if (!importText.trim()) return;
    const lines = importText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const items: typeof parsed = [];
    const s = getStore();
    const posSet = new Set(activePositions().map(p => p.id));
    posSet.add("SIN_ASIGNAR");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip header row
      if (i === 0 && /sku_origen|sku|nombre/i.test(line)) continue;

      // Parse CSV (handle quoted fields)
      const parts = parseCSVLine(line);
      
      // We need at minimum: sku_origen, and stock, posicion 
      // Full format: sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion
      // Simple format: sku_origen, stock, posicion  OR  sku_origen, nombre, stock, posicion
      let sku = "", name = "", stock = 0, pos = "";

      if (parts.length >= 7) {
        // Full format: sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion
        sku = parts[0].toUpperCase().trim();
        name = parts[1].trim();
        stock = parseInt(parts[5]) || 0;
        pos = parts[6].toUpperCase().trim();
      } else if (parts.length >= 4) {
        // 4-col: sku_origen, nombre, stock, posicion
        sku = parts[0].toUpperCase().trim();
        name = parts[1].trim();
        stock = parseInt(parts[2]) || 0;
        pos = parts[3].toUpperCase().trim();
      } else if (parts.length >= 3) {
        // 3-col: sku_origen, stock, posicion  OR  posicion, sku, stock (legacy)
        const maybeQty = parseInt(parts[2]);
        const maybeQty1 = parseInt(parts[1]);
        if (!isNaN(maybeQty) && isNaN(maybeQty1)) {
          // sku, ???, stock → sku, posicion, stock? or sku, stock, posicion?
          // Check if parts[2] looks like a number and parts[1] like a position
          if (posSet.has(parts[1].toUpperCase().trim())) {
            // sku, posicion, stock
            sku = parts[0].toUpperCase().trim();
            pos = parts[1].toUpperCase().trim();
            stock = maybeQty;
          } else {
            // sku, stock, posicion
            sku = parts[0].toUpperCase().trim();
            stock = parseInt(parts[1]) || 0;
            pos = parts[2].toUpperCase().trim();
          }
        } else if (!isNaN(maybeQty1)) {
          // posicion, sku, stock (legacy format)
          pos = parts[0].toUpperCase().trim();
          sku = parts[1].toUpperCase().trim();
          stock = maybeQty;
        } else {
          sku = parts[0].toUpperCase().trim();
          stock = parseInt(parts[1]) || 0;
          pos = parts[2].toUpperCase().trim();
        }
      } else {
        items.push({ sku: line, name: "", stock: 0, pos: "", valid: false, error: "Formato no reconocido" });
        continue;
      }

      const prod = s.products[sku];
      const errors: string[] = [];
      if (!sku) errors.push("SKU vacío");
      if (!prod) errors.push(`SKU "${sku}" no existe`);
      if (stock <= 0) errors.push("Stock inválido");
      if (!pos) errors.push("Posición vacía");
      if (pos && !posSet.has(pos)) errors.push(`Posición "${pos}" no existe`);

      items.push({
        sku, name: name || prod?.name || "?", stock, pos,
        valid: errors.length === 0, error: errors.join(", "),
        isNew: !prod,
      });
    }
    setParsed(items);
    setResult(null);
  };

  const doImport = async () => {
    const valid = parsed.filter(p => p.valid);
    if (valid.length === 0) return;
    const totalUnits = valid.reduce((s, p) => s + p.stock, 0);
    
    const modeText = importMode === "replace" 
      ? "⚠️ REEMPLAZAR: Se borrará TODO el stock actual y se cargará solo lo del CSV."
      : "AGREGAR: Se sumará el stock del CSV al existente.";
    
    if (!confirm(`${modeText}\n\n${valid.length} líneas, ${totalUnits.toLocaleString()} unidades.\n\n¿Continuar?`)) return;
    
    setLoading(true);
    let ok = 0, err = 0;

    if (importMode === "replace") {
      // Clear ALL existing stock first
      const s = getStore();
      for (const [sku, posMap] of Object.entries(s.stock)) {
        for (const [pos, qty] of Object.entries(posMap)) {
          if (qty > 0) {
            recordMovement({
              ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason,
              sku, pos, qty, who: "Admin", note: "CSV import — reset stock",
            });
          }
        }
      }
    }

    // Now add all lines
    for (const item of valid) {
      try {
        recordMovement({
          ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason,
          sku: item.sku, pos: item.pos, qty: item.stock,
          who: "Admin", note: `CSV import${importMode === "replace" ? " (reemplazo)" : ""}`,
        });
        ok++;
      } catch { err++; }
    }

    setResult({ ok, err, units: totalUnits });
    setLoading(false);
    setImportText("");
    setParsed([]);
    refresh();
  };

  const validCount = parsed.filter(p => p.valid).length;
  const errorCount = parsed.filter(p => !p.valid).length;
  const totalUnits = parsed.filter(p => p.valid).reduce((s, p) => s + p.stock, 0);

  // Count current stock for export info
  const s = getStore();
  const stockEntries = Object.entries(s.stock).reduce((count, [, posMap]) => 
    count + Object.values(posMap).filter(q => q > 0).length, 0);
  const totalStockUnits = Object.values(s.stock).reduce((total, posMap) => 
    total + Object.values(posMap).reduce((s, q) => s + Math.max(0, q), 0), 0);

  return (
    <div className="card" style={{marginTop:12}}>
      <div className="card-title">📤📥 Exportar / Importar CSV</div>
      
      <div style={{display:"flex",gap:4,marginBottom:12}}>
        <button onClick={()=>{setMode("export");setParsed([]);setResult(null);}}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,
            background:mode==="export"?"var(--cyan)":"var(--bg3)",
            color:mode==="export"?"#000":"var(--txt3)",
            border:`1px solid ${mode==="export"?"var(--cyan)":"var(--bg4)"}`}}>
          📤 Exportar
        </button>
        <button onClick={()=>{setMode("import");setResult(null);}}
          style={{flex:1,padding:10,borderRadius:8,fontWeight:700,fontSize:13,
            background:mode==="import"?"var(--green)":"var(--bg3)",
            color:mode==="import"?"#fff":"var(--txt3)",
            border:`1px solid ${mode==="import"?"var(--green)":"var(--bg4)"}`}}>
          📥 Importar
        </button>
      </div>

      {mode === "export" && (
        <div>
          <div style={{padding:"10px 14px",background:"var(--bg2)",borderRadius:8,marginBottom:12,fontSize:12,color:"var(--txt2)",lineHeight:1.6}}>
            <strong>{stockEntries}</strong> registros · <strong>{totalStockUnits.toLocaleString()}</strong> unidades totales
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={doExport}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background:"var(--cyan)",color:"#000",minWidth:160}}>
              📤 Completo (con ventas ML)
            </button>
            <button onClick={doExportSimple}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--cyan)33",minWidth:160}}>
              📤 Simple (SKU + stock + pos)
            </button>
          </div>
          <div style={{marginTop:8,fontSize:10,color:"var(--txt3)",lineHeight:1.5}}>
            <strong>Completo:</strong> sku_origen, nombre, sku_venta, etiquetado, unidades_pack, stock, posicion<br/>
            <strong>Simple:</strong> sku_origen, nombre, stock, posicion
          </div>
        </div>
      )}

      {mode === "import" && (
        <div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,fontWeight:700,marginBottom:6}}>Modo de importación:</div>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>setImportMode("add")}
                style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                  background:importMode==="add"?"var(--greenBg)":"var(--bg3)",
                  color:importMode==="add"?"var(--green)":"var(--txt3)",
                  border:`1px solid ${importMode==="add"?"var(--green)33":"var(--bg4)"}`}}>
                ➕ Agregar al existente
              </button>
              <button onClick={()=>setImportMode("replace")}
                style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                  background:importMode==="replace"?"var(--amberBg)":"var(--bg3)",
                  color:importMode==="replace"?"var(--amber)":"var(--txt3)",
                  border:`1px solid ${importMode==="replace"?"var(--amber)33":"var(--bg4)"}`}}>
                🔄 Reemplazar todo
              </button>
            </div>
            {importMode === "replace" && (
              <div style={{marginTop:6,padding:"6px 10px",background:"var(--amberBg)",borderRadius:6,fontSize:10,color:"var(--amber)",lineHeight:1.5}}>
                ⚠️ Reemplazar borra TODO el stock actual y carga solo lo del CSV. Úsalo para un conteo completo de inventario.
              </div>
            )}
          </div>

          <p style={{fontSize:11,color:"var(--txt3)",marginBottom:6,lineHeight:1.5}}>
            Pega CSV o datos separados por tab/coma. Acepta formato completo (7 cols) o simple (3-4 cols). La primera fila de encabezado se ignora automáticamente.
          </p>
          <div style={{padding:"6px 10px",background:"var(--bg2)",borderRadius:6,marginBottom:8,fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"var(--txt3)"}}>
            sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion<br/>
            SAB-180-BL, Sábana 180 Blanca, 1, MLC123, PACK-SAB, 25, 1<br/>
            — o simplemente —<br/>
            SAB-180-BL, 25, 1
          </div>

          <div style={{display:"flex",gap:6,marginBottom:8}}>
            <textarea
              value={importText} onChange={e => { setImportText(e.target.value); setParsed([]); setResult(null); }}
              placeholder="Pega datos CSV aquí..."
              style={{flex:1,minHeight:120,padding:10,borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt)",fontSize:12,fontFamily:"'JetBrains Mono',monospace",resize:"vertical"}}
            />
          </div>

          {/* Upload CSV file */}
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <label style={{flex:1,padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,textAlign:"center",cursor:"pointer",border:"1px dashed var(--bg4)"}}>
              📎 Subir archivo CSV
              <input type="file" accept=".csv,.txt,.tsv" hidden onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                  const text = ev.target?.result as string;
                  setImportText(text);
                  setParsed([]);
                  setResult(null);
                };
                reader.readAsText(file);
                e.target.value = "";
              }}/>
            </label>
            <button onClick={doParse} disabled={!importText.trim()}
              style={{padding:"10px 20px",borderRadius:8,fontWeight:700,fontSize:13,
                background:importText.trim()?"var(--cyan)":"var(--bg3)",
                color:importText.trim()?"#000":"var(--txt3)"}}>
              Previsualizar
            </button>
          </div>

          {result && (
            <div style={{padding:"10px 14px",background:"var(--greenBg)",border:"1px solid var(--greenBd)",borderRadius:8,marginBottom:12,fontSize:12}}>
              <span style={{color:"var(--green)",fontWeight:700}}>
                ✓ Importado: {result.ok} líneas, {result.units.toLocaleString()} unidades
                {importMode === "replace" && " (stock anterior reemplazado)"}
              </span>
              {result.err > 0 && <span style={{color:"var(--red)",marginLeft:8}}>{result.err} errores</span>}
            </div>
          )}

          {parsed.length > 0 && (
            <>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:11}}>
                  <span style={{color:"var(--green)",fontWeight:700}}>{validCount} OK</span>
                  {errorCount > 0 && <span style={{color:"var(--red)",fontWeight:700,marginLeft:8}}>{errorCount} errores</span>}
                  <span style={{color:"var(--txt3)",marginLeft:8}}>({totalUnits.toLocaleString()} uds)</span>
                </div>
                <button onClick={()=>{setParsed([]);setImportText("");}}
                  style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Limpiar</button>
              </div>
              <div style={{maxHeight:300,overflow:"auto",border:"1px solid var(--bg4)",borderRadius:8,marginBottom:12}}>
                {parsed.map((p, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",borderBottom:"1px solid var(--bg3)",background:p.valid?"transparent":"var(--redBg)",fontSize:11}}>
                    <span style={{width:8,height:8,borderRadius:"50%",background:p.valid?"var(--green)":"var(--red)",flexShrink:0}}/>
                    <span className="mono" style={{fontWeight:700,minWidth:100}}>{p.sku}</span>
                    <span style={{flex:1,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                    <span className="mono" style={{fontWeight:700,color:"var(--blue)",minWidth:36,textAlign:"right"}}>{p.stock}</span>
                    <span className="mono" style={{fontWeight:600,color:"var(--cyan)",minWidth:40}}>{p.pos}</span>
                    {p.error && <span style={{color:"var(--red)",fontSize:9}}>⚠ {p.error}</span>}
                  </div>
                ))}
              </div>
              {validCount > 0 && (
                <button onClick={doImport} disabled={loading}
                  style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",
                    background:importMode==="replace"
                      ?"linear-gradient(135deg,#d97706,#f59e0b)"
                      :"linear-gradient(135deg,#059669,var(--green))",
                    opacity:loading?0.5:1}}>
                  {loading ? "Importando..." 
                    : importMode==="replace" 
                      ? `🔄 REEMPLAZAR stock — ${validCount} líneas, ${totalUnits.toLocaleString()} uds`
                      : `➕ AGREGAR ${validCount} líneas — ${totalUnits.toLocaleString()} uds`
                  }
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function csvEscape(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function parseCSVLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i+1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === "," || ch === "\t" || ch === ";") { parts.push(current); current = ""; }
      else current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// ==================== PEDIDOS ML (Shipment-centric) ====================
function AdminPedidosFlex({ refresh }: { refresh: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [fecha, setFecha] = useState(today);
  const [shipments, setShipments] = useState<ShipmentWithItems[]>([]);
  const [pedidos, setPedidos] = useState<DBPedidoFlex[]>([]); // legacy (debug only)
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncDays, setSyncDays] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, unknown> | null>(null);
  const [mlConfig, setMlConfig] = useState<DBMLConfig | null>(null);
  const [configForm, setConfigForm] = useState({ client_id: "", client_secret: "", seller_id: "", hora_corte_lv: 13, hora_corte_sab: 12 });
  const [showLegacy, setShowLegacy] = useState(false); // hidden legacy table (debug only)
  const [storeFilter, setStoreFilter] = useState<number | null>(null); // store_id filter
  const [storeOptions, setStoreOptions] = useState<{ store_id: number; count: number }[]>([]);

  const loadPedidos = useCallback(async () => {
    setLoading(true);
    // Load ALL active shipments (ready_to_ship + pending/buffered) for Flex dispatch view
    try {
      const sData = await fetchActiveFlexShipments(storeFilter);
      setShipments(sData);
    } catch { setShipments([]); }
    // Load store options for filter dropdown
    try { const stores = await fetchStoreIds(); setStoreOptions(stores); } catch { /* ignore */ }
    // Legacy pedidos_flex (debug only)
    try { const data = await fetchPedidosFlex(fecha); setPedidos(data); } catch { setPedidos([]); }
    setLoading(false);
  }, [fecha, today, storeFilter]);

  const loadConfig = useCallback(async () => {
    const cfg = await fetchMLConfig();
    setMlConfig(cfg);
    if (cfg) {
      setConfigForm({
        client_id: cfg.client_id || "",
        client_secret: cfg.client_secret || "",
        seller_id: cfg.seller_id || "",
        hora_corte_lv: cfg.hora_corte_lv || 13,
        hora_corte_sab: cfg.hora_corte_sab || 12,
      });
    }
  }, []);

  useEffect(() => { loadPedidos(); loadConfig(); }, [loadPedidos, loadConfig]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const iv = setInterval(loadPedidos, 30_000);
    return () => clearInterval(iv);
  }, [loadPedidos]);

  // Shipment-centric labels & colors
  const LOGISTIC_LABELS: Record<string, string> = {
    self_service: "Flex", cross_docking: "Colecta", xd_drop_off: "Drop-off", drop_off: "Correo",
  };
  const LOGISTIC_COLORS: Record<string, string> = {
    self_service: "#10b981", cross_docking: "#f59e0b", xd_drop_off: "#a855f7", drop_off: "#6366f1",
  };

  // ===== FLEX DISPATCH CLASSIFICATION =====
  type FlexDispatchCategory = "DESPACHAR_HOY" | "DESPACHAR_MANANA" | "BUFFERED" | "YA_IMPRESO" | "ATRASADO";

  // Helper: extract YYYY-MM-DD in Chile timezone for proper date comparison
  const toChileDateStr = (d: Date): string => {
    const parts = d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" }); // en-CA = YYYY-MM-DD
    return parts; // "2026-03-09"
  };
  const todayChile = toChileDateStr(new Date());

  const classifyShipment = (s: ShipmentWithItems): FlexDispatchCategory => {
    // Buffered — ML hasn't released the label yet
    if (s.status === "pending" && s.substatus === "buffered") return "BUFFERED";
    // Already printed
    if (s.substatus === "printed") return "YA_IMPRESO";
    // Ready to print — classify HOY vs MAÑANA using handling_limit in Chile timezone
    if (s.substatus === "ready_to_print") {
      if (!s.handling_limit) return "DESPACHAR_HOY"; // no date = assume urgent
      const limitDay = toChileDateStr(new Date(s.handling_limit));
      if (limitDay < todayChile) return "ATRASADO";
      if (limitDay === todayChile) return "DESPACHAR_HOY";
      return "DESPACHAR_MANANA";
    }
    // Pending with ready_to_print (before ready_to_ship)
    if (s.status === "pending" && s.substatus === "ready_to_print") {
      if (!s.handling_limit) return "DESPACHAR_HOY";
      const limitDay = toChileDateStr(new Date(s.handling_limit));
      if (limitDay <= todayChile) return "DESPACHAR_HOY";
      return "DESPACHAR_MANANA";
    }
    // Other pending states
    return "BUFFERED";
  };

  const CATEGORY_CONFIG: Record<FlexDispatchCategory, { label: string; color: string; icon: string; order: number }> = {
    ATRASADO: { label: "Atrasados", color: "#ef4444", icon: "!!", order: 0 },
    DESPACHAR_HOY: { label: "Despachar HOY", color: "#10b981", icon: "", order: 1 },
    DESPACHAR_MANANA: { label: "Programados para MAÑANA", color: "#f59e0b", icon: "", order: 2 },
    BUFFERED: { label: "En espera (buffered)", color: "#3b82f6", icon: "", order: 3 },
    YA_IMPRESO: { label: "Ya impresos", color: "#94a3b8", icon: "", order: 4 },
  };

  // Classify all shipments
  const classifiedShipments = shipments.map(s => ({ ...s, _category: classifyShipment(s) }));

  // Group by category
  const categoryGroups = (() => {
    const groups: Record<FlexDispatchCategory, typeof classifiedShipments> = {
      ATRASADO: [], DESPACHAR_HOY: [], DESPACHAR_MANANA: [], BUFFERED: [], YA_IMPRESO: [],
    };
    for (const s of classifiedShipments) {
      groups[s._category].push(s);
    }
    return (Object.entries(groups) as [FlexDispatchCategory, typeof classifiedShipments][])
      .filter(([, ships]) => ships.length > 0)
      .sort(([a], [b]) => CATEGORY_CONFIG[a].order - CATEGORY_CONFIG[b].order);
  })();

  const shipCounts = {
    total: shipments.length,
    despacharHoy: classifiedShipments.filter(s => s._category === "DESPACHAR_HOY").length,
    despacharManana: classifiedShipments.filter(s => s._category === "DESPACHAR_MANANA").length,
    buffered: classifiedShipments.filter(s => s._category === "BUFFERED").length,
    atrasado: classifiedShipments.filter(s => s._category === "ATRASADO").length,
    yaImpreso: classifiedShipments.filter(s => s._category === "YA_IMPRESO").length,
    readyToPrint: shipments.filter(s => s.substatus === "ready_to_print").length,
    printed: shipments.filter(s => s.substatus === "printed").length,
  };
  // Legacy counts (only for debug)
  const legacyPendientes = pedidos.filter(p => p.estado === "PENDIENTE").length;

  const doSync = async () => {
    setSyncing(true);
    try {
      const body = syncDays > 0 ? { days: syncDays } : {};
      const resp = await fetch("/api/ml/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await resp.json();
      if (data.new_items > 0) await loadPedidos();
      if (syncDays > 0) {
        alert(`Sync histórico (${syncDays}d): ${data.total_orders || 0} órdenes, ${data.shipments_processed || 0} envíos procesados (no-Full), ${data.new_items || 0} items. Omitidos: ${data.shipments_skipped || 0}`);
      } else {
        alert(`Sincronización completa: ${data.new_items || 0} items nuevos de ${data.total_orders || 0} órdenes`);
      }
    } catch (err) {
      alert("Error de sincronización: " + String(err));
    }
    setSyncing(false);
  };

  const doDiagnose = async () => {
    setDiagnosing(true);
    setDiagResult(null);
    try {
      const resp = await fetch("/api/ml/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "diagnose" }) });
      const data = await resp.json();
      setDiagResult(data);
    } catch (err) {
      setDiagResult({ error: String(err) });
    }
    setDiagnosing(false);
  };

  const doSaveConfig = async () => {
    await upsertMLConfig({
      client_id: configForm.client_id,
      client_secret: configForm.client_secret,
      seller_id: configForm.seller_id,
      hora_corte_lv: configForm.hora_corte_lv,
      hora_corte_sab: configForm.hora_corte_sab,
    });
    await loadConfig();
    alert("Configuración guardada");
  };

  const doDownloadLabels = async (onlyCategory?: FlexDispatchCategory) => {
    // Only download labels for DESPACHAR_HOY + ATRASADO by default (not MAÑANA/BUFFERED)
    const eligibleShips = classifiedShipments.filter(s => {
      if (s.is_fraud_risk) return false;
      if (s.substatus !== "ready_to_print") return false;
      if (onlyCategory) return s._category === onlyCategory;
      return s._category === "DESPACHAR_HOY" || s._category === "ATRASADO";
    });
    const shippingIds = eligibleShips.length > 0
      ? eligibleShips.map(s => s.shipment_id)
      : Array.from(new Set(pedidos.filter(p => p.estado !== "DESPACHADO").map(p => p.shipping_id)));
    if (shippingIds.length === 0) { alert("Sin envíos para descargar etiquetas"); return; }

    if (shippingIds.length > 50) {
      alert(`Atención: hay ${shippingIds.length} etiquetas pero ML solo permite 50 por descarga. Se descargarán las primeras 50.`);
    }

    try {
      const resp = await fetch("/api/ml/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_ids: shippingIds.slice(0, 50), skip_validation: true }),
      });
      if (!resp.ok) { alert("Error descargando etiquetas"); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiquetas-${today}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error: " + String(err));
    }
  };

  // Print label for a single shipment
  const doPrintLabel = async (shipmentId: number) => {
    try {
      const resp = await fetch("/api/ml/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_ids: [shipmentId], skip_validation: true }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.message || "Error descargando etiqueta");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiqueta-${shipmentId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error: " + String(err));
    }
  };

  // Verify shipment status live before picking
  const doVerifyShipment = async (shipmentId: number): Promise<boolean> => {
    try {
      const resp = await fetch("/api/ml/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipment_id: shipmentId }),
      });
      const data = await resp.json();
      if (data.cancelled) {
        alert(`Envío #${shipmentId} fue CANCELADO. No preparar.`);
        await loadPedidos(); // refresh to remove from list
        return false;
      }
      if (!data.ok_to_pick) {
        alert(`Envío #${shipmentId} ya no está en ready_to_ship (status: ${data.status}). No preparar.`);
        await loadPedidos();
        return false;
      }
      return true;
    } catch {
      alert("No se pudo verificar. Revisa la conexión.");
      return false;
    }
  };

  const tokenValid = mlConfig?.token_expires_at && new Date(mlConfig.token_expires_at) > new Date();
  const authUrl = mlConfig?.client_id ? getOAuthUrl(mlConfig.client_id, `${typeof window !== "undefined" ? window.location.origin : ""}/api/ml/auth`) : "";

  return (
    <div>
      {/* Header */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
          <div className="card-title">🛒 Pedidos MercadoLibre Flex</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            <button onClick={() => setShowConfig(!showConfig)} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              ⚙️ Config ML
            </button>
            <button onClick={doDiagnose} disabled={diagnosing} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"#f59e0b",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              {diagnosing ? "Diagnosticando..." : "🩺 Diagnosticar"}
            </button>
            <button onClick={() => doDownloadLabels()} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"#a855f7",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              📄 Etiquetas HOY
            </button>
          </div>
        </div>

        {/* Sync controls */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,flexWrap:"wrap"}}>
          <select value={syncDays} onChange={e => setSyncDays(parseInt(e.target.value))}
            className="form-input mono" style={{fontSize:12,padding:"6px 8px",width:130}}>
            <option value={0}>Últimas 2 hrs</option>
            <option value={3}>3 días</option>
            <option value={7}>7 días</option>
            <option value={14}>14 días</option>
            <option value={30}>30 días</option>
          </select>
          <button onClick={doSync} disabled={syncing} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {syncing ? "Sincronizando..." : "🔄 Sincronizar"}
          </button>
        </div>

        {/* Store filter */}
        {storeOptions.length > 1 && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
            <select value={storeFilter ?? ""} onChange={e => setStoreFilter(e.target.value ? Number(e.target.value) : null)}
              className="form-input mono" style={{fontSize:12,padding:"6px 8px",width:180}}>
              <option value="">Todas las tiendas</option>
              {storeOptions.map(s => (
                <option key={s.store_id} value={s.store_id}>Tienda {s.store_id} ({s.count})</option>
              ))}
            </select>
          </div>
        )}

        {/* Status indicator */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,fontSize:11}}>
          <span style={{color: tokenValid ? "var(--green)" : "var(--red)", fontWeight:700}}>
            {tokenValid ? "● Token ML válido" : "● Token ML vencido/no configurado"}
          </span>
          {mlConfig?.updated_at && <span style={{color:"var(--txt3)"}}>· Última actualización: {new Date(mlConfig.updated_at).toLocaleString("es-CL")}</span>}
        </div>
      </div>

      {/* Diagnostic results */}
      {diagResult && (
        <div className="card" style={{border: (diagResult.errors as string[])?.length > 0 ? "2px solid var(--red)" : "2px solid var(--green)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div className="card-title">🩺 Diagnóstico ML</div>
            <button onClick={() => setDiagResult(null)} style={{background:"none",border:"none",color:"var(--txt3)",cursor:"pointer",fontSize:16}}>✕</button>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8,fontSize:12}}>
            <div><strong>Token:</strong> <span style={{color: diagResult.token_status === "valid" ? "var(--green)" : "var(--red)"}}>{diagResult.token_status === "valid" ? "Válido" : String(diagResult.token_status)}</span></div>
            <div><strong>Expira:</strong> <span className="mono">{diagResult.token_expires_at ? new Date(diagResult.token_expires_at as string).toLocaleString("es-CL") : "—"}</span></div>
            <div><strong>Seller ID:</strong> <span className="mono">{String(diagResult.seller_id || "—")}</span></div>
            <div><strong>Nickname:</strong> <span className="mono">{String(diagResult.seller_nickname || "—")}</span></div>
            <div><strong>Flex Suscripción:</strong> <span style={{color: (diagResult.flex_subscription as Record<string, unknown>)?.active ? "var(--green)" : "var(--red)"}}>{(diagResult.flex_subscription as Record<string, unknown>)?.active ? "Activa" : "Inactiva/No encontrada"}</span></div>
            <div><strong>Service ID:</strong> <span className="mono">{String((diagResult.flex_subscription as Record<string, unknown>)?.service_id || "—")}</span></div>
          </div>
          <div style={{borderTop:"1px solid var(--bg4)",marginTop:12,paddingTop:12}}>
            <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>Órdenes últimos 7 días</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:12}}>
              <div><strong>Total:</strong> {String(diagResult.recent_orders_total)}</div>
              <div><strong>Flex (self_service):</strong> <span style={{color: (diagResult.recent_orders_flex as number) > 0 ? "var(--green)" : "var(--red)", fontWeight:700}}>{String(diagResult.recent_orders_flex)}</span></div>
              <div><strong>Otros tipos:</strong> {String(diagResult.recent_orders_other)}</div>
            </div>
          </div>
          {(diagResult.sample_orders as Array<Record<string, unknown>>)?.length > 0 && (
            <div style={{marginTop:8}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--txt3)",marginBottom:4}}>Muestra de órdenes:</div>
              <div style={{overflowX:"auto"}}>
                <table className="tbl" style={{fontSize:11}}>
                  <thead><tr><th>Order ID</th><th>Fecha venta</th><th>Tipo envío</th><th>Despachar antes de</th><th>Origen</th><th>Dirección</th><th>Estado</th><th>Items</th></tr></thead>
                  <tbody>
                    {(diagResult.sample_orders as Array<Record<string, unknown>>).map((o: Record<string, unknown>) => (
                      <tr key={String(o.id)} style={{background: o.logistic_type === "self_service" ? "#10b98115" : "transparent"}}>
                        <td className="mono">{String(o.id)}</td>
                        <td className="mono">{new Date(o.date as string).toLocaleString("es-CL", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</td>
                        <td><span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,background: o.logistic_type === "self_service" ? "#10b98122" : "#f59e0b22",color: o.logistic_type === "self_service" ? "#10b981" : "#f59e0b"}}>{String(o.logistic_type)}</span></td>
                        <td className="mono" style={{fontSize:10,fontWeight:700,color: o.handling_limit_date ? "var(--cyan)" : "var(--txt3)"}}>{o.handling_limit_date ? String(o.handling_limit_date) : "—"}</td>
                        <td style={{fontSize:10}}>{o.origin_type ? String(o.origin_type) : "—"}</td>
                        <td style={{fontSize:10,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.origin_address ? String(o.origin_address) : "—"}</td>
                        <td>{String(o.status)}</td>
                        <td style={{textAlign:"right"}}>{String(o.items)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {(diagResult.errors as string[])?.length > 0 && (
            <div style={{marginTop:12,padding:8,borderRadius:6,background:"#ef444422",border:"1px solid #ef444444"}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--red)",marginBottom:4}}>Problemas detectados:</div>
              {(diagResult.errors as string[]).map((e: string, i: number) => (
                <div key={i} style={{fontSize:11,color:"var(--red)",marginBottom:2}}>• {e}</div>
              ))}
            </div>
          )}
          {diagResult.shipment_sample ? (
            <details style={{marginTop:8}}>
              <summary style={{fontSize:11,color:"var(--txt3)",cursor:"pointer"}}>Ver detalle envío Flex de ejemplo (shipment raw)</summary>
              <pre style={{fontSize:10,overflow:"auto",maxHeight:200,background:"var(--bg2)",padding:8,borderRadius:4,marginTop:4}}>{JSON.stringify(diagResult.shipment_sample, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      )}

      {/* ML Config panel */}
      {showConfig && (
        <div className="card" style={{border:"2px solid var(--cyan)"}}>
          <div className="card-title">Configuración MercadoLibre</div>
          <div className="admin-form-grid">
            <div className="form-group"><label className="form-label">Client ID</label><input className="form-input mono" value={configForm.client_id} onChange={e => setConfigForm({...configForm, client_id: e.target.value})} placeholder="App ID de ML"/></div>
            <div className="form-group"><label className="form-label">Client Secret</label><input className="form-input mono" type="password" value={configForm.client_secret} onChange={e => setConfigForm({...configForm, client_secret: e.target.value})} placeholder="Secret key"/></div>
            <div className="form-group"><label className="form-label">Seller ID</label><input className="form-input mono" value={configForm.seller_id} onChange={e => setConfigForm({...configForm, seller_id: e.target.value})} placeholder="Se autocompleta al vincular"/></div>
            <div className="form-group"><label className="form-label">Corte L-V (hora)</label><input type="number" className="form-input mono" value={configForm.hora_corte_lv} onFocus={e=>e.target.select()} onChange={e => setConfigForm({...configForm, hora_corte_lv: parseInt(e.target.value) || 13})} min={0} max={23}/></div>
            <div className="form-group"><label className="form-label">Corte Sábado (hora)</label><input type="number" className="form-input mono" value={configForm.hora_corte_sab} onFocus={e=>e.target.select()} onChange={e => setConfigForm({...configForm, hora_corte_sab: parseInt(e.target.value) || 12})} min={0} max={23}/></div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={doSaveConfig} style={{padding:"8px 16px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13}}>Guardar Config</button>
            {configForm.client_id && (
              <a href={authUrl} style={{padding:"8px 16px",borderRadius:8,background:"#3483fa",color:"#fff",fontWeight:700,fontSize:13,textDecoration:"none",display:"inline-flex",alignItems:"center"}}>
                🔗 Vincular cuenta ML
              </a>
            )}
          </div>
        </div>
      )}

      {/* Summary KPIs: dispatch categories */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:0}}>
        <div className="card" style={{textAlign:"center",padding:12,border: shipCounts.atrasado > 0 ? "2px solid #ef4444" : undefined}}>
          <div style={{fontSize:26,fontWeight:800,color:"#ef4444"}}>{shipCounts.atrasado}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Atrasados</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12,border: shipCounts.despacharHoy > 0 ? "2px solid #10b981" : undefined}}>
          <div style={{fontSize:26,fontWeight:800,color:"#10b981"}}>{shipCounts.despacharHoy}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Despachar HOY</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#f59e0b"}}>{shipCounts.despacharManana}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Para MAÑANA</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#3b82f6"}}>{shipCounts.buffered}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>En espera</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#94a3b8"}}>{shipCounts.yaImpreso}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Ya impresos</div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>Cargando...</div>
      ) : shipments.length > 0 ? (
        /* ===== FLEX DISPATCH VIEW — grouped by category (HOY/MAÑANA/BUFFERED/YA_IMPRESO) ===== */
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {categoryGroups.map(([category, catShips]) => {
            const cfg = CATEGORY_CONFIG[category];
            const isUrgent = category === "ATRASADO" || category === "DESPACHAR_HOY";
            const isBuffered = category === "BUFFERED";
            const isMañana = category === "DESPACHAR_MANANA";
            const isPrinted = category === "YA_IMPRESO";
            const readyToPrintCount = catShips.filter(s => s.substatus === "ready_to_print").length;

            const LOGISTIC_ACTIONS: Record<string, string> = {
              self_service: "darle el paquete a tu conductor",
              cross_docking: "tenerlo listo para recolección de ML",
              xd_drop_off: "llevarlo a la agencia",
              drop_off: "llevarlo al correo",
            };

            // Sub-group by logistic type within category
            const logisticTypes = ["self_service", "cross_docking", "xd_drop_off", "drop_off"];
            const ltGroups = logisticTypes.map(lt => ({
              lt, label: LOGISTIC_LABELS[lt] || lt, color: LOGISTIC_COLORS[lt] || "#94a3b8",
              action: LOGISTIC_ACTIONS[lt] || "preparar",
              ships: catShips.filter(s => s.logistic_type === lt),
            })).filter(g => g.ships.length > 0);

            return (
              <div key={category} className="card" style={{padding:0,overflow:"hidden",border: category === "ATRASADO" ? "2px solid #ef4444" : `1px solid ${cfg.color}44`}}>
                {/* Category header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:`${cfg.color}11`,borderBottom:"1px solid var(--bg4)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:4,background:`${cfg.color}22`,color:cfg.color,border:`1px solid ${cfg.color}44`,textTransform:"uppercase",letterSpacing:"0.05em"}}>
                      {cfg.label}
                    </span>
                    <span style={{fontSize:12,color:"var(--txt3)",fontWeight:600}}>{catShips.length} paquete{catShips.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {isUrgent && readyToPrintCount > 0 && (
                      <button onClick={() => doDownloadLabels(category)} style={{fontSize:10,fontWeight:700,padding:"4px 12px",borderRadius:4,border:"none",cursor:"pointer",background:cfg.color,color:"#fff"}}>
                        Imprimir {readyToPrintCount} etiqueta{readyToPrintCount !== 1 ? "s" : ""}
                      </button>
                    )}
                    {isMañana && (
                      <span style={{fontSize:10,color:"#f59e0b",fontWeight:600}}>No imprimir aún</span>
                    )}
                    {isBuffered && (
                      <span style={{fontSize:10,color:"#3b82f6",fontWeight:600}}>Esperando liberación ML</span>
                    )}
                  </div>
                </div>

                {/* Instruction banner per category */}
                {category === "ATRASADO" && (
                  <div style={{padding:"8px 16px",background:"#ef444415",fontSize:11,color:"#ef4444",fontWeight:700}}>
                    Estos envíos ya pasaron su deadline. Despachar URGENTE para evitar penalizaciones.
                  </div>
                )}
                {isMañana && (
                  <div style={{padding:"8px 16px",background:"#f59e0b10",fontSize:11,color:"#f59e0b",fontWeight:600}}>
                    Estos pedidos están programados para mañana. No necesitas imprimir etiquetas ahora.
                  </div>
                )}
                {isBuffered && (
                  <div style={{padding:"8px 16px",background:"#3b82f610",fontSize:11,color:"#3b82f6",fontWeight:600}}>
                    ML aún no liberó estas etiquetas. Se habilitarán automáticamente cuando estén listas.
                  </div>
                )}

                {/* Logistic type subgroups */}
                <div style={{padding:"8px 12px"}}>
                  {ltGroups.map(ltg => (
                    <div key={ltg.lt} style={{marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,margin:"8px 0 6px",padding:"6px 10px",background:`${ltg.color}0d`,borderRadius:6}}>
                        <span style={{fontSize:12,fontWeight:700,color:ltg.color}}>{ltg.label}</span>
                        {isUrgent && (
                          <span style={{fontSize:11,color:"var(--txt2)"}}>
                            — Tienes que <strong>{ltg.action}</strong> {category === "ATRASADO" ? <span style={{color:"#ef4444",fontWeight:800}}>URGENTE</span> : <strong>hoy</strong>}
                          </span>
                        )}
                        {isMañana && <span style={{fontSize:11,color:"var(--txt3)"}}>— Entregar mañana</span>}
                        <span style={{fontSize:10,color:"var(--txt3)",marginLeft:"auto"}}>({ltg.ships.length})</span>
                      </div>
                      {ltg.ships.map(ship => {
                        const canPrint = isUrgent && ship.substatus === "ready_to_print" && ship.status === "ready_to_ship";
                        const bufferingInfo = isBuffered && ship.buffering_date
                          ? `Etiqueta disponible desde: ${new Date(ship.buffering_date).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                          : null;
                        const handlingInfo = ship.handling_limit
                          ? new Date(ship.handling_limit).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                          : null;

                        return (
                          <div key={ship.shipment_id} style={{padding:"8px 10px",marginBottom:2,borderLeft:`3px solid ${ship.is_fraud_risk ? "#dc2626" : cfg.color}`,background: ship.is_fraud_risk ? "#dc262610" : "var(--bg2)",borderRadius:"0 6px 6px 0"}}>
                            {ship.is_fraud_risk && (
                              <div style={{padding:"4px 8px",marginBottom:4,borderRadius:4,background:"#dc262622",color:"#dc2626",fontSize:11,fontWeight:800}}>
                                RIESGO DE FRAUDE — NO PREPARAR ESTE PEDIDO
                              </div>
                            )}
                            {/* Actions + status */}
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <div style={{display:"flex",alignItems:"center",gap:6}}>
                                {canPrint ? (
                                  <button onClick={() => doPrintLabel(ship.shipment_id)}
                                    disabled={ship.is_fraud_risk}
                                    style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,border:"none",cursor: ship.is_fraud_risk ? "not-allowed" : "pointer",
                                      background: category === "ATRASADO" ? "#ef4444" : "#10b981",color:"#fff"}}>
                                    IMPRIMIR ETIQUETA
                                  </button>
                                ) : isPrinted || ship.substatus === "printed" ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#10b98122",color:"#10b981"}}>
                                    LISTA PARA DESPACHAR
                                  </span>
                                ) : isMañana && ship.substatus === "ready_to_print" ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#f59e0b22",color:"#f59e0b"}} title="Este pedido está programado para mañana">
                                    MAÑANA — NO IMPRIMIR
                                  </span>
                                ) : isBuffered ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#3b82f622",color:"#3b82f6"}}>
                                    EN ESPERA
                                  </span>
                                ) : (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#94a3b822",color:"#94a3b8"}}>
                                    {ship.substatus || "—"}
                                  </span>
                                )}
                                {(isUrgent || isMañana) && (
                                  <button onClick={async () => { const ok = await doVerifyShipment(ship.shipment_id); if (ok) alert("Verificado: listo para armar"); }}
                                    style={{fontSize:9,fontWeight:600,padding:"2px 8px",borderRadius:3,border:"1px solid var(--bg4)",background:"var(--bg3)",color:"var(--txt3)",cursor:"pointer"}}>
                                    Verificar
                                  </button>
                                )}
                                {handlingInfo && isUrgent && (
                                  <span className="mono" style={{fontSize:9,color: category === "ATRASADO" ? "#ef4444" : "var(--txt3)"}}>
                                    Despachar antes: {handlingInfo}
                                  </span>
                                )}
                              </div>
                              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                                <span style={{fontSize:10,color:"var(--txt3)"}}>{ship.receiver_name || ""}{ship.destination_city ? ` · ${ship.destination_city}` : ""}</span>
                                {ship.handling_limit && (
                                  <span className="mono" style={{fontSize:9,color:"var(--txt3)"}}>
                                    Deadline: {toChileDateStr(new Date(ship.handling_limit))} {new Date(ship.handling_limit).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                )}
                              </div>
                            </div>
                            {bufferingInfo && (
                              <div style={{fontSize:10,color:"#3b82f6",marginBottom:4}}>{bufferingInfo}</div>
                            )}
                            {/* Items */}
                            {ship.items.map((item, idx) => {
                              const comps = getComponentesPorSkuVenta(item.seller_sku);
                              if (comps.length > 0) {
                                return comps.map((comp, ci) => {
                                  const totalUnits = comp.unidades * item.quantity;
                                  const isMultiUnit = comp.unidades > 1;
                                  return (
                                    <div key={`${idx}-${ci}`} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",fontSize:12}}>
                                      <span className="mono" style={{fontWeight:800,minWidth:110,color:"var(--cyan)"}}>{comp.skuOrigen}</span>
                                      <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--txt1)"}}>{item.title}</span>
                                      <span className="mono" style={{fontWeight:800,fontSize:13,color: isMultiUnit ? "#f59e0b" : "var(--txt1)"}}>
                                        x{totalUnits}{isMultiUnit ? ` (${comp.unidades}x${item.quantity})` : ""}
                                      </span>
                                    </div>
                                  );
                                });
                              }
                              return (
                                <div key={idx} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",fontSize:12}}>
                                  <span className="mono" style={{fontWeight:800,minWidth:110,color:"var(--cyan)"}}>{item.seller_sku}</span>
                                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--txt1)"}}>{item.title}</span>
                                  <span className="mono" style={{fontWeight:800,fontSize:13,color:"var(--txt1)"}}>x{item.quantity}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:12}}>📦</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin envíos activos</div>
          <div style={{fontSize:12,marginTop:4}}>Usa "Diagnosticar" para verificar la conexión. Luego "Sincronizar" con rango de días para traer envíos.</div>
          <div style={{fontSize:11,marginTop:8,color:"var(--txt3)"}}>Si es la primera vez, ejecuta primero la migración SQL para crear las tablas ml_shipments.</div>
          {legacyPendientes > 0 && (
            <div style={{marginTop:12}}>
              <button onClick={() => setShowLegacy(!showLegacy)} style={{fontSize:10,color:"var(--txt3)",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:4,padding:"4px 8px",cursor:"pointer"}}>
                {showLegacy ? "Ocultar" : "Ver"} tabla legacy ({legacyPendientes} pedidos_flex)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== CONTEO CÍCLICO ====================
function AdminConteos({ refresh }: { refresh: () => void }) {
  const [conteos, setConteos] = useState<DBConteo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selConteo, setSelConteo] = useState<DBConteo | null>(null);
  const [filter, setFilter] = useState<"activas"|"revision"|"cerradas"|"todas">("activas");

  const loadConteos = useCallback(async () => {
    setLoading(true);
    const data = await fetchConteos();
    setConteos(data);
    setLoading(false);
  }, []);

  useEffect(() => { loadConteos(); }, [loadConteos]);

  const counts = {
    activas: conteos.filter(c => ["ABIERTA","EN_PROCESO"].includes(c.estado)).length,
    revision: conteos.filter(c => c.estado === "REVISION").length,
    cerradas: conteos.filter(c => c.estado === "CERRADA").length,
    todas: conteos.length,
  };

  const filtered = conteos.filter(c => {
    if (filter === "activas") return ["ABIERTA","EN_PROCESO"].includes(c.estado);
    if (filter === "revision") return c.estado === "REVISION";
    if (filter === "cerradas") return c.estado === "CERRADA";
    return true;
  });

  if (selConteo) {
    return <ConteoDetail conteo={selConteo} onBack={() => { setSelConteo(null); loadConteos(); }} refresh={refresh}/>;
  }

  if (showCreate) {
    return <CreateConteo onCreated={() => { setShowCreate(false); loadConteos(); }} onCancel={() => setShowCreate(false)}/>;
  }

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div className="card-title">📋 Conteo Cíclico</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={loadConteos} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄</button>
            <button onClick={() => setShowCreate(true)} style={{padding:"8px 16px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13}}>+ Nuevo Conteo</button>
          </div>
        </div>
        <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap"}}>
          {(["activas","revision","cerradas","todas"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,
                background: filter === f ? "var(--cyan)" : "var(--bg3)",
                color: filter === f ? "#000" : "var(--txt2)",
                border:`1px solid ${filter === f ? "var(--cyan)" : "var(--bg4)"}`}}>
              {f === "activas" ? "Activas" : f === "revision" ? "En revisión" : f === "cerradas" ? "Cerradas" : "Todas"} ({counts[f]})
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin conteos</div>
        </div>
      )}

      {filtered.map(c => {
        const total = c.posiciones.length;
        const done = c.posiciones_contadas.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const estadoColors: Record<string, string> = { ABIERTA: "#f59e0b", EN_PROCESO: "#3b82f6", REVISION: "#a855f7", CERRADA: "#10b981" };
        const color = estadoColors[c.estado] || "#94a3b8";
        return (
          <div key={c.id} className="card" style={{cursor:"pointer",border:`1px solid ${color}33`}} onClick={() => setSelConteo(c)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>Conteo {c.fecha}</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>
                  {c.tipo === "por_posicion" ? "Por posición" : "Por SKU"} · {total} posiciones · Creado por: {c.created_by}
                </div>
              </div>
              <span style={{padding:"4px 10px",borderRadius:6,fontSize:10,fontWeight:700,background:`${color}22`,color,border:`1px solid ${color}44`}}>
                {c.estado}
              </span>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:6,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:6,transition:"width .3s"}}/>
            </div>
            <div style={{fontSize:10,color:"var(--txt3)",marginTop:4}}>{done}/{total} posiciones contadas</div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== CREATE CONTEO ====================
function CreateConteo({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [tipo, setTipo] = useState<"por_posicion" | "por_sku">("por_posicion");
  const [selPositions, setSelPositions] = useState<Set<string>>(new Set());
  const [skuSearch, setSkuSearch] = useState("");
  const [selSkus, setSelSkus] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const s = getStore();
  const positions = activePositions().filter(p => p.active);
  const allProds = Object.values(s.products).sort((a, b) => a.sku.localeCompare(b.sku));

  const togglePos = (id: string) => {
    const next = new Set(selPositions);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelPositions(next);
  };

  const selectAllPositions = () => {
    if (selPositions.size === positions.length) setSelPositions(new Set());
    else setSelPositions(new Set(positions.map(p => p.id)));
  };

  const toggleSku = (sku: string) => {
    const next = new Set(selSkus);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setSelSkus(next);
  };

  const skuResults = skuSearch.length >= 2 ? findProduct(skuSearch).slice(0, 10) : [];

  const doCreate = async () => {
    setCreating(true);
    const fecha = new Date().toISOString().slice(0, 10);
    let posicionesConteo: string[] = [];
    const lineas: ConteoLinea[] = [];

    if (tipo === "por_posicion") {
      posicionesConteo = Array.from(selPositions);
      for (const posId of posicionesConteo) {
        const items = posContents(posId);
        const pos = positions.find(p => p.id === posId);
        for (const item of items) {
          if (item.qty <= 0) continue;
          lineas.push({
            posicion_id: posId,
            posicion_label: pos?.label || posId,
            sku: item.sku,
            nombre: item.name,
            stock_sistema: item.qty,
            stock_contado: 0,
            operario: "",
            timestamp: "",
            estado: "PENDIENTE",
            es_inesperado: false,
          });
        }
      }
    } else {
      // por_sku: find all positions for selected SKUs
      const posSet = new Set<string>();
      for (const sku of Array.from(selSkus)) {
        const posiciones = skuPositions(sku);
        for (const p of posiciones) {
          posSet.add(p.pos);
          const pos = positions.find(pp => pp.id === p.pos);
          lineas.push({
            posicion_id: p.pos,
            posicion_label: pos?.label || p.pos,
            sku,
            nombre: s.products[sku]?.name || sku,
            stock_sistema: p.qty,
            stock_contado: 0,
            operario: "",
            timestamp: "",
            estado: "PENDIENTE",
            es_inesperado: false,
          });
        }
      }
      posicionesConteo = Array.from(posSet);
    }

    if (posicionesConteo.length === 0) { setCreating(false); return; }

    await createConteo({
      fecha,
      tipo,
      estado: "ABIERTA",
      lineas,
      posiciones: posicionesConteo,
      posiciones_contadas: [],
      created_by: "Admin",
      closed_at: null,
      closed_by: null,
    });

    setCreating(false);
    onCreated();
  };

  return (
    <div>
      <div className="card" style={{border:"2px solid var(--cyan)"}}>
        <div className="card-title">Nuevo Conteo Cíclico</div>

        <div style={{marginBottom:16}}>
          <div className="form-label">Tipo de conteo</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={() => setTipo("por_posicion")}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background: tipo === "por_posicion" ? "var(--cyan)" : "var(--bg3)",
                color: tipo === "por_posicion" ? "#000" : "var(--txt2)",
                border:`1px solid ${tipo === "por_posicion" ? "var(--cyan)" : "var(--bg4)"}`}}>
              📍 Por Posición
            </button>
            <button onClick={() => setTipo("por_sku")}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background: tipo === "por_sku" ? "var(--cyan)" : "var(--bg3)",
                color: tipo === "por_sku" ? "#000" : "var(--txt2)",
                border:`1px solid ${tipo === "por_sku" ? "var(--cyan)" : "var(--bg4)"}`}}>
              🏷️ Por SKU
            </button>
          </div>
        </div>

        {tipo === "por_posicion" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div className="form-label" style={{marginBottom:0}}>Seleccionar posiciones ({selPositions.size})</div>
              <button onClick={selectAllPositions}
                style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)"}}>
                {selPositions.size === positions.length ? "Deseleccionar todas" : "Seleccionar todas"}
              </button>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4,maxHeight:200,overflow:"auto",padding:4}}>
              {positions.map(p => {
                const sel = selPositions.has(p.id);
                const items = posContents(p.id);
                const qty = items.reduce((s, i) => s + i.qty, 0);
                return (
                  <button key={p.id} onClick={() => togglePos(p.id)}
                    style={{padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,
                      background: sel ? "var(--cyan)" : "var(--bg3)",
                      color: sel ? "#000" : qty > 0 ? "var(--txt1)" : "var(--txt3)",
                      border:`1px solid ${sel ? "var(--cyan)" : "var(--bg4)"}`,
                      opacity: qty > 0 || sel ? 1 : 0.5}}>
                    {p.id} {qty > 0 && `(${qty})`}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tipo === "por_sku" && (
          <div>
            <div className="form-label">Buscar y seleccionar SKUs ({selSkus.size})</div>
            <input className="form-input mono" value={skuSearch} onChange={e => setSkuSearch(e.target.value)}
              placeholder="Buscar SKU o nombre..." style={{fontSize:12,marginBottom:8}}/>
            {skuResults.map(p => {
              const sel = selSkus.has(p.sku);
              const stock = skuTotal(p.sku);
              return (
                <button key={p.sku} onClick={() => toggleSku(p.sku)}
                  style={{width:"100%",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"8px 12px",marginBottom:2,borderRadius:6,
                    background: sel ? "var(--cyan)15" : "var(--bg3)",
                    border:`1px solid ${sel ? "var(--cyan)" : "var(--bg4)"}`,cursor:"pointer"}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:12}}>{p.sku}</span>
                    <span style={{marginLeft:8,fontSize:11,color:"var(--txt3)"}}>{p.name}</span>
                  </div>
                  <span style={{fontSize:11,fontWeight:600,color:sel?"var(--cyan)":"var(--txt3)"}}>{stock} uds {sel?"✓":""}</span>
                </button>
              );
            })}
            {selSkus.size > 0 && (
              <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:4}}>
                {Array.from(selSkus).map(sku => (
                  <span key={sku} onClick={() => toggleSku(sku)} style={{cursor:"pointer",padding:"4px 8px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--cyan)22",color:"var(--cyan)",border:"1px solid var(--cyan)44"}}>
                    {sku} ✕
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={onCancel} style={{flex:1,padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
          <button onClick={doCreate} disabled={creating || (tipo === "por_posicion" ? selPositions.size === 0 : selSkus.size === 0)}
            style={{flex:2,padding:10,borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,
              opacity: (tipo === "por_posicion" ? selPositions.size > 0 : selSkus.size > 0) ? 1 : 0.5}}>
            {creating ? "Creando..." : "Crear Conteo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== CONTEO DETAIL / REVIEW ====================
function ConteoDetail({ conteo: initialConteo, onBack, refresh }: { conteo: DBConteo; onBack: () => void; refresh: () => void }) {
  const [conteo, setConteo] = useState(initialConteo);
  const [processing, setProcessing] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  // Recalcular stock_sistema con el stock real actual para líneas no resueltas
  useEffect(() => {
    const s = getStore();
    let changed = false;
    const fixedLineas = conteo.lineas.map(l => {
      // Solo actualizar líneas que aún no fueron aprobadas/verificadas
      if (l.estado === "AJUSTADO" || l.estado === "VERIFICADO") return l;
      const stockReal = s.stock[l.sku]?.[l.posicion_id] ?? 0;
      if (stockReal !== l.stock_sistema) {
        changed = true;
        return { ...l, stock_sistema: stockReal };
      }
      return l;
    });
    if (changed) {
      const updated = { ...conteo, lineas: fixedLineas };
      setConteo(updated);
      updateConteo(conteo.id!, { lineas: fixedLineas });
    }
  }, [initialConteo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadConteo = async () => {
    const all = await fetchConteos();
    const found = all.find(c => c.id === conteo.id);
    if (found) setConteo(found);
  };

  const positions = activePositions();
  const posMap = new Map(positions.map(p => [p.id, p]));

  // Group lines by position
  const byPosition = new Map<string, ConteoLinea[]>();
  for (const l of conteo.lineas) {
    if (!byPosition.has(l.posicion_id)) byPosition.set(l.posicion_id, []);
    byPosition.get(l.posicion_id)!.push(l);
  }

  // Stats
  const totalLineas = conteo.lineas.filter(l => l.estado !== "PENDIENTE").length;
  const conDiferencia = conteo.lineas.filter(l => l.estado === "CONTADO" && l.stock_sistema !== l.stock_contado).length;
  const sinDiferencia = conteo.lineas.filter(l => l.estado === "CONTADO" && l.stock_sistema === l.stock_contado).length;
  const ajustados = conteo.lineas.filter(l => l.estado === "AJUSTADO" || l.estado === "VERIFICADO").length;

  const aprobarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const linea = conteo.lineas.find(l => l.posicion_id === posId && l.sku === sku && l.estado === "CONTADO");
    if (!linea) { setProcessing(false); return; }

    const diff = linea.stock_contado - linea.stock_sistema;
    if (diff !== 0) {
      const ts = new Date().toISOString();
      await recordMovementAsync({
        ts,
        type: diff > 0 ? "in" : "out",
        reason: "ajuste_conteo",
        sku: linea.sku,
        pos: linea.posicion_id,
        qty: Math.abs(diff),
        who: "Admin (conteo)",
        note: `Ajuste conteo cíclico ${conteo.fecha} — ${diff > 0 ? "sobrante" : "faltante"}`,
      });
    }

    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "AJUSTADO" as const } : l
    );

    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");

    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });

    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    refresh();
    setProcessing(false);
  };

  const rechazarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "VERIFICADO" as const } : l
    );
    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");
    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });
    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    setProcessing(false);
  };

  const recontarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "PENDIENTE" as const, stock_contado: 0, operario: "", timestamp: "" } : l
    );
    // Remove position from contadas so operator can recount
    const newContadas = conteo.posiciones_contadas.filter(p => p !== posId);
    await updateConteo(conteo.id!, { lineas: newLineas, posiciones_contadas: newContadas, estado: "EN_PROCESO" });
    setConteo({ ...conteo, lineas: newLineas, posiciones_contadas: newContadas, estado: "EN_PROCESO" });
    setProcessing(false);
  };

  // Traspasar: mover stock de una posición origen a la posición contada (en vez de ajustar)
  const traspasarLinea = async (posId: string, sku: string, fromPos: string, qty: number) => {
    if (!confirm(`¿Traspasar ${qty} unidades de ${sku} desde ${fromPos} → ${posId}?\n\nEsto NO cambia el stock total, solo mueve entre posiciones.`)) return;
    setProcessing(true);
    const ts = new Date().toISOString();
    const nota = `Traspaso conteo cíclico ${conteo.fecha}: ${fromPos} → ${posId}`;
    // Salida desde la posición origen
    await recordMovementAsync({
      ts, type: "out", reason: "ajuste_conteo", sku, pos: fromPos, qty,
      who: "Admin (conteo)", note: nota,
    });
    // Entrada en la posición destino
    await recordMovementAsync({
      ts, type: "in", reason: "ajuste_conteo", sku, pos: posId, qty,
      who: "Admin (conteo)", note: nota,
    });

    // Marcar la línea como ajustada y actualizar stock_sistema
    const s = getStore();
    const newLineas = conteo.lineas.map(l => {
      if (l.posicion_id === posId && l.sku === sku) {
        return { ...l, estado: "AJUSTADO" as const, stock_sistema: s.stock[sku]?.[posId] ?? l.stock_contado };
      }
      return l;
    });

    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");
    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });
    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    refresh();
    setProcessing(false);
  };

  const aprobarTodo = async () => {
    if (!confirm("¿Aprobar TODOS los ajustes pendientes? Se generarán movimientos automáticos.")) return;
    setProcessing(true);
    for (const l of conteo.lineas) {
      if (l.estado !== "CONTADO") continue;
      const diff = l.stock_contado - l.stock_sistema;
      if (diff !== 0) {
        await recordMovementAsync({
          ts: new Date().toISOString(),
          type: diff > 0 ? "in" : "out",
          reason: "ajuste_conteo",
          sku: l.sku,
          pos: l.posicion_id,
          qty: Math.abs(diff),
          who: "Admin (conteo)",
          note: `Ajuste conteo cíclico ${conteo.fecha}`,
        });
      }
    }
    const newLineas = conteo.lineas.map(l => l.estado === "CONTADO" ? { ...l, estado: "AJUSTADO" as const } : l);
    await updateConteo(conteo.id!, { lineas: newLineas, estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" });
    setConteo({ ...conteo, lineas: newLineas, estado: "CERRADA" });
    refresh();
    setProcessing(false);
  };

  const doDelete = async () => {
    if (!confirm("¿Eliminar este conteo? Esta acción no se puede deshacer.")) return;
    await deleteConteo(conteo.id!);
    onBack();
  };

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <button onClick={onBack} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)",marginBottom:8}}>← Volver</button>
            <div className="card-title">📋 Conteo {conteo.fecha}</div>
            <div style={{fontSize:11,color:"var(--txt3)"}}>
              {conteo.tipo === "por_posicion" ? "Por posición" : "Por SKU"} · {conteo.posiciones.length} posiciones · Estado: <strong>{conteo.estado}</strong>
            </div>
          </div>
          <div style={{display:"flex",gap:6}}>
            {conteo.estado !== "CERRADA" && (
              <button onClick={doDelete} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>Eliminar</button>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
        {[
          { label: "Contados", value: totalLineas, color: "#3b82f6" },
          { label: "Sin diferencia", value: sinDiferencia, color: "#10b981" },
          { label: "Con diferencia", value: conDiferencia, color: "#f59e0b" },
          { label: "Resueltos", value: ajustados, color: "#a855f7" },
        ].map(st => (
          <div key={st.label} className="card" style={{textAlign:"center",padding:12}}>
            <div style={{fontSize:20,fontWeight:800,color:st.color}}>{st.value}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Approve all button */}
      {conteo.estado === "REVISION" && conDiferencia > 0 && (
        <div className="card" style={{border:"2px solid #a855f744"}}>
          <button onClick={aprobarTodo} disabled={processing}
            style={{width:"100%",padding:14,borderRadius:10,background:"linear-gradient(135deg,#7c3aed,#a855f7)",color:"#fff",fontWeight:700,fontSize:14,border:"none",cursor:"pointer"}}>
            {processing ? "Procesando..." : `✅ Aprobar todos los ajustes (${conDiferencia} diferencias)`}
          </button>
        </div>
      )}

      {/* Lines by position */}
      {Array.from(byPosition.entries()).map(([posId, lines]) => {
        const pos = posMap.get(posId);
        const isDone = conteo.posiciones_contadas.includes(posId);
        return (
          <div key={posId} className="card" style={{border:`1px solid ${isDone ? "var(--bg4)" : "var(--bg3)"}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span className="mono" style={{fontSize:14,fontWeight:800,color:"var(--cyan)"}}>{posId}</span>
                <span style={{fontSize:12,color:"var(--txt3)"}}>{pos?.label || posId}</span>
              </div>
              {isDone ? <span style={{fontSize:10,fontWeight:700,color:"#10b981"}}>✅ Contada</span> :
                <span style={{fontSize:10,fontWeight:700,color:"#f59e0b"}}>⏳ Pendiente</span>}
            </div>
            <table className="tbl" style={{fontSize:12}}>
              <thead>
                <tr>
                  <th>SKU</th><th>Producto</th>
                  <th style={{textAlign:"right"}}>Sistema</th>
                  <th style={{textAlign:"right"}}>Contado</th>
                  <th style={{textAlign:"right"}}>Diff</th>
                  <th>Estado</th>
                  {(conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") && <th></th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const diff = l.stock_contado - l.stock_sistema;
                  const diffColor = diff === 0 ? "#10b981" : Math.abs(diff) >= 5 ? "#ef4444" : "#f59e0b";
                  const isContado = l.estado === "CONTADO";
                  const lineKey = `${l.posicion_id}|${l.sku}`;
                  const isExpanded = expandedSku === lineKey;
                  const hasDiff = l.estado !== "PENDIENTE" && diff !== 0;
                  const colCount = (conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") ? 7 : 6;

                  // Build stock global info for this SKU
                  const s = getStore();
                  const skuStock = s.stock[l.sku] || {};
                  const allPositions = Object.entries(skuStock).filter(([, q]) => q > 0);
                  const totalSistema = allPositions.reduce((sum, [, q]) => sum + q, 0);

                  // Find all conteo lines for this SKU (to show what operator counted elsewhere)
                  const conteoLinesSku = conteo.lineas.filter(cl => cl.sku === l.sku);

                  // Projected total if approved: total sistema + diff for this line
                  const proyectado = totalSistema + diff;

                  return (
                    <React.Fragment key={i}>
                    <tr style={{background: l.estado === "PENDIENTE" ? "transparent" : diff === 0 ? "#10b98108" : `${diffColor}08`, cursor: hasDiff ? "pointer" : "default"}}
                      onClick={() => hasDiff && setExpandedSku(isExpanded ? null : lineKey)}>
                      <td className="mono" style={{fontWeight:700,fontSize:11}}>
                        {l.sku}
                        {l.es_inesperado && <span style={{marginLeft:4,fontSize:9,padding:"1px 4px",borderRadius:3,background:"#f59e0b22",color:"#f59e0b",fontWeight:700}}>NUEVO</span>}
                        {hasDiff && <span style={{marginLeft:4,fontSize:9,color:"var(--txt3)"}}>{isExpanded ? "▼" : "▶"}</span>}
                      </td>
                      <td style={{fontSize:11,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nombre}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:600}}>{l.stock_sistema}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color: l.estado === "PENDIENTE" ? "var(--txt3)" : diffColor}}>
                        {l.estado === "PENDIENTE" ? "—" : l.stock_contado}
                      </td>
                      <td className="mono" style={{textAlign:"right",fontWeight:800,color: l.estado === "PENDIENTE" ? "var(--txt3)" : diffColor}}>
                        {l.estado === "PENDIENTE" ? "—" : diff === 0 ? "OK" : (diff > 0 ? "+" : "") + diff}
                      </td>
                      <td>
                        <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,
                          background: l.estado === "PENDIENTE" ? "#64748b22" : l.estado === "CONTADO" ? "#3b82f622" : l.estado === "AJUSTADO" ? "#10b98122" : "#a855f722",
                          color: l.estado === "PENDIENTE" ? "#64748b" : l.estado === "CONTADO" ? "#3b82f6" : l.estado === "AJUSTADO" ? "#10b981" : "#a855f7"}}>
                          {l.estado}
                        </span>
                      </td>
                      {(conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") && (
                        <td style={{textAlign:"right",whiteSpace:"nowrap"}} onClick={e => e.stopPropagation()}>
                          {isContado && diff !== 0 && (
                            <>
                              <button onClick={() => aprobarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#10b98122",color:"#10b981",border:"1px solid #10b98144",marginRight:3}}>
                                Aprobar
                              </button>
                              <button onClick={() => rechazarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",marginRight:3}}>
                                Rechazar
                              </button>
                              <button onClick={() => recontarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#f59e0b22",color:"#f59e0b",border:"1px solid #f59e0b44"}}>
                                Recontar
                              </button>
                            </>
                          )}
                          {isContado && diff === 0 && (
                            <span style={{fontSize:9,color:"#10b981",fontWeight:600}}>✓ OK</span>
                          )}
                        </td>
                      )}
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={colCount} style={{padding:0,border:"none"}}>
                          <div style={{margin:"0 0 8px 0",padding:"10px 14px",background:"var(--bg2)",borderRadius:8,border:"1px solid var(--bg4)"}}>
                            <div style={{fontSize:11,fontWeight:700,color:"var(--cyan)",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span>📦 Stock global de {l.sku}</span>
                              <span className="mono" style={{fontSize:12,color:"var(--txt)"}}>
                                Total sistema: <b>{totalSistema}</b>
                                {l.estado !== "PENDIENTE" && diff !== 0 && (
                                  <span style={{marginLeft:8,color: proyectado > totalSistema ? "#ef4444" : proyectado < totalSistema ? "#f59e0b" : "#10b981"}}>
                                    → Si aprueba: <b>{proyectado}</b> ({diff > 0 ? "+" : ""}{diff})
                                  </span>
                                )}
                              </span>
                            </div>
                            <table style={{width:"100%",fontSize:11,borderCollapse:"collapse"}}>
                              <thead>
                                <tr style={{borderBottom:"1px solid var(--bg4)"}}>
                                  <th style={{textAlign:"left",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Posición</th>
                                  <th style={{textAlign:"right",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Stock sistema</th>
                                  <th style={{textAlign:"right",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Contado</th>
                                  <th style={{textAlign:"left",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>En conteo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {allPositions.map(([pid, qty]) => {
                                  const conteoLine = conteoLinesSku.find(cl => cl.posicion_id === pid);
                                  const enConteo = conteo.posiciones.includes(pid);
                                  const esEstaLinea = pid === l.posicion_id;
                                  return (
                                    <tr key={pid} style={{borderBottom:"1px solid var(--bg3)", background: esEstaLinea ? `${diffColor}10` : "transparent"}}>
                                      <td className="mono" style={{padding:"4px 6px",fontWeight: esEstaLinea ? 800 : 500, color: esEstaLinea ? "var(--cyan)" : "var(--txt2)"}}>
                                        {pid} {esEstaLinea && "◀"}
                                      </td>
                                      <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600}}>{qty}</td>
                                      <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600,
                                        color: conteoLine && conteoLine.estado !== "PENDIENTE" ? (conteoLine.stock_contado !== qty ? "#f59e0b" : "#10b981") : "var(--txt3)"}}>
                                        {conteoLine && conteoLine.estado !== "PENDIENTE" ? conteoLine.stock_contado : "—"}
                                      </td>
                                      <td style={{padding:"4px 6px",fontSize:10}}>
                                        {enConteo ? (
                                          conteoLine && conteoLine.estado !== "PENDIENTE" ?
                                            <span style={{color:"#10b981",fontWeight:600}}>✓ Contada</span> :
                                            <span style={{color:"#f59e0b",fontWeight:600}}>⏳ Pendiente</span>
                                        ) : (
                                          <span style={{color:"var(--txt3)"}}>No incluida</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                                {/* Positions in conteo with this SKU but 0 system stock (inesperado scenarios) */}
                                {conteoLinesSku.filter(cl => !allPositions.some(([pid]) => pid === cl.posicion_id)).map(cl => (
                                  <tr key={cl.posicion_id} style={{borderBottom:"1px solid var(--bg3)", background: cl.posicion_id === l.posicion_id ? `${diffColor}10` : "transparent"}}>
                                    <td className="mono" style={{padding:"4px 6px",fontWeight: cl.posicion_id === l.posicion_id ? 800 : 500, color: cl.posicion_id === l.posicion_id ? "var(--cyan)" : "var(--txt2)"}}>
                                      {cl.posicion_id} {cl.posicion_id === l.posicion_id && "◀"}
                                    </td>
                                    <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600}}>0</td>
                                    <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600,
                                      color: cl.estado !== "PENDIENTE" ? (cl.stock_contado !== 0 ? "#f59e0b" : "#10b981") : "var(--txt3)"}}>
                                      {cl.estado !== "PENDIENTE" ? cl.stock_contado : "—"}
                                    </td>
                                    <td style={{padding:"4px 6px",fontSize:10}}>
                                      {cl.estado !== "PENDIENTE" ?
                                        <span style={{color:"#10b981",fontWeight:600}}>✓ Contada</span> :
                                        <span style={{color:"#f59e0b",fontWeight:600}}>⏳ Pendiente</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {/* Warning if position with stock not included in conteo */}
                            {allPositions.some(([pid]) => !conteo.posiciones.includes(pid)) && (
                              <div style={{marginTop:8,padding:"6px 10px",borderRadius:6,background:"#f59e0b15",border:"1px solid #f59e0b33",fontSize:10,color:"#f59e0b",fontWeight:600}}>
                                ⚠️ Hay posiciones con stock de este SKU que NO están incluidas en este conteo. Verifique antes de aprobar.
                              </div>
                            )}
                            {/* Transfer detection: if this line has +N and there are other positions with stock that could be the source */}
                            {isContado && diff > 0 && (() => {
                              // Find positions with stock that could be the source of the transfer
                              const transferSources = allPositions
                                .filter(([pid]) => pid !== l.posicion_id)
                                .filter(([pid, qty]) => {
                                  // Candidate: has stock >= diff, and is NOT in this conteo (so we can't verify it was emptied)
                                  // OR is in conteo and operator counted less than system (meaning stock was taken from there)
                                  const cl = conteoLinesSku.find(c => c.posicion_id === pid);
                                  if (!cl) return qty >= diff; // Not in conteo but has stock — likely source
                                  if (cl.estado !== "PENDIENTE" && cl.stock_contado < qty) return true; // Counted less — stock was taken
                                  return false;
                                })
                                .map(([pid, qty]) => {
                                  const cl = conteoLinesSku.find(c => c.posicion_id === pid);
                                  const available = cl && cl.estado !== "PENDIENTE" ? qty - cl.stock_contado : qty;
                                  return { pid, sysQty: qty, available, contada: cl && cl.estado !== "PENDIENTE" };
                                })
                                .filter(t => t.available > 0);

                              if (transferSources.length === 0) return null;
                              return (
                                <div style={{marginTop:8,padding:"10px 12px",borderRadius:8,background:"#3b82f610",border:"1px solid #3b82f633"}}>
                                  <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",marginBottom:6}}>
                                    🔄 Posible traspaso detectado
                                  </div>
                                  <div style={{fontSize:10,color:"var(--txt2)",marginBottom:8}}>
                                    El operador encontró +{diff} en {l.posicion_id}. Puede traspasar desde otra posición sin alterar el stock total:
                                  </div>
                                  {transferSources.map(src => {
                                    const transferQty = Math.min(diff, src.available);
                                    return (
                                      <div key={src.pid} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderRadius:6,background:"var(--bg3)",marginBottom:4}}>
                                        <div style={{fontSize:11}}>
                                          <span className="mono" style={{fontWeight:700,color:"var(--txt)"}}>{src.pid}</span>
                                          <span style={{color:"var(--txt3)",marginLeft:6}}>
                                            (sistema: {src.sysQty}{src.contada ? `, contado: ${src.sysQty - src.available}` : ""})
                                          </span>
                                          <span style={{color:"#3b82f6",marginLeft:6,fontWeight:600}}>
                                            → mover {transferQty} a {l.posicion_id}
                                          </span>
                                        </div>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); traspasarLinea(l.posicion_id, l.sku, src.pid, transferQty); }}
                                          disabled={processing}
                                          style={{padding:"4px 12px",borderRadius:6,fontSize:10,fontWeight:700,background:"#3b82f622",color:"#3b82f6",border:"1px solid #3b82f644",cursor:"pointer",whiteSpace:"nowrap"}}>
                                          Traspasar {transferQty}
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
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
        );
      })}
    </div>
  );
}

// ==================== CONFIGURACIÓN ====================
function Configuracion({ refresh }: { refresh: () => void }) {
  const [configTab, setConfigTab] = useState<"general"|"posiciones"|"mapa"|"etiquetas"|"carga_stock"|"conteos"|"conciliador">("general");
  const [conciliadorPin, setConciliadorPin] = useState("");
  const [conciliadorAuth, setConciliadorAuth] = useState(false);
  const CONCILIADOR_PIN = "9461";
  const [cats, setCats] = useState<string[]>([]);
  const [provs, setProvs] = useState<string[]>([]);
  const [newCat, setNewCat] = useState("");
  const [newProv, setNewProv] = useState("");
  const [editCat, setEditCat] = useState<{idx:number;val:string}|null>(null);
  const [editProv, setEditProv] = useState<{idx:number;val:string}|null>(null);

  // Stock import
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{imported:number;totalUnits:number}|null>(null);
  const [imported, setImported] = useState(false);

  // Assign positions
  const [unassigned, setUnassigned] = useState<{sku:string;name:string;qty:number}[]>([]);
  const [assignMap, setAssignMap] = useState<Record<string,string>>({});
  const [assignToast, setAssignToast] = useState("");

  useEffect(() => {
    setCats(getCategorias()); setProvs(getProveedores());
    setImported(wasStockImported());
    setUnassigned(getUnassignedStock());
  }, []);

  const doImport = async () => {
    if (!confirm("Esto importará las cantidades de la columna K de tu Google Sheet como stock inicial.\n\nTodo queda en posición 'SIN_ASIGNAR' hasta que les asignes posición.\n\n¿Continuar?")) return;
    setImporting(true);
    const res = await importStockFromSheet();
    setImportResult(res);
    setImporting(false);
    setImported(true);
    setUnassigned(getUnassignedStock());
    refresh();
  };

  const doAssign = (sku: string) => {
    const pos = assignMap[sku];
    if (!pos) return;
    const item = unassigned.find(u => u.sku === sku);
    if (!item) return;
    const ok = assignPosition(sku, pos, item.qty);
    if (ok) {
      setAssignToast(`${item.qty}× ${sku} → Posición ${pos}`);
      setUnassigned(getUnassignedStock());
      refresh();
      setTimeout(() => setAssignToast(""), 2000);
    }
  };

  const doAssignAll = () => {
    let count = 0;
    unassigned.forEach(item => {
      const pos = assignMap[item.sku];
      if (pos) { assignPosition(item.sku, pos, item.qty); count++; }
    });
    if (count > 0) {
      setAssignToast(`${count} SKUs asignados`);
      setUnassigned(getUnassignedStock());
      refresh();
      setTimeout(() => setAssignToast(""), 2500);
    }
  };

  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");

  // Categories
  const addCat = () => {
    if (!newCat.trim() || cats.includes(newCat.trim())) return;
    const updated = [...cats, newCat.trim()];
    setCats(updated); saveCategorias(updated); setNewCat(""); refresh();
  };
  const removeCat = (idx: number) => {
    if (!confirm("Eliminar categoría \"" + cats[idx] + "\"?")) return;
    const updated = cats.filter((_, i) => i !== idx);
    setCats(updated); saveCategorias(updated); refresh();
  };
  const saveEditCat = () => {
    if (!editCat || !editCat.val.trim()) return;
    const updated = [...cats]; updated[editCat.idx] = editCat.val.trim();
    setCats(updated); saveCategorias(updated); setEditCat(null); refresh();
  };

  // Suppliers
  const addProv = () => {
    if (!newProv.trim() || provs.includes(newProv.trim())) return;
    const updated = [...provs, newProv.trim()];
    setProvs(updated); saveProveedores(updated); setNewProv(""); refresh();
  };
  const removeProv = (idx: number) => {
    if (!confirm("Eliminar proveedor \"" + provs[idx] + "\"?")) return;
    const updated = provs.filter((_, i) => i !== idx);
    setProvs(updated); saveProveedores(updated); refresh();
  };
  const saveEditProv = () => {
    if (!editProv || !editProv.val.trim()) return;
    const updated = [...provs]; updated[editProv.idx] = editProv.val.trim();
    setProvs(updated); saveProveedores(updated); setEditProv(null); refresh();
  };

  // Move up/down
  const moveCat = (idx: number, dir: -1|1) => {
    const ni = idx + dir; if (ni < 0 || ni >= cats.length) return;
    const updated = [...cats]; [updated[idx], updated[ni]] = [updated[ni], updated[idx]];
    setCats(updated); saveCategorias(updated);
  };
  const moveProv = (idx: number, dir: -1|1) => {
    const ni = idx + dir; if (ni < 0 || ni >= provs.length) return;
    const updated = [...provs]; [updated[idx], updated[ni]] = [updated[ni], updated[idx]];
    setProvs(updated); saveProveedores(updated);
  };

  // Count products using each
  const s = getStore();
  const allProducts = Object.values(s.products);
  const catCount = (cat: string) => allProducts.filter(p => p.cat === cat).length;
  const provCount = (prov: string) => allProducts.filter(p => p.prov === prov).length;

  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {([["general","General","⚙️"],["posiciones","Posiciones","📍"],["mapa","Mapa Bodega","🗺️"],["etiquetas","Etiquetas","🖨️"],["carga_stock","Carga Stock","📥"],["conteos","Conteo Cíclico","📋"],["conciliador","Conciliador","🏦"]] as const).map(([key,label,icon])=>(
          <button key={key} onClick={()=>setConfigTab(key)} style={{padding:"8px 16px",borderRadius:8,background:configTab===key?"var(--cyan)":"var(--bg3)",color:configTab===key?"#fff":"var(--txt2)",fontWeight:configTab===key?700:500,fontSize:13,border:configTab===key?"none":"1px solid var(--bg4)",cursor:"pointer"}}>{icon} {label}</button>
        ))}
      </div>

      {configTab==="posiciones"&&<Posiciones refresh={refresh}/>}
      {configTab==="etiquetas"&&<AdminEtiquetas/>}
      {configTab==="carga_stock"&&<CargaStock refresh={refresh}/>}
      {configTab==="conteos"&&<AdminConteos refresh={refresh}/>}
      {configTab==="conciliador"&&(
        conciliadorAuth ? (
          <div className="card" style={{textAlign:"center",padding:32}}>
            <div style={{fontSize:48,marginBottom:16}}>🏦</div>
            <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Conciliador</div>
            <div style={{fontSize:13,color:"var(--txt2)",marginBottom:20}}>Conciliación bancaria y contable</div>
            <Link href="/conciliacion"><button style={{padding:"12px 32px",borderRadius:10,background:"var(--cyan)",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>Abrir Conciliador</button></Link>
          </div>
        ) : (
          <div className="card" style={{maxWidth:360,margin:"40px auto",textAlign:"center",padding:32}}>
            <div style={{fontSize:48,marginBottom:16}}>🔒</div>
            <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Acceso restringido</div>
            <div style={{fontSize:13,color:"var(--txt2)",marginBottom:20}}>Ingresa el PIN para acceder al Conciliador</div>
            <input className="form-input" type="password" inputMode="numeric" maxLength={6} value={conciliadorPin} onChange={e=>setConciliadorPin(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&conciliadorPin===CONCILIADOR_PIN)setConciliadorAuth(true);else if(e.key==="Enter")setConciliadorPin("");}} placeholder="PIN" style={{textAlign:"center",fontSize:20,letterSpacing:8,marginBottom:12,fontFamily:"var(--font-mono)"}}/>
            <button onClick={()=>{if(conciliadorPin===CONCILIADOR_PIN){setConciliadorAuth(true);}else{setConciliadorPin("");alert("PIN incorrecto");}}} style={{width:"100%",padding:"12px",borderRadius:10,background:conciliadorPin.length>=4?"var(--cyan)":"var(--bg3)",color:conciliadorPin.length>=4?"#fff":"var(--txt3)",fontWeight:700,fontSize:14,cursor:"pointer"}}>Ingresar</button>
          </div>
        )
      )}
      {configTab==="mapa"&&(
        <div className="card" style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:48,marginBottom:16}}>🗺️</div>
          <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Mapa de Bodega</div>
          <div style={{fontSize:13,color:"var(--txt2)",marginBottom:20}}>Editor visual de posiciones y layout de la bodega</div>
          <Link href="/admin/mapa"><button style={{padding:"12px 32px",borderRadius:10,background:"var(--cyan)",color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>Abrir Editor de Mapa</button></Link>
        </div>
      )}
      {configTab==="general"&&<>
      <div className="admin-grid-2">
        {/* CATEGORIAS */}
        <div className="card">
          <div className="card-title">Categorías de productos ({cats.length})</div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            <input className="form-input" value={newCat} onChange={e=>setNewCat(e.target.value)} placeholder="Nueva categoría..." onKeyDown={e=>e.key==="Enter"&&addCat()} style={{flex:1,fontSize:12}}/>
            <button onClick={addCat} disabled={!newCat.trim()} style={{padding:"8px 16px",borderRadius:8,background:newCat.trim()?"var(--green)":"var(--bg3)",color:newCat.trim()?"#fff":"var(--txt3)",fontWeight:700,fontSize:12,whiteSpace:"nowrap"}}>+ Agregar</button>
          </div>
          {cats.map((cat, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 0",borderBottom:"1px solid var(--bg3)"}}>
              {editCat?.idx === i ? (
                <>
                  <input className="form-input" value={editCat.val} onChange={e=>setEditCat({idx:i,val:e.target.value})} onKeyDown={e=>e.key==="Enter"&&saveEditCat()} autoFocus style={{flex:1,fontSize:12,padding:6}}/>
                  <button onClick={saveEditCat} style={{padding:"4px 10px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:600}}>OK</button>
                  <button onClick={()=>setEditCat(null)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </>
              ) : (
                <>
                  <div style={{display:"flex",flexDirection:"column",gap:2}}>
                    <button onClick={()=>moveCat(i,-1)} disabled={i===0} style={{background:"none",color:i===0?"var(--bg4)":"var(--txt3)",fontSize:8,lineHeight:1,padding:0,border:"none"}}>▲</button>
                    <button onClick={()=>moveCat(i,1)} disabled={i===cats.length-1} style={{background:"none",color:i===cats.length-1?"var(--bg4)":"var(--txt3)",fontSize:8,lineHeight:1,padding:0,border:"none"}}>▼</button>
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:500}}>{cat}</span>
                  <span className="mono" style={{fontSize:10,color:"var(--txt3)",minWidth:30,textAlign:"right"}}>{catCount(cat)}</span>
                  <button onClick={()=>setEditCat({idx:i,val:cat})} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Editar</button>
                  <button onClick={()=>removeCat(i)} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </>
              )}
            </div>
          ))}
        </div>

        {/* PROVEEDORES */}
        <div className="card">
          <div className="card-title">Proveedores ({provs.length})</div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            <input className="form-input" value={newProv} onChange={e=>setNewProv(e.target.value)} placeholder="Nuevo proveedor..." onKeyDown={e=>e.key==="Enter"&&addProv()} style={{flex:1,fontSize:12}}/>
            <button onClick={addProv} disabled={!newProv.trim()} style={{padding:"8px 16px",borderRadius:8,background:newProv.trim()?"var(--green)":"var(--bg3)",color:newProv.trim()?"#fff":"var(--txt3)",fontWeight:700,fontSize:12,whiteSpace:"nowrap"}}>+ Agregar</button>
          </div>
          {provs.map((prov, i) => (
            <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 0",borderBottom:"1px solid var(--bg3)"}}>
              {editProv?.idx === i ? (
                <>
                  <input className="form-input" value={editProv.val} onChange={e=>setEditProv({idx:i,val:e.target.value})} onKeyDown={e=>e.key==="Enter"&&saveEditProv()} autoFocus style={{flex:1,fontSize:12,padding:6}}/>
                  <button onClick={saveEditProv} style={{padding:"4px 10px",borderRadius:4,background:"var(--green)",color:"#fff",fontSize:10,fontWeight:600}}>OK</button>
                  <button onClick={()=>setEditProv(null)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </>
              ) : (
                <>
                  <div style={{display:"flex",flexDirection:"column",gap:2}}>
                    <button onClick={()=>moveProv(i,-1)} disabled={i===0} style={{background:"none",color:i===0?"var(--bg4)":"var(--txt3)",fontSize:8,lineHeight:1,padding:0,border:"none"}}>▲</button>
                    <button onClick={()=>moveProv(i,1)} disabled={i===provs.length-1} style={{background:"none",color:i===provs.length-1?"var(--bg4)":"var(--txt3)",fontSize:8,lineHeight:1,padding:0,border:"none"}}>▼</button>
                  </div>
                  <span style={{flex:1,fontSize:13,fontWeight:500}}>{prov}</span>
                  <span className="mono" style={{fontSize:10,color:"var(--txt3)",minWidth:30,textAlign:"right"}}>{provCount(prov)}</span>
                  <button onClick={()=>setEditProv({idx:i,val:prov})} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Editar</button>
                  <button onClick={()=>removeProv(i)} style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="admin-grid-2" style={{marginTop:12}}>
        <div className="card">
          <div className="card-title">Mantenimiento</div>
          {(() => {
            const orphanSkus = Object.keys(s.stock).filter(sku => !s.products[sku] && skuTotal(sku) > 0);
            const orphanTotal = orphanSkus.reduce((sum, sku) => sum + skuTotal(sku), 0);
            return <>
              {orphanSkus.length > 0 ? (
                <div>
                  <div style={{padding:"10px 12px",background:"var(--amberBg)",border:"1px solid var(--amberBd)",borderRadius:8,marginBottom:10}}>
                    <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:4}}>⚠️ Stock huérfano detectado</div>
                    <div style={{fontSize:11,color:"var(--txt2)"}}>{orphanSkus.length} SKU{orphanSkus.length>1?"s":""} con {orphanTotal} unidades sin producto en el diccionario</div>
                  </div>
                  {orphanSkus.map(sku => (
                    <div key={sku} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
                      <div>
                        <span className="mono" style={{fontWeight:700}}>{sku}</span>
                        <span style={{color:"var(--txt3)",marginLeft:6}}>{skuTotal(sku)} uds en {Object.keys(s.stock[sku]||{}).filter(p=>(s.stock[sku][p]||0)>0).join(", ")}</span>
                      </div>
                      <button onClick={()=>{
                        if(!confirm("Eliminar todo el stock de "+sku+"? ("+skuTotal(sku)+" unidades)"))return;
                        delete s.stock[sku];saveStore();refresh();
                      }} style={{padding:"4px 10px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--red)"}}>Eliminar stock</button>
                    </div>
                  ))}
                  <button onClick={()=>{
                    if(!confirm("Eliminar TODO el stock huérfano? ("+orphanTotal+" unidades de "+orphanSkus.length+" SKUs)"))return;
                    orphanSkus.forEach(sku=>{delete s.stock[sku];});saveStore();refresh();
                  }} style={{width:"100%",marginTop:10,padding:10,borderRadius:8,background:"var(--red)",color:"#fff",fontWeight:700,fontSize:12}}>Limpiar todo el stock huérfano</button>
                </div>
              ) : (
                <div style={{padding:12,textAlign:"center",color:"var(--green)",fontSize:12,fontWeight:600}}>Sin stock huérfano — todo limpio</div>
              )}
            </>;
          })()}
        </div>

        <div className="card">
          <div className="card-title">Información del sistema</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,fontSize:12}}>
            <div><span style={{color:"var(--txt3)"}}>Productos registrados:</span> <strong>{Object.keys(s.products).length}</strong></div>
            <div><span style={{color:"var(--txt3)"}}>SKUs con stock:</span> <strong>{Object.keys(s.stock).filter(sku=>skuTotal(sku)>0).length}</strong></div>
            <div><span style={{color:"var(--txt3)"}}>Posiciones activas:</span> <strong>{activePositions().length}</strong></div>
            <div><span style={{color:"var(--txt3)"}}>Movimientos totales:</span> <strong>{s.movements.length}</strong></div>
            <div><span style={{color:"var(--txt3)"}}>Última sync Sheet:</span> <strong>{getLastSyncTime()||"Nunca"}</strong></div>
            <div><span style={{color:"var(--txt3)"}}>PIN Admin:</span> <strong>1234</strong> <span style={{color:"var(--amber)",fontSize:10}}>(editar en código)</span></div>
            <div><span style={{color:"var(--txt3)"}}>Supabase:</span> <strong style={{color:isSupabaseConfigured()?"var(--green)":"var(--red)"}}>{isSupabaseConfigured()?"Configurado":"No configurado"}</strong></div>
          </div>
        </div>
      </div>
      </>}
    </div>
  );
}
