"use client";
import React, { useState, useEffect } from "react";
import { getStore, skuTotal, activePositions, getCategorias, saveCategorias, getProveedores, saveProveedores, getLastSyncTime, importStockFromSheet, wasStockImported, getUnassignedStock, assignPosition, isSupabaseConfigured, saveStore } from "@/lib/store";
import { getOAuthUrl } from "@/lib/ml";
import Link from "next/link";
import ConfigML from "@/components/admin/ConfigML";
import DiccionarioConfig from "@/components/admin/DiccionarioConfig";
import Posiciones from "@/components/admin/Posiciones";
import AdminEtiquetas from "@/components/admin/AdminEtiquetas";
import CargaStock from "@/components/admin/CargaStock";
import AdminConteos from "@/components/admin/AdminConteos";
import ConciliacionSplitView from "@/components/ConciliacionSplitView";

function Configuracion({ refresh, initialSubTab }: { refresh: () => void; initialSubTab?: string }) {
  const [configTab, setConfigTab] = useState<"general"|"posiciones"|"mapa"|"etiquetas"|"carga_stock"|"conteos"|"conciliador"|"diccionario"|"ml">(initialSubTab === "ml" ? "ml" : "general");
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
        {([["general","General","⚙️"],["ml","MercadoLibre","🛒"],["diccionario","Diccionario","📖"],["posiciones","Posiciones","📍"],["mapa","Mapa Bodega","🗺️"],["etiquetas","Etiquetas","🖨️"],["carga_stock","Carga Stock","📥"],["conteos","Conteo Cíclico","📋"],["conciliador","Conciliador","🏦"]] as const).map(([key,label,icon])=>(
          <button key={key} onClick={()=>setConfigTab(key)} style={{padding:"8px 16px",borderRadius:8,background:configTab===key?"var(--cyan)":"var(--bg3)",color:configTab===key?"#fff":"var(--txt2)",fontWeight:configTab===key?700:500,fontSize:13,border:configTab===key?"none":"1px solid var(--bg4)",cursor:"pointer"}}>{icon} {label}</button>
        ))}
      </div>

      {configTab==="ml"&&<ConfigML/>}
      {configTab==="diccionario"&&<DiccionarioConfig/>}
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

export default Configuracion;
