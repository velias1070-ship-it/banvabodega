"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { getStore, findProduct, findPosition, activePositions, skuTotal, skuPositions, posContents, recordMovement, IN_REASONS, OUT_REASONS, initStore, refreshStore, isSupabaseConfigured, getMapConfig } from "@/lib/store";
import type { Product, InReason, OutReason } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });
import SheetSync from "@/components/SheetSync";

const CLOUD_SYNC_INTERVAL = 10_000;

export default function OperadorPage() {
  const [screen, setScreen] = useState<"menu"|"in"|"out"|"transfer"|"stock">("menu");
  const [,setTick] = useState(0);
  const r = useCallback(() => setTick(t => t + 1), []);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cloudOk, setCloudOk] = useState(false);

  useEffect(() => { setMounted(true); initStore().then(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!isSupabaseConfigured() || loading) return;
    setCloudOk(true);
    const interval = setInterval(async () => { await refreshStore(); r(); }, CLOUD_SYNC_INTERVAL);
    return () => clearInterval(interval);
  }, [r, loading]);

  if (!mounted) return null;
  if (loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Bodega</div>
        <div style={{color:"var(--txt3)"}}>Conectando...</div>
      </div>
    </div>
  );

  const goBack = () => { setScreen("menu"); r(); };

  return (
    <div className="app">
      <div className="topbar">
        {screen === "menu" ? (
          <Link href="/"><button className="back-btn">&#8592;</button></Link>
        ) : (
          <button className="back-btn" onClick={goBack}>&#8592;</button>
        )}
        <h1>BANVA Bodega</h1>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {cloudOk && <span title="Sincronizado" style={{fontSize:10,color:"var(--green)"}}>☁️</span>}
          <Link href="/operador/picking">
            <button style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"#f59e0b",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🏷️ Picking</button>
          </Link>
          <Link href="/operador/recepciones">
            <button style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>📦 Recepción</button>
          </Link>
        </div>
      </div>
      <SheetSync onSynced={r}/>
      <div style={{padding:12}}>
        {screen === "menu" && <MainMenu onSelect={setScreen}/>}
        {screen === "in" && <Ingreso refresh={r}/>}
        {screen === "out" && <Salida refresh={r}/>}
        {screen === "transfer" && <Traspaso refresh={r}/>}
        {screen === "stock" && <StockView/>}
      </div>
    </div>
  );
}

// ==================== MAIN MENU ====================
function MainMenu({ onSelect }: { onSelect: (s: "in"|"out"|"transfer"|"stock") => void }) {
  const s = getStore();
  const totalSkus = Object.keys(s.stock).filter(sku => skuTotal(sku) > 0).length;
  const totalUnits = Object.values(s.stock).reduce((t, posMap) =>
    t + Object.values(posMap).reduce((s, q) => s + Math.max(0, q), 0), 0);

  const buttons: { key: "in"|"out"|"transfer"|"stock"; icon: string; label: string; sub: string; color: string; bg: string }[] = [
    { key: "in", icon: "📥", label: "INGRESO", sub: "Guardar productos", color: "#10b981", bg: "linear-gradient(135deg, #064e3b, #065f46)" },
    { key: "out", icon: "📤", label: "SALIDA", sub: "Sacar productos", color: "#ef4444", bg: "linear-gradient(135deg, #450a0a, #7f1d1d)" },
    { key: "transfer", icon: "🔄", label: "TRASPASO", sub: "Mover entre posiciones", color: "#06b6d4", bg: "linear-gradient(135deg, #0c4a6e, #164e63)" },
    { key: "stock", icon: "📦", label: "STOCK", sub: `${totalSkus} productos · ${totalUnits.toLocaleString()} uds`, color: "#3b82f6", bg: "linear-gradient(135deg, #1e1b4b, #312e81)" },
  ];

  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:8}}>
      {buttons.map(b => (
        <button key={b.key} onClick={() => onSelect(b.key)}
          style={{padding:"28px 16px",borderRadius:16,background:b.bg,border:`2px solid ${b.color}33`,
            display:"flex",flexDirection:"column",alignItems:"center",gap:8,cursor:"pointer",
            transition:"transform .1s",boxShadow:`0 4px 20px ${b.color}15`}}>
          <span style={{fontSize:36}}>{b.icon}</span>
          <span style={{fontSize:16,fontWeight:800,color:b.color,letterSpacing:1}}>{b.label}</span>
          <span style={{fontSize:11,color:"#94a3b8",fontWeight:500}}>{b.sub}</span>
        </button>
      ))}
    </div>
  );
}

// ==================== TOAST ====================
function useToast() {
  const [msg, setMsg] = useState("");
  const [type, setType] = useState<"ok"|"err">("ok");
  const show = (m: string, t: "ok"|"err" = "ok") => { setMsg(m); setType(t); setTimeout(() => setMsg(""), 2500); };
  const Toast = msg ? (
    <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
      border:`2px solid ${type==="ok"?"#10b981":"#f59e0b"}`,color:type==="ok"?"#10b981":"#f59e0b",
      padding:"10px 20px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)",maxWidth:"90vw",textAlign:"center"}}>
      {msg}
    </div>
  ) : null;
  return { show, Toast };
}

// ==================== SMART PRODUCT SEARCH ====================
function ProductSearch({ onSelect, placeholder }: { onSelect: (p: Product) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.length >= 2) { setResults(findProduct(q).slice(0, 8)); setOpen(true); }
    else { setResults([]); setOpen(false); }
  }, [q]);

  const select = (p: Product) => { setQ(""); setOpen(false); onSelect(p); };

  return (
    <div style={{position:"relative"}}>
      <input className="form-input" value={q} onChange={e=>setQ(e.target.value)}
        placeholder={placeholder || "Buscar producto..."}
        onFocus={()=>{if(results.length)setOpen(true);}}
        style={{fontSize:16,padding:"14px 16px",borderRadius:12}}/>
      {open && results.length > 0 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:100,background:"var(--bg2)",border:"1px solid var(--bg4)",
          borderRadius:"0 0 12px 12px",maxHeight:280,overflow:"auto",boxShadow:"0 8px 24px rgba(0,0,0,0.5)"}}>
          {results.map(p => (
            <div key={p.sku} onClick={()=>select(p)} style={{padding:"12px 14px",borderBottom:"1px solid var(--bg3)",cursor:"pointer"}}
              onMouseEnter={e=>(e.currentTarget.style.background="var(--bg3)")}
              onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div className="mono" style={{fontWeight:700,fontSize:14}}>{p.sku}</div>
                  <div style={{fontSize:12,color:"var(--txt2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                </div>
                <div className="mono" style={{fontSize:14,fontWeight:700,color:"#3b82f6",marginLeft:12}}>{skuTotal(p.sku)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && q.length >= 2 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:100,background:"var(--bg2)",border:"1px solid var(--bg4)",
          borderRadius:"0 0 12px 12px",padding:16,textAlign:"center",color:"#f59e0b",fontSize:13}}>
          No se encontró &quot;{q}&quot;
        </div>
      )}
    </div>
  );
}

// ==================== OPERATOR MINI MAP ====================
function OperatorMiniMap({ selectedPos, onSelectPos, highlightPositions }: {
  selectedPos: string; onSelectPos: (posId: string) => void; highlightPositions?: Set<string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(16);
  const cfg = getMapConfig();
  const positions = activePositions().filter(p => p.active && p.mx !== undefined);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) setCellSize(Math.max(10, Math.floor((containerRef.current.clientWidth - 4) / cfg.gridW)));
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cfg.gridW]);

  const mapW = cfg.gridW * cellSize, mapH = cfg.gridH * cellSize;

  return (
    <div ref={containerRef} style={{width:"100%",position:"relative",background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:10,overflow:"hidden",marginBottom:8}}>
      <div style={{width:mapW,height:mapH,position:"relative",margin:"0 auto"}}>
        <svg width={mapW} height={mapH} style={{position:"absolute",top:0,left:0,pointerEvents:"none",opacity:0.06}}>
          {Array.from({length:cfg.gridW+1}).map((_,i)=><line key={"v"+i} x1={i*cellSize} y1={0} x2={i*cellSize} y2={mapH} stroke="#94a3b8" strokeWidth={1}/>)}
          {Array.from({length:cfg.gridH+1}).map((_,i)=><line key={"h"+i} x1={0} y1={i*cellSize} x2={mapW} y2={i*cellSize} stroke="#94a3b8" strokeWidth={1}/>)}
        </svg>
        {cfg.objects.map(o=>(
          <div key={o.id} style={{position:"absolute",left:o.mx*cellSize,top:o.my*cellSize,width:o.mw*cellSize,height:o.mh*cellSize,background:(o.color||"#64748b")+"18",border:`1px dashed ${o.color||"#64748b"}44`,borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:1}}>
            {o.mw*cellSize > 30 && <div style={{fontSize:Math.max(6,cellSize*0.28),color:(o.color||"#64748b")+"88",fontWeight:600,textAlign:"center",overflow:"hidden"}}>{o.label}</div>}
          </div>
        ))}
        {positions.map(p=>{
          const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
          const color=p.color||"#10b981";
          const isSel=selectedPos===p.id;
          const isHL=highlightPositions?.has(p.id);
          const items=posContents(p.id);
          const tq=items.reduce((s,i)=>s+i.qty,0);
          const isEmpty=tq===0;
          return(
            <div key={p.id} onClick={()=>onSelectPos(p.id)}
              style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                background:isSel?color+"55":isHL?"#f59e0b33":isEmpty?color+"0a":color+"1a",
                border:`2px solid ${isSel?"#fff":isHL?"#f59e0b":isEmpty?color+"33":color}`,borderRadius:4,
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                cursor:"pointer",zIndex:isSel?20:isHL?15:10,
                boxShadow:isSel?`0 0 0 2px ${color}, 0 0 12px ${color}66`:"none",
                transition:"all .15s",userSelect:"none"}}>
              <div className="mono" style={{fontSize:Math.max(8,Math.min(13,cellSize*0.45)),fontWeight:800,color:isSel?"#fff":isEmpty?color+"55":color,lineHeight:1}}>{p.id}</div>
              {tq>0 && mh*cellSize>24 && <div className="mono" style={{fontSize:Math.max(6,cellSize*0.25),color:"#3b82f6",fontWeight:600,marginTop:1}}>{tq}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== INGRESO ====================
function Ingreso({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [pos, setPos] = useState("");
  const [posLabel, setPosLabel] = useState("");
  const [product, setProduct] = useState<Product|null>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<InReason>("compra");
  const [note, setNote] = useState("");
  const [cam, setCam] = useState(false);
  const [step, setStep] = useState(0);

  const handleScan = useCallback((code: string) => {
    const p = findPosition(code);
    if (p) { setPos(p.id); setPosLabel(p.label); setStep(1); setCam(false); if (navigator.vibrate) navigator.vibrate(100); }
    else show("Posición no reconocida", "err");
  }, []);

  const handleManualPos = (posId: string) => {
    const p = activePositions().find(x => x.id === posId);
    if (p) { setPos(p.id); setPosLabel(p.label); setStep(1); setCam(false); }
  };

  const doConfirm = () => {
    if (!product || !pos || qty < 1) return;
    recordMovement({ ts: new Date().toISOString(), type: "in", reason, sku: product.sku, pos, qty, who: "Operador", note });
    show(`+${qty} ${product.sku} → ${posLabel}`);
    setStep(0); setPos(""); setPosLabel(""); setProduct(null); setQty(1); setNote("");
    refresh();
  };

  const reset = () => { setStep(0); setPos(""); setPosLabel(""); setProduct(null); setQty(1); setNote(""); setCam(false); };
  const posItems = pos ? posContents(pos) : [];

  return (
    <div>
      {Toast}
      {step === 0 && (
        <div className="card">
          <div style={{fontSize:15,fontWeight:700,marginBottom:12,color:"#10b981"}}>📥 ¿Dónde guardas?</div>
          <BarcodeScanner active={true} onScan={handleScan} label="Escanea QR de la POSICIÓN" mode="qr"/>
          <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>O toca en el mapa:</div>
          <OperatorMiniMap selectedPos={pos} onSelectPos={handleManualPos}/>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <SelTag color="#10b981" label="Posición" value={`${pos} — ${posLabel}`}/>
          {posItems.length > 0 && <PosContent items={posItems}/>}
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:8}}>¿Qué producto guardas?</div>
          <ProductSearch onSelect={(p) => { setProduct(p); setStep(2); }} placeholder="Nombre, SKU o código..."/>
          <CancelBtn onClick={reset}/>
        </div>
      )}

      {step === 2 && product && (
        <div className="card">
          <SelTag color="#10b981" label="Posición" value={`${pos} — ${posLabel}`}/>
          <SelTag color="#3b82f6" label="Producto" value={`${product.sku} — ${product.name}`}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:12}}>¿Cuántos?</div>
          <QtyPicker qty={qty} setQty={setQty}/>
          <div style={{marginTop:12}}>
            <div style={{fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:6}}>Motivo:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {(Object.entries(IN_REASONS) as [InReason, string][]).map(([k,v]) => (
                <button key={k} onClick={()=>setReason(k)} style={{padding:"10px 8px",borderRadius:8,fontSize:12,fontWeight:600,textAlign:"center",
                  background:reason===k?"#065f4622":"var(--bg3)",color:reason===k?"#10b981":"#94a3b8",
                  border:reason===k?"2px solid #10b981":"1px solid var(--bg4)"}}>{v}</button>
              ))}
            </div>
          </div>
          <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota (opcional)..." style={{marginTop:10,fontSize:13}}/>
          <button onClick={doConfirm}
            style={{marginTop:16,width:"100%",padding:16,borderRadius:12,fontWeight:700,fontSize:16,color:"#fff",background:"linear-gradient(135deg,#059669,#10b981)"}}>
            CONFIRMAR +{qty} × {product.sku}
          </button>
          <CancelBtn onClick={()=>setStep(1)} label="Volver"/>
        </div>
      )}
    </div>
  );
}

// ==================== SALIDA ====================
function Salida({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [product, setProduct] = useState<Product|null>(null);
  const [selectedPos, setSelectedPos] = useState("");
  const [selectedPosLabel, setSelectedPosLabel] = useState("");
  const [maxQty, setMaxQty] = useState(0);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<OutReason>("envio_full");
  const [note, setNote] = useState("");
  const [step, setStep] = useState(0);

  const selectProduct = (p: Product) => {
    setProduct(p);
    const positions = skuPositions(p.sku);
    if (positions.length === 0) { show(p.sku + " sin stock", "err"); return; }
    if (positions.length === 1) { setSelectedPos(positions[0].pos); setSelectedPosLabel(positions[0].label); setMaxQty(positions[0].qty); setStep(2); }
    else setStep(1);
  };

  const doConfirm = () => {
    if (!product || !selectedPos || qty < 1) return;
    const take = Math.min(qty, maxQty);
    recordMovement({ ts: new Date().toISOString(), type: "out", reason, sku: product.sku, pos: selectedPos, qty: take, who: "Operador", note });
    show(`-${take} ${product.sku} de ${selectedPosLabel}`);
    reset(); refresh();
  };

  const reset = () => { setStep(0); setProduct(null); setSelectedPos(""); setSelectedPosLabel(""); setQty(1); setNote(""); };

  return (
    <div>
      {Toast}
      {step === 0 && (
        <div className="card">
          <div style={{fontSize:15,fontWeight:700,marginBottom:12,color:"#ef4444"}}>📤 ¿Qué producto sacas?</div>
          <ProductSearch onSelect={selectProduct} placeholder="Nombre, SKU o código..."/>
        </div>
      )}

      {step === 1 && product && (
        <div className="card">
          <SelTag color="#f59e0b" label="Producto" value={`${product.sku} — ${product.name}`}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:8}}>¿De dónde sacas?</div>
          <div style={{fontSize:12,color:"#94a3b8",marginBottom:8}}>Stock total: <strong style={{color:"#3b82f6"}}>{skuTotal(product.sku)}</strong></div>
          {skuPositions(product.sku).map(sp => (
            <button key={sp.pos} onClick={()=>{setSelectedPos(sp.pos);setSelectedPosLabel(sp.label);setMaxQty(sp.qty);setQty(1);setStep(2);}}
              style={{width:"100%",padding:"14px 16px",marginBottom:6,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg4)",
                display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
              <div><span className="mono" style={{fontWeight:700,fontSize:16,color:"#10b981"}}>{sp.pos}</span><span style={{fontSize:12,color:"#94a3b8",marginLeft:8}}>{sp.label}</span></div>
              <div className="mono" style={{fontWeight:700,fontSize:18,color:"#3b82f6"}}>{sp.qty}</div>
            </button>
          ))}
          <div style={{marginTop:8,fontSize:11,color:"#06b6d4",fontWeight:600,marginBottom:4}}>🗺️ Posiciones en mapa:</div>
          <OperatorMiniMap selectedPos="" onSelectPos={(id)=>{
            const sp = skuPositions(product.sku).find(x=>x.pos===id);
            if(sp){setSelectedPos(sp.pos);setSelectedPosLabel(sp.label);setMaxQty(sp.qty);setQty(1);setStep(2);}
          }} highlightPositions={new Set(skuPositions(product.sku).map(x=>x.pos))}/>
          <CancelBtn onClick={reset}/>
        </div>
      )}

      {step === 2 && product && (
        <div className="card">
          <SelTag color="#f59e0b" label="Producto" value={`${product.sku} — ${product.name}`}/>
          <SelTag color="#06b6d4" label="Desde" value={`${selectedPos} — ${selectedPosLabel} (${maxQty} disp.)`}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:12}}>¿Cuántos sacas?</div>
          <QtyPicker qty={qty} setQty={setQty} max={maxQty}/>
          <div style={{marginTop:12}}>
            <div style={{fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:6}}>Motivo:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {(Object.entries(OUT_REASONS) as [OutReason, string][]).map(([k,v]) => (
                <button key={k} onClick={()=>setReason(k)} style={{padding:"10px 8px",borderRadius:8,fontSize:12,fontWeight:600,textAlign:"center",
                  background:reason===k?"#7f1d1d22":"var(--bg3)",color:reason===k?"#ef4444":"#94a3b8",
                  border:reason===k?"2px solid #ef4444":"1px solid var(--bg4)"}}>{v}</button>
              ))}
            </div>
          </div>
          <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota: # orden, ref envío..." style={{marginTop:10,fontSize:13}}/>
          <button onClick={doConfirm}
            style={{marginTop:16,width:"100%",padding:16,borderRadius:12,fontWeight:700,fontSize:16,color:"#fff",background:"linear-gradient(135deg,#dc2626,#ef4444)"}}>
            CONFIRMAR SALIDA −{Math.min(qty,maxQty)} × {product.sku}
          </button>
          <CancelBtn onClick={()=>{skuPositions(product.sku).length>1?setStep(1):reset();}} label="Volver"/>
        </div>
      )}
    </div>
  );
}

// ==================== TRASPASO INTERNO ====================
function Traspaso({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [step, setStep] = useState(0);
  const [sourcePos, setSourcePos] = useState("");
  const [sourcePosLabel, setSourcePosLabel] = useState("");
  const [product, setProduct] = useState<{sku:string;name:string;qty:number}|null>(null);
  const [destPos, setDestPos] = useState("");
  const [destPosLabel, setDestPosLabel] = useState("");
  const [qty, setQty] = useState(1);
  const [cam, setCam] = useState(false);
  const [camDest, setCamDest] = useState(false);

  const sourceItems = sourcePos ? posContents(sourcePos) : [];

  const handleScanSource = useCallback((code: string) => {
    const p = findPosition(code);
    if (p) { setSourcePos(p.id); setSourcePosLabel(p.label); setStep(1); setCam(false); if (navigator.vibrate) navigator.vibrate(100); }
    else show("Posición no reconocida", "err");
  }, []);

  const handleScanDest = useCallback((code: string) => {
    const p = findPosition(code);
    if (p) {
      if (p.id === sourcePos) { show("¡Misma posición!", "err"); return; }
      setDestPos(p.id); setDestPosLabel(p.label); setStep(3); setCamDest(false); if (navigator.vibrate) navigator.vibrate(100);
    } else show("Posición no reconocida", "err");
  }, [sourcePos]);

  const selectDestPos = (posId: string) => {
    if (posId === sourcePos) { show("¡Misma posición!", "err"); return; }
    const p = activePositions().find(x => x.id === posId);
    if (p) { setDestPos(p.id); setDestPosLabel(p.label); setStep(3); setCamDest(false); }
  };

  const doConfirm = () => {
    if (!product || !sourcePos || !destPos || qty < 1) return;
    const take = Math.min(qty, product.qty);
    recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason, sku: product.sku, pos: sourcePos, qty: take, who: "Operador", note: `Traspaso → ${destPos}` });
    recordMovement({ ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason, sku: product.sku, pos: destPos, qty: take, who: "Operador", note: `Traspaso ← ${sourcePos}` });
    show(`🔄 ${take}× ${product.sku}: ${sourcePos} → ${destPos}`);
    reset(); refresh();
  };

  const reset = () => { setStep(0); setSourcePos(""); setSourcePosLabel(""); setProduct(null); setDestPos(""); setDestPosLabel(""); setQty(1); setCam(false); setCamDest(false); };

  return (
    <div>
      {Toast}
      {/* STEP 0: Select source */}
      {step === 0 && (
        <div className="card">
          <div style={{fontSize:15,fontWeight:700,marginBottom:12,color:"#06b6d4"}}>🔄 ¿De dónde mueves?</div>
          <BarcodeScanner active={true} onScan={handleScanSource} label="Escanea posición ORIGEN" mode="qr"/>
          <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>O toca en el mapa:</div>
          <OperatorMiniMap selectedPos={sourcePos} onSelectPos={(id)=>{
            const p = activePositions().find(x=>x.id===id);
            if(p){setSourcePos(p.id);setSourcePosLabel(p.label);setStep(1);setCam(false);}
          }}/>
        </div>
      )}

      {/* STEP 1: Select product from source */}
      {step === 1 && (
        <div className="card">
          <SelTag color="#06b6d4" label="Origen" value={`${sourcePos} — ${sourcePosLabel}`}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:8}}>¿Qué mueves?</div>
          {sourceItems.length === 0 ? (
            <div style={{padding:20,textAlign:"center",color:"#94a3b8"}}>
              <div style={{fontSize:24,marginBottom:8}}>📭</div>
              <div>Posición vacía</div>
            </div>
          ) : sourceItems.map(item => (
            <button key={item.sku} onClick={()=>{setProduct(item);setQty(item.qty);setStep(2);}}
              style={{width:"100%",padding:"14px 16px",marginBottom:6,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg4)",
                display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",textAlign:"left"}}>
              <div style={{flex:1,minWidth:0}}>
                <div className="mono" style={{fontWeight:700,fontSize:14}}>{item.sku}</div>
                <div style={{fontSize:12,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
              </div>
              <div className="mono" style={{fontWeight:700,fontSize:18,color:"#3b82f6",marginLeft:12}}>{item.qty}</div>
            </button>
          ))}
          <CancelBtn onClick={reset}/>
        </div>
      )}

      {/* STEP 2: Select destination */}
      {step === 2 && product && (
        <div className="card">
          <SelTag color="#06b6d4" label="Origen" value={sourcePos}/>
          <SelTag color="#3b82f6" label="Producto" value={`${product.sku} — ${product.name} (${product.qty})`}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:12,marginTop:8}}>¿A dónde lo mueves?</div>
          <BarcodeScanner active={true} onScan={handleScanDest} label="Escanea posición DESTINO" mode="qr"/>
          <div style={{fontSize:11,color:"#94a3b8",marginBottom:6}}>O toca en el mapa:</div>
          <OperatorMiniMap selectedPos={destPos} onSelectPos={selectDestPos}/>
          <CancelBtn onClick={()=>setStep(1)} label="Volver"/>
        </div>
      )}

      {/* STEP 3: Quantity + confirm */}
      {step === 3 && product && (
        <div className="card">
          <SelTag color="#06b6d4" label="Origen" value={sourcePos}/>
          <SelTag color="#3b82f6" label="Producto" value={`${product.sku}`}/>
          <SelTag color="#10b981" label="Destino" value={destPos}/>
          <div style={{fontSize:15,fontWeight:700,marginBottom:10,marginTop:12}}>¿Cuántos mueves?</div>
          <QtyPicker qty={qty} setQty={setQty} max={product.qty}/>
          <button onClick={doConfirm}
            style={{marginTop:16,width:"100%",padding:16,borderRadius:12,fontWeight:700,fontSize:16,color:"#fff",background:"linear-gradient(135deg,#0891b2,#06b6d4)"}}>
            MOVER {Math.min(qty,product.qty)}× → {destPos}
          </button>
          <CancelBtn onClick={()=>setStep(2)} label="Volver"/>
        </div>
      )}
    </div>
  );
}

// ==================== STOCK VIEW ====================
function StockView() {
  const [q, setQ] = useState("");
  const [selectedSku, setSelectedSku] = useState<string|null>(null);
  const [selectedPos, setSelectedPos] = useState("");
  const s = getStore();

  const allSkus = q.length >= 2
    ? findProduct(q).map(p => p.sku).filter(sku => skuTotal(sku) > 0)
    : Object.keys(s.stock).filter(sku => skuTotal(sku) > 0);

  // When a SKU is selected (or search narrows to 1), get its positions
  const focusSku = selectedSku || (q.length >= 2 && allSkus.length === 1 ? allSkus[0] : null);
  const focusPositions = focusSku ? skuPositions(focusSku) : [];
  const focusPosSet = new Set(focusPositions.map(p => p.pos));
  const focusProd = focusSku ? s.products[focusSku] : null;

  // Position detail when tapping map
  const selectedPosItems = selectedPos ? posContents(selectedPos) : [];
  const selectedPosTotal = selectedPosItems.reduce((s,i)=>s+i.qty, 0);

  const clearFocus = () => { setSelectedSku(null); setQ(""); setSelectedPos(""); };

  return (
    <div>
      <div className="card">
        <input className="form-input" value={q}
          onChange={e=>{setQ(e.target.value); setSelectedSku(null); setSelectedPos("");}}
          placeholder="¿Qué producto buscas?"
          style={{fontSize:16,padding:"14px 16px",borderRadius:12,marginBottom:4}}/>
      </div>

      {/* === PRODUCT FOUND — LOCATION PANEL === */}
      {focusSku && focusPositions.length > 0 && (
        <div style={{marginTop:8}}>
          {/* Product info */}
          <div style={{padding:"14px 16px",background:"#3b82f615",border:"2px solid #3b82f644",borderRadius:12,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{flex:1,minWidth:0}}>
                <div className="mono" style={{fontWeight:800,fontSize:16}}>{focusSku}</div>
                <div style={{fontSize:13,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{focusProd?.name || focusSku}</div>
              </div>
              <div style={{textAlign:"center",marginLeft:12}}>
                <div className="mono" style={{fontSize:24,fontWeight:800,color:"#3b82f6"}}>{skuTotal(focusSku)}</div>
                <div style={{fontSize:10,color:"#94a3b8"}}>total</div>
              </div>
            </div>
            {selectedSku && (
              <button onClick={clearFocus} style={{marginTop:8,padding:"4px 12px",borderRadius:6,background:"var(--bg3)",color:"#94a3b8",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>✕ Limpiar búsqueda</button>
            )}
          </div>

          {/* WHERE TO FIND IT */}
          <div style={{padding:"14px 16px",background:"#10b98115",border:"2px solid #10b98144",borderRadius:12,marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:700,color:"#10b981",marginBottom:10}}>
              📍 {focusPositions.length === 1 ? "Está en:" : "Está en estas posiciones:"}
            </div>
            {focusPositions.map(sp => (
              <div key={sp.pos}
                onClick={()=>setSelectedPos(sp.pos)}
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",marginBottom:6,borderRadius:10,
                  background:selectedPos===sp.pos?"#10b98122":"var(--bg2)",
                  border:`2px solid ${selectedPos===sp.pos?"#10b981":"var(--bg3)"}`,cursor:"pointer",transition:"all .15s"}}>
                <div style={{width:48,height:48,borderRadius:10,background:"linear-gradient(135deg,#064e3b,#065f46)",
                  display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <span className="mono" style={{fontSize:18,fontWeight:800,color:"#10b981"}}>{sp.pos}</span>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--txt1)"}}>{sp.label}</div>
                  <div style={{fontSize:11,color:"#94a3b8"}}>Posición {sp.pos}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div className="mono" style={{fontSize:22,fontWeight:800,color:"#3b82f6"}}>{sp.qty}</div>
                  <div style={{fontSize:10,color:"#94a3b8"}}>uds</div>
                </div>
              </div>
            ))}
          </div>

          {/* MAP with highlighted positions */}
          <div className="card">
            <div style={{fontSize:12,fontWeight:700,color:"#06b6d4",marginBottom:6}}>🗺️ Ubicación en mapa</div>
            <OperatorMiniMap selectedPos={selectedPos} onSelectPos={setSelectedPos} highlightPositions={focusPosSet}/>
          </div>
        </div>
      )}

      {/* === PRODUCT SEARCHED BUT NO STOCK === */}
      {focusSku && focusPositions.length === 0 && (
        <div style={{marginTop:8,padding:24,textAlign:"center",background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg3)"}}>
          <div style={{fontSize:32,marginBottom:8}}>🚫</div>
          <div style={{fontSize:14,fontWeight:700,color:"#ef4444"}}>{focusSku} sin stock</div>
          <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>No hay unidades en ninguna posición</div>
        </div>
      )}

      {/* === NO SEARCH — BROWSE MODE === */}
      {!focusSku && (
        <>
          {/* Map browser */}
          <div className="card" style={{marginTop:8}}>
            <div style={{fontSize:12,fontWeight:700,color:"#06b6d4",marginBottom:6}}>🗺️ Toca una posición para ver su contenido</div>
            <OperatorMiniMap selectedPos={selectedPos} onSelectPos={setSelectedPos}/>
            {selectedPos && (
              <div style={{marginTop:4}}>
                <div style={{fontSize:14,fontWeight:700,color:"#10b981",marginBottom:8}}>📍 {selectedPos} — {selectedPosTotal} uds</div>
                {selectedPosItems.length === 0 ? (
                  <div style={{fontSize:12,color:"#94a3b8"}}>Vacía</div>
                ) : selectedPosItems.map(it => (
                  <div key={it.sku} onClick={()=>{setSelectedSku(it.sku);setQ(it.sku);}}
                    style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid var(--bg3)",cursor:"pointer"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div className="mono" style={{fontWeight:700,fontSize:13}}>{it.sku}</div>
                      <div style={{fontSize:11,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.name}</div>
                    </div>
                    <div className="mono" style={{fontWeight:700,fontSize:16,color:"#3b82f6"}}>{it.qty}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Product list */}
          <div style={{marginTop:8}}>
            <div style={{fontSize:11,color:"#94a3b8",padding:"4px 0",marginBottom:4}}>{allSkus.length} productos en bodega</div>
            {allSkus.slice(0, 50).map(sku => {
              const prod = s.products[sku];
              const positions = skuPositions(sku);
              const total = skuTotal(sku);
              if (total === 0) return null;
              return (
                <div key={sku} onClick={()=>{setSelectedSku(sku);setQ(sku);}}
                  style={{padding:"12px 14px",marginBottom:6,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div className="mono" style={{fontSize:14,fontWeight:700}}>{sku}</div>
                      <div style={{fontSize:12,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{prod?.name || sku}</div>
                      <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap"}}>
                        {positions.map(sp => (
                          <span key={sp.pos} style={{padding:"2px 8px",borderRadius:4,background:"#10b98118",border:"1px solid #10b98133",fontSize:10,fontWeight:700,color:"#10b981"}}>
                            {sp.pos}: {sp.qty}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div style={{textAlign:"center",background:"var(--bg3)",borderRadius:8,padding:"6px 14px",marginLeft:8}}>
                      <div className="mono" style={{fontSize:18,fontWeight:700,color:"#3b82f6"}}>{total}</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {allSkus.length > 50 && <div style={{textAlign:"center",padding:12,color:"#94a3b8",fontSize:12}}>Mostrando 50 de {allSkus.length} — usa el buscador</div>}
            {allSkus.length === 0 && q.length >= 2 && <div style={{textAlign:"center",padding:24,color:"#94a3b8"}}>Sin resultados para &quot;{q}&quot;</div>}
          </div>
        </>
      )}
    </div>
  );
}

// ==================== SHARED COMPONENTS ====================
function SelTag({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{padding:"8px 12px",background:`${color}15`,border:`1px solid ${color}44`,borderRadius:8,marginBottom:6,display:"flex",gap:8,alignItems:"center"}}>
      <span style={{fontSize:11,fontWeight:700,color,minWidth:55}}>{label}</span>
      <span style={{fontSize:13,fontWeight:600,color:"var(--txt1)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{value}</span>
    </div>
  );
}

function PosContent({ items }: { items: {sku:string;name:string;qty:number}[] }) {
  return (
    <div style={{padding:"8px 12px",background:"var(--bg2)",borderRadius:8,marginBottom:8}}>
      <div style={{fontSize:10,color:"#94a3b8",fontWeight:600,marginBottom:4}}>Ya contiene:</div>
      {items.map(it => (
        <div key={it.sku} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",fontSize:12}}>
          <span className="mono" style={{fontWeight:600}}>{it.sku}</span>
          <span className="mono" style={{fontWeight:700,color:"#3b82f6"}}>{it.qty}</span>
        </div>
      ))}
    </div>
  );
}

function QtyPicker({ qty, setQty, max }: { qty: number; setQty: (n:number)=>void; max?: number }) {
  const clamp = (n: number) => Math.max(1, max ? Math.min(max, n) : n);
  return (
    <>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <button onClick={()=>setQty(clamp(qty-1))}
          style={{width:52,height:52,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:24,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
        <input type="number" className="mono" value={qty} onChange={e=>setQty(clamp(parseInt(e.target.value)||1))}
          style={{flex:1,textAlign:"center",fontSize:32,fontWeight:800,padding:8,background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:12,color:"var(--txt)"}}/>
        <button onClick={()=>setQty(clamp(qty+1))}
          style={{width:52,height:52,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:24,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
      </div>
      <div style={{display:"flex",gap:4,marginTop:8,justifyContent:"center",flexWrap:"wrap"}}>
        {[1,5,10,12,20,50].filter(n => !max || n <= max).map(n=>(
          <button key={n} onClick={()=>setQty(n)}
            style={{padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:700,
              background:qty===n?"#3b82f6":"var(--bg3)",color:qty===n?"#fff":"#94a3b8",
              border:`1px solid ${qty===n?"#3b82f6":"var(--bg4)"}`}}>
            {n}
          </button>
        ))}
        {max && max > 1 && (
          <button onClick={()=>setQty(max)}
            style={{padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:700,
              background:qty===max?"#f59e0b":"var(--bg3)",color:qty===max?"#000":"#f59e0b",
              border:`1px solid ${qty===max?"#f59e0b":"var(--bg4)"}`}}>
            Todo ({max})
          </button>
        )}
      </div>
    </>
  );
}

function CancelBtn({ onClick, label }: { onClick: ()=>void; label?: string }) {
  return (
    <button onClick={onClick}
      style={{marginTop:10,width:"100%",padding:10,borderRadius:8,background:"var(--bg3)",color:"#94a3b8",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
      {label || "Cancelar"}
    </button>
  );
}
