"use client";
import React, { useState, useEffect } from "react";
import { getStore, saveStore, skuTotal, fmtMoney, getCategorias, getProveedores, getVentasPorSkuOrigen, getNotasOperativas } from "@/lib/store";
import type { Product } from "@/lib/store";
import { fetchMLItemsMap } from "@/lib/db";
import type { DBMLItemMap } from "@/lib/db";

// ==================== PRODUCTOS ====================
function Productos({ refresh }: { refresh: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editSku, setEditSku] = useState<string|null>(null);
  const [q, setQ] = useState("");
  const [mlItems, setMlItems] = useState<DBMLItemMap[]>([]);
  const s = getStore();

  // Cargar ml_items_map para mostrar capa ML en detalle de producto
  useEffect(() => { fetchMLItemsMap().then(setMlItems); }, []);

  // Index: sku_venta (upper) → ML items
  const mlBySkuVenta = React.useMemo(() => {
    const map: Record<string, DBMLItemMap[]> = {};
    for (const m of mlItems) {
      const sv = (m.sku_venta || "").toUpperCase();
      if (!sv) continue;
      if (!map[sv]) map[sv] = [];
      map[sv].push(m);
    }
    return map;
  }, [mlItems]);
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
    s.products[sku]={sku,skuVenta:"",name:form.name!,mlCode:form.mlCode||"",cat:form.cat||"Otros",prov:form.prov||"Otro",cost:form.cost||0,price:form.price||0,reorder:form.reorder||20};
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
            <thead><tr><th>SKU Origen</th><th>Nombre</th><th>Publicaciones ML</th><th>Cat.</th><th>Prov.</th><th style={{textAlign:"right"}}>Costo</th><th style={{textAlign:"right"}}>Stock</th><th style={{textAlign:"right"}}>Vendible</th><th></th></tr></thead>
            <tbody>{prods.map(p=>{
              const ventas = getVentasPorSkuOrigen(p.sku);
              const stock = skuTotal(p.sku);
              return (
              <tr key={p.sku}>
                <td className="mono" style={{fontWeight:700,fontSize:12}}>{p.sku}</td>
                <td style={{fontSize:12}}>{p.name}</td>
                <td style={{fontSize:11}}>
                  {ventas.length > 0 ? ventas.map((v, i) => {
                    const mlItems4sv = mlBySkuVenta[v.skuVenta.toUpperCase()] || [];
                    const notas = getNotasOperativas(v.skuVenta);
                    return (
                    <div key={i} style={{marginBottom:i<ventas.length-1?6:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,whiteSpace:"nowrap",
                          background:v.unidades>1?"var(--amber)15":"var(--cyan)15",
                          color:v.unidades>1?"var(--amber)":"var(--cyan)"}}>
                          {v.unidades>1?`x${v.unidades}`:"x1"}
                        </span>
                        <span className="mono" style={{fontSize:10}}>{v.codigoMl}</span>
                        <span style={{fontSize:9,color:"var(--txt3)"}}>{v.skuVenta}</span>
                      </div>
                      {notas.length > 0 && (
                        <div style={{fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>⚠ {notas.join(" | ")}</div>
                      )}
                      {mlItems4sv.length > 0 && mlItems4sv.map((ml, j) => (
                        <div key={j} style={{marginLeft:16,marginTop:2,display:"flex",alignItems:"center",gap:4,fontSize:9,color:"var(--txt3)"}}>
                          <span style={{color:"var(--green)"}}>ML</span>
                          <span className="mono">{ml.item_id}</span>
                          {ml.inventory_id && <span className="mono" style={{color:"var(--txt3)"}}>inv:{ml.inventory_id}</span>}
                          {(ml.available_quantity != null && ml.available_quantity > 0) && <span style={{color:"var(--blue)",fontWeight:600}}>Full:{ml.available_quantity}</span>}
                        </div>
                      ))}
                    </div>);
                  }) : <span style={{color:"var(--txt3)"}}>Sin publicación</span>}
                </td>
                <td><span className="tag">{p.cat}</span></td>
                <td><span className="tag">{p.prov}</span></td>
                <td className="mono" style={{textAlign:"right",fontSize:11}}>{fmtMoney(p.cost)}</td>
                <td className="mono" style={{textAlign:"right",fontWeight:700,color:"var(--blue)"}}>{stock}</td>
                <td style={{textAlign:"right",fontSize:11}}>
                  {ventas.length > 0 ? ventas.map((v, i) => {
                    const sellable = Math.floor(stock / v.unidades);
                    return (
                      <div key={i} style={{color:sellable>0?"var(--green)":"var(--red)",fontWeight:600}}>
                        {sellable}{v.unidades>1?` pack${sellable!==1?"s":""}`:""}</div>
                    );
                  }) : <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{stock}</span>}
                </td>
                <td style={{textAlign:"right"}}>
                  <button onClick={()=>startEdit(p)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)",marginRight:4}}>Editar</button>
                  <button onClick={()=>remove(p.sku)} style={{padding:"4px 10px",borderRadius:4,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
                </td>
              </tr>);
            })}</tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mobile-only">
        {prods.map(p=>{
          const ventas = getVentasPorSkuOrigen(p.sku);
          const stock = skuTotal(p.sku);
          return (
          <div key={p.sku} className="card" style={{marginTop:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <div className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</div>
                <div style={{fontSize:12,color:"var(--txt2)"}}>{p.name}</div>
                <div style={{display:"flex",gap:4,marginTop:3,flexWrap:"wrap"}}><span className="tag">{p.cat}</span><span className="tag">{p.prov}</span></div>
                <div style={{fontSize:10,color:"var(--txt3)",marginTop:3}}>Costo: {fmtMoney(p.cost)} | Stock: <strong style={{color:"var(--blue)"}}>{stock}</strong> uds</div>
                {ventas.length > 0 && (
                  <div style={{marginTop:4,borderTop:"1px solid var(--bg4)",paddingTop:4}}>
                    <div style={{fontSize:10,color:"var(--txt3)",fontWeight:600,marginBottom:2}}>Publicaciones:</div>
                    {ventas.map((v, i) => {
                      const sellable = Math.floor(stock / v.unidades);
                      const mlItems4sv = mlBySkuVenta[v.skuVenta.toUpperCase()] || [];
                      return (
                        <div key={i} style={{marginBottom:4}}>
                          <div style={{display:"flex",alignItems:"center",gap:4,fontSize:10}}>
                            <span style={{fontWeight:700,padding:"1px 4px",borderRadius:3,
                              background:v.unidades>1?"var(--amber)15":"var(--cyan)15",
                              color:v.unidades>1?"var(--amber)":"var(--cyan)"}}>
                              {v.unidades>1?`Pack x${v.unidades}`:"x1"}
                            </span>
                            <span className="mono">{v.codigoMl}</span>
                            <span style={{color:sellable>0?"var(--green)":"var(--red)",fontWeight:600,marginLeft:"auto"}}>
                              {sellable} vendibles
                            </span>
                          </div>
                          {mlItems4sv.length > 0 && mlItems4sv.map((ml, j) => (
                            <div key={j} style={{marginLeft:12,marginTop:1,display:"flex",alignItems:"center",gap:4,fontSize:9,color:"var(--txt3)"}}>
                              <span style={{color:"var(--green)"}}>ML</span>
                              <span className="mono">{ml.item_id}</span>
                              {ml.inventory_id && <span className="mono">inv:{ml.inventory_id}</span>}
                              {(ml.available_quantity != null && ml.available_quantity > 0) && <span style={{color:"var(--blue)",fontWeight:600}}>Full:{ml.available_quantity}</span>}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:4,marginLeft:8}}>
                <button onClick={()=>startEdit(p)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>Editar</button>
                <button onClick={()=>remove(p.sku)} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:10,fontWeight:600,border:"1px solid var(--bg4)"}}>X</button>
              </div>
            </div>
          </div>);
        })}
      </div>
    </div>
  );
}

export default Productos;
