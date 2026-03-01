"use client";
/* v3.1 — conteos + pedidos ML + cron fix */
import { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, resetStore, skuTotal, skuPositions, posContents, activePositions, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS, getCategorias, saveCategorias, getProveedores, saveProveedores, getLastSyncTime, recordMovement, recordBulkMovements, findProduct, importStockFromSheet, wasStockImported, getUnassignedStock, assignPosition, isSupabaseConfigured, getCloudStatus, initStore, isStoreReady, getRecepciones, getRecepcionLineas, crearRecepcion, actualizarRecepcion, actualizarLineaRecepcion, getOperarios, anularRecepcion, pausarRecepcion, reactivarRecepcion, cerrarRecepcion, asignarOperariosRecepcion, parseRecepcionMeta, encodeRecepcionMeta, eliminarLineaRecepcion, agregarLineaRecepcion, getMapConfig, getSkusVenta, getComponentesPorML, getComponentesPorSkuVenta, getVentasPorSkuOrigen, buildPickingLineas, crearPickingSession, getPickingsByDate, getActivePickings, actualizarPicking, eliminarPicking, findSkuVenta, recordMovementAsync } from "@/lib/store";
import type { Product, Movement, Position, InReason, OutReason, DBRecepcion, DBRecepcionLinea, DBOperario, ComposicionVenta, DBPickingSession, PickingLinea, RecepcionMeta } from "@/lib/store";
import { fetchConteos, createConteo, updateConteo, deleteConteo, fetchPedidosFlex, fetchAllPedidosFlex, fetchPedidosFlexByEstado, updatePedidosFlex, fetchMLConfig, upsertMLConfig, fetchMLItemsMap, fetchShipmentsToArm, fetchAllShipments } from "@/lib/db";
import type { DBConteo, ConteoLinea, DBPedidoFlex, DBMLConfig, DBMLItemMap, ShipmentWithItems } from "@/lib/db";
import { getOAuthUrl } from "@/lib/ml";
import Link from "next/link";
import SheetSync from "@/components/SheetSync";

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
  const [tab, setTab] = useState<"dash"|"rec"|"picking"|"etiquetas"|"conteos"|"pedidos"|"ops"|"inv"|"mov"|"prod"|"pos"|"stock_load"|"config">("dash");
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
          {([["dash","Dashboard","📊"],["rec","Recepciones","📦"],["picking","Picking Flex","🏷️"],["pedidos","Pedidos ML","🛒"],["etiquetas","Etiquetas","🖨️"],["conteos","Conteo Cíclico","📋"],["ops","Operaciones","⚡"],["inv","Inventario","📦"],["mov","Movimientos","📋"],["prod","Productos","🏷️"],["pos","Posiciones","📍"],["stock_load","Carga Stock","📥"],["config","Configuración","⚙️"]] as const).map(([key,label,icon])=>(
            <button key={key} className={`sidebar-btn ${tab===key?"active":""}`} onClick={()=>setTab(key as any)}>
              <span className="sidebar-icon">{icon}</span>
              <span className="sidebar-label">{label}</span>
            </button>
          ))}
          <div style={{flex:1}}/>
          <Link href="/admin/mapa"><button className="sidebar-btn"><span className="sidebar-icon">🗺️</span><span className="sidebar-label">Mapa Bodega</span></button></Link>
          <Link href="/admin/qr-codes"><button className="sidebar-btn"><span className="sidebar-icon">🖨️</span><span className="sidebar-label">Imprimir QRs</span></button></Link>
          <button className="sidebar-btn" onClick={()=>{if(confirm("Resetear todos los datos a demo?")){resetStore();window.location.reload();}}}><span className="sidebar-icon">🔄</span><span className="sidebar-label" style={{color:"var(--amber)"}}>Reset Demo</span></button>
        </nav>

        <main className="admin-main">
          {/* Mobile tabs fallback */}
          <div className="admin-mobile-tabs">
            {([["dash","Dashboard"],["rec","Recepción"],["picking","Picking"],["pedidos","Pedidos ML"],["etiquetas","Etiquetas"],["conteos","Conteos"],["ops","Ops"],["inv","Inventario"],["mov","Movim."],["prod","Productos"],["pos","Posiciones"],["stock_load","Carga"],["config","Config"]] as const).map(([key,label])=>(
              <button key={key} className={`tab ${tab===key?"active-cyan":""}`} onClick={()=>setTab(key as any)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {tab==="dash"&&<Dashboard/>}
            {tab==="rec"&&<AdminRecepciones refresh={r}/>}
            {tab==="picking"&&<AdminPicking refresh={r}/>}
            {tab==="etiquetas"&&<AdminEtiquetas/>}
            {tab==="conteos"&&<AdminConteos refresh={r}/>}
            {tab==="pedidos"&&<AdminPedidosFlex refresh={r}/>}
            {tab==="ops"&&<Operaciones refresh={r}/>}
            {tab==="inv"&&<Inventario/>}
            {tab==="mov"&&<Movimientos/>}
            {tab==="prod"&&<Productos refresh={r}/>}
            {tab==="pos"&&<Posiciones refresh={r}/>}
            {tab==="stock_load"&&<CargaStock refresh={r}/>}
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

function AdminRecepciones({ refresh }: { refresh: () => void }) {
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<RecFilter>("activas");
  const [selRec, setSelRec] = useState<DBRecepcion|null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [operarios, setOperarios] = useState<DBOperario[]>([]);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editFolio, setEditFolio] = useState("");
  const [editProv, setEditProv] = useState("");
  const [editNotas, setEditNotas] = useState("");
  const [editAsignados, setEditAsignados] = useState<string[]>([]);

  // Anular dialog
  const [showAnular, setShowAnular] = useState(false);
  const [anularMotivo, setAnularMotivo] = useState("");

  // Create form
  const [newFolio, setNewFolio] = useState("");
  const [newProv, setNewProv] = useState("");
  const [newLineas, setNewLineas] = useState<{sku:string;nombre:string;codigoML:string;cantidad:number;costo:number;requiereEtiqueta:boolean}[]>([]);
  const [newSku, setNewSku] = useState("");
  const [newQty, setNewQty] = useState(1);

  // Add line to existing
  const [addSku, setAddSku] = useState("");
  const [addQty, setAddQty] = useState(1);

  const loadRecs = async () => { setLoading(true); setRecs(await getRecepciones()); setOperarios(await getOperarios()); setLoading(false); };
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
    setLineas(await getRecepcionLineas(rec.id!));
    const meta = parseRecepcionMeta(rec.notas || "");
    setEditFolio(rec.folio); setEditProv(rec.proveedor);
    setEditNotas(meta.notas); setEditAsignados(meta.asignados);
    setEditing(false); setShowAnular(false);
  };

  const refreshDetail = async () => {
    if (!selRec) return;
    const updatedRecs = await getRecepciones();
    setRecs(updatedRecs);
    const updated = updatedRecs.find(r => r.id === selRec.id);
    if (updated) { setSelRec(updated); const m = parseRecepcionMeta(updated.notas||""); setEditNotas(m.notas); setEditAsignados(m.asignados); }
    setLineas(await getRecepcionLineas(selRec.id!));
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
  const doCerrar = async () => { if (!selRec) return; setLoading(true); await cerrarRecepcion(selRec.id!); await loadRecs(); setSelRec(null); setLoading(false); };

  // ---- Edit save ----
  const doSaveEdit = async () => {
    if (!selRec) return; setLoading(true);
    const meta: RecepcionMeta = { notas: editNotas, asignados: editAsignados };
    await actualizarRecepcion(selRec.id!, { folio: editFolio, proveedor: editProv, notas: encodeRecepcionMeta(meta) });
    setEditing(false); await refreshDetail(); setLoading(false);
  };

  // ---- Line actions ----
  const doResetLinea = async (lineaId: string) => {
    if (!confirm("Resetear esta línea a PENDIENTE? Se perderán conteos y ubicaciones.")) return;
    await actualizarLineaRecepcion(lineaId, { estado: "PENDIENTE", qty_recibida: 0, qty_etiquetada: 0, qty_ubicada: 0, operario_conteo: "", operario_etiquetado: "", operario_ubicacion: "" });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const doDeleteLinea = async (lineaId: string) => {
    if (!confirm("Eliminar esta línea de la recepción?")) return;
    await eliminarLineaRecepcion(lineaId);
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const doUpdateLineQty = async (lineaId: string, val: string) => {
    const n = parseInt(val); if (isNaN(n) || n < 0) return;
    await actualizarLineaRecepcion(lineaId, { qty_factura: n });
    setLineas(await getRecepcionLineas(selRec!.id!));
  };
  const doAddLinea = async () => {
    if (!addSku || !selRec) return;
    const prod = getStore().products[addSku.toUpperCase()];
    await agregarLineaRecepcion(selRec.id!, {
      sku: addSku.toUpperCase(), nombre: prod?.name || addSku, codigoML: prod?.mlCode || "",
      cantidad: addQty, costo: prod?.cost || 0, requiereEtiqueta: prod?.requiresLabel !== false,
    });
    setAddSku(""); setAddQty(1);
    setLineas(await getRecepcionLineas(selRec.id!));
  };

  // Toggle operator assignment
  const toggleOp = (nombre: string) => {
    setEditAsignados(prev => prev.includes(nombre) ? prev.filter(n=>n!==nombre) : [...prev, nombre]);
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
    await crearRecepcion(newFolio, newProv, "", newLineas);
    setNewFolio(""); setNewProv(""); setNewLineas([]); setShowCreate(false);
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
        </div>

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
            <button onClick={doSaveEdit} disabled={loading} style={{padding:"10px 20px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
              {loading ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        )}

        {/* Lines table */}
        <div className="card" style={{marginTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:13,fontWeight:700}}>Líneas ({lineas.length})</div>
          </div>
          <div style={{overflowX:"auto"}}>
            <table className="tbl">
              <thead><tr><th>SKU</th><th>Producto</th><th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th><th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th><th>Estado</th>{isEditable&&<th>Acciones</th>}</tr></thead>
              <tbody>{lineas.map(l => (
                <tr key={l.id} style={{background:l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                  <td className="mono" style={{fontSize:11,fontWeight:700}}>{l.sku}</td>
                  <td style={{fontSize:11}}>{l.nombre}<br/><span className="mono" style={{fontSize:9,color:"var(--txt3)"}}>{l.codigo_ml||""}</span></td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                  <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                  <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                  <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                  <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                    background:l.estado==="UBICADA"?"var(--greenBg)":l.estado==="PENDIENTE"?"var(--redBg)":"var(--amberBg)",
                    color:l.estado==="UBICADA"?"var(--green)":l.estado==="PENDIENTE"?"var(--red)":"var(--amber)"}}>{l.estado}</span></td>
                  {isEditable&&<td style={{whiteSpace:"nowrap"}}>
                    <div style={{display:"flex",gap:4}}>
                      {l.estado !== "PENDIENTE" && <button onClick={()=>doResetLinea(l.id!)} title="Resetear a pendiente" style={{padding:"3px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:10,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>Reset</button>}
                      <button onClick={()=>{const v=prompt("Nueva cantidad factura:",String(l.qty_factura));if(v)doUpdateLineQty(l.id!,v);}} title="Editar cantidad" style={{padding:"3px 6px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer"}}>Qty</button>
                      <button onClick={()=>doDeleteLinea(l.id!)} title="Eliminar línea" style={{padding:"3px 6px",borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:10,fontWeight:700,border:"1px solid var(--redBd)",cursor:"pointer"}}>✕</button>
                    </div>
                  </td>}
                </tr>
              ))}</tbody>
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
                <input type="number" className="form-input" value={addQty} onChange={e=>setAddQty(parseInt(e.target.value)||1)} style={{width:60,textAlign:"center",fontSize:12}}/>
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
              <input type="number" className="form-input" value={newQty} onChange={e=>setNewQty(parseInt(e.target.value)||1)} style={{width:70,textAlign:"center"}}/>
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
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div className="card-title" style={{margin:0}}>Recepciones</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadRecs} disabled={loading} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading?"...":"Actualizar"}
          </button>
          <button onClick={()=>setShowCreate(true)} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
            + Nueva recepción
          </button>
        </div>
      </div>

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
          <div style={{fontSize:13,color:"var(--txt3)"}}>Sin recepciones en esta categoría.</div>
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
    await crearPickingSession(fecha, preview.lineas);
    setSaving(false);
    onCreated();
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
        <div style={{fontSize:16,fontWeight:700}}>Picking {session.fecha}</div>
        <div style={{fontSize:12,color:"var(--txt3)"}}>Estado: <strong>{session.estado}</strong> · {session.lineas.length} pedidos · {doneComps}/{totalComps} items ({pct}%)</div>
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
                    <br/>
                    {editing && !isPicked ? (
                      <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
                        <button onClick={() => changeQty(linea.id, linea.qtyPedida - 1)} disabled={linea.qtyPedida <= 1 || saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>−</button>
                        <span style={{fontSize:13,fontWeight:700,color:"var(--blue)",minWidth:20,textAlign:"center"}}>{linea.qtyPedida}</span>
                        <button onClick={() => changeQty(linea.id, linea.qtyPedida + 1)} disabled={saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>+</button>
                      </div>
                    ) : (
                      <span style={{fontSize:10,color:"var(--txt3)"}}>×{linea.qtyPedida}</span>
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
                        onChange={e=>setQueue(queue.map((q,j)=>j===i?{...q,qty:Math.max(1,parseInt(e.target.value)||1)}:q))}
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
                    <input type="number" className="form-input mono" value={ventaQty} onChange={e=>setVentaQty(Math.max(1,Math.min(ventaDisponible,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
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
                <input type="number" className="form-input mono" value={qty} onChange={e=>setQty(Math.max(1,Math.min(mode==="transfer"?transferMax:maxQty,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
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
                      <input type="number" className="form-input mono" value={bulkQtyMap[item.sku]||0} onChange={e=>setBulkQtyMap(m=>({...m,[item.sku]:Math.max(0,Math.min(item.qty,parseInt(e.target.value)||0))}))} style={{width:50,textAlign:"center",fontSize:12,padding:4}}/>
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
  const s = getStore();

  // Physical stock view
  const allSkus = Object.keys(s.stock).filter(sku => {
    if (skuTotal(sku) === 0) return false;
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[sku];
    return sku.toLowerCase().includes(ql)||prod?.name.toLowerCase().includes(ql)||prod?.cat?.toLowerCase().includes(ql)||prod?.prov?.toLowerCase().includes(ql);
  }).sort((a,b)=>skuTotal(b)-skuTotal(a));
  const grandTotal = allSkus.reduce((s,sku)=>s+skuTotal(sku),0);

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

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4}}>
            <button onClick={()=>setViewMode("fisico")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="fisico"?"var(--cyanBg)":"var(--bg3)",color:viewMode==="fisico"?"var(--cyan)":"var(--txt3)",
              border:viewMode==="fisico"?"1px solid var(--cyan)":"1px solid var(--bg4)"}}>📦 Stock Físico</button>
            <button onClick={()=>setViewMode("ml")} style={{padding:"6px 14px",borderRadius:6,fontSize:11,fontWeight:700,
              background:viewMode==="ml"?"var(--amberBg)":"var(--bg3)",color:viewMode==="ml"?"var(--amber)":"var(--txt3)",
              border:viewMode==="ml"?"1px solid var(--amber)":"1px solid var(--bg4)"}}>🛒 Publicaciones ML</button>
          </div>
          <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder={viewMode==="fisico"?"Filtrar SKU, nombre, proveedor...":"Filtrar código ML, SKU venta, nombre..."} style={{fontSize:13,flex:1}}/>
          <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
            {viewMode === "fisico" ? (
              <>
                <div style={{fontSize:10,color:"var(--txt3)"}}>{allSkus.length} SKUs</div>
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
                  <th>SKU</th><th>Producto</th><th>Cat.</th><th>Proveedor</th><th>Ubicaciones</th><th style={{textAlign:"right"}}>Total</th><th style={{textAlign:"right"}}>Valor</th>
                </tr></thead>
                <tbody>
                  {allSkus.map(sku=>{
                    const prod=s.products[sku];const total=skuTotal(sku);const positions=skuPositions(sku);
                    const isOpen=expanded===sku;
                    return([
                      <tr key={sku} onClick={()=>setExpanded(isOpen?null:sku)} style={{cursor:"pointer",background:isOpen?"var(--bg3)":"transparent"}}>
                        <td className="mono" style={{fontWeight:700,fontSize:12}}>{sku}</td>
                        <td style={{fontSize:12}}>{prod?.name||sku}</td>
                        <td><span className="tag">{prod?.cat}</span></td>
                        <td><span className="tag">{prod?.prov}</span></td>
                        <td>{positions.map(p=><span key={p.pos} className="mono" style={{fontSize:10,marginRight:6,padding:"2px 6px",background:"var(--bg3)",borderRadius:4}}>{p.pos}: {p.qty}</span>)}</td>
                        <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{total}</td>
                        <td className="mono" style={{textAlign:"right",fontSize:11}}>{prod?fmtMoney(prod.cost*total):"-"}</td>
                      </tr>,
                      isOpen && <tr key={sku+"-detail"}><td colSpan={7} style={{background:"var(--bg3)",padding:16}}>
                        <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Historial de movimientos — {sku}</div>
                        <table className="tbl"><thead><tr><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Pos</th><th>Quien</th><th>Nota</th><th style={{textAlign:"right"}}>Qty</th></tr></thead>
                          <tbody>{s.movements.filter(m=>m.sku===sku).slice(0,20).map(m=>(
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
            {allSkus.map(sku=>{
              const prod=s.products[sku];const positions=skuPositions(sku);const total=skuTotal(sku);const isOpen=expanded===sku;
              const movs=s.movements.filter(m=>m.sku===sku);
              return(
                <div key={sku} className="card" style={{marginTop:6,cursor:"pointer"}} onClick={()=>setExpanded(isOpen?null:sku)}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div className="mono" style={{fontSize:14,fontWeight:700}}>{sku}</div>
                      <div style={{fontSize:12,color:"var(--txt2)"}}>{prod?.name||sku}</div>
                      <div style={{display:"flex",gap:4,marginTop:3}}>{prod?.cat&&<span className="tag">{prod.cat}</span>}{prod?.prov&&<span className="tag">{prod.prov}</span>}</div>
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
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt2)",marginBottom:6}}>Historial ({movs.length})</div>
                    {movs.slice(0,15).map(m=>(
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

// ==================== MOVIMIENTOS ====================
function Movimientos() {
  const [filterType, setFilterType] = useState<"all"|"in"|"out">("all");
  const [filterSku, setFilterSku] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterReason, setFilterReason] = useState("");
  const s = getStore();

  let movs = [...s.movements];
  if (filterType !== "all") movs = movs.filter(m => m.type === filterType);
  if (filterSku) { const q = filterSku.toLowerCase(); movs = movs.filter(m => m.sku.toLowerCase().includes(q) || s.products[m.sku]?.name.toLowerCase().includes(q)); }
  if (filterDate) movs = movs.filter(m => m.ts.startsWith(filterDate));
  if (filterReason) movs = movs.filter(m => m.reason === filterReason);

  const totalIn = movs.filter(m=>m.type==="in").reduce((s,m)=>s+m.qty,0);
  const totalOut = movs.filter(m=>m.type==="out").reduce((s,m)=>s+m.qty,0);

  const allReasons = [...Object.keys(IN_REASONS), ...Object.keys(OUT_REASONS)];

  return (
    <div>
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
        <div style={{display:"flex",justifyContent:"space-between",marginTop:8,fontSize:12}}>
          <span style={{color:"var(--txt3)"}}>{movs.length} movimientos</span>
          <span><span style={{color:"var(--green)",fontWeight:600}}>+{totalIn.toLocaleString("es-CL")}</span> / <span style={{color:"var(--red)",fontWeight:600}}>-{totalOut.toLocaleString("es-CL")}</span></span>
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
                  <td style={{fontSize:10,color:"var(--cyan)",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis"}}>{m.note}</td>
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
                  {m.note&&<div style={{fontSize:10,color:"var(--cyan)",marginTop:1}}>{m.note}</div>}
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
    s.products[sku]={sku,name:form.name!,mlCode:form.mlCode||"",cat:form.cat||"Otros",prov:form.prov||"Otro",cost:form.cost||0,price:form.price||0,reorder:form.reorder||20};
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
                    <input type="number" min={1} max={u.qty} value={row.qty||""} onChange={e=>{
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
    rows.push(["sku_origen","nombre","unidades","codigo_ml","sku_venta","stock","posicion"].join(","));

    // Get all stock entries grouped by (sku, pos)
    for (const [sku, posMap] of Object.entries(s.stock)) {
      const prod = s.products[sku];
      const ventas = getVentasPorSkuOrigen(sku);
      
      for (const [pos, qty] of Object.entries(posMap)) {
        if (qty <= 0) continue;
        const name = prod?.name || "";
        
        if (ventas.length > 0) {
          // One row per venta mapping × position
          for (const v of ventas) {
            rows.push([
              csvEscape(sku),
              csvEscape(name),
              String(v.unidades),
              csvEscape(v.codigoMl),
              csvEscape(v.skuVenta),
              String(qty),
              csvEscape(pos),
            ].join(","));
          }
        } else {
          // No venta mapping — still export stock
          rows.push([
            csvEscape(sku),
            csvEscape(name),
            "",
            "",
            "",
            String(qty),
            csvEscape(pos),
          ].join(","));
        }
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
            <strong>Completo:</strong> sku_origen, nombre, unidades, codigo_ml, sku_venta, stock, posicion<br/>
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
  const [verTodos, setVerTodos] = useState(false);
  const [shipments, setShipments] = useState<ShipmentWithItems[]>([]);
  const [pedidos, setPedidos] = useState<DBPedidoFlex[]>([]); // legacy fallback
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncDays, setSyncDays] = useState(0);
  const [creating, setCreating] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagResult, setDiagResult] = useState<Record<string, unknown> | null>(null);
  const [mlConfig, setMlConfig] = useState<DBMLConfig | null>(null);
  const [configForm, setConfigForm] = useState({ client_id: "", client_secret: "", seller_id: "", hora_corte_lv: 13, hora_corte_sab: 12 });
  const [useNewView, setUseNewView] = useState(true); // toggle between new shipment view and legacy

  const loadPedidos = useCallback(async () => {
    setLoading(true);
    // Load new shipment-centric data
    try {
      const sData = verTodos ? await fetchAllShipments(200) : await fetchShipmentsToArm(fecha);
      setShipments(sData);
    } catch { setShipments([]); }
    // Also load legacy pedidos_flex as fallback
    const data = verTodos ? await fetchAllPedidosFlex(200) : await fetchPedidosFlex(fecha);
    setPedidos(data);
    setLoading(false);
  }, [fecha, verTodos]);

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

  // Shipment-centric counts
  const LOGISTIC_LABELS: Record<string, string> = {
    self_service: "Flex", cross_docking: "Colecta", xd_drop_off: "Drop-off", drop_off: "Correo",
  };
  const shipCounts = {
    total: shipments.length,
    flex: shipments.filter(s => s.logistic_type === "self_service").length,
    colecta: shipments.filter(s => s.logistic_type === "cross_docking").length,
    dropoff: shipments.filter(s => ["xd_drop_off", "drop_off"].includes(s.logistic_type)).length,
    atrasado: shipments.filter(s => s.handling_limit && s.handling_limit.slice(0, 10) < fecha).length,
    totalItems: shipments.reduce((acc, s) => acc + s.items.reduce((a2, i) => a2 + i.quantity, 0), 0),
  };
  // Legacy counts as fallback
  const counts = {
    total: pedidos.length,
    pendiente: pedidos.filter(p => p.estado === "PENDIENTE").length,
    en_picking: pedidos.filter(p => p.estado === "EN_PICKING").length,
    despachado: pedidos.filter(p => p.estado === "DESPACHADO").length,
    atrasado: pedidos.filter(p => p.estado !== "DESPACHADO" && p.fecha_armado < fecha).length,
  };

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

  const doCreatePicking = async () => {
    const pendientes = pedidos.filter(p => p.estado === "PENDIENTE");
    if (pendientes.length === 0) { alert("No hay pedidos pendientes"); return; }

    setCreating(true);
    try {
      // Group by SKU venta and sum quantities
      const skuMap = new Map<string, number>();
      for (const p of pendientes) {
        skuMap.set(p.sku_venta, (skuMap.get(p.sku_venta) || 0) + p.cantidad);
      }

      const items = Array.from(skuMap.entries()).map(([sku, qty]) => ({ skuVenta: sku, qty }));
      const { lineas, errors } = buildPickingLineas(items);

      if (lineas.length === 0) {
        alert("No se pudieron armar líneas de picking. Verifica que los SKU Venta estén en el diccionario.");
        setCreating(false);
        return;
      }

      if (errors.length > 0) {
        const proceed = confirm(`Advertencias:\n${errors.join("\n")}\n\n¿Crear picking de todas formas?`);
        if (!proceed) { setCreating(false); return; }
      }

      const sessionId = await crearPickingSession(fecha, lineas);

      if (sessionId) {
        // Mark pedidos as EN_PICKING and link to session
        const ids = pendientes.map(p => p.id!).filter(Boolean);
        await updatePedidosFlex(ids, { estado: "EN_PICKING", picking_session_id: sessionId });
        await loadPedidos();
        alert(`Sesión de picking creada con ${lineas.length} líneas`);
      }
    } catch (err) {
      alert("Error creando picking: " + String(err));
    }
    setCreating(false);
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

  const doDownloadLabels = async () => {
    const shippingIds = Array.from(new Set(pedidos.filter(p => p.estado !== "DESPACHADO").map(p => p.shipping_id)));
    if (shippingIds.length === 0) { alert("Sin envíos para descargar etiquetas"); return; }

    try {
      const resp = await fetch("/api/ml/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_ids: shippingIds }),
      });
      if (!resp.ok) { alert("Error descargando etiquetas"); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiquetas-${fecha}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error: " + String(err));
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
            <button onClick={doDownloadLabels} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"#a855f7",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              📄 Etiquetas
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

        {/* Date picker */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
          <input type="date" value={fecha} onChange={e => { setFecha(e.target.value); setVerTodos(false); }}
            className="form-input mono" style={{fontSize:13,padding:8,width:160}} disabled={verTodos}/>
          <button onClick={() => { setFecha(today); setVerTodos(false); }} style={{padding:"6px 12px",borderRadius:6,background: !verTodos ? "var(--bg3)" : "var(--bg2)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>Hoy</button>
          <button onClick={() => setVerTodos(!verTodos)} style={{padding:"6px 12px",borderRadius:6,background: verTodos ? "var(--cyan)" : "var(--bg3)",color: verTodos ? "#fff" : "var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {verTodos ? "● Ver todos" : "Ver todos"}
          </button>
        </div>

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
            <div className="form-group"><label className="form-label">Corte L-V (hora)</label><input type="number" className="form-input mono" value={configForm.hora_corte_lv} onChange={e => setConfigForm({...configForm, hora_corte_lv: parseInt(e.target.value) || 13})} min={0} max={23}/></div>
            <div className="form-group"><label className="form-label">Corte Sábado (hora)</label><input type="number" className="form-input mono" value={configForm.hora_corte_sab} onChange={e => setConfigForm({...configForm, hora_corte_sab: parseInt(e.target.value) || 12})} min={0} max={23}/></div>
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

      {/* Stats — shipment-centric */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:0}}>
        {[
          { label: "Envíos", value: shipCounts.total, sub: `${shipCounts.totalItems} items`, color: "#3b82f6" },
          { label: "Flex", value: shipCounts.flex, sub: "self_service", color: "#10b981" },
          { label: "Colecta", value: shipCounts.colecta, sub: "cross_docking", color: "#f59e0b" },
          { label: "Drop-off", value: shipCounts.dropoff, sub: "drop_off", color: "#a855f7" },
          { label: "Atrasados", value: shipCounts.atrasado, sub: "handling vencido", color: "#ef4444" },
        ].map(st => (
          <div key={st.label} className="card" style={{textAlign:"center",padding:12}}>
            <div style={{fontSize:24,fontWeight:800,color:st.color}}>{st.value}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{st.label}</div>
            <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{st.sub}</div>
          </div>
        ))}
      </div>

      {/* View toggle + Create picking */}
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <button onClick={() => setUseNewView(!useNewView)}
          style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
          {useNewView ? "Vista envíos" : "Vista legacy"}
        </button>
        {counts.pendiente > 0 && (
          <button onClick={doCreatePicking} disabled={creating}
            style={{padding:"8px 16px",borderRadius:8,background:"linear-gradient(135deg,#059669,#10b981)",color:"#fff",fontWeight:700,fontSize:12,border:"none",cursor:"pointer",flex:1}}>
            {creating ? "Creando..." : `Crear picking (${counts.pendiente} pendientes)`}
          </button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>Cargando...</div>
      ) : useNewView && shipments.length > 0 ? (
        /* ===== NEW SHIPMENT VIEW ===== */
        <div>
          {/* Group by logistic type */}
          {(["self_service", "cross_docking", "xd_drop_off", "drop_off"] as const).map(lt => {
            const group = shipments.filter(s => s.logistic_type === lt);
            if (group.length === 0) return null;
            const ltColor: Record<string, string> = { self_service: "#10b981", cross_docking: "#f59e0b", xd_drop_off: "#a855f7", drop_off: "#6366f1" };
            const ltLabel = LOGISTIC_LABELS[lt] || lt;
            return (
              <div key={lt}>
                <div style={{display:"flex",alignItems:"center",gap:8,margin:"12px 0 6px",padding:"0 4px"}}>
                  <span style={{fontSize:12,fontWeight:800,color:ltColor[lt] || "#94a3b8"}}>{ltLabel}</span>
                  <span style={{fontSize:10,color:"var(--txt3)"}}>({group.length} envíos)</span>
                </div>
                {group.map(ship => {
                  const hlDate = ship.handling_limit ? ship.handling_limit.slice(0, 10) : null;
                  const isOverdue = hlDate ? hlDate < fecha : false;
                  const urgColor = isOverdue ? "#ef4444" : (ltColor[lt] || "#94a3b8");
                  return (
                    <div key={ship.shipment_id} className="card" style={{padding:12,marginBottom:6,borderLeft:`3px solid ${urgColor}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span className="mono" style={{fontSize:11,fontWeight:700}}>#{ship.shipment_id}</span>
                          {isOverdue && <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,background:"#ef444422",color:"#ef4444",border:"1px solid #ef444444"}}>ATRASADO</span>}
                          <span style={{fontSize:9,fontWeight:600,padding:"2px 6px",borderRadius:3,background:`${urgColor}22`,color:urgColor}}>{ship.status}/{ship.substatus || "—"}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8,fontSize:10,color:"var(--txt3)"}}>
                          {ship.receiver_name && <span>{ship.receiver_name}</span>}
                          {ship.destination_city && <span>· {ship.destination_city}</span>}
                        </div>
                      </div>
                      <div style={{display:"flex",gap:16,fontSize:10,color:"var(--txt3)",marginBottom:6}}>
                        <span>Despachar: <strong style={{color: isOverdue ? "#ef4444" : "var(--cyan)"}}>{hlDate || "—"}</strong></span>
                        {ship.delivery_date && <span>Entrega: <strong>{ship.delivery_date.slice(0, 10)}</strong></span>}
                        <span>Origen: {ship.origin_type || "—"}</span>
                      </div>
                      {/* Items */}
                      <div style={{borderTop:"1px solid var(--bg4)",paddingTop:6}}>
                        {ship.items.map((item, idx) => (
                          <div key={idx} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",fontSize:11}}>
                            <span className="mono" style={{fontWeight:700,minWidth:100}}>{item.seller_sku}</span>
                            <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--txt2)"}}>{item.title}</span>
                            <span className="mono" style={{fontWeight:700}}>x{item.quantity}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {/* Shipments with unknown/other logistic types */}
          {shipments.filter(s => !["self_service","cross_docking","xd_drop_off","drop_off"].includes(s.logistic_type)).length > 0 && (
            <div>
              <div style={{fontSize:12,fontWeight:800,color:"var(--txt3)",margin:"12px 0 6px",padding:"0 4px"}}>Otros</div>
              {shipments.filter(s => !["self_service","cross_docking","xd_drop_off","drop_off"].includes(s.logistic_type)).map(ship => (
                <div key={ship.shipment_id} className="card" style={{padding:8,marginBottom:4,fontSize:11}}>
                  <span className="mono">#{ship.shipment_id}</span> — {ship.logistic_type} — {ship.items.length} items
                </div>
              ))}
            </div>
          )}
        </div>
      ) : shipments.length === 0 && pedidos.length === 0 ? (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:12}}>📦</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin envíos {verTodos ? "en el sistema" : `para ${fecha}`}</div>
          <div style={{fontSize:12,marginTop:4}}>Usa "Diagnosticar" para verificar la conexión. Luego "Sincronizar" con rango de días para traer envíos.</div>
          <div style={{fontSize:11,marginTop:8,color:"var(--txt3)"}}>Si es la primera vez, ejecuta primero la migración SQL para crear las tablas ml_shipments.</div>
        </div>
      ) : (
        /* ===== LEGACY TABLE VIEW ===== */
        <div className="card" style={{padding:0,overflow:"hidden"}}>
          <table className="tbl" style={{fontSize:12}}>
            <thead>
              <tr>
                <th>Despachar</th>
                <th>Hora venta</th>
                <th>Order ID</th>
                <th>SKU Venta</th>
                <th>Producto</th>
                <th style={{textAlign:"right"}}>Cant.</th>
                <th>Comprador</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map(p => {
                const estadoColors: Record<string, string> = { PENDIENTE: "#f59e0b", EN_PICKING: "#a855f7", DESPACHADO: "#10b981" };
                const isOverdue = p.estado !== "DESPACHADO" && p.fecha_armado < fecha;
                const color = isOverdue ? "#ef4444" : (estadoColors[p.estado] || "#94a3b8");
                const hora = p.fecha_venta ? new Date(p.fecha_venta).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—";
                return (
                  <tr key={p.id} style={{background: isOverdue ? "#ef444410" : p.estado === "DESPACHADO" ? "#10b98108" : p.estado === "EN_PICKING" ? "#a855f708" : "transparent"}}>
                    <td className="mono" style={{fontSize:11,fontWeight:700,color: isOverdue ? "#ef4444" : "var(--txt3)"}}>{p.fecha_armado}{isOverdue ? " !" : ""}</td>
                    <td style={{fontSize:11,color:"var(--txt3)"}}>{hora}</td>
                    <td className="mono" style={{fontSize:11}}>{p.order_id}</td>
                    <td className="mono" style={{fontWeight:700,fontSize:11}}>{p.sku_venta}</td>
                    <td style={{fontSize:11,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.nombre_producto}</td>
                    <td className="mono" style={{textAlign:"right",fontWeight:700}}>{p.cantidad}</td>
                    <td style={{fontSize:11,color:"var(--txt3)"}}>{p.buyer_nickname}</td>
                    <td><span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,background:`${color}22`,color,border:`1px solid ${color}44`}}>{isOverdue ? "ATRASADO" : p.estado}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                  return (
                    <tr key={i} style={{background: l.estado === "PENDIENTE" ? "transparent" : diff === 0 ? "#10b98108" : `${diffColor}08`}}>
                      <td className="mono" style={{fontWeight:700,fontSize:11}}>
                        {l.sku}
                        {l.es_inesperado && <span style={{marginLeft:4,fontSize:9,padding:"1px 4px",borderRadius:3,background:"#f59e0b22",color:"#f59e0b",fontWeight:700}}>NUEVO</span>}
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
                        <td style={{textAlign:"right",whiteSpace:"nowrap"}}>
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
    </div>
  );
}
