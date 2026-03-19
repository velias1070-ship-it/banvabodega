"use client";
import React, { useState } from "react";
import { getStore, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS, updateMovementNote } from "@/lib/store";
import type { Movement } from "@/lib/store";

// ==================== MOVIMIENTOS ====================
function Movimientos() {
  const [filterType, setFilterType] = useState<"all"|"in"|"out">("all");
  const [filterSku, setFilterSku] = useState("");
  const [filterDate, setFilterDate] = useState("");
  const [filterReason, setFilterReason] = useState("");
  const [editNoteId, setEditNoteId] = useState<string|null>(null);
  const [editNoteVal, setEditNoteVal] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [,setTick] = useState(0);
  const s = getStore();

  let movs = [...s.movements];
  if (filterType !== "all") movs = movs.filter(m => m.type === filterType);
  if (filterSku) { const q = filterSku.toLowerCase(); movs = movs.filter(m => m.sku.toLowerCase().includes(q) || s.products[m.sku]?.name.toLowerCase().includes(q)); }
  if (filterDate) movs = movs.filter(m => m.ts.startsWith(filterDate));
  if (filterReason) movs = movs.filter(m => m.reason === filterReason);

  const totalIn = movs.filter(m=>m.type==="in").reduce((s,m)=>s+m.qty,0);
  const totalOut = movs.filter(m=>m.type==="out").reduce((s,m)=>s+m.qty,0);

  const allReasons = [...Object.keys(IN_REASONS), ...Object.keys(OUT_REASONS)];

  const openEditNote = (m: Movement) => { setEditNoteId(m.id); setEditNoteVal(m.note || ""); };
  const saveNote = async () => {
    if (!editNoteId) return;
    setSavingNote(true);
    await updateMovementNote(editNoteId, editNoteVal);
    setSavingNote(false);
    setEditNoteId(null);
    setTick(t => t + 1);
  };

  return (
    <div>
      {/* Modal editar nota */}
      {editNoteId && (() => {
        const m = movs.find(x => x.id === editNoteId);
        return (
          <div style={{position:"fixed",inset:0,zIndex:300,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}
            onClick={() => !savingNote && setEditNoteId(null)}>
            <div style={{width:"100%",maxWidth:440,background:"var(--bg2)",borderRadius:14,border:"1px solid var(--bg4)",padding:24}}
              onClick={e => e.stopPropagation()}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:8}}>Editar nota</div>
              {m && (
                <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>
                  <span className="mono" style={{fontWeight:700}}>{m.sku}</span> — {m.type === "in" ? "Entrada" : "Salida"} {m.qty} uds — {fmtDate(m.ts)} {fmtTime(m.ts)}
                </div>
              )}
              <textarea className="form-input" value={editNoteVal} onChange={e => setEditNoteVal(e.target.value)}
                placeholder="Escribe una nota..." rows={3} autoFocus
                style={{width:"100%",marginBottom:12,resize:"vertical",fontSize:13}} />
              <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                <button onClick={() => setEditNoteId(null)} disabled={savingNote}
                  style={{padding:"8px 16px",borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
                  Cancelar
                </button>
                <button onClick={saveNote} disabled={savingNote}
                  style={{padding:"8px 16px",borderRadius:6,background:savingNote?"var(--bg3)":"var(--green)",color:savingNote?"var(--txt3)":"#fff",fontSize:12,fontWeight:700}}>
                  {savingNote ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,fontSize:12}}>
          <span style={{color:"var(--txt3)"}}>{movs.length} movimientos</span>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <span><span style={{color:"var(--green)",fontWeight:600}}>+{totalIn.toLocaleString("es-CL")}</span> / <span style={{color:"var(--red)",fontWeight:600}}>-{totalOut.toLocaleString("es-CL")}</span></span>
            <button onClick={() => {
              const header = "ID,Fecha,Hora,Tipo,Motivo,SKU,Producto,Posición,Operador,Nota,Cantidad";
              const rows = movs.map(m => {
                const prod = s.products[m.sku];
                const reason = (IN_REASONS as any)[m.reason] || (OUT_REASONS as any)[m.reason] || m.reason;
                const escapeCsv = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? '"' + v.replace(/"/g, '""') + '"' : v;
                return [
                  m.id, fmtDate(m.ts), fmtTime(m.ts),
                  m.type === "in" ? "ENTRADA" : "SALIDA",
                  escapeCsv(reason), m.sku, escapeCsv(prod?.name || ""),
                  m.pos, escapeCsv(m.who || ""), escapeCsv(m.note || ""),
                  (m.type === "in" ? "" : "-") + m.qty
                ].join(",");
              });
              const csv = "\uFEFF" + header + "\n" + rows.join("\n");
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `movimientos_${filterDate || new Date().toISOString().slice(0,10)}.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }} style={{padding:"4px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer"}}>
              Exportar CSV
            </button>
          </div>
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
                  <td onClick={() => openEditNote(m)} style={{fontSize:10,color:m.note?"var(--cyan)":"var(--txt3)",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",cursor:"pointer"}} title="Click para editar nota">{m.note || "—"}</td>
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
                  <div onClick={() => openEditNote(m)} style={{fontSize:10,color:m.note?"var(--cyan)":"var(--txt3)",marginTop:1,cursor:"pointer"}}>{m.note || "Agregar nota..."}</div>
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

export default Movimientos;
