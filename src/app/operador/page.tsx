"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { getStore, saveStore, findProduct, findPosition, activePositions, skuTotal, skuPositions, posContents, recordMovement, recordBulkMovements, fmtMoney, IN_REASONS, OUT_REASONS } from "@/lib/store";
import type { Product, InReason, OutReason } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

export default function OperadorPage() {
  const [tab, setTab] = useState<"in"|"out"|"stock"|"bulk">("in");
  const [,setTick] = useState(0);
  const r = useCallback(() => setTick(t => t + 1), []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/"><button className="back-btn">&#8592;</button></Link>
        <h1>BANVA Bodega</h1>
        <div style={{fontSize:10,color:"var(--txt3)"}}>{new Date().toLocaleDateString("es-CL")}</div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab==="in"?"active-green":""}`} onClick={()=>setTab("in")}>INGRESO</button>
        <button className={`tab ${tab==="out"?"active-out":""}`} onClick={()=>setTab("out")}>SALIDA</button>
        <button className={`tab ${tab==="stock"?"active-blue":""}`} onClick={()=>setTab("stock")}>STOCK</button>
        <button className={`tab ${tab==="bulk"?"active-cyan":""}`} onClick={()=>setTab("bulk")}>MASIVO</button>
      </div>
      <div style={{padding:12}}>
        {tab==="in"&&<Ingreso refresh={r}/>}
        {tab==="out"&&<Salida refresh={r}/>}
        {tab==="stock"&&<StockView/>}
        {tab==="bulk"&&<BulkMode refresh={r}/>}
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
