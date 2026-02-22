"use client";
import { useState, useCallback, useEffect } from "react";
import { getStore, updateStore, getSkuBodTotal, getSkuTotal, getLocItems, getStockStatus, nextMovId, LOCS } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

function findSku(db: Record<string,any>, code: string): string|null {
  const u = code.toUpperCase().trim();
  if (db[u]) return u;
  for (const [s,d] of Object.entries(db) as any) { if (d.mlCode && d.mlCode.toUpperCase()===u) return s; }
  for (const [s] of Object.entries(db)) { if (s.includes(u)||u.includes(s)) return s; }
  return null;
}
function parseLoc(code: string): string|null {
  const u = code.toUpperCase().trim();
  if (/^P-\d{2}$/.test(u)) return u;
  if (/^E-\d{2}-\d$/.test(u)) return u;
  const mp = u.match(/(P-\d{2})/); if (mp) return mp[1];
  const me = u.match(/(E-\d{2}-\d)/); if (me) return me[1];
  return null;
}

export default function OperadorPage() {
  const [tab, setTab] = useState<"scan"|"find"|"map">("scan");
  const [,setTick] = useState(0);
  const refresh = useCallback(()=>setTick(t=>t+1),[]);
  return (
    <div className="app">
      <div className="topbar">
        <Link href="/"><button className="back-btn">&#8592; Salir</button></Link>
        <h1>Operador</h1>
        <div style={{fontSize:11,color:"var(--txt3)"}}>{new Date().toLocaleDateString("es-CL")}</div>
      </div>
      <div className="tabs">
        {(["scan","find","map"] as const).map(t=>(
          <button key={t} className={`tab ${tab===t?"active-green":""}`} onClick={()=>setTab(t)}>
            {t==="scan"?"Escanear":t==="find"?"Buscar":"Mapa"}
          </button>
        ))}
      </div>
      <div style={{padding:16}}>
        {tab==="scan"&&<Scanner refresh={refresh}/>}
        {tab==="find"&&<Finder/>}
        {tab==="map"&&<MapView/>}
      </div>
    </div>
  );
}

function Scanner({refresh}:{refresh:()=>void}) {
  const [mode,setMode]=useState<"in"|"out">("in");
  const [step,setStep]=useState(0);
  const [sku,setSku]=useState("");
  const [loc,setLoc]=useState("");
  const [qty,setQty]=useState(1);
  const [flash,setFlash]=useState("");
  const [log,setLog]=useState<{time:string;type:string;sku:string;loc:string;qty:number}[]>([]);
  const [mounted,setMounted]=useState(false);
  const [cam,setCam]=useState(false);
  const [manual,setManual]=useState("");
  const [showManual,setShowManual]=useState(false);
  const [toast,setToast]=useState("");

  useEffect(()=>setMounted(true),[]);
  const doFlash=(c:string)=>{setFlash(c);setTimeout(()=>setFlash(""),500);};
  const msg=(m:string)=>{setToast(m);setTimeout(()=>setToast(""),2500);};
  const reset=()=>{setStep(0);setSku("");setLoc("");setQty(1);setCam(false);setManual("");setShowManual(false);};

  const handleScan=useCallback((code:string)=>{
    const {db}=getStore();
    if(mode==="in"){
      if(step===0){
        const f=findSku(db,code);
        if(f){setSku(f);setStep(1);setCam(false);doFlash("green");setTimeout(()=>setCam(true),600);}
        else msg("No reconocido: "+code);
      } else if(step===1){
        const l=parseLoc(code);
        if(l&&LOCS.includes(l)){setLoc(l);setStep(2);setCam(false);doFlash("blue");}
        else msg("Ubicacion no valida: "+code);
      }
    } else {
      if(step===0){
        const f=findSku(db,code);
        if(f){
          const ls=Object.entries(db[f].locs).filter(([,q])=>q>0);
          if(!ls.length){msg("Sin stock en bodega");return;}
          setSku(f);if(ls.length===1)setLoc(ls[0][0]);
          setStep(1);setCam(false);doFlash("red");
        } else msg("No reconocido: "+code);
      }
    }
  },[mode,step]);

  const doManual=()=>{if(manual.trim()){handleScan(manual.trim());setManual("");setShowManual(false);}};

  const confirm=()=>{
    const store=getStore();const{db}=store;const now=new Date();
    const ts=now.toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    if(mode==="in"){
      db[sku].locs[loc]=(db[sku].locs[loc]||0)+qty;
      store.movements.unshift({id:nextMovId(store),ts:now.toISOString(),type:"in",sku,loc,qty,who:"Operador",ref:"SCAN-"+Date.now()});
      updateStore({db,movements:store.movements,movCounter:store.movCounter});
      setLog(p=>[{time:ts,type:"in",sku,loc,qty},...p].slice(0,20));
      msg(qty+" x "+sku+" -> "+loc);doFlash("green");
    } else {
      const take=Math.min(qty,db[sku].locs[loc]||0);
      db[sku].locs[loc]-=take;if(db[sku].locs[loc]<=0)delete db[sku].locs[loc];
      store.movements.unshift({id:nextMovId(store),ts:now.toISOString(),type:"out-full",sku,loc,qty:take,who:"Operador",ref:"SCAN-"+Date.now()});
      updateStore({db,movements:store.movements,movCounter:store.movCounter});
      setLog(p=>[{time:ts,type:"out",sku,loc,qty:take},...p].slice(0,20));
      msg(take+" x "+sku+" salio de "+loc);doFlash("red");
    }
    reset();refresh();
  };

  if(!mounted)return null;
  const isIn=mode==="in";const db=getStore().db;

  return(<div>
    <div className="scan-mode">
      <button className={isIn?"active-in":""} onClick={()=>{setMode("in");reset();}}>ENTRADA</button>
      <button className={!isIn?"active-out":""} onClick={()=>{setMode("out");reset();}}>SALIDA</button>
    </div>
    {toast&&<div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:toast.includes("No")?"2px solid var(--amber)":"2px solid var(--green)",color:toast.includes("No")?"var(--amber)":"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}
    {cam&&<BarcodeScanner active={cam} onScan={handleScan} label={isIn?(step===0?"Apunta al PRODUCTO":"Apunta al QR UBICACION"):"Apunta al PRODUCTO"}/>}
    <div className={`scan-area ${flash?"flash-"+flash:""}`}>
      {isIn?<>
        {step===0&&<><div style={{fontSize:40}}>{"📦"}</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 1 de 3</div><div style={{fontSize:18,fontWeight:700}}>Escanea el PRODUCTO</div><div style={{fontSize:11,color:"var(--txt3)"}}>Codigo de barras, etiqueta ML, o SKU</div></>}
        {step===1&&<><div className="scan-tag mono" style={{background:"var(--greenBg)",color:"var(--green)",marginBottom:8}}>{sku} - {db[sku]?.d}</div><div style={{fontSize:40}}>{"📍"}</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 2 de 3</div><div style={{fontSize:18,fontWeight:700}}>Escanea la UBICACION</div><div style={{fontSize:11,color:"var(--txt3)"}}>QR del estante</div></>}
        {step===2&&<><div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center",marginBottom:8}}><span className="scan-tag mono" style={{background:"var(--greenBg)",color:"var(--green)"}}>{sku}</span><span className="scan-tag mono" style={{background:"var(--blueBg)",color:"var(--blue)"}}>{loc}</span></div><div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>Paso 3 de 3 - Cantidad</div>
          <div className="qty-row"><button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>-</button><div className="qty-val mono">{qty}</div><button className="qty-btn" onClick={()=>setQty(qty+1)}>+</button></div>
          <div className="qty-presets">{[1,5,10,20,50,100].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>)}</div></>}
      </>:<>
        {step===0&&<><div style={{fontSize:40}}>{"🏷️"}</div><div style={{fontSize:12,color:"var(--txt3)"}}>Paso 1 de 2</div><div style={{fontSize:18,fontWeight:700}}>Escanea el PRODUCTO que sale</div></>}
        {step===1&&<><div className="scan-tag mono" style={{background:"var(--amberBg)",color:"var(--amber)",marginBottom:8}}>{sku} - {db[sku]?.d}</div>
          {Object.entries(db[sku]?.locs||{}).filter(([,q])=>q>0).length>1&&<div style={{marginBottom:8,width:"100%"}}><div style={{fontSize:11,color:"var(--txt3)",marginBottom:4}}>Selecciona ubicacion:</div><div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>{Object.entries(db[sku].locs).filter(([,q])=>q>0).map(([l,q])=><button key={l} onClick={()=>setLoc(l)} style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:700,background:loc===l?"var(--amberBg)":"var(--bg3)",color:loc===l?"var(--amber)":"var(--txt2)",border:loc===l?"2px solid var(--amber)":"1px solid var(--bg4)",fontFamily:"'JetBrains Mono',monospace"}}>{l} ({q as number})</button>)}</div></div>}
          {loc&&<><div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>Cantidad:</div>
          <div className="qty-row"><button className="qty-btn" onClick={()=>setQty(Math.max(1,qty-1))}>-</button><div className="qty-val mono">{qty}</div><button className="qty-btn" onClick={()=>setQty(qty+1)}>+</button></div>
          <div className="qty-presets">{[1,5,10,20,50].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)}>{n}</button>)}</div></>}
        </>}
      </>}
    </div>
    <div style={{display:"flex",gap:8,marginTop:12}}>
      {((isIn&&step<2)||(!isIn&&step===0))?<>
        <button className="scan-btn blue" style={{flex:1}} onClick={()=>setCam(!cam)}>{cam?"Pausar Camara":"Abrir Camara"}</button>
        <button style={{padding:"14px 18px",borderRadius:"var(--radius)",background:"var(--bg3)",color:"var(--txt2)",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}} onClick={()=>setShowManual(!showManual)}>Manual</button>
      </>:<button className={`scan-btn ${isIn?"green":"red"}`} style={{flex:1}} onClick={confirm} disabled={isIn?step!==2:!loc}>{isIn?"CONFIRMAR ENTRADA":"CONFIRMAR SALIDA"}</button>}
    </div>
    {step>0&&<button onClick={reset} style={{width:"100%",padding:10,marginTop:8,borderRadius:"var(--radius)",background:"var(--bg3)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>}
    {showManual&&<div style={{marginTop:12,display:"flex",gap:8}}>
      <input className="find-input mono" value={manual} onChange={e=>setManual(e.target.value.toUpperCase())} placeholder={step===1&&isIn?"Ubicacion (P-01 o E-01-1)":"SKU o codigo..."} onKeyDown={e=>e.key==="Enter"&&doManual()} autoFocus style={{flex:1}}/>
      <button className="scan-btn blue" style={{width:"auto",padding:"12px 20px"}} onClick={doManual}>OK</button>
    </div>}
    {showManual&&step===0&&<div className="sku-chips" style={{marginTop:8}}>{Object.keys(db).map(s=><button key={s} className="sku-chip mono" onClick={()=>handleScan(s)}>{s}</button>)}</div>}
    {showManual&&step===1&&isIn&&<div className="sku-chips" style={{marginTop:8}}>{LOCS.map(l=><button key={l} className="sku-chip mono" onClick={()=>handleScan(l)} style={{fontSize:10}}>{l}</button>)}</div>}
    {log.length>0&&<div className="card" style={{marginTop:14}}><div className="card-title">Registro de hoy</div>{log.map((e,i)=><div key={i} className={`log-item ${i===0?"anim-in":""}`}><span className="mono" style={{color:"var(--txt3)",fontSize:10}}>{e.time}</span><span className="log-badge" style={{background:e.type==="in"?"var(--greenBg)":"var(--redBg)",color:e.type==="in"?"var(--green)":"var(--red)"}}>{e.type==="in"?"ENTRADA":"SALIDA"}</span><span className="mono" style={{fontWeight:700,fontSize:11}}>{e.sku}</span><span style={{color:"var(--txt3)"}}>-&gt;</span><span className="mono" style={{color:"var(--blue)",fontWeight:600,fontSize:11}}>{e.loc}</span><span style={{color:"var(--txt2)"}}>x{e.qty}</span></div>)}</div>}
  </div>);
}

function Finder() {
  const [q,setQ]=useState("");const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);if(!mounted)return null;
  const db=getStore().db;const ql=q.toLowerCase();
  const res=ql.length>=2?Object.entries(db).filter(([s,v])=>s.toLowerCase().includes(ql)||v.d.toLowerCase().includes(ql)||v.cat?.toLowerCase().includes(ql)):[];
  return(<div>
    <div className="card"><div className="card-title">Buscar producto</div>
      <input className="find-input mono" placeholder="SKU, nombre o categoria..." value={q} onChange={e=>setQ(e.target.value)}/>
      <div className="sku-chips">{Object.keys(db).map(s=><button key={s} className="sku-chip mono" onClick={()=>setQ(s)}>{s}</button>)}</div>
    </div>
    {res.map(([sku,data])=>{const total=getSkuTotal(db,sku),st=getStockStatus(db,sku);
      return(<div key={sku} className="card" style={{border:"2px solid var(--blueBd)",marginTop:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
          <div><div className="mono" style={{fontSize:18,fontWeight:700}}>{sku}</div><div style={{fontSize:13,color:"var(--txt2)",marginTop:2}}>{data.d}</div>
            <div style={{display:"flex",gap:6,marginTop:4}}><span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:st.color+"20",color:st.color}}>{st.label}</span><span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--bg3)",color:"var(--txt3)"}}>{data.cat}</span></div></div>
          <div style={{textAlign:"center",background:"var(--bg3)",borderRadius:8,padding:"8px 14px"}}><div style={{fontSize:10,color:"var(--txt3)",fontWeight:600}}>TOTAL</div><div className="mono" style={{fontSize:22,fontWeight:700,color:"var(--blue)"}}>{total}</div></div>
        </div>
        <div style={{fontSize:12,fontWeight:700,color:"var(--txt2)",marginBottom:8}}>En Bodega - {Object.keys(data.locs).length} ubicacion{Object.keys(data.locs).length!==1?"es":""}</div>
        {Object.entries(data.locs).map(([l,q])=><div key={l} className="loc-row"><span className="mono" style={{fontWeight:700,color:"var(--green)",minWidth:65}}>{l}</span><span style={{flex:1,fontWeight:700,fontSize:15}}>{q} uds</span><span style={{fontSize:11,color:"var(--green)",fontWeight:600}}>IR</span></div>)}
        <div className="stat-grid">
          <div className="stat-box" style={{background:"var(--amberBg)",border:"1px solid var(--amberBd)"}}><div className="label" style={{color:"var(--amber)"}}>EN TRANSITO</div><div className="val mono" style={{color:"var(--amber)"}}>{data.transit}</div></div>
          <div className="stat-box" style={{background:"var(--blueBg)",border:"1px solid var(--blueBd)"}}><div className="label" style={{color:"var(--blue)"}}>EN ML FULL</div><div className="val mono" style={{color:"var(--blue)"}}>{data.full}</div></div>
        </div>
      </div>);})}
  </div>);
}

function MapView() {
  const [sel,setSel]=useState<string|null>(null);const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);if(!mounted)return null;
  const db=getStore().db;
  const pallets=LOCS.filter(l=>l.startsWith("P-"));
  const shelves=LOCS.filter(l=>l.startsWith("E-"));
  const sections=[{id:"P",locs:pallets,lb:"Pallets en Piso",c:"var(--amber)"},{id:"E",locs:shelves,lb:"Estantes",c:"var(--cyan)"}];
  return(<div>{sections.map(z=>{return(<div key={z.id} style={{marginBottom:20}}>
    <div className="zone-label" style={{color:z.c}}>{z.lb} ({z.locs.length})</div>
    <div className="loc-grid" style={{gridTemplateColumns:z.id==="P"?"repeat(4,1fr)":"repeat(3,1fr)"}}>
      {z.locs.map(loc=>{const items=getLocItems(db,loc);const tq=items.reduce((s,i)=>s+i.qty,0);const isSel=sel===loc;
      return(<div key={loc} className={`loc-cell ${isSel?"selected":""}`} onClick={()=>setSel(isSel?null:loc)}>
        <div className="mono" style={{fontSize:11,fontWeight:700,color:z.c,marginBottom:3}}>{loc}</div>
        {items.length?<div style={{fontSize:10,color:"var(--txt3)"}}>{items.map(i=>i.sku).join(", ")}<br/>{tq} uds</div>:<div style={{fontSize:10,color:"var(--green)",fontWeight:600}}>LIBRE</div>}
      </div>);})}</div>
    {sel&&sel.startsWith(z.id==="P"?"P":"E")&&<div className="card"><div className="card-title mono" style={{color:z.c}}>{sel}</div>
      {getLocItems(db,sel).length?getLocItems(db,sel).map((it,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 10px",background:"var(--bg3)",borderRadius:6,marginBottom:4}}>
        <div><span className="mono" style={{fontWeight:700}}>{it.sku}</span><span style={{fontSize:12,color:"var(--txt3)",marginLeft:8}}>{it.desc}</span></div>
        <span className="mono" style={{fontWeight:700,color:z.c}}>{it.qty} uds</span></div>)
      :<div style={{fontSize:13,color:"var(--txt3)"}}>Ubicacion libre</div>}
    </div>}
  </div>);})}</div>);
}
