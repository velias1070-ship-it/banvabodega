"use client";
import { useState, useEffect, useCallback } from "react";
import { getStore, saveStore, resetStore, skuTotal, skuPositions, posContents, activePositions, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS, getCategorias, saveCategorias, getProveedores, saveProveedores, getLastSyncTime, recordMovement, findProduct, importStockFromSheet, wasStockImported, getUnassignedStock, assignPosition, isSupabaseConfigured, getCloudStatus, initStore, isStoreReady } from "@/lib/store";
import type { Product, Movement, Position, InReason, OutReason } from "@/lib/store";
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
  const [tab, setTab] = useState<"dash"|"ops"|"inv"|"mov"|"prod"|"pos"|"stock_load"|"config">("dash");
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
          {([["dash","Dashboard","📊"],["ops","Operaciones","⚡"],["inv","Inventario","📦"],["mov","Movimientos","📋"],["prod","Productos","🏷️"],["pos","Posiciones","📍"],["stock_load","Carga Stock","📥"],["config","Configuración","⚙️"]] as const).map(([key,label,icon])=>(
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
            {([["dash","Dashboard"],["ops","Ops"],["inv","Inventario"],["mov","Movim."],["prod","Productos"],["pos","Posiciones"],["stock_load","Carga"],["config","Config"]] as const).map(([key,label])=>(
              <button key={key} className={`tab ${tab===key?"active-cyan":""}`} onClick={()=>setTab(key as any)}>{label}</button>
            ))}
          </div>
          <div className="admin-content">
            {tab==="dash"&&<Dashboard/>}
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

// ==================== OPERACIONES RÁPIDAS ====================
function Operaciones({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"in"|"out"|"transfer">("in");
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

  const doConfirm = () => {
    if (!selected || !pos || qty < 1) return;

    if (mode === "transfer") {
      if (!posFrom || posFrom === pos) return;
      // Salida de origen
      recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason, sku: selected.sku, pos: posFrom, qty, who: "Admin", note: "Transferencia → " + pos });
      // Entrada en destino
      recordMovement({ ts: new Date().toISOString(), type: "in", reason: "transferencia_in" as InReason, sku: selected.sku, pos, qty, who: "Admin", note: "Transferencia ← " + posFrom });
      setLog(l => [`${qty}× ${selected.sku} | ${posFrom} → ${pos}`, ...l].slice(0, 10));
      setToast(`Transferido ${qty}× ${selected.sku}`);
    } else {
      recordMovement({ ts: new Date().toISOString(), type: mode, reason: reason as any, sku: selected.sku, pos, qty, who: "Admin", note });
      setLog(l => [`${mode === "in" ? "+" : "-"}${qty}× ${selected.sku} | Pos ${pos}`, ...l].slice(0, 10));
      setToast(`${mode === "in" ? "+" : "-"}${qty} ${selected.sku}`);
    }

    // Reset form but keep mode
    setSelected(null); setSku(""); setPos(""); setPosFrom(""); setQty(1); setNote("");
    refresh();
    setTimeout(() => setToast(""), 2000);
  };

  useEffect(() => {
    if (mode === "in") setReason("compra");
    else if (mode === "out") setReason("envio_full");
  }, [mode]);

  const maxQty = mode === "out" && selected && pos ? (getStore().stock[selected.sku]?.[pos] || 0) : 9999;
  const transferMax = mode === "transfer" && selected && posFrom ? (getStore().stock[selected.sku]?.[posFrom] || 0) : 9999;

  return (
    <div>
      {toast && <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:"2px solid var(--green)",color:"var(--green)",padding:"10px 24px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}

      <div className="admin-grid-2">
        <div className="card">
          {/* Mode */}
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            <button onClick={()=>setMode("in")} style={{flex:1,padding:"10px",borderRadius:8,fontWeight:700,fontSize:13,background:mode==="in"?"var(--greenBg)":"var(--bg3)",color:mode==="in"?"var(--green)":"var(--txt3)",border:mode==="in"?"2px solid var(--green)":"1px solid var(--bg4)"}}>Entrada</button>
            <button onClick={()=>setMode("out")} style={{flex:1,padding:"10px",borderRadius:8,fontWeight:700,fontSize:13,background:mode==="out"?"var(--redBg)":"var(--bg3)",color:mode==="out"?"var(--red)":"var(--txt3)",border:mode==="out"?"2px solid var(--red)":"1px solid var(--bg4)"}}>Salida</button>
            <button onClick={()=>setMode("transfer")} style={{flex:1,padding:"10px",borderRadius:8,fontWeight:700,fontSize:13,background:mode==="transfer"?"var(--cyanBg)":"var(--bg3)",color:mode==="transfer"?"var(--cyan)":"var(--txt3)",border:mode==="transfer"?"2px solid var(--cyan)":"1px solid var(--bg4)"}}>Transferir</button>
          </div>

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
        </div>

        {/* Log + quick info */}
        <div>
          {log.length > 0 && (
            <div className="card">
              <div className="card-title">Registro de esta sesión</div>
              {log.map((l,i)=><div key={i} style={{padding:"5px 0",borderBottom:"1px solid var(--bg3)",fontSize:12,color:i===0?"var(--txt)":"var(--txt3)",fontFamily:"'JetBrains Mono',monospace"}}>{l}</div>)}
            </div>
          )}
          <div className="card">
            <div className="card-title">Posiciones rápidas</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
              {positions.slice(0,20).map(p=>{
                const items=posContents(p.id);const tq=items.reduce((s,i)=>s+i.qty,0);
                return(
                  <div key={p.id} style={{padding:"8px 4px",borderRadius:6,textAlign:"center",background:tq>0?"var(--bg3)":"var(--bg2)",border:"1px solid var(--bg4)"}}>
                    <div className="mono" style={{fontWeight:700,fontSize:13,color:tq>0?"var(--green)":"var(--txt3)"}}>{p.id}</div>
                    {tq>0?<div style={{fontSize:9,color:"var(--txt3)"}}>{tq} uds</div>:<div style={{fontSize:9,color:"var(--txt3)"}}>—</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
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
  const s = getStore();
  const allSkus = Object.keys(s.stock).filter(sku => {
    if (skuTotal(sku) === 0) return false;
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[sku];
    return sku.toLowerCase().includes(ql)||prod?.name.toLowerCase().includes(ql)||prod?.cat?.toLowerCase().includes(ql)||prod?.prov?.toLowerCase().includes(ql);
  }).sort((a,b)=>skuTotal(b)-skuTotal(a));
  const grandTotal = allSkus.reduce((s,sku)=>s+skuTotal(sku),0);

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder="Filtrar SKU, nombre, proveedor, categoría..." style={{fontSize:13,flex:1}}/>
          <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{allSkus.length} SKUs</div>
            <div className="mono" style={{fontSize:14,fontWeight:700,color:"var(--blue)"}}>{grandTotal.toLocaleString("es-CL")} uds</div>
          </div>
        </div>
      </div>

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
