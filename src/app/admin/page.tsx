"use client";
import { useState, useEffect } from "react";
import { getStore, updateStore, getSkuBodTotal, getSkuTotal, getLocItems, getStockStatus, getABC, nextMovId, fmtMoney, fmtDate, fmtTime, PROVEEDORES, CATEGORIAS, LOCS } from "@/lib/store";
import Link from "next/link";

export default function AdminPage() {
  const [tab, setTab] = useState("dashboard");
  const [, setTick] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const refresh = () => setTick(t => t + 1);

  if (!mounted) return <div className="app"><div style={{padding:40,textAlign:"center",color:"var(--txt3)"}}>Cargando...</div></div>;

  const tabs = [
    { id: "dashboard", label: "📊 Dashboard" },
    { id: "skus", label: "📦 SKUs" },
    { id: "locations", label: "🗺️ Mapa" },
    { id: "movements", label: "📋 Movimientos" },
    { id: "counts", label: "📝 Conteos" },
    { id: "alerts", label: "🔔 Alertas" },
  ];

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/"><button className="back-btn">← Salir</button></Link>
        <h1>⚙️ Admin</h1>
        <div style={{ fontSize: 11, color: "var(--txt3)" }}>{new Date().toLocaleDateString("es-CL")}</div>
      </div>
      <div className="tabs">
        {tabs.map(t => <button key={t.id} className={`tab ${tab===t.id?"active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>)}
      </div>
      <div style={{ padding: 16 }}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "skus" && <SkuAdmin refresh={refresh} />}
        {tab === "locations" && <LocationAdmin />}
        {tab === "movements" && <Movements />}
        {tab === "counts" && <Counts refresh={refresh} />}
        {tab === "alerts" && <Alerts />}
      </div>
    </div>
  );
}

function KPI({ label, val, color }: { label: string; val: string; color: string }) {
  return <div className="kpi"><div className="label">{label}</div><div className="val mono" style={{color}}>{val}</div></div>;
}

function Dashboard() {
  const { db } = getStore();
  const skus = Object.entries(db);
  const totalBod = skus.reduce((s,[k]) => s + getSkuBodTotal(db,k), 0);
  const totalFull = skus.reduce((s,[,v]) => s + v.full, 0);
  const totalTrans = skus.reduce((s,[,v]) => s + v.transit, 0);
  const valorBod = skus.reduce((s,[k,v]) => s + getSkuBodTotal(db,k) * v.cost, 0);
  const criticos = skus.filter(([k]) => { const st = getStockStatus(db,k); return st.label==="CRÍTICO"||st.label==="SIN STOCK"; }).length;
  const usedLocs = LOCS.filter(l => getLocItems(db,l).length > 0).length;
  const store = getStore();
  const movHoy = store.movements.filter(m => new Date(m.ts).toDateString() === new Date().toDateString()).length;

  return (
    <div>
      {/* Quick action links */}
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <a href="/admin/qr-codes" style={{flex:1,padding:"14px 12px",borderRadius:"var(--radius)",background:"var(--bg2)",border:"1px solid var(--bg4)",textAlign:"center",textDecoration:"none",color:"var(--txt)"}}>
          <div style={{fontSize:20,marginBottom:4}}>{"🏷️"}</div>
          <div style={{fontSize:11,fontWeight:700,color:"var(--cyan)"}}>Imprimir QRs</div>
          <div style={{fontSize:10,color:"var(--txt3)"}}>Ubicaciones</div>
        </a>
        <a href="/admin/importar" style={{flex:1,padding:"14px 12px",borderRadius:"var(--radius)",background:"var(--bg2)",border:"1px solid var(--bg4)",textAlign:"center",textDecoration:"none",color:"var(--txt)"}}>
          <div style={{fontSize:20,marginBottom:4}}>{"📥"}</div>
          <div style={{fontSize:11,fontWeight:700,color:"var(--cyan)"}}>Importar SKUs</div>
          <div style={{fontSize:10,color:"var(--txt3)"}}>CSV / Excel</div>
        </a>
        <a href="/admin" onClick={()=>{if(typeof window!=="undefined"&&confirm("Resetear todos los datos a los valores de demo?")){const{resetStore}=require("@/lib/store");resetStore();window.location.reload();}}} style={{flex:1,padding:"14px 12px",borderRadius:"var(--radius)",background:"var(--bg2)",border:"1px solid var(--bg4)",textAlign:"center",textDecoration:"none",color:"var(--txt)"}}>
          <div style={{fontSize:20,marginBottom:4}}>{"🔄"}</div>
          <div style={{fontSize:11,fontWeight:700,color:"var(--amber)"}}>Resetear</div>
          <div style={{fontSize:10,color:"var(--txt3)"}}>Datos demo</div>
        </a>
      </div>
      <div className="kpi-grid">
        <KPI label="Total SKUs" val={String(skus.length)} color="var(--cyan)"/>
        <KPI label="Uds en Bodega" val={String(totalBod)} color="var(--green)"/>
        <KPI label="Uds en Full" val={String(totalFull)} color="var(--blue)"/>
        <KPI label="En Tránsito" val={String(totalTrans)} color="var(--amber)"/>
        <KPI label="Valor Bodega" val={fmtMoney(valorBod)} color="var(--green)"/>
        <KPI label="SKUs Críticos" val={String(criticos)} color={criticos>0?"var(--red)":"var(--green)"}/>
        <KPI label="Ubicaciones" val={`${usedLocs}/${LOCS.length}`} color="var(--cyan)"/>
        <KPI label="Mov. Hoy" val={String(movHoy)} color="var(--blue)"/>
      </div>

      <div className="card">
        <div className="card-title">📊 Stock por Proveedor</div>
        <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr><th>Proveedor</th><th>SKUs</th><th>Uds</th><th>Valor</th></tr></thead>
          <tbody>{PROVEEDORES.map(p => {
            const ps = skus.filter(([,v]) => v.prov === p);
            const uds = ps.reduce((s,[k]) => s + getSkuBodTotal(db,k), 0);
            const val = ps.reduce((s,[k,v]) => s + getSkuBodTotal(db,k) * v.cost, 0);
            return <tr key={p}><td style={{fontWeight:600}}>{p}</td><td className="mono">{ps.length}</td><td className="mono">{uds}</td><td className="mono">{fmtMoney(val)}</td></tr>;
          })}</tbody>
        </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">📦 Inventario por SKU</div>
        <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr><th>SKU</th><th>Bod.</th><th>Full</th><th>Total</th><th>Estado</th><th>ABC</th></tr></thead>
          <tbody>{skus.map(([sku,d]) => {
            const st = getStockStatus(db,sku), abc = getABC(db,sku);
            return (
              <tr key={sku}>
                <td><span className="mono" style={{fontWeight:600,fontSize:11}}>{sku}</span><div style={{fontSize:10,color:"var(--txt3)"}}>{d.d}</div></td>
                <td className="mono">{getSkuBodTotal(db,sku)}</td>
                <td className="mono">{d.full}</td>
                <td className="mono" style={{fontWeight:700}}>{getSkuTotal(db,sku)}</td>
                <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:st.color+"20",color:st.color}}>{st.label}</span></td>
                <td><span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:abc==="A"?"var(--greenBg)":abc==="B"?"var(--amberBg)":"var(--bg3)",color:abc==="A"?"var(--green)":abc==="B"?"var(--amber)":"var(--txt3)"}}>{abc}</span></td>
              </tr>
            );
          })}</tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function SkuAdmin({ refresh }: { refresh: () => void }) {
  const [f, setF] = useState({ sku:"", desc:"", cat:"Sábanas", prov:"Idetex", cost:"", price:"", reorder:"", mlCode:"" });
  const store = getStore();
  const db = store.db;

  const addSku = () => {
    if (!f.sku || !f.desc) return alert("Completa SKU y Descripción");
    if (db[f.sku]) return alert("Este SKU ya existe");
    db[f.sku] = { d: f.desc, cat: f.cat, prov: f.prov, cost: parseInt(f.cost)||0, price: parseInt(f.price)||0, locs: {}, transit: 0, full: 0, reorder: parseInt(f.reorder)||20, sales30: 0, mlCode: f.mlCode };
    updateStore({ db });
    setF({ sku:"", desc:"", cat:"Sábanas", prov:"Idetex", cost:"", price:"", reorder:"", mlCode:"" });
    refresh();
  };

  const delSku = (sku: string) => {
    if (!confirm("¿Eliminar " + sku + "?")) return;
    delete db[sku];
    updateStore({ db });
    refresh();
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">➕ Agregar SKU</div>
        <div className="form-group"><label className="form-label">SKU</label><input className="form-input mono" value={f.sku} onChange={e=>setF({...f,sku:e.target.value.toUpperCase()})} placeholder="TOA-0099"/></div>
        <div className="form-group"><label className="form-label">Descripción</label><input className="form-input" value={f.desc} onChange={e=>setF({...f,desc:e.target.value})} placeholder="Toalla Diseño 099"/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div className="form-group"><label className="form-label">Categoría</label><select className="form-select" value={f.cat} onChange={e=>setF({...f,cat:e.target.value})}>{CATEGORIAS.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Proveedor</label><select className="form-select" value={f.prov} onChange={e=>setF({...f,prov:e.target.value})}>{PROVEEDORES.map(p=><option key={p} value={p}>{p}</option>)}</select></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <div className="form-group"><label className="form-label">Costo ($)</label><input className="form-input mono" type="number" value={f.cost} onChange={e=>setF({...f,cost:e.target.value})}/></div>
          <div className="form-group"><label className="form-label">Precio ML ($)</label><input className="form-input mono" type="number" value={f.price} onChange={e=>setF({...f,price:e.target.value})}/></div>
          <div className="form-group"><label className="form-label">Pto. Reorden</label><input className="form-input mono" type="number" value={f.reorder} onChange={e=>setF({...f,reorder:e.target.value})}/></div>
        </div>
        <div className="form-group"><label className="form-label">Código ML (Code 128)</label><input className="form-input mono" value={f.mlCode} onChange={e=>setF({...f,mlCode:e.target.value})} placeholder="MLC-882734100"/></div>
        <button className="btn-primary" onClick={addSku}>Agregar SKU</button>
      </div>

      <div className="card">
        <div className="card-title">📦 SKUs Registrados ({Object.keys(db).length})</div>
        <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr><th>SKU</th><th>Prov.</th><th>Costo</th><th>Precio</th><th>Reorden</th><th></th></tr></thead>
          <tbody>{Object.entries(db).map(([sku,d]) => (
            <tr key={sku}>
              <td><span className="mono" style={{fontWeight:600,fontSize:11}}>{sku}</span><div style={{fontSize:10,color:"var(--txt3)"}}>{d.d}</div></td>
              <td style={{fontSize:11}}>{d.prov}</td>
              <td className="mono" style={{fontSize:11}}>{fmtMoney(d.cost)}</td>
              <td className="mono" style={{fontSize:11}}>{fmtMoney(d.price)}</td>
              <td className="mono" style={{fontSize:11}}>{d.reorder}</td>
              <td><button className="btn-danger" onClick={()=>delSku(sku)}>✕</button></td>
            </tr>
          ))}</tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function LocationAdmin() {
  const [sel, setSel] = useState<string|null>(null);
  const db = getStore().db;
  const zones = [{id:"P",lb:"Pallets en Piso",c:"var(--amber)",locs:LOCS.filter(l=>l.startsWith("P-"))},{id:"E",lb:"Estantes",c:"var(--cyan)",locs:LOCS.filter(l=>l.startsWith("E-"))}];

  return (
    <div>
      {zones.map(z => {
        return (
          <div key={z.id} style={{marginBottom:20}}>
            <div className="zone-label" style={{color:z.c}}>{z.lb} ({z.locs.length})</div>
            <div className="loc-grid" style={{gridTemplateColumns:z.id==="P"?"repeat(4,1fr)":"repeat(3,1fr)"}}>
              {z.locs.map(loc => {
                const items = getLocItems(db,loc); const tq = items.reduce((s,i)=>s+i.qty,0); const isSel = sel===loc;
                return (
                  <div key={loc} className={`loc-cell ${isSel?"selected":""}`} onClick={()=>setSel(isSel?null:loc)}>
                    <div className="mono" style={{fontSize:11,fontWeight:700,color:z.c,marginBottom:3}}>{loc}</div>
                    {items.length ? <div style={{fontSize:10,color:"var(--txt3)"}}>{items.map(i=>i.sku).join(", ")}<br/>{tq} uds</div> : <div style={{fontSize:10,color:"var(--green)",fontWeight:600}}>LIBRE</div>}
                  </div>
                );
              })}
            </div>
            {sel && sel.startsWith(z.id==="P"?"P":"E") && (
              <div className="card">
                <div className="card-title mono" style={{color:z.c}}>📍 {sel}</div>
                {getLocItems(db,sel).length ? getLocItems(db,sel).map((it,i) => (
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

function Movements() {
  const { movements } = getStore();
  return (
    <div>
      <div className="card">
        <div className="card-title">📋 Últimos Movimientos ({movements.length})</div>
      </div>
      {movements.slice(0,25).map(m => {
        const isIn = m.type==="in", isFull = m.type==="out-full";
        const color = isIn?"var(--green)":isFull?"var(--blue)":"var(--amber)";
        const bg = isIn?"var(--greenBg)":isFull?"var(--blueBg)":"var(--amberBg)";
        const label = isIn?"ENTRADA":isFull?"→ FULL":m.type==="out-flex"?"→ FLEX":"AJUSTE";
        return (
          <div key={m.id} className="mov-item">
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:4,background:bg,color}}>{label}</span>
                <span className="mono" style={{fontWeight:700,fontSize:11}}>{m.sku}</span>
                <span style={{color:"var(--txt2)",fontSize:11}}>×{m.qty}</span>
              </div>
              <div style={{display:"flex",gap:10,fontSize:10,color:"var(--txt3)"}}>
                <span>📍 {m.loc}</span><span>👤 {m.who}</span><span>📎 {m.ref}</span>
              </div>
            </div>
            <div style={{textAlign:"right",fontSize:10,color:"var(--txt3)"}}>
              <div>{fmtDate(m.ts)}</div><div>{fmtTime(m.ts)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Counts({ refresh }: { refresh: () => void }) {
  const [f, setF] = useState({ sku:"", loc:"", expected:"", counted:"" });
  const store = getStore();
  const db = store.db;

  const submit = () => {
    if (!f.sku || !f.counted) return alert("Completa SKU y cantidad contada");
    const exp = parseInt(f.expected)||0, cnt = parseInt(f.counted)||0;
    store.cycleCounts.unshift({ date: new Date().toISOString().split("T")[0], sku: f.sku, loc: f.loc, expected: exp, counted: cnt, diff: cnt-exp });
    if (cnt !== exp) {
      db[f.sku].locs[f.loc] = cnt;
      if (cnt <= 0) delete db[f.sku].locs[f.loc];
      store.movements.unshift({ id: nextMovId(store), ts: new Date().toISOString(), type: "adjust", sku: f.sku, loc: f.loc, qty: Math.abs(cnt-exp), who: "Conteo", ref: "AJUSTE-CICLICO" });
    }
    updateStore({ db, cycleCounts: store.cycleCounts, movements: store.movements, movCounter: store.movCounter });
    setF({ sku:"", loc:"", expected:"", counted:"" });
    refresh();
  };

  const skuLocs = f.sku ? Object.keys(db[f.sku]?.locs || {}) : [];

  return (
    <div>
      <div className="card">
        <div className="card-title">📝 Registrar Conteo</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div className="form-group"><label className="form-label">SKU</label>
            <select className="form-select mono" value={f.sku} onChange={e=>{
              const sk=e.target.value; const locs=sk?Object.keys(db[sk]?.locs||{}):[];
              setF({...f,sku:sk,loc:locs[0]||"",expected:sk&&locs[0]?String(db[sk].locs[locs[0]]||0):""});
            }}><option value="">Seleccionar...</option>{Object.keys(db).map(s=><option key={s} value={s}>{s}</option>)}</select>
          </div>
          <div className="form-group"><label className="form-label">Ubicación</label>
            <select className="form-select mono" value={f.loc} onChange={e=>setF({...f,loc:e.target.value,expected:f.sku?String(db[f.sku]?.locs[e.target.value]||0):""})}>{skuLocs.map(l=><option key={l} value={l}>{l}</option>)}</select>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div className="form-group"><label className="form-label">Stock Teórico</label><input className="form-input mono" value={f.expected} disabled/></div>
          <div className="form-group"><label className="form-label">Stock Real</label><input className="form-input mono" type="number" value={f.counted} onChange={e=>setF({...f,counted:e.target.value})}/></div>
        </div>
        <button className="btn-primary" onClick={submit}>Registrar Conteo</button>
      </div>
      <div className="card">
        <div className="card-title">📊 Historial</div>
        <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr><th>Fecha</th><th>SKU</th><th>Ubic.</th><th>Teórico</th><th>Real</th><th>Dif.</th></tr></thead>
          <tbody>{store.cycleCounts.map((c,i) => (
            <tr key={i}>
              <td style={{fontSize:11}}>{c.date}</td>
              <td className="mono" style={{fontSize:11,fontWeight:600}}>{c.sku}</td>
              <td className="mono" style={{fontSize:11}}>{c.loc}</td>
              <td className="mono">{c.expected}</td>
              <td className="mono">{c.counted}</td>
              <td className="mono" style={{fontWeight:700,color:c.diff===0?"var(--green)":"var(--red)"}}>{c.diff}</td>
            </tr>
          ))}</tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function Alerts() {
  const store = getStore();
  const db = store.db;
  const alerts: {icon:string;msg:string;color:string;bg:string}[] = [];

  Object.entries(db).forEach(([sku,d]) => {
    const st = getStockStatus(db,sku);
    if (st.label==="CRÍTICO"||st.label==="SIN STOCK")
      alerts.push({icon:"🔴",msg:`${sku} (${d.d}) — Stock: ${getSkuTotal(db,sku)}. Reorden: ${d.reorder}. Pedir a ${d.prov}.`,color:"var(--red)",bg:"var(--redBg)"});
    else if (st.label==="BAJO")
      alerts.push({icon:"🟡",msg:`${sku} (${d.d}) — Stock bajo: ${getSkuTotal(db,sku)}. Reorden: ${d.reorder}.`,color:"var(--amber)",bg:"var(--amberBg)"});
  });

  const diffs = store.cycleCounts.filter(c => c.diff !== 0);
  if (diffs.length > 0) alerts.push({icon:"📋",msg:`${diffs.length} conteo(s) con diferencia.`,color:"var(--amber)",bg:"var(--amberBg)"});
  if (alerts.length === 0) alerts.push({icon:"✅",msg:"Sin alertas. Todo en orden.",color:"var(--green)",bg:"var(--greenBg)"});

  return (
    <div>
      <div className="card">
        <div className="card-title">🔔 Alertas Activas ({alerts.length})</div>
        {alerts.map((a,i) => (
          <div key={i} className="alert-item" style={{background:a.bg,border:`1px solid ${a.color}40`}}>
            <span style={{fontSize:16,flexShrink:0}}>{a.icon}</span>
            <span style={{color:a.color}}>{a.msg}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-title">📦 Sugerencia de Reposición</div>
        <div style={{overflowX:"auto"}}>
        <table className="tbl">
          <thead><tr><th>SKU</th><th>Stock</th><th>Reorden</th><th>Pedir</th><th>Prov.</th></tr></thead>
          <tbody>{Object.entries(db).filter(([k])=>getSkuTotal(db,k)<=db[k].reorder*1.5).map(([sku,d]) => {
            const total = getSkuTotal(db,sku), sugerido = Math.max(0, d.reorder*2-total);
            return (
              <tr key={sku}>
                <td className="mono" style={{fontSize:11,fontWeight:600}}>{sku}</td>
                <td className="mono">{total}</td>
                <td className="mono">{d.reorder}</td>
                <td className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{sugerido}</td>
                <td style={{fontSize:11}}>{d.prov}</td>
              </tr>
            );
          })}</tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
