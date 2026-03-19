"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, fmtDate, fmtTime } from "@/lib/store";

interface StockCompareRow {
  sku: string;
  item_id: string;
  user_product_id: string | null;
  stock_wms: number;
  stock_flex_ml: number;
  stock_full_ml: number;
  ultimo_sync: string | null;
  ultimo_stock_enviado: number | null;
  cache_updated_at: string | null;
}

function AdminStockML() {
  const [rows, setRows] = useState<StockCompareRow[]>([]);
  const rowsRef = useRef<StockCompareRow[]>([]);
  // Mantener ref sincronizado con state
  const updateRows = useCallback((updater: StockCompareRow[] | ((prev: StockCompareRow[]) => StockCompareRow[])) => {
    setRows(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      rowsRef.current = next;
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(false);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlProgress, setMlProgress] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncResult, setSyncResult] = useState<Record<string, string>>({});
  const [syncAllLoading, setSyncAllLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const s = getStore();

  // Carga rápida: WMS + cache ML desde DB (instantáneo, sin llamar a ML API)
  const loadWms = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetch("/api/ml/stock-compare?phase=wms");
      if (!resp.ok) {
        const text = await resp.text();
        setError(`Error ${resp.status}: ${text.substring(0, 200)}`);
        return;
      }
      const json = await resp.json();
      if (json.error) { setError(json.error); return; }
      const wmsRows: StockCompareRow[] = json.rows || [];
      updateRows(wmsRows);
      const ov: Record<string, string> = {};
      for (const r of wmsRows) ov[r.sku] = String(r.stock_wms);
      setOverrides(ov);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [updateRows]);

  // Consulta en vivo a ML API: actualiza cache en DB + filas en pantalla progresivamente
  const refreshMl = useCallback(async () => {
    if (mlLoading) return;
    setMlLoading(true);
    setDiagnostics([]);
    const allDiags: string[] = [];

    // Leer SKUs actuales del ref (siempre sincronizado)
    const allSkus = rowsRef.current.map(r => r.sku);
    if (allSkus.length === 0) { setMlLoading(false); return; }

    const ML_BATCH = 10;
    let tokenFailed = false;

    for (let i = 0; i < allSkus.length; i += ML_BATCH) {
      if (tokenFailed) break;
      const batchSkus = allSkus.slice(i, i + ML_BATCH);
      setMlProgress(`Consultando ML ${Math.min(i + ML_BATCH, allSkus.length)}/${allSkus.length}...`);

      try {
        const resp = await fetch(`/api/ml/stock-compare?phase=ml&skus=${encodeURIComponent(batchSkus.join(","))}`);
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          allDiags.push(`Error ${resp.status}: ${text.substring(0, 100)}`);
          if (i === 0) tokenFailed = true;
          continue;
        }
        const json = await resp.json();

        // Actualizar filas INMEDIATAMENTE con los datos de este batch
        if (json.results && Object.keys(json.results).length > 0) {
          const batchData = json.results as Record<string, { flex: number; full: number; upId: string | null; error?: string }>;
          updateRows(prev => prev.map(row => {
            const ml = batchData[row.sku];
            if (ml && !ml.error) {
              return {
                ...row,
                stock_flex_ml: ml.flex,
                stock_full_ml: ml.full,
                user_product_id: ml.upId || row.user_product_id,
                cache_updated_at: new Date().toISOString(),
              };
            }
            return row;
          }));
        }
        if (json.diagnostics) allDiags.push(...json.diagnostics);

        if (i === 0) {
          const batchResults = Object.values(json.results || {}) as { error?: string }[];
          if (batchResults.length > 0 && batchResults.every(r => r.error)) {
            tokenFailed = true;
            allDiags.push(`Todas las consultas ML fallaron. Posible problema de token.`);
          }
        }
      } catch (fetchErr) {
        allDiags.push(`Error de red: ${String(fetchErr)}`);
        if (i === 0) tokenFailed = true;
      }
    }

    if (allDiags.length > 0) setDiagnostics(allDiags);
    setMlProgress("");
    setMlLoading(false);
  }, [mlLoading, updateRows]);

  // Al montar: cargar WMS (instantáneo con cache ML)
  useEffect(() => { loadWms(); }, [loadWms]);

  // Auto-refresh WMS cada 30 segundos (solo DB, no ML API)
  useEffect(() => {
    const iv = setInterval(loadWms, 30_000);
    return () => clearInterval(iv);
  }, [loadWms]);

  const filtered = rows.filter(r => {
    if (!q) return true;
    const ql = q.toLowerCase();
    const prod = s.products[r.sku];
    return r.sku.toLowerCase().includes(ql)
      || r.item_id.toLowerCase().includes(ql)
      || (prod?.name || "").toLowerCase().includes(ql);
  });

  // Separar vinculados vs sin vincular (SKU = item_id de ML = sin mapeo real)
  const vinculados = filtered.filter(r => r.sku !== r.item_id && !r.sku.startsWith("MLC"));
  const sinVincular = filtered.filter(r => r.sku === r.item_id || r.sku.startsWith("MLC"));

  const syncOne = async (sku: string, force = false) => {
    const qty = parseInt(overrides[sku] || "0", 10);
    if (isNaN(qty) || qty < 0) return;
    setSyncing(p => ({ ...p, [sku]: true }));
    setSyncResult(p => ({ ...p, [sku]: "" }));
    try {
      const resp = await fetch("/api/ml/stock-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus: [sku], quantities: { [sku]: qty }, force }),
      });
      const json = await resp.json();
      if (json.error) {
        setSyncResult(p => ({ ...p, [sku]: `Error: ${json.error}` }));
      } else if (json.results?.[sku]?.ok) {
        setSyncResult(p => ({ ...p, [sku]: "OK" }));
      } else {
        const reason = json.results?.[sku]?.reason || "Error desconocido";
        setSyncResult(p => ({ ...p, [sku]: reason }));
      }
      // Refrescar WMS para ver cache actualizado
      loadWms();
    } catch (err) {
      setSyncResult(p => ({ ...p, [sku]: String(err) }));
    } finally {
      setSyncing(p => ({ ...p, [sku]: false }));
    }
  };

  const syncAll = async (force = false) => {
    if (!confirm(`Sincronizar ${vinculados.length} SKUs vinculados a MercadoLibre?`)) return;
    setSyncAllLoading(true);
    const quantities: Record<string, number> = {};
    const skus: string[] = [];
    for (const r of vinculados) {
      const qty = parseInt(overrides[r.sku] || "0", 10);
      quantities[r.sku] = isNaN(qty) ? r.stock_wms : qty;
      skus.push(r.sku);
    }
    try {
      const resp = await fetch("/api/ml/stock-compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus, quantities, force }),
      });
      const json = await resp.json();
      if (json.error) {
        alert(`Error: ${json.error}`);
      } else {
        // Show per-SKU results
        const failed = Object.entries(json.results || {}).filter(([, r]: [string, any]) => !r.ok);
        let msg = `Sync completado: ${json.synced}/${json.total} SKUs sincronizados`;
        if (failed.length > 0) {
          msg += `\n\nFallaron ${failed.length}:\n` + failed.map(([sku, r]: [string, any]) => `• ${sku}: ${r.reason}`).join("\n");
        }
        alert(msg);
        // Update per-row results in UI
        for (const [sku, r] of Object.entries(json.results || {}) as [string, any][]) {
          setSyncResult(p => ({ ...p, [sku]: r.ok ? "OK" : r.reason }));
        }
        loadWms();
      }
    } catch (err) {
      alert(`Error: ${String(err)}`);
    } finally {
      setSyncAllLoading(false);
    }
  };

  // KPIs (solo vinculados)
  const totalWms = vinculados.reduce((s, r) => s + r.stock_wms, 0);
  const totalFlex = vinculados.reduce((s, r) => s + (r.stock_flex_ml < 0 ? 0 : r.stock_flex_ml), 0);
  const totalFull = vinculados.reduce((s, r) => s + (r.stock_full_ml < 0 ? 0 : r.stock_full_ml), 0);
  const desincronizados = vinculados.filter(r => {
    if (r.stock_flex_ml < 0) return false; // ML data not loaded yet
    const deseado = parseInt(overrides[r.sku] || "0", 10);
    return r.stock_flex_ml !== deseado;
  }).length;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <h2 style={{margin:0,fontSize:18}}>Stock ML — WMS vs Flex</h2>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={loadWms} disabled={loading}
            style={{padding:"8px 16px",borderRadius:8,background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bg4)",fontWeight:600,fontSize:12,cursor:"pointer"}}>
            {loading ? "Cargando..." : "Refrescar WMS"}
          </button>
          <button onClick={refreshMl} disabled={mlLoading}
            style={{padding:"8px 16px",borderRadius:8,background:mlLoading?"var(--bg3)":"var(--greenBg)",color:mlLoading?"var(--txt3)":"var(--green)",border:`1px solid ${mlLoading?"var(--bg4)":"var(--greenBd)"}`,fontWeight:600,fontSize:12,cursor:"pointer"}}>
            {mlLoading ? "Consultando ML..." : "Refrescar ML"}
          </button>
          <button onClick={() => syncAll()} disabled={syncAllLoading || vinculados.length === 0}
            style={{padding:"8px 16px",borderRadius:8,background:"var(--cyan)",color:"#000",border:"none",fontWeight:700,fontSize:12,cursor:"pointer"}}>
            {syncAllLoading ? "Sincronizando..." : `Sync Todo (${vinculados.length})`}
          </button>
        </div>
      </div>

      {error && <div style={{padding:12,borderRadius:8,background:"var(--redBg)",border:"1px solid var(--redBd)",color:"var(--red)",fontSize:12}}>{error}</div>}

      {diagnostics.length > 0 && (
        <details style={{padding:12,borderRadius:8,background:"var(--amberBg)",border:"1px solid var(--amberBd)"}}>
          <summary style={{fontSize:12,fontWeight:600,color:"var(--amber)",cursor:"pointer"}}>⚠️ Diagnóstico ({diagnostics.length} avisos)</summary>
          <div style={{marginTop:8,fontSize:11,color:"var(--txt2)",fontFamily:"var(--font-mono)"}}>
            {diagnostics.map((d, i) => <div key={i} style={{padding:"2px 0"}}>• {d}</div>)}
          </div>
        </details>
      )}

      {/* KPIs */}
      <div className="kpi-grid" style={{gridTemplateColumns:"repeat(4, 1fr)"}}>
        <div className="kpi">
          <div style={{fontSize:10,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>SKUs Vinculados</div>
          <div style={{fontSize:24,fontWeight:700,fontFamily:"var(--font-mono)"}}>{vinculados.length}</div>
          {sinVincular.length > 0 && <div style={{fontSize:10,color:"var(--amber)",marginTop:2}}>{sinVincular.length} sin vincular</div>}
        </div>
        <div className="kpi">
          <div style={{fontSize:10,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Stock WMS</div>
          <div style={{fontSize:24,fontWeight:700,fontFamily:"var(--font-mono)",color:"var(--cyan)"}}>{totalWms}</div>
        </div>
        <div className="kpi">
          <div style={{fontSize:10,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Stock Flex ML</div>
          <div style={{fontSize:24,fontWeight:700,fontFamily:"var(--font-mono)",color:"var(--green)"}}>{totalFlex}</div>
        </div>
        <div className="kpi">
          <div style={{fontSize:10,color:"var(--txt3)",textTransform:"uppercase",letterSpacing:1}}>Desincronizados</div>
          <div style={{fontSize:24,fontWeight:700,fontFamily:"var(--font-mono)",color:desincronizados>0?"var(--amber)":"var(--green)"}}>{desincronizados}</div>
        </div>
      </div>

      {/* Cache freshness + search */}
      {(() => {
        const cached = rows.filter(r => r.cache_updated_at);
        if (cached.length > 0) {
          const oldest = cached.reduce((min, r) => {
            const t = new Date(r.cache_updated_at!).getTime();
            return t < min ? t : min;
          }, Infinity);
          const ageMin = Math.round((Date.now() - oldest) / 60000);
          const ageText = ageMin < 1 ? "< 1 min" : ageMin < 60 ? `${ageMin} min` : `${Math.round(ageMin / 60)}h`;
          const fresh = ageMin < 10;
          return (
            <div style={{fontSize:11,color:fresh?"var(--green)":"var(--amber)",display:"flex",alignItems:"center",gap:6}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:fresh?"var(--green)":"var(--amber)",display:"inline-block"}} />
              Stock ML cache: {cached.length}/{rows.length} SKUs — antigüedad: {ageText}
              {!mlLoading && ageMin >= 5 && <span style={{color:"var(--txt3)",marginLeft:4}}>(click Refrescar ML para actualizar)</span>}
            </div>
          );
        }
        if (!mlLoading && rows.length > 0) {
          return <div style={{fontSize:11,color:"var(--txt3)"}}>Sin cache ML — click &quot;Refrescar ML&quot; para cargar stock de MercadoLibre</div>;
        }
        return null;
      })()}
      <input className="form-input" placeholder="Buscar SKU, item ID, nombre..." value={q} onChange={e=>setQ(e.target.value)}
        style={{maxWidth:400}} />

      {mlLoading && rows.length > 0 && (
        <div style={{padding:"8px 16px",textAlign:"center",fontSize:12}}>
          <div style={{color:"var(--cyan)",marginBottom:6}}>{mlProgress || "Consultando stock en vivo de MercadoLibre..."}</div>
          {(() => {
            const total = rows.length;
            const done = rows.filter(r => r.stock_flex_ml >= 0).length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div style={{maxWidth:400,margin:"0 auto",height:6,borderRadius:3,background:"var(--bg4)",overflow:"hidden"}}>
                <div style={{height:"100%",width:`${pct}%`,background:"var(--cyan)",borderRadius:3,transition:"width 0.3s ease"}} />
              </div>
            );
          })()}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div style={{padding:40,textAlign:"center",color:"var(--txt3)"}}>Cargando datos...</div>
      ) : !loading && !mlLoading && vinculados.length === 0 && sinVincular.length === 0 ? (
        <div style={{padding:40,textAlign:"center",color:"var(--txt3)"}}>No hay SKUs mapeados a ML. Configura los mapeos en la pestaña Config.</div>
      ) : (
        <>
        {vinculados.length > 0 && (
        <div style={{overflowX:"auto"}}>
          <table className="tbl" style={{width:"100%",fontSize:12}}>
            <thead>
              <tr>
                <th style={{textAlign:"left"}}>SKU</th>
                <th style={{textAlign:"left"}}>Producto</th>
                <th style={{textAlign:"right"}}>Stock WMS</th>
                <th style={{textAlign:"right"}}>Flex ML</th>
                <th style={{textAlign:"right"}}>Full ML</th>
                <th style={{textAlign:"center",minWidth:100}}>Enviar a Flex</th>
                <th style={{textAlign:"center"}}>Sync</th>
                <th style={{textAlign:"left"}}>Último sync</th>
              </tr>
            </thead>
            <tbody>
              {vinculados.map(r => {
                const prod = s.products[r.sku];
                const deseado = parseInt(overrides[r.sku] || "0", 10);
                const mlNotLoaded = r.stock_flex_ml < 0;
                const diff = !mlNotLoaded && r.stock_flex_ml !== deseado;
                const isSyncing = syncing[r.sku];
                const result = syncResult[r.sku];
                return (
                  <tr key={r.sku + r.item_id} style={{background: diff ? "var(--amberBg)" : undefined}}>
                    <td style={{fontFamily:"var(--font-mono)",fontWeight:600}}>{r.sku}</td>
                    <td style={{color:"var(--txt2)",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{prod?.name || "—"}</td>
                    <td style={{textAlign:"right",fontFamily:"var(--font-mono)",fontWeight:700,color:"var(--cyan)"}}>{r.stock_wms}</td>
                    <td style={{textAlign:"right",fontFamily:"var(--font-mono)",fontWeight:700,color:mlNotLoaded?"var(--txt3)":"var(--green)"}}>{mlNotLoaded ? "..." : r.stock_flex_ml}</td>
                    <td style={{textAlign:"right",fontFamily:"var(--font-mono)",color:"var(--txt3)"}}>{mlNotLoaded ? "..." : r.stock_full_ml}</td>
                    <td style={{textAlign:"center"}}>
                      <input
                        type="number"
                        min={0}
                        value={overrides[r.sku] ?? ""}
                        onChange={e => setOverrides(p => ({ ...p, [r.sku]: e.target.value }))}
                        style={{width:70,textAlign:"center",padding:"4px 6px",borderRadius:6,background:"var(--bg3)",border:"1px solid var(--bg4)",color:"var(--txt)",fontFamily:"var(--font-mono)",fontSize:12,fontWeight:700}}
                        inputMode="numeric"
                      />
                    </td>
                    <td style={{textAlign:"center"}}>
                      <button onClick={() => syncOne(r.sku)} disabled={isSyncing}
                        style={{padding:"4px 10px",borderRadius:6,background: result === "OK" ? "var(--green)" : "var(--cyan)",color:"#000",border:"none",fontWeight:700,fontSize:11,cursor:"pointer",opacity:isSyncing?0.5:1}}>
                        {isSyncing ? "..." : result === "OK" ? "✓" : "Sync"}
                      </button>
                      {result && result !== "OK" && (
                        <div style={{marginTop:2}}>
                          <div style={{fontSize:10,color:"var(--red)",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis"}} title={result}>{result}</div>
                          {result.includes("Safety block") && (
                            <button onClick={() => syncOne(r.sku, true)} disabled={isSyncing}
                              style={{marginTop:2,padding:"2px 8px",borderRadius:4,background:"var(--amber)",color:"#000",border:"none",fontWeight:700,fontSize:10,cursor:"pointer"}}>
                              Forzar
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{fontSize:10,color:"var(--txt3)",whiteSpace:"nowrap"}}>{r.ultimo_sync ? fmtDate(r.ultimo_sync) + " " + fmtTime(r.ultimo_sync) : "Nunca"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}

        {/* Sin vincular */}
        {sinVincular.length > 0 && (
          <div className="card" style={{marginTop:8}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <div>
                <div style={{fontWeight:700,fontSize:14,color:"var(--amber)"}}>Sin vincular ({sinVincular.length})</div>
                <div style={{fontSize:11,color:"var(--txt3)"}}>Items en tu cuenta ML que no están vinculados a un producto del WMS. Vinculalos desde Productos para que el sistema pueda sincronizar stock.</div>
              </div>
            </div>
            <table className="tbl" style={{width:"100%",fontSize:12}}>
              <thead>
                <tr>
                  <th style={{textAlign:"left"}}>Item ID</th>
                  <th style={{textAlign:"right"}}>Flex ML</th>
                  <th style={{textAlign:"right"}}>Full ML</th>
                </tr>
              </thead>
              <tbody>
                {sinVincular.map(r => (
                  <tr key={r.sku + r.item_id} style={{opacity:0.7}}>
                    <td className="mono" style={{fontWeight:600,color:"var(--amber)"}}>{r.item_id}</td>
                    <td style={{textAlign:"right",fontFamily:"var(--font-mono)"}}>{r.stock_flex_ml < 0 ? "..." : r.stock_flex_ml}</td>
                    <td style={{textAlign:"right",fontFamily:"var(--font-mono)"}}>{r.stock_full_ml < 0 ? "..." : r.stock_full_ml}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>
      )}

      <div className="card" style={{padding:12,fontSize:11,color:"var(--txt3)"}}>
        <strong>Nota:</strong> La columna "Enviar a Flex" permite ajustar la cantidad antes de sincronizar. Por defecto usa el stock total del WMS.
        En días de mucho movimiento, revisa las cantidades antes de hacer Sync. El sistema bloquea automáticamente si el stock baja de &gt;10 a 0 (safety block).
      </div>
    </div>
  );
}

export default AdminStockML;
