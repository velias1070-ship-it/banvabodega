"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { getStore, saveStore, findProduct, findPosition, activePositions, skuTotal, skuPositions, posContents, recordMovement, recordBulkMovements, fmtMoney, IN_REASONS, OUT_REASONS, initStore, isStoreReady, refreshStore, isSupabaseConfigured, getRecepcionesActivas, getRecepcionLineas, contarLinea, etiquetarLinea, ubicarLinea, actualizarRecepcion, fmtDate, fmtTime, getUnassignedStock, assignPosition } from "@/lib/store";
import type { Product, InReason, OutReason, DBRecepcion, DBRecepcionLinea } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });
import SheetSync from "@/components/SheetSync";

const CLOUD_SYNC_INTERVAL = 10_000;

export default function OperadorPage() {
  const [tab, setTab] = useState<"rec"|"in"|"out"|"stock"|"bulk"|"carga">("rec");
  const [,setTick] = useState(0);
  const r = useCallback(() => setTick(t => t + 1), []);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cloudOk, setCloudOk] = useState(false);

  useEffect(() => {
    setMounted(true);
    initStore().then(() => setLoading(false));
  }, []);

  // Cloud sync polling
  useEffect(() => {
    if (!isSupabaseConfigured() || loading) return;
    setCloudOk(true);
    const poll = async () => {
      await refreshStore();
      r();
    };
    const interval = setInterval(poll, CLOUD_SYNC_INTERVAL);
    return () => clearInterval(interval);
  }, [r, loading]);

  if (!mounted) return null;
  if (loading) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}><div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Bodega</div><div style={{color:"var(--txt3)"}}>Conectando...</div></div></div>;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/"><button className="back-btn">&#8592;</button></Link>
        <h1>BANVA Bodega</h1>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {cloudOk && <span title="Sincronizado con la nube" style={{fontSize:10,color:"var(--green)"}}>☁️</span>}
          <Link href="/operador/recepciones"><button style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--green)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>📦 Recepción</button></Link>
          <Link href="/mapa"><button style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🗺️ Mapa</button></Link>
        </div>
      </div>
      <SheetSync onSynced={r}/>
      <div className="tabs">
        <button className={`tab ${tab==="rec"?"active-cyan":""}`} onClick={()=>setTab("rec")}>📦 RECEPCIÓN</button>
        <button className={`tab ${tab==="in"?"active-green":""}`} onClick={()=>setTab("in")}>INGRESO</button>
        <button className={`tab ${tab==="out"?"active-out":""}`} onClick={()=>setTab("out")}>SALIDA</button>
        <button className={`tab ${tab==="stock"?"active-blue":""}`} onClick={()=>setTab("stock")}>STOCK</button>
        <button className={`tab ${tab==="bulk"?"active-cyan":""}`} onClick={()=>setTab("bulk")}>MASIVO</button>
        <button className={`tab ${tab==="carga"?"active-green":""}`} onClick={()=>setTab("carga")}>📋 CARGA</button>
      </div>
      <div style={{padding:12}}>
        {tab==="rec"&&<Recepciones refresh={r}/>}
        {tab==="in"&&<Ingreso refresh={r}/>}
        {tab==="out"&&<Salida refresh={r}/>}
        {tab==="stock"&&<StockView/>}
        {tab==="bulk"&&<BulkMode refresh={r}/>}
        {tab==="carga"&&<CargaInventario refresh={r}/>}
      </div>
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
      border:`2px solid ${type==="ok"?"var(--green)":"var(--amber)"}`,color:type==="ok"?"var(--green)":"var(--amber)",
      padding:"10px 20px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)",maxWidth:"90vw",textAlign:"center"}}>
      {msg}
    </div>
  ) : null;
  return { show, Toast };
}

// ==================== PRODUCT SEARCH COMPONENT ====================
function ProductSearch({ onSelect, placeholder }: { onSelect: (p: Product) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.length >= 2) { setResults(findProduct(q)); setOpen(true); }
    else { setResults([]); setOpen(false); }
  }, [q]);

  const select = (p: Product) => { setQ(p.sku + " - " + p.name); setOpen(false); onSelect(p); };

  return (
    <div ref={ref} style={{position:"relative"}}>
      <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder={placeholder||"Buscar SKU, nombre o código ML..."}
        onFocus={()=>{if(results.length)setOpen(true);}} style={{fontSize:14}}/>
      {open && results.length > 0 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:100,background:"var(--bg2)",border:"1px solid var(--bg4)",
          borderRadius:"0 0 8px 8px",maxHeight:250,overflow:"auto",boxShadow:"0 8px 20px rgba(0,0,0,0.4)"}}>
          {results.map(p => (
            <div key={p.sku} onClick={()=>select(p)} style={{padding:"10px 12px",borderBottom:"1px solid var(--bg3)",cursor:"pointer",
              display:"flex",justifyContent:"space-between",alignItems:"center"}}
              onMouseEnter={e=>(e.currentTarget.style.background="var(--bg3)")}
              onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
              <div>
                <div className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</div>
                <div style={{fontSize:11,color:"var(--txt2)"}}>{p.name}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{p.mlCode}</div>
                <div className="mono" style={{fontSize:12,fontWeight:700,color:"var(--blue)"}}>{skuTotal(p.sku)} uds</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && q.length >= 2 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:100,background:"var(--bg2)",border:"1px solid var(--bg4)",
          borderRadius:"0 0 8px 8px",padding:16,textAlign:"center",color:"var(--amber)",fontSize:12}}>
          No se encontró "{q}" en el diccionario de productos
        </div>
      )}
    </div>
  );
}

// ==================== INGRESO ====================
function Ingreso({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [pos, setPos] = useState<string>("");
  const [posLabel, setPosLabel] = useState("");
  const [product, setProduct] = useState<Product|null>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<InReason>("compra");
  const [note, setNote] = useState("");
  const [cam, setCam] = useState(false);
  const [step, setStep] = useState(0); // 0=scan pos, 1=select product, 2=qty+confirm

  const handleScan = useCallback((code: string) => {
    const p = findPosition(code);
    if (p) {
      setPos(p.id); setPosLabel(p.label); setStep(1); setCam(false);
      if (navigator.vibrate) navigator.vibrate(100);
    } else {
      show("Posición no reconocida: " + code, "err");
    }
  }, []);

  const handleManualPos = (posId: string) => {
    const positions = activePositions();
    const p = positions.find(x => x.id === posId);
    if (p) { setPos(p.id); setPosLabel(p.label); setStep(1); setCam(false); }
  };

  const confirm = () => {
    if (!product || !pos || qty < 1) return;
    recordMovement({ ts: new Date().toISOString(), type: "in", reason, sku: product.sku, pos, qty, who: "Operador", note });
    show(`+${qty} ${product.sku} → ${posLabel}`);
    setStep(0); setPos(""); setPosLabel(""); setProduct(null); setQty(1); setNote("");
    refresh();
  };

  const reset = () => { setStep(0); setPos(""); setPosLabel(""); setProduct(null); setQty(1); setNote(""); setCam(false); };

  const positions = activePositions();
  const posItems = pos ? posContents(pos) : [];

  return (
    <div>
      {Toast}

      {/* STEP 0: Select position */}
      {step === 0 && <>
        <div className="card">
          <div className="step-header">
            <span className="step-num">1</span>
            <span className="step-title">Escanea o selecciona la POSICIÓN donde guardas</span>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <button className="scan-btn blue" style={{flex:1}} onClick={()=>setCam(!cam)}>
              {cam ? "Pausar Cámara" : "Abrir Cámara"}
            </button>
          </div>
          {cam && <BarcodeScanner active={cam} onScan={handleScan} label="Apunta al QR de la POSICIÓN"/>}
          <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8}}>O selecciona manualmente:</div>
          <div className="pos-grid">
            {positions.map(p => {
              const items = posContents(p.id);
              const totalQ = items.reduce((s,i) => s + i.qty, 0);
              return (
                <button key={p.id} className="pos-btn" onClick={() => handleManualPos(p.id)}>
                  <div className="pos-number">{p.id}</div>
                  <div className="pos-label">{p.type === "shelf" ? "Estante" : "Pallet"}</div>
                  {totalQ > 0 ? <div className="pos-count">{totalQ} uds</div> : <div className="pos-free">LIBRE</div>}
                </button>
              );
            })}
          </div>
        </div>
      </>}

      {/* STEP 1: Select product */}
      {step === 1 && <>
        <div className="card">
          <div className="selected-tag green">Posición: <strong>{posLabel}</strong> ({pos})</div>
          {posItems.length > 0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"var(--txt3)",marginBottom:4}}>Ya contiene:</div>
              {posItems.map(it => (
                <div key={it.sku} className="mini-row">
                  <span className="mono" style={{fontWeight:600,fontSize:11}}>{it.sku}</span>
                  <span style={{fontSize:11,color:"var(--txt2)"}}>{it.name}</span>
                  <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{it.qty}</span>
                </div>
              ))}
            </div>
          )}
          <div className="step-header">
            <span className="step-num">2</span>
            <span className="step-title">Busca el producto que estás guardando</span>
          </div>
          <ProductSearch onSelect={(p) => { setProduct(p); setStep(2); }}/>
        </div>
        <button onClick={reset} className="cancel-btn">Cancelar</button>
      </>}

      {/* STEP 2: Quantity + Reason + Confirm */}
      {step === 2 && product && <>
        <div className="card">
          <div className="selected-tag green">Posición: <strong>{posLabel}</strong></div>
          <div className="selected-tag blue">{product.sku} — {product.name}</div>

          <div className="step-header" style={{marginTop:12}}>
            <span className="step-num">3</span>
            <span className="step-title">Cantidad y motivo</span>
          </div>

          <div className="qty-row">
            <button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>−</button>
            <input type="number" className="qty-input mono" value={qty} onChange={e=>setQty(Math.max(1,parseInt(e.target.value)||1))} min={1}/>
            <button className="qty-btn" onClick={()=>setQty(qty+1)}>+</button>
          </div>
          <div className="qty-presets">{[1,5,10,20,50,100].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>)}</div>

          <div style={{marginTop:12}}>
            <div style={{fontSize:11,color:"var(--txt3)",marginBottom:4}}>Motivo de ingreso:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {(Object.entries(IN_REASONS) as [InReason, string][]).map(([k,v]) => (
                <button key={k} onClick={()=>setReason(k)} style={{padding:"10px 8px",borderRadius:8,fontSize:11,fontWeight:600,textAlign:"center",
                  background:reason===k?"var(--greenBg)":"var(--bg3)",color:reason===k?"var(--green)":"var(--txt2)",
                  border:reason===k?"2px solid var(--green)":"1px solid var(--bg4)"}}>{v}</button>
              ))}
            </div>
          </div>

          <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota (opcional): # factura, referencia..." style={{marginTop:10,fontSize:12}}/>
        </div>

        <button className="confirm-btn green" onClick={confirm}>CONFIRMAR INGRESO — {qty} × {product.sku} → {posLabel}</button>
        <button onClick={()=>setStep(1)} className="cancel-btn">Volver</button>
      </>}
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
  const [step, setStep] = useState(0); // 0=search product, 1=select position, 2=confirm

  const selectProduct = (p: Product) => {
    setProduct(p);
    const positions = skuPositions(p.sku);
    if (positions.length === 0) {
      show(p.sku + " no tiene stock en bodega", "err");
      return;
    }
    if (positions.length === 1) {
      setSelectedPos(positions[0].pos);
      setSelectedPosLabel(positions[0].label);
      setMaxQty(positions[0].qty);
      setStep(2);
    } else {
      setStep(1);
    }
  };

  const selectPos = (posId: string, label: string, available: number) => {
    setSelectedPos(posId); setSelectedPosLabel(label); setMaxQty(available); setQty(1); setStep(2);
  };

  const confirm = () => {
    if (!product || !selectedPos || qty < 1) return;
    const take = Math.min(qty, maxQty);
    recordMovement({ ts: new Date().toISOString(), type: "out", reason, sku: product.sku, pos: selectedPos, qty: take, who: "Operador", note });
    show(`-${take} ${product.sku} de ${selectedPosLabel}`);
    setStep(0); setProduct(null); setSelectedPos(""); setSelectedPosLabel(""); setQty(1); setNote("");
    refresh();
  };

  const reset = () => { setStep(0); setProduct(null); setSelectedPos(""); setSelectedPosLabel(""); setQty(1); setNote(""); };

  return (
    <div>
      {Toast}

      {step === 0 && <>
        <div className="card">
          <div className="step-header">
            <span className="step-num">1</span>
            <span className="step-title">Busca el producto que necesitas sacar</span>
          </div>
          <ProductSearch onSelect={selectProduct} placeholder="SKU, nombre o código ML del producto..."/>
        </div>
      </>}

      {step === 1 && product && <>
        <div className="card">
          <div className="selected-tag amber">{product.sku} — {product.name}</div>
          <div className="step-header">
            <span className="step-num">2</span>
            <span className="step-title">Selecciona de qué posición sacas</span>
          </div>
          <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8}}>Stock total: <strong style={{color:"var(--blue)"}}>{skuTotal(product.sku)} uds</strong></div>
          {skuPositions(product.sku).map(sp => (
            <button key={sp.pos} onClick={()=>selectPos(sp.pos, sp.label, sp.qty)} className="pos-select-btn">
              <div>
                <span className="mono" style={{fontWeight:700,fontSize:16,color:"var(--green)"}}>{sp.pos}</span>
                <span style={{fontSize:12,color:"var(--txt2)",marginLeft:8}}>{sp.label}</span>
              </div>
              <div className="mono" style={{fontWeight:700,fontSize:18,color:"var(--blue)"}}>{sp.qty} uds</div>
            </button>
          ))}
        </div>
        <button onClick={reset} className="cancel-btn">Cancelar</button>
      </>}

      {step === 2 && product && <>
        <div className="card">
          <div className="selected-tag amber">{product.sku} — {product.name}</div>
          <div className="selected-tag blue">Desde: {selectedPosLabel} ({selectedPos}) — {maxQty} disponibles</div>

          <div className="step-header" style={{marginTop:12}}>
            <span className="step-num">{skuPositions(product.sku).length > 1 ? "3" : "2"}</span>
            <span className="step-title">Cantidad y motivo de salida</span>
          </div>

          <div className="qty-row">
            <button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>−</button>
            <input type="number" className="qty-input mono" value={qty} onChange={e=>setQty(Math.max(1,Math.min(maxQty,parseInt(e.target.value)||1)))} min={1} max={maxQty}/>
            <button className="qty-btn" onClick={()=>setQty(Math.min(maxQty,qty+1))}>+</button>
          </div>
          <div className="qty-presets">
            {[1,5,10,20,50].map(n=>n<=maxQty?<button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>:null)}
            <button className={qty===maxQty?"sel":""} onClick={()=>setQty(maxQty)}>Todo ({maxQty})</button>
          </div>

          <div style={{marginTop:12}}>
            <div style={{fontSize:11,color:"var(--txt3)",marginBottom:4}}>Motivo de salida:</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {(Object.entries(OUT_REASONS) as [OutReason, string][]).map(([k,v]) => (
                <button key={k} onClick={()=>setReason(k)} style={{padding:"10px 8px",borderRadius:8,fontSize:11,fontWeight:600,textAlign:"center",
                  background:reason===k?"var(--redBg)":"var(--bg3)",color:reason===k?"var(--red)":"var(--txt2)",
                  border:reason===k?"2px solid var(--red)":"1px solid var(--bg4)"}}>{v}</button>
              ))}
            </div>
          </div>
          <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota: # orden ML, referencia envío..." style={{marginTop:10,fontSize:12}}/>
        </div>
        <button className="confirm-btn red" onClick={confirm}>CONFIRMAR SALIDA — {qty} × {product.sku}</button>
        <button onClick={()=>{skuPositions(product.sku).length>1?setStep(1):reset();}} className="cancel-btn">Volver</button>
      </>}
    </div>
  );
}

// ==================== STOCK EN VIVO ====================
function StockView() {
  const [q, setQ] = useState("");
  const s = getStore();
  const allSkus = Object.keys(s.stock).filter(sku => {
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[sku];
    return sku.toLowerCase().includes(ql) || prod?.name.toLowerCase().includes(ql) || prod?.mlCode.toLowerCase().includes(ql);
  });

  return (
    <div>
      <div className="card">
        <input className="form-input mono" value={q} onChange={e=>setQ(e.target.value)} placeholder="Filtrar por SKU, nombre..." style={{fontSize:14,marginBottom:8}}/>
        <div style={{fontSize:11,color:"var(--txt3)"}}>{allSkus.length} productos en bodega</div>
      </div>
      {allSkus.map(sku => {
        const prod = s.products[sku];
        const positions = skuPositions(sku);
        const total = skuTotal(sku);
        if (total === 0) return null;
        return (
          <div key={sku} className="card" style={{marginTop:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div className="mono" style={{fontSize:15,fontWeight:700}}>{sku}</div>
                <div style={{fontSize:12,color:"var(--txt2)"}}>{prod?.name || sku}</div>
              </div>
              <div style={{textAlign:"center",background:"var(--bg3)",borderRadius:8,padding:"6px 14px"}}>
                <div style={{fontSize:9,color:"var(--txt3)",fontWeight:600}}>TOTAL</div>
                <div className="mono" style={{fontSize:20,fontWeight:700,color:"var(--blue)"}}>{total}</div>
              </div>
            </div>
            {positions.map(sp => (
              <div key={sp.pos} className="mini-row">
                <span className="mono" style={{fontWeight:700,fontSize:14,color:"var(--green)",minWidth:50}}>{sp.pos}</span>
                <span style={{flex:1,fontSize:11,color:"var(--txt3)"}}>{sp.label}</span>
                <span className="mono" style={{fontWeight:700,fontSize:14}}>{sp.qty} uds</span>
              </div>
            ))}
          </div>
        );
      })}
      {allSkus.length === 0 && <div className="card" style={{textAlign:"center",color:"var(--txt3)",padding:24}}>No hay stock que mostrar</div>}
    </div>
  );
}

// ==================== MODO MASIVO ====================
function BulkMode({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [type, setType] = useState<"in"|"out">("in");
  const [reason, setReason] = useState<string>("compra");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<{sku:string;pos:string;qty:number;name:string}[]>([{sku:"",pos:"",qty:0,name:""}]);
  const [done, setDone] = useState(false);

  const updateLine = (i: number, field: string, val: any) => {
    const newLines = [...lines];
    (newLines[i] as any)[field] = val;
    if (field === "sku") {
      const prods = findProduct(val);
      newLines[i].name = prods.length === 1 ? prods[0].name : "";
    }
    setLines(newLines);
  };

  const addLine = () => setLines([...lines, {sku:"",pos:"",qty:0,name:""}]);
  const removeLine = (i: number) => { if (lines.length > 1) setLines(lines.filter((_,j) => j !== i)); };

  const validLines = lines.filter(l => l.sku && l.pos && l.qty > 0 && getStore().products[l.sku.toUpperCase()]);

  const confirm = () => {
    const items = validLines.map(l => ({ sku: l.sku.toUpperCase(), pos: l.pos, qty: l.qty }));
    const count = recordBulkMovements(items, type, reason as any, "Operador", note);
    show(`${count} movimientos registrados`);
    setLines([{sku:"",pos:"",qty:0,name:""}]);
    setNote("");
    setDone(true);
    refresh();
    setTimeout(() => setDone(false), 3000);
  };

  const totalUnits = validLines.reduce((s, l) => s + l.qty, 0);
  const positions = activePositions();

  return (
    <div>
      {Toast}
      <div className="card">
        <div className="step-header" style={{marginBottom:12}}>
          <span className="step-title" style={{fontSize:14,fontWeight:700}}>Modo Masivo — {type==="in"?"Ingreso":"Salida"} de gran volumen</span>
        </div>
        <div className="scan-mode" style={{marginBottom:12}}>
          <button className={type==="in"?"active-in":""} onClick={()=>{setType("in");setReason("compra");}}>INGRESO</button>
          <button className={type!=="in"?"active-out":""} onClick={()=>{setType("out");setReason("envio_full");}}>SALIDA</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12}}>
          {(type==="in"?Object.entries(IN_REASONS):Object.entries(OUT_REASONS)).map(([k,v]) => (
            <button key={k} onClick={()=>setReason(k)} style={{padding:"8px",borderRadius:8,fontSize:10,fontWeight:600,
              background:reason===k?(type==="in"?"var(--greenBg)":"var(--redBg)"):"var(--bg3)",
              color:reason===k?(type==="in"?"var(--green)":"var(--red)"):"var(--txt3)",
              border:reason===k?`2px solid ${type==="in"?"var(--green)":"var(--red)"}`:"1px solid var(--bg4)"}}>{v}</button>
          ))}
        </div>
        <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Referencia general: # envío, # factura..." style={{fontSize:12,marginBottom:12}}/>
      </div>

      <div className="card">
        <div style={{fontSize:12,fontWeight:700,color:"var(--txt2)",marginBottom:8}}>Líneas ({lines.length})</div>
        {lines.map((l, i) => (
          <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 30px",gap:6,marginBottom:6,alignItems:"center"}}>
            <input className="form-input mono" value={l.sku} onChange={e=>updateLine(i,"sku",e.target.value.toUpperCase())} placeholder="SKU" style={{fontSize:11,padding:8}}/>
            <select className="form-select" value={l.pos} onChange={e=>updateLine(i,"pos",e.target.value)} style={{fontSize:11,padding:8}}>
              <option value="">Pos</option>
              {positions.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}
            </select>
            <input type="number" className="form-input mono" value={l.qty||""} onChange={e=>updateLine(i,"qty",parseInt(e.target.value)||0)} placeholder="Qty" min={0} style={{fontSize:11,padding:8}}/>
            <button onClick={()=>removeLine(i)} style={{background:"none",color:"var(--red)",fontSize:16,fontWeight:700,border:"none",cursor:"pointer"}}>×</button>
          </div>
        ))}
        <button onClick={addLine} style={{width:"100%",padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:12,fontWeight:600,border:"1px dashed var(--bg4)",marginTop:4}}>
          + Agregar línea
        </button>
      </div>

      {validLines.length > 0 && (
        <div className="card" style={{background:type==="in"?"var(--greenBg)":"var(--redBg)",border:`1px solid ${type==="in"?"var(--green)":"var(--red)"}`}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:11,fontWeight:600,color:type==="in"?"var(--green)":"var(--red)"}}>{validLines.length} líneas válidas</div>
            <div className="mono" style={{fontSize:24,fontWeight:700,color:type==="in"?"var(--green)":"var(--red)"}}>{totalUnits} unidades</div>
          </div>
        </div>
      )}

      <button className={`confirm-btn ${type==="in"?"green":"red"}`} onClick={confirm}
        disabled={validLines.length===0} style={{opacity:validLines.length===0?0.4:1}}>
        {type==="in"?"CONFIRMAR INGRESO MASIVO":"CONFIRMAR SALIDA MASIVA"} — {validLines.length} líneas
      </button>

      {done && <div style={{textAlign:"center",padding:20,color:"var(--green)",fontSize:16,fontWeight:700}}>Registrado correctamente</div>}
    </div>
  );
}

// ==================== RECEPCIONES ====================
const ESTADO_COLORS: Record<string, string> = {
  PENDIENTE: "var(--red)", CONTADA: "var(--amber)", EN_ETIQUETADO: "var(--blue)",
  ETIQUETADA: "var(--cyan)", UBICADA: "var(--green)",
};
const ESTADO_ICONS: Record<string, string> = {
  PENDIENTE: "🔴", CONTADA: "🟡", EN_ETIQUETADO: "🔵", ETIQUETADA: "🟢", UBICADA: "✅",
};

function Recepciones({ refresh }: { refresh: () => void }) {
  const [view, setView] = useState<"list"|"detail"|"process">("list");
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [selRec, setSelRec] = useState<DBRecepcion|null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [selLinea, setSelLinea] = useState<DBRecepcionLinea|null>(null);
  const [loading, setLoading] = useState(false);
  const [operario, setOperario] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("banva_operario") || "";
    return "";
  });

  // Load recepciones
  const loadRecs = async () => {
    setLoading(true);
    const data = await getRecepcionesActivas();
    setRecs(data);
    setLoading(false);
  };

  useEffect(() => { loadRecs(); }, []);

  // Load lineas when rec selected
  const openRec = async (rec: DBRecepcion) => {
    setSelRec(rec);
    setLoading(true);
    const data = await getRecepcionLineas(rec.id!);
    setLineas(data);
    setView("detail");
    setLoading(false);
    // Mark as EN_PROCESO if CREADA
    if (rec.estado === "CREADA") {
      await actualizarRecepcion(rec.id!, { estado: "EN_PROCESO" });
    }
  };

  const refreshLineas = async () => {
    if (!selRec?.id) return;
    const data = await getRecepcionLineas(selRec.id);
    setLineas(data);
  };

  // Save operario name
  const saveOperario = (name: string) => {
    setOperario(name);
    if (typeof window !== "undefined") localStorage.setItem("banva_operario", name);
  };

  // Operario gate
  if (!operario) {
    return (
      <div style={{textAlign:"center",padding:32}}>
        <div style={{fontSize:18,fontWeight:700,marginBottom:16}}>¿Quién eres?</div>
        <input className="form-input" placeholder="Tu nombre" autoFocus
          onKeyDown={e => { if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) saveOperario((e.target as HTMLInputElement).value.trim()); }}
          style={{fontSize:16,textAlign:"center",padding:14,marginBottom:12,width:"100%",maxWidth:300}}/>
        <div style={{fontSize:11,color:"var(--txt3)"}}>Escribe tu nombre y presiona Enter</div>
      </div>
    );
  }

  // ====== VIEW: LIST ======
  if (view === "list") {
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <div style={{fontSize:16,fontWeight:700}}>Recepciones</div>
            <div style={{fontSize:11,color:"var(--txt3)"}}>Operario: <strong style={{color:"var(--cyan)"}}>{operario}</strong>
              <button onClick={()=>saveOperario("")} style={{marginLeft:8,fontSize:10,color:"var(--txt3)",background:"none",border:"none",textDecoration:"underline",cursor:"pointer"}}>cambiar</button>
            </div>
          </div>
          <button onClick={loadRecs} disabled={loading} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading ? "..." : "🔄 Actualizar"}
          </button>
        </div>

        {recs.length === 0 && !loading && (
          <div style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
            <div style={{fontSize:32,marginBottom:8}}>📦</div>
            <div style={{fontSize:14,fontWeight:600}}>Sin recepciones pendientes</div>
            <div style={{fontSize:12,marginTop:4}}>Las recepciones se crean desde la app de etiquetas o desde el panel admin</div>
          </div>
        )}

        {recs.map(rec => (
          <button key={rec.id} onClick={() => openRec(rec)}
            style={{width:"100%",textAlign:"left",padding:14,marginBottom:8,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>{rec.proveedor}</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>Folio: {rec.folio} · {fmtDate(rec.created_at||"")}</div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,background:rec.estado==="CREADA"?"var(--amberBg)":"var(--blueBg)",
                color:rec.estado==="CREADA"?"var(--amber)":"var(--blue)",fontSize:10,fontWeight:700}}>
                {rec.estado === "CREADA" ? "NUEVA" : "EN PROCESO"}
              </div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  // ====== VIEW: DETAIL ======
  if (view === "detail" && selRec) {
    const total = lineas.length;
    const ubicadas = lineas.filter(l => l.estado === "UBICADA").length;
    const progress = total > 0 ? Math.round((ubicadas / total) * 100) : 0;

    return (
      <div>
        <button onClick={() => { setView("list"); loadRecs(); }} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver a lista
        </button>

        <div style={{padding:14,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
          <div style={{fontSize:16,fontWeight:700}}>{selRec.proveedor}</div>
          <div style={{fontSize:12,color:"var(--txt3)"}}>Folio: {selRec.folio} · {fmtDate(selRec.created_at||"")}</div>
          {/* Progress bar */}
          <div style={{marginTop:10,background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:"var(--green)",borderRadius:6,transition:"width 0.3s"}}/>
          </div>
          <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>{ubicadas}/{total} líneas completadas ({progress}%)</div>
        </div>

        <button onClick={refreshLineas} style={{width:"100%",padding:8,marginBottom:12,borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
          🔄 Refrescar líneas
        </button>

        {/* Lines */}
        {lineas.map(linea => (
          <div key={linea.id} onClick={() => { if (linea.estado !== "UBICADA") { setSelLinea(linea); setView("process"); } }}
            style={{padding:12,marginBottom:6,borderRadius:8,background:linea.estado==="UBICADA"?"var(--greenBg)":"var(--bg2)",
              border:`1px solid ${linea.estado==="UBICADA"?"var(--greenBd)":"var(--bg3)"}`,
              cursor:linea.estado==="UBICADA"?"default":"pointer",opacity:linea.estado==="UBICADA"?0.7:1}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700}}>{linea.nombre}</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>
                  SKU: {linea.sku} · ML: {linea.codigo_ml || "—"}
                </div>
                <div style={{fontSize:11,marginTop:4,display:"flex",gap:12}}>
                  <span>Factura: <strong>{linea.qty_factura}</strong></span>
                  {linea.qty_recibida > 0 && <span>Recibido: <strong style={{color:linea.qty_recibida===linea.qty_factura?"var(--green)":"var(--amber)"}}>{linea.qty_recibida}</strong></span>}
                  {linea.qty_etiquetada > 0 && <span>Etiq: <strong>{linea.qty_etiquetada}</strong></span>}
                  {linea.qty_ubicada > 0 && <span>Ubicado: <strong style={{color:"var(--green)"}}>{linea.qty_ubicada}</strong></span>}
                </div>
              </div>
              <div style={{textAlign:"right",marginLeft:8}}>
                <span style={{fontSize:16}}>{ESTADO_ICONS[linea.estado]||"⚪"}</span>
                <div style={{fontSize:9,fontWeight:700,color:ESTADO_COLORS[linea.estado]||"var(--txt3)",marginTop:2}}>{linea.estado}</div>
              </div>
            </div>
          </div>
        ))}

        {/* Complete button */}
        {ubicadas === total && total > 0 && (
          <button onClick={async () => {
            await actualizarRecepcion(selRec.id!, { estado: "COMPLETADA", completed_at: new Date().toISOString() });
            setView("list"); loadRecs();
          }} style={{width:"100%",marginTop:12,padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700}}>
            ✅ Cerrar recepción — Todo ubicado
          </button>
        )}
      </div>
    );
  }

  // ====== VIEW: PROCESS LINE ======
  if (view === "process" && selLinea) {
    return <ProcessLine linea={selLinea} operario={operario} recepcionId={selRec!.id!}
      onBack={async () => { await refreshLineas(); setView("detail"); }}
      refresh={refresh} />;
  }

  return null;
}

// ==================== PROCESS LINE COMPONENT ====================
function ProcessLine({ linea, operario, recepcionId, onBack, refresh }: {
  linea: DBRecepcionLinea; operario: string; recepcionId: string;
  onBack: () => void; refresh: () => void;
}) {
  const [currentLinea, setCurrentLinea] = useState(linea);
  const [saving, setSaving] = useState(false);

  // --- STEP 1: CONTAR ---
  const [qtyReal, setQtyReal] = useState(linea.qty_factura);

  const doContar = async () => {
    setSaving(true);
    await contarLinea(linea.id!, qtyReal, operario);
    setCurrentLinea(l => ({ ...l, qty_recibida: qtyReal, estado: "CONTADA", operario_conteo: operario }));
    setSaving(false);
  };

  // --- STEP 2: ETIQUETAR ---
  const [qtyEtiq, setQtyEtiq] = useState(0);
  const [scanMode, setScanMode] = useState(false);

  const doEtiquetar = async (addQty: number) => {
    setSaving(true);
    const newTotal = (currentLinea.qty_etiquetada || 0) + addQty;
    const qtyTotal = currentLinea.qty_recibida || currentLinea.qty_factura;
    await etiquetarLinea(linea.id!, newTotal, operario, qtyTotal);
    const newEstado = newTotal >= qtyTotal ? "ETIQUETADA" : "EN_ETIQUETADO";
    setCurrentLinea(l => ({ ...l, qty_etiquetada: newTotal, estado: newEstado as any }));
    setQtyEtiq(0);
    setSaving(false);
  };

  // --- STEP 3: UBICAR ---
  const [ubicarQty, setUbicarQty] = useState(0);
  const [ubicarPos, setUbicarPos] = useState("");
  const [scanPosMode, setScanPosMode] = useState(false);
  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");

  const doUbicar = async () => {
    if (!ubicarPos || ubicarQty <= 0) return;
    setSaving(true);
    await ubicarLinea(linea.id!, linea.sku, ubicarPos, ubicarQty, operario, recepcionId);
    const newUbicada = (currentLinea.qty_ubicada || 0) + ubicarQty;
    const qtyTotal = currentLinea.qty_recibida || currentLinea.qty_factura;
    setCurrentLinea(l => ({ ...l, qty_ubicada: newUbicada, estado: newUbicada >= qtyTotal ? "UBICADA" as any : l.estado }));
    setUbicarQty(0); setUbicarPos("");
    refresh();
    setSaving(false);
    if (newUbicada >= qtyTotal) {
      setTimeout(onBack, 500);
    }
  };

  const qtyTotal = currentLinea.qty_recibida || currentLinea.qty_factura;
  const skipEtiqueta = !currentLinea.requiere_etiqueta;

  // Determine current step
  let step: "contar" | "etiquetar" | "ubicar" = "contar";
  if (currentLinea.estado === "CONTADA" || currentLinea.estado === "EN_ETIQUETADO") {
    step = skipEtiqueta ? "ubicar" : "etiquetar";
  }
  if (currentLinea.estado === "ETIQUETADA") step = "ubicar";
  if (currentLinea.estado === "UBICADA") step = "ubicar";
  // If etiquetado complete, go to ubicar
  if (step === "etiquetar" && (currentLinea.qty_etiquetada || 0) >= qtyTotal) step = "ubicar";

  const remainEtiq = qtyTotal - (currentLinea.qty_etiquetada || 0);
  const remainUbic = qtyTotal - (currentLinea.qty_ubicada || 0);

  return (
    <div>
      <button onClick={onBack} style={{marginBottom:12,padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
        ← Volver
      </button>

      {/* Header */}
      <div style={{padding:14,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:16}}>
        <div style={{fontSize:15,fontWeight:700}}>{currentLinea.nombre}</div>
        <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>SKU: {currentLinea.sku} · ML: {currentLinea.codigo_ml || "sin etiqueta"}</div>
        <div style={{fontSize:12,marginTop:8,display:"flex",gap:16}}>
          <span>Factura: <strong>{currentLinea.qty_factura}</strong></span>
          <span>Recibido: <strong style={{color:(currentLinea.qty_recibida||0)>0?"var(--green)":"var(--txt3)"}}>{currentLinea.qty_recibida||"—"}</strong></span>
          {!skipEtiqueta && <span>Etiquetado: <strong>{currentLinea.qty_etiquetada||0}/{qtyTotal}</strong></span>}
          <span>Ubicado: <strong style={{color:(currentLinea.qty_ubicada||0)>=qtyTotal?"var(--green)":"var(--txt3)"}}>{currentLinea.qty_ubicada||0}/{qtyTotal}</strong></span>
        </div>
        {/* Steps indicator */}
        <div style={{display:"flex",gap:4,marginTop:10}}>
          {["contar","etiquetar","ubicar"].map((s,i) => {
            if (s === "etiquetar" && skipEtiqueta) return null;
            const done = (s === "contar" && step !== "contar") || (s === "etiquetar" && (step === "ubicar")) || (s === "ubicar" && currentLinea.estado === "UBICADA");
            const active = s === step;
            return <div key={s} style={{flex:1,height:4,borderRadius:2,background:done?"var(--green)":active?"var(--cyan)":"var(--bg3)"}}/>; 
          })}
        </div>
      </div>

      {/* STEP 1: CONTAR */}
      {step === "contar" && (
        <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 1 — Contar</div>
          <div style={{fontSize:12,color:"var(--txt3)",marginBottom:16}}>Factura dice: <strong style={{color:"var(--txt1)",fontSize:20}}>{currentLinea.qty_factura}</strong> unidades</div>
          <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>¿Cuántas recibiste realmente?</div>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <button onClick={()=>setQtyReal(Math.max(0,qtyReal-1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>−</button>
            <input type="number" value={qtyReal} onChange={e=>setQtyReal(Math.max(0,parseInt(e.target.value)||0))}
              style={{flex:1,textAlign:"center",fontSize:28,fontWeight:700,padding:10,borderRadius:8,border:"2px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt1)"}}/>
            <button onClick={()=>setQtyReal(qtyReal+1)} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>+</button>
          </div>
          {qtyReal !== currentLinea.qty_factura && (
            <div style={{padding:8,borderRadius:6,background:qtyReal<currentLinea.qty_factura?"var(--amberBg)":"var(--redBg)",
              color:qtyReal<currentLinea.qty_factura?"var(--amber)":"var(--red)",fontSize:12,fontWeight:600,marginBottom:12,textAlign:"center"}}>
              {qtyReal < currentLinea.qty_factura ? `⚠️ Faltan ${currentLinea.qty_factura - qtyReal} unidades` : `⚠️ Sobran ${qtyReal - currentLinea.qty_factura} unidades`}
            </div>
          )}
          <button onClick={doContar} disabled={saving}
            style={{width:"100%",padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700,opacity:saving?0.6:1}}>
            {saving ? "Guardando..." : `Confirmar: ${qtyReal} unidades recibidas`}
          </button>
        </div>
      )}

      {/* STEP 2: ETIQUETAR */}
      {step === "etiquetar" && (
        <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 2 — Etiquetar</div>
          <div style={{fontSize:12,color:"var(--txt3)",marginBottom:16}}>
            Faltan <strong style={{color:"var(--amber)",fontSize:18}}>{remainEtiq}</strong> unidades por etiquetar
            {currentLinea.qty_etiquetada > 0 && <span> · Ya etiquetadas: {currentLinea.qty_etiquetada}</span>}
          </div>

          <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>¿Cuántas etiquetaste en esta tanda?</div>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <button onClick={()=>setQtyEtiq(Math.max(0,qtyEtiq-1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>−</button>
            <input type="number" value={qtyEtiq||""} onChange={e=>setQtyEtiq(Math.min(remainEtiq,Math.max(0,parseInt(e.target.value)||0)))}
              style={{flex:1,textAlign:"center",fontSize:28,fontWeight:700,padding:10,borderRadius:8,border:"2px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt1)"}}/>
            <button onClick={()=>setQtyEtiq(Math.min(remainEtiq,qtyEtiq+1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>+</button>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {[6,12,remainEtiq].filter((v,i,a)=>a.indexOf(v)===i&&v>0&&v<=remainEtiq).map(n => (
              <button key={n} onClick={()=>setQtyEtiq(n)}
                style={{flex:1,padding:8,borderRadius:6,background:qtyEtiq===n?"var(--cyan)":"var(--bg3)",color:qtyEtiq===n?"#fff":"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)"}}>
                {n === remainEtiq ? `Todo (${n})` : n}
              </button>
            ))}
          </div>
          <button onClick={()=>doEtiquetar(qtyEtiq)} disabled={saving||qtyEtiq<=0}
            style={{width:"100%",padding:14,borderRadius:10,background:qtyEtiq>0?"var(--green)":"var(--bg3)",color:qtyEtiq>0?"#fff":"var(--txt3)",fontSize:14,fontWeight:700}}>
            {saving ? "Guardando..." : `Registrar ${qtyEtiq} etiquetadas`}
          </button>
        </div>
      )}

      {/* STEP 3: UBICAR */}
      {step === "ubicar" && remainUbic > 0 && (
        <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)"}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>
            {skipEtiqueta ? "Paso 2" : "Paso 3"} — Ubicar en posición
          </div>
          <div style={{fontSize:12,color:"var(--txt3)",marginBottom:16}}>
            <strong style={{color:"var(--cyan)",fontSize:18}}>{remainUbic}</strong> unidades por ubicar
          </div>

          {/* Scan QR or select position */}
          {scanPosMode ? (
            <div style={{marginBottom:12}}>
              <BarcodeScanner onScan={(code: string) => {
                const pos = findPosition(code);
                if (pos) { setUbicarPos(pos.id); setScanPosMode(false); }
              }} active={scanPosMode} />
              <button onClick={()=>setScanPosMode(false)} style={{width:"100%",marginTop:8,padding:8,borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11}}>Cancelar escaneo</button>
            </div>
          ) : (
            <div style={{marginBottom:12}}>
              <button onClick={()=>setScanPosMode(true)}
                style={{width:"100%",padding:12,borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)",marginBottom:8}}>
                📷 Escanear QR de posición
              </button>
              <select className="form-select" value={ubicarPos} onChange={e=>setUbicarPos(e.target.value)}
                style={{width:"100%",padding:12,fontSize:13}}>
                <option value="">Seleccionar posición...</option>
                {positions.map(p => <option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
              </select>
            </div>
          )}

          {ubicarPos && (
            <div style={{padding:10,background:"var(--greenBg)",borderRadius:8,marginBottom:12,textAlign:"center"}}>
              <span style={{fontSize:12,color:"var(--green)",fontWeight:700}}>📍 Posición: {ubicarPos} — {positions.find(p=>p.id===ubicarPos)?.label}</span>
            </div>
          )}

          <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>Cantidad a ubicar aquí:</div>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
            <button onClick={()=>setUbicarQty(Math.max(0,ubicarQty-1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>−</button>
            <input type="number" value={ubicarQty||""} onChange={e=>setUbicarQty(Math.min(remainUbic,Math.max(0,parseInt(e.target.value)||0)))}
              style={{flex:1,textAlign:"center",fontSize:28,fontWeight:700,padding:10,borderRadius:8,border:"2px solid var(--bg4)",background:"var(--bg1)",color:"var(--txt1)"}}/>
            <button onClick={()=>setUbicarQty(Math.min(remainUbic,ubicarQty+1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,color:"var(--txt1)",border:"1px solid var(--bg4)"}}>+</button>
          </div>
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            {[6,12,remainUbic].filter((v,i,a)=>a.indexOf(v)===i&&v>0&&v<=remainUbic).map(n => (
              <button key={n} onClick={()=>setUbicarQty(n)}
                style={{flex:1,padding:8,borderRadius:6,background:ubicarQty===n?"var(--cyan)":"var(--bg3)",color:ubicarQty===n?"#fff":"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)"}}>
                {n === remainUbic ? `Todo (${n})` : n}
              </button>
            ))}
          </div>
          <button onClick={doUbicar} disabled={saving||!ubicarPos||ubicarQty<=0}
            style={{width:"100%",padding:14,borderRadius:10,background:(ubicarPos&&ubicarQty>0)?"var(--green)":"var(--bg3)",color:(ubicarPos&&ubicarQty>0)?"#fff":"var(--txt3)",fontSize:14,fontWeight:700}}>
            {saving ? "Guardando..." : `Ubicar ${ubicarQty} en ${ubicarPos || "..."}`}
          </button>
        </div>
      )}

      {/* DONE */}
      {currentLinea.estado === "UBICADA" && (
        <div style={{textAlign:"center",padding:24}}>
          <div style={{fontSize:32,marginBottom:8}}>✅</div>
          <div style={{fontSize:16,fontWeight:700,color:"var(--green)"}}>Línea completada</div>
          <button onClick={onBack} style={{marginTop:12,padding:"10px 24px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
            Volver a recepción
          </button>
        </div>
      )}
    </div>
  );
}

// ==================== CARGA INVENTARIO (SCAN POSITION BY POSITION) ====================
function CargaInventario({ refresh }: { refresh: () => void }) {
  const { show, Toast } = useToast();
  const [currentPos, setCurrentPos] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [skuSearch, setSkuSearch] = useState("");
  const [skuResults, setSkuResults] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product|null>(null);
  const [qty, setQty] = useState(1);
  const [sessionLog, setSessionLog] = useState<{pos:string;sku:string;name:string;qty:number;fromUnassigned:boolean}[]>([]);
  const [sugFilter, setSugFilter] = useState("");
  const [,setTick] = useState(0);
  const skuInputRef = useRef<HTMLInputElement>(null);

  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");
  const currentPosItems = currentPos ? posContents(currentPos) : [];
  const currentPosTotal = currentPosItems.reduce((s,i)=>s+i.qty,0);
  const sessionTotal = sessionLog.reduce((s,l) => s+l.qty, 0);

  // Unassigned stock
  const unassigned = getUnassignedStock();
  const totalUnassigned = unassigned.reduce((s,u) => s+u.qty, 0);
  const filteredUnassigned = sugFilter
    ? unassigned.filter(u => u.sku.toLowerCase().includes(sugFilter.toLowerCase()) || u.name.toLowerCase().includes(sugFilter.toLowerCase()))
    : unassigned;

  const handleScanPos = (code: string) => {
    setScanning(false);
    const pos = findPosition(code);
    if (pos) {
      setCurrentPos(pos.id);
      show(`Posición ${pos.id} seleccionada`);
    } else {
      show(`Posición "${code}" no encontrada`, "err");
    }
  };

  const doSearchSku = (q: string) => {
    setSkuSearch(q);
    setSelectedProduct(null);
    if (q.length >= 2) setSkuResults(findProduct(q).slice(0,6));
    else setSkuResults([]);
  };

  const selectProduct = (p: Product) => {
    setSelectedProduct(p);
    setSkuSearch(p.sku);
    setSkuResults([]);
    setQty(1);
  };

  // Select from unassigned suggestions
  const selectUnassigned = (u: {sku:string;name:string;qty:number}) => {
    const prod = findProduct(u.sku)[0];
    if (prod) {
      setSelectedProduct(prod);
      setSkuSearch(prod.sku);
      setSkuResults([]);
      setQty(u.qty); // Pre-fill with full unassigned quantity
    }
  };

  const doAdd = () => {
    if (!selectedProduct || !currentPos || qty < 1) return;

    // Check if this SKU has unassigned stock — if so, use assignPosition (move from SIN_ASIGNAR)
    const unassignedItem = unassigned.find(u => u.sku === selectedProduct.sku);
    const fromUnassigned = unassignedItem && unassignedItem.qty >= qty;

    if (fromUnassigned) {
      assignPosition(selectedProduct.sku, currentPos, qty);
    } else {
      recordMovement({
        ts: new Date().toISOString(), type: "in", reason: "ajuste_entrada" as InReason,
        sku: selectedProduct.sku, pos: currentPos, qty,
        who: "Operario", note: "Carga inventario inicial",
      });
    }

    setSessionLog(l => [{ pos: currentPos, sku: selectedProduct.sku, name: selectedProduct.name, qty, fromUnassigned: !!fromUnassigned }, ...l]);
    show(`${fromUnassigned?"📦":"+"} ${qty}× ${selectedProduct.sku} → ${currentPos}`);
    setSelectedProduct(null);
    setSkuSearch("");
    setQty(1);
    setTick(t=>t+1);
    refresh();
    setTimeout(() => skuInputRef.current?.focus(), 100);
  };

  return (
    <div>
      {Toast}

      {/* Header stats */}
      <div style={{display:"flex",gap:6,marginBottom:12}}>
        <div style={{flex:1,padding:"8px 10px",background:"var(--bg2)",borderRadius:8,textAlign:"center"}}>
          <div style={{fontSize:18,fontWeight:800,color:"var(--green)"}}>{sessionLog.length}</div>
          <div style={{fontSize:9,color:"var(--txt3)"}}>registros</div>
        </div>
        <div style={{flex:1,padding:"8px 10px",background:"var(--bg2)",borderRadius:8,textAlign:"center"}}>
          <div style={{fontSize:18,fontWeight:800,color:"var(--blue)"}}>{sessionTotal}</div>
          <div style={{fontSize:9,color:"var(--txt3)"}}>unidades</div>
        </div>
        <div style={{flex:1,padding:"8px 10px",background:totalUnassigned>0?"var(--amberBg)":"var(--bg2)",borderRadius:8,textAlign:"center",border:totalUnassigned>0?"1px solid var(--amber)33":"none"}}>
          <div style={{fontSize:18,fontWeight:800,color:totalUnassigned>0?"var(--amber)":"var(--txt3)"}}>{totalUnassigned}</div>
          <div style={{fontSize:9,color:"var(--txt3)"}}>sin ubicar</div>
        </div>
      </div>

      {/* Step 1: Select position */}
      <div className="card">
        <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:currentPos?"var(--green)":"var(--txt)"}}>
          {currentPos ? `📍 Posición: ${currentPos}` : "1️⃣ Seleccionar posición"}
        </div>

        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <button onClick={()=>setScanning(!scanning)}
            style={{flex:1,padding:12,borderRadius:8,background:scanning?"var(--amberBg)":"var(--bg3)",color:scanning?"var(--amber)":"var(--cyan)",fontWeight:700,fontSize:13,border:`1px solid ${scanning?"var(--amber)":"var(--bg4)"}`}}>
            {scanning ? "Cancelar" : "📷 Escanear QR posición"}
          </button>
        </div>

        {scanning && (
          <div style={{marginBottom:10,borderRadius:8,overflow:"hidden"}}>
            <BarcodeScanner onScan={handleScanPos} active={scanning} />
          </div>
        )}

        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {positions.slice(0,20).map(p => (
            <button key={p.id} onClick={()=>{setCurrentPos(p.id);show(`Posición ${p.id}`);setTimeout(()=>skuInputRef.current?.focus(),100);}}
              style={{padding:"8px 10px",borderRadius:6,fontSize:12,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",
                background:currentPos===p.id?"var(--greenBg)":"var(--bg3)",
                color:currentPos===p.id?"var(--green)":"var(--txt3)",
                border:currentPos===p.id?"2px solid var(--green)":"1px solid var(--bg4)"}}>
              {p.id}
            </button>
          ))}
        </div>

        {currentPos && currentPosTotal > 0 && (
          <div style={{marginTop:8,padding:"6px 10px",background:"var(--bg2)",borderRadius:6,fontSize:11,color:"var(--txt3)"}}>
            Ya tiene {currentPosTotal} uds ({currentPosItems.length} SKUs)
          </div>
        )}
      </div>

      {/* Step 2: Add SKUs */}
      {currentPos && (
        <div className="card" style={{marginTop:8}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:8}}>2️⃣ Agregar productos a {currentPos}</div>

          <div style={{position:"relative",marginBottom:8}}>
            <input ref={skuInputRef} className="form-input mono" value={skuSearch}
              onChange={e=>doSearchSku(e.target.value.toUpperCase())}
              onKeyDown={e=>{if(e.key==="Enter"&&selectedProduct)doAdd();}}
              placeholder="Buscar SKU o nombre..."
              style={{fontSize:14}} autoFocus/>
            {skuResults.length > 0 && (
              <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:"0 0 8px 8px",maxHeight:200,overflow:"auto",boxShadow:"0 6px 16px rgba(0,0,0,0.4)"}}>
                {skuResults.map(p=>{
                  const unItem = unassigned.find(u=>u.sku===p.sku);
                  return(
                    <div key={p.sku} onClick={()=>selectProduct(p)} style={{padding:"10px 12px",cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}
                      onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <div style={{display:"flex",justifyContent:"space-between"}}>
                        <span className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</span>
                        <div style={{textAlign:"right"}}>
                          {unItem && <span style={{fontSize:10,color:"var(--amber)",fontWeight:600,marginRight:6}}>{unItem.qty} sin ubicar</span>}
                          <span className="mono" style={{fontSize:11,color:"var(--blue)"}}>{skuTotal(p.sku)} total</span>
                        </div>
                      </div>
                      <div style={{fontSize:11,color:"var(--txt3)"}}>{p.name}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Unassigned suggestions */}
          {!selectedProduct && unassigned.length > 0 && (
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--amber)"}}>📦 Sin ubicar ({unassigned.length} SKUs, {totalUnassigned} uds)</div>
              </div>
              {unassigned.length > 5 && (
                <input className="form-input mono" value={sugFilter} onChange={e=>setSugFilter(e.target.value)}
                  placeholder="Filtrar sugerencias..." style={{fontSize:12,marginBottom:6,padding:6}}/>
              )}
              <div style={{maxHeight:200,overflow:"auto",border:"1px solid var(--bg4)",borderRadius:8}}>
                {filteredUnassigned.slice(0,20).map(u=>(
                  <div key={u.sku} onClick={()=>selectUnassigned(u)}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderBottom:"1px solid var(--bg3)",cursor:"pointer",transition:"background .1s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"var(--amber)",flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <span className="mono" style={{fontWeight:700,fontSize:12}}>{u.sku}</span>
                      <div style={{fontSize:10,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.name}</div>
                    </div>
                    <span className="mono" style={{fontWeight:800,fontSize:14,color:"var(--amber)"}}>{u.qty}</span>
                  </div>
                ))}
                {filteredUnassigned.length > 20 && (
                  <div style={{padding:8,textAlign:"center",fontSize:10,color:"var(--txt3)"}}>+{filteredUnassigned.length-20} más — usa el filtro</div>
                )}
              </div>
            </div>
          )}

          {selectedProduct && (
            <div style={{padding:"8px 10px",background:"var(--bg3)",borderRadius:6,marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <span className="mono" style={{fontWeight:700,fontSize:13}}>{selectedProduct.sku}</span>
                  <div style={{fontSize:11,color:"var(--txt3)"}}>{selectedProduct.name}</div>
                  {unassigned.find(u=>u.sku===selectedProduct.sku) && (
                    <div style={{fontSize:10,color:"var(--amber)",fontWeight:600,marginTop:2}}>📦 {unassigned.find(u=>u.sku===selectedProduct.sku)?.qty} sin ubicar — se moverán a {currentPos}</div>
                  )}
                </div>
                <button onClick={()=>{setSelectedProduct(null);setSkuSearch("");}} style={{background:"none",color:"var(--txt3)",fontSize:16,border:"none",padding:"0 4px"}}>✕</button>
              </div>
            </div>
          )}

          {selectedProduct && (
            <>
              <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:10}}>
                <button onClick={()=>setQty(Math.max(1,qty-1))} style={{width:44,height:44,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                <input type="number" className="form-input mono" value={qty} onChange={e=>setQty(Math.max(1,parseInt(e.target.value)||1))}
                  style={{flex:1,textAlign:"center",fontSize:28,fontWeight:800,padding:8}}/>
                <button onClick={()=>setQty(qty+1)} style={{width:44,height:44,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
              </div>
              <div style={{display:"flex",gap:4,marginBottom:12,justifyContent:"center",flexWrap:"wrap"}}>
                {[1,5,10,12,20,50].map(n=>(
                  <button key={n} onClick={()=>setQty(n)}
                    style={{padding:"6px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                      background:qty===n?"var(--greenBg)":"var(--bg3)",color:qty===n?"var(--green)":"var(--txt3)",
                      border:qty===n?"1px solid var(--green)":"1px solid var(--bg4)"}}>
                    {n}
                  </button>
                ))}
                {(() => {
                  const unItem = unassigned.find(u=>u.sku===selectedProduct.sku);
                  return unItem && unItem.qty > 1 ? (
                    <button onClick={()=>setQty(unItem.qty)}
                      style={{padding:"6px 12px",borderRadius:6,fontSize:12,fontWeight:700,
                        background:qty===unItem.qty?"var(--amberBg)":"var(--bg3)",color:qty===unItem.qty?"var(--amber)":"var(--amber)",
                        border:qty===unItem.qty?"1px solid var(--amber)":"1px solid var(--bg4)"}}>
                      Todo ({unItem.qty})
                    </button>
                  ) : null;
                })()}
              </div>
              <button onClick={doAdd}
                style={{width:"100%",padding:16,borderRadius:10,fontWeight:700,fontSize:16,color:"#fff",background:"linear-gradient(135deg,#059669,var(--green))"}}>
                {unassigned.find(u=>u.sku===selectedProduct.sku && u.qty >= qty)
                  ? `📦 UBICAR ${qty}× → ${currentPos}`
                  : `+ AGREGAR ${qty}× ${selectedProduct.sku}`
                }
              </button>
            </>
          )}
        </div>
      )}

      {/* Session log */}
      {sessionLog.length > 0 && (
        <div className="card" style={{marginTop:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:12,fontWeight:700}}>Registros esta sesión ({sessionLog.length})</div>
            <button onClick={()=>{if(confirm("Limpiar historial visual? (no afecta el stock ya registrado)"))setSessionLog([]);}}
              style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Limpiar</button>
          </div>
          {sessionLog.slice(0,30).map((l,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
              <span className="mono" style={{fontWeight:700,color:"var(--cyan)",minWidth:36}}>{l.pos}</span>
              <span className="mono" style={{fontWeight:700,minWidth:80}}>{l.sku}</span>
              <span style={{flex:1,fontSize:10,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.name}</span>
              <span className="mono" style={{fontWeight:800,color:"var(--green)"}}>+{l.qty}</span>
              {l.fromUnassigned && <span style={{fontSize:8,color:"var(--amber)"}}>📦</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
