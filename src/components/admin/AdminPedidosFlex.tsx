"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { getStore, fmtDate, fmtTime, fmtMoney, getComponentesPorSkuVenta, getSkusVenta, skuTotal } from "@/lib/store";
import type { Product } from "@/lib/store";
import { fetchShipmentsToArm, fetchAllShipments, fetchStoreIds, fetchPedidosFlex, fetchMLConfig, fetchActiveFlexShipments } from "@/lib/db";
import type { ShipmentWithItems, DBPedidoFlex, DBMLConfig } from "@/lib/db";

// ==================== PEDIDOS ML (Shipment-centric) ====================
function AdminPedidosFlex({ refresh }: { refresh: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [fecha, setFecha] = useState(today);
  const [shipments, setShipments] = useState<ShipmentWithItems[]>([]);
  const [pedidos, setPedidos] = useState<DBPedidoFlex[]>([]); // legacy (debug only)
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncDays, setSyncDays] = useState(0);
  const [mlConfig, setMlConfig] = useState<DBMLConfig | null>(null);
  const [showLegacy, setShowLegacy] = useState(false); // hidden legacy table (debug only)
  const [storeFilter, setStoreFilter] = useState<number | null>(null); // store_id filter
  const [storeOptions, setStoreOptions] = useState<{ store_id: number; count: number }[]>([]);

  const loadPedidos = useCallback(async () => {
    setLoading(true);
    // Load ALL active shipments (ready_to_ship + pending/buffered) for Flex dispatch view
    try {
      const sData = await fetchActiveFlexShipments(storeFilter);
      setShipments(sData);
    } catch { setShipments([]); }
    // Load store options for filter dropdown
    try { const stores = await fetchStoreIds(); setStoreOptions(stores); } catch { /* ignore */ }
    // Legacy pedidos_flex (debug only)
    try { const data = await fetchPedidosFlex(fecha); setPedidos(data); } catch { setPedidos([]); }
    setLoading(false);
  }, [fecha, today, storeFilter]);

  const loadConfig = useCallback(async () => {
    const cfg = await fetchMLConfig();
    setMlConfig(cfg);
  }, []);

  useEffect(() => { loadPedidos(); loadConfig(); }, [loadPedidos, loadConfig]);

  // Auto-refresh UI cada 30 segundos
  useEffect(() => {
    const iv = setInterval(loadPedidos, 30_000);
    return () => clearInterval(iv);
  }, [loadPedidos]);

  // Auto-sync con ML: inmediato al abrir + cada 5 minutos
  // Reemplaza el cron de Vercel (plan Hobby solo permite 1x/día)
  useEffect(() => {
    const doAutoSync = async () => {
      try {
        // Sync órdenes recientes
        await fetch("/api/ml/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        // Procesar cola de stock pendiente
        await fetch("/api/ml/stock-sync", { method: "POST" }).catch(() => {});
        loadPedidos();
      } catch { /* silencioso */ }
    };
    doAutoSync(); // sync inmediato al abrir el tab
    const iv = setInterval(doAutoSync, 5 * 60_000);
    return () => clearInterval(iv);
  }, [loadPedidos]);

  // Shipment-centric labels & colors
  const LOGISTIC_LABELS: Record<string, string> = {
    self_service: "Flex", cross_docking: "Colecta", xd_drop_off: "Drop-off", drop_off: "Correo",
  };
  const LOGISTIC_COLORS: Record<string, string> = {
    self_service: "#10b981", cross_docking: "#f59e0b", xd_drop_off: "#a855f7", drop_off: "#6366f1",
  };

  // ===== FLEX DISPATCH CLASSIFICATION =====
  type FlexDispatchCategory = "DESPACHAR_HOY" | "DESPACHAR_MANANA" | "BUFFERED" | "YA_IMPRESO" | "ATRASADO";

  // Helper: extract YYYY-MM-DD in Chile timezone for proper date comparison
  const toChileDateStr = (d: Date): string => {
    const parts = d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" }); // en-CA = YYYY-MM-DD
    return parts; // "2026-03-09"
  };
  const todayChile = toChileDateStr(new Date());

  const classifyShipment = (s: ShipmentWithItems): FlexDispatchCategory => {
    // Buffered — ML hasn't released the label yet
    if (s.status === "pending" && s.substatus === "buffered") return "BUFFERED";
    // Already printed
    if (s.substatus === "printed") return "YA_IMPRESO";
    // Ready to print — classify HOY vs MAÑANA using handling_limit in Chile timezone
    if (s.substatus === "ready_to_print") {
      if (!s.handling_limit) return "DESPACHAR_HOY"; // no date = assume urgent
      const limitDay = toChileDateStr(new Date(s.handling_limit));
      if (limitDay < todayChile) return "ATRASADO";
      if (limitDay === todayChile) return "DESPACHAR_HOY";
      return "DESPACHAR_MANANA";
    }
    // Pending with ready_to_print (before ready_to_ship)
    if (s.status === "pending" && s.substatus === "ready_to_print") {
      if (!s.handling_limit) return "DESPACHAR_HOY";
      const limitDay = toChileDateStr(new Date(s.handling_limit));
      if (limitDay <= todayChile) return "DESPACHAR_HOY";
      return "DESPACHAR_MANANA";
    }
    // Other pending states
    return "BUFFERED";
  };

  const CATEGORY_CONFIG: Record<FlexDispatchCategory, { label: string; color: string; icon: string; order: number }> = {
    ATRASADO: { label: "Atrasados", color: "#ef4444", icon: "!!", order: 0 },
    DESPACHAR_HOY: { label: "Despachar HOY", color: "#10b981", icon: "", order: 1 },
    DESPACHAR_MANANA: { label: "Programados para MAÑANA", color: "#f59e0b", icon: "", order: 2 },
    BUFFERED: { label: "En espera (buffered)", color: "#3b82f6", icon: "", order: 3 },
    YA_IMPRESO: { label: "Ya impresos", color: "#94a3b8", icon: "", order: 4 },
  };

  // Classify all shipments
  const classifiedShipments = shipments.map(s => ({ ...s, _category: classifyShipment(s) }));

  // Group by category
  const categoryGroups = (() => {
    const groups: Record<FlexDispatchCategory, typeof classifiedShipments> = {
      ATRASADO: [], DESPACHAR_HOY: [], DESPACHAR_MANANA: [], BUFFERED: [], YA_IMPRESO: [],
    };
    for (const s of classifiedShipments) {
      groups[s._category].push(s);
    }
    return (Object.entries(groups) as [FlexDispatchCategory, typeof classifiedShipments][])
      .filter(([, ships]) => ships.length > 0)
      .sort(([a], [b]) => CATEGORY_CONFIG[a].order - CATEGORY_CONFIG[b].order);
  })();

  const shipCounts = {
    total: shipments.length,
    despacharHoy: classifiedShipments.filter(s => s._category === "DESPACHAR_HOY").length,
    despacharManana: classifiedShipments.filter(s => s._category === "DESPACHAR_MANANA").length,
    buffered: classifiedShipments.filter(s => s._category === "BUFFERED").length,
    atrasado: classifiedShipments.filter(s => s._category === "ATRASADO").length,
    yaImpreso: classifiedShipments.filter(s => s._category === "YA_IMPRESO").length,
    readyToPrint: shipments.filter(s => s.substatus === "ready_to_print").length,
    printed: shipments.filter(s => s.substatus === "printed").length,
  };
  // Legacy counts (only for debug)
  const legacyPendientes = pedidos.filter(p => p.estado === "PENDIENTE").length;

  const doSync = async () => {
    setSyncing(true);
    try {
      const body = syncDays > 0 ? { days: syncDays } : {};
      const resp = await fetch("/api/ml/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await resp.json();
      if (data.new_items > 0) await loadPedidos();
      if (syncDays > 0) {
        alert(`Sync histórico (${syncDays}d): ${data.total_orders || 0} órdenes, ${data.shipments_processed || 0} envíos procesados (no-Full), ${data.new_items || 0} items. Omitidos: ${data.shipments_skipped || 0}`);
      } else {
        alert(`Sincronización completa: ${data.new_items || 0} items nuevos de ${data.total_orders || 0} órdenes`);
      }
    } catch (err) {
      alert("Error de sincronización: " + String(err));
    }
    setSyncing(false);
  };

  const doDownloadLabels = async (onlyCategory?: FlexDispatchCategory) => {
    // Only download labels for DESPACHAR_HOY + ATRASADO by default (not MAÑANA/BUFFERED)
    const eligibleShips = classifiedShipments.filter(s => {
      if (s.is_fraud_risk) return false;
      if (s.substatus !== "ready_to_print") return false;
      if (onlyCategory) return s._category === onlyCategory;
      return s._category === "DESPACHAR_HOY" || s._category === "ATRASADO";
    });
    const shippingIds = eligibleShips.length > 0
      ? eligibleShips.map(s => s.shipment_id)
      : Array.from(new Set(pedidos.filter(p => p.estado !== "DESPACHADO").map(p => p.shipping_id)));
    if (shippingIds.length === 0) { alert("Sin envíos para descargar etiquetas"); return; }

    if (shippingIds.length > 50) {
      alert(`Atención: hay ${shippingIds.length} etiquetas pero ML solo permite 50 por descarga. Se descargarán las primeras 50.`);
    }

    try {
      const resp = await fetch("/api/ml/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_ids: shippingIds.slice(0, 50), skip_validation: true }),
      });
      if (!resp.ok) { alert("Error descargando etiquetas"); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiquetas-${today}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error: " + String(err));
    }
  };

  // Print label for a single shipment
  const doPrintLabel = async (shipmentId: number) => {
    try {
      const resp = await fetch("/api/ml/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipping_ids: [shipmentId], skip_validation: true }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.message || "Error descargando etiqueta");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `etiqueta-${shipmentId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error: " + String(err));
    }
  };

  // Verify shipment status live before picking
  const doVerifyShipment = async (shipmentId: number): Promise<boolean> => {
    try {
      const resp = await fetch("/api/ml/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipment_id: shipmentId }),
      });
      const data = await resp.json();
      if (data.cancelled) {
        alert(`Envío #${shipmentId} fue CANCELADO. No preparar.`);
        await loadPedidos(); // refresh to remove from list
        return false;
      }
      if (!data.ok_to_pick) {
        alert(`Envío #${shipmentId} ya no está en ready_to_ship (status: ${data.status}). No preparar.`);
        await loadPedidos();
        return false;
      }
      return true;
    } catch {
      alert("No se pudo verificar. Revisa la conexión.");
      return false;
    }
  };

  const tokenValid = mlConfig?.token_expires_at && new Date(mlConfig.token_expires_at) > new Date();

  return (
    <div>
      {/* Header */}
      <div className="card">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
          <div className="card-title">🛒 Pedidos MercadoLibre Flex</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            <button onClick={() => doDownloadLabels()} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"#a855f7",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
              📄 Etiquetas HOY
            </button>
          </div>
        </div>

        {/* Sync controls */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,flexWrap:"wrap"}}>
          <select value={syncDays} onChange={e => setSyncDays(parseInt(e.target.value))}
            className="form-input mono" style={{fontSize:12,padding:"6px 8px",width:130}}>
            <option value={0}>Últimas 2 hrs</option>
            <option value={3}>3 días</option>
            <option value={7}>7 días</option>
            <option value={14}>14 días</option>
            <option value={30}>30 días</option>
          </select>
          <button onClick={doSync} disabled={syncing} style={{padding:"6px 12px",borderRadius:6,background:"var(--bg3)",color:"var(--cyan)",fontSize:11,fontWeight:600,border:"1px solid var(--bg4)"}}>
            {syncing ? "Sincronizando..." : "🔄 Sincronizar"}
          </button>
        </div>

        {/* Store filter */}
        {storeOptions.length > 1 && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
            <select value={storeFilter ?? ""} onChange={e => setStoreFilter(e.target.value ? Number(e.target.value) : null)}
              className="form-input mono" style={{fontSize:12,padding:"6px 8px",width:180}}>
              <option value="">Todas las tiendas</option>
              {storeOptions.map(s => (
                <option key={s.store_id} value={s.store_id}>Tienda {s.store_id} ({s.count})</option>
              ))}
            </select>
          </div>
        )}

        {/* Status indicator */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,fontSize:11}}>
          <span style={{color: tokenValid ? "var(--green)" : "var(--red)", fontWeight:700}}>
            {tokenValid ? "● Token ML válido" : "● Token ML vencido/no configurado"}
          </span>
          {mlConfig?.updated_at && <span style={{color:"var(--txt3)"}}>· Última actualización: {new Date(mlConfig.updated_at).toLocaleString("es-CL")}</span>}
        </div>
      </div>

      {/* Summary KPIs: dispatch categories */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:0}}>
        <div className="card" style={{textAlign:"center",padding:12,border: shipCounts.atrasado > 0 ? "2px solid #ef4444" : undefined}}>
          <div style={{fontSize:26,fontWeight:800,color:"#ef4444"}}>{shipCounts.atrasado}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Atrasados</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12,border: shipCounts.despacharHoy > 0 ? "2px solid #10b981" : undefined}}>
          <div style={{fontSize:26,fontWeight:800,color:"#10b981"}}>{shipCounts.despacharHoy}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Despachar HOY</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#f59e0b"}}>{shipCounts.despacharManana}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Para MAÑANA</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#3b82f6"}}>{shipCounts.buffered}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>En espera</div>
        </div>
        <div className="card" style={{textAlign:"center",padding:12}}>
          <div style={{fontSize:26,fontWeight:800,color:"#94a3b8"}}>{shipCounts.yaImpreso}</div>
          <div style={{fontSize:10,fontWeight:600,color:"var(--txt2)"}}>Ya impresos</div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>Cargando...</div>
      ) : shipments.length > 0 ? (
        /* ===== FLEX DISPATCH VIEW — grouped by category (HOY/MAÑANA/BUFFERED/YA_IMPRESO) ===== */
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {categoryGroups.map(([category, catShips]) => {
            const cfg = CATEGORY_CONFIG[category];
            const isUrgent = category === "ATRASADO" || category === "DESPACHAR_HOY";
            const isBuffered = category === "BUFFERED";
            const isMañana = category === "DESPACHAR_MANANA";
            const isPrinted = category === "YA_IMPRESO";
            const readyToPrintCount = catShips.filter(s => s.substatus === "ready_to_print").length;

            const LOGISTIC_ACTIONS: Record<string, string> = {
              self_service: "darle el paquete a tu conductor",
              cross_docking: "tenerlo listo para recolección de ML",
              xd_drop_off: "llevarlo a la agencia",
              drop_off: "llevarlo al correo",
            };

            // Sub-group by logistic type within category
            const logisticTypes = ["self_service", "cross_docking", "xd_drop_off", "drop_off"];
            const ltGroups = logisticTypes.map(lt => ({
              lt, label: LOGISTIC_LABELS[lt] || lt, color: LOGISTIC_COLORS[lt] || "#94a3b8",
              action: LOGISTIC_ACTIONS[lt] || "preparar",
              ships: catShips.filter(s => s.logistic_type === lt),
            })).filter(g => g.ships.length > 0);

            return (
              <div key={category} className="card" style={{padding:0,overflow:"hidden",border: category === "ATRASADO" ? "2px solid #ef4444" : `1px solid ${cfg.color}44`}}>
                {/* Category header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:`${cfg.color}11`,borderBottom:"1px solid var(--bg4)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:4,background:`${cfg.color}22`,color:cfg.color,border:`1px solid ${cfg.color}44`,textTransform:"uppercase",letterSpacing:"0.05em"}}>
                      {cfg.label}
                    </span>
                    <span style={{fontSize:12,color:"var(--txt3)",fontWeight:600}}>{catShips.length} paquete{catShips.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {isUrgent && readyToPrintCount > 0 && (
                      <button onClick={() => doDownloadLabels(category)} style={{fontSize:10,fontWeight:700,padding:"4px 12px",borderRadius:4,border:"none",cursor:"pointer",background:cfg.color,color:"#fff"}}>
                        Imprimir {readyToPrintCount} etiqueta{readyToPrintCount !== 1 ? "s" : ""}
                      </button>
                    )}
                    {isMañana && (
                      <span style={{fontSize:10,color:"#f59e0b",fontWeight:600}}>No imprimir aún</span>
                    )}
                    {isBuffered && (
                      <span style={{fontSize:10,color:"#3b82f6",fontWeight:600}}>Esperando liberación ML</span>
                    )}
                  </div>
                </div>

                {/* Instruction banner per category */}
                {category === "ATRASADO" && (
                  <div style={{padding:"8px 16px",background:"#ef444415",fontSize:11,color:"#ef4444",fontWeight:700}}>
                    Estos envíos ya pasaron su deadline. Despachar URGENTE para evitar penalizaciones.
                  </div>
                )}
                {isMañana && (
                  <div style={{padding:"8px 16px",background:"#f59e0b10",fontSize:11,color:"#f59e0b",fontWeight:600}}>
                    Estos pedidos están programados para mañana. No necesitas imprimir etiquetas ahora.
                  </div>
                )}
                {isBuffered && (
                  <div style={{padding:"8px 16px",background:"#3b82f610",fontSize:11,color:"#3b82f6",fontWeight:600}}>
                    ML aún no liberó estas etiquetas. Se habilitarán automáticamente cuando estén listas.
                  </div>
                )}

                {/* Logistic type subgroups */}
                <div style={{padding:"8px 12px"}}>
                  {ltGroups.map(ltg => (
                    <div key={ltg.lt} style={{marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,margin:"8px 0 6px",padding:"6px 10px",background:`${ltg.color}0d`,borderRadius:6}}>
                        <span style={{fontSize:12,fontWeight:700,color:ltg.color}}>{ltg.label}</span>
                        {isUrgent && (
                          <span style={{fontSize:11,color:"var(--txt2)"}}>
                            — Tienes que <strong>{ltg.action}</strong> {category === "ATRASADO" ? <span style={{color:"#ef4444",fontWeight:800}}>URGENTE</span> : <strong>hoy</strong>}
                          </span>
                        )}
                        {isMañana && <span style={{fontSize:11,color:"var(--txt3)"}}>— Entregar mañana</span>}
                        <span style={{fontSize:10,color:"var(--txt3)",marginLeft:"auto"}}>({ltg.ships.length})</span>
                      </div>
                      {ltg.ships.map(ship => {
                        const canPrint = isUrgent && ship.substatus === "ready_to_print" && ship.status === "ready_to_ship";
                        const bufferingInfo = isBuffered && ship.buffering_date
                          ? `Etiqueta disponible desde: ${new Date(ship.buffering_date).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                          : null;
                        const handlingInfo = ship.handling_limit
                          ? new Date(ship.handling_limit).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                          : null;

                        return (
                          <div key={ship.shipment_id} style={{padding:"8px 10px",marginBottom:2,borderLeft:`3px solid ${ship.is_fraud_risk ? "#dc2626" : cfg.color}`,background: ship.is_fraud_risk ? "#dc262610" : "var(--bg2)",borderRadius:"0 6px 6px 0"}}>
                            {ship.is_fraud_risk && (
                              <div style={{padding:"4px 8px",marginBottom:4,borderRadius:4,background:"#dc262622",color:"#dc2626",fontSize:11,fontWeight:800}}>
                                RIESGO DE FRAUDE — NO PREPARAR ESTE PEDIDO
                              </div>
                            )}
                            {/* Actions + status */}
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                              <div style={{display:"flex",alignItems:"center",gap:6}}>
                                {canPrint ? (
                                  <button onClick={() => doPrintLabel(ship.shipment_id)}
                                    disabled={ship.is_fraud_risk}
                                    style={{fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:4,border:"none",cursor: ship.is_fraud_risk ? "not-allowed" : "pointer",
                                      background: category === "ATRASADO" ? "#ef4444" : "#10b981",color:"#fff"}}>
                                    IMPRIMIR ETIQUETA
                                  </button>
                                ) : isPrinted || ship.substatus === "printed" ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#10b98122",color:"#10b981"}}>
                                    LISTA PARA DESPACHAR
                                  </span>
                                ) : isMañana && ship.substatus === "ready_to_print" ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#f59e0b22",color:"#f59e0b"}} title="Este pedido está programado para mañana">
                                    MAÑANA — NO IMPRIMIR
                                  </span>
                                ) : isBuffered ? (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#3b82f622",color:"#3b82f6"}}>
                                    EN ESPERA
                                  </span>
                                ) : (
                                  <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:3,background:"#94a3b822",color:"#94a3b8"}}>
                                    {ship.substatus || "—"}
                                  </span>
                                )}
                                {(isUrgent || isMañana) && (
                                  <button onClick={async () => { const ok = await doVerifyShipment(ship.shipment_id); if (ok) alert("Verificado: listo para armar"); }}
                                    style={{fontSize:9,fontWeight:600,padding:"2px 8px",borderRadius:3,border:"1px solid var(--bg4)",background:"var(--bg3)",color:"var(--txt3)",cursor:"pointer"}}>
                                    Verificar
                                  </button>
                                )}
                                {handlingInfo && isUrgent && (
                                  <span className="mono" style={{fontSize:9,color: category === "ATRASADO" ? "#ef4444" : "var(--txt3)"}}>
                                    Despachar antes: {handlingInfo}
                                  </span>
                                )}
                              </div>
                              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2}}>
                                <span style={{fontSize:10,color:"var(--txt3)"}}>{ship.receiver_name || ""}{ship.destination_city ? ` · ${ship.destination_city}` : ""}</span>
                                {ship.handling_limit && (
                                  <span className="mono" style={{fontSize:9,color:"var(--txt3)"}}>
                                    Deadline: {toChileDateStr(new Date(ship.handling_limit))} {new Date(ship.handling_limit).toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                )}
                              </div>
                            </div>
                            {bufferingInfo && (
                              <div style={{fontSize:10,color:"#3b82f6",marginBottom:4}}>{bufferingInfo}</div>
                            )}
                            {/* Items */}
                            {ship.items.map((item, idx) => {
                              const comps = getComponentesPorSkuVenta(item.seller_sku);
                              if (comps.length > 0) {
                                return comps.map((comp, ci) => {
                                  const totalUnits = comp.unidades * item.quantity;
                                  const isMultiUnit = comp.unidades > 1;
                                  return (
                                    <div key={`${idx}-${ci}`} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",fontSize:12}}>
                                      <span className="mono" style={{fontWeight:800,minWidth:110,color:"var(--cyan)"}}>{comp.skuOrigen}</span>
                                      <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--txt1)"}}>{item.title}</span>
                                      <span className="mono" style={{fontWeight:800,fontSize:13,color: isMultiUnit ? "#f59e0b" : "var(--txt1)"}}>
                                        x{totalUnits}{isMultiUnit ? ` (${comp.unidades}x${item.quantity})` : ""}
                                      </span>
                                    </div>
                                  );
                                });
                              }
                              return (
                                <div key={idx} style={{display:"flex",alignItems:"center",gap:8,padding:"3px 0",fontSize:12}}>
                                  <span className="mono" style={{fontWeight:800,minWidth:110,color:"var(--cyan)"}}>{item.seller_sku}</span>
                                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--txt1)"}}>{item.title}</span>
                                  <span className="mono" style={{fontWeight:800,fontSize:13,color:"var(--txt1)"}}>x{item.quantity}</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{textAlign:"center",padding:40,color:"var(--txt3)"}}>
          <div style={{fontSize:40,marginBottom:12}}>📦</div>
          <div style={{fontSize:16,fontWeight:700}}>Sin envíos activos</div>
          <div style={{fontSize:12,marginTop:4}}>Usa "Diagnosticar" para verificar la conexión. Luego "Sincronizar" con rango de días para traer envíos.</div>
          <div style={{fontSize:11,marginTop:8,color:"var(--txt3)"}}>Si es la primera vez, ejecuta primero la migración SQL para crear las tablas ml_shipments.</div>
          {legacyPendientes > 0 && (
            <div style={{marginTop:12}}>
              <button onClick={() => setShowLegacy(!showLegacy)} style={{fontSize:10,color:"var(--txt3)",background:"var(--bg3)",border:"1px solid var(--bg4)",borderRadius:4,padding:"4px 8px",cursor:"pointer"}}>
                {showLegacy ? "Ocultar" : "Ver"} tabla legacy ({legacyPendientes} pedidos_flex)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== CONTEO CÍCLICO ====================

export default AdminPedidosFlex;
