"use client";
import React, { useState } from "react";
import { getStore, saveStore, posContents } from "@/lib/store";

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

export default Posiciones;
