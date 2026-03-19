"use client";
import React from "react";
import { getStore, skuTotal, activePositions, posContents, fmtDate, fmtTime, fmtMoney, IN_REASONS, OUT_REASONS } from "@/lib/store";

export default function Dashboard() {
  const s = getStore();
  const skusWithStock = Object.keys(s.stock).filter(sku => skuTotal(sku) > 0);
  const totalUnits = skusWithStock.reduce((sum, sku) => sum + skuTotal(sku), 0);
  const totalValue = skusWithStock.reduce((sum, sku) => { const p = s.products[sku]; return sum + (p ? p.cost * skuTotal(sku) : 0); }, 0);
  const usedPos = activePositions().filter(p => posContents(p.id).length > 0).length;
  const totalPos = activePositions().length;
  const today = fmtDate(new Date().toISOString());
  const todayMovs = s.movements.filter(m => fmtDate(m.ts) === today);
  const todayIn = todayMovs.filter(m=>m.type==="in").reduce((s,m)=>s+m.qty,0);
  const todayOut = todayMovs.filter(m=>m.type==="out").reduce((s,m)=>s+m.qty,0);

  // Movements by reason
  const reasonCounts: Record<string,number> = {};
  s.movements.slice(0,100).forEach(m => { reasonCounts[m.reason] = (reasonCounts[m.reason]||0) + m.qty; });

  return (
    <div>
      <div className="admin-kpi-grid">
        <div className="kpi"><div className="kpi-label">SKUs en bodega</div><div className="kpi-val">{skusWithStock.length}</div><div className="kpi-sub">de {Object.keys(s.products).length} registrados</div></div>
        <div className="kpi"><div className="kpi-label">Unidades totales</div><div className="kpi-val blue">{totalUnits.toLocaleString("es-CL")}</div></div>
        <div className="kpi"><div className="kpi-label">Valor inventario</div><div className="kpi-val green">{fmtMoney(totalValue)}</div><div className="kpi-sub">a costo</div></div>
        <div className="kpi"><div className="kpi-label">Posiciones</div><div className="kpi-val">{usedPos}<span style={{fontSize:14,color:"var(--txt3)"}}> / {totalPos}</span></div><div className="kpi-sub">{totalPos-usedPos} libres</div></div>
        <div className="kpi"><div className="kpi-label">Movimientos hoy</div><div className="kpi-val cyan">{todayMovs.length}</div></div>
        <div className="kpi"><div className="kpi-label">Flujo hoy</div><div className="kpi-val"><span style={{color:"var(--green)"}}>+{todayIn}</span> <span style={{color:"var(--red)"}}>-{todayOut}</span></div></div>
      </div>

      <div className="admin-grid-2">
        <div className="card">
          <div className="card-title">Ultimos movimientos</div>
          {s.movements.slice(0,12).map(m => {
            const prod = s.products[m.sku];
            return (
              <div key={m.id} className="mov-row">
                <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}>
                  <span className="mov-badge" style={{background:m.type==="in"?"var(--greenBg)":"var(--redBg)",color:m.type==="in"?"var(--green)":"var(--red)"}}>
                    {m.type==="in"?"ENTRADA":"SALIDA"}
                  </span>
                  <span className="mono" style={{fontSize:10,color:"var(--txt3)"}}>{m.id}</span>
                  <span style={{fontSize:10,color:"var(--txt3)"}}>{fmtDate(m.ts)} {fmtTime(m.ts)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:12}}>{m.sku}</span>
                    <span style={{fontSize:11,color:"var(--txt3)",marginLeft:6}}>{prod?.name}</span>
                    <span style={{fontSize:10,color:"var(--txt3)",marginLeft:6}}>Pos {m.pos}</span>
                  </div>
                  <span className="mono" style={{fontWeight:700,fontSize:14,color:m.type==="in"?"var(--green)":"var(--red)"}}>{m.type==="in"?"+":"-"}{m.qty}</span>
                </div>
                {m.note && <div style={{fontSize:10,color:"var(--cyan)",marginTop:1}}>{m.note}</div>}
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-title">Resumen por motivo (ultimos 100 mov.)</div>
          {Object.entries(reasonCounts).sort((a,b)=>b[1]-a[1]).map(([reason,qty])=>(
            <div key={reason} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
              <span style={{color:"var(--txt2)"}}>{(IN_REASONS as any)[reason]||(OUT_REASONS as any)[reason]||reason}</span>
              <span className="mono" style={{fontWeight:700}}>{qty} uds</span>
            </div>
          ))}
          <div style={{marginTop:16}}>
            <div className="card-title">Top SKUs por volumen</div>
            {skusWithStock.sort((a,b)=>skuTotal(b)-skuTotal(a)).slice(0,8).map(sku=>{
              const prod=s.products[sku];
              return(
                <div key={sku} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bg3)",fontSize:12}}>
                  <div><span className="mono" style={{fontWeight:600}}>{sku}</span> <span style={{color:"var(--txt3)",fontSize:11}}>{prod?.name}</span></div>
                  <span className="mono" style={{fontWeight:700,color:"var(--blue)"}}>{skuTotal(sku)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
