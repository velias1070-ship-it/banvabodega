"use client";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { initStore, refreshStore, isSupabaseConfigured, getActivePickings, pickearComponente, pickearLineaFull, marcarArmadoFull, verificarScanPicking, activePositions, posContents, getMapConfig, calcularRutaPicking, agruparPorPosicion } from "@/lib/store";
import type { DBPickingSession, PickingLinea, PickingComponente } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

export default function PickingPage() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<DBPickingSession[]>([]);
  const [activeSes, setActiveSes] = useState<DBPickingSession | null>(null);
  const [activeLinea, setActiveLinea] = useState<PickingLinea | null>(null);
  const [activeCompIdx, setActiveCompIdx] = useState(-1);
  const [screen, setScreen] = useState<"list" | "session" | "pick" | "pickFull">("list");
  const [operario, setOperario] = useState("");

  useEffect(() => {
    setMounted(true);
    initStore().then(() => setLoading(false));
    if (typeof window !== "undefined") setOperario(localStorage.getItem("banva_operario") || "");
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await getActivePickings();
    setSessions(data);
  }, []);

  useEffect(() => { if (!loading) loadSessions(); }, [loading, loadSessions]);

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
        <div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Picking</div>
        <div style={{color:"#94a3b8"}}>Conectando...</div>
      </div>
    </div>
  );

  if (!operario) return (
    <div className="app">
      <div className="topbar">
        <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        <h1>Picking</h1><div/>
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
    if (screen==="pick" || screen==="pickFull"){setScreen("session");setActiveLinea(null);setActiveCompIdx(-1);}
    else if(screen==="session"){setScreen("list");setActiveSes(null);loadSessions();}
  };

  const isEnvioFull = activeSes?.tipo === "envio_full";
  const titulo = isEnvioFull ? (activeSes?.titulo || "Envío a Full") : "Picking Flex";

  return (
    <div className="app">
      <div className="topbar">
        {screen==="list"?(<Link href="/operador"><button className="back-btn">&#8592;</button></Link>):(
          <button className="back-btn" onClick={goBack}>&#8592;</button>
        )}
        <h1>{screen==="list" ? "Picking" : titulo}</h1>
        <div style={{fontSize:10,color:"#06b6d4",fontWeight:600}}>{operario}</div>
      </div>
      <div style={{padding:12}}>
        {screen==="list"&&<SessionList sessions={sessions} onSelect={s=>{setActiveSes(s);setScreen("session");}} onRefresh={loadSessions}/>}
        {screen==="session"&&activeSes&&!isEnvioFull&&<SessionDetail session={activeSes} onPickComp={(l,i)=>{setActiveLinea(l);setActiveCompIdx(i);setScreen("pick");}} onRefresh={async()=>{
          const fresh=await getActivePickings();const u=fresh.find(s=>s.id===activeSes.id);
          if(u)setActiveSes(u);setSessions(fresh);
        }}/>}
        {screen==="session"&&activeSes&&isEnvioFull&&<SessionDetailFull session={activeSes} onPickLine={(linea)=>{setActiveLinea(linea);setScreen("pickFull");}} operario={operario} onRefresh={async()=>{
          const fresh=await getActivePickings();const u=fresh.find(s=>s.id===activeSes.id);
          if(u)setActiveSes(u);setSessions(fresh);
        }}/>}
        {screen==="pick"&&activeSes&&activeLinea&&activeCompIdx>=0&&<PickFlow session={activeSes} linea={activeLinea} compIdx={activeCompIdx} operario={operario} onDone={async()=>{
          const fresh=await getActivePickings();const u=fresh.find(s=>s.id===activeSes.id);
          if(u){setActiveSes(u);setSessions(fresh);}
          setScreen("session");setActiveLinea(null);setActiveCompIdx(-1);
        }}/>}
        {screen==="pickFull"&&activeSes&&activeLinea&&<PickFlowFull session={activeSes} linea={activeLinea} operario={operario} onDone={async()=>{
          const fresh=await getActivePickings();const u=fresh.find(s=>s.id===activeSes.id);
          if(u){setActiveSes(u);setSessions(fresh);}
          setScreen("session");setActiveLinea(null);
        }}/>}
      </div>
    </div>
  );
}

// ==================== SESSION LIST ====================
function SessionList({sessions,onSelect,onRefresh}:{sessions:DBPickingSession[];onSelect:(s:DBPickingSession)=>void;onRefresh:()=>void}) {
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:16,fontWeight:700}}>Sesiones de Picking</div>
        <button onClick={onRefresh} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"#06b6d4",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Actualizar</button>
      </div>
      {sessions.length===0&&(
        <div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin picking pendiente</div>
          <div style={{fontSize:12,marginTop:4}}>El admin creará la sesión cuando haya pedidos</div>
        </div>
      )}
      {sessions.map(ses=>{
        const isEnvioFull = ses.tipo === "envio_full";
        const tc = ses.lineas.reduce((s,l)=>s+l.componentes.length,0);
        const dc = ses.lineas.reduce((s,l)=>s+l.componentes.filter(c=>c.estado==="PICKEADO").length,0);
        const pct=tc>0?Math.round((dc/tc)*100):0;
        const done = ses.lineas.filter(l=>l.estado==="PICKEADO").length;
        const total = ses.lineas.length;
        const tipoBadge = isEnvioFull ? "FULL" : "FLEX";
        const tipoBadgeColor = isEnvioFull ? "#3b82f6" : "#f59e0b";
        return(
          <button key={ses.id} onClick={()=>onSelect(ses)}
            style={{width:"100%",textAlign:"left",padding:16,marginBottom:8,borderRadius:12,cursor:"pointer",
              background:pct===100?"#10b98115":"var(--bg2)",border:`2px solid ${pct===100?"#10b98144":"var(--bg3)"}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:15,fontWeight:700}}>{isEnvioFull ? "📦" : "🏷️"} {ses.titulo || `Picking ${ses.fecha}`}</span>
                  <span style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:800,background:`${tipoBadgeColor}22`,color:tipoBadgeColor,border:`1px solid ${tipoBadgeColor}44`}}>{tipoBadge}</span>
                </div>
                <div style={{fontSize:11,color:"#94a3b8"}}>{total} {isEnvioFull ? "productos" : "pedidos"} · {tc} items</div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:700,
                background:pct===100?"#10b98122":done>0?"#3b82f622":"#f59e0b22",
                color:pct===100?"#10b981":done>0?"#3b82f6":"#f59e0b"}}>
                {pct===100?"✅ LISTO":`${done}/${total}`}
              </div>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background:pct===100?"#10b981":"#3b82f6",borderRadius:6,transition:"width .3s"}}/>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ==================== SESSION DETAIL (Flex — con agrupación por posición) ====================
function SessionDetail({session,onPickComp,onRefresh}:{session:DBPickingSession;onPickComp:(l:PickingLinea,i:number)=>void;onRefresh:()=>void}) {
  const tc=session.lineas.reduce((s,l)=>s+l.componentes.length,0);
  const dc=session.lineas.reduce((s,l)=>s+l.componentes.filter(c=>c.estado==="PICKEADO").length,0);
  const pct=tc>0?Math.round((dc/tc)*100):0;

  // Aplicar ruta inteligente y agrupación por posición para Flex también
  const posicionesNecesarias = useMemo(() => {
    const posSet = new Set<string>();
    for (const l of session.lineas) for (const c of l.componentes) if (c.estado === "PENDIENTE") posSet.add(c.posicion);
    return Array.from(posSet);
  }, [session]);

  const rutaOrdenada = useMemo(() => calcularRutaPicking(posicionesNecesarias), [posicionesNecesarias]);

  // Find next pending (by route order)
  const next = useMemo(() => {
    // Build ordered list of pending components by route
    for (const posId of rutaOrdenada) {
      for (const l of session.lineas) {
        for (let i = 0; i < l.componentes.length; i++) {
          if (l.componentes[i].estado === "PENDIENTE" && l.componentes[i].posicion === posId) {
            return { linea: l, idx: i };
          }
        }
      }
    }
    // Fallback: any pending
    for (const l of session.lineas) for (let i = 0; i < l.componentes.length; i++)
      if (l.componentes[i].estado === "PENDIENTE") return { linea: l, idx: i };
    return null;
  }, [session, rutaOrdenada]);

  return(
    <div>
      <div style={{padding:16,background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg3)",marginBottom:12}}>
        <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>🏷️ Picking Flex {session.fecha}</div>
        <div style={{fontSize:12,color:"#94a3b8"}}>{dc}/{tc} productos</div>
        <div style={{background:"var(--bg3)",borderRadius:6,height:10,overflow:"hidden",marginTop:8}}>
          <div style={{width:`${pct}%`,height:"100%",background:pct===100?"#10b981":"#3b82f6",borderRadius:6,transition:"width .3s"}}/>
        </div>
        <div style={{textAlign:"center",marginTop:6,fontSize:20,fontWeight:800,color:pct===100?"#10b981":"#3b82f6"}}>{pct}%</div>
      </div>

      {next&&(
        <button onClick={()=>onPickComp(next.linea,next.idx)}
          style={{width:"100%",padding:18,marginBottom:12,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
            background:"linear-gradient(135deg,#059669,#10b981)",cursor:"pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
          ▶ SIGUIENTE PRODUCTO
        </button>
      )}

      {pct===100&&(
        <div style={{textAlign:"center",padding:20,marginBottom:12}}>
          <div style={{fontSize:48}}>✅</div>
          <div style={{fontSize:18,fontWeight:700,color:"#10b981",marginTop:8}}>¡Picking completo!</div>
        </div>
      )}

      <button onClick={onRefresh} style={{width:"100%",padding:8,marginBottom:12,borderRadius:6,background:"var(--bg3)",color:"#06b6d4",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Refrescar</button>

      {session.lineas.map(linea=>{
        const allDone=linea.componentes.every(c=>c.estado==="PICKEADO");
        return(
          <div key={linea.id} style={{padding:14,marginBottom:8,borderRadius:10,
            background:allDone?"#10b98110":"var(--bg2)",border:`1px solid ${allDone?"#10b98133":"var(--bg3)"}`,opacity:allDone?0.7:1}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <span style={{fontSize:10,color:"#94a3b8",fontWeight:600}}>PEDIDO {linea.id}</span>
                <div className="mono" style={{fontSize:14,fontWeight:700}}>{linea.skuVenta}</div>
                <div style={{fontSize:11,color:"#94a3b8"}}>×{linea.qtyPedida}</div>
              </div>
              {allDone?<span style={{fontSize:20}}>✅</span>:
                <span style={{fontSize:11,fontWeight:700,color:"#f59e0b"}}>{linea.componentes.filter(c=>c.estado==="PICKEADO").length}/{linea.componentes.length}</span>
              }
            </div>
            {linea.componentes.map((comp,idx)=>(
              <div key={idx} onClick={()=>{if(comp.estado!=="PICKEADO")onPickComp(linea,idx);}}
                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginTop:4,borderRadius:8,
                  background:comp.estado==="PICKEADO"?"#10b98118":"var(--bg3)",
                  border:`1px solid ${comp.estado==="PICKEADO"?"#10b98133":"var(--bg4)"}`,
                  cursor:comp.estado==="PICKEADO"?"default":"pointer",opacity:comp.estado==="PICKEADO"?0.6:1}}>
                <div style={{width:36,height:36,borderRadius:8,background:comp.estado==="PICKEADO"?"#10b98122":"#3b82f622",
                  display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {comp.estado==="PICKEADO"?<span style={{fontSize:18}}>✅</span>:
                    <span className="mono" style={{fontSize:14,fontWeight:800,color:"#3b82f6"}}>{comp.unidades}</span>}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{comp.nombre}</div>
                  <div style={{fontSize:11,color:"#94a3b8"}}>
                    <span className="mono">{comp.skuOrigen}</span> · Pos <strong style={{color:"#10b981"}}>{comp.posicion}</strong>
                  </div>
                </div>
                {comp.estado!=="PICKEADO"&&<span style={{fontSize:18,color:"#3b82f6"}}>→</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ==================== SESSION DETAIL FULL (3 fases: Recolección, Armado, Resumen) ====================
function SessionDetailFull({session,onPickLine,operario,onRefresh}:{session:DBPickingSession;onPickLine:(linea:PickingLinea)=>void;operario:string;onRefresh:()=>void}) {
  const lineas = session.lineas;
  const [fase, setFase] = useState<"recoleccion"|"armado"|"resumen">("recoleccion");

  const allPicked = lineas.every(l => l.estado === "PICKEADO");
  const allArmado = lineas.every(l => !l.estadoArmado || l.estadoArmado === "COMPLETADO");
  const needArmado = lineas.some(l => l.estadoArmado === "PENDIENTE");

  // Auto-advance to armado when all picked
  useEffect(() => {
    if (allPicked && needArmado && fase === "recoleccion") setFase("armado");
    if (allPicked && allArmado) setFase("resumen");
  }, [allPicked, allArmado, needArmado, fase]);

  const pickedCount = lineas.filter(l => l.estado === "PICKEADO").length;
  const pctPicked = lineas.length > 0 ? Math.round((pickedCount / lineas.length) * 100) : 0;

  // Agrupar por posición y ordenar por ruta
  const gruposPorPosicion = useMemo(() => {
    const pendientes = lineas.filter(l => l.estado === "PENDIENTE");
    const posiciones = Array.from(new Set(pendientes.map(l => l.componentes[0]?.posicion).filter(Boolean))) as string[];
    const ruta = calcularRutaPicking(posiciones);
    // Group lines by their component's position
    const grupos = new Map<string, PickingLinea[]>();
    for (const l of pendientes) {
      const pos = l.componentes[0]?.posicion || "?";
      if (!grupos.has(pos)) grupos.set(pos, []);
      grupos.get(pos)!.push(l);
    }
    return ruta.map(pos => ({ pos, label: grupos.get(pos)?.[0]?.componentes[0]?.posLabel || pos, items: grupos.get(pos) || [] })).filter(g => g.items.length > 0);
  }, [lineas]);

  // Next pending line (by route)
  const nextPending = useMemo(() => {
    for (const g of gruposPorPosicion) {
      for (const item of g.items) {
        if (item.estado === "PENDIENTE") return item;
      }
    }
    return null;
  }, [gruposPorPosicion]);

  // Armado lines: only packs/combos that need armado
  const lineasArmado = useMemo(() => {
    const map = new Map<string, PickingLinea[]>();
    for (const l of lineas) {
      if (!l.estadoArmado || l.estadoArmado === "COMPLETADO" && !l.tipoFull) continue;
      if (!l.tipoFull || l.tipoFull === "simple") continue;
      if (!map.has(l.skuVenta)) map.set(l.skuVenta, []);
      map.get(l.skuVenta)!.push(l);
    }
    return Array.from(map.entries()).map(([skuVenta, items]) => ({
      skuVenta,
      items,
      todoArmado: items.every(i => !i.estadoArmado || i.estadoArmado === "COMPLETADO"),
    }));
  }, [lineas]);

  // Resumen: agrupado por SKU Venta
  const resumen = useMemo(() => {
    const map = new Map<string, { skuVenta: string; nombre: string; unidadesVenta: number }>();
    for (const l of lineas) {
      if (!map.has(l.skuVenta)) map.set(l.skuVenta, { skuVenta: l.skuVenta, nombre: "", unidadesVenta: 0 });
      const r = map.get(l.skuVenta)!;
      r.nombre = l.componentes[0]?.nombre || l.skuVenta;
      r.unidadesVenta = l.qtyVenta || l.qtyPedida;
    }
    return Array.from(map.values());
  }, [lineas]);

  const handleMarcarArmado = useCallback(async (lineaId: string) => {
    await marcarArmadoFull(session.id!, lineaId, operario, session);
    await onRefresh();
  }, [session, operario, onRefresh]);

  return (
    <div>
      {/* Header */}
      <div style={{padding:16,background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg3)",marginBottom:12}}>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
          <span style={{fontSize:16,fontWeight:700}}>📦 {session.titulo || "Envío a Full"}</span>
          <span style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:800,background:"#3b82f622",color:"#3b82f6",border:"1px solid #3b82f644"}}>FULL</span>
        </div>
        <div style={{fontSize:12,color:"#94a3b8"}}>{pickedCount}/{lineas.length} recolectados</div>
        <div style={{background:"var(--bg3)",borderRadius:6,height:10,overflow:"hidden",marginTop:8}}>
          <div style={{width:`${pctPicked}%`,height:"100%",background:allPicked?"#10b981":"#3b82f6",borderRadius:6,transition:"width .3s"}}/>
        </div>
      </div>

      {/* Phase tabs */}
      <div style={{display:"flex",borderRadius:8,overflow:"hidden",border:"1px solid var(--bg4)",marginBottom:12}}>
        <button onClick={()=>setFase("recoleccion")} style={{flex:1,padding:"8px 0",fontSize:11,fontWeight:700,background:fase==="recoleccion"?"#3b82f6":"var(--bg3)",color:fase==="recoleccion"?"#fff":"#94a3b8",border:"none",cursor:"pointer"}}>
          1. Recolección {allPicked && "✅"}
        </button>
        <button onClick={()=>setFase("armado")} disabled={!allPicked && needArmado} style={{flex:1,padding:"8px 0",fontSize:11,fontWeight:700,background:fase==="armado"?"#f59e0b":"var(--bg3)",color:fase==="armado"?"#000":"#94a3b8",border:"none",cursor:allPicked||!needArmado?"pointer":"default",opacity:!allPicked&&needArmado?0.4:1}}>
          2. Armado {allArmado && "✅"}
        </button>
        <button onClick={()=>setFase("resumen")} disabled={!allPicked||!allArmado} style={{flex:1,padding:"8px 0",fontSize:11,fontWeight:700,background:fase==="resumen"?"#10b981":"var(--bg3)",color:fase==="resumen"?"#000":"#94a3b8",border:"none",cursor:allPicked&&allArmado?"pointer":"default",opacity:!allPicked||!allArmado?0.4:1}}>
          3. Resumen
        </button>
      </div>

      <button onClick={onRefresh} style={{width:"100%",padding:8,marginBottom:12,borderRadius:6,background:"var(--bg3)",color:"#06b6d4",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Refrescar</button>

      {/* FASE 1: RECOLECCIÓN — agrupado por posición con ruta inteligente */}
      {fase==="recoleccion"&&(
        <div>
          {nextPending && (
            <button onClick={()=>onPickLine(nextPending)}
              style={{width:"100%",padding:18,marginBottom:12,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
                background:"linear-gradient(135deg,#059669,#10b981)",cursor:"pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
              ▶ SIGUIENTE: {nextPending.componentes[0]?.posLabel} — {nextPending.componentes[0]?.nombre}
            </button>
          )}

          {allPicked && !needArmado && (
            <div style={{textAlign:"center",padding:20,marginBottom:12}}>
              <div style={{fontSize:48}}>✅</div>
              <div style={{fontSize:18,fontWeight:700,color:"#10b981",marginTop:8}}>¡Recolección completa!</div>
              <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>Todos los productos simples. Listo para despacho.</div>
            </div>
          )}

          {allPicked && needArmado && (
            <div style={{textAlign:"center",padding:20,marginBottom:12,background:"#f59e0b15",borderRadius:12,border:"1px solid #f59e0b44"}}>
              <div style={{fontSize:48}}>⚙️</div>
              <div style={{fontSize:18,fontWeight:700,color:"#f59e0b",marginTop:8}}>Recolección completa</div>
              <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>Ahora ve a la fase de Armado para armar packs y combos.</div>
            </div>
          )}

          {/* Posiciones agrupadas con ruta */}
          {gruposPorPosicion.map((grupo, gi) => (
            <div key={grupo.pos} style={{padding:14,marginBottom:8,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#064e3b,#065f46)",border:"2px solid #10b981",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <span style={{fontSize:10,fontWeight:800,color:"#10b981"}}>{gi+1}</span>
                </div>
                <div>
                  <div style={{fontSize:14,fontWeight:700}}>📍 {grupo.label}</div>
                  <div style={{fontSize:11,color:"#94a3b8"}}>{grupo.items.length} producto{grupo.items.length>1?"s":""} a tomar</div>
                </div>
              </div>
              {grupo.items.map(item => {
                const comp = item.componentes[0];
                return (
                <div key={item.id} onClick={()=>{if(item.estado!=="PICKEADO")onPickLine(item);}}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",marginTop:4,borderRadius:8,
                    background:item.estado==="PICKEADO"?"#10b98118":"var(--bg3)",
                    border:`1px solid ${item.estado==="PICKEADO"?"#10b98133":"var(--bg4)"}`,
                    cursor:item.estado==="PICKEADO"?"default":"pointer",opacity:item.estado==="PICKEADO"?0.6:1}}>
                  <div style={{width:36,height:36,borderRadius:8,background:item.estado==="PICKEADO"?"#10b98122":"#3b82f622",
                    display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {item.estado==="PICKEADO"?<span style={{fontSize:18}}>✅</span>:
                      <span className="mono" style={{fontSize:14,fontWeight:800,color:"#3b82f6"}}>{comp?.unidades}</span>}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{comp?.nombre}</div>
                    <div style={{fontSize:11,color:"#94a3b8"}}>
                      <span className="mono">{comp?.skuOrigen}</span> · {comp?.unidades} uds
                      {item.tipoFull && item.tipoFull !== "simple" && <span style={{color:"#f59e0b",marginLeft:6}}>→ {item.skuVenta}</span>}
                    </div>
                  </div>
                  {item.estado!=="PICKEADO"&&<span style={{fontSize:18,color:"#3b82f6"}}>→</span>}
                </div>
              );})}
            </div>
          ))}

          {/* Already picked items */}
          {lineas.filter(l => l.estado === "PICKEADO").length > 0 && (
            <div style={{padding:14,marginTop:8,borderRadius:10,background:"#10b98110",border:"1px solid #10b98133",opacity:0.6}}>
              <div style={{fontSize:12,fontWeight:700,color:"#10b981",marginBottom:8}}>✅ Ya recolectados ({lineas.filter(l => l.estado === "PICKEADO").length})</div>
              {lineas.filter(l => l.estado === "PICKEADO").map(item => (
                <div key={item.id} style={{fontSize:11,color:"#94a3b8",padding:"2px 0"}}>
                  <span className="mono">{item.componentes[0]?.skuOrigen}</span> — {item.componentes[0]?.unidades} uds de {item.componentes[0]?.posLabel}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* FASE 2: ARMADO */}
      {fase==="armado"&&(
        <div>
          <div style={{padding:16,background:"#f59e0b15",border:"1px solid #f59e0b44",borderRadius:12,marginBottom:12}}>
            <div style={{fontSize:15,fontWeight:700,color:"#f59e0b",marginBottom:4}}>📦 ARMAR ANTES DE ENVIAR</div>
            <div style={{fontSize:12,color:"#94a3b8"}}>Arma los packs y combos con los productos ya recolectados.</div>
          </div>

          {lineasArmado.length === 0 && (
            <div style={{textAlign:"center",padding:30,color:"#94a3b8"}}>
              <div style={{fontSize:36}}>✅</div>
              <div style={{fontSize:14,fontWeight:600,marginTop:8}}>No hay packs ni combos que armar</div>
              <div style={{fontSize:12,marginTop:4}}>Todos son productos simples. Ve al Resumen.</div>
            </div>
          )}

          {lineasArmado.map((grupo, gi) => (
            <div key={grupo.skuVenta} style={{padding:14,marginBottom:8,borderRadius:10,
              background:grupo.todoArmado?"#10b98110":"var(--bg2)",
              border:`1px solid ${grupo.todoArmado?"#10b98133":"var(--bg3)"}`,
              opacity:grupo.todoArmado?0.7:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div>
                  <span style={{fontSize:12,fontWeight:700,color:"#f59e0b"}}>{gi+1}. </span>
                  <span className="mono" style={{fontSize:14,fontWeight:700}}>{grupo.skuVenta}</span>
                </div>
                {grupo.todoArmado && <span style={{fontSize:18}}>✅</span>}
              </div>
              {grupo.items.map(item => (
                <div key={item.id} style={{padding:"10px 12px",marginTop:4,borderRadius:8,
                  background:item.estadoArmado==="COMPLETADO"?"#10b98118":"var(--bg3)",
                  border:`1px solid ${item.estadoArmado==="COMPLETADO"?"#10b98133":"var(--bg4)"}`}}>
                  <div style={{fontSize:12,fontWeight:600,marginBottom:4}}>{item.instruccionArmado}</div>
                  <div style={{fontSize:11,color:"#94a3b8"}}>
                    {item.qtyFisica || item.qtyPedida} uds de <span className="mono">{item.skuOrigen || item.componentes[0]?.skuOrigen}</span> → {item.qtyVenta || item.qtyPedida} {item.tipoFull === "pack" ? "packs" : "combos"} de <span className="mono">{item.skuVenta}</span>
                  </div>
                  {item.estadoArmado !== "COMPLETADO" && (
                    <button onClick={()=>handleMarcarArmado(item.id)}
                      style={{marginTop:8,width:"100%",padding:12,borderRadius:8,fontWeight:700,fontSize:14,color:"#fff",
                        background:"linear-gradient(135deg,#d97706,#f59e0b)",cursor:"pointer",border:"none"}}>
                      ✅ Marcar como armado
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* FASE 3: RESUMEN */}
      {fase==="resumen"&&(
        <div>
          <div style={{textAlign:"center",padding:20,marginBottom:12}}>
            <div style={{fontSize:64}}>✅</div>
            <div style={{fontSize:20,fontWeight:800,color:"#10b981",marginTop:8}}>¡Envío a Full listo!</div>
            <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>Todos los productos están recolectados y armados.</div>
          </div>

          <div style={{padding:16,background:"var(--bg2)",borderRadius:12,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📋 Resumen del envío</div>
            {resumen.map(r => (
              <div key={r.skuVenta} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--bg3)",fontSize:13}}>
                <div>
                  <span className="mono" style={{fontWeight:700}}>{r.skuVenta}</span>
                </div>
                <span className="mono" style={{fontWeight:700,color:"#3b82f6"}}>{r.unidadesVenta} uds</span>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:14,fontWeight:800}}>
              <span>Total SKUs</span>
              <span className="mono" style={{color:"#10b981"}}>{resumen.length}</span>
            </div>
          </div>

          <div style={{textAlign:"center",padding:16,background:"#10b98115",borderRadius:12,border:"1px solid #10b98144",fontSize:13,color:"#10b981",fontWeight:600}}>
            Todo está listo para embalar y enviar a ML Full.
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== PICK FLOW (Flex — original) ====================
function PickFlow({session,linea,compIdx,operario,onDone}:{
  session:DBPickingSession;linea:PickingLinea;compIdx:number;operario:string;onDone:()=>void;
}) {
  const comp=linea.componentes[compIdx];
  const [phase,setPhase]=useState<"locate"|"scan"|"done">("locate");
  const [scanResult,setScanResult]=useState<"ok"|"error"|null>(null);
  const [scanCode,setScanCode]=useState("");
  const [saving,setSaving]=useState(false);

  const cfg=getMapConfig();
  const positions=activePositions().filter(p=>p.active&&p.mx!==undefined);
  const containerRef=useRef<HTMLDivElement>(null);
  const [cellSize,setCellSize]=useState(16);

  useEffect(()=>{
    const hr=()=>{if(containerRef.current)setCellSize(Math.max(12,Math.floor((containerRef.current.clientWidth-4)/cfg.gridW)));};
    hr();window.addEventListener("resize",hr);return()=>window.removeEventListener("resize",hr);
  },[cfg.gridW]);

  const mapW=cfg.gridW*cellSize,mapH=cfg.gridH*cellSize;
  const targetPos=comp.posicion;
  const posItems=targetPos?posContents(targetPos):[];

  const doConfirm=useCallback(async()=>{
    setSaving(true);
    await pickearComponente(session.id!,linea.id,compIdx,operario,session);
    setSaving(false);setPhase("done");
    if(navigator.vibrate)navigator.vibrate([100,50,100]);
    setTimeout(onDone,1200);
  },[session,linea,compIdx,operario,onDone]);

  const handleScan=useCallback((code:string)=>{
    setScanCode(code);
    if(verificarScanPicking(code,comp,linea.skuVenta)){setScanResult("ok");doConfirm();}
    else{setScanResult("error");if(navigator.vibrate)navigator.vibrate([200,100,200]);}
  },[comp,doConfirm,linea.skuVenta]);

  if(phase==="done")return(
    <div style={{textAlign:"center",padding:40}}>
      <div style={{fontSize:64,marginBottom:16}}>✅</div>
      <div style={{fontSize:20,fontWeight:800,color:"#10b981"}}>¡Pickeado!</div>
      <div style={{fontSize:14,color:"#94a3b8",marginTop:8}}>{comp.unidades}× {comp.nombre}</div>
    </div>
  );

  return(
    <div>
      {/* WHAT */}
      <div style={{padding:20,background:"linear-gradient(135deg,#1e1b4b,#312e81)",borderRadius:16,marginBottom:12,border:"2px solid #3b82f644"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>PEDIDO {linea.id} · {linea.skuVenta}</div>
          {comp.unidades > 1 && (
            <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,background:"#f59e0b22",color:"#f59e0b",border:"1px solid #f59e0b44"}}>
              PACK x{comp.unidades}
            </span>
          )}
        </div>
        <div style={{fontSize:18,fontWeight:800,color:"#fff",marginBottom:4}}>{comp.nombre}</div>
        <div style={{display:"flex",gap:12,alignItems:"center",marginTop:8}}>
          <div style={{padding:"8px 20px",background:"#3b82f633",borderRadius:10,border:"2px solid #3b82f6"}}>
            <div style={{fontSize:28,fontWeight:800,color:"#3b82f6",textAlign:"center"}}>{comp.unidades}</div>
            <div style={{fontSize:10,color:"#94a3b8",textAlign:"center"}}>uds</div>
          </div>
          <div style={{flex:1}}>
            <div className="mono" style={{fontSize:13,color:"#94a3b8"}}>SKU: {comp.skuOrigen}</div>
            {comp.codigoMl&&<div className="mono" style={{fontSize:12,color:"#64748b"}}>Código ML: {comp.codigoMl}</div>}
            <div className="mono" style={{fontSize:10,color:"#475569",marginTop:2}}>SKU Venta: {linea.skuVenta}</div>
          </div>
        </div>
      </div>

      {/* WHERE — LOCATE PHASE */}
      {phase==="locate"&&(<>
        <div style={{padding:16,background:"#10b98115",border:"2px solid #10b98144",borderRadius:14,marginBottom:12}}>
          <div style={{fontSize:15,fontWeight:700,color:"#10b981",marginBottom:8}}>📍 Ve a buscar a:</div>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <div style={{width:64,height:64,borderRadius:14,background:"linear-gradient(135deg,#064e3b,#065f46)",border:"3px solid #10b981",
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <span className="mono" style={{fontSize:24,fontWeight:800,color:"#10b981"}}>{targetPos}</span>
            </div>
            <div>
              <div style={{fontSize:16,fontWeight:700}}>{comp.posLabel}</div>
              <div style={{fontSize:12,color:"#94a3b8"}}>
                Disponible: <strong style={{color:"#3b82f6"}}>{comp.stockDisponible}</strong> · Tomar: <strong style={{color:"#f59e0b"}}>{comp.unidades}</strong>
              </div>
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
            {positions.map(p=>{
              const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
              const isT=p.id===targetPos;
              const items=posContents(p.id);const tq=items.reduce((s,i)=>s+i.qty,0);
              return(
                <div key={p.id} style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                  background:isT?"#10b98155":tq>0?"#10b9811a":"#10b9810a",
                  border:isT?"3px solid #fff":`1px solid ${tq>0?"#10b98166":"#10b98122"}`,borderRadius:4,
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  zIndex:isT?20:5,boxShadow:isT?"0 0 0 3px #10b981, 0 0 20px #10b98166":"none"}}>
                  <div className="mono" style={{fontSize:Math.max(8,Math.min(14,cellSize*0.5)),fontWeight:800,color:isT?"#fff":"#10b98166"}}>{p.id}</div>
                </div>
              );
            })}
          </div>
        </div>

        {posItems.length>1&&(
          <div style={{padding:12,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{fontSize:11,color:"#94a3b8",fontWeight:600,marginBottom:6}}>En posición {targetPos}:</div>
            {posItems.map(it=>(
              <div key={it.sku} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12,
                fontWeight:it.sku===comp.skuOrigen?700:400,color:it.sku===comp.skuOrigen?"#fff":"#64748b"}}>
                <span className="mono">{it.sku}</span><span>{it.qty}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={()=>setPhase("scan")}
          style={{width:"100%",padding:18,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
            background:"linear-gradient(135deg,#059669,#10b981)",cursor:"pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
          YA LO TENGO → VERIFICAR
        </button>
      </>)}

      {/* SCAN PHASE */}
      {phase==="scan"&&(<>
        <div style={{padding:16,background:"#06b6d415",border:"2px solid #06b6d444",borderRadius:14,marginBottom:12}}>
          <div style={{fontSize:15,fontWeight:700,color:"#06b6d4",marginBottom:8}}>Verifica escaneando la etiqueta ML</div>
          <div style={{fontSize:12,color:"#94a3b8"}}>Escanea el código de barras Code 128 de la etiqueta MercadoLibre con el lector.</div>
        </div>

        <BarcodeScanner active={true} onScan={handleScan} label="Escanea etiqueta ML" mode="barcode" placeholder="Código ML o SKU..."/>

        {scanResult==="error"&&(
          <div style={{padding:16,background:"#ef444422",border:"2px solid #ef4444",borderRadius:12,marginBottom:12,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>&#10060;</div>
            <div style={{fontSize:16,fontWeight:700,color:"#ef4444"}}>CODIGO INCORRECTO</div>
            <div style={{fontSize:13,color:"#94a3b8",marginTop:4}}>Escaneaste: <strong style={{fontFamily:"monospace",color:"#ef4444"}}>{scanCode}</strong></div>
            <div style={{fontSize:12,color:"#94a3b8",marginTop:6}}>
              Códigos válidos para este producto:
            </div>
            {comp.codigoMl && <div style={{fontFamily:"monospace",fontSize:12,color:"#10b981",marginTop:2}}>{comp.codigoMl} ({linea.skuVenta})</div>}
            <div style={{fontFamily:"monospace",fontSize:11,color:"#64748b",marginTop:2}}>{comp.skuOrigen} (SKU físico)</div>
            <div style={{fontSize:13,color:"#f59e0b",marginTop:8,fontWeight:600}}>Verifica que tomaste el producto correcto</div>
            <button onClick={()=>{setScanResult(null);setScanCode("");}}
              style={{marginTop:12,padding:"10px 24px",borderRadius:8,background:"var(--bg3)",color:"#06b6d4",fontWeight:700,fontSize:13,border:"1px solid var(--bg4)"}}>
              Intentar de nuevo
            </button>
          </div>
        )}

        {scanResult==="ok"&&(
          <div style={{padding:16,background:"#10b98122",border:"2px solid #10b981",borderRadius:12,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>✅</div>
            <div style={{fontSize:16,fontWeight:700,color:"#10b981"}}>{saving?"Guardando...":"¡CORRECTO!"}</div>
          </div>
        )}

        <button onClick={async()=>{setSaving(true);await pickearComponente(session.id!,linea.id,compIdx,operario,session);setSaving(false);setPhase("done");setTimeout(onDone,800);}} disabled={saving}
          style={{width:"100%",marginTop:16,padding:10,borderRadius:8,background:"transparent",color:"#64748b",fontSize:11,border:"1px dashed #64748b44"}}>
          Confirmar sin escanear (solo si no hay etiqueta)
        </button>
        <button onClick={()=>setPhase("locate")}
          style={{width:"100%",marginTop:8,padding:10,borderRadius:8,background:"var(--bg3)",color:"#94a3b8",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver a ubicación
        </button>
      </>)}
    </div>
  );
}

// ==================== PICK FLOW FULL (envio_full — con mapa, usa PickingLinea unificada) ====================
function PickFlowFull({session,linea,operario,onDone}:{
  session:DBPickingSession;linea:PickingLinea;operario:string;onDone:()=>void;
}) {
  const comp = linea.componentes[0];
  const [phase,setPhase]=useState<"locate"|"scan"|"done">("locate");
  const [scanResult,setScanResult]=useState<"ok"|"error"|null>(null);
  const [scanCode,setScanCode]=useState("");
  const [saving,setSaving]=useState(false);

  const cfg=getMapConfig();
  const positions=activePositions().filter(p=>p.active&&p.mx!==undefined);
  const containerRef=useRef<HTMLDivElement>(null);
  const [cellSize,setCellSize]=useState(16);

  useEffect(()=>{
    const hr=()=>{if(containerRef.current)setCellSize(Math.max(12,Math.floor((containerRef.current.clientWidth-4)/cfg.gridW)));};
    hr();window.addEventListener("resize",hr);return()=>window.removeEventListener("resize",hr);
  },[cfg.gridW]);

  const mapW=cfg.gridW*cellSize,mapH=cfg.gridH*cellSize;
  const targetPos=comp?.posicion || "?";
  const posItems=targetPos?posContents(targetPos):[];

  const doConfirm=useCallback(async()=>{
    setSaving(true);
    await pickearLineaFull(session.id!,linea.id,operario,session);
    setSaving(false);setPhase("done");
    if(navigator.vibrate)navigator.vibrate([100,50,100]);
    setTimeout(onDone,1200);
  },[session,linea,operario,onDone]);

  // Verify scan: use the standard verificarScanPicking function
  const handleScan=useCallback((code:string)=>{
    setScanCode(code);
    if (comp && verificarScanPicking(code, comp, linea.skuVenta)) {
      setScanResult("ok"); doConfirm();
    } else {
      setScanResult("error"); if(navigator.vibrate)navigator.vibrate([200,100,200]);
    }
  },[comp,linea.skuVenta,doConfirm]);

  if (!comp) return null;

  if(phase==="done")return(
    <div style={{textAlign:"center",padding:40}}>
      <div style={{fontSize:64,marginBottom:16}}>✅</div>
      <div style={{fontSize:20,fontWeight:800,color:"#10b981"}}>¡Recolectado!</div>
      <div style={{fontSize:14,color:"#94a3b8",marginTop:8}}>{comp.unidades}× {comp.nombre}</div>
    </div>
  );

  return(
    <div>
      {/* WHAT */}
      <div style={{padding:20,background:"linear-gradient(135deg,#1e1b4b,#312e81)",borderRadius:16,marginBottom:12,border:"2px solid #3b82f644"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>ENVÍO FULL · {linea.skuVenta}</div>
          {linea.tipoFull && linea.tipoFull !== "simple" && (
            <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:4,background:"#f59e0b22",color:"#f59e0b",border:"1px solid #f59e0b44"}}>
              {linea.tipoFull === "pack" ? `PACK x${linea.unidadesPorPack}` : "COMBO"}
            </span>
          )}
        </div>
        <div style={{fontSize:18,fontWeight:800,color:"#fff",marginBottom:4}}>{comp.nombre}</div>
        <div style={{display:"flex",gap:12,alignItems:"center",marginTop:8}}>
          <div style={{padding:"8px 20px",background:"#3b82f633",borderRadius:10,border:"2px solid #3b82f6"}}>
            <div style={{fontSize:28,fontWeight:800,color:"#3b82f6",textAlign:"center"}}>{comp.unidades}</div>
            <div style={{fontSize:10,color:"#94a3b8",textAlign:"center"}}>uds</div>
          </div>
          <div style={{flex:1}}>
            <div className="mono" style={{fontSize:13,color:"#94a3b8"}}>SKU: {comp.skuOrigen}</div>
            {comp.codigoMl&&<div className="mono" style={{fontSize:12,color:"#64748b"}}>Código ML: {comp.codigoMl}</div>}
            {linea.qtyVenta !== undefined && linea.qtyVenta !== comp.unidades && (
              <div className="mono" style={{fontSize:10,color:"#475569",marginTop:2}}>Destino: {linea.skuVenta} ({linea.qtyVenta} uds venta)</div>
            )}
          </div>
        </div>
      </div>

      {/* WHERE — LOCATE */}
      {phase==="locate"&&(<>
        <div style={{padding:16,background:"#10b98115",border:"2px solid #10b98144",borderRadius:14,marginBottom:12}}>
          <div style={{fontSize:15,fontWeight:700,color:"#10b981",marginBottom:8}}>📍 Ve a buscar a:</div>
          <div style={{display:"flex",alignItems:"center",gap:14}}>
            <div style={{width:64,height:64,borderRadius:14,background:"linear-gradient(135deg,#064e3b,#065f46)",border:"3px solid #10b981",
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <span className="mono" style={{fontSize:24,fontWeight:800,color:"#10b981"}}>{targetPos}</span>
            </div>
            <div>
              <div style={{fontSize:16,fontWeight:700}}>{comp.posLabel}</div>
              <div style={{fontSize:12,color:"#94a3b8"}}>
                Disponible: <strong style={{color:"#3b82f6"}}>{comp.stockDisponible}</strong> · Tomar: <strong style={{color:"#f59e0b"}}>{comp.unidades}</strong>
              </div>
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
            {positions.map(p=>{
              const mx=p.mx??0,my=p.my??0,mw=p.mw??2,mh=p.mh??2;
              const isT=p.id===targetPos;
              const items=posContents(p.id);const tq=items.reduce((s,i)=>s+i.qty,0);
              return(
                <div key={p.id} style={{position:"absolute",left:mx*cellSize,top:my*cellSize,width:mw*cellSize,height:mh*cellSize,
                  background:isT?"#10b98155":tq>0?"#10b9811a":"#10b9810a",
                  border:isT?"3px solid #fff":`1px solid ${tq>0?"#10b98166":"#10b98122"}`,borderRadius:4,
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  zIndex:isT?20:5,boxShadow:isT?"0 0 0 3px #10b981, 0 0 20px #10b98166":"none"}}>
                  <div className="mono" style={{fontSize:Math.max(8,Math.min(14,cellSize*0.5)),fontWeight:800,color:isT?"#fff":"#10b98166"}}>{p.id}</div>
                </div>
              );
            })}
          </div>
        </div>

        {posItems.length>1&&(
          <div style={{padding:12,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:12}}>
            <div style={{fontSize:11,color:"#94a3b8",fontWeight:600,marginBottom:6}}>En posición {targetPos}:</div>
            {posItems.map(it=>(
              <div key={it.sku} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12,
                fontWeight:it.sku===comp.skuOrigen?700:400,color:it.sku===comp.skuOrigen?"#fff":"#64748b"}}>
                <span className="mono">{it.sku}</span><span>{it.qty}</span>
              </div>
            ))}
          </div>
        )}

        <button onClick={()=>setPhase("scan")}
          style={{width:"100%",padding:18,borderRadius:14,fontWeight:700,fontSize:16,color:"#fff",
            background:"linear-gradient(135deg,#059669,#10b981)",cursor:"pointer",border:"none",boxShadow:"0 4px 20px #10b98133"}}>
          YA LO TENGO → VERIFICAR
        </button>
      </>)}

      {/* SCAN */}
      {phase==="scan"&&(<>
        <div style={{padding:16,background:"#06b6d415",border:"2px solid #06b6d444",borderRadius:14,marginBottom:12}}>
          <div style={{fontSize:15,fontWeight:700,color:"#06b6d4",marginBottom:8}}>Verifica escaneando</div>
          <div style={{fontSize:12,color:"#94a3b8"}}>Escanea el código de barras del producto.</div>
        </div>

        <BarcodeScanner active={true} onScan={handleScan} label="Escanea producto" mode="barcode" placeholder="Código ML o SKU..."/>

        {scanResult==="error"&&(
          <div style={{padding:16,background:"#ef444422",border:"2px solid #ef4444",borderRadius:12,marginBottom:12,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>&#10060;</div>
            <div style={{fontSize:16,fontWeight:700,color:"#ef4444"}}>CODIGO INCORRECTO</div>
            <div style={{fontSize:13,color:"#94a3b8",marginTop:4}}>Escaneaste: <strong style={{fontFamily:"monospace",color:"#ef4444"}}>{scanCode}</strong></div>
            <div style={{fontSize:13,color:"#f59e0b",marginTop:8,fontWeight:600}}>Verifica que tomaste el producto correcto</div>
            <button onClick={()=>{setScanResult(null);setScanCode("");}}
              style={{marginTop:12,padding:"10px 24px",borderRadius:8,background:"var(--bg3)",color:"#06b6d4",fontWeight:700,fontSize:13,border:"1px solid var(--bg4)"}}>
              Intentar de nuevo
            </button>
          </div>
        )}

        {scanResult==="ok"&&(
          <div style={{padding:16,background:"#10b98122",border:"2px solid #10b981",borderRadius:12,textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>✅</div>
            <div style={{fontSize:16,fontWeight:700,color:"#10b981"}}>{saving?"Guardando...":"¡CORRECTO!"}</div>
          </div>
        )}

        <button onClick={async()=>{setSaving(true);await pickearLineaFull(session.id!,linea.id,operario,session);setSaving(false);setPhase("done");setTimeout(onDone,800);}} disabled={saving}
          style={{width:"100%",marginTop:16,padding:10,borderRadius:8,background:"transparent",color:"#64748b",fontSize:11,border:"1px dashed #64748b44"}}>
          Confirmar sin escanear
        </button>
        <button onClick={()=>setPhase("locate")}
          style={{width:"100%",marginTop:8,padding:10,borderRadius:8,background:"var(--bg3)",color:"#94a3b8",fontSize:13,fontWeight:600,border:"1px solid var(--bg4)"}}>
          ← Volver a ubicación
        </button>
      </>)}
    </div>
  );
}
