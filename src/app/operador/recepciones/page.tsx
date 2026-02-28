"use client";
import { useState, useEffect, useCallback } from "react";
import { initStore, isStoreReady, getRecepcionesActivas, getRecepcionesParaOperario, getRecepcionLineas, contarLinea, etiquetarLinea, ubicarLinea, actualizarRecepcion, activePositions, findPosition, fmtDate, fmtTime } from "@/lib/store";
import type { DBRecepcion, DBRecepcionLinea } from "@/lib/store";
import dynamic from "next/dynamic";
import Link from "next/link";
const BarcodeScanner = dynamic(() => import("@/components/BarcodeScanner"), { ssr: false });

const ESTADO_ICON: Record<string, string> = { PENDIENTE: "🔴", CONTADA: "🟡", EN_ETIQUETADO: "🔵", ETIQUETADA: "🟢", UBICADA: "✅" };
const ESTADO_LABEL: Record<string, string> = { PENDIENTE: "Pendiente", CONTADA: "Contada", EN_ETIQUETADO: "Etiquetando", ETIQUETADA: "Etiquetada", UBICADA: "Ubicada" };

export default function RecepcionesOperador() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operario, setOperario] = useState("");

  // Navigation state
  const [recs, setRecs] = useState<DBRecepcion[]>([]);
  const [selRec, setSelRec] = useState<DBRecepcion | null>(null);
  const [lineas, setLineas] = useState<DBRecepcionLinea[]>([]);
  const [selLinea, setSelLinea] = useState<DBRecepcionLinea | null>(null);

  useEffect(() => {
    initStore().then(() => { setMounted(true); setLoading(false); });
    const saved = localStorage.getItem("banva_operario");
    if (saved) setOperario(saved);
  }, []);

  const loadRecs = useCallback(async () => {
    setLoading(true);
    setRecs(operario ? await getRecepcionesParaOperario(operario) : await getRecepcionesActivas());
    setLoading(false);
  }, [operario]);

  useEffect(() => { if (mounted && operario) loadRecs(); }, [mounted, operario, loadRecs]);

  const openRec = async (rec: DBRecepcion) => {
    setSelRec(rec);
    setLineas(await getRecepcionLineas(rec.id!));
    // Mark as EN_PROCESO if was CREADA
    if (rec.estado === "CREADA") {
      await actualizarRecepcion(rec.id!, { estado: "EN_PROCESO" });
    }
  };

  const refreshLineas = async () => {
    if (!selRec) return;
    const updated = await getRecepcionLineas(selRec.id!);
    setLineas(updated);
    // Check if all are UBICADA → mark reception COMPLETADA
    if (updated.length > 0 && updated.every(l => l.estado === "UBICADA")) {
      await actualizarRecepcion(selRec.id!, { estado: "COMPLETADA", completed_at: new Date().toISOString() });
    }
  };

  const saveOperario = (name: string) => {
    setOperario(name);
    localStorage.setItem("banva_operario", name);
  };

  if (!mounted || loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100dvh",background:"var(--bg)"}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:24,fontWeight:700,marginBottom:8}}>BANVA Bodega</div><div style={{color:"var(--txt3)"}}>Cargando recepciones...</div></div>
    </div>
  );

  // Ask for operator name if not set
  if (!operario) return <OperarioLogin onLogin={saveOperario} />;

  // Processing a specific line
  if (selLinea && selRec) return (
    <ProcesarLinea
      linea={selLinea} recepcion={selRec} operario={operario}
      onBack={async () => { setSelLinea(null); await refreshLineas(); }}
    />
  );

  // Viewing a specific reception
  if (selRec) return (
    <RecepcionDetalle
      rec={selRec} lineas={lineas} operario={operario}
      onBack={() => { setSelRec(null); loadRecs(); }}
      onSelectLinea={setSelLinea}
      onRefresh={refreshLineas}
    />
  );

  // List of active receptions
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
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <span style={{fontSize:13,fontWeight:700}}>Recepciones activas</span>
          <button onClick={loadRecs} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Actualizar</button>
        </div>

        {recs.length === 0 && (
          <div style={{textAlign:"center",padding:32,color:"var(--txt3)"}}>
            <div style={{fontSize:32,marginBottom:8}}>📦</div>
            <div style={{fontSize:13}}>Sin recepciones pendientes</div>
            <div style={{fontSize:11,marginTop:4}}>El admin o la app de etiquetas crearán nuevas recepciones</div>
          </div>
        )}

        {recs.map(rec => (
          <div key={rec.id} onClick={() => openRec(rec)}
            style={{padding:"14px 16px",marginBottom:8,borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>{rec.proveedor}</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>Folio {rec.folio} · {fmtDate(rec.created_at || "")}</div>
              </div>
              <span style={{padding:"4px 10px",borderRadius:6,fontSize:10,fontWeight:700,
                background:rec.estado==="CREADA"?"var(--amberBg)":"var(--blueBg)",
                color:rec.estado==="CREADA"?"var(--amber)":"var(--blue)",
                border:`1px solid ${rec.estado==="CREADA"?"var(--amberBd)":"var(--blueBd)"}`
              }}>{rec.estado === "CREADA" ? "NUEVA" : "EN PROCESO"}</span>
            </div>
          </div>
        ))}
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
        <div style={{fontSize:13,color:"var(--txt3)",marginBottom:24}}>¿Quién eres?</div>
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

// ==================== RECEPCION DETALLE ====================
function RecepcionDetalle({ rec, lineas, operario, onBack, onSelectLinea, onRefresh }: {
  rec: DBRecepcion; lineas: DBRecepcionLinea[]; operario: string;
  onBack: () => void; onSelectLinea: (l: DBRecepcionLinea) => void; onRefresh: () => void;
}) {
  const total = lineas.length;
  const ubicadas = lineas.filter(l => l.estado === "UBICADA").length;
  const progress = total > 0 ? Math.round((ubicadas / total) * 100) : 0;

  // Group by estado
  const pendientes = lineas.filter(l => l.estado === "PENDIENTE");
  const enProceso = lineas.filter(l => ["CONTADA", "EN_ETIQUETADO", "ETIQUETADA"].includes(l.estado));
  const completadas = lineas.filter(l => l.estado === "UBICADA");

  return (
    <div className="app">
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>&#8592;</button>
        <h1>{rec.proveedor}</h1>
        <button onClick={onRefresh} style={{padding:"6px 10px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄</button>
      </div>
      <div style={{padding:12}}>
        {/* Header card */}
        <div style={{padding:"14px 16px",borderRadius:10,background:"var(--bg2)",border:"1px solid var(--bg3)",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:12,color:"var(--txt3)"}}>Folio <strong style={{color:"var(--txt1)"}}>{rec.folio}</strong></span>
            <span style={{fontSize:11,color:"var(--txt3)"}}>{fmtDate(rec.created_at || "")}</span>
          </div>
          <div style={{background:"var(--bg3)",borderRadius:6,height:10,overflow:"hidden"}}>
            <div style={{width:`${progress}%`,height:"100%",background:progress===100?"var(--green)":"var(--blue)",borderRadius:6,transition:"width 0.3s"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:11}}>
            <span style={{color:"var(--txt3)"}}>{ubicadas}/{total} completadas</span>
            <span style={{fontWeight:700,color:progress===100?"var(--green)":"var(--blue)"}}>{progress}%</span>
          </div>
        </div>

        {/* Pending - action required */}
        {pendientes.length > 0 && (
          <div style={{marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:"var(--red)",marginBottom:6}}>
              🔴 Pendientes de conteo ({pendientes.length})
            </div>
            {pendientes.map(l => (
              <LineaCard key={l.id} linea={l} onTap={() => onSelectLinea(l)} />
            ))}
          </div>
        )}

        {/* In progress */}
        {enProceso.length > 0 && (
          <div style={{marginBottom:16}}>
            <div style={{fontSize:12,fontWeight:700,color:"var(--amber)",marginBottom:6}}>
              🟡 En proceso ({enProceso.length})
            </div>
            {enProceso.map(l => (
              <LineaCard key={l.id} linea={l} onTap={() => onSelectLinea(l)} />
            ))}
          </div>
        )}

        {/* Completed */}
        {completadas.length > 0 && (
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"var(--green)",marginBottom:6}}>
              ✅ Completadas ({completadas.length})
            </div>
            {completadas.map(l => (
              <LineaCard key={l.id} linea={l} onTap={() => onSelectLinea(l)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LineaCard({ linea: l, onTap }: { linea: DBRecepcionLinea; onTap: () => void }) {
  const icon = ESTADO_ICON[l.estado] || "⚪";
  return (
    <div onClick={onTap}
      style={{padding:"12px 14px",marginBottom:6,borderRadius:8,background:"var(--bg2)",border:"1px solid var(--bg3)",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div style={{flex:1}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span>{icon}</span>
          <span className="mono" style={{fontWeight:700,fontSize:13}}>{l.sku}</span>
        </div>
        <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>{l.nombre}</div>
        {l.estado !== "PENDIENTE" && (
          <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>
            Recibido: {l.qty_recibida}/{l.qty_factura}
            {l.requiere_etiqueta && <span> · Etiq: {l.qty_etiquetada}</span>}
            <span> · Ubic: {l.qty_ubicada}</span>
          </div>
        )}
      </div>
      <div style={{textAlign:"right"}}>
        <div className="mono" style={{fontWeight:700,fontSize:16,color:"var(--blue)"}}>{l.qty_factura}</div>
        <div style={{fontSize:9,color:"var(--txt3)"}}>factura</div>
      </div>
    </div>
  );
}

// ==================== PROCESAR LINEA ====================
function ProcesarLinea({ linea: initialLinea, recepcion, operario, onBack }: {
  linea: DBRecepcionLinea; recepcion: DBRecepcion; operario: string; onBack: () => void;
}) {
  const [linea, setLinea] = useState(initialLinea);
  const [step, setStep] = useState<"contar" | "etiquetar" | "ubicar">(determineStep(initialLinea));
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const positions = activePositions().filter(p => p.id !== "SIN_ASIGNAR");

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  const refreshLinea = async () => {
    const lineas = await getRecepcionLineas(recepcion.id!);
    const updated = lineas.find(l => l.id === linea.id);
    if (updated) { setLinea(updated); setStep(determineStep(updated)); }
  };

  // ---- PASO 1: CONTAR ----
  const [qtyReal, setQtyReal] = useState(linea.qty_factura);

  const doContar = async () => {
    setSaving(true);
    await contarLinea(linea.id!, qtyReal, operario);
    showToast(`Conteo registrado: ${qtyReal} unidades`);
    await refreshLinea();
    setSaving(false);
  };

  // ---- PASO 2: ETIQUETAR ----
  const [scanning, setScanning] = useState(false);
  const [etiqQty, setEtiqQty] = useState(0);

  const doEtiquetar = async (qty: number) => {
    const newTotal = (linea.qty_etiquetada || 0) + qty;
    const qtyTotal = linea.qty_recibida ?? linea.qty_factura;
    setSaving(true);
    await etiquetarLinea(linea.id!, newTotal, operario, qtyTotal);
    showToast(`${qty} unidades etiquetadas (${newTotal}/${qtyTotal})`);
    await refreshLinea();
    setSaving(false);
    setEtiqQty(0);
  };

  const onScanML = (code: string) => {
    setScanning(false);
    // Verify scanned code matches this product's ML code
    if (linea.codigo_ml && code.trim() !== linea.codigo_ml.trim()) {
      showToast(`⚠️ Código ${code} no corresponde a ${linea.codigo_ml}`);
      return;
    }
    showToast(`✓ Código ML verificado: ${code}`);
  };

  // ---- PASO 3: UBICAR ----
  const [ubicarQty, setUbicarQty] = useState(0);
  const [ubicarPos, setUbicarPos] = useState("");
  const [scanningPos, setScanningPos] = useState(false);

  useEffect(() => {
    const qtyTotal = linea.qty_recibida ?? linea.qty_factura;
    const remaining = qtyTotal - (linea.qty_ubicada || 0);
    setUbicarQty(Math.max(0, remaining));
  }, [linea]);

  const doUbicar = async () => {
    if (!ubicarPos || ubicarQty <= 0) return;
    setSaving(true);
    await ubicarLinea(linea.id!, linea.sku, ubicarPos, ubicarQty, operario, recepcion.id!);
    showToast(`${ubicarQty} uds ubicadas en ${ubicarPos}`);
    await refreshLinea();
    setSaving(false);
    setUbicarPos("");
  };

  const onScanPos = (code: string) => {
    setScanningPos(false);
    const pos = findPosition(code);
    if (pos) {
      setUbicarPos(pos.id);
      showToast(`Posición: ${pos.label}`);
    } else {
      showToast(`⚠️ Posición no encontrada: ${code}`);
    }
  };

  const isComplete = linea.estado === "UBICADA";
  const qtyTotal = linea.qty_recibida ?? linea.qty_factura;
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
          <div style={{fontSize:11,color:"var(--txt3)",marginTop:2}}>
            {linea.codigo_ml && <span>ML: <strong>{linea.codigo_ml}</strong> · </span>}
            Factura: <strong>{linea.qty_factura}</strong>
            {linea.qty_recibida > 0 && <span> · Recibido: <strong style={{color:linea.qty_recibida===linea.qty_factura?"var(--green)":"var(--amber)"}}>{linea.qty_recibida}</strong></span>}
          </div>
          {/* Progress bar */}
          <div style={{display:"flex",gap:4,marginTop:8}}>
            <StepPill label="Conteo" active={step==="contar"} done={["CONTADA","EN_ETIQUETADO","ETIQUETADA","UBICADA"].includes(linea.estado)} />
            {linea.requiere_etiqueta && <StepPill label="Etiquetado" active={step==="etiquetar"} done={["ETIQUETADA","UBICADA"].includes(linea.estado)} />}
            <StepPill label="Ubicación" active={step==="ubicar"} done={linea.estado==="UBICADA"} />
          </div>
        </div>

        {/* COMPLETADA */}
        {isComplete && (
          <div style={{textAlign:"center",padding:24}}>
            <div style={{fontSize:48,marginBottom:8}}>✅</div>
            <div style={{fontSize:18,fontWeight:700,color:"var(--green)"}}>Línea completada</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginTop:4}}>
              {linea.qty_ubicada} unidades ubicadas
            </div>
            <button onClick={onBack} style={{marginTop:16,padding:"12px 24px",borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:13,fontWeight:700,border:"1px solid var(--bg4)"}}>
              ← Volver a recepción
            </button>
          </div>
        )}

        {/* PASO 1: CONTAR */}
        {step === "contar" && !isComplete && (
          <div style={{padding:"16px",borderRadius:10,background:"var(--bg2)",border:"2px solid var(--amber)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 1 — Conteo</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:12}}>
              La factura dice <strong style={{color:"var(--txt1)"}}>{linea.qty_factura} unidades</strong>. ¿Cuántas recibiste realmente?
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
              <button onClick={() => setQtyReal(q => Math.max(0, q - 1))} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
              <input type="number" value={qtyReal} onChange={e => setQtyReal(Math.max(0, parseInt(e.target.value) || 0))}
                style={{width:80,textAlign:"center",fontSize:28,fontWeight:700,padding:10,borderRadius:8,background:"var(--bg1)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
              <button onClick={() => setQtyReal(q => q + 1)} style={{width:44,height:44,borderRadius:8,background:"var(--bg3)",fontSize:20,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
            </div>
            {qtyReal !== linea.qty_factura && (
              <div style={{textAlign:"center",marginBottom:8,padding:"6px 12px",borderRadius:6,
                background:qtyReal < linea.qty_factura ? "var(--amberBg)" : "var(--redBg)",
                color:qtyReal < linea.qty_factura ? "var(--amber)" : "var(--red)",
                fontSize:12,fontWeight:700}}>
                {qtyReal < linea.qty_factura
                  ? `⚠️ Faltan ${linea.qty_factura - qtyReal} unidades`
                  : `⚠️ Sobran ${qtyReal - linea.qty_factura} unidades`}
              </div>
            )}
            <button onClick={doContar} disabled={saving}
              style={{width:"100%",padding:14,borderRadius:10,background:saving?"var(--bg3)":"var(--green)",color:saving?"var(--txt3)":"#fff",fontSize:14,fontWeight:700}}>
              {saving ? "Guardando..." : `Confirmar: ${qtyReal} unidades recibidas`}
            </button>
          </div>
        )}

        {/* PASO 2: ETIQUETAR */}
        {step === "etiquetar" && !isComplete && (
          <div style={{padding:"16px",borderRadius:10,background:"var(--bg2)",border:"2px solid var(--blue)"}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:4}}>Paso 2 — Etiquetado</div>
            <div style={{fontSize:12,color:"var(--txt3)",marginBottom:4}}>
              Etiqueta cada unidad con código ML: <strong style={{color:"var(--cyan)"}}>{linea.codigo_ml}</strong>
            </div>
            {/* Progress */}
            <div style={{background:"var(--bg3)",borderRadius:6,height:8,overflow:"hidden",marginBottom:8}}>
              <div style={{width:`${Math.round(((linea.qty_etiquetada||0)/qtyTotal)*100)}%`,height:"100%",background:"var(--blue)",borderRadius:6}}/>
            </div>
            <div style={{fontSize:12,marginBottom:12,color:"var(--txt2)"}}>
              <strong>{linea.qty_etiquetada || 0}</strong> de <strong>{qtyTotal}</strong> etiquetadas
              {(qtyTotal - (linea.qty_etiquetada||0)) > 0 && <span style={{color:"var(--amber)"}}> — faltan {qtyTotal - (linea.qty_etiquetada||0)}</span>}
            </div>

            {/* Scan to verify */}
            {!scanning ? (
              <button onClick={() => setScanning(true)}
                style={{width:"100%",padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)",marginBottom:10}}>
                📷 Escanear código ML para verificar
              </button>
            ) : (
              <div style={{marginBottom:10}}>
                <BarcodeScanner onScan={onScanML} active={true} label="Escanear código ML" mode="barcode" />
                <button onClick={() => setScanning(false)} style={{width:"100%",marginTop:6,padding:8,borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:11}}>Cancelar escaneo</button>
              </div>
            )}

            {/* Mark quantity as labeled */}
            <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>¿Cuántas etiquetaste en esta tanda?</div>
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

            {/* Scan position QR */}
            {!scanningPos ? (
              <button onClick={() => setScanningPos(true)}
                style={{width:"100%",padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--cyan)",fontSize:12,fontWeight:600,border:"1px solid var(--bg4)",marginBottom:10}}>
                📷 Escanear QR de posición
              </button>
            ) : (
              <div style={{marginBottom:10}}>
                <BarcodeScanner onScan={onScanPos} active={true} label="Escanear QR posición" mode="qr" />
                <button onClick={() => setScanningPos(false)} style={{width:"100%",marginTop:6,padding:8,borderRadius:6,background:"var(--bg3)",color:"var(--txt3)",fontSize:11}}>Cancelar escaneo</button>
              </div>
            )}

            {/* Or select manually */}
            <div style={{fontSize:11,textAlign:"center",color:"var(--txt3)",marginBottom:6}}>o selecciona manualmente</div>
            <select className="form-select" value={ubicarPos} onChange={e => setUbicarPos(e.target.value)}
              style={{width:"100%",padding:10,fontSize:13,marginBottom:10}}>
              <option value="">— Seleccionar posición —</option>
              {positions.map(p => <option key={p.id} value={p.id}>{p.id} — {p.label}</option>)}
            </select>

            {ubicarPos && (
              <>
                <div style={{fontSize:12,fontWeight:600,color:"var(--txt2)",marginBottom:6}}>Cantidad a ubicar en {ubicarPos}:</div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:12,marginBottom:12}}>
                  <button onClick={() => setUbicarQty(q => Math.max(1, q - 1))} style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>−</button>
                  <input type="number" value={ubicarQty} onChange={e => setUbicarQty(Math.max(1, Math.min(qtyPendienteUbicar, parseInt(e.target.value) || 0)))}
                    style={{width:70,textAlign:"center",fontSize:24,fontWeight:700,padding:8,borderRadius:8,background:"var(--bg1)",border:"2px solid var(--bg4)",color:"var(--txt1)"}} />
                  <button onClick={() => setUbicarQty(q => Math.min(qtyPendienteUbicar, q + 1))} style={{width:40,height:40,borderRadius:8,background:"var(--bg3)",fontSize:18,fontWeight:700,border:"1px solid var(--bg4)"}}>+</button>
                </div>
                {ubicarQty < qtyPendienteUbicar && (
                  <div style={{textAlign:"center",fontSize:11,color:"var(--amber)",marginBottom:8}}>
                    Quedarán {qtyPendienteUbicar - ubicarQty} unidades sin ubicar (puedes dividir en otra posición)
                  </div>
                )}
                <button onClick={doUbicar} disabled={saving}
                  style={{width:"100%",padding:14,borderRadius:10,background:saving?"var(--bg3)":"var(--green)",color:saving?"var(--txt3)":"#fff",fontSize:14,fontWeight:700}}>
                  {saving ? "Guardando..." : `Ubicar ${ubicarQty} uds en posición ${ubicarPos}`}
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
    return l.requiere_etiqueta ? "etiquetar" : "ubicar";
  }
  if (l.estado === "ETIQUETADA") return "ubicar";
  return "ubicar"; // UBICADA - show completed
}
