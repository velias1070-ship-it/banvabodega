"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, fmtDate, fmtTime, fmtMoney, findProduct, skuTotal, skuPositions, posContents, activePositions, recordMovement, recordMovementAsync } from "@/lib/store";
import type { Product, Position } from "@/lib/store";
import { fetchConteos, createConteo, updateConteo, deleteConteo } from "@/lib/db";
import type { DBConteo, ConteoLinea } from "@/lib/db";

// ==================== CONTEO CÍCLICO ====================
function AdminConteos({ refresh }: { refresh: () => void }) {
  const [conteos, setConteos] = useState<DBConteo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selConteo, setSelConteo] = useState<DBConteo | null>(null);
  const [filter, setFilter] = useState<"activas"|"revision"|"cerradas"|"todas">("activas");

  const loadConteos = useCallback(async () => {
    setLoading(true);
    const data = await fetchConteos();
    setConteos(data);
    setLoading(false);
  }, []);

  useEffect(() => { loadConteos(); }, [loadConteos]);

  const counts = {
    activas: conteos.filter(c => ["ABIERTA","EN_PROCESO"].includes(c.estado)).length,
    revision: conteos.filter(c => c.estado === "REVISION").length,
    cerradas: conteos.filter(c => c.estado === "CERRADA").length,
    todas: conteos.length,
  };

  const filtered = conteos.filter(c => {
    if (filter === "activas") return ["ABIERTA","EN_PROCESO"].includes(c.estado);
    if (filter === "revision") return c.estado === "REVISION";
    if (filter === "cerradas") return c.estado === "CERRADA";
    return true;
  });

  if (selConteo) {
    return <ConteoDetail conteo={selConteo} onBack={() => { setSelConteo(null); loadConteos(); }} refresh={refresh}/>;
  }

  if (showCreate) {
    return <CreateConteo onCreated={() => { setShowCreate(false); loadConteos(); }} onCancel={() => setShowCreate(false)}/>;
  }

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div className="card-title">📋 Conteo Cíclico</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={loadConteos} style={{padding:"8px 14px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄</button>
            <button onClick={() => setShowCreate(true)} style={{padding:"8px 16px",borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,fontSize:13}}>+ Nuevo Conteo</button>
          </div>
        </div>
        <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap"}}>
          {(["activas","revision","cerradas","todas"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{padding:"6px 12px",borderRadius:6,fontSize:11,fontWeight:600,
                background: filter === f ? "var(--cyan)" : "var(--bg3)",
                color: filter === f ? "#000" : "var(--txt2)",
                border:`1px solid ${filter === f ? "var(--cyan)" : "var(--bg4)"}`}}>
              {f === "activas" ? "Activas" : f === "revision" ? "En revisión" : f === "cerradas" ? "Cerradas" : "Todas"} ({counts[f]})
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin conteos</div>
        </div>
      )}

      {filtered.map(c => {
        const total = c.posiciones.length;
        const done = c.posiciones_contadas.length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const estadoColors: Record<string, string> = { ABIERTA: "#f59e0b", EN_PROCESO: "#3b82f6", REVISION: "#a855f7", CERRADA: "#10b981" };
        const color = estadoColors[c.estado] || "#94a3b8";
        return (
          <div key={c.id} className="card" style={{cursor:"pointer",border:`1px solid ${color}33`}} onClick={() => setSelConteo(c)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <div style={{fontSize:14,fontWeight:700}}>Conteo {c.fecha}</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>
                  {c.tipo === "por_posicion" ? "Por posición" : "Por SKU"} · {total} posiciones · Creado por: {c.created_by}
                </div>
              </div>
              <span style={{padding:"4px 10px",borderRadius:6,fontSize:10,fontWeight:700,background:`${color}22`,color,border:`1px solid ${color}44`}}>
                {c.estado}
              </span>
            </div>
            <div style={{background:"var(--bg3)",borderRadius:6,height:6,overflow:"hidden"}}>
              <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:6,transition:"width .3s"}}/>
            </div>
            <div style={{fontSize:10,color:"var(--txt3)",marginTop:4}}>{done}/{total} posiciones contadas</div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== CREATE CONTEO ====================
function CreateConteo({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [tipo, setTipo] = useState<"por_posicion" | "por_sku">("por_posicion");
  const [selPositions, setSelPositions] = useState<Set<string>>(new Set());
  const [skuSearch, setSkuSearch] = useState("");
  const [selSkus, setSelSkus] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const s = getStore();
  const positions = activePositions().filter(p => p.active);
  const allProds = Object.values(s.products).sort((a, b) => a.sku.localeCompare(b.sku));

  const togglePos = (id: string) => {
    const next = new Set(selPositions);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelPositions(next);
  };

  const selectAllPositions = () => {
    if (selPositions.size === positions.length) setSelPositions(new Set());
    else setSelPositions(new Set(positions.map(p => p.id)));
  };

  const toggleSku = (sku: string) => {
    const next = new Set(selSkus);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setSelSkus(next);
  };

  const skuResults = skuSearch.length >= 2 ? findProduct(skuSearch).slice(0, 10) : [];

  const doCreate = async () => {
    setCreating(true);
    const fecha = new Date().toISOString().slice(0, 10);
    let posicionesConteo: string[] = [];
    const lineas: ConteoLinea[] = [];

    if (tipo === "por_posicion") {
      posicionesConteo = Array.from(selPositions);
      for (const posId of posicionesConteo) {
        const items = posContents(posId);
        const pos = positions.find(p => p.id === posId);
        for (const item of items) {
          if (item.qty <= 0) continue;
          lineas.push({
            posicion_id: posId,
            posicion_label: pos?.label || posId,
            sku: item.sku,
            nombre: item.name,
            stock_sistema: item.qty,
            stock_contado: 0,
            operario: "",
            timestamp: "",
            estado: "PENDIENTE",
            es_inesperado: false,
          });
        }
      }
    } else {
      // por_sku: find all positions for selected SKUs
      const posSet = new Set<string>();
      for (const sku of Array.from(selSkus)) {
        const posiciones = skuPositions(sku);
        for (const p of posiciones) {
          posSet.add(p.pos);
          const pos = positions.find(pp => pp.id === p.pos);
          lineas.push({
            posicion_id: p.pos,
            posicion_label: pos?.label || p.pos,
            sku,
            nombre: s.products[sku]?.name || sku,
            stock_sistema: p.qty,
            stock_contado: 0,
            operario: "",
            timestamp: "",
            estado: "PENDIENTE",
            es_inesperado: false,
          });
        }
      }
      posicionesConteo = Array.from(posSet);
    }

    if (posicionesConteo.length === 0) { setCreating(false); return; }

    await createConteo({
      fecha,
      tipo,
      estado: "ABIERTA",
      lineas,
      posiciones: posicionesConteo,
      posiciones_contadas: [],
      created_by: "Admin",
      closed_at: null,
      closed_by: null,
    });

    setCreating(false);
    onCreated();
  };

  return (
    <div>
      <div className="card" style={{border:"2px solid var(--cyan)"}}>
        <div className="card-title">Nuevo Conteo Cíclico</div>

        <div style={{marginBottom:16}}>
          <div className="form-label">Tipo de conteo</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={() => setTipo("por_posicion")}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background: tipo === "por_posicion" ? "var(--cyan)" : "var(--bg3)",
                color: tipo === "por_posicion" ? "#000" : "var(--txt2)",
                border:`1px solid ${tipo === "por_posicion" ? "var(--cyan)" : "var(--bg4)"}`}}>
              📍 Por Posición
            </button>
            <button onClick={() => setTipo("por_sku")}
              style={{flex:1,padding:12,borderRadius:8,fontWeight:700,fontSize:13,
                background: tipo === "por_sku" ? "var(--cyan)" : "var(--bg3)",
                color: tipo === "por_sku" ? "#000" : "var(--txt2)",
                border:`1px solid ${tipo === "por_sku" ? "var(--cyan)" : "var(--bg4)"}`}}>
              🏷️ Por SKU
            </button>
          </div>
        </div>

        {tipo === "por_posicion" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div className="form-label" style={{marginBottom:0}}>Seleccionar posiciones ({selPositions.size})</div>
              <button onClick={selectAllPositions}
                style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)"}}>
                {selPositions.size === positions.length ? "Deseleccionar todas" : "Seleccionar todas"}
              </button>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:4,maxHeight:200,overflow:"auto",padding:4}}>
              {positions.map(p => {
                const sel = selPositions.has(p.id);
                const items = posContents(p.id);
                const qty = items.reduce((s, i) => s + i.qty, 0);
                return (
                  <button key={p.id} onClick={() => togglePos(p.id)}
                    style={{padding:"6px 10px",borderRadius:6,fontSize:11,fontWeight:600,
                      background: sel ? "var(--cyan)" : "var(--bg3)",
                      color: sel ? "#000" : qty > 0 ? "var(--txt1)" : "var(--txt3)",
                      border:`1px solid ${sel ? "var(--cyan)" : "var(--bg4)"}`,
                      opacity: qty > 0 || sel ? 1 : 0.5}}>
                    {p.id} {qty > 0 && `(${qty})`}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tipo === "por_sku" && (
          <div>
            <div className="form-label">Buscar y seleccionar SKUs ({selSkus.size})</div>
            <input className="form-input mono" value={skuSearch} onChange={e => setSkuSearch(e.target.value)}
              placeholder="Buscar SKU o nombre..." style={{fontSize:12,marginBottom:8}}/>
            {skuResults.map(p => {
              const sel = selSkus.has(p.sku);
              const stock = skuTotal(p.sku);
              return (
                <button key={p.sku} onClick={() => toggleSku(p.sku)}
                  style={{width:"100%",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"8px 12px",marginBottom:2,borderRadius:6,
                    background: sel ? "var(--cyan)15" : "var(--bg3)",
                    border:`1px solid ${sel ? "var(--cyan)" : "var(--bg4)"}`,cursor:"pointer"}}>
                  <div>
                    <span className="mono" style={{fontWeight:700,fontSize:12}}>{p.sku}</span>
                    <span style={{marginLeft:8,fontSize:11,color:"var(--txt3)"}}>{p.name}</span>
                  </div>
                  <span style={{fontSize:11,fontWeight:600,color:sel?"var(--cyan)":"var(--txt3)"}}>{stock} uds {sel?"✓":""}</span>
                </button>
              );
            })}
            {selSkus.size > 0 && (
              <div style={{marginTop:8,display:"flex",flexWrap:"wrap",gap:4}}>
                {Array.from(selSkus).map(sku => (
                  <span key={sku} onClick={() => toggleSku(sku)} style={{cursor:"pointer",padding:"4px 8px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--cyan)22",color:"var(--cyan)",border:"1px solid var(--cyan)44"}}>
                    {sku} ✕
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={onCancel} style={{flex:1,padding:10,borderRadius:8,background:"var(--bg3)",color:"var(--txt3)",fontWeight:600,border:"1px solid var(--bg4)"}}>Cancelar</button>
          <button onClick={doCreate} disabled={creating || (tipo === "por_posicion" ? selPositions.size === 0 : selSkus.size === 0)}
            style={{flex:2,padding:10,borderRadius:8,background:"var(--green)",color:"#fff",fontWeight:700,
              opacity: (tipo === "por_posicion" ? selPositions.size > 0 : selSkus.size > 0) ? 1 : 0.5}}>
            {creating ? "Creando..." : "Crear Conteo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ==================== CONTEO DETAIL / REVIEW ====================
function ConteoDetail({ conteo: initialConteo, onBack, refresh }: { conteo: DBConteo; onBack: () => void; refresh: () => void }) {
  const [conteo, setConteo] = useState(initialConteo);
  const [processing, setProcessing] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  // Función para refrescar stock_sistema con el stock real actual
  const refreshStockSistema = useCallback(() => {
    const s = getStore();
    let changed = false;
    const fixedLineas = conteo.lineas.map(l => {
      if (l.estado === "AJUSTADO" || l.estado === "VERIFICADO") return l;
      const stockReal = s.stock[l.sku]?.[l.posicion_id] ?? 0;
      if (stockReal !== l.stock_sistema) {
        changed = true;
        return { ...l, stock_sistema: stockReal };
      }
      return l;
    });
    if (changed) {
      const updated = { ...conteo, lineas: fixedLineas };
      setConteo(updated);
      updateConteo(conteo.id!, { lineas: fixedLineas });
    }
    setLastRefresh(Date.now());
  }, [conteo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refrescar al montar
  useEffect(() => { refreshStockSistema(); }, [initialConteo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Obtener movimientos que ocurrieron durante el conteo para los SKUs contados
  const getMovsDuranteConteo = useCallback((sku: string, posId?: string) => {
    const s = getStore();
    const desde = conteo.created_at || conteo.fecha + "T00:00:00";
    return s.movements.filter(m => {
      if (m.sku !== sku) return false;
      if (posId && m.pos !== posId) return false;
      if (m.ts < desde) return false;
      // Excluir movimientos generados por el propio conteo
      if (m.note?.includes("conteo cíclico") || m.note?.includes("Traspaso conteo")) return false;
      return true;
    });
  }, [conteo.created_at, conteo.fecha]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadConteo = async () => {
    const all = await fetchConteos();
    const found = all.find(c => c.id === conteo.id);
    if (found) setConteo(found);
  };

  const positions = activePositions();
  const posMap = new Map(positions.map(p => [p.id, p]));

  // Group lines by position
  const byPosition = new Map<string, ConteoLinea[]>();
  for (const l of conteo.lineas) {
    if (!byPosition.has(l.posicion_id)) byPosition.set(l.posicion_id, []);
    byPosition.get(l.posicion_id)!.push(l);
  }

  // Stats
  const totalLineas = conteo.lineas.filter(l => l.estado !== "PENDIENTE").length;
  const conDiferencia = conteo.lineas.filter(l => l.estado === "CONTADO" && l.stock_sistema !== l.stock_contado).length;
  const sinDiferencia = conteo.lineas.filter(l => l.estado === "CONTADO" && l.stock_sistema === l.stock_contado).length;
  const ajustados = conteo.lineas.filter(l => l.estado === "AJUSTADO" || l.estado === "VERIFICADO").length;

  const aprobarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const linea = conteo.lineas.find(l => l.posicion_id === posId && l.sku === sku && l.estado === "CONTADO");
    if (!linea) { setProcessing(false); return; }

    const diff = linea.stock_contado - linea.stock_sistema;
    if (diff !== 0) {
      const ts = new Date().toISOString();
      await recordMovementAsync({
        ts,
        type: diff > 0 ? "in" : "out",
        reason: "ajuste_conteo",
        sku: linea.sku,
        pos: linea.posicion_id,
        qty: Math.abs(diff),
        who: "Admin (conteo)",
        note: `Ajuste conteo cíclico ${conteo.fecha} — ${diff > 0 ? "sobrante" : "faltante"}`,
      });
    }

    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "AJUSTADO" as const } : l
    );

    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");

    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });

    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    refresh();
    setProcessing(false);
  };

  const rechazarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "VERIFICADO" as const } : l
    );
    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");
    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });
    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    setProcessing(false);
  };

  const recontarLinea = async (posId: string, sku: string) => {
    setProcessing(true);
    const newLineas = conteo.lineas.map(l =>
      l.posicion_id === posId && l.sku === sku ? { ...l, estado: "PENDIENTE" as const, stock_contado: 0, operario: "", timestamp: "" } : l
    );
    // Remove position from contadas so operator can recount
    const newContadas = conteo.posiciones_contadas.filter(p => p !== posId);
    await updateConteo(conteo.id!, { lineas: newLineas, posiciones_contadas: newContadas, estado: "EN_PROCESO" });
    setConteo({ ...conteo, lineas: newLineas, posiciones_contadas: newContadas, estado: "EN_PROCESO" });
    setProcessing(false);
  };

  // Traspasar: mover stock de una posición origen a la posición contada (en vez de ajustar)
  const traspasarLinea = async (posId: string, sku: string, fromPos: string, qty: number) => {
    if (!confirm(`¿Traspasar ${qty} unidades de ${sku} desde ${fromPos} → ${posId}?\n\nEsto NO cambia el stock total, solo mueve entre posiciones.`)) return;
    setProcessing(true);
    const ts = new Date().toISOString();
    const nota = `Traspaso conteo cíclico ${conteo.fecha}: ${fromPos} → ${posId}`;
    // Salida desde la posición origen
    await recordMovementAsync({
      ts, type: "out", reason: "ajuste_conteo", sku, pos: fromPos, qty,
      who: "Admin (conteo)", note: nota,
    });
    // Entrada en la posición destino
    await recordMovementAsync({
      ts, type: "in", reason: "ajuste_conteo", sku, pos: posId, qty,
      who: "Admin (conteo)", note: nota,
    });

    // Marcar la línea como ajustada y actualizar stock_sistema
    const s = getStore();
    const newLineas = conteo.lineas.map(l => {
      if (l.posicion_id === posId && l.sku === sku) {
        return { ...l, estado: "AJUSTADO" as const, stock_sistema: s.stock[sku]?.[posId] ?? l.stock_contado };
      }
      return l;
    });

    const allResolved = newLineas.every(l => l.estado !== "CONTADO" && l.estado !== "PENDIENTE");
    await updateConteo(conteo.id!, {
      lineas: newLineas,
      ...(allResolved ? { estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" } : {}),
    });
    setConteo({ ...conteo, lineas: newLineas, ...(allResolved ? { estado: "CERRADA" as const } : {}) });
    refresh();
    setProcessing(false);
  };

  const aprobarTodo = async () => {
    if (!confirm("¿Aprobar TODOS los ajustes pendientes? Se generarán movimientos automáticos.")) return;
    setProcessing(true);
    for (const l of conteo.lineas) {
      if (l.estado !== "CONTADO") continue;
      const diff = l.stock_contado - l.stock_sistema;
      if (diff !== 0) {
        await recordMovementAsync({
          ts: new Date().toISOString(),
          type: diff > 0 ? "in" : "out",
          reason: "ajuste_conteo",
          sku: l.sku,
          pos: l.posicion_id,
          qty: Math.abs(diff),
          who: "Admin (conteo)",
          note: `Ajuste conteo cíclico ${conteo.fecha}`,
        });
      }
    }
    const newLineas = conteo.lineas.map(l => l.estado === "CONTADO" ? { ...l, estado: "AJUSTADO" as const } : l);
    await updateConteo(conteo.id!, { lineas: newLineas, estado: "CERRADA", closed_at: new Date().toISOString(), closed_by: "Admin" });
    setConteo({ ...conteo, lineas: newLineas, estado: "CERRADA" });
    refresh();
    setProcessing(false);
  };

  const doDelete = async () => {
    if (!confirm("¿Eliminar este conteo? Esta acción no se puede deshacer.")) return;
    await deleteConteo(conteo.id!);
    onBack();
  };

  return (
    <div>
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <button onClick={onBack} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontWeight:600,background:"var(--bg3)",color:"var(--cyan)",border:"1px solid var(--bg4)",marginBottom:8}}>← Volver</button>
            <div className="card-title">📋 Conteo {conteo.fecha}</div>
            <div style={{fontSize:11,color:"var(--txt3)"}}>
              {conteo.tipo === "por_posicion" ? "Por posición" : "Por SKU"} · {conteo.posiciones.length} posiciones · Estado: <strong>{conteo.estado}</strong>
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {conteo.estado !== "CERRADA" && (
              <button onClick={refreshStockSistema} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>🔄 Refrescar stock</button>
            )}
            {conteo.estado !== "CERRADA" && (
              <button onClick={doDelete} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--red)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>Eliminar</button>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
        {[
          { label: "Contados", value: totalLineas, color: "#3b82f6" },
          { label: "Sin diferencia", value: sinDiferencia, color: "#10b981" },
          { label: "Con diferencia", value: conDiferencia, color: "#f59e0b" },
          { label: "Resueltos", value: ajustados, color: "#a855f7" },
        ].map(st => (
          <div key={st.label} className="card" style={{textAlign:"center",padding:12}}>
            <div style={{fontSize:20,fontWeight:800,color:st.color}}>{st.value}</div>
            <div style={{fontSize:10,color:"var(--txt3)"}}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Approve all button */}
      {conteo.estado === "REVISION" && conDiferencia > 0 && (
        <div className="card" style={{border:"2px solid #a855f744"}}>
          <button onClick={aprobarTodo} disabled={processing}
            style={{width:"100%",padding:14,borderRadius:10,background:"linear-gradient(135deg,#7c3aed,#a855f7)",color:"#fff",fontWeight:700,fontSize:14,border:"none",cursor:"pointer"}}>
            {processing ? "Procesando..." : `✅ Aprobar todos los ajustes (${conDiferencia} diferencias)`}
          </button>
        </div>
      )}

      {/* Lines by position */}
      {Array.from(byPosition.entries()).map(([posId, lines]) => {
        const pos = posMap.get(posId);
        const isDone = conteo.posiciones_contadas.includes(posId);
        return (
          <div key={posId} className="card" style={{border:`1px solid ${isDone ? "var(--bg4)" : "var(--bg3)"}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span className="mono" style={{fontSize:14,fontWeight:800,color:"var(--cyan)"}}>{posId}</span>
                <span style={{fontSize:12,color:"var(--txt3)"}}>{pos?.label || posId}</span>
              </div>
              {isDone ? <span style={{fontSize:10,fontWeight:700,color:"#10b981"}}>✅ Contada</span> :
                <span style={{fontSize:10,fontWeight:700,color:"#f59e0b"}}>⏳ Pendiente</span>}
            </div>
            <table className="tbl" style={{fontSize:12}}>
              <thead>
                <tr>
                  <th>SKU</th><th>Producto</th>
                  <th style={{textAlign:"right"}}>Sistema</th>
                  <th style={{textAlign:"right"}}>Contado</th>
                  <th style={{textAlign:"right"}}>Diff</th>
                  <th>Estado</th>
                  {(conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") && <th></th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const diff = l.stock_contado - l.stock_sistema;
                  const diffColor = diff === 0 ? "#10b981" : Math.abs(diff) >= 5 ? "#ef4444" : "#f59e0b";
                  const isContado = l.estado === "CONTADO";
                  const lineKey = `${l.posicion_id}|${l.sku}`;
                  const isExpanded = expandedSku === lineKey;
                  const hasDiff = l.estado !== "PENDIENTE" && diff !== 0;
                  const colCount = (conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") ? 7 : 6;

                  // Build stock global info for this SKU
                  const s = getStore();
                  const skuStock = s.stock[l.sku] || {};
                  const allPositions = Object.entries(skuStock).filter(([, q]) => q > 0);
                  const totalSistema = allPositions.reduce((sum, [, q]) => sum + q, 0);

                  // Find all conteo lines for this SKU (to show what operator counted elsewhere)
                  const conteoLinesSku = conteo.lineas.filter(cl => cl.sku === l.sku);

                  // Projected total if approved: total sistema + diff for this line
                  const proyectado = totalSistema + diff;

                  return (
                    <React.Fragment key={i}>
                    <tr style={{background: l.estado === "PENDIENTE" ? "transparent" : diff === 0 ? "#10b98108" : `${diffColor}08`, cursor: hasDiff ? "pointer" : "default"}}
                      onClick={() => hasDiff && setExpandedSku(isExpanded ? null : lineKey)}>
                      <td className="mono" style={{fontWeight:700,fontSize:11}}>
                        {l.sku}
                        {l.es_inesperado && <span style={{marginLeft:4,fontSize:9,padding:"1px 4px",borderRadius:3,background:"#f59e0b22",color:"#f59e0b",fontWeight:700}}>NUEVO</span>}
                        {hasDiff && <span style={{marginLeft:4,fontSize:9,color:"var(--txt3)"}}>{isExpanded ? "▼" : "▶"}</span>}
                      </td>
                      <td style={{fontSize:11,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nombre}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:600}}>{l.stock_sistema}</td>
                      <td className="mono" style={{textAlign:"right",fontWeight:700,color: l.estado === "PENDIENTE" ? "var(--txt3)" : diffColor}}>
                        {l.estado === "PENDIENTE" ? "—" : l.stock_contado}
                      </td>
                      <td className="mono" style={{textAlign:"right",fontWeight:800,color: l.estado === "PENDIENTE" ? "var(--txt3)" : diffColor}}>
                        {l.estado === "PENDIENTE" ? "—" : diff === 0 ? "OK" : (diff > 0 ? "+" : "") + diff}
                      </td>
                      <td>
                        <span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:3,
                          background: l.estado === "PENDIENTE" ? "#64748b22" : l.estado === "CONTADO" ? "#3b82f622" : l.estado === "AJUSTADO" ? "#10b98122" : "#a855f722",
                          color: l.estado === "PENDIENTE" ? "#64748b" : l.estado === "CONTADO" ? "#3b82f6" : l.estado === "AJUSTADO" ? "#10b981" : "#a855f7"}}>
                          {l.estado}
                        </span>
                      </td>
                      {(conteo.estado === "REVISION" || conteo.estado === "EN_PROCESO") && (
                        <td style={{textAlign:"right",whiteSpace:"nowrap"}} onClick={e => e.stopPropagation()}>
                          {isContado && diff !== 0 && (
                            <>
                              <button onClick={() => aprobarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#10b98122",color:"#10b981",border:"1px solid #10b98144",marginRight:3}}>
                                Aprobar
                              </button>
                              <button onClick={() => rechazarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"var(--bg3)",color:"var(--txt3)",border:"1px solid var(--bg4)",marginRight:3}}>
                                Rechazar
                              </button>
                              <button onClick={() => recontarLinea(l.posicion_id, l.sku)} disabled={processing}
                                style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#f59e0b22",color:"#f59e0b",border:"1px solid #f59e0b44"}}>
                                Recontar
                              </button>
                            </>
                          )}
                          {isContado && diff === 0 && (
                            <span style={{fontSize:9,color:"#10b981",fontWeight:600}}>✓ OK</span>
                          )}
                        </td>
                      )}
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={colCount} style={{padding:0,border:"none"}}>
                          <div style={{margin:"0 0 8px 0",padding:"10px 14px",background:"var(--bg2)",borderRadius:8,border:"1px solid var(--bg4)"}}>
                            <div style={{fontSize:11,fontWeight:700,color:"var(--cyan)",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <span>📦 Stock global de {l.sku}</span>
                              <span className="mono" style={{fontSize:12,color:"var(--txt)"}}>
                                Total sistema: <b>{totalSistema}</b>
                                {l.estado !== "PENDIENTE" && diff !== 0 && (
                                  <span style={{marginLeft:8,color: proyectado > totalSistema ? "#ef4444" : proyectado < totalSistema ? "#f59e0b" : "#10b981"}}>
                                    → Si aprueba: <b>{proyectado}</b> ({diff > 0 ? "+" : ""}{diff})
                                  </span>
                                )}
                              </span>
                            </div>
                            <table style={{width:"100%",fontSize:11,borderCollapse:"collapse"}}>
                              <thead>
                                <tr style={{borderBottom:"1px solid var(--bg4)"}}>
                                  <th style={{textAlign:"left",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Posición</th>
                                  <th style={{textAlign:"right",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Stock sistema</th>
                                  <th style={{textAlign:"right",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>Contado</th>
                                  <th style={{textAlign:"left",padding:"3px 6px",fontSize:10,color:"var(--txt3)",fontWeight:600}}>En conteo</th>
                                </tr>
                              </thead>
                              <tbody>
                                {allPositions.map(([pid, qty]) => {
                                  const conteoLine = conteoLinesSku.find(cl => cl.posicion_id === pid);
                                  const enConteo = conteo.posiciones.includes(pid);
                                  const esEstaLinea = pid === l.posicion_id;
                                  return (
                                    <tr key={pid} style={{borderBottom:"1px solid var(--bg3)", background: esEstaLinea ? `${diffColor}10` : "transparent"}}>
                                      <td className="mono" style={{padding:"4px 6px",fontWeight: esEstaLinea ? 800 : 500, color: esEstaLinea ? "var(--cyan)" : "var(--txt2)"}}>
                                        {pid} {esEstaLinea && "◀"}
                                      </td>
                                      <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600}}>{qty}</td>
                                      <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600,
                                        color: conteoLine && conteoLine.estado !== "PENDIENTE" ? (conteoLine.stock_contado !== qty ? "#f59e0b" : "#10b981") : "var(--txt3)"}}>
                                        {conteoLine && conteoLine.estado !== "PENDIENTE" ? conteoLine.stock_contado : "—"}
                                      </td>
                                      <td style={{padding:"4px 6px",fontSize:10}}>
                                        {enConteo ? (
                                          conteoLine && conteoLine.estado !== "PENDIENTE" ?
                                            <span style={{color:"#10b981",fontWeight:600}}>✓ Contada</span> :
                                            <span style={{color:"#f59e0b",fontWeight:600}}>⏳ Pendiente</span>
                                        ) : (
                                          <span style={{color:"var(--txt3)"}}>No incluida</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                                {/* Positions in conteo with this SKU but 0 system stock (inesperado scenarios) */}
                                {conteoLinesSku.filter(cl => !allPositions.some(([pid]) => pid === cl.posicion_id)).map(cl => (
                                  <tr key={cl.posicion_id} style={{borderBottom:"1px solid var(--bg3)", background: cl.posicion_id === l.posicion_id ? `${diffColor}10` : "transparent"}}>
                                    <td className="mono" style={{padding:"4px 6px",fontWeight: cl.posicion_id === l.posicion_id ? 800 : 500, color: cl.posicion_id === l.posicion_id ? "var(--cyan)" : "var(--txt2)"}}>
                                      {cl.posicion_id} {cl.posicion_id === l.posicion_id && "◀"}
                                    </td>
                                    <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600}}>0</td>
                                    <td className="mono" style={{textAlign:"right",padding:"4px 6px",fontWeight:600,
                                      color: cl.estado !== "PENDIENTE" ? (cl.stock_contado !== 0 ? "#f59e0b" : "#10b981") : "var(--txt3)"}}>
                                      {cl.estado !== "PENDIENTE" ? cl.stock_contado : "—"}
                                    </td>
                                    <td style={{padding:"4px 6px",fontSize:10}}>
                                      {cl.estado !== "PENDIENTE" ?
                                        <span style={{color:"#10b981",fontWeight:600}}>✓ Contada</span> :
                                        <span style={{color:"#f59e0b",fontWeight:600}}>⏳ Pendiente</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {/* Warning if position with stock not included in conteo */}
                            {allPositions.some(([pid]) => !conteo.posiciones.includes(pid)) && (
                              <div style={{marginTop:8,padding:"6px 10px",borderRadius:6,background:"#f59e0b15",border:"1px solid #f59e0b33",fontSize:10,color:"#f59e0b",fontWeight:600}}>
                                ⚠️ Hay posiciones con stock de este SKU que NO están incluidas en este conteo. Verifique antes de aprobar.
                              </div>
                            )}
                            {/* Transfer detection: if this line has +N and there are other positions with stock that could be the source */}
                            {isContado && diff > 0 && (() => {
                              // Find positions with stock that could be the source of the transfer
                              const transferSources = allPositions
                                .filter(([pid]) => pid !== l.posicion_id)
                                .filter(([pid, qty]) => {
                                  // Candidate: has stock and is NOT in this conteo (can't verify if emptied)
                                  // OR is in conteo and operator counted less than system (stock was taken from there)
                                  const cl = conteoLinesSku.find(c => c.posicion_id === pid);
                                  if (!cl) return qty > 0; // Not in conteo but has stock — possible source
                                  if (cl.estado !== "PENDIENTE" && cl.stock_contado < qty) return true; // Counted less — stock was taken
                                  return false;
                                })
                                .map(([pid, qty]) => {
                                  const cl = conteoLinesSku.find(c => c.posicion_id === pid);
                                  const available = cl && cl.estado !== "PENDIENTE" ? qty - cl.stock_contado : qty;
                                  return { pid, sysQty: qty, available, contada: cl && cl.estado !== "PENDIENTE" };
                                })
                                .filter(t => t.available > 0);

                              if (transferSources.length === 0) return null;
                              return (
                                <div style={{marginTop:8,padding:"10px 12px",borderRadius:8,background:"#3b82f610",border:"1px solid #3b82f633"}}>
                                  <div style={{fontSize:11,fontWeight:700,color:"#3b82f6",marginBottom:6}}>
                                    🔄 Posible traspaso detectado
                                  </div>
                                  <div style={{fontSize:10,color:"var(--txt2)",marginBottom:8}}>
                                    El operador encontró +{diff} en {l.posicion_id}. Puede traspasar desde otra posición sin alterar el stock total{transferSources.reduce((s, t) => s + Math.min(diff, t.available), 0) < diff ? ` (cubre hasta ${transferSources.reduce((s, t) => s + Math.min(diff, t.available), 0)} de ${diff})` : ""}:
                                  </div>
                                  {transferSources.map(src => {
                                    const transferQty = Math.min(diff, src.available);
                                    return (
                                      <div key={src.pid} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",borderRadius:6,background:"var(--bg3)",marginBottom:4}}>
                                        <div style={{fontSize:11}}>
                                          <span className="mono" style={{fontWeight:700,color:"var(--txt)"}}>{src.pid}</span>
                                          <span style={{color:"var(--txt3)",marginLeft:6}}>
                                            (sistema: {src.sysQty}{src.contada ? `, contado: ${src.sysQty - src.available}` : ""})
                                          </span>
                                          <span style={{color:"#3b82f6",marginLeft:6,fontWeight:600}}>
                                            → mover {transferQty} a {l.posicion_id}
                                          </span>
                                        </div>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); traspasarLinea(l.posicion_id, l.sku, src.pid, transferQty); }}
                                          disabled={processing}
                                          style={{padding:"4px 12px",borderRadius:6,fontSize:10,fontWeight:700,background:"#3b82f622",color:"#3b82f6",border:"1px solid #3b82f644",cursor:"pointer",whiteSpace:"nowrap"}}>
                                          Traspasar {transferQty}
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                            {/* Movimientos ocurridos durante el conteo para este SKU */}
                            {(() => {
                              const movsDurante = getMovsDuranteConteo(l.sku);
                              if (movsDurante.length === 0) return null;
                              const netChange = movsDurante.reduce((sum, m) => sum + (m.type === "in" ? m.qty : -m.qty), 0);
                              return (
                                <div style={{marginTop:8,padding:"10px 12px",borderRadius:8,background:"#a855f710",border:"1px solid #a855f733"}}>
                                  <div style={{fontSize:11,fontWeight:700,color:"#a855f7",marginBottom:6,display:"flex",justifyContent:"space-between"}}>
                                    <span>📋 Movimientos durante el conteo ({movsDurante.length})</span>
                                    <span className="mono" style={{fontSize:11,color: netChange === 0 ? "var(--txt3)" : netChange < 0 ? "#ef4444" : "#10b981"}}>
                                      Neto: {netChange > 0 ? "+" : ""}{netChange}
                                    </span>
                                  </div>
                                  <div style={{fontSize:10,color:"var(--txt3)",marginBottom:6}}>
                                    Estos movimientos ocurrieron desde que se creó el conteo y ya están reflejados en "Stock sistema":
                                  </div>
                                  <div style={{maxHeight:150,overflowY:"auto"}}>
                                    {movsDurante.slice(0, 20).map((m, mi) => (
                                      <div key={mi} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 6px",borderRadius:4,background: mi % 2 === 0 ? "var(--bg3)" : "transparent",fontSize:10}}>
                                        <span style={{width:16,textAlign:"center",fontWeight:700,color: m.type === "in" ? "#10b981" : "#ef4444"}}>{m.type === "in" ? "+" : "−"}</span>
                                        <span className="mono" style={{fontWeight:600,minWidth:24,textAlign:"right"}}>{m.qty}</span>
                                        <span className="mono" style={{color:"var(--txt3)",minWidth:40}}>{m.pos}</span>
                                        <span style={{color:"var(--txt2)",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                          {m.reason === "venta_flex" ? "Venta Flex" : m.reason === "envio_full" ? "Envío Full" : m.reason === "ajuste_salida" ? "Ajuste salida" : m.reason === "compra" ? "Compra/Recepción" : m.reason}
                                        </span>
                                        <span style={{color:"var(--txt3)",fontSize:9,whiteSpace:"nowrap"}}>{new Date(m.ts).toLocaleString("es-CL", {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
                                      </div>
                                    ))}
                                    {movsDurante.length > 20 && <div style={{fontSize:9,color:"var(--txt3)",textAlign:"center",padding:4}}>...y {movsDurante.length - 20} más</div>}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ==================== DICCIONARIO CONFIG ====================

export default AdminConteos;
