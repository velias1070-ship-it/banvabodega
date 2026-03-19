"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, fmtDate, fmtTime, fmtMoney, findProduct, getSkusVenta, getComponentesPorSkuVenta, getVentasPorSkuOrigen, buildPickingLineas, crearPickingSession, getPickingsByDate, getActivePickings, actualizarPicking, eliminarPicking, findSkuVenta, recordMovementAsync, skuTotal, skuPositions, despickearComponente, buildPickingLineasFull, getSkuFisicoPorSkuVenta, refreshStore, getNotasOperativas } from "@/lib/store";
import type { Product, DBPickingSession, PickingLinea, ComposicionVenta } from "@/lib/store";
import { fetchActiveFlexShipments, fetchMovimientosBySku } from "@/lib/db";
import type { ShipmentWithItems } from "@/lib/db";

function AdminPicking({ refresh }: { refresh: () => void }) {
  const [sessions, setSessions] = useState<DBPickingSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selSession, setSelSession] = useState<DBPickingSession | null>(null);

  const loadSessions = async () => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    const active = await getActivePickings();
    const todaySessions = await getPickingsByDate(today);
    // Merge unique
    const map = new Map<string, DBPickingSession>();
    [...active, ...todaySessions].forEach(s => { if (s.id) map.set(s.id, s); });
    setSessions(Array.from(map.values()).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")));
    setLoading(false);
  };

  useEffect(() => { loadSessions(); }, []);

  if (selSession) {
    return <PickingSessionDetail session={selSession} onBack={() => { setSelSession(null); loadSessions(); }}/>;
  }

  if (showCreate) {
    return <CreatePickingSession onCreated={() => { setShowCreate(false); loadSessions(); }} onCancel={() => setShowCreate(false)}/>;
  }

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <h2 style={{fontSize:18,fontWeight:700,margin:0}}>Picking Flex</h2>
          <p style={{fontSize:12,color:"var(--txt3)",margin:0}}>Sesiones de picking diario para envíos Flex</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadSessions} disabled={loading} style={{padding:"8px 14px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {loading ? "..." : "🔄"}
          </button>
          <button onClick={() => setShowCreate(true)} style={{padding:"8px 18px",borderRadius:8,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none"}}>
            + Nueva sesión
          </button>
        </div>
      </div>

      {sessions.length === 0 && !loading && (
        <div style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:8}}>🏷️</div>
          <div style={{fontSize:14,fontWeight:600}}>No hay sesiones de picking</div>
          <div style={{fontSize:12,marginTop:4}}>Crea una nueva para el picking del día</div>
        </div>
      )}

      {sessions.map(sess => {
        const totalComps = sess.lineas.reduce((s, l) => s + l.componentes.length, 0);
        const doneComps = sess.lineas.reduce((s, l) => s + l.componentes.filter(c => c.estado === "PICKEADO").length, 0);
        const pct = totalComps > 0 ? Math.round((doneComps / totalComps) * 100) : 0;
        const totalUnits = sess.lineas.reduce((s, l) => s + l.componentes.reduce((s2, c) => s2 + c.unidades, 0), 0);

        return (
          <div key={sess.id} onClick={() => setSelSession(sess)}
            style={{padding:16,marginBottom:8,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>Picking {sess.fecha}</div>
                <div style={{fontSize:12,color:"var(--txt3)"}}>{sess.lineas.length} pedidos · {totalUnits} unidades · {doneComps}/{totalComps} items</div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,fontSize:10,fontWeight:700,
                background: pct === 100 ? "var(--greenBg)" : pct > 0 ? "var(--amberBg)" : "var(--redBg)",
                color: pct === 100 ? "var(--green)" : pct > 0 ? "var(--amber)" : "var(--red)"}}>
                {sess.estado === "COMPLETADA" ? "✅ COMPLETADA" : pct > 0 ? `${pct}%` : "PENDIENTE"}
              </div>
            </div>
            <div style={{marginTop:8,background:"var(--bg3)",borderRadius:4,height:4,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background:pct===100?"var(--green)":"var(--amber)",borderRadius:4}}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== CREATE PICKING SESSION ====================
// ==================== PRODUCT SEARCH FOR PICKING ====================
function PickingProductSearch({ onAdd }: { onAdd: (skuVenta: string, qty: number) => void }) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState(1);
  const [results, setResults] = useState<{ skuVenta: string; codigoMl: string; nombre: string; componentes: { skuVenta: string; codigoMl: string; skuOrigen: string; unidades: number }[] }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.length >= 2) {
      setResults(findSkuVenta(q));
    } else {
      setResults([]);
    }
  }, [q]);

  const handleAdd = (skuVenta: string) => {
    onAdd(skuVenta, qty);
    setQ("");
    setQty(1);
    setResults([]);
    inputRef.current?.focus();
  };

  return (
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <input ref={inputRef} className="form-input" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Buscar producto por nombre o SKU..."
          style={{flex:1,fontSize:13,padding:10}}/>
        <div style={{display:"flex",alignItems:"center",gap:4,background:"var(--bg3)",borderRadius:8,padding:"0 8px",border:"1px solid var(--bg4)"}}>
          <button onClick={() => setQty(Math.max(1, qty - 1))}
            style={{width:24,height:24,borderRadius:4,background:"var(--bg4)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"22px"}}>−</button>
          <input type="number" inputMode="numeric" min={1} className="mono" value={qty}
            onFocus={e => e.target.select()}
            onChange={e => { const v = parseInt(e.target.value); setQty(v > 0 ? v : 1); }}
            style={{width:40,fontSize:14,fontWeight:700,color:"var(--blue)",textAlign:"center",background:"transparent",border:"none",outline:"none",padding:0}}/>
          <button onClick={() => setQty(qty + 1)}
            style={{width:24,height:24,borderRadius:4,background:"var(--bg4)",color:"var(--txt2)",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"22px"}}>+</button>
        </div>
      </div>

      {results.length > 0 && (
        <div style={{maxHeight:250,overflow:"auto",borderRadius:8,border:"1px solid var(--bg4)",background:"var(--bg)"}}>
          {results.map(r => (
            <button key={r.skuVenta} onClick={() => handleAdd(r.skuVenta)}
              style={{width:"100%",textAlign:"left",padding:"10px 12px",border:"none",borderBottom:"1px solid var(--bg3)",
                background:"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.nombre}</div>
                <div style={{fontSize:11,color:"var(--txt3)",display:"flex",gap:8}}>
                  <span className="mono">{r.skuVenta}</span>
                  {r.componentes.length > 1 && <span>({r.componentes.length} componentes)</span>}
                </div>
              </div>
              <div style={{padding:"4px 10px",borderRadius:6,background:"var(--greenBg)",color:"var(--green)",fontSize:11,fontWeight:700,flexShrink:0}}>
                + {qty}
              </div>
            </button>
          ))}
        </div>
      )}

      {q.length >= 2 && results.length === 0 && (
        <div style={{textAlign:"center",padding:12,color:"var(--txt3)",fontSize:12}}>
          Sin resultados para &quot;{q}&quot;
        </div>
      )}
    </div>
  );
}

function CreatePickingSession({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [raw, setRaw] = useState("");
  const [fecha, setFecha] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<{ lineas: PickingLinea[]; errors: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [inputMode, setInputMode] = useState<"search" | "text">("search");
  const [searchOrders, setSearchOrders] = useState<{ skuVenta: string; qty: number; nombre: string }[]>([]);

  const parseOrders = () => {
    let orders: { skuVenta: string; qty: number }[] = [];

    if (inputMode === "text") {
      const lines = raw.trim().split("\n").filter(l => l.trim());
      for (const line of lines) {
        const parts = line.trim().split(/[\s,;\t]+/);
        const sku = parts[0]?.trim();
        const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
        if (sku) orders.push({ skuVenta: sku, qty });
      }
    } else {
      orders = searchOrders.map(o => ({ skuVenta: o.skuVenta, qty: o.qty }));
    }

    const result = buildPickingLineas(orders);
    setPreview(result);
  };

  const handleSearchAdd = (skuVenta: string, qty: number) => {
    // If already in list, increment qty
    const existing = searchOrders.find(o => o.skuVenta === skuVenta);
    if (existing) {
      setSearchOrders(searchOrders.map(o => o.skuVenta === skuVenta ? { ...o, qty: o.qty + qty } : o));
    } else {
      const found = findSkuVenta(skuVenta);
      const nombre = found.find(f => f.skuVenta === skuVenta)?.nombre || skuVenta;
      setSearchOrders([...searchOrders, { skuVenta, qty, nombre }]);
    }
    setPreview(null);
  };

  const removeSearchOrder = (skuVenta: string) => {
    setSearchOrders(searchOrders.filter(o => o.skuVenta !== skuVenta));
    setPreview(null);
  };

  const updateSearchOrderQty = (skuVenta: string, newQty: number) => {
    if (newQty < 1) return;
    setSearchOrders(searchOrders.map(o => o.skuVenta === skuVenta ? { ...o, qty: newQty } : o));
    setPreview(null);
  };

  const doCreate = async () => {
    if (!preview || preview.lineas.length === 0) return;
    setSaving(true);
    const id = await crearPickingSession(fecha, preview.lineas);
    setSaving(false);
    if (id) {
      onCreated();
    } else {
      alert("Error al crear la sesión de picking. Verificar que la tabla picking_sessions tenga las columnas 'tipo' y 'titulo' (ejecutar migración v10).");
    }
  };

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h2 style={{fontSize:18,fontWeight:700,margin:0}}>Nueva sesión de picking</h2>
        <button onClick={onCancel} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {/* Left: Input */}
        <div>
          <div style={{marginBottom:12}}>
            <label style={{fontSize:12,fontWeight:600,color:"var(--txt3)",display:"block",marginBottom:4}}>Fecha de picking</label>
            <input type="date" className="form-input" value={fecha} onChange={e => setFecha(e.target.value)} style={{fontSize:14,padding:10}}/>
          </div>

          {/* Mode toggle */}
          <div style={{display:"flex",gap:4,marginBottom:12,background:"var(--bg3)",borderRadius:8,padding:3}}>
            <button onClick={() => setInputMode("search")}
              style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
                background:inputMode==="search"?"var(--blue)":"transparent",
                color:inputMode==="search"?"#fff":"var(--txt3)"}}>
              Buscar producto
            </button>
            <button onClick={() => setInputMode("text")}
              style={{flex:1,padding:"8px 12px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
                background:inputMode==="text"?"var(--blue)":"transparent",
                color:inputMode==="text"?"#fff":"var(--txt3)"}}>
              Pegar texto
            </button>
          </div>

          {inputMode === "search" ? (
            <div>
              <PickingProductSearch onAdd={handleSearchAdd}/>

              {/* Search orders list */}
              {searchOrders.length > 0 && (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--txt3)",marginBottom:6}}>Pedidos agregados ({searchOrders.length}):</div>
                  <div style={{maxHeight:300,overflow:"auto"}}>
                    {searchOrders.map(o => (
                      <div key={o.skuVenta} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",marginBottom:4,
                        borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)"}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.nombre}</div>
                          <div className="mono" style={{fontSize:11,color:"var(--txt3)"}}>{o.skuVenta}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <button onClick={() => updateSearchOrderQty(o.skuVenta, o.qty - 1)}
                            style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>−</button>
                          <span className="mono" style={{fontSize:13,fontWeight:700,color:"var(--blue)",minWidth:20,textAlign:"center"}}>{o.qty}</span>
                          <button onClick={() => updateSearchOrderQty(o.skuVenta, o.qty + 1)}
                            style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>+</button>
                        </div>
                        <button onClick={() => removeSearchOrder(o.skuVenta)}
                          style={{width:22,height:22,borderRadius:4,background:"var(--redBg)",color:"var(--red)",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",lineHeight:"20px"}}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={parseOrders} disabled={searchOrders.length === 0}
                style={{width:"100%",padding:12,borderRadius:8,background:"var(--blue)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:searchOrders.length===0?0.4:1}}>
                Vista previa
              </button>
            </div>
          ) : (
            <div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:12,fontWeight:600,color:"var(--txt3)",display:"block",marginBottom:4}}>
                  Pedidos (SKU Venta + Cantidad, uno por línea)
                </label>
                <textarea className="form-input mono" value={raw} onChange={e => setRaw(e.target.value)}
                  placeholder={"TXV23QLAT25BE 1\nSAB180BL-PK2 2\nJUE2PCAM15GR 1"}
                  rows={12} style={{fontSize:12,lineHeight:1.6,resize:"vertical"}}/>
                <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>
                  Formato: <code>SKU_VENTA CANTIDAD</code> — Si no pones cantidad, asume 1.<br/>
                  Separadores válidos: espacio, tab, coma, punto y coma.
                </div>
              </div>

              <button onClick={parseOrders}
                style={{width:"100%",padding:12,borderRadius:8,background:"var(--blue)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer"}}>
                Vista previa
              </button>
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div>
          {!preview && (
            <div style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
              <div style={{fontSize:32,marginBottom:8}}>{inputMode === "search" ? "🔍" : "👈"}</div>
              <div style={{fontSize:13}}>{inputMode === "search" ? "Busca productos y agrégalos a la lista" : "Pega los pedidos y haz clic en \"Vista previa\""}</div>
            </div>
          )}

          {preview && (
            <div>
              <div style={{marginBottom:12,display:"flex",gap:12}}>
                <div style={{padding:"8px 14px",borderRadius:8,background:"var(--greenBg)",color:"var(--green)",fontSize:13,fontWeight:700}}>
                  {preview.lineas.length} pedidos OK
                </div>
                {preview.errors.length > 0 && (
                  <div style={{padding:"8px 14px",borderRadius:8,background:"var(--amberBg)",color:"var(--amber)",fontSize:13,fontWeight:700}}>
                    {preview.errors.length} advertencias
                  </div>
                )}
              </div>

              {/* Errors */}
              {preview.errors.length > 0 && (
                <div style={{padding:12,background:"var(--amberBg)",borderRadius:8,marginBottom:12,maxHeight:150,overflow:"auto"}}>
                  {preview.errors.map((e, i) => (
                    <div key={i} style={{fontSize:11,color:"var(--amber)",padding:"2px 0"}}>{e}</div>
                  ))}
                </div>
              )}

              {/* Lines */}
              <div style={{maxHeight:400,overflow:"auto"}}>
                {preview.lineas.map(linea => (
                  <div key={linea.id} style={{padding:10,marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span className="mono" style={{fontWeight:700,fontSize:12}}>{linea.skuVenta}</span>
                      <span style={{fontSize:11,color:"var(--txt3)"}}>×{linea.qtyPedida}</span>
                    </div>
                    {linea.componentes.map((comp, ci) => (
                      <div key={ci} style={{display:"flex",justifyContent:"space-between",fontSize:11,padding:"2px 0",color:"var(--txt2)"}}>
                        <span>{comp.nombre?.slice(0, 35) || comp.skuOrigen}</span>
                        <span>
                          <strong style={{color:"var(--green)"}}>{comp.posicion}</strong>
                          {" · "}{comp.unidades} uds
                          {comp.stockDisponible < comp.unidades && <span style={{color:"var(--red)"}}> bajo stock</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {preview.lineas.length > 0 && (
                <button onClick={doCreate} disabled={saving}
                  style={{width:"100%",marginTop:12,padding:14,borderRadius:10,background:"var(--green)",color:"#fff",fontSize:14,fontWeight:700,border:"none",cursor:"pointer",opacity:saving?0.6:1}}>
                  {saving ? "Creando..." : `Crear sesión — ${preview.lineas.length} pedidos`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== PICKING SESSION DETAIL ====================
function PickingSessionDetail({ session: initialSession, onBack }: { session: DBPickingSession; onBack: () => void }) {
  const [session, setSession] = useState<DBPickingSession>(initialSession);
  const [editing, setEditing] = useState(false);
  const [addRaw, setAddRaw] = useState("");
  const [addMode, setAddMode] = useState<"search" | "text">("search");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const isFull = session.tipo === "envio_full";
  const totalComps = session.lineas.reduce((s, l) => s + l.componentes.length, 0);
  const doneComps = session.lineas.reduce((s, l) => s + l.componentes.filter(c => c.estado === "PICKEADO").length, 0);
  const pct = totalComps > 0 ? Math.round((doneComps / totalComps) * 100) : 0;

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  // Exportar CSV para envio_full
  const exportCSV = () => {
    // Agrupar por SKU Venta con unidades de venta
    const skuMap = new Map<string, number>();
    for (const l of session.lineas) {
      const qty = l.qtyVenta || l.qtyPedida;
      skuMap.set(l.skuVenta, (skuMap.get(l.skuVenta) || 0) + qty);
    }

    let csv = "SKU Venta;Unidades\n";
    Array.from(skuMap.entries()).forEach(([sku, qty]) => {
      csv += `${sku};${qty}\n`;
    });

    // Agregar sección de bultos desde líneas inline
    const lineasConBultos = session.lineas.filter(l => l.bultos !== null && l.bultos !== undefined);
    if (lineasConBultos.length > 0) {
      csv += "\nSKU Venta;Posición;Uds;Bultos Cerrados;Compartido Con\n";
      for (const l of lineasConBultos) {
        csv += `${l.skuVenta};${l.componentes[0]?.posicion || "?"};${l.qtyFisica || l.qtyPedida};${l.bultos};${l.bultoCompartido || ""}\n`;
      }
    }

    const fecha = new Date().toISOString().slice(0, 10);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `envio_full_${fecha}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV exportado");
  };

  const doDelete = async () => {
    if (!confirm("¿Eliminar esta sesión de picking completa?")) return;
    await eliminarPicking(session.id!);
    onBack();
  };

  // Regenerar líneas pendientes con multi-posición
  const regenerarLineas = async () => {
    // Agrupar SKUs pendientes por skuVenta sumando cantidades
    const pendientes = session.lineas.filter(l => l.estado !== "PICKEADO");
    const pickeadas = session.lineas.filter(l => l.estado === "PICKEADO");
    if (pendientes.length === 0) { showToast("No hay líneas pendientes para regenerar"); return; }

    // Refrescar store para tener stock actualizado antes de recalcular posiciones
    await refreshStore();

    const skuMap = new Map<string, number>();
    for (const l of pendientes) {
      const key = l.skuVenta;
      skuMap.set(key, (skuMap.get(key) || 0) + (l.qtyFisica || l.qtyPedida));
    }

    const orders = Array.from(skuMap.entries()).map(([skuVenta, qty]) => ({ skuVenta, qty }));
    const result = buildPickingLineas(orders);

    // Re-numerar desde el máximo existente
    const prefix = isFull ? "F" : "P";
    const maxNum = pickeadas.reduce((max, l) => {
      const n = parseInt(l.id.replace(/^[A-Z]/, "")) || 0;
      return Math.max(max, n);
    }, 0);
    const newLineas = result.lineas.map((l, i) => ({ ...l, id: `${prefix}${String(maxNum + i + 1).padStart(3, "0")}` }));

    const allLineas = [...pickeadas, ...newLineas];
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: allLineas });
    setSession({ ...session, lineas: allLineas });
    setSaving(false);
    showToast(`Regeneradas ${newLineas.length} líneas (${pendientes.length} → ${newLineas.length} con multi-posición)`);
    if (result.errors.length > 0) alert("Advertencias:\n" + result.errors.join("\n"));
  };

  // Reparar datos de picking: restaura posiciones "?", cantidades 0, bultos y armado faltantes
  // Fuentes de datos:
  // 1. Otras sesiones de picking completadas del mismo tipo (tiene bultos, armado, etc)
  // 2. Movimientos de salida (venta_flex / envio_full) — tiene posición, qty, operario
  const repararPosiciones = async () => {
    await refreshStore();

    // Detect lines that need repair: position "?", qty 0, missing bultos/armado
    const needsRepair = (l: PickingLinea) => {
      const comp = l.componentes[0];
      if (!comp) return false;
      if (comp.posicion === "?") return true;
      if (comp.unidades === 0 || l.qtyPedida === 0) return true;
      if (isFull && (l.bultos === undefined || l.bultos === null)) return true;
      if (isFull && l.tipoFull && l.tipoFull !== "simple" && (!l.estadoArmado || l.estadoArmado === "PENDIENTE") && l.estado === "PICKEADO") return true;
      return false;
    };

    const lineasParaReparar = session.lineas.filter(needsRepair);
    if (lineasParaReparar.length === 0) { showToast("No hay líneas para reparar"); return; }

    setSaving(true);

    // --- Source 1: Other completed picking sessions ---
    const sb = (await import("@/lib/supabase")).getSupabase();
    const otherSessionLines: PickingLinea[] = [];
    if (sb) {
      const { data: otherSessions } = await sb
        .from("picking_sessions")
        .select("id, lineas, tipo")
        .eq("tipo", session.tipo || "flex")
        .in("estado", ["COMPLETADA", "COMPLETADO", "EN_PROCESO"])
        .neq("id", session.id || "")
        .order("created_at", { ascending: false })
        .limit(50);

      if (otherSessions) {
        for (const os of otherSessions) {
          const lineas = (os.lineas || []) as PickingLinea[];
          for (const l of lineas) {
            if (l.estado === "PICKEADO" && l.componentes[0]?.posicion && l.componentes[0]?.posicion !== "?") {
              otherSessionLines.push(l);
            }
          }
        }
      }
    }

    // Index by skuVenta for lookup
    const sessionLinesBySkuVenta = new Map<string, PickingLinea[]>();
    for (const l of otherSessionLines) {
      if (!sessionLinesBySkuVenta.has(l.skuVenta)) sessionLinesBySkuVenta.set(l.skuVenta, []);
      sessionLinesBySkuVenta.get(l.skuVenta)!.push(l);
    }
    const sessionLineUsado = new Set<number>(); // index-based tracking

    // --- Source 2: Movements ---
    const skusToSearch = new Set<string>();
    for (const l of session.lineas) {
      const comp = l.componentes[0];
      if (comp) {
        skusToSearch.add(comp.skuOrigen);
        const compsVenta = getComponentesPorSkuVenta(l.skuVenta);
        for (const c of compsVenta) skusToSearch.add(c.skuOrigen);
      }
    }

    const allMovs: { sku: string; pos: string; qty: number; operario: string; ts: string; skuVenta: string; idx: number }[] = [];
    let movIdx = 0;
    for (const sku of Array.from(skusToSearch)) {
      const movs = await fetchMovimientosBySku(sku);
      for (const m of movs) {
        if (m.tipo !== "salida") continue;
        if (m.motivo !== "venta_flex" && m.motivo !== "envio_full") continue;
        let skuVenta: string | null = null;
        const matchFlex = m.nota?.match(/Picking Flex:\s*(\S+)/);
        const matchFull = m.nota?.match(/Envío Full:\s*(\S+)/);
        if (matchFlex) skuVenta = matchFlex[1];
        else if (matchFull) skuVenta = matchFull[1];
        if (!skuVenta) continue;
        allMovs.push({
          sku: m.sku, pos: m.posicion_id, qty: Math.abs(m.cantidad),
          operario: m.operario, ts: m.created_at || "",
          skuVenta, idx: movIdx++,
        });
      }
    }

    // Track which movements are consumed by lines that are already OK (not needing repair)
    const movUsado = new Map<string, number>();
    for (const l of session.lineas) {
      if (!needsRepair(l) && l.estado === "PICKEADO" && l.componentes[0]?.posicion !== "?") {
        const comp = l.componentes[0];
        if (comp && comp.unidades > 0) {
          const key = `${l.skuVenta}:${comp.skuOrigen}:${comp.posicion}`;
          movUsado.set(key, (movUsado.get(key) || 0) + comp.unidades);
        }
      }
    }

    let reparadas = 0;
    let sinEvidencia = 0;
    const newLineas = [...session.lineas];

    for (const linea of newLineas) {
      if (!needsRepair(linea)) continue;
      const comp = linea.componentes[0];
      if (!comp) continue;

      const needsPos = comp.posicion === "?";
      const needsQty = comp.unidades === 0 || linea.qtyPedida === 0;

      // Strategy 1: Try matching line from other completed sessions
      let foundInSession = false;
      const sessionCandidates = sessionLinesBySkuVenta.get(linea.skuVenta) || [];
      for (let si = 0; si < sessionCandidates.length; si++) {
        const globalIdx = otherSessionLines.indexOf(sessionCandidates[si]);
        if (sessionLineUsado.has(globalIdx)) continue;
        const cand = sessionCandidates[si];
        const candComp = cand.componentes[0];
        if (!candComp) continue;

        // If we need position, candidate must have a matching sku
        if (needsPos && candComp.skuOrigen !== comp.skuOrigen) {
          // Also check if it matches any component
          const compsVenta = getComponentesPorSkuVenta(linea.skuVenta);
          if (!compsVenta.some(c => c.skuOrigen === candComp.skuOrigen)) continue;
        }

        // Copy position data
        if (needsPos) {
          const posObj = getStore().positions.find(p => p.id === candComp.posicion);
          comp.skuOrigen = candComp.skuOrigen;
          comp.nombre = candComp.nombre || getStore().products[candComp.skuOrigen]?.name || candComp.skuOrigen;
          comp.posicion = candComp.posicion;
          comp.posLabel = posObj?.label || candComp.posLabel || candComp.posicion;
          comp.estado = "PICKEADO";
          comp.pickedAt = candComp.pickedAt;
          comp.operario = candComp.operario;
          linea.estado = "PICKEADO";
        }
        // Copy qty if missing
        if (needsQty && candComp.unidades > 0) {
          comp.unidades = candComp.unidades;
          linea.qtyPedida = cand.qtyPedida || candComp.unidades;
          if (isFull) linea.qtyFisica = cand.qtyFisica || candComp.unidades;
        }
        // Copy Full-specific fields
        if (isFull) {
          if (cand.bultos !== undefined && cand.bultos !== null) linea.bultos = cand.bultos;
          if (cand.bultoCompartido !== undefined) linea.bultoCompartido = cand.bultoCompartido;
          if (cand.estadoArmado) linea.estadoArmado = cand.estadoArmado;
          if (cand.qtyFisica && cand.qtyFisica > 0) linea.qtyFisica = cand.qtyFisica;
          if (cand.qtyVenta && cand.qtyVenta > 0) linea.qtyVenta = cand.qtyVenta;
          if (cand.tipoFull) linea.tipoFull = cand.tipoFull;
          if (cand.unidadesPorPack) linea.unidadesPorPack = cand.unidadesPorPack;
          if (cand.posicionOrden !== undefined) linea.posicionOrden = cand.posicionOrden;
          if (cand.instruccionArmado !== undefined) linea.instruccionArmado = cand.instruccionArmado;
        }
        // Copy operario if missing
        if (!comp.operario && candComp.operario) comp.operario = candComp.operario;

        sessionLineUsado.add(globalIdx);
        reparadas++;
        foundInSession = true;
        break;
      }

      if (foundInSession) continue;

      // Strategy 2: Fallback to movements
      const movs = allMovs.filter(m => m.skuVenta === linea.skuVenta);
      let foundMov = false;
      for (const mov of movs) {
        const usadoKey = `${linea.skuVenta}:${mov.sku}:${mov.pos}`;
        const yaUsado = movUsado.get(usadoKey) || 0;
        const disponible = mov.qty - yaUsado;
        if (disponible <= 0) continue;

        const posObj = getStore().positions.find(p => p.id === mov.pos);

        // Restore position
        if (needsPos || comp.posicion === mov.pos) {
          comp.skuOrigen = mov.sku;
          comp.nombre = getStore().products[mov.sku]?.name || mov.sku;
          comp.posicion = mov.pos;
          comp.posLabel = posObj?.label || mov.pos;
          comp.estado = "PICKEADO";
          comp.pickedAt = mov.ts;
          comp.operario = mov.operario;
          linea.estado = "PICKEADO";
        }

        // Restore qty from movement
        if (needsQty) {
          comp.unidades = mov.qty;
          linea.qtyPedida = mov.qty;
          if (isFull) linea.qtyFisica = mov.qty;
        }

        // Restore operario
        if (!comp.operario) comp.operario = mov.operario;

        movUsado.set(usadoKey, yaUsado + (comp.unidades || mov.qty));
        reparadas++;
        foundMov = true;
        break;
      }
      if (!foundMov) sinEvidencia++;
    }

    if (reparadas === 0 && sinEvidencia > 0) {
      setSaving(false);
      const skuList = lineasParaReparar.map(l => l.skuVenta).join(", ");
      showToast(`No se encontró evidencia para ${sinEvidencia} líneas`);
      alert(`No se encontraron datos en sesiones ni movimientos para:\n${skuList}\n\nSesiones consultadas: ${otherSessionLines.length} líneas\nMovimientos encontrados: ${allMovs.length}`);
      return;
    }

    const allDone = newLineas.length > 0 && newLineas.every(l => l.estado === "PICKEADO");
    const allArmado = isFull ? newLineas.every(l => !l.estadoArmado || l.estadoArmado === "COMPLETADO") : true;
    const sessionDone = allDone && allArmado;
    await actualizarPicking(session.id!, { lineas: newLineas, ...(sessionDone ? { estado: "COMPLETADA", completado_at: new Date().toISOString() } : {}) });
    setSession({ ...session, lineas: newLineas, ...(sessionDone ? { estado: "COMPLETADA" } : {}) });
    setSaving(false);
    const parts: string[] = [];
    if (reparadas > 0) parts.push(`${reparadas} líneas reparadas`);
    if (sinEvidencia > 0) parts.push(`${sinEvidencia} sin evidencia`);
    if (sessionDone) parts.push("Sesión completada");
    showToast(parts.join(" · "));
  };

  // Remove a single line
  const removeLine = async (lineaId: string) => {
    const linea = session.lineas.find(l => l.id === lineaId);
    if (linea?.estado === "PICKEADO") {
      if (!confirm("Esta línea ya fue pickeada. ¿Eliminar de todas formas? (no revierte el stock)")) return;
    }
    const newLineas = session.lineas.filter(l => l.id !== lineaId);
    setSaving(true);
    const allDone = newLineas.length > 0 && newLineas.every(l => l.estado === "PICKEADO");
    await actualizarPicking(session.id!, {
      lineas: newLineas,
      estado: newLineas.length === 0 ? "ABIERTA" : allDone ? "COMPLETADA" : session.estado,
    });
    setSession({ ...session, lineas: newLineas });
    setSaving(false);
    showToast(`Línea ${lineaId} eliminada`);
  };

  // Change quantity of a line (pending: rebuild components, picked: adjust qty directly)
  const changeQty = async (lineaId: string, newQty: number) => {
    if (newQty < 1) return;
    const linea = session.lineas.find(l => l.id === lineaId);
    if (!linea) return;

    if (linea.estado === "PICKEADO") {
      // For picked lines: adjust qty/unidades directly without rebuilding
      const newLineas = session.lineas.map(l => {
        if (l.id !== lineaId) return l;
        const comp = { ...l.componentes[0] };
        if (comp) comp.unidades = newQty;
        return { ...l, qtyPedida: newQty, qtyFisica: newQty, componentes: comp ? [comp, ...l.componentes.slice(1)] : l.componentes };
      });
      setSaving(true);
      await actualizarPicking(session.id!, { lineas: newLineas });
      setSession({ ...session, lineas: newLineas });
      setSaving(false);
      showToast(`Cantidad ajustada a ${newQty}`);
    } else {
      // For pending lines: rebuild components with new positions
      await refreshStore();
      const newLineas = session.lineas.map(l => {
        if (l.id !== lineaId) return l;
        const result = buildPickingLineas([{ skuVenta: l.skuVenta, qty: newQty }]);
        if (result.lineas.length === 0) return l;
        // Preserve Full-specific fields
        const rebuilt = result.lineas[0];
        if (isFull) {
          rebuilt.tipoFull = l.tipoFull;
          rebuilt.qtyVenta = l.qtyVenta;
          rebuilt.unidadesPorPack = l.unidadesPorPack;
          rebuilt.instruccionArmado = l.instruccionArmado;
          rebuilt.estadoArmado = l.estadoArmado;
          rebuilt.posicionOrden = l.posicionOrden;
        }
        return { ...rebuilt, id: l.id };
      });
      setSaving(true);
      await actualizarPicking(session.id!, { lineas: newLineas });
      setSession({ ...session, lineas: newLineas });
      setSaving(false);
      showToast("Cantidad actualizada");
    }
  };

  // Change bultos count on a picked Full line
  const changeBultos = async (lineaId: string, bultos: number) => {
    const newLineas = session.lineas.map(l => {
      if (l.id !== lineaId) return l;
      return { ...l, bultos };
    });
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: newLineas });
    setSession({ ...session, lineas: newLineas });
    setSaving(false);
  };

  // Change bultoCompartido on a line
  const changeBultoCompartido = async (lineaId: string, bultoCompartido: string | null) => {
    const newLineas = session.lineas.map(l => {
      if (l.id !== lineaId) return l;
      return { ...l, bultoCompartido };
    });
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: newLineas });
    setSession({ ...session, lineas: newLineas });
    setSaving(false);
  };

  // Reset a picked component (reverse stock)
  const resetComp = async (lineaId: string, compIdx: number) => {
    const linea = session.lineas.find(l => l.id === lineaId);
    if (!linea) return;
    const comp = linea.componentes[compIdx];
    if (!comp || comp.estado !== "PICKEADO") return;
    if (!confirm(`¿Reiniciar pick de ${comp.nombre || comp.skuOrigen}?\n\nSe devolverá ${comp.unidades} uds de stock a posición ${comp.posicion}.`)) return;
    setSaving(true);
    await despickearComponente(session.id!, lineaId, compIdx, "admin", session);
    // Refresh session
    const fresh = await getActivePickings();
    const updated = fresh.find(s => s.id === session.id);
    if (updated) setSession(updated);
    setSaving(false);
    showToast(`Pick reiniciado — stock devuelto a ${comp.posicion}`);
  };

  // Add new lines from text input
  const addLines = async () => {
    const lines = addRaw.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return;

    const orders: { skuVenta: string; qty: number }[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/[\s,;\t]+/);
      const sku = parts[0]?.trim();
      const qty = parts.length > 1 ? parseInt(parts[1]) || 1 : 1;
      if (sku) orders.push({ skuVenta: sku, qty });
    }

    const result = buildPickingLineas(orders);
    if (result.lineas.length === 0) {
      showToast("No se pudo agregar ninguna línea");
      return;
    }

    // Re-number new lines to continue from existing
    const prefix = isFull ? "F" : "P";
    const maxNum = session.lineas.reduce((max, l) => {
      const n = parseInt(l.id.replace(/^[A-Z]/, "")) || 0;
      return Math.max(max, n);
    }, 0);
    const newLineas = result.lineas.map((l, i) => ({ ...l, id: `${prefix}${String(maxNum + i + 1).padStart(3, "0")}` }));

    const allLineas = [...session.lineas, ...newLineas];
    setSaving(true);
    await actualizarPicking(session.id!, { lineas: allLineas, estado: "ABIERTA" });
    setSession({ ...session, lineas: allLineas, estado: "ABIERTA" });
    setSaving(false);
    setAddRaw("");
    setEditing(false);
    showToast(`+${newLineas.length} pedidos agregados`);

    if (result.errors.length > 0) {
      alert("Advertencias:\n" + result.errors.join("\n"));
    }
  };

  return (
    <div>
      {toast && (
        <div style={{position:"fixed",top:60,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
          border:"2px solid var(--green)",color:"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:13,fontWeight:700,boxShadow:"0 8px 30px rgba(0,0,0,0.5)"}}>
          {toast}
        </div>
      )}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <button onClick={onBack} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)"}}>← Volver</button>
        <div style={{display:"flex",gap:6}}>
          <button onClick={() => setEditing(!editing)} style={{padding:"6px 14px",borderRadius:6,background:editing?"var(--amberBg)":"var(--bg3)",color:editing?"var(--amber)":"var(--cyan)",fontSize:11,fontWeight:600,border:`1px solid ${editing?"var(--amber)33":"var(--bg4)"}`}}>
            {editing ? "✕ Cerrar edición" : "✏️ Editar"}
          </button>
          {editing && <button onClick={regenerarLineas} disabled={saving} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--blue)",fontSize:11,fontWeight:600,border:"1px solid var(--blue)33",cursor:"pointer"}}>
            🔄 Regenerar posiciones
          </button>}
          {editing && session.lineas.some(l => {
            const c = l.componentes[0];
            if (!c) return false;
            return c.posicion === "?" || c.unidades === 0 || l.qtyPedida === 0
              || (isFull && (l.bultos === undefined || l.bultos === null));
          }) && (
            <button onClick={repararPosiciones} disabled={saving} style={{padding:"6px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--amber)",fontSize:11,fontWeight:600,border:"1px solid var(--amber)33",cursor:"pointer"}}>
              🔧 Reparar datos picking
            </button>
          )}
          <button onClick={doDelete} style={{padding:"6px 14px",borderRadius:6,background:"var(--redBg)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--red)33"}}>Eliminar</button>
        </div>
      </div>

      {/* Header */}
      <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{fontSize:16,fontWeight:700}}>{isFull ? (session.titulo || "Envío a Full") : `Picking ${session.fecha}`}</div>
          {isFull && <span style={{padding:"2px 6px",borderRadius:4,fontSize:9,fontWeight:800,background:"#3b82f622",color:"#3b82f6",border:"1px solid #3b82f644"}}>FULL</span>}
          {isFull && (
            <button onClick={exportCSV} style={{padding:"4px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)",cursor:"pointer",marginLeft:4}}>
              📥 Exportar CSV
            </button>
          )}
        </div>
        <div style={{fontSize:12,color:"var(--txt3)"}}>Estado: <strong>{session.estado}</strong> · {session.lineas.length} {isFull ? "productos" : "pedidos"} · {doneComps}/{totalComps} items ({pct}%)</div>
        <div style={{marginTop:8,background:"var(--bg3)",borderRadius:4,height:6,overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:pct===100?"var(--green)":"var(--amber)",borderRadius:4}}/>
        </div>
      </div>

      {/* Add lines panel */}
      {editing && (
        <div style={{padding:16,background:"var(--bg2)",borderRadius:10,border:"2px solid var(--cyan)33",marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:700,color:"var(--cyan)",marginBottom:8}}>➕ Agregar pedidos</div>

          {/* Mode toggle */}
          <div style={{display:"flex",gap:4,marginBottom:12,background:"var(--bg3)",borderRadius:8,padding:3}}>
            <button onClick={() => setAddMode("search")}
              style={{flex:1,padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
                background:addMode==="search"?"var(--blue)":"transparent",
                color:addMode==="search"?"#fff":"var(--txt3)"}}>
              Buscar producto
            </button>
            <button onClick={() => setAddMode("text")}
              style={{flex:1,padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
                background:addMode==="text"?"var(--blue)":"transparent",
                color:addMode==="text"?"#fff":"var(--txt3)"}}>
              Pegar texto
            </button>
          </div>

          {addMode === "search" ? (
            <PickingProductSearch onAdd={(skuVenta, qty) => {
              const found = findSkuVenta(skuVenta);
              const nombre = found.find(f => f.skuVenta === skuVenta)?.nombre || skuVenta;
              // Add directly via addLines logic
              const result = buildPickingLineas([{ skuVenta, qty }]);
              if (result.lineas.length === 0) {
                showToast("Producto no encontrado en diccionario");
                return;
              }
              // Re-number with correct prefix
              const prefix = isFull ? "F" : "P";
              const maxNum = session.lineas.reduce((max, l) => {
                const n = parseInt(l.id.replace(/^[A-Z]/, "")) || 0;
                return Math.max(max, n);
              }, 0);
              const newLineas = result.lineas.map((l, i) => ({ ...l, id: `${prefix}${String(maxNum + i + 1).padStart(3, "0")}` }));
              const allLineas = [...session.lineas, ...newLineas];
              setSaving(true);
              actualizarPicking(session.id!, { lineas: allLineas, estado: "ABIERTA" }).then(() => {
                setSession({ ...session, lineas: allLineas, estado: "ABIERTA" });
                setSaving(false);
                showToast(`+ ${qty}× ${nombre}`);
                if (result.errors.length > 0) {
                  alert("Advertencias:\n" + result.errors.join("\n"));
                }
              });
            }}/>
          ) : (
            <>
              <textarea className="form-input mono" value={addRaw} onChange={e => setAddRaw(e.target.value)}
                placeholder={"TXV23QLAT25BE 1\nSAB180BL-PK2 2"} rows={4}
                style={{fontSize:12,lineHeight:1.6,resize:"vertical",marginBottom:8}}/>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addLines} disabled={saving || !addRaw.trim()}
                  style={{padding:"8px 18px",borderRadius:8,background:"var(--green)",color:"#fff",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",opacity:(!addRaw.trim()||saving)?0.4:1}}>
                  {saving ? "Guardando..." : "Agregar"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Lines table */}
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{borderBottom:"2px solid var(--bg3)"}}>
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>SKU Venta</th>
            {isFull && <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>Nota</th>}
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>Componente</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Pos</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Qty</th>
            <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Estado</th>
            {isFull && <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Armado</th>}
            {isFull && <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)"}}>Bultos</th>}
            <th style={{textAlign:"left",padding:"8px 6px",color:"var(--txt3)"}}>Operario</th>
            {editing && <th style={{textAlign:"center",padding:"8px 6px",color:"var(--txt3)",width:80}}>Acciones</th>}
          </tr>
        </thead>
        <tbody>
          {session.lineas.map(linea => {
            const isPicked = linea.estado === "PICKEADO";
            return linea.componentes.map((comp, ci) => (
              <tr key={linea.id + "-" + ci} style={{borderBottom:"1px solid var(--bg3)",background:comp.estado==="PICKEADO"?"var(--greenBg)":"transparent"}}>
                {ci === 0 && (
                  <td rowSpan={linea.componentes.length} className="mono" style={{padding:"8px 6px",fontWeight:700,verticalAlign:"top"}}>
                    {linea.skuVenta}
                    {isFull && linea.tipoFull && linea.tipoFull !== "simple" && (
                      <span style={{display:"block",fontSize:9,fontWeight:700,color:"var(--amber)",marginTop:2}}>
                        {linea.tipoFull === "pack" ? `PACK x${linea.unidadesPorPack}` : "COMBO"}
                      </span>
                    )}
                    <br/>
                    {editing ? (
                      <div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}>
                        <button onClick={() => changeQty(linea.id, (linea.qtyFisica || linea.qtyPedida) - 1)} disabled={(linea.qtyFisica || linea.qtyPedida) <= 1 || saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>−</button>
                        <span style={{fontSize:13,fontWeight:700,color:isPicked?"var(--green)":"var(--blue)",minWidth:20,textAlign:"center"}}>{linea.qtyFisica || linea.qtyPedida}</span>
                        <button onClick={() => changeQty(linea.id, (linea.qtyFisica || linea.qtyPedida) + 1)} disabled={saving}
                          style={{width:22,height:22,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"20px"}}>+</button>
                      </div>
                    ) : (
                      <span style={{fontSize:10,color:"var(--txt3)"}}>×{linea.qtyFisica || linea.qtyPedida}{isFull && linea.qtyVenta !== undefined && linea.qtyVenta !== linea.qtyPedida ? ` (${linea.qtyVenta} venta)` : ""}</span>
                    )}
                  </td>
                )}
                {isFull && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{padding:"8px 6px",verticalAlign:"top",maxWidth:120}}>
                    {(() => { const notas = getNotasOperativas(linea.skuVenta); return notas.length > 0 ? (
                      <span style={{fontSize:10,color:"var(--amber)",fontWeight:600}}>{notas.join(" | ")}</span>
                    ) : <span style={{fontSize:10,color:"var(--txt3)"}}>—</span>; })()}
                  </td>
                )}
                <td style={{padding:"8px 6px"}}>{comp.nombre?.slice(0, 30) || comp.skuOrigen}</td>
                <td style={{textAlign:"center",padding:"8px 6px"}}><span className="mono" style={{fontWeight:700,color:"var(--green)"}}>{comp.posicion}</span></td>
                <td style={{textAlign:"center",padding:"8px 6px"}} className="mono">{comp.unidades}</td>
                <td style={{textAlign:"center",padding:"8px 6px"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                    <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,
                      background:comp.estado==="PICKEADO"?"var(--greenBg)":"var(--amberBg)",
                      color:comp.estado==="PICKEADO"?"var(--green)":"var(--amber)"}}>
                      {comp.estado === "PICKEADO" ? "✅" : "⏳"}
                    </span>
                    {editing && comp.estado==="PICKEADO" && (
                      <button onClick={()=>resetComp(linea.id,ci)} disabled={saving} title="Reiniciar pick (devuelve stock)"
                        style={{padding:"2px 6px",borderRadius:4,background:"var(--amberBg)",color:"var(--amber)",fontSize:9,fontWeight:700,border:"1px solid var(--amberBd)",cursor:"pointer"}}>
                        ↩
                      </button>
                    )}
                  </div>
                </td>
                {isFull && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{textAlign:"center",padding:"8px 6px",verticalAlign:"top"}}>
                    {linea.estadoArmado === null || linea.estadoArmado === undefined ? (
                      <span style={{fontSize:10,color:"var(--txt3)"}}>—</span>
                    ) : (
                      <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,
                        background:linea.estadoArmado==="COMPLETADO"?"var(--greenBg)":"var(--amberBg)",
                        color:linea.estadoArmado==="COMPLETADO"?"var(--green)":"var(--amber)"}}>
                        {linea.estadoArmado === "COMPLETADO" ? "✅" : "⏳"}
                      </span>
                    )}
                  </td>
                )}
                {isFull && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{textAlign:"center",padding:"8px 6px",verticalAlign:"top",fontSize:11}}>
                    {editing ? (
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                        <div style={{display:"flex",alignItems:"center",gap:3}}>
                          <button onClick={() => changeBultos(linea.id, Math.max(0, (linea.bultos || 0) - 1))} disabled={saving || (linea.bultos || 0) <= 0}
                            style={{width:20,height:20,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"18px",padding:0}}>−</button>
                          <span className="mono" style={{fontWeight:700,color:"var(--cyan)",minWidth:16,textAlign:"center"}}>{linea.bultos ?? "—"}</span>
                          <button onClick={() => changeBultos(linea.id, (linea.bultos || 0) + 1)} disabled={saving}
                            style={{width:20,height:20,borderRadius:4,background:"var(--bg3)",color:"var(--txt2)",fontSize:11,fontWeight:700,border:"1px solid var(--bg4)",cursor:"pointer",lineHeight:"18px",padding:0}}>+</button>
                        </div>
                        {linea.bultos === 0 && (
                          <input
                            type="text" placeholder="comp. con..."
                            value={linea.bultoCompartido || ""}
                            onChange={e => changeBultoCompartido(linea.id, e.target.value || null)}
                            style={{width:70,fontSize:9,padding:"2px 4px",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:4,color:"var(--amber)",textAlign:"center"}}
                          />
                        )}
                      </div>
                    ) : (
                      linea.bultos !== null && linea.bultos !== undefined ? (
                        <div>
                          <span className="mono" style={{fontWeight:700,color:"var(--cyan)"}}>{linea.bultos}</span>
                          {linea.bultos === 0 && linea.bultoCompartido && (
                            <div style={{fontSize:9,color:"var(--amber)",marginTop:2}}>→ {linea.bultoCompartido}</div>
                          )}
                          {linea.bultos === 0 && !linea.bultoCompartido && (
                            <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>suelto</div>
                          )}
                        </div>
                      ) : (
                        <span style={{color:"var(--txt3)"}}>—</span>
                      )
                    )}
                  </td>
                )}
                <td style={{padding:"8px 6px",fontSize:11,color:"var(--txt3)"}}>{comp.operario || "—"}</td>
                {editing && ci === 0 && (
                  <td rowSpan={linea.componentes.length} style={{textAlign:"center",padding:"8px 6px",verticalAlign:"top"}}>
                    <button onClick={() => removeLine(linea.id)} disabled={saving}
                      style={{padding:"4px 10px",borderRadius:6,background:"var(--redBg)",color:"var(--red)",fontSize:11,fontWeight:700,border:"1px solid var(--red)33",cursor:"pointer"}}>
                      🗑️
                    </button>
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>

      {isFull && session.lineas.length > 0 && (() => {
        const totalBultos = session.lineas.reduce((s, l) => s + (l.bultos || 0), 0);
        const compartidas = session.lineas.filter(l => l.bultos === 0 && l.bultoCompartido);
        const sueltas = session.lineas.filter(l => l.bultos === 0 && !l.bultoCompartido && l.estado === "PICKEADO");

        // Agrupar por SKU venta: pedido vs pickeado
        const skuResumen = new Map<string, { pedido: number; pickeado: number; bultos: number; compartidas: string[]; tipoFull?: string; armadoPendiente: number; armadoCompletado: number }>();
        for (const l of session.lineas) {
          const existing = skuResumen.get(l.skuVenta) || { pedido: 0, pickeado: 0, bultos: 0, compartidas: [], armadoPendiente: 0, armadoCompletado: 0 };
          const qty = l.qtyFisica || l.qtyPedida || l.componentes[0]?.unidades || 0;
          existing.pedido += qty;
          if (l.estado === "PICKEADO") existing.pickeado += qty;
          existing.bultos += (l.bultos || 0);
          if (l.bultos === 0 && l.bultoCompartido) existing.compartidas.push(l.bultoCompartido);
          if (l.tipoFull) existing.tipoFull = l.tipoFull;
          if (l.estadoArmado === "COMPLETADO") existing.armadoCompletado++;
          else if (l.estadoArmado === "PENDIENTE") existing.armadoPendiente++;
          skuResumen.set(l.skuVenta, existing);
        }

        const totalPedido = session.lineas.reduce((s, l) => s + (l.qtyFisica || l.qtyPedida || l.componentes[0]?.unidades || 0), 0);
        const totalPickeado = session.lineas.filter(l => l.estado === "PICKEADO").reduce((s, l) => s + (l.qtyFisica || l.qtyPedida || l.componentes[0]?.unidades || 0), 0);
        const totalFalta = totalPedido - totalPickeado;
        const pctDone = totalPedido > 0 ? Math.round((totalPickeado / totalPedido) * 100) : 0;

        return (
          <div style={{padding:14,background:"var(--bg2)",borderRadius:10,border:"1px solid var(--bg3)",marginTop:14}}>
            {/* Barra de progreso */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <strong style={{fontSize:13,color:"var(--txt)"}}>Progreso</strong>
              <div style={{flex:1,height:8,background:"var(--bg4)",borderRadius:4,overflow:"hidden"}}>
                <div style={{width:`${pctDone}%`,height:"100%",background:pctDone===100?"var(--green)":"var(--cyan)",borderRadius:4,transition:"width 0.3s"}} />
              </div>
              <span className="mono" style={{fontSize:12,fontWeight:700,color:pctDone===100?"var(--green)":"var(--cyan)"}}>{pctDone}%</span>
            </div>

            {/* Resumen general */}
            <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:10,fontSize:11}}>
              <span>{session.lineas.length} líneas</span>
              <span>·</span>
              <span>{new Set(session.lineas.map(l => l.skuVenta)).size} SKUs</span>
              <span>·</span>
              <span style={{color:"var(--green)",fontWeight:700}}>{totalPickeado} pickeadas</span>
              {totalFalta > 0 && <><span>·</span><span style={{color:"var(--amber)",fontWeight:700}}>{totalFalta} faltan</span></>}
              {totalBultos > 0 && <><span>·</span><span style={{color:"var(--cyan)",fontWeight:700}}>📦 {totalBultos} bultos</span></>}
              {compartidas.length > 0 && <><span>·</span><span style={{color:"var(--amber)"}}>{compartidas.length} compartidas</span></>}
              {sueltas.length > 0 && <><span>·</span><span style={{color:"var(--txt3)"}}>{sueltas.length} sueltas</span></>}
            </div>

            {/* Tabla por SKU */}
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{borderBottom:"2px solid var(--bg4)"}}>
                  <th style={{textAlign:"left",padding:"4px 6px",color:"var(--txt3)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>SKU Venta</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--txt3)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Tipo</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--txt3)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Pedido</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--green)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Pickeado</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--amber)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Falta</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--cyan)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Bultos</th>
                  <th style={{textAlign:"center",padding:"4px 6px",color:"var(--txt3)",fontWeight:600,textTransform:"uppercase",fontSize:10}}>Armado</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(skuResumen.entries()).map(([sku, r]) => {
                  const falta = r.pedido - r.pickeado;
                  const done = falta === 0;
                  return (
                    <tr key={sku} style={{borderBottom:"1px solid var(--bg3)",background:done?"var(--greenBg)":"transparent"}}>
                      <td className="mono" style={{padding:"5px 6px",fontWeight:700}}>{sku}</td>
                      <td style={{textAlign:"center",padding:"5px 6px",fontSize:10,color:"var(--txt3)"}}>
                        {r.tipoFull === "pack" ? <span style={{color:"var(--amber)",fontWeight:700}}>PACK</span>
                          : r.tipoFull === "combo" ? <span style={{color:"var(--blue)",fontWeight:700}}>COMBO</span>
                          : "simple"}
                      </td>
                      <td className="mono" style={{textAlign:"center",padding:"5px 6px",fontWeight:600}}>{r.pedido}</td>
                      <td className="mono" style={{textAlign:"center",padding:"5px 6px",fontWeight:700,color:"var(--green)"}}>{r.pickeado}</td>
                      <td className="mono" style={{textAlign:"center",padding:"5px 6px",fontWeight:700,color:falta > 0 ? "var(--amber)" : "var(--green)"}}>
                        {falta > 0 ? falta : "✓"}
                      </td>
                      <td className="mono" style={{textAlign:"center",padding:"5px 6px",fontWeight:700,color:"var(--cyan)"}}>
                        {r.bultos > 0 ? r.bultos : "—"}
                        {r.compartidas.length > 0 && <span style={{fontSize:9,color:"var(--amber)",marginLeft:4}}>+{r.compartidas.length}comp</span>}
                      </td>
                      <td style={{textAlign:"center",padding:"5px 6px"}}>
                        {(r.armadoPendiente + r.armadoCompletado) > 0 ? (
                          <span style={{fontSize:10,fontWeight:700,color:r.armadoPendiente === 0 ? "var(--green)" : "var(--amber)"}}>
                            {r.armadoCompletado}/{r.armadoPendiente + r.armadoCompletado}
                          </span>
                        ) : <span style={{color:"var(--txt3)"}}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{borderTop:"2px solid var(--bg4)"}}>
                  <td style={{padding:"6px",fontWeight:700,fontSize:11}}>TOTAL</td>
                  <td></td>
                  <td className="mono" style={{textAlign:"center",padding:"6px",fontWeight:700}}>{totalPedido}</td>
                  <td className="mono" style={{textAlign:"center",padding:"6px",fontWeight:700,color:"var(--green)"}}>{totalPickeado}</td>
                  <td className="mono" style={{textAlign:"center",padding:"6px",fontWeight:700,color:totalFalta > 0 ? "var(--amber)" : "var(--green)"}}>
                    {totalFalta > 0 ? totalFalta : "✓"}
                  </td>
                  <td className="mono" style={{textAlign:"center",padding:"6px",fontWeight:700,color:"var(--cyan)"}}>{totalBultos > 0 ? totalBultos : "—"}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        );
      })()}

      {session.lineas.length === 0 && (
        <div style={{textAlign:"center",padding:24,color:"var(--txt3)",fontSize:13}}>
          Sin pedidos. Usa el botón &quot;Editar&quot; para agregar.
        </div>
      )}
    </div>
  );
}


export default AdminPicking;
