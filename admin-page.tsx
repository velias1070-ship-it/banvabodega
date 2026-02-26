"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, resetStore, skuTotal, skuPositions, posContents, activePositions, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS, getCategorias, saveCategorias, getProveedores, saveProveedores, getLastSyncTime, recordMovement, findProduct, importStockFromSheet, wasStockImported, getUnassignedStock, assignPosition, isSupabaseConfigured, getCloudStatus, initStore, isStoreReady, getRecepciones, getRecepcionLineas, crearRecepcion, getMapConfig, getSkusVenta, getComponentesPorML, getComponentesPorSkuVenta } from "@/lib/store";
import type { Product, Movement, Position, InReason, OutReason, DBRecepcion, DBRecepcionLinea, ComposicionVenta } from "@/lib/store";
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
  const [tab, setTab] = useState<"dash"|"rec"|"ops"|"inv"|"mov"|"prod"|"pos"|"stock_load"|"config">("dash");
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
          {([["dash","Dashboard","📊"],["rec","Recepciones","📦"],["ops","Operaciones","⚡"],["inv","Inventario","📦"],["mov","Movimientos","📋"],["prod","Productos","🏷️"],["pos","Posiciones","📍"],["stock_load","Carga Stock","📥"],["config","Configuración","⚙️"]] as const).map(([key,label,icon])=>(
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
            {([["dash","Dashboard"],["rec","Recepción"],["ops","Ops"],["inv","Inventario"],["mov","Movim."],["prod","Productos"],["pos","Posiciones"],["stock_load","Carga"],["config","Config"]] as const).map(([key,label])=>(
              <button key={key} className={`tab ${tab===key?"active-cyan":""}`} onClick={()=>setTab(key as any)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {tab==="dash"&&<Dashboard/>}
            {tab==="rec"&&<AdminRecepciones refresh={r}/>}
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
const ESTADO_COLORS_A: Record<string, string> = { CREADA: "var(--amber)", EN_PROCESO: "var(--blue)", COMPLETADA: "var(--green)", CERRADA: "var(--txt3)" };

function AdminRecepciones({ refresh }: { refresh: () => void }) {
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selRec, setSelRec] = useState<DBRecepcion|null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);

  // Create form
  const [newFolio, setNewFolio] = useState("");
  const [newProv, setNewProv] = useState("");
  const [newLineas, setNewLineas] = useState<{sku:string;nombre:string;codigoML:string;cantidad:number;costo:number;requiereEtiqueta:boolean}[]>([]);
  const [newSku, setNewSku] = useState("");
  const [newQty, setNewQty] = useState(1);

  const loadRecs = async () => { setLoading(true); setRecs(await getRecepciones()); setLoading(false); };
  useEffect(() => { loadRecs(); }, []);

  const openRec = async (rec: DBRecepcion) => {
    setSelRec(rec);
    setLineas(await getRecepcionLineas(rec.id!));
  };

  const addLinea = () => {
    if (!newSku) return;
    const s = getStore();
    const prod = s.products[newSku.toUpperCase()];
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
    await loadRecs();
    setLoading(false);
  };

  // Detail view
  if (selRec) {
    const total = lineas.length;
    const ubicadas = lineas.filter(l => l.estado === "UBICADA").length;
    const progress = total > 0 ? Math.round((ubicadas / total) * 100) : 0;

    return (
      <div>
        <button onClick={() => { setSelRec(null); loadRecs(); }} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver
        </button>
        <div className="card">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div className="card-title">{selRec.proveedor} — Folio {selRec.folio}</div>
              <div style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(selRec.created_at||"")} · {fmtTime(selRec.created_at||"")}</div>
            </div>
            <span style={{padding:"4px 12px",borderRadius:6,background:ESTADO_COLORS_A[selRec.estado],color:"#fff",fontSize:11,fontWeight:700}}>{selRec.estado}</span>
          </div>
          <div style={{marginTop:10,background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:"var(--green)",borderRadius:6}}/>
          </div>
          <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>{ubicadas}/{total} completadas</div>
        </div>
        <div className="card" style={{marginTop:12}}>
          <table className="tbl">
            <thead><tr><th>SKU</th><th>Producto</th><th>ML</th><th style={{textAlign:"right"}}>Factura</th><th style={{textAlign:"right"}}>Recibido</th><th style={{textAlign:"right"}}>Etiq.</th><th style={{textAlign:"right"}}>Ubic.</th><th>Estado</th></tr></thead>
            <tbody>{lineas.map(l => (
              <tr key={l.id} style={{background:l.estado==="UBICADA"?"var(--greenBg)":"transparent"}}>
                <td className="mono" style={{fontSize:11,fontWeight:700}}>{l.sku}</td>
                <td style={{fontSize:11}}>{l.nombre}</td>
                <td className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{l.codigo_ml||"—"}</td>
                <td className="mono" style={{textAlign:"right"}}>{l.qty_factura}</td>
                <td className="mono" style={{textAlign:"right",color:l.qty_recibida>0?(l.qty_recibida===l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||"—"}</td>
                <td className="mono" style={{textAlign:"right"}}>{l.qty_etiquetada||"—"}</td>
                <td className="mono" style={{textAlign:"right",color:(l.qty_ubicada||0)>0?"var(--green)":"var(--txt3)"}}>{l.qty_ubicada||"—"}</td>
                <td style={{fontSize:10,fontWeight:700,color:l.estado==="UBICADA"?"var(--green)":l.estado==="PENDIENTE"?"var(--red)":"var(--amber)"}}>{l.estado}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    );
  }

  // Create form
  if (showCreate) {
    const s = getStore();
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

  // List view
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div className="card-title" style={{margin:0}}>Recepciones</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadRecs} disabled={loading} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading?"...":"🔄"}
          </button>
          <button onClick={()=>setShowCreate(true)} style={{padding:"8px 16px",borderRadius:6,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700}}>
            + Nueva recepción
          </button>
        </div>
      </div>

      {recs.length === 0 && !loading && (
        <div className="card" style={{textAlign:"center",padding:32}}>
          <div style={{fontSize:13,color:"var(--txt3)"}}>Sin recepciones. Crea una manualmente o desde la app de etiquetas.</div>
        </div>
      )}

      <div className="desktop-only">
        <table className="tbl">
          <thead><tr><th>Folio</th><th>Proveedor</th><th>Fecha</th><th>Estado</th><th style={{textAlign:"right"}}>Líneas</th><th></th></tr></thead>
          <tbody>{recs.map(rec => (
            <tr key={rec.id} onClick={()=>openRec(rec)} style={{cursor:"pointer"}}>
              <td className="mono" style={{fontWeight:700}}>{rec.folio}</td>
              <td>{rec.proveedor}</td>
              <td style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(rec.created_at||"")} {fmtTime(rec.created_at||"")}</td>
              <td><span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{rec.estado}</span></td>
              <td style={{textAlign:"right"}}>—</td>
              <td><button style={{fontSize:10,padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)"}}>Ver →</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div className="mobile-only">
        {recs.map(rec => (
          <div key={rec.id} onClick={()=>openRec(rec)} style={{padding:12,marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <div style={{fontWeight:700,fontSize:13}}>{rec.proveedor}</div>
              <span style={{padding:"2px 8px",borderRadius:4,background:ESTADO_COLORS_A[rec.estado],color:"#fff",fontSize:10,fontWeight:700}}>{rec.estado}</span>
            </div>
            <div style={{fontSize:11,color:"var(--txt3)"}}>Folio: {rec.folio} · {fmtDate(rec.created_at||"")}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== OPERACIONES RÁPIDAS ====================
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
            <thead><tr><th>SKU</th><th>Nombre</th><th>Código ML</th><th>Categoría</th><th>Proveedor</th><th style={{textAlign:"right"}}>Costo</th><th style={{textAlign:"right"}}>Precio ML</th><th style={{textAlign:"right"}}>Stock</th><th></th></tr></thead>
            <tbody>{prods.map(p=>(
              <tr key={p.sku}>
                <td className="mono" style={{fontWeight:700,fontSize:12}}>{p.sku}</td>
                <td style={{fontSize:12}}>{p.name}</td>
                <td className="mono" style={{fontSize:11,color:"var(--txt3)"}}>{p.mlCode||"-"}</td>
                <td><span className="tag">{p.cat}</span></td>
                <td><span className="tag">{p.prov}</span></td>
                <td className="mono" style={{textAlign:"right",fontSize:11}}>{fmtMoney(p.cost)}</td>
                <td className="mono" style={{textAlign:"right",fontSize:11}}>{fmtMoney(p.price)}</td>
                <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{skuTotal(p.sku)}</td>
                <td style={{textAlign:"right"}}>
                  <button onClick={()=>startEdit(p)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)",marginRight:4}}>Editar</button>
                  <button onClick={()=>remove(p.sku)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mobile-only">
        {prods.map(p=>(
          <div key={p.sku} className="card" style={{marginTop:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</div>
                <div style={{fontSize:12,color:"var(--txt2)"}}>{p.name}</div>
                <div style={{display:"flex",gap:4,marginTop:3}}><span className="tag">{p.cat}</span><span className="tag">{p.prov}</span>{p.mlCode&&<span className="tag mono">{p.mlCode}</span>}</div>
                <div style={{fontSize:10,color:"var(--txt3)",marginTop:3}}>Costo: {fmtMoney(p.cost)} | ML: {fmtMoney(p.price)} | Stock: {skuTotal(p.sku)}</div>
              </div>
              <div style={{display:"flex",gap:4}}>
                <button onClick={()=>startEdit(p)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Editar</button>
                <button onClick={()=>remove(p.sku)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
              </div>
            </div>
          </div>
        ))}
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
