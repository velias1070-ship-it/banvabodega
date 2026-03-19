"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, saveStore, fmtMoney, skuTotal, skuPositions, posContents, getMapConfig, recordMovement, recordBulkMovements, findProduct, reconciliarStock, aplicarReconciliacion, getUnassignedStock, assignPosition, IN_REASONS, OUT_REASONS, activePositions, getSkusVenta } from "@/lib/store";
import type { Product, Position, ComposicionVenta, InReason, OutReason } from "@/lib/store";

function Operaciones({ refresh }: { refresh: () => void }) {
  const [mode, setMode] = useState<"in"|"out"|"transfer"|"venta_ml">("in");
  const [sku, setSku] = useState("");
  const [skuResults, setSkuResults] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product|null>(null);
  const [pos, setPos] = useState("");
  const [posFrom, setPosFrom] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState<string>("compra");
  const [note, setNote] = useState("");
  const [toast, setToast] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Venta ML state
  const [mlSearch, setMlSearch] = useState("");
  const [mlResults, setMlResults] = useState<{skuVenta:string;codigoMl:string;componentes:ComposicionVenta[]}[]>([]);
  const [selectedVenta, setSelectedVenta] = useState<{skuVenta:string;codigoMl:string;componentes:ComposicionVenta[]}|null>(null);
  const [ventaQty, setVentaQty] = useState(1);

  const positions = activePositions();

  const searchSku = (q: string) => {
    setSku(q);
    setSelected(null);
    if (q.length >= 2) setSkuResults(findProduct(q));
    else setSkuResults([]);
  };

  const selectProduct = (p: Product) => {
    setSelected(p); setSku(p.sku); setSkuResults([]);
  };

  // ML search
  const searchML = (q: string) => {
    setMlSearch(q);
    setSelectedVenta(null);
    if (q.length < 2) { setMlResults([]); return; }
    const ql = q.toLowerCase();
    const all = getSkusVenta();
    const filtered = all.filter(v =>
      v.skuVenta.toLowerCase().includes(ql) ||
      v.codigoMl.toLowerCase().includes(ql) ||
      v.componentes.some(c => {
        const prod = getStore().products[c.skuOrigen];
        return prod?.name.toLowerCase().includes(ql);
      })
    );
    setMlResults(filtered.slice(0, 10));
  };

  const selectVenta = (v: typeof mlResults[0]) => {
    setSelectedVenta(v);
    setMlSearch(v.codigoMl || v.skuVenta);
    setMlResults([]);
    setVentaQty(1);
  };

  // Calculate available packs for selected venta
  const getDisponibleVenta = (v: typeof selectedVenta): number => {
    if (!v) return 0;
    let min = Infinity;
    for (const comp of v.componentes) {
      const stockTotal = skuTotal(comp.skuOrigen);
      const available = Math.floor(stockTotal / comp.unidades);
      if (available < min) min = available;
    }
    return min === Infinity ? 0 : min;
  };

  // Auto-pick best positions for a component SKU
  const pickPositions = (skuOrigen: string, needed: number): {pos:string;qty:number}[] => {
    const picks: {pos:string;qty:number}[] = [];
    const posiciones = skuPositions(skuOrigen).sort((a,b) => b.qty - a.qty);
    let remaining = needed;
    for (const sp of posiciones) {
      if (remaining <= 0) break;
      const take = Math.min(sp.qty, remaining);
      picks.push({ pos: sp.pos, qty: take });
      remaining -= take;
    }
    return picks;
  };

  const doConfirm = () => {
    if (!selected || !pos || qty < 1) return;

    if (mode === "transfer") {
      if (!posFrom || posFrom === pos) return;
      recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as OutReason, sku: selected.sku, pos: posFrom, qty, who: "Admin", note: "Transferencia → " + pos });
      recordMovement({ ts: new Date().toISOString(), type: "in", reason: "transferencia_in" as InReason, sku: selected.sku, pos, qty, who: "Admin", note: "Transferencia ← " + posFrom });
      setLog(l => [`${qty}× ${selected.sku} | ${posFrom} → ${pos}`, ...l].slice(0, 10));
      setToast(`Transferido ${qty}× ${selected.sku}`);
    } else {
      recordMovement({ ts: new Date().toISOString(), type: mode as "in"|"out", reason: reason as any, sku: selected.sku, pos, qty, who: "Admin", note });
      setLog(l => [`${mode === "in" ? "+" : "-"}${qty}× ${selected.sku} | Pos ${pos}`, ...l].slice(0, 10));
      setToast(`${mode === "in" ? "+" : "-"}${qty} ${selected.sku}`);
    }

    setSelected(null); setSku(""); setPos(""); setPosFrom(""); setQty(1); setNote("");
    refresh();
    setTimeout(() => setToast(""), 2000);
  };

  const doConfirmVentaML = () => {
    if (!selectedVenta || ventaQty < 1) return;
    const disponible = getDisponibleVenta(selectedVenta);
    if (ventaQty > disponible) return;

    let totalMoved = 0;
    const logLines: string[] = [];

    for (const comp of selectedVenta.componentes) {
      const needed = comp.unidades * ventaQty;
      const picks = pickPositions(comp.skuOrigen, needed);

      for (const pick of picks) {
        recordMovement({
          ts: new Date().toISOString(), type: "out", reason: "venta_flex" as OutReason,
          sku: comp.skuOrigen, pos: pick.pos, qty: pick.qty, who: "Admin",
          note: `Venta ML: ${selectedVenta.codigoMl || selectedVenta.skuVenta} ×${ventaQty}`,
        });
        totalMoved += pick.qty;
      }
      logLines.push(`-${needed}× ${comp.skuOrigen}`);
    }

    setLog(l => [`🛒 ${selectedVenta.codigoMl} ×${ventaQty}: ${logLines.join(", ")}`, ...l].slice(0, 10));
    setToast(`Venta ML: ${totalMoved} unidades descontadas`);
    setSelectedVenta(null); setMlSearch(""); setVentaQty(1);
    refresh();
    setTimeout(() => setToast(""), 3000);
  };

  useEffect(() => {
    if (mode === "in") setReason("compra");
    else if (mode === "out") setReason("envio_full");
  }, [mode]);

  const maxQty = mode === "out" && selected && pos ? (getStore().stock[selected.sku]?.[pos] || 0) : 9999;
  const transferMax = mode === "transfer" && selected && posFrom ? (getStore().stock[selected.sku]?.[posFrom] || 0) : 9999;
  const ventaDisponible = getDisponibleVenta(selectedVenta);

  return (
    <div>
      {toast && <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:"2px solid var(--green)",color:"var(--green)",padding:"10px 24px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}

      <div className="admin-grid-2">
        <div className="card">
          {/* Mode */}
          <div style={{display:"flex",gap:4,marginBottom:14,flexWrap:"wrap"}}>
            <button onClick={()=>setMode("in")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="in"?"var(--greenBg)":"var(--bg3)",color:mode==="in"?"var(--green)":"var(--txt3)",border:mode==="in"?"2px solid var(--green)":"1px solid var(--bg4)"}}>Entrada</button>
            <button onClick={()=>setMode("out")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="out"?"var(--redBg)":"var(--bg3)",color:mode==="out"?"var(--red)":"var(--txt3)",border:mode==="out"?"2px solid var(--red)":"1px solid var(--bg4)"}}>Salida</button>
            <button onClick={()=>setMode("transfer")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="transfer"?"var(--cyanBg)":"var(--bg3)",color:mode==="transfer"?"var(--cyan)":"var(--txt3)",border:mode==="transfer"?"2px solid var(--cyan)":"1px solid var(--bg4)"}}>Transferir</button>
            <button onClick={()=>setMode("venta_ml")} style={{flex:1,padding:"10px 6px",borderRadius:8,fontWeight:700,fontSize:12,background:mode==="venta_ml"?"var(--amberBg)":"var(--bg3)",color:mode==="venta_ml"?"var(--amber)":"var(--txt3)",border:mode==="venta_ml"?"2px solid var(--amber)":"1px solid var(--bg4)"}}>🛒 Venta ML</button>
          </div>

          {mode === "venta_ml" ? (
            /* ===== VENTA ML MODE ===== */
            <>
              <div style={{fontSize:11,color:"var(--txt3)",marginBottom:8}}>Busca por código ML, SKU Venta o nombre del producto</div>
              <div style={{position:"relative",marginBottom:10}}>
                <input className="form-input mono" value={mlSearch} onChange={e=>searchML(e.target.value.toUpperCase())} placeholder="MLC123456, SKU-PACK-001, almohada..." style={{fontSize:13}}/>
                {mlResults.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:"0 0 8px 8px",maxHeight:220,overflow:"auto",boxShadow:"0 6px 16px rgba(0,0,0,0.4)"}}>
                    {mlResults.map(v=>{
                      const disp = getDisponibleVenta(v);
                      const names = v.componentes.map(c=>getStore().products[c.skuOrigen]?.name||c.skuOrigen).join(" + ");
                      return(
                        <div key={v.skuVenta} onClick={()=>selectVenta(v)} style={{padding:"8px 12px",cursor:"pointer",borderBottom:"1px solid var(--bg3)"}}
                          onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                            <div>
                              <span className="mono" style={{fontWeight:700,fontSize:12,color:"var(--amber)"}}>{v.codigoMl}</span>
                              <span className="mono" style={{fontSize:10,color:"var(--txt3)",marginLeft:8}}>{v.skuVenta}</span>
                            </div>
                            <span className="mono" style={{fontSize:12,color:disp>0?"var(--green)":"var(--red)",fontWeight:700}}>{disp} disp.</span>
                          </div>
                          <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>{names}</div>
                          {v.componentes.length > 1 && <div style={{fontSize:9,color:"var(--cyan)",marginTop:1}}>Pack de {v.componentes.length} componentes</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedVenta && (
                <>
                  {/* Selected publication card */}
                  <div style={{padding:"10px 12px",background:"var(--bg3)",borderRadius:8,marginBottom:12,border:"1px solid var(--amber)33"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <span className="mono" style={{fontWeight:800,fontSize:14,color:"var(--amber)"}}>{selectedVenta.codigoMl}</span>
                        <span className="mono" style={{fontSize:11,color:"var(--txt3)",marginLeft:8}}>{selectedVenta.skuVenta}</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div className="mono" style={{fontSize:18,fontWeight:800,color:ventaDisponible>0?"var(--green)":"var(--red)"}}>{ventaDisponible}</div>
                        <div style={{fontSize:9,color:"var(--txt3)"}}>disponibles</div>
                      </div>
                    </div>

                    {/* Components breakdown */}
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt3)",marginBottom:4}}>Componentes del pack:</div>
                    {selectedVenta.componentes.map(comp=>{
                      const prod = getStore().products[comp.skuOrigen];
                      const stockOrigen = skuTotal(comp.skuOrigen);
                      const posiciones = skuPositions(comp.skuOrigen);
                      return(
                        <div key={comp.skuOrigen} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 0",borderBottom:"1px solid var(--bg4)"}}>
                          <div style={{flex:1}}>
                            <span className="mono" style={{fontWeight:700,fontSize:12}}>{comp.skuOrigen}</span>
                            <span style={{fontSize:10,color:"var(--txt3)",marginLeft:6}}>{prod?.name}</span>
                            <div style={{fontSize:9,color:"var(--txt3)",marginTop:1}}>
                              ×{comp.unidades} por pack · Stock: {stockOrigen} · En: {posiciones.map(p=>`${p.pos}(${p.qty})`).join(", ")}
                            </div>
                          </div>
                          <div className="mono" style={{fontSize:13,fontWeight:700,color:stockOrigen>=comp.unidades*ventaQty?"var(--green)":"var(--red)"}}>
                            -{comp.unidades * ventaQty}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Qty selector */}
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
                    <span style={{fontSize:12,color:"var(--txt3)",minWidth:90}}>Packs a vender:</span>
                    <button onClick={()=>setVentaQty(Math.max(1,ventaQty-1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>−</button>
                    <input type="number" className="form-input mono" value={ventaQty} onFocus={e=>e.target.select()} onChange={e=>setVentaQty(Math.max(1,Math.min(ventaDisponible,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
                    <button onClick={()=>setVentaQty(Math.min(ventaDisponible,ventaQty+1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>+</button>
                    <div className="qty-presets" style={{flex:1}}>{[1,2,5,10].map(n=><button key={n} className={ventaQty===n?"sel":""} onClick={()=>setVentaQty(Math.min(ventaDisponible,n))} style={{fontSize:10,padding:"4px 8px"}}>{n}</button>)}</div>
                  </div>

                  <button onClick={doConfirmVentaML}
                    disabled={ventaQty < 1 || ventaQty > ventaDisponible}
                    style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#000",
                      background:"linear-gradient(135deg,#f59e0b,#eab308)",
                      opacity:(ventaQty<1||ventaQty>ventaDisponible)?0.4:1}}>
                    🛒 CONFIRMAR VENTA — {selectedVenta.componentes.reduce((s,c)=>s+c.unidades*ventaQty,0)} unidades
                  </button>
                </>
              )}
            </>
          ) : (
            /* ===== NORMAL MODES (in/out/transfer) ===== */
            <>
              {/* SKU search */}
              <div style={{position:"relative",marginBottom:10}}>
                <input className="form-input mono" value={sku} onChange={e=>searchSku(e.target.value.toUpperCase())} placeholder="SKU, nombre o código ML..." style={{fontSize:13}}/>
                {skuResults.length > 0 && (
                  <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:"0 0 8px 8px",maxHeight:180,overflow:"auto",boxShadow:"0 6px 16px rgba(0,0,0,0.4)"}}>
                    {skuResults.slice(0,8).map(p=>(
                      <div key={p.sku} onClick={()=>selectProduct(p)} style={{padding:"8px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",borderBottom:"1px solid var(--bg3)"}}
                        onMouseEnter={e=>e.currentTarget.style.background="var(--bg3)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <div><span className="mono" style={{fontWeight:600,fontSize:12}}>{p.sku}</span> <span style={{fontSize:11,color:"var(--txt3)"}}>{p.name}</span></div>
                        <span className="mono" style={{fontSize:11,color:"var(--blue)"}}>{skuTotal(p.sku)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {selected && <div style={{padding:"6px 10px",background:"var(--bg3)",borderRadius:6,marginBottom:10,fontSize:12}}><span className="mono" style={{fontWeight:700}}>{selected.sku}</span> — {selected.name} <span className="mono" style={{color:"var(--blue)",marginLeft:8}}>Stock: {skuTotal(selected.sku)}</span></div>}

              {/* Position(s) */}
              {mode === "transfer" ? (
                <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:8,marginBottom:10,alignItems:"center"}}>
                  <select className="form-select" value={posFrom} onChange={e=>setPosFrom(e.target.value)} style={{fontSize:12}}>
                    <option value="">Origen...</option>
                    {selected ? skuPositions(selected.sku).map(sp=><option key={sp.pos} value={sp.pos}>{sp.pos} ({sp.qty} uds)</option>) : positions.map(p=><option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                  <span style={{color:"var(--cyan)",fontWeight:700,fontSize:16}}>→</span>
                  <select className="form-select" value={pos} onChange={e=>setPos(e.target.value)} style={{fontSize:12}}>
                    <option value="">Destino...</option>
                    {positions.filter(p=>p.id!==posFrom).map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                  </select>
                </div>
              ) : (
                <select className="form-select" value={pos} onChange={e=>setPos(e.target.value)} style={{fontSize:12,marginBottom:10}}>
                  <option value="">Seleccionar posición...</option>
                  {mode === "out" && selected
                    ? skuPositions(selected.sku).map(sp=><option key={sp.pos} value={sp.pos}>{sp.pos} — {sp.label} ({sp.qty} uds)</option>)
                    : positions.map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)
                  }
                </select>
              )}

              {/* Qty */}
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:12,color:"var(--txt3)",minWidth:50}}>Cantidad:</span>
                <button onClick={()=>setQty(Math.max(1,qty-1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>−</button>
                <input type="number" className="form-input mono" value={qty} onFocus={e=>e.target.select()} onChange={e=>setQty(Math.max(1,Math.min(mode==="transfer"?transferMax:maxQty,parseInt(e.target.value)||1)))} style={{width:80,textAlign:"center",fontSize:18,fontWeight:700,padding:6}}/>
                <button onClick={()=>setQty(Math.min(mode==="transfer"?transferMax:maxQty,qty+1))} style={{width:36,height:36,borderRadius:"50%",background:"var(--bg3)",color:"var(--txt)",fontSize:18,border:"1px solid var(--bg4)"}}>+</button>
                <div className="qty-presets" style={{flex:1}}>{[5,10,20,50].map(n=><button key={n} className={qty===n?"sel":""} onClick={()=>setQty(n)} style={{fontSize:10,padding:"4px 8px"}}>{n}</button>)}</div>
              </div>

              {/* Reason (not for transfer) */}
              {mode !== "transfer" && (
                <select className="form-select" value={reason} onChange={e=>setReason(e.target.value)} style={{fontSize:12,marginBottom:10}}>
                  {(mode==="in"?Object.entries(IN_REASONS):Object.entries(OUT_REASONS)).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                </select>
              )}

              <input className="form-input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Nota / referencia (opcional)" style={{fontSize:12,marginBottom:12}}/>

              <button onClick={doConfirm}
                disabled={!selected || !pos || qty < 1 || (mode==="transfer" && (!posFrom || posFrom===pos))}
                style={{width:"100%",padding:14,borderRadius:10,fontWeight:700,fontSize:14,color:"#fff",
                  background:mode==="in"?"linear-gradient(135deg,#059669,var(--green))":mode==="out"?"linear-gradient(135deg,#dc2626,var(--red))":"linear-gradient(135deg,#0891b2,var(--cyan))",
                  opacity:(!selected||!pos||qty<1||(mode==="transfer"&&(!posFrom||posFrom===pos)))?0.4:1}}>
                {mode==="in"?"CONFIRMAR ENTRADA":mode==="out"?"CONFIRMAR SALIDA":"CONFIRMAR TRANSFERENCIA"}
              </button>
            </>
          )}
        </div>

        {/* Mini map + position detail */}
        <div>
          {log.length > 0 && (
            <div className="card" style={{marginBottom:8}}>
              <div className="card-title" style={{fontSize:11}}>Registro sesión</div>
              {log.slice(0,5).map((l,i)=><div key={i} style={{padding:"4px 0",borderBottom:"1px solid var(--bg3)",fontSize:11,color:i===0?"var(--txt)":"var(--txt3)",fontFamily:"'JetBrains Mono',monospace"}}>{l}</div>)}
            </div>
          )}
          <MiniMapPanel
            positions={positions}
            onSelectProduct={(p,posId)=>{setMode("out");setSelected(p);setSku(p.sku);setPos(posId);setSkuResults([]);}}
            onSetMode={setMode}
            refresh={refresh}
          />
        </div>
      </div>
    </div>
  );
}

// ==================== MINI MAP PANEL ====================
function MiniMapPanel({ positions, onSelectProduct, onSetMode, refresh }: {
  positions: ReturnType<typeof activePositions>;
  onSelectProduct: (p: Product, posId: string) => void;
  onSetMode: (m: "in"|"out"|"transfer") => void;
  refresh: () => void;
}) {
  const [selectedPos, setSelectedPos] = useState<string|null>(null);
  const [checkedSkus, setCheckedSkus] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<""|"out"|"transfer">("");
  const [bulkQtyMap, setBulkQtyMap] = useState<Record<string,number>>({});
  const [transferDest, setTransferDest] = useState("");
  const [toast, setToast] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(22);
  const cfg = getMapConfig();

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        setCellSize(Math.max(14, Math.floor((w - 8) / cfg.gridW)));
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [cfg.gridW]);

  const mapW = cfg.gridW * cellSize;
  const mapH = cfg.gridH * cellSize;
  const selItems = selectedPos ? posContents(selectedPos) : [];
  const selTotalQty = selItems.reduce((s,i) => s + i.qty, 0);

  const toggleCheck = (sku: string) => {
    const next = new Set(checkedSkus);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setCheckedSkus(next);
  };
  const toggleAll = () => {
    if (checkedSkus.size === selItems.length) setCheckedSkus(new Set());
    else setCheckedSkus(new Set(selItems.map(i=>i.sku)));
  };

  const initBulkQty = (items: typeof selItems) => {
    const m: Record<string,number> = {};
    items.forEach(i => { m[i.sku] = i.qty; });
    setBulkQtyMap(m);
  };

  const executeBulk = () => {
    if (!selectedPos || checkedSkus.size === 0) return;
    const items = selItems.filter(i => checkedSkus.has(i.sku));
    let count = 0;
    items.forEach(item => {
      const qty = bulkQtyMap[item.sku] || 0;
      if (qty <= 0) return;
      if (bulkAction === "out") {
        recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as any, sku: item.sku, pos: selectedPos, qty, who: "Admin", note: "Salida rápida desde mapa" });
        count += qty;
      } else if (bulkAction === "transfer" && transferDest && transferDest !== selectedPos) {
        recordMovement({ ts: new Date().toISOString(), type: "out", reason: "ajuste_salida" as any, sku: item.sku, pos: selectedPos, qty, who: "Admin", note: "Transferencia → " + transferDest });
        recordMovement({ ts: new Date().toISOString(), type: "in", reason: "transferencia_in" as any, sku: item.sku, pos: transferDest, qty, who: "Admin", note: "Transferencia ← " + selectedPos });
        count += qty;
      }
    });
    if (count > 0) {
      setToast(`${bulkAction === "out" ? "Sacadas" : "Movidas"} ${count} uds`);
      setTimeout(() => setToast(""), 2000);
      setCheckedSkus(new Set());
      setBulkAction("");
      setBulkQtyMap({});
      setTransferDest("");
      refresh();
    }
  };

  return (
    <>
      {toast && <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",border:"2px solid var(--green)",color:"var(--green)",padding:"10px 24px",borderRadius:10,fontSize:14,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>{toast}</div>}

      <div className="card" style={{padding:8}}>
        <div className="card-title" style={{fontSize:11,marginBottom:6}}>🗺️ Mapa de bodega</div>
        <div ref={containerRef} style={{width:"100%",height:mapH,position:"relative",background:"var(--bg2)",border:"1px solid var(--bg4)",borderRadius:6,overflow:"hidden"}}>
          {/* Grid lines */}
          <svg width={mapW} height={mapH} style={{position:"absolute",top:0,left:0,pointerEvents:"none",opacity:0.06}}>
            {Array.from({length:cfg.gridW+1}).map((_,i)=><line key={"v"+i} x1={i*cellSize} y1={0} x2={i*cellSize} y2={mapH} stroke="var(--txt3)" strokeWidth={1}/>)}
            {Array.from({length:cfg.gridH+1}).map((_,i)=><line key={"h"+i} x1={0} y1={i*cellSize} x2={mapW} y2={i*cellSize} stroke="var(--txt3)" strokeWidth={1}/>)}
          </svg>

          {/* Static objects */}
          {cfg.objects.map(o=>(
            <div key={o.id} style={{position:"absolute",left:o.mx*cellSize,top:o.my*cellSize,width:o.mw*cellSize,height:o.mh*cellSize,background:(o.color||"#64748b")+"18",border:`1px dashed ${o.color||"#64748b"}44`,borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:1}}>
              <div style={{fontSize:Math.max(7,cellSize*0.3),color:(o.color||"#64748b")+"88",fontWeight:600,textAlign:"center",overflow:"hidden"}}>{o.label}</div>
            </div>
          ))}

          {/* Position blocks */}
          {positions.filter(p=>p.active && p.mx !== undefined).map(p=>{
            const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
            const color=p.color||"#10b981";
            const isSel=selectedPos===p.id;
            const items=posContents(p.id);
            const tq=items.reduce((s,i)=>s+i.qty,0);
            const isEmpty=tq===0;
            return(
              <div key={p.id} onClick={(e)=>{e.stopPropagation();setSelectedPos(isSel?null:p.id);setCheckedSkus(new Set());setBulkAction("");}}
                style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                  background:isSel?color+"44":isEmpty?color+"08":color+"1a",
                  border:`2px solid ${isSel?"#fff":isEmpty?color+"33":color}`,borderRadius:4,
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  cursor:"pointer",zIndex:isSel?20:10,
                  boxShadow:isSel?`0 0 0 2px ${color}, 0 0 12px ${color}44`:"none",
                  transition:"all .15s",userSelect:"none"}}>
                <div className="mono" style={{fontSize:Math.max(9,Math.min(14,cellSize*0.5)),fontWeight:800,color:isEmpty?color+"66":color,lineHeight:1}}>{p.id}</div>
                {tq>0 && mh*cellSize>28 && <div className="mono" style={{fontSize:Math.max(7,cellSize*0.28),color:"var(--blue)",fontWeight:600,marginTop:1}}>{tq}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Position detail panel */}
      {selectedPos && (
        <div className="card" style={{marginTop:8,padding:0,overflow:"hidden",border:"1px solid var(--cyan)33"}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",background:"var(--bg3)",borderBottom:"1px solid var(--bg4)"}}>
            <div>
              <span className="mono" style={{fontWeight:800,fontSize:16,color:"var(--cyan)"}}>{selectedPos}</span>
              <span style={{fontSize:12,color:"var(--txt3)",marginLeft:8}}>{selTotalQty} uds · {selItems.length} SKUs</span>
            </div>
            <button onClick={()=>setSelectedPos(null)} style={{background:"none",color:"var(--txt3)",fontSize:18,padding:"0 4px",border:"none",cursor:"pointer"}}>✕</button>
          </div>

          {selItems.length === 0 ? (
            <div style={{padding:20,textAlign:"center",color:"var(--txt3)",fontSize:13}}>Posición vacía</div>
          ) : (
            <>
              {/* Select all + actions bar */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--bg2)",borderBottom:"1px solid var(--bg4)"}}>
                <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:11,color:"var(--txt3)"}}>
                  <input type="checkbox" checked={checkedSkus.size===selItems.length && selItems.length>0} onChange={toggleAll} style={{accentColor:"var(--cyan)"}}/>
                  {checkedSkus.size>0 ? `${checkedSkus.size} seleccionados` : "Seleccionar todo"}
                </label>
                {checkedSkus.size > 0 && !bulkAction && (
                  <div style={{display:"flex",gap:4}}>
                    <button onClick={()=>{setBulkAction("out");initBulkQty(selItems.filter(i=>checkedSkus.has(i.sku)));}} style={{padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:600,background:"var(--redBg)",color:"var(--red)",border:"1px solid var(--red)"}}>🔻 Sacar</button>
                    <button onClick={()=>{setBulkAction("transfer");initBulkQty(selItems.filter(i=>checkedSkus.has(i.sku)));}} style={{padding:"5px 10px",borderRadius:6,fontSize:11,fontWeight:600,background:"var(--cyanBg)",color:"var(--cyan)",border:"1px solid var(--cyan)"}}>↗️ Mover</button>
                  </div>
                )}
              </div>

              {/* Bulk action panel */}
              {bulkAction && (
                <div style={{padding:"10px 12px",background:bulkAction==="out"?"var(--redBg)":"var(--cyanBg)",borderBottom:"1px solid var(--bg4)"}}>
                  <div style={{fontSize:12,fontWeight:700,color:bulkAction==="out"?"var(--red)":"var(--cyan)",marginBottom:8}}>
                    {bulkAction==="out"?"🔻 Sacar stock":"↗️ Mover a otra posición"}
                  </div>
                  {bulkAction==="transfer" && (
                    <select className="form-select" value={transferDest} onChange={e=>setTransferDest(e.target.value)} style={{fontSize:12,marginBottom:8,width:"100%"}}>
                      <option value="">Destino...</option>
                      {positions.filter(p=>p.id!==selectedPos).map(p=><option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
                    </select>
                  )}
                  {/* Per-SKU qty adjustment */}
                  {selItems.filter(i=>checkedSkus.has(i.sku)).map(item=>(
                    <div key={item.sku} style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,fontSize:11}}>
                      <span className="mono" style={{flex:1,fontWeight:600}}>{item.sku}</span>
                      <button onClick={()=>setBulkQtyMap(m=>({...m,[item.sku]:Math.max(0,(m[item.sku]||0)-1)}))} style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)",fontSize:14}}>−</button>
                      <input type="number" className="form-input mono" value={bulkQtyMap[item.sku]||0} onFocus={e=>e.target.select()} onChange={e=>setBulkQtyMap(m=>({...m,[item.sku]:Math.max(0,Math.min(item.qty,parseInt(e.target.value)||0))}))} style={{width:50,textAlign:"center",fontSize:12,padding:4}}/>
                      <button onClick={()=>setBulkQtyMap(m=>({...m,[item.sku]:Math.min(item.qty,(m[item.sku]||0)+1)}))} style={{width:24,height:24,borderRadius:4,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)",fontSize:14}}>+</button>
                      <span style={{color:"var(--txt3)",fontSize:10,minWidth:28}}>/ {item.qty}</span>
                    </div>
                  ))}
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    <button onClick={()=>{setBulkAction("");setBulkQtyMap({});setTransferDest("");}} style={{flex:1,padding:8,borderRadius:6,fontSize:11,fontWeight:600,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)"}}>Cancelar</button>
                    <button onClick={executeBulk} disabled={bulkAction==="transfer"&&!transferDest}
                      style={{flex:1,padding:8,borderRadius:6,fontSize:11,fontWeight:700,color:"#fff",
                        background:bulkAction==="out"?"linear-gradient(135deg,#dc2626,var(--red))":"linear-gradient(135deg,#0891b2,var(--cyan))",
                        opacity:(bulkAction==="transfer"&&!transferDest)?0.4:1}}>
                      {bulkAction==="out"?"Confirmar salida":"Confirmar movimiento"}
                    </button>
                  </div>
                </div>
              )}

              {/* Stock list */}
              <div style={{maxHeight:280,overflow:"auto"}}>
                {selItems.map(item=>{
                  const product = findProduct(item.sku)[0];
                  return(
                    <div key={item.sku} onClick={()=>toggleCheck(item.sku)}
                      style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderBottom:"1px solid var(--bg3)",cursor:"pointer",
                        background:checkedSkus.has(item.sku)?"var(--bg3)":"transparent",transition:"background .1s"}}>
                      <input type="checkbox" checked={checkedSkus.has(item.sku)} onChange={()=>toggleCheck(item.sku)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--cyan)",flexShrink:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div className="mono" style={{fontWeight:700,fontSize:12}}>{item.sku}</div>
                        <div style={{fontSize:10,color:"var(--txt3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div className="mono" style={{fontWeight:700,fontSize:14,color:"var(--blue)"}}>{item.qty}</div>
                        {product?.cost ? <div style={{fontSize:9,color:"var(--txt3)"}}>{fmtMoney(product.cost * item.qty)}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ==================== DASHBOARD ====================

export default Operaciones;
