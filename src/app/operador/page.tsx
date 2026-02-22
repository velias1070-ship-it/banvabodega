"use client";
import { useState, useCallback, useEffect } from "react";
import { getStore, updateStore, getSkuBodTotal, getSkuTotal, getLocItems, getStockStatus, nextMovId, LOCS } from "@/lib/store";
import type { StoreData } from "@/lib/store";
import Link from "next/link";

export default function OperadorPage() {
  const [tab, setTab] = useState<"scan"|"find"|"map">("scan");
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  return (
    <div className="app">
      <div className="topbar">
        <Link href="/"><button className="back-btn">← Salir</button></Link>
        <h1>📱 Operador</h1>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>{new Date().toLocaleDateString("es-CL")}</div>
      </div>
      <div className="tabs">
        {(["scan","find","map"] as const).map(t => (
          <button key={t} className={`tab ${tab===t?"active-green":""}`} onClick={() => setTab(t)}>
            {t==="scan"?"📷 Escanear":t==="find"?"🔍 Buscar":"🗺️ Mapa"}
          </button>
        ))}
      </div>
      <div style={{ padding: 16 }}>
        {tab==="scan" && <Scanner refresh={refresh}/>}
        {tab==="find" && <Finder/>}
        {tab==="map" && <MapView/>}
      </div>
    </div>
  );
}

function Scanner({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"in"|"out">("in");
  const [step, setStep] = useState(0);
  const [sku, setSku] = useState("");
  const [loc, setLoc] = useState("");
  const [qty, setQty] = useState(1);
  const [flash, setFlash] = useState("");
  const [log, setLog] = useState<{time:string;type:string;sku:string;loc:string;qty:number}[]>([]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const doFlash = (c: string) => { setFlash(c); setTimeout(() => setFlash(""), 400); };

  const reset = () => { setStep(0); setSku(""); setLoc(""); setQty(1); };

  const doScan = () => {
    const store = getStore();
    const db = store.db;
    const skus = Object.keys(db);

    if (mode === "in") {
      if (step === 0) {
        const s = skus[Math.floor(Math.random() * skus.length)];
        setSku(s); setStep(1); doFlash("green");
      } else if (step === 1) {
        const free = LOCS.filter(l => { const items = getLocItems(db, l); return items.reduce((s,i)=>s+i.qty,0) < 150; });
        const l = free[Math.floor(Math.random() * free.length)];
        setLoc(l); setStep(2); doFlash("blue");
      } else {
        db[sku].locs[loc] = (db[sku].locs[loc] || 0) + qty;
        store.movements.unshift({ id: nextMovId(store), ts: new Date().toISOString(), type: "in", sku, loc, qty, who: "Operador", ref: "SCAN-" + Date.now() });
        updateStore({ db, movements: store.movements, movCounter: store.movCounter });
        setLog(p => [{ time: new Date().toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit",second:"2-digit"}), type: "in", sku, loc, qty }, ...p].slice(0, 15));
        doFlash("green"); reset(); refresh();
      }
    } else {
      if (step === 0) {
        const valid = skus.filter(s => Object.values(db[s].locs).some(q => q > 0));
        if (!valid.length) return;
        const s = valid[Math.floor(Math.random() * valid.length)];
        const ls = Object.entries(db[s].locs).filter(([,q]) => q > 0);
        const [l] = ls[Math.floor(Math.random() * ls.length)];
        setSku(s); setLoc(l); setStep(1); doFlash("red");
      } else {
        const take = Math.min(qty, db[sku].locs[loc] || 0);
        db[sku].locs[loc] -= take;
        if (db[sku].locs[loc] <= 0) delete db[sku].locs[loc];
        store.movements.unshift({ id: nextMovId(store), ts: new Date().toISOString(), type: "out-full", sku, loc, qty: take, who: "Operador", ref: "SCAN-" + Date.now() });
        updateStore({ db, movements: store.movements, movCounter: store.movCounter });
        setLog(p => [{ time: new Date().toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit",second:"2-digit"}), type: "out", sku, loc, qty: take }, ...p].slice(0, 15));
        doFlash("red"); reset(); refresh();
      }
    }
  };

  if (!mounted) return null;
  const isIn = mode === "in";
  const db = getStore().db;

  return (
    <div>
      <div className="scan-mode">
        <button className={isIn ? "active-in" : ""} onClick={() => { setMode("in"); reset(); }}>📦 ENTRADA</button>
        <button className={!isIn ? "active-out" : ""} onClick={() => { setMode("out"); reset(); }}>🚚 SALIDA</button>
      </div>

      <div className={`scan-area ${flash ? "flash-"+flash : ""}`}>
        {isIn ? <>
          {step===0 && <><div style={{fontSize:40}}>📦</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 1 de 3</div><div style={{fontSize:18,fontWeight:700}}>Escanea el PRODUCTO</div><div style={{fontSize:11,color:"var(--txt3)"}}>Código de barras o etiqueta ML</div></>}
          {step===1 && <><div className="scan-tag mono" style={{background:"var(--greenBg)",color:"var(--green)",marginBottom:8}}>{sku} — {db[sku]?.d}</div><div style={{fontSize:40}}>📍</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 2 de 3</div><div style={{fontSize:18,fontWeight:700}}>Escanea la UBICACIÓN</div></>}
          {step===2 && <>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",marginBottom:8}}>
              <span className="scan-tag mono" style={{background:"var(--greenBg)",color:"var(--green)"}}>{sku}</span>
              <span className="scan-tag mono" style={{background:"var(--blueBg)",color:"var(--blue)"}}>{loc}</span>
            </div>
            <div style={{fontSize:12,color:"var(--txt3)"}}>Paso 3 de 3 — Cantidad</div>
            <div className="qty-row">
              <button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>−</button>
              <div className="qty-val mono">{qty}</div>
              <button className="qty-btn" onClick={()=>setQty(qty+1)}>+</button>
            </div>
            <div className="qty-presets">
              {[1,5,10,20,50].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>)}
            </div>
          </>}
        </> : <>
          {step===0 && <><div style={{fontSize:40}}>🏷️</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 1 de 2</div><div style={{fontSize:18,fontWeight:700}}>Escanea el PRODUCTO que sale</div></>}
          {step===1 && <>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",marginBottom:8}}>
              <span className="scan-tag mono" style={{background:"var(--amberBg)",color:"var(--amber)"}}>{sku}</span>
              <span className="scan-tag mono" style={{background:"var(--amberBg)",color:"var(--amber)"}}>desde {loc}</span>
            </div>
            <div style={{fontSize:12,color:"var(--txt3)"}}>Paso 2 de 2 — Cantidad</div>
            <div className="qty-row">
              <button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>−</button>
              <div className="qty-val mono">{qty}</div>
              <button className="qty-btn" onClick={()=>setQty(qty+1)}>+</button>
            </div>
            <div className="qty-presets">
              {[1,5,10,20,50].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>)}
            </div>
          </>}
        </>}
      </div>

      <button className={`scan-btn ${isIn?(step===2?"green":"blue"):(step===1?"red":"blue")}`} onClick={doScan} style={{marginTop:12}}>
        {isIn ? (step===0?"📷  ESCANEAR PRODUCTO":step===1?"📷  ESCANEAR UBICACIÓN":"✅  CONFIRMAR ENTRADA") : (step===0?"📷  ESCANEAR PRODUCTO":"✅  CONFIRMAR SALIDA")}
      </button>

      {log.length > 0 && <div className="card" style={{marginTop:14}}>
        <div className="card-title">📋 Registro en vivo</div>
        {log.map((e,i) => (
          <div key={i} className={`log-item ${i===0?"anim-in":""}`}>
            <span className="mono" style={{color:"var(--txt3)",fontSize:10}}>{e.time}</span>
            <span className="log-badge" style={{background:e.type==="in"?"var(--greenBg)":"var(--redBg)",color:e.type==="in"?"var(--green)":"var(--red)"}}>{e.type==="in"?"ENTRADA":"SALIDA"}</span>
            <span className="mono" style={{fontWeight:700,fontSize:11}}>{e.sku}</span>
            <span style={{color:"var(--txt3)"}}>→</span>
            <span className="mono" style={{color:"var(--blue)",fontWeight:600,fontSize:11}}>{e.loc}</span>
            <span style={{color:"var(--txt2)"}}>×{e.qty}</span>
          </div>
        ))}
      </div>}
    </div>
  );
}

function Finder() {
  const [q, setQ] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const db = getStore().db;
  const ql = q.toLowerCase();
  const results = ql.length >= 2 ? Object.entries(db).filter(([s,v]) => s.toLowerCase().includes(ql) || v.d.toLowerCase().includes(ql)) : [];

  return (
    <div>
      <div className="card">
        <div className="card-title">🔍 Buscar producto</div>
        <input className="find-input mono" placeholder="SKU o nombre..." value={q} onChange={e=>setQ(e.target.value)} />
        <div className="sku-chips">
          {Object.keys(db).map(s => <button key={s} className="sku-chip mono" onClick={()=>setQ(s)}>{s}</button>)}
        </div>
      </div>
      {results.map(([sku, data]) => {
        const bodTot = getSkuBodTotal(db, sku), total = getSkuTotal(db, sku), st = getStockStatus(db, sku);
        return (
          <div key={sku} className="card" style={{border:`2px solid var(--blueBd)`,marginTop:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div>
                <div className="mono" style={{fontSize:18,fontWeight:700}}>{sku}</div>
                <div style={{fontSize:13,color:"var(--txt2)",marginTop:2}}>{data.d}</div>
                <span style={{display:"inline-block",padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,marginTop:4,background:st.color+"20",color:st.color}}>{st.label}</span>
              </div>
              <div style={{textAlign:"center",background:"var(--bg3)",borderRadius:8,padding:"8px 14px"}}>
                <div style={{fontSize:10,color:"var(--txt3)",fontWeight:600}}>TOTAL</div>
                <div className="mono" style={{fontSize:22,fontWeight:700,color:"var(--blue)"}}>{total}</div>
              </div>
            </div>
            <div style={{fontSize:12,fontWeight:700,color:"var(--txt2)",marginBottom:8}}>📍 En Bodega — {Object.keys(data.locs).length} ubicación{Object.keys(data.locs).length>1?"es":""}</div>
            {Object.entries(data.locs).map(([loc, qty]) => (
              <div key={loc} className="loc-row">
                <span className="mono" style={{fontWeight:700,color:"var(--green)",minWidth:65}}>{loc}</span>
                <span style={{flex:1,fontWeight:700,fontSize:15}}>{qty} uds</span>
                <span style={{fontSize:11,color:"var(--green)",fontWeight:600}}>IR →</span>
              </div>
            ))}
            <div className="stat-grid">
              <div className="stat-box" style={{background:"var(--amberBg)",border:"1px solid var(--amberBd)"}}>
                <div className="label" style={{color:"var(--amber)"}}>EN TRÁNSITO</div>
                <div className="val mono" style={{color:"var(--amber)"}}>{data.transit}</div>
              </div>
              <div className="stat-box" style={{background:"var(--blueBg)",border:"1px solid var(--blueBd)"}}>
                <div className="label" style={{color:"var(--blue)"}}>EN ML FULL</div>
                <div className="val mono" style={{color:"var(--blue)"}}>{data.full}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MapView() {
  const [sel, setSel] = useState<string|null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  const db = getStore().db;
  const zones = [{id:"A",lb:"Zona A — Alta rotación",c:"var(--green)"},{id:"B",lb:"Zona B — Media",c:"var(--blue)"},{id:"C",lb:"Zona C — Baja rotación",c:"var(--txt3)"}];

  return (
    <div>
      {zones.map(z => {
        const zl = LOCS.filter(l => l.startsWith(z.id));
        return (
          <div key={z.id} style={{marginBottom:20}}>
            <div className="zone-label" style={{color:z.c}}>{z.lb}</div>
            <div className="loc-grid">
              {zl.map(loc => {
                const items = getLocItems(db, loc);
                const tq = items.reduce((s,i) => s+i.qty, 0);
                const isSel = sel === loc;
                return (
                  <div key={loc} className={`loc-cell ${isSel?"selected":""}`} onClick={() => setSel(isSel?null:loc)}>
                    <div className="mono" style={{fontSize:11,fontWeight:700,color:z.c,marginBottom:3}}>{loc}</div>
                    {items.length ? <div style={{fontSize:10,color:"var(--txt3)"}}>{items.map(i=>i.sku).join(", ")}<br/>{tq} uds</div> : <div style={{fontSize:10,color:"var(--green)",fontWeight:600}}>LIBRE</div>}
                  </div>
                );
              })}
            </div>
            {sel && sel.startsWith(z.id) && (
              <div className="card">
                <div className="card-title mono" style={{color:z.c}}>📍 {sel}</div>
                {getLocItems(db, sel).length ? getLocItems(db, sel).map((it,i) => (
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",background:"var(--bg3)",borderRadius:6,marginBottom:4}}>
                    <div><span className="mono" style={{fontWeight:700}}>{it.sku}</span><span style={{fontSize:12,color:"var(--txt3)",marginLeft:8}}>{it.desc}</span></div>
                    <span className="mono" style={{fontWeight:700,color:z.c}}>{it.qty} uds</span>
                  </div>
                )) : <div style={{fontSize:13,color:"var(--txt3)"}}>Ubicación libre</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
