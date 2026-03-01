"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import { initStore, refreshStore, isSupabaseConfigured, activePositions, posContents, getMapConfig, getStore, findProduct } from "@/lib/store";
import { fetchActiveConteos, updateConteo } from "@/lib/db";
import type { DBConteo, ConteoLinea } from "@/lib/db";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

export default function ConteosPage() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conteos, setConteos] = useState<DBConteo[]>([]);
  const [activeConteo, setActiveConteo] = useState<DBConteo | null>(null);
  const [screen, setScreen] = useState<"list" | "conteo" | "count">("list");
  const [operario, setOperario] = useState("");
  const [currentPosIdx, setCurrentPosIdx] = useState(0);

  useEffect(() => {
    setMounted(true);
    initStore().then(() => setLoading(false));
    if (typeof window !== "undefined") setOperario(localStorage.getItem("banva_operario") || "");
  }, []);

  const loadConteos = useCallback(async () => {
    const data = await fetchActiveConteos();
    setConteos(data);
  }, []);

  useEffect(() => { if (!loading) loadConteos(); }, [loading, loadConteos]);

  useEffect(() => {
    if (!isSupabaseConfigured() || loading) return;
    const iv = setInterval(() => refreshStore(), 15_000);
    return () => clearInterval(iv);
  }, [loading]);

  const saveOperario = (name: string) => {
    setOperario(name);
    if (typeof window !== "undefined") localStorage.setItem("banva_operario", name);
  };

  if (!mounted || loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Conteos</div>
        <div style={{color:"#94a3b8"}}>Conectando...</div>
      </div>
    </div>
  );

  if (!operario) return (
    <div className="app">
      <div className="topbar">
        <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        <h1>Conteo Cíclico</h1><div/>
      </div>
      <div style={{textAlign:"center",padding:40}}>
        <div style={{fontSize:32,marginBottom:12}}>👷</div>
        <div style={{fontSize:18,fontWeight:700,marginBottom:16}}>¿Quién eres?</div>
        <input className="form-input" placeholder="Tu nombre" autoFocus
          onKeyDown={e=>{if(e.key==="Enter"&&(e.target as HTMLInputElement).value.trim())saveOperario((e.target as HTMLInputElement).value.trim());}}
          style={{fontSize:18,textAlign:"center",padding:14,width:"100%",maxWidth:300,margin:"0 auto"}}/>
        <div style={{fontSize:12,color:"#94a3b8",marginTop:8}}>Escribe tu nombre y presiona Enter</div>
      </div>
    </div>
  );

  const goBack = () => {
    if (screen === "count") { setScreen("conteo"); }
    else if (screen === "conteo") { setScreen("list"); setActiveConteo(null); loadConteos(); }
  };

  const openConteo = (c: DBConteo) => {
    setActiveConteo(c);
    // Find first uncounted position
    const pendingIdx = c.posiciones.findIndex(p => !c.posiciones_contadas.includes(p));
    setCurrentPosIdx(pendingIdx >= 0 ? pendingIdx : 0);
    setScreen("conteo");
    // Mark as EN_PROCESO if still ABIERTA
    if (c.estado === "ABIERTA") {
      updateConteo(c.id!, { estado: "EN_PROCESO" });
      c.estado = "EN_PROCESO";
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        {screen === "list" ? (
          <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        ) : (
          <button className="back-btn" onClick={goBack}>&#8592;</button>
        )}
        <h1>Conteo Cíclico</h1>
        <div style={{fontSize:10,color:"#06b6d4",fontWeight:600}}>{operario}</div>
      </div>
      <div style={{padding:12}}>
        {screen === "list" && <ConteoList conteos={conteos} onSelect={openConteo} onRefresh={loadConteos}/>}
        {screen === "conteo" && activeConteo && (
          <ConteoOverview
            conteo={activeConteo}
            currentPosIdx={currentPosIdx}
            onStartCount={(idx) => { setCurrentPosIdx(idx); setScreen("count"); }}
            onRefresh={async () => {
              const fresh = await fetchActiveConteos();
              const u = fresh.find(c => c.id === activeConteo.id);
              if (u) setActiveConteo(u);
              setConteos(fresh);
            }}
          />
        )}
        {screen === "count" && activeConteo && (
          <CountPosition
            conteo={activeConteo}
            posIdx={currentPosIdx}
            operario={operario}
            onDone={async (updatedConteo) => {
              setActiveConteo(updatedConteo);
              // Move to next uncounted position
              const nextIdx = updatedConteo.posiciones.findIndex(p => !updatedConteo.posiciones_contadas.includes(p));
              if (nextIdx >= 0) {
                setCurrentPosIdx(nextIdx);
              } else {
                // All done - go back to overview
                setScreen("conteo");
              }
              if (nextIdx < 0) setScreen("conteo");
              else setScreen("count"); // Stay in count for next position
            }}
            onBack={() => setScreen("conteo")}
          />
        )}
      </div>
    </div>
  );
}

// ==================== CONTEO LIST ====================
function ConteoList({ conteos, onSelect, onRefresh }: { conteos: DBConteo[]; onSelect: (c: DBConteo) => void; onRefresh: () => void }) {
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:16,fontWeight:700}}>Conteos Pendientes</div>
        <button onClick={onRefresh} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"#06b6d4",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Actualizar</button>
      </div>
      {conteos.length === 0 && (
        <div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin conteos pendientes</div>
          <div style={{fontSize:12,marginTop:4}}>El admin creará una orden de conteo cuando sea necesario</div>
        </div>
      )}
      {conteos.map(c => {
        const total = c.posiciones.length;
        const done = c.posiciones_contadas.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return (
          <button key={c.id} onClick={() => onSelect(c)}
            style={{width:"100%",textAlign:"left",padding:16,marginBottom:8,borderRadius:12,cursor:"pointer",
              background: pct === 100 ? "#10b98115" : "var(--bg2)",border:`2px solid ${pct === 100 ? "#10b98144" : "var(--bg3)"}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontSize:15,fontWeight:700}}>📋 Conteo {c.fecha}</div>
                <div style={{fontSize:11,color:"#94a3b8"}}>
                  {c.tipo === "por_posicion" ? "Por posición" : "Por SKU"} · {total} posiciones
                </div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:700,
                background: pct === 100 ? "#10b98122" : done > 0 ? "#3b82f622" : "#f59e0b22",
                color: pct === 100 ? "#10b981" : done > 0 ? "#3b82f6" : "#f59e0b"}}>
                {pct === 100 ? "✅ LISTO" : `${done}/${total}`}
              </div>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background: pct === 100 ? "#10b981" : "#3b82f6",borderRadius:6,transition:"width .3s"}}/>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ==================== CONTEO OVERVIEW ====================
function ConteoOverview({ conteo, currentPosIdx, onStartCount, onRefresh }: {
  conteo: DBConteo; currentPosIdx: number;
  onStartCount: (idx: number) => void; onRefresh: () => void;
}) {
  const total = conteo.posiciones.length;
  const done = conteo.posiciones_contadas.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const positions = activePositions();

  const nextPendingIdx = conteo.posiciones.findIndex(p => !conteo.posiciones_contadas.includes(p));

  return (
    <div>
      <div style={{padding:16,background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg3)",marginBottom:12}}>
        <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>📋 Conteo {conteo.fecha}</div>
        <div style={{fontSize:12,color:"#94a3b8"}}>{done}/{total} posiciones contadas</div>
        <div style={{background:"var(--bg3)",borderRadius:6,height:10,overflow:"hidden",marginTop:8}}>
          <div style={{width:`${pct}%`,height:"100%",background: pct === 100 ? "#10b981" : "#3b82f6",borderRadius:6,transition:"width .3s"}}/>
        </div>
        <div style={{textAlign:"center",marginTop:6,fontSize:20,fontWeight:800,color: pct === 100 ? "#10b981" : "#3b82f6"}}>{pct}%</div>
      </div>

      {nextPendingIdx >= 0 && (
        <button onClick={() => onStartCount(nextPendingIdx)}
          style={{width:"100%",padding:18,marginBottom:12,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
            background:"linear-gradient(135deg,#059669,#10b981)",cursor:"pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
          ▶ SIGUIENTE POSICION
        </button>
      )}

      {pct === 100 && (
        <div style={{textAlign:"center",padding:20,marginBottom:12}}>
          <div style={{fontSize:48}}>✅</div>
          <div style={{fontSize:18,fontWeight:700,color:"#10b981",marginTop:8}}>¡Conteo completo!</div>
          <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>El admin revisará los resultados</div>
        </div>
      )}

      <button onClick={onRefresh} style={{width:"100%",padding:8,marginBottom:12,borderRadius:6,background:"var(--bg3)",color:"#06b6d4",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Refrescar</button>

      {conteo.posiciones.map((posId, idx) => {
        const isDone = conteo.posiciones_contadas.includes(posId);
        const pos = positions.find(p => p.id === posId);
        const lineas = conteo.lineas.filter(l => l.posicion_id === posId && l.estado !== "PENDIENTE");
        const totalContado = lineas.reduce((s, l) => s + l.stock_contado, 0);
        return (
          <div key={posId} onClick={() => { if (!isDone) onStartCount(idx); }}
            style={{padding:14,marginBottom:8,borderRadius:10,
              background: isDone ? "#10b98110" : "var(--bg2)",
              border:`1px solid ${isDone ? "#10b98133" : "var(--bg3)"}`,
              opacity: isDone ? 0.7 : 1, cursor: isDone ? "default" : "pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:40,height:40,borderRadius:8,
                  background: isDone ? "#10b98122" : "#3b82f622",
                  display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {isDone ? <span style={{fontSize:18}}>✅</span> :
                    <span className="mono" style={{fontSize:14,fontWeight:800,color:"#3b82f6"}}>{posId}</span>}
                </div>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>{pos?.label || posId}</div>
                  {isDone && (
                    <div style={{fontSize:11,color:"#94a3b8"}}>
                      {lineas.length} SKUs · {totalContado} uds contadas
                    </div>
                  )}
                </div>
              </div>
              {!isDone && <span style={{fontSize:18,color:"#3b82f6"}}>→</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== COUNT POSITION ====================
function CountPosition({ conteo, posIdx, operario, onDone, onBack }: {
  conteo: DBConteo; posIdx: number; operario: string;
  onDone: (updated: DBConteo) => void; onBack: () => void;
}) {
  const posId = conteo.posiciones[posIdx];
  const positions = activePositions();
  const pos = positions.find(p => p.id === posId);
  const cfg = getMapConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(16);

  // Items the operator has registered for this position
  const [items, setItems] = useState<{ sku: string; nombre: string; qty: number }[]>([]);
  const [showScanner, setShowScanner] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [qtyEdit, setQtyEdit] = useState<number | null>(null); // index of item being edited
  const [tempQty, setTempQty] = useState(1);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    const hr = () => { if (containerRef.current) setCellSize(Math.max(12, Math.floor((containerRef.current.clientWidth - 4) / cfg.gridW))); };
    hr(); window.addEventListener("resize", hr); return () => window.removeEventListener("resize", hr);
  }, [cfg.gridW]);

  const mapW = cfg.gridW * cellSize, mapH = cfg.gridH * cellSize;

  const addProduct = (sku: string, nombre: string) => {
    const existing = items.findIndex(i => i.sku === sku);
    if (existing >= 0) {
      // Focus on qty edit
      setQtyEdit(existing);
      setTempQty(items[existing].qty);
    } else {
      const newItems = [...items, { sku, nombre, qty: 1 }];
      setItems(newItems);
      setQtyEdit(newItems.length - 1);
      setTempQty(1);
    }
    setShowScanner(false);
    setShowSearch(false);
    setSearchQ("");
  };

  const handleScan = (code: string) => {
    const s = getStore();
    // Try to find by SKU or ML code
    const prods = findProduct(code);
    if (prods.length > 0) {
      addProduct(prods[0].sku, prods[0].name);
    } else {
      // Try by ML code in products
      const allProds = Object.values(s.products);
      const found = allProds.find(p => p.mlCode && p.mlCode.split(",").some(c => c.trim() === code));
      if (found) {
        addProduct(found.sku, found.name);
      }
    }
  };

  const searchResults = searchQ.length >= 2 ? findProduct(searchQ).slice(0, 8) : [];

  const updateQty = (idx: number, qty: number) => {
    const newItems = [...items];
    newItems[idx].qty = Math.max(0, qty);
    setItems(newItems);
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
    setQtyEdit(null);
  };

  const confirmPosition = async (empty: boolean) => {
    setSaving(true);
    const now = new Date().toISOString();
    const newLineas = [...conteo.lineas];

    if (empty) {
      // Mark all expected lines for this position as counted with 0
      for (let i = 0; i < newLineas.length; i++) {
        if (newLineas[i].posicion_id === posId && newLineas[i].estado === "PENDIENTE") {
          newLineas[i] = { ...newLineas[i], stock_contado: 0, operario, timestamp: now, estado: "CONTADO" };
        }
      }
    } else {
      // Process each item the operator registered
      for (const item of items) {
        const existingIdx = newLineas.findIndex(l => l.posicion_id === posId && l.sku === item.sku);
        if (existingIdx >= 0) {
          // Update existing expected line
          newLineas[existingIdx] = { ...newLineas[existingIdx], stock_contado: item.qty, operario, timestamp: now, estado: "CONTADO" };
        } else {
          // New unexpected SKU found by operator
          const posLabel = pos?.label || posId;
          const s = getStore();
          const prod = s.products[item.sku];
          newLineas.push({
            posicion_id: posId,
            posicion_label: posLabel,
            sku: item.sku,
            nombre: prod?.name || item.nombre,
            stock_sistema: 0,
            stock_contado: item.qty,
            operario,
            timestamp: now,
            estado: "CONTADO",
            es_inesperado: true,
          });
        }
      }
      // Mark expected lines for this position that operator didn't find as counted with 0 (faltantes)
      for (let i = 0; i < newLineas.length; i++) {
        if (newLineas[i].posicion_id === posId && newLineas[i].estado === "PENDIENTE") {
          const found = items.find(it => it.sku === newLineas[i].sku);
          if (!found) {
            newLineas[i] = { ...newLineas[i], stock_contado: 0, operario, timestamp: now, estado: "CONTADO" };
          }
        }
      }
    }

    const newContadas = [...conteo.posiciones_contadas, posId];
    const allDone = conteo.posiciones.every(p => newContadas.includes(p));

    const updates: Partial<DBConteo> = {
      lineas: newLineas,
      posiciones_contadas: newContadas,
      estado: allDone ? "REVISION" : "EN_PROCESO",
    };

    await updateConteo(conteo.id!, updates);

    const updated: DBConteo = { ...conteo, ...updates };
    setSaving(false);
    setShowDone(true);
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    setTimeout(() => onDone(updated), 1200);
  };

  if (showDone) return (
    <div style={{textAlign:"center",padding:40}}>
      <div style={{fontSize:64,marginBottom:16}}>✅</div>
      <div style={{fontSize:20,fontWeight:800,color:"#10b981"}}>¡Posición contada!</div>
      <div style={{fontSize:14,color:"#94a3b8",marginTop:8}}>{posId} — {items.length} productos registrados</div>
    </div>
  );

  return (
    <div>
      {/* Header: Position info */}
      <div style={{padding:16,background:"#3b82f615",border:"2px solid #3b82f644",borderRadius:14,marginBottom:12}}>
        <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>
          POSICIÓN {posIdx + 1} DE {conteo.posiciones.length}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14,marginTop:8}}>
          <div style={{width:64,height:64,borderRadius:14,background:"linear-gradient(135deg,#1e1b4b,#312e81)",border:"3px solid #3b82f6",
            display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            <span className="mono" style={{fontSize:24,fontWeight:800,color:"#3b82f6"}}>{posId}</span>
          </div>
          <div>
            <div style={{fontSize:18,fontWeight:700}}>{pos?.label || posId}</div>
            <div style={{fontSize:13,color:"#94a3b8"}}>Ve a esta posición y cuenta lo que hay</div>
          </div>
        </div>
      </div>

      {/* Map */}
      <div ref={containerRef} style={{background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg4)",overflow:"hidden",marginBottom:12,padding:4}}>
        <div style={{width:mapW,height:mapH,position:"relative",margin:"0 auto"}}>
          <svg width={mapW} height={mapH} style={{position:"absolute",top:0,left:0,pointerEvents:"none",opacity:0.06}}>
            {Array.from({length:cfg.gridW+1}).map((_,i)=><line key={"v"+i} x1={i*cellSize} y1={0} x2={i*cellSize} y2={mapH} stroke="#94a3b8" strokeWidth={1}/>)}
            {Array.from({length:cfg.gridH+1}).map((_,i)=><line key={"h"+i} x1={0} y1={i*cellSize} x2={mapW} y2={i*cellSize} stroke="#94a3b8" strokeWidth={1}/>)}
          </svg>
          {cfg.objects.map(o=>(
            <div key={o.id} style={{position:"absolute",left:o.mx*cellSize,top:o.my*cellSize,width:o.mw*cellSize,height:o.mh*cellSize,
              background:(o.color||"#64748b")+"18",border:`1px dashed ${o.color||"#64748b"}44`,borderRadius:3,
              display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none",zIndex:1}}>
              {o.mw*cellSize>30&&<div style={{fontSize:Math.max(6,cellSize*0.28),color:(o.color||"#64748b")+"88",fontWeight:600}}>{o.label}</div>}
            </div>
          ))}
          {positions.filter(p => p.active && p.mx !== undefined).map(p => {
            const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
            const isT = p.id === posId;
            return (
              <div key={p.id} style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                background: isT ? "#3b82f655" : "#3b82f60a",
                border: isT ? "3px solid #fff" : "1px solid #3b82f622", borderRadius:4,
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                zIndex: isT ? 20 : 5, boxShadow: isT ? "0 0 0 3px #3b82f6, 0 0 20px #3b82f666" : "none"}}>
                <div className="mono" style={{fontSize:Math.max(8,Math.min(14,cellSize*0.5)),fontWeight:800,color: isT ? "#fff" : "#3b82f633"}}>{p.id}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Registered items */}
      <div style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,marginBottom:8,color:"#94a3b8"}}>
          {items.length > 0 ? `PRODUCTOS ENCONTRADOS (${items.length})` : "SIN PRODUCTOS REGISTRADOS"}
        </div>
        {items.map((item, idx) => (
          <div key={idx} style={{padding:12,marginBottom:6,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",
            display:"flex",alignItems:"center",gap:10}}>
            <div style={{flex:1,minWidth:0}}>
              <div className="mono" style={{fontSize:13,fontWeight:700}}>{item.sku}</div>
              <div style={{fontSize:11,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.nombre}</div>
            </div>
            {qtyEdit === idx ? (
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <button onClick={() => updateQty(idx, tempQty - 1)} style={{width:36,height:36,borderRadius:8,background:"var(--bg3)",color:"#fff",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                <input type="number" value={tempQty} onChange={e => setTempQty(parseInt(e.target.value) || 0)}
                  style={{width:56,height:36,borderRadius:8,background:"var(--bg3)",color:"#fff",fontSize:16,fontWeight:700,textAlign:"center",border:"1px solid var(--bg4)"}}/>
                <button onClick={() => updateQty(idx, tempQty + 1)} style={{width:36,height:36,borderRadius:8,background:"var(--bg3)",color:"#fff",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                <button onClick={() => { updateQty(idx, tempQty); setQtyEdit(null); }}
                  style={{padding:"6px 12px",borderRadius:8,background:"#10b98133",color:"#10b981",fontSize:12,fontWeight:700,border:"1px solid #10b98144"}}>OK</button>
              </div>
            ) : (
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <button onClick={() => { setQtyEdit(idx); setTempQty(item.qty); }}
                  style={{padding:"6px 14px",borderRadius:8,background:"#3b82f622",color:"#3b82f6",fontSize:16,fontWeight:800,border:"1px solid #3b82f644",minWidth:48,textAlign:"center"}}>
                  {item.qty}
                </button>
                <button onClick={() => removeItem(idx)}
                  style={{width:36,height:36,borderRadius:8,background:"#ef444422",color:"#ef4444",fontSize:14,fontWeight:700,border:"1px solid #ef444444"}}>✕</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Scanner */}
      {showScanner && (
        <div style={{marginBottom:12}}>
          <BarcodeScanner active={true} onScan={handleScan} label="Escanea código del producto" mode="barcode" placeholder="SKU o Código ML..."/>
          <button onClick={() => setShowScanner(false)}
            style={{width:"100%",marginTop:8,padding:10,borderRadius:8,background:"var(--bg3)",color:"#94a3b8",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
            Cerrar escáner
          </button>
        </div>
      )}

      {/* Search */}
      {showSearch && (
        <div style={{marginBottom:12}}>
          <input className="form-input mono" value={searchQ} onChange={e => setSearchQ(e.target.value)}
            placeholder="Buscar SKU o nombre..." autoFocus
            style={{fontSize:14,padding:12,width:"100%",marginBottom:4}}/>
          {searchResults.map(p => (
            <button key={p.sku} onClick={() => addProduct(p.sku, p.name)}
              style={{width:"100%",textAlign:"left",padding:"10px 14px",marginBottom:2,borderRadius:8,background:"var(--bg2)",
                border:"1px solid var(--bg3)",cursor:"pointer"}}>
              <span className="mono" style={{fontWeight:700,fontSize:13}}>{p.sku}</span>
              <span style={{marginLeft:8,fontSize:12,color:"#94a3b8"}}>{p.name}</span>
            </button>
          ))}
          <button onClick={() => { setShowSearch(false); setSearchQ(""); }}
            style={{width:"100%",marginTop:8,padding:10,borderRadius:8,background:"var(--bg3)",color:"#94a3b8",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
            Cerrar búsqueda
          </button>
        </div>
      )}

      {/* Action buttons */}
      {!showScanner && !showSearch && (
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          <button onClick={() => setShowScanner(true)}
            style={{padding:16,borderRadius:12,background:"#06b6d415",border:"2px solid #06b6d444",color:"#06b6d4",fontWeight:700,fontSize:14,cursor:"pointer"}}>
            📷 Escanear
          </button>
          <button onClick={() => setShowSearch(true)}
            style={{padding:16,borderRadius:12,background:"#f59e0b15",border:"2px solid #f59e0b44",color:"#f59e0b",fontWeight:700,fontSize:14,cursor:"pointer"}}>
            🔍 Buscar
          </button>
        </div>
      )}

      {/* Empty position */}
      <button onClick={() => { if (confirm("¿Confirmar que la posición " + posId + " está vacía?")) confirmPosition(true); }}
        disabled={saving}
        style={{width:"100%",padding:14,marginBottom:8,borderRadius:10,background:"transparent",color:"#94a3b8",fontSize:13,fontWeight:600,
          border:"2px dashed #64748b44",cursor:"pointer"}}>
        📭 Posición vacía (no hay nada)
      </button>

      {/* Confirm */}
      {items.length > 0 && (
        <button onClick={() => confirmPosition(false)} disabled={saving || qtyEdit !== null}
          style={{width:"100%",padding:18,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
            background: saving ? "#64748b" : "linear-gradient(135deg,#059669,#10b981)",
            cursor: saving ? "default" : "pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
          {saving ? "Guardando..." : `✅ CONFIRMAR POSICIÓN (${items.reduce((s, i) => s + i.qty, 0)} uds)`}
        </button>
      )}
    </div>
  );
}
