"use client";
import { useState, useEffect } from "react";
import * as XLSX from "xlsx";

interface OrderRow {
  order_id: string;
  order_number?: string;
  fecha?: string;
  cliente?: string;
  razon_social?: string;
  sku_venta: string;
  nombre_producto: string;
  cantidad: number;
  canal: string;
  precio_unitario: number;
  subtotal: number;
  comision_unitaria: number;
  comision_total: number;
  estado?: string;
  costo_envio: number;
  ingreso_envio: number;
  ingreso_adicional_tc: number;
  total: number;
  total_neto?: number;
  logistic_type: string;
  fuente: string;
  documento_tributario?: string;
  estado_documento?: string;
}

interface ComparisonRow {
  order_id: string;
  sku_venta: string;
  nombre: string;
  pg: OrderRow | null;
  ml: OrderRow | null;
}

const fmt = (n: number) => "$" + n.toLocaleString("es-CL");

const CACHE_KEY = "banva_ventas_ml_cache";

function saveCache(data: { from: string; to: string; tarifaFlex: number; mlOrders: OrderRow[]; pgOrders: OrderRow[]; updatedAt: string }) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

function loadCache(): { from: string; to: string; tarifaFlex: number; mlOrders: OrderRow[]; pgOrders: OrderRow[]; updatedAt: string } | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function getDatePresets() {
  const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const today = new Date(todayStr + "T12:00:00");
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(weekStart); lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  const yearStart = new Date(today.getFullYear(), 0, 1);

  const last7 = new Date(today); last7.setDate(last7.getDate() - 6);
  const last30 = new Date(today); last30.setDate(last30.getDate() - 29);

  return [
    { label: "Hoy", from: todayStr, to: todayStr },
    { label: "Ayer", from: fmt(yesterday), to: fmt(yesterday) },
    { label: "Últ. 7 días", from: fmt(last7), to: todayStr },
    { label: "Esta semana", from: fmt(weekStart), to: todayStr },
    { label: "Sem. pasada", from: fmt(lastWeekStart), to: fmt(lastWeekEnd) },
    { label: "Últ. 30 días", from: fmt(last30), to: todayStr },
    { label: "Este mes", from: fmt(monthStart), to: todayStr },
    { label: "Mes pasado", from: fmt(lastMonthStart), to: fmt(lastMonthEnd) },
    { label: "Este año", from: fmt(yearStart), to: todayStr },
  ];
}

export default function AdminVentasML() {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [tarifaFlex, setTarifaFlex] = useState(3320);
  const [loading, setLoading] = useState<string | null>(null);
  const [pgOrders, setPgOrders] = useState<OrderRow[]>([]);
  const [mlOrders, setMlOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"comparativa" | "ml_directo">("comparativa");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [source, setSource] = useState<"cache" | "live" | "session">("cache");

  // Load from DB cache (instant)
  const loadFromDBCache = async (f: string, t: string) => {
    setLoading("Cargando desde cache...");
    setError(null);
    try {
      const res = await fetch(`/api/ml/ventas-cache?from=${f}&to=${t}`);
      const json = await res.json();
      if (json.ordenes && json.ordenes.length > 0) {
        setMlOrders(json.ordenes);
        setPgOrders([]);
        setView("ml_directo");
        setSource("cache");
        const syncTime = json.last_sync ? new Date(json.last_sync).toLocaleString("es-CL", { timeZone: "America/Santiago" }) : null;
        setLastUpdated(syncTime);
        saveCache({ from: f, to: t, tarifaFlex, mlOrders: json.ordenes, pgOrders: [], updatedAt: syncTime || "" });
        return true;
      }
      return false;
    } catch { return false; }
    finally { setLoading(null); }
  };

  // On mount: load from DB cache (always fresh), sessionStorage as instant fallback
  useEffect(() => {
    const cached = loadCache();
    const targetFrom = cached?.from || today;
    const targetTo = cached?.to || today;
    if (cached) {
      setFrom(cached.from);
      setTo(cached.to);
      setTarifaFlex(cached.tarifaFlex);
    }
    // Show sessionStorage data instantly while DB loads
    if (cached?.mlOrders?.length) {
      setMlOrders(cached.mlOrders);
      setPgOrders(cached.pgOrders);
      setSource("session");
      if (cached.pgOrders.length > 0) setView("comparativa");
      else setView("ml_directo");
    }
    // Then load fresh from DB cache (overwrites session data)
    loadFromDBCache(targetFrom, targetTo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchBoth = async () => {
    setLoading("Cargando ambas fuentes...");
    setError(null);
    try {
      // ML directo in 15-day chunks
      const allMl: OrderRow[] = [];
      const start = new Date(from + "T00:00:00");
      const end = new Date(to + "T00:00:00");
      const chunks: { from: string; to: string }[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + 14); // 15-day chunks
        const actualEnd = chunkEnd > end ? end : chunkEnd;
        chunks.push({ from: cursor.toISOString().slice(0, 10), to: actualEnd.toISOString().slice(0, 10) });
        cursor.setDate(actualEnd.getDate() + 1);
      }
      if (chunks.length === 0) chunks.push({ from, to });

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        setLoading(`Cargando ML ${c.from} → ${c.to} (${i + 1}/${chunks.length})...`);
        const res = await fetch(`/api/ml/orders-history?from=${c.from}&to=${c.to}&tarifa_flex=${tarifaFlex}`);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error(`Respuesta inválida de ML (${c.from}→${c.to}). Posible timeout.`); }
        if (data.error) throw new Error("ML: " + data.error);
        allMl.push(...(data.ordenes || []));
      }
      setMlOrders(allMl);

      setLoading("Cargando ProfitGuard...");
      const pgRes = await fetch(`/api/profitguard/orders?from=${from}&to=${to}`);
      const pgText = await pgRes.text();
      let pgData;
      try { pgData = JSON.parse(pgText); } catch { setError("ProfitGuard: respuesta inválida"); setPgOrders([]); return; }
      if (pgData.error) {
        setError("ProfitGuard falló: " + pgData.error);
        setPgOrders([]);
      } else {
        setPgOrders(pgData.ordenes || []);
      }
      const now = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
      setLastUpdated(now);
      setSource("live");
      saveCache({ from, to, tarifaFlex, mlOrders: allMl, pgOrders: pgData?.ordenes || [], updatedAt: now });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(null);
    }
  };

  const fetchMLOnly = async () => {
    setLoading("Cargando ML Directo...");
    setError(null);
    try {
      // Split into chunks of 5 days (backend has 5 min timeout)
      const allOrdenes: OrderRow[] = [];
      const start = new Date(from + "T00:00:00");
      const end = new Date(to + "T00:00:00");
      const chunks: { from: string; to: string }[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        const chunkEnd = new Date(cursor);
        chunkEnd.setDate(chunkEnd.getDate() + 29); // 30-day chunks
        const actualEnd = chunkEnd > end ? end : chunkEnd;
        chunks.push({ from: cursor.toISOString().slice(0, 10), to: actualEnd.toISOString().slice(0, 10) });
        cursor.setDate(actualEnd.getDate() + 1);
      }
      if (chunks.length === 0) chunks.push({ from, to });

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        setLoading(`Cargando ML ${c.from} → ${c.to} (${i + 1}/${chunks.length})...`);
        const res = await fetch(`/api/ml/orders-history?from=${c.from}&to=${c.to}&tarifa_flex=${tarifaFlex}`);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { throw new Error(`Respuesta inválida de ML (${c.from}→${c.to}). Posible timeout — intenta un rango más corto.`); }
        if (data.error) throw new Error("ML: " + data.error);
        allOrdenes.push(...(data.ordenes || []));
      }
      setMlOrders(allOrdenes);
      setPgOrders([]);
      const now = new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" });
      setLastUpdated(now);
      setSource("live");
      saveCache({ from, to, tarifaFlex, mlOrders: allOrdenes, pgOrders: [], updatedAt: now });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(null);
    }
  };

  // Build comparison
  const pgMap = new Map<string, OrderRow>();
  for (const o of pgOrders) pgMap.set(`${o.order_id}|${o.sku_venta}`, o);
  const mlMap = new Map<string, OrderRow>();
  for (const o of mlOrders) mlMap.set(`${o.order_id}|${o.sku_venta}`, o);

  const allKeys = new Set([...Array.from(pgMap.keys()), ...Array.from(mlMap.keys())]);
  const rows: ComparisonRow[] = Array.from(allKeys).map(key => {
    const pg = pgMap.get(key) || null;
    const ml = mlMap.get(key) || null;
    const ref = ml || pg;
    return { order_id: ref!.order_id, sku_venta: ref!.sku_venta, nombre: ref!.nombre_producto, pg, ml };
  }).sort((a, b) => (b.ml?.order_id || b.pg?.order_id || "").localeCompare(a.ml?.order_id || a.pg?.order_id || ""));

  const commonCount = rows.filter(r => r.pg && r.ml).length;
  const pgOnlyCount = rows.filter(r => r.pg && !r.ml).length;
  const mlOnlyCount = rows.filter(r => !r.pg && r.ml).length;

  // Field match stats
  const fields = ["precio_unitario", "subtotal", "comision_total", "costo_envio", "ingreso_envio", "total"] as const;
  const matchStats: Record<string, number> = {};
  for (const f of fields) {
    matchStats[f] = rows.filter(r => r.pg && r.ml && r.pg[f] === r.ml[f]).length;
  }

  const exportToExcel = () => {
    if (mlOrders.length === 0) return;
    const rows = mlOrders.map(o => ({
      "Cliente": o.cliente || "",
      "Razón Social": o.razon_social || "",
      "Canal": o.canal,
      "Order ID": o.order_id,
      "Order Number": o.order_number || o.order_id,
      "Fecha": o.fecha || "",
      "Producto": o.nombre_producto,
      "SKU": o.sku_venta,
      "Cantidad": o.cantidad,
      "Precio Unitario": o.precio_unitario,
      "Subtotal": o.subtotal,
      "Comision Unitaria": o.comision_unitaria,
      "Comision Total": o.comision_total,
      "Estado": o.estado || "",
      "Costo Envío": o.costo_envio,
      "Ingreso Envío": o.ingreso_envio || 0,
      "Ingreso Adicional Tarjeta de Crédito": o.ingreso_adicional_tc || 0,
      "Total": o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0)),
      "Logística": o.logistic_type,
      "Documento Tributario": o.documento_tributario || "",
      "Estado Documento": o.estado_documento || "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ventas ML");
    XLSX.writeFile(wb, `ventas_ml_${from}_${to}.xlsx`);
  };

  // Totals for ML directo (exclude orders in mediation)
  const validOrders = mlOrders.filter(o => o.estado !== "En mediación");
  const mediacionCount = mlOrders.length - validOrders.length;
  const mlTotals = validOrders.reduce((acc, o) => ({
    subtotal: acc.subtotal + o.subtotal,
    comision: acc.comision + o.comision_total,
    envio: acc.envio + o.costo_envio,
    bonif: acc.bonif + (o.ingreso_envio || 0),
    neto: acc.neto + (o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0))),
    items: acc.items + o.cantidad,
  }), { subtotal: 0, comision: 0, envio: 0, bonif: 0, neto: 0, items: 0 });

  // Daily chart data
  const dailyChart = (() => {
    if (validOrders.length === 0) return null;
    const dailyMap = new Map<string, { venta: number; neto: number; orders: number }>();
    for (const o of validOrders) {
      const day = (o.fecha || "").slice(0, 10);
      if (!day) continue;
      const prev = dailyMap.get(day) || { venta: 0, neto: 0, orders: 0 };
      prev.venta += o.subtotal;
      prev.neto += o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0));
      prev.orders += 1;
      dailyMap.set(day, prev);
    }
    const days = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length <= 1) return null;
    const maxVenta = Math.max(...days.map(([, d]) => d.venta), 1);
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>📊 Ventas por día</div>
          <div style={{ fontSize: 10, color: "var(--txt3)" }}>{days.length} días</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }}>
          {days.map(([day, d]) => {
            const h = Math.max(4, (d.venta / maxVenta) * 100);
            const netoH = Math.max(2, (Math.max(0, d.neto) / maxVenta) * 100);
            const dayLabel = day.slice(5);
            return (
              <div key={day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }} title={`${day}\nVenta: ${fmt(d.venta)}\nNeto: ${fmt(d.neto)}\nÓrdenes: ${d.orders}`}>
                <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                  <div style={{ width: "80%", maxWidth: 40, height: h, background: "var(--cyanBg)", borderRadius: "3px 3px 0 0", border: "1px solid var(--cyanBd)", position: "relative" }}>
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: netoH, background: "var(--cyan)", borderRadius: "0 0 0 0", opacity: 0.6 }} />
                  </div>
                </div>
                <div style={{ fontSize: 8, color: "var(--txt3)", marginTop: 4, transform: days.length > 15 ? "rotate(-45deg)" : undefined, whiteSpace: "nowrap" }}>{dayLabel}</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 8, justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--txt3)" }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--cyanBg)", border: "1px solid var(--cyanBd)" }} /> Venta bruta
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--txt3)" }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: "var(--cyan)", opacity: 0.6 }} /> Neto
          </div>
        </div>
      </div>
    );
  })();

  return (
    <div>
      {/* Header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>💰 Ventas MercadoLibre</h2>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>Comparativa ProfitGuard vs API ML Directa</div>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <label style={{ fontSize: 10, color: "var(--txt3)" }}>Tarifa Flex:</label>
              <input type="number" value={tarifaFlex} onChange={e => setTarifaFlex(parseInt(e.target.value) || 0)}
                style={{ width: 60, padding: "5px 6px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11, textAlign: "right" }} />
            </div>
            {mlOrders.length > 0 && (
              <button onClick={exportToExcel}
                style={{ padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>
                Exportar
              </button>
            )}
          </div>
        </div>
        {/* Date presets */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 12 }}>
          {getDatePresets().map(p => {
            const isActive = from === p.from && to === p.to;
            return (
              <button key={p.label} onClick={() => { setFrom(p.from); setTo(p.to); loadFromDBCache(p.from, p.to); }}
                style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, fontWeight: isActive ? 700 : 500, background: isActive ? "var(--cyanBg)" : "var(--bg3)", color: isActive ? "var(--cyan)" : "var(--txt3)", border: `1px solid ${isActive ? "var(--cyanBd)" : "var(--bg4)"}`, cursor: "pointer" }}>
                {p.label}
              </button>
            );
          })}
        </div>
        {/* Custom date range + actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11 }} />
          <span style={{ color: "var(--txt3)", fontSize: 11 }}>→</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11 }} />
          <button onClick={fetchMLOnly} disabled={!!loading}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: loading ? "wait" : "pointer" }}>
            {loading ? "Cargando..." : "Cargar"}
          </button>
          <button onClick={fetchBoth} disabled={!!loading}
            style={{ padding: "5px 12px", borderRadius: 6, fontSize: 10, fontWeight: 600, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: loading ? "wait" : "pointer" }}>
            + ProfitGuard
          </button>
        </div>
        {loading && <div style={{ marginTop: 8, fontSize: 12, color: "var(--amber)" }}>{loading}</div>}
        {error && <div style={{ marginTop: 8, fontSize: 12, color: "var(--red)" }}>{error}</div>}
        {lastUpdated && !loading && <div style={{ marginTop: 8, fontSize: 11, color: "var(--txt3)" }}>Última sync: {lastUpdated} · Fuente: {source === "cache" ? "Cache DB (auto)" : source === "live" ? "ML API (live)" : "Sesión"}</div>}
      </div>

      {/* KPIs */}
      {mlOrders.length > 0 && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi"><div className="kpi-label">Órdenes ML</div><div className="kpi-value">{validOrders.length}{mediacionCount > 0 ? <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 400 }}> ({mediacionCount} en mediación)</span> : null}</div></div>
          <div className="kpi"><div className="kpi-label">Items</div><div className="kpi-value">{mlTotals.items}</div></div>
          <div className="kpi"><div className="kpi-label">Venta bruta</div><div className="kpi-value" style={{ fontSize: 16 }}>{fmt(mlTotals.subtotal)}</div></div>
          <div className="kpi"><div className="kpi-label">Comisiones</div><div className="kpi-value" style={{ color: "var(--red)", fontSize: 16 }}>{fmt(mlTotals.comision)}</div></div>
          <div className="kpi"><div className="kpi-label">Envío</div><div className="kpi-value" style={{ color: "var(--amber)", fontSize: 16 }}>{fmt(mlTotals.envio)}</div></div>
          {mlTotals.bonif > 0 && <div className="kpi"><div className="kpi-label">Bonificación</div><div className="kpi-value" style={{ color: "var(--green)", fontSize: 16 }}>+{fmt(mlTotals.bonif)}</div></div>}
          <div className="kpi"><div className="kpi-label">Ingreso neto</div><div className="kpi-value" style={{ color: "var(--green)", fontSize: 16 }}>{fmt(mlTotals.neto)}</div></div>
        </div>
      )}

      {/* Daily chart */}
      {dailyChart}

      {/* View toggle */}
      {mlOrders.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <button className={`tab ${view === "ml_directo" ? "active-cyan" : ""}`} onClick={() => setView("ml_directo")} style={{ fontSize: 12, padding: "6px 12px" }}>
            ML Directo ({mlOrders.length})
          </button>
          {pgOrders.length > 0 && (
            <button className={`tab ${view === "comparativa" ? "active-cyan" : ""}`} onClick={() => setView("comparativa")} style={{ fontSize: 12, padding: "6px 12px" }}>
              Comparativa ({commonCount} en común)
            </button>
          )}
        </div>
      )}

      {/* Comparison stats */}
      {view === "comparativa" && pgOrders.length > 0 && mlOrders.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Coincidencias por campo ({commonCount} órdenes en común)</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {fields.map(f => {
              const pct = commonCount > 0 ? Math.round(matchStats[f] / commonCount * 100) : 0;
              const color = pct === 100 ? "var(--green)" : pct > 80 ? "var(--amber)" : "var(--red)";
              return (
                <div key={f} style={{ fontSize: 11, padding: "4px 8px", borderRadius: 4, background: "var(--bg3)", border: `1px solid var(--bg4)` }}>
                  <span style={{ color: "var(--txt3)" }}>{f.replace(/_/g, " ")}: </span>
                  <span style={{ color, fontWeight: 700 }}>{matchStats[f]}/{commonCount} ({pct}%)</span>
                </div>
              );
            })}
          </div>
          {pgOnlyCount > 0 && <div style={{ fontSize: 11, color: "var(--amber)", marginTop: 6 }}>⚠ {pgOnlyCount} órdenes solo en ProfitGuard</div>}
          {mlOnlyCount > 0 && <div style={{ fontSize: 11, color: "var(--blue)", marginTop: 2 }}>ℹ {mlOnlyCount} órdenes solo en ML Directo</div>}
        </div>
      )}

      {/* ML Directo table */}
      {view === "ml_directo" && mlOrders.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th>Order</th><th>SKU</th><th>Qty</th><th>Canal</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "right" }}>Subtotal</th>
                <th style={{ textAlign: "right" }}>Comisión</th>
                <th style={{ textAlign: "right" }}>Envío</th>
                <th style={{ textAlign: "right" }}>Bonif.</th>
                <th style={{ textAlign: "right" }}>Neto</th>
              </tr>
            </thead>
            <tbody>
              {mlOrders.map((o, i) => {
                const enMediacion = o.estado === "En mediación";
                return (
                <tr key={i} style={enMediacion ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td className="mono" style={{ fontSize: 10 }}>{o.order_id}{enMediacion && <span style={{ display: "block", fontSize: 9, color: "var(--amber)", textDecoration: "none" }}>MEDIACIÓN</span>}</td>
                  <td style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.sku_venta}</td>
                  <td style={{ textAlign: "center" }}>{o.cantidad}</td>
                  <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: o.canal === "Full" ? "var(--blueBg)" : "var(--cyanBg)", color: o.canal === "Full" ? "var(--blue)" : "var(--cyan)" }}>{o.canal}</span></td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmt(o.precio_unitario)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmt(o.subtotal)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--red)" }}>{fmt(o.comision_total)}</td>
                  <td className="mono" style={{ textAlign: "right", color: o.costo_envio > 0 ? "var(--amber)" : "var(--txt3)" }}>{fmt(o.costo_envio)}</td>
                  <td className="mono" style={{ textAlign: "right", color: o.ingreso_envio > 0 ? "var(--green)" : "var(--txt3)" }}>{o.ingreso_envio > 0 ? `+${fmt(o.ingreso_envio)}` : "-"}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: enMediacion ? "var(--txt3)" : "var(--green)" }}>{fmt(o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0)))}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Comparison table */}
      {view === "comparativa" && pgOrders.length > 0 && mlOrders.length > 0 && (
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th>Order</th><th>SKU</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "right" }}>Comisión PG</th><th style={{ textAlign: "right" }}>Comisión ML</th>
                <th style={{ textAlign: "right" }}>Envío PG</th><th style={{ textAlign: "right" }}>Envío ML</th>
                <th style={{ textAlign: "right" }}>Neto ML</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter(r => r.pg && r.ml).slice(0, 100).map((r, i) => {
                const pg = r.pg!;
                const ml = r.ml!;
                const mlNeto = ml.total_neto ?? (ml.subtotal - ml.comision_total - ml.costo_envio);
                const comMatch = pg.comision_total === ml.comision_total;
                const envMatch = pg.costo_envio === ml.costo_envio;
                return (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 10 }}>{r.order_id}</td>
                    <td style={{ maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sku_venta}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmt(pg.precio_unitario)}</td>
                    <td className="mono" style={{ textAlign: "right", color: comMatch ? "var(--txt)" : "var(--amber)" }}>{fmt(pg.comision_total)}</td>
                    <td className="mono" style={{ textAlign: "right", color: comMatch ? "var(--txt)" : "var(--cyan)" }}>{fmt(ml.comision_total)}</td>
                    <td className="mono" style={{ textAlign: "right", color: envMatch ? "var(--txt)" : "var(--amber)" }}>{fmt(pg.costo_envio)}</td>
                    <td className="mono" style={{ textAlign: "right", color: envMatch ? "var(--txt)" : "var(--cyan)" }}>{fmt(ml.costo_envio)}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: "var(--green)" }}>{fmt(mlNeto)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {mlOrders.length === 0 && !loading && (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Selecciona un rango de fechas</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Usa "Solo ML" para ver datos directos o "Comparar" para contrastar con ProfitGuard</div>
        </div>
      )}
    </div>
  );
}
