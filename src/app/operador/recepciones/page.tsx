"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { initStore, isStoreReady, getRecepcionesParaOperario, getLineasDeRecepciones, getRecepcionLineas, contarLinea, etiquetarLinea, ubicarLinea, actualizarRecepcion, actualizarLineaRecepcion, activePositions, findPosition, bloquearLinea, desbloquearLinea, renovarBloqueo, isLineaBloqueada, getVentasPorSkuOrigen, getNotasOperativas } from "@/lib/store";
import type { DBRecepcion, DBRecepcionLinea, ComposicionVenta } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

const ESTADO_ICON: Record<string, string> = { PENDIENTE: "\u{1F534}", CONTADA: "\u{1F7E1}", EN_ETIQUETADO: "\u{1F535}", ETIQUETADA: "\u{1F7E2}", UBICADA: "\u2705" };
const ESTADO_LABEL: Record<string, string> = { PENDIENTE: "Pendiente", CONTADA: "Contada", EN_ETIQUETADO: "Etiquetando", ETIQUETADA: "Etiquetada", UBICADA: "Ubicada" };
const POLL_INTERVAL = 15_000;

export default function RecepcionesOperador() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operario, setOperario] = useState("");

  // Unified line list
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [allLineas, setAllLineas] = useState<DBRecepcionLinea[]>([]);
  const [selLinea, setSelLinea] = useState<DBRecepcionLinea | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [lockError, setLockError] = useState("");
  const [prioritySkus, setPrioritySkus] = useState<Set<string>>(new Set());

  useEffect(() => {
    initStore().then(() => { setMounted(true); setLoading(false); });
    const saved = localStorage.getItem("banva_operario");
    if (saved) setOperario(saved);
  }, []);

  const loadAll = useCallback(async () => {
    if (!operario) return;
    const activeRecs = await getRecepcionesParaOperario(operario);
    setRecs(activeRecs);
    const recIds = activeRecs.map(r => r.id!).filter(Boolean);
    if (recIds.length > 0) {
      const lineas = await getLineasDeRecepciones(recIds);
      setAllLineas(lineas);
      // Load priority SKUs: those that need Full replenishment (low coverage)
      try {
        const sb = (await import("@/lib/supabase")).getSupabase();
        if (sb) {
          const { data: fullCache } = await sb.from("stock_full_cache").select("sku_venta, cantidad, vel_promedio");
          const { data: comps } = await sb.from("composicion_venta").select("sku_venta, sku_origen");
          const origenToFull = new Map<string, {stockFull:number;vel:number}>();
          const ventaToOrigen = new Map<string, string>();
          for (const c of (comps || []) as {sku_venta:string;sku_origen:string}[]) ventaToOrigen.set(c.sku_venta, c.sku_origen);
          for (const f of (fullCache || []) as {sku_venta:string;cantidad:number;vel_promedio:number|null}[]) {
            const origen = ventaToOrigen.get(f.sku_venta) || f.sku_venta;
            const prev = origenToFull.get(origen) || { stockFull: 0, vel: 0 };
            prev.stockFull += f.cantidad; prev.vel += (f.vel_promedio || 0);
            origenToFull.set(origen, prev);
          }
          const urgent = new Set<string>();
          for (const [sku, data] of Array.from(origenToFull.entries())) {
            if (data.vel <= 0) continue;
            const cobDias = (data.stockFull / (data.vel / 7));
            if (cobDias < 21) urgent.add(sku);
          }
          setPrioritySkus(urgent);
        }
      } catch { /* priority is optional */ }
    } else {
      setAllLineas([]);
    }
    // Mark any CREADA recs as EN_PROCESO
    for (const r of activeRecs) {
      if (r.estado === "CREADA") {
        actualizarRecepcion(r.id!, { estado: "EN_PROCESO" });
      }
    }
  }, [operario]);

  useEffect(() => { if (mounted && operario) { setLoading(true); loadAll().finally(() => setLoading(false)); } }, [mounted, operario, loadAll]);

  // Polling
  useEffect(() => {
    if (!mounted || !operario || selLinea) return;
    const interval = setInterval(loadAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [mounted, operario, selLinea, loadAll]);

  const saveOperario = (name: string) => {
    setOperario(name);
    localStorage.setItem("banva_operario", name);
  };

  const handleSelectLinea = async (linea: DBRecepcionLinea) => {
    setLockError("");
    const lock = isLineaBloqueada(linea, operario);
    if (lock.blocked) {
      setLockError(`${lock.by} esta trabajando en esta linea`);
      setTimeout(() => setLockError(""), 4000);
      return;
    }
    try {
      const ok = await bloquearLinea(linea.id!, operario);
      if (!ok) {
        // Refresh to get who has the lock
        await loadAll();
        setLockError("Otro operario tomo esta linea justo ahora. Intenta otra.");
        setTimeout(() => setLockError(""), 4000);
        return;
      }
    } catch {}
    setSelLinea(linea);
  };

  const handleBack = async () => {
    if (selLinea) {
      try { await desbloquearLinea(selLinea.id!); } catch {}
    }
    setSelLinea(null);
    await loadAll();
  };

  const handleStepComplete = async () => {
    // After completing a step, refresh the line but keep working on it
    if (!selLinea) return;
    // Refresh this line's data
    const lineas = await getRecepcionLineas(selLinea.recepcion_id);
    const updated = lineas.find(l => l.id === selLinea.id);
    if (updated) {
      // Check if all lines of this reception are UBICADA
      if (lineas.every(l => l.estado === "UBICADA")) {
        // Detectar discrepancias de cantidad antes de cerrar
        const hasFaltantes = lineas.some(l => (l.qty_recibida || 0) < (l.qty_factura || 0));
        if (hasFaltantes) {
          // Hay faltantes — detectar discrepancias, reabrir líneas faltantes y NO cerrar
          import("@/lib/store").then(m => m.detectarDiscrepanciasQty(selLinea.recepcion_id, lineas)).catch(() => {});
          for (const l of lineas) {
            if ((l.qty_recibida || 0) < (l.qty_factura || 0)) {
              await actualizarLineaRecepcion(l.id!, { estado: "PENDIENTE" });
            }
          }
        } else {
          await actualizarRecepcion(selLinea.recepcion_id, { estado: "COMPLETADA", completed_at: new Date().toISOString() });
          // Trigger: recepción completada
          import("@/lib/agents-triggers").then(m => m.dispararTrigger("recepcion_completada", { recepcion_id: selLinea.recepcion_id })).catch(() => {});
        }
      }
      if (updated.estado === "UBICADA") {
        // Line fully done, unlock and go back
        try { await desbloquearLinea(selLinea.id!); } catch {}
        setSelLinea(null);
        await loadAll();
      } else if (updated.estado === "PENDIENTE" && (updated.qty_recibida || 0) > 0) {
        // Pass complete but more boxes pending — unlock and go back to list
        try { await desbloquearLinea(selLinea.id!); } catch {}
        setSelLinea(null);
        await loadAll();
      } else {
        setSelLinea(updated);
      }
    }
  };

  if (!mounted || loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Bodega</div><div style={{color:"var(--txt3)"}}>Cargando recepciones...</div></div>
    </div>
  );

  if (!operario) return <OperarioLogin onLogin={saveOperario} />;

  // Processing a specific line
  if (selLinea) {
    const rec = recs.find(r => r.id === selLinea.recepcion_id);
    return (
      <ProcesarLinea
        linea={selLinea} recepcionId={selLinea.recepcion_id} operario={operario}
        folio={rec?.folio || ""} proveedor={rec?.proveedor || ""}
        onBack={handleBack}
        onStepComplete={handleStepComplete}
      />
    );
  }

  // Unified line list
  const q = busqueda.trim().toLowerCase();
  const lineasFiltradas = q
    ? allLineas.filter(l => l.sku.toLowerCase().includes(q) || (l.nombre || "").toLowerCase().includes(q) || (l.codigo_ml || "").toLowerCase().includes(q))
    : allLineas;

  const pendientes = lineasFiltradas.filter(l => l.estado === "PENDIENTE");
  const enProceso = lineasFiltradas.filter(l => ["CONTADA", "EN_ETIQUETADO", "ETIQUETADA"].includes(l.estado));
  const completadas = lineasFiltradas.filter(l => l.estado === "UBICADA");
  const totalLineas = allLineas.length;
  const totalUbicadas = allLineas.filter(l => l.estado === "UBICADA").length;
  const progress = totalLineas > 0 ? Math.round((totalUbicadas / totalLineas) * 100) : 0;

  return (
    <div className="app">
      <div className="topbar">
        <Link href="/operador"><button className="back-btn">&#8592;</button></Link>
        <h1>Recepciones</h1>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <span style={{fontSize:10,color:"var(--txt3)"}}>{operario}</span>
          <button onClick={() => { localStorage.removeItem("banva_operario"); setOperario(""); }}
            style={{padding:"4px 8px",borderRadius:4,background:"var(--bg3)",color:"var(--txt3)",fontSize:10,border:"1px solid var(--bg4)"}}>✕</button>
        </div>
      </div>
      <div style={{padding:12}}>
        {lockError && (
          <div style={{padding:"10px 14px",borderRadius:8,background:"#fef2f2",border:"1px solid #fca5a5",color:"#dc2626",fontSize:13,fontWeight:600,marginBottom:10,textAlign:"center"}}>
            {lockError}
          </div>
        )}
        {/* Global progress */}
        <div style={{padding:"14px 16px",borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <span style={{fontSize:13,fontWeight:700}}>Progreso del dia</span>
            <button onClick={() => { setLoading(true); loadAll().finally(() => setLoading(false)); }}
              style={{padding:"4px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              🔄
            </button>
          </div>
          <div style={{background:"var(--bg3)",borderRadius:6,height:10,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:progress===100?"var(--green)":"var(--blue)",borderRadius:6,transition:"width 0.3s"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:11}}>
            <span style={{color:"var(--txt3)"}}>{totalUbicadas}/{totalLineas} lineas completadas</span>
            <span style={{fontWeight:700,color:progress===100?"var(--green)":"var(--blue)"}}>{progress}%</span>
          </div>
        </div>

        {totalLineas === 0 && (
          <div style={{textAlign:"center",padding:32,color:"var(--txt3)"}}>
            <div style={{fontSize:32,marginBottom:8}}>📦</div>
            <div style={{fontSize:13}}>Sin lineas pendientes</div>
            <div style={{fontSize:11,marginTop:4}}>El admin creara nuevas recepciones</div>
          </div>
        )}

        {/* Search */}
        <div style={{position:"relative",marginBottom:12}}>
          <input type="text" value={busqueda} onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar por SKU, nombre o codigo ML..."
            style={{width:"100%",padding:"10px 14px 10px 36px",borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",color:"var(--txt1)",fontSize:13,outline:"none"}} />
          <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:16,color:"var(--txt3)",pointerEvents:"none"}}>🔍</span>
          {busqueda && <button onClick={() => setBusqueda("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:4,color:"var(--txt3)",fontSize:11,padding:"2px 8px",cursor:"pointer"}}>✕</button>}
        </div>

        {/* Line list grouped by factura */}
        {totalLineas > 0 && (() => {
          // Sort receptions: FULL priority first, then by pending count
          const sortedRecs = [...recs].sort((a, b) => {
            const aLineas = allLineas.filter(l => l.recepcion_id === a.id);
            const bLineas = allLineas.filter(l => l.recepcion_id === b.id);
            const aHasFull = aLineas.some(l => prioritySkus.has(l.sku) && l.estado !== "UBICADA");
            const bHasFull = bLineas.some(l => prioritySkus.has(l.sku) && l.estado !== "UBICADA");
            if (aHasFull && !bHasFull) return -1;
            if (!aHasFull && bHasFull) return 1;
            const aPend = aLineas.filter(l => l.estado !== "UBICADA").length;
            const bPend = bLineas.filter(l => l.estado !== "UBICADA").length;
            return bPend - aPend;
          });

          // Filter lines if searching
          const getLineas = (recId: string) => {
            const recLineas = allLineas.filter(l => l.recepcion_id === recId);
            if (!q) return recLineas;
            return recLineas.filter(l => l.sku.toLowerCase().includes(q) || (l.nombre || "").toLowerCase().includes(q) || (l.codigo_ml || "").toLowerCase().includes(q));
          };

          return sortedRecs.map(r => {
            const recLineas = getLineas(r.id!);
            if (recLineas.length === 0) return null;
            const recPend = recLineas.filter(l => l.estado !== "UBICADA");
            const recDone = recLineas.filter(l => l.estado === "UBICADA");
            const hasFull = recPend.some(l => prioritySkus.has(l.sku));
            const prog = recLineas.length > 0 ? Math.round((recDone.length / recLineas.length) * 100) : 0;

            // Sort: FULL first, then by estado (PENDIENTE > CONTADA > ETIQUETADA > UBICADA)
            const sorted = [...recLineas].sort((a, b) => {
              const aDone = a.estado === "UBICADA" ? 1 : 0;
              const bDone = b.estado === "UBICADA" ? 1 : 0;
              if (aDone !== bDone) return aDone - bDone;
              const aPrio = prioritySkus.has(a.sku) ? 0 : 1;
              const bPrio = prioritySkus.has(b.sku) ? 0 : 1;
              return aPrio - bPrio;
            });

            return (
              <div key={r.id} style={{marginBottom:16}}>
                {/* Factura header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,padding:"6px 0"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:13,fontWeight:700}}>{r.proveedor}</span>
                    <span className="mono" style={{fontSize:11,color:"var(--txt3)"}}>#{r.folio}</span>
                    {hasFull && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"var(--red)",color:"#fff"}}>FULL</span>}
                  </div>
                  <span style={{fontSize:11,fontWeight:700,color:prog===100?"var(--green)":"var(--blue)"}}>{recDone.length}/{recLineas.length}</span>
                </div>
                <div style={{background:"var(--bg3)",borderRadius:3,height:4,overflow:"hidden",marginBottom:6}}>
                  <div style={{width:`${prog}%`,height:"100%",background:prog===100?"var(--green)":"var(--blue)",borderRadius:3}}/>
                </div>
                {/* Lines */}
                {sorted.map(l => <LineaCard key={l.id} linea={l} operario={operario} onTap={() => handleSelectLinea(l)} priority={prioritySkus.has(l.sku)} />)}
              </div>
            );
          });
        })()}
      </div>
    </div>
  );
}

// ==================== OPERARIO LOGIN ====================
function OperarioLogin({ onLogin }: { onLogin: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)",padding:24}}>
      <div style={{width:"100%",maxWidth:340,textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.12em",color:"var(--cyan)",textTransform:"uppercase",marginBottom:6}}>BANVA BODEGA</div>
        <div style={{fontSize:22,fontWeight:800,marginBottom:4}}>Recepciones</div>
        <div style={{fontSize:13,color:"var(--txt3)",marginBottom:24}}>¿Quien eres?</div>
        <input className="form-input" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && name.trim() && onLogin(name.trim())}
          placeholder="Tu nombre" autoFocus style={{fontSize:16,textAlign:"center",padding:14,marginBottom:12}} />
        <button onClick={() => name.trim() && onLogin(name.trim())}
          disabled={!name.trim()}
          style={{width:"100%",padding:14,borderRadius:10,background:name.trim()?"var(--green)":"var(--bg3)",color:name.trim()?"#fff":"var(--txt3)",fontSize:14,fontWeight:700}}>
          Entrar
        </button>
      </div>
    </div>
  );
}

// ==================== LINEA CARD (with lock display) ====================
function LineaCard({ linea: l, operario, onTap, priority }: { linea: DBRecepcionLinea; operario: string; onTap: () => void; priority?: boolean }) {
  const icon = ESTADO_ICON[l.estado] || "⚪";
  const lock = isLineaBloqueada(l, operario);

  return (
    <div onClick={lock.blocked ? undefined : onTap}
      style={{
        padding:"12px 14px",marginBottom:6,borderRadius:8,
        background: lock.blocked ? "var(--bg3)" : priority ? "rgba(239,68,68,0.08)" : "var(--bg2)",
        border: `1px solid ${priority ? "var(--red)" : lock.blocked ? "var(--bg4)" : "var(--bg3)"}`,
        cursor: lock.blocked ? "not-allowed" : "pointer",
        opacity: lock.blocked ? 0.6 : 1,
        display:"flex",justifyContent:"space-between",alignItems:"center",
      }}>
      <div style={{flex:1}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span>{lock.blocked ? "🔒" : icon}</span>
          <span className="mono" style={{fontWeight:700,fontSize:13}}>{l.sku}</span>
          {priority && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:"var(--red)",color:"#fff"}}>FULL</span>}
          {lock.blocked && <span style={{fontSize:10,color:"var(--amber)",fontWeight:600}}>{lock.by}</span>}
        </div>
        <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>{l.nombre}</div>
        {(l.estado !== "PENDIENTE" || (l.qty_recibida || 0) > 0) && (
          <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>
            Recibido: <span style={{color:(l.qty_recibida||0)>0?((l.qty_recibida||0)>=l.qty_factura?"var(--green)":"var(--amber)"):"var(--txt3)"}}>{l.qty_recibida||0}/{l.qty_factura}</span>
            {l.requiere_etiqueta && <span> · Etiq: {l.qty_etiquetada||0}</span>}
            <span> · Ubic: {l.qty_ubicada||0}</span>
            {l.estado === "PENDIENTE" && (l.qty_recibida || 0) > 0 && (
              <span style={{color:"var(--cyan)",fontWeight:600}}> · Esperando caja</span>
            )}
          </div>
        )}
      </div>
      <div style={{textAlign:"right"}}>
        <div className="mono" style={{fontWeight:700,fontSize:16,color:lock.blocked?"var(--txt3)":"var(--blue)"}}>{l.qty_factura}</div>
        <div style={{fontSize:9,color:"var(--txt3)"}}>factura</div>
      </div>
    </div>
  );
}

// ==================== PROCESAR LINEA ====================
function ProcesarLinea({ linea: initialLinea, recepcionId, operario, folio, proveedor, onBack, onStepComplete }: {
  linea: DBRecepcionLinea; recepcionId: string; operario: string; folio: string; proveedor: string; onBack: () => void; onStepComplete: () => void;
}) {
  const [linea, setLinea] = useState(initialLinea);
  const [step, setStep] = useState<"contar" | "etiquetar" | "ubicar">(determineStep(initialLinea));
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");
  const renewalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  // Auto-renew lock every 5 minutes while working on this line
  useEffect(() => {
    renewalRef.current = setInterval(() => {
      renovarBloqueo(linea.id!, operario);
    }, 5 * 60 * 1000);
    return () => {
      if (renewalRef.current) clearInterval(renewalRef.current);
    };
  }, [linea.id, operario]);

  const refreshLinea = async () => {
    const lineas = await getRecepcionLineas(recepcionId);
    const updated = lineas.find(l => l.id === linea.id);
    if (updated) { setLinea(updated); setStep(determineStep(updated)); }
  };

  // Auto-corregir estado inconsistente: si qty_etiquetada >= qtyTotal pero estado no es ETIQUETADA
  useEffect(() => {
    if (!linea.requiere_etiqueta) return;
    const qtyTotal = (linea.qty_recibida || 0) > 0 ? linea.qty_recibida! : linea.qty_factura;
    const yaEtiquetadas = linea.qty_etiquetada || 0;
    if (yaEtiquetadas >= qtyTotal && qtyTotal > 0 && linea.estado !== "ETIQUETADA" && linea.estado !== "UBICADA") {
      // Estado desincronizado: corregir en DB
      actualizarLineaRecepcion(linea.id!, { estado: "ETIQUETADA", ts_etiquetado: new Date().toISOString() })
        .then(() => refreshLinea())
        .catch(() => {});
    }
  }, [linea.id, linea.estado, linea.qty_etiquetada, linea.qty_recibida]);

  // ---- PASO 1: CONTAR (por caja, acumulativo) ----
  const prevRecibida = linea.qty_recibida || 0;
  const faltanPorRecibir = Math.max(0, linea.qty_factura - prevRecibida);
  const [qtyCaja, setQtyCaja] = useState(faltanPorRecibir);

  const doContar = async () => {
    setSaving(true);
    try {
      await contarLinea(linea.id!, qtyCaja, operario, recepcionId);
      const nuevoTotal = prevRecibida + qtyCaja;
      showToast(`Caja: ${qtyCaja} uds — Total recibido: ${nuevoTotal}/${linea.qty_factura}`);
      await refreshLinea();
      onStepComplete();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error desconocido";
      showToast(`ERROR al contar: ${msg}`);
      await refreshLinea();
    } finally {
      setSaving(false);
    }
  };

  // Cerrar linea cuando no hay mas cajas (recibido < factura)
  const doCerrarLinea = async () => {
    if (!window.confirm(`¿Confirmar que no hay mas cajas?\n\nRecibido: ${prevRecibida} de ${linea.qty_factura} facturados.\nSe cerrara la linea con ${prevRecibida} unidades.`)) return;
    setSaving(true);
    try {
      // Ajustar qty_factura al real recibido para que la linea pueda completarse
      await actualizarLineaRecepcion(linea.id!, { qty_factura: prevRecibida });
      showToast(`Linea cerrada con ${prevRecibida} unidades recibidas`);
      await refreshLinea();
      onStepComplete();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error desconocido";
      showToast(`ERROR: ${msg}`);
      await refreshLinea();
    } finally {
      setSaving(false);
    }
  };

  // ---- PASO 2: ETIQUETAR ----
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<"ok" | "error" | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [etiqQty, setEtiqQty] = useState(0);

  const doEtiquetar = async (qty: number) => {
    const newTotal = (linea.qty_etiquetada || 0) + qty;
    const qtyTotal = linea.qty_recibida || linea.qty_factura;
    setSaving(true);
    try {
      await etiquetarLinea(linea.id!, newTotal, operario, qtyTotal);
      showToast(`${qty} unidades etiquetadas (${newTotal}/${qtyTotal})`);
      await refreshLinea();
      setEtiqQty(0);
      setScanResult(null);
      setScanCode("");
      // Renew lock after each labeling action
      await renovarBloqueo(linea.id!, operario);
      onStepComplete();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error desconocido";
      showToast(`ERROR al etiquetar: ${msg}`);
      await refreshLinea();
    } finally {
      setSaving(false);
    }
  };

  // Get ALL packs/ventas this physical product participates in
  const packsForSku: ComposicionVenta[] = getVentasPorSkuOrigen(linea.sku);
  const allValidMlCodes = packsForSku.map(p => p.codigoMl).filter(Boolean);
  if (linea.codigo_ml && !allValidMlCodes.includes(linea.codigo_ml)) {
    allValidMlCodes.push(linea.codigo_ml);
  }

  const onScanML = (code: string) => {
    const trimmed = code.trim().toUpperCase();
    setScanCode(trimmed);
    const isValid = allValidMlCodes.some(ml => ml.toUpperCase() === trimmed)
      || trimmed === linea.sku.toUpperCase();
    if (!isValid) {
      setScanResult("error");
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      return;
    }
    setScanResult("ok");
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
  };

  // ---- PASO 3: UBICAR ----
  const [ubicarQty, setUbicarQty] = useState(0);
  const [ubicarPos, setUbicarPos] = useState("");
  // Auto-seleccionar formato desde la línea de recepción (viene de factura)
  const [ubicarSkuVenta, setUbicarSkuVenta] = useState<string>(linea.sku_venta || "__SIN_ETIQUETAR__");
  const [scanningPos, setScanningPos] = useState(false);

  // Build options for sku_venta format selection
  const formatosVenta = packsForSku.length > 0
    ? packsForSku.map(p => ({ skuVenta: p.skuVenta, codigoMl: p.codigoMl, unidades: p.unidades }))
    : (linea.sku_venta ? [{ skuVenta: linea.sku_venta, codigoMl: linea.codigo_ml, unidades: 1 }] : []);

  useEffect(() => {
    const qtyTotal = linea.qty_recibida || linea.qty_factura;
    const remaining = qtyTotal - (linea.qty_ubicada || 0);
    setUbicarQty(Math.max(0, remaining));
    // Sincronizar formato cuando cambia la línea
    if (linea.sku_venta) setUbicarSkuVenta(linea.sku_venta);
  }, [linea]);

  const doUbicar = async () => {
    if (!ubicarPos || ubicarQty <= 0) return;
    setSaving(true);
    try {
      const skuVentaVal = ubicarSkuVenta === "__SIN_ETIQUETAR__" ? null : ubicarSkuVenta;
      await ubicarLinea(linea.id!, linea.sku, ubicarPos, ubicarQty, operario, recepcionId, {
        skuVenta: skuVentaVal, folio, proveedor,
      });
      showToast(`${ubicarQty} uds ubicadas en ${ubicarPos}`);
      await refreshLinea();
      setUbicarPos("");
      onStepComplete();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error desconocido al ubicar";
      showToast(`ERROR: ${msg}`);
      await refreshLinea();
    } finally {
      setSaving(false);
    }
  };

  const onScanPos = (code: string) => {
    setScanningPos(false);
    const pos = findPosition(code);
    if (pos) {
      setUbicarPos(pos.id);
      showToast(`Posicion: ${pos.label}`);
    } else {
      showToast(`⚠️ Posicion no encontrada: ${code}`);
    }
  };

  const isComplete = linea.estado === "UBICADA";
  const qtyTotal = linea.qty_recibida || linea.qty_factura;
  const qtyPendienteUbicar = qtyTotal - (linea.qty_ubicada || 0);

  return (
    <div className="app">
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>&#8592;</button>
        <h1>{linea.sku}</h1>
        <span style={{fontSize:10,color:"var(--txt3)"}}>{ESTADO_LABEL[linea.estado]}</span>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",zIndex:200,background:"var(--bg2)",
          border:"2px solid var(--green)",color:"var(--green)",padding:"10px 20px",borderRadius:10,fontSize:13,fontWeight:700,
          boxShadow:"0 8px 30px rgba(0,0,0,0.5)",maxWidth:"90vw",textAlign:"center"}}>{toast}</div>
      )}

      <div style={{padding:12}}>
        {/* Product info */}
        <div style={{padding:"12px 14px",borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",marginBottom:12}}>
          <div style={{fontSize:14,fontWeight:700}}>{linea.nombre}</div>
          {(() => { const notas = getNotasOperativas(linea.sku); return notas.length > 0 ? (
            <div style={{padding:"4px 8px",borderRadius:4,background:"#f59e0b15",border:"1px solid #f59e0b33",marginTop:4}}>
              <div style={{fontSize:11,fontWeight:700,color:"#f59e0b"}}>⚠ {notas.join(" | ")}</div>
            </div>
          ) : null; })()}
          <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>
            {linea.codigo_ml && <span>ML: <strong>{linea.codigo_ml}</strong> · </span>}
            Factura: <strong>{linea.qty_factura}</strong>
            {(linea.qty_recibida || 0) > 0 && <span> · Recibido: <strong style={{color:(linea.qty_recibida||0)>=linea.qty_factura?"var(--green)":"var(--amber)"}}>{linea.qty_recibida}</strong></span>}
            {(linea.qty_ubicada || 0) > 0 && <span> · Ubicado: <strong>{linea.qty_ubicada}</strong></span>}
          </div>
          {/* Progress bar */}
          <div style={{display:"flex",gap:4,marginTop:8}}>
            <StepPill label="Conteo" active={step==="contar"} done={["CONTADA","EN_ETIQUETADO","ETIQUETADA","UBICADA"].includes(linea.estado)} />
            {linea.requiere_etiqueta && <StepPill label="Etiquetado" active={step==="etiquetar"} done={["ETIQUETADA","UBICADA"].includes(linea.estado)} />}
            <StepPill label="Ubicacion" active={step==="ubicar"} done={linea.estado==="UBICADA"} />
          </div>
        </div>

        {/* COMPLETADA */}
        {isComplete && (
          <div style={{textAlign:"center",padding:24}}>
            <div style={{fontSize:48,marginBottom:8}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"var(--green)"}}>Linea completada</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginTop:4}}>{linea.qty_ubicada} unidades ubicadas</div>
            <button onClick={onBack} style={{marginTop:16,padding:"12px 24px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:700,border:"1px solid var(--bg4)"}}>
              ← Volver
            </button>
          </div>
        )}

        {/* PASO 1: CONTAR (por caja) */}
        {step === "contar" && !isComplete && (
          <div style={{padding:"16px",borderRadius:10,background:"var(--bg2)",border:"2px solid var(--amber)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 1 — Conteo {prevRecibida > 0 ? "(siguiente caja)" : ""}</div>
            {prevRecibida > 0 && (
              <div style={{marginBottom:8,padding:"6px 12px",borderRadius:6,background:"var(--bg3)",fontSize:12,fontWeight:700,textAlign:"center"}}>
                Ya procesadas: <span style={{color:"var(--cyan)"}}>{prevRecibida}</span> / {linea.qty_factura} — Faltan: <span style={{color:"var(--amber)"}}>{faltanPorRecibir}</span>
              </div>
            )}
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
              {prevRecibida > 0
                ? <>¿Cuantas unidades hay en <strong style={{color:"var(--txt1)"}}>esta caja</strong>?</>
                : <>La factura dice <strong style={{color:"var(--txt1)"}}>{linea.qty_factura} unidades</strong>. ¿Cuantas hay en esta caja?</>
              }
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
              <button onClick={() => setQtyCaja(q => Math.max(0, q - 1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
              <input type="number" value={qtyCaja} onFocus={e=>e.target.select()} onChange={e => setQtyCaja(Math.max(0, parseInt(e.target.value) || 0))}
                style={{width:80,textAlign:"center",fontSize:28,fontWeight:700,padding:10,borderRadius:8,background:"var(--bg1)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
              <button onClick={() => setQtyCaja(q => q + 1)} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
            </div>
            {prevRecibida + qtyCaja > linea.qty_factura && (
              <div style={{textAlign:"center",marginBottom:8,padding:"6px 12px",borderRadius:6,
                background:"var(--amberBg)",color:"var(--amber)",fontSize:12,fontWeight:700}}>
                ⚠️ Total seria {prevRecibida + qtyCaja} — sobran {prevRecibida + qtyCaja - linea.qty_factura} vs factura
              </div>
            )}
            <button onClick={doContar} disabled={saving || qtyCaja <= 0}
              style={{width:"100%",padding:14,borderRadius:10,background:saving||qtyCaja<=0?"var(--bg3)":"var(--green)",color:saving||qtyCaja<=0?"var(--txt3)":"#fff",fontSize:14,fontWeight:700}}>
              {saving ? "Guardando..." : `Confirmar: ${qtyCaja} uds en esta caja`}
            </button>
            {/* Opcion de cerrar linea cuando ya se recibieron cajas pero faltan vs factura */}
            {prevRecibida > 0 && (linea.qty_ubicada || 0) > 0 && (
              <button onClick={doCerrarLinea} disabled={saving}
                style={{width:"100%",marginTop:8,padding:12,borderRadius:10,background:"var(--bg3)",
                  color:"var(--amber)",fontSize:13,fontWeight:600,border:"1px solid var(--amberBd)"}}>
                No hay mas cajas — cerrar con {prevRecibida} recibidas
              </button>
            )}
          </div>
        )}

        {/* PASO 2: ETIQUETAR */}
        {step === "etiquetar" && !isComplete && (
          <div style={{padding:"16px",borderRadius:10,background:"var(--bg2)",border:"2px solid var(--blue)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 2 — Etiquetado</div>

            {packsForSku.length > 1 ? (
              <div style={{marginBottom:10}}>
                <div style={{fontSize:12,color:"var(--txt3)",marginBottom:6}}>
                  Este producto se vende en <strong style={{color:"var(--cyan)"}}>{packsForSku.length} publicaciones</strong>:
                </div>
                {packsForSku.map((pack, i) => (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",marginBottom:4,
                    background:"var(--bg3)",borderRadius:8,border:"1px solid var(--bg4)"}}>
                    <span style={{fontSize:11,fontWeight:700,color:pack.unidades > 1 ? "var(--amber)" : "var(--cyan)",
                      background:pack.unidades > 1 ? "var(--amber)15" : "var(--cyan)15",
                      padding:"2px 8px",borderRadius:4,whiteSpace:"nowrap"}}>
                      {pack.unidades > 1 ? `Pack x${pack.unidades}` : "Unitario"}
                    </span>
                    <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:"var(--txt1)"}}>{pack.codigoMl}</span>
                    <span style={{fontSize:10,color:"var(--txt3)",flex:1,textAlign:"right"}}>{pack.skuVenta}</span>
                  </div>
                ))}
                <div style={{fontSize:11,color:"var(--txt3)",marginTop:4}}>Cualquiera de estos codigos es valido al escanear</div>
              </div>
            ) : (
              <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
                Etiqueta cada unidad con codigo ML: <strong style={{color:"var(--cyan)"}}>{linea.codigo_ml || packsForSku[0]?.codigoMl || "—"}</strong>
                {packsForSku.length === 1 && packsForSku[0].unidades > 1 && (
                  <span style={{color:"var(--amber)",fontWeight:700}}> (Pack x{packsForSku[0].unidades})</span>
                )}
              </div>
            )}

            {/* Progress */}
            <div style={{background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden",marginBottom:8}}>
              <div style={{width:`${Math.round(((linea.qty_etiquetada||0)/qtyTotal)*100)}%`,height:"100%",background:"var(--blue)",borderRadius:6}}/>
            </div>
            <div style={{fontSize:12,marginBottom:12,color:"var(--txt2)"}}>
              <strong>{linea.qty_etiquetada || 0}</strong> de <strong>{qtyTotal}</strong> etiquetadas
              {(qtyTotal - (linea.qty_etiquetada||0)) > 0 && <span style={{color:"var(--amber)"}}> — faltan {qtyTotal - (linea.qty_etiquetada||0)}</span>}
            </div>

            {/* Scan to verify */}
            <BarcodeScanner onScan={onScanML} active={true} label="Verificar codigo ML" mode="barcode"
              placeholder={allValidMlCodes.length === 1 ? `Esperado: ${allValidMlCodes[0]}` : "Escanea cualquier codigo ML valido..."} />

            {scanResult === "error" && (
              <div style={{padding:14,background:"#ef444422",border:"2px solid #ef4444",borderRadius:12,marginBottom:12,textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:6}}>&#10060;</div>
                <div style={{fontSize:15,fontWeight:700,color:"#ef4444"}}>CODIGO INCORRECTO</div>
                <div style={{fontSize:13,color:"#94a3b8",marginTop:6}}>Escaneaste: <strong style={{fontFamily:"monospace",color:"#ef4444"}}>{scanCode}</strong></div>
                <div style={{fontSize:12,color:"#94a3b8",marginTop:4}}>Codigos validos para <strong>{linea.sku}</strong>:</div>
                {allValidMlCodes.map((ml, i) => {
                  const pack = packsForSku.find(p => p.codigoMl === ml);
                  return (
                    <div key={i} style={{fontFamily:"monospace",fontSize:12,color:"#10b981",marginTop:2}}>
                      {ml} {pack ? `(${pack.unidades > 1 ? `Pack x${pack.unidades}` : "Unitario"})` : ""}
                    </div>
                  );
                })}
                <div style={{fontSize:12,color:"#f59e0b",marginTop:8,fontWeight:600}}>Verifica que la etiqueta corresponde a este producto</div>
                <button onClick={() => setScanResult(null)}
                  style={{marginTop:10,padding:"8px 20px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontWeight:700,fontSize:12,border:"1px solid var(--bg4)"}}>
                  Intentar de nuevo
                </button>
              </div>
            )}

            {scanResult === "ok" && (() => {
              const matchedPack = packsForSku.find(p => p.codigoMl.toUpperCase() === scanCode);
              return (
                <div style={{padding:14,background:"#10b98122",border:"2px solid #10b981",borderRadius:12,marginBottom:12,textAlign:"center"}}>
                  <div style={{fontSize:28,marginBottom:6}}>&#9989;</div>
                  <div style={{fontSize:15,fontWeight:700,color:"#10b981"}}>CODIGO CORRECTO</div>
                  <div style={{fontSize:13,color:"#94a3b8",marginTop:4,fontFamily:"monospace"}}>{scanCode}</div>
                  {matchedPack && matchedPack.unidades > 1 && (
                    <div style={{fontSize:12,color:"var(--amber)",marginTop:4,fontWeight:600}}>Pack x{matchedPack.unidades} — {matchedPack.skuVenta}</div>
                  )}
                </div>
              );
            })()}

            {scanResult !== "ok" && (
              <div style={{padding:"10px 14px",background:"var(--amberBg)",border:"1px solid var(--amberBd)",borderRadius:8,marginBottom:10,textAlign:"center"}}>
                <div style={{fontSize:12,fontWeight:700,color:"var(--amber)"}}>⚠️ Escaneá o ingresá el codigo ML para continuar</div>
                <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>No se puede registrar etiquetado sin verificar el codigo</div>
              </div>
            )}
            <div style={{opacity:scanResult==="ok"?1:0.4,pointerEvents:scanResult==="ok"?"auto":"none"}}>
              <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>¿Cuantas etiquetaste en esta tanda?</div>
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                {[1, 3, 6, 10, 12, qtyTotal - (linea.qty_etiquetada||0)].filter((v, i, a) => v > 0 && v <= (qtyTotal - (linea.qty_etiquetada||0)) && a.indexOf(v) === i).map(n => (
                  <button key={n} onClick={() => setEtiqQty(n)}
                    style={{padding:"8px 14px",borderRadius:6,background:etiqQty===n?"var(--blue)":"var(--bg3)",color:etiqQty===n?"#fff":"var(--txt2)",fontSize:12,fontWeight:700,border:"1px solid var(--bg4)",minWidth:44}}>
                    {n === (qtyTotal-(linea.qty_etiquetada||0)) ? `Todo (${n})` : n}
                  </button>
                ))}
              </div>
              <button onClick={() => etiqQty > 0 && doEtiquetar(etiqQty)} disabled={saving || etiqQty <= 0}
                style={{width:"100%",padding:14,borderRadius:10,background:(etiqQty>0&&!saving)?"var(--green)":"var(--bg3)",color:(etiqQty>0&&!saving)?"#fff":"var(--txt3)",fontSize:14,fontWeight:700}}>
                {saving ? "Guardando..." : etiqQty > 0 ? `Registrar ${etiqQty} etiquetadas` : "Selecciona cantidad"}
              </button>
            </div>
          </div>
        )}

        {/* PASO 3: UBICAR */}
        {step === "ubicar" && !isComplete && (
          <div style={{padding:"16px",borderRadius:10,background:"var(--bg2)",border:"2px solid var(--green)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>
              {linea.requiere_etiqueta ? "Paso 3" : "Paso 2"} — Ubicar en bodega
            </div>
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
              <strong style={{color:"var(--txt1)"}}>{qtyPendienteUbicar} unidades</strong> listas para ubicar
            </div>

            {/* Formato de venta - auto-asignado desde recepción */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>
                Formato de venta de estas unidades:
                {linea.sku_venta && <span style={{fontSize:10,color:"var(--green)",marginLeft:6}}>(asignado en recepcion)</span>}
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                <button onClick={() => setUbicarSkuVenta("__SIN_ETIQUETAR__")}
                  style={{padding:"8px 12px",borderRadius:6,fontSize:11,fontWeight:700,
                    background:ubicarSkuVenta==="__SIN_ETIQUETAR__"?"var(--amberBg)":"var(--bg3)",
                    color:ubicarSkuVenta==="__SIN_ETIQUETAR__"?"var(--amber)":"var(--txt3)",
                    border:ubicarSkuVenta==="__SIN_ETIQUETAR__"?"1px solid var(--amber)":"1px solid var(--bg4)"}}>
                  Sin etiquetar
                </button>
                {formatosVenta.map(f => (
                  <button key={f.skuVenta} onClick={() => setUbicarSkuVenta(f.skuVenta)}
                    style={{padding:"8px 12px",borderRadius:6,fontSize:11,fontWeight:700,
                      background:ubicarSkuVenta===f.skuVenta?"var(--cyanBg)":"var(--bg3)",
                      color:ubicarSkuVenta===f.skuVenta?"var(--cyan)":"var(--txt3)",
                      border:ubicarSkuVenta===f.skuVenta?"1px solid var(--cyan)":"1px solid var(--bg4)"}}>
                    {f.skuVenta} {f.unidades > 1 ? `(x${f.unidades})` : "(individual)"}
                  </button>
                ))}
              </div>
            </div>

            <BarcodeScanner onScan={onScanPos} active={true} label="Escanear QR de posicion" mode="qr" />

            <div style={{fontSize:11,textAlign:"center",color:"var(--txt3)",marginBottom:6}}>o selecciona manualmente</div>
            <select className="form-select" value={ubicarPos} onChange={e => setUbicarPos(e.target.value)}
              style={{width:"100%",padding:10,fontSize:13,marginBottom:10}}>
              <option value="">— Seleccionar posicion —</option>
              {positions.map(p => <option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
            </select>

            {ubicarPos && (
              <>
                <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Cantidad a ubicar en {ubicarPos}:</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
                  <button onClick={() => setUbicarQty(q => Math.max(1, q - 1))} style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                  <input type="number" value={ubicarQty} onFocus={e=>e.target.select()} onChange={e => setUbicarQty(Math.max(1, Math.min(qtyPendienteUbicar, parseInt(e.target.value) || 0)))}
                    style={{width:70,textAlign:"center",fontSize:24,fontWeight:700,padding:8,borderRadius:8,background:"var(--bg1)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                  <button onClick={() => setUbicarQty(q => Math.min(qtyPendienteUbicar, q + 1))} style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                </div>
                {ubicarQty < qtyPendienteUbicar && (
                  <div style={{textAlign:"center",fontSize:11,color:"var(--amber)",marginBottom:8}}>
                    Quedaran {qtyPendienteUbicar - ubicarQty} unidades sin ubicar (puedes dividir en otra posicion)
                  </div>
                )}
                <button onClick={doUbicar} disabled={saving}
                  style={{width:"100%",padding:14,borderRadius:10,background:saving?"var(--bg3)":"var(--green)",color:saving?"var(--txt3)":"#fff",fontSize:14,fontWeight:700}}>
                  {saving ? "Guardando..." : `Ubicar ${ubicarQty} uds en posicion ${ubicarPos}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepPill({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span style={{
      flex:1,textAlign:"center",padding:"4px 6px",borderRadius:4,fontSize:10,fontWeight:700,
      background: done ? "var(--greenBg)" : active ? "var(--blueBg)" : "var(--bg3)",
      color: done ? "var(--green)" : active ? "var(--blue)" : "var(--txt3)",
      border: `1px solid ${done ? "var(--greenBd)" : active ? "var(--blueBd)" : "var(--bg4)"}`,
    }}>
      {done ? "✓ " : ""}{label}
    </span>
  );
}

function determineStep(l: DBRecepcionLinea): "contar" | "etiquetar" | "ubicar" {
  if (l.estado === "PENDIENTE") return "contar";
  if (l.estado === "CONTADA" || l.estado === "EN_ETIQUETADO") {
    if (!l.requiere_etiqueta) return "ubicar";
    // Si ya se etiquetaron todas las unidades recibidas, saltar a ubicar
    const qtyTotal = (l.qty_recibida || 0) > 0 ? l.qty_recibida! : l.qty_factura;
    if ((l.qty_etiquetada || 0) >= qtyTotal && qtyTotal > 0) return "ubicar";
    return "etiquetar";
  }
  if (l.estado === "ETIQUETADA") return "ubicar";
  return "ubicar";
}
