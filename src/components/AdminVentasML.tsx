"use client";
import { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import type { CostoFuente } from "@/lib/costos";
import { getSupabase } from "@/lib/supabase";

interface TrazaResponse {
  skus_venta: Array<{
    sku_venta: string;
    costo_resuelto: { costo_neto: number; costo_bruto_iva: number; fuente: string };
    componentes: Array<{
      sku_origen: string;
      unidades: number;
      tipo_relacion: string;
      costo_promedio: number;
      costo_catalogo: number;
      stock_actual: number;
      recepciones: Array<{ folio: string; fecha: string; estado: string; costo_unitario: number; qty: number }>;
    }>;
  }>;
}

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
  costo_producto?: number | null;
  costo_fuente?: CostoFuente | null;
  costo_snapshot_at?: string | null;
  costo_detalle?: Array<{ sku_origen: string; unidades: number; costo_unit_neto: number }> | null;
  margen?: number | null;
  margen_pct?: number | null;
  ads_cost_asignado?: number | null;
  ads_atribucion?: "direct" | "organic" | "sin_datos" | null;
  margen_neto?: number | null;
  margen_neto_pct?: number | null;
  anulada?: boolean;
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

  const weekStart = new Date(today);
  const dayOfWeek = weekStart.getDay();
  weekStart.setDate(weekStart.getDate() + (dayOfWeek === 0 ? -6 : 1 - dayOfWeek)); // Monday of current week
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

type Accent = "red" | "green" | "amber" | "cyan";

function PnlSection({ title, accent, children }: { title: string; accent: Accent; children: React.ReactNode }) {
  const color = `var(--${accent})`;
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: `2px solid ${color}`, background: `var(--${accent}Bg)`, display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.8 }}>{title}</div>
      </div>
      <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", flex: 1 }}>{children}</div>
    </div>
  );
}

function PnlRow({ label, value, hint, sub, subColor, accent }: { label: string; value: string; hint?: string; sub?: string; subColor?: Accent; accent?: Accent }) {
  const color = accent ? `var(--${accent})` : "var(--txt)";
  return (
    <div style={{ padding: "8px 14px", display: "flex", flexDirection: "column", gap: 3, borderBottom: "1px dashed var(--bg4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
        <div style={{ fontSize: 12, color: "var(--txt2)" }}>{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          {hint && <div style={{ fontSize: 10, color: "var(--txt3)", fontFamily: "var(--font-mono, monospace)" }}>{hint}</div>}
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", color, minWidth: 100, textAlign: "right" }}>{value}</div>
        </div>
      </div>
      {sub && <div style={{ fontSize: 9, color: subColor ? `var(--${subColor})` : "var(--txt3)", fontStyle: "italic" }}>{sub}</div>}
    </div>
  );
}

function PnlTotal({ label, value, accent, hint }: { label: string; value: string; accent: Accent; hint?: string }) {
  const color = `var(--${accent})`;
  return (
    <div style={{ padding: "12px 14px", marginTop: "auto", background: `var(--${accent}Bg)`, borderTop: `1px solid ${color}`, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        {hint && <div style={{ fontSize: 10, color, opacity: 0.75, fontFamily: "var(--font-mono, monospace)" }}>{hint}</div>}
        <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "var(--font-mono, monospace)", color }}>{value}</div>
      </div>
    </div>
  );
}

function PnlHint({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "6px 14px 2px", fontSize: 9, color: "var(--txt3)", fontStyle: "italic" }}>{children}</div>;
}

function SortHeader<K extends string>({ label, sortKey, align = "left", state, setState }: {
  label: string;
  sortKey: K;
  align?: "left" | "right" | "center";
  state: { key: K; dir: "asc" | "desc" };
  setState: React.Dispatch<React.SetStateAction<{ key: K; dir: "asc" | "desc" }>>;
}) {
  const active = state.key === sortKey;
  const arrow = active ? (state.dir === "asc" ? "▲" : "▼") : "⇅";
  const onClick = () => setState(prev => prev.key === sortKey ? { key: sortKey, dir: prev.dir === "asc" ? "desc" : "asc" } : { key: sortKey, dir: "desc" });
  return (
    <th
      onClick={onClick}
      style={{ textAlign: align, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title={`Ordenar por ${label}`}
    >
      <span style={{ color: active ? "var(--cyan)" : undefined }}>{label}</span>
      <span style={{ marginLeft: 4, fontSize: 9, opacity: active ? 1 : 0.35 }}>{arrow}</span>
    </th>
  );
}

type VentasMlModo = "dashboard" | "ordenes";

export default function AdminVentasML({ modo }: { modo?: VentasMlModo } = {}) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Santiago" });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [tarifaFlex, setTarifaFlex] = useState(3320);
  const [loading, setLoading] = useState<string | null>(null);
  const [pgOrders, setPgOrders] = useState<OrderRow[]>([]);
  const [mlOrders, setMlOrders] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const defaultView = modo === "ordenes" ? "ml_directo" : modo === "dashboard" ? "productos" : "comparativa";
  const [view, setView] = useState<"comparativa" | "ml_directo" | "productos">(defaultView);
  const [cfwaRango, setCfwaRango] = useState(0);
  const [adsTotalRango, setAdsTotalRango] = useState(0);
  const [stockSabanas, setStockSabanas] = useState<{ unidades: number; skus: number } | null>(null);
  const [productoSearch, setProductoSearch] = useState("");
  const [mlDirectoSearch, setMlDirectoSearch] = useState("");
  const [productosSort, setProductosSort] = useState<{ key: "sku_venta" | "canal" | "orders" | "unidades" | "ingresos" | "costo_producto" | "comision" | "envio" | "ads" | "margen" | "margen_neto"; dir: "asc" | "desc" }>({ key: "ingresos", dir: "desc" });
  const [ordenesSort, setOrdenesSort] = useState<{ key: "fecha" | "order_id" | "sku_venta" | "cantidad" | "canal" | "precio_unitario" | "subtotal" | "comision_total" | "costo_envio" | "ingreso_envio" | "total_neto" | "costo_producto" | "margen" | "ads_cost_asignado" | "margen_neto"; dir: "asc" | "desc" }>({ key: "fecha", dir: "desc" });
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [source, setSource] = useState<"cache" | "live" | "session">("cache");
  const [trazaModal, setTrazaModal] = useState<{ order: OrderRow; traza: TrazaResponse | null; loading: boolean } | null>(null);

  async function abrirTraza(order: OrderRow) {
    setTrazaModal({ order, traza: null, loading: true });
    try {
      const res = await fetch(`/api/costos/traza?sku_venta=${encodeURIComponent(order.sku_venta)}`);
      const traza = res.ok ? await res.json() : null;
      setTrazaModal({ order, traza, loading: false });
    } catch {
      setTrazaModal({ order, traza: null, loading: false });
    }
  }

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
        // Respeta el modo fijado por la tab. Solo fuerza ml_directo si no hay modo.
        if (!modo) setView("ml_directo");
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

  // On mount: always load from DB cache
  useEffect(() => {
    loadFromDBCache(today, today);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-reload orders when dates change (debounced 500ms). Evita disparos en cada keystroke.
  useEffect(() => {
    // Skip on first render (loadFromDBCache ya corre en el mount effect)
    if (from === today && to === today) return;
    const t = setTimeout(() => { loadFromDBCache(from, to); }, 500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  // Carga CFWA (almacenamiento Full) y Ads totales del rango seleccionado.
  // Ads cache tiene ~330 items/día × N días; paginamos para sortear el limit 1000 de Supabase.
  useEffect(() => {
    (async () => {
      const sb = getSupabase(); if (!sb) return;

      // CFWA: pocos rows (4/día), cabe en una llamada.
      const { data: cfwaData } = await sb
        .from("ml_billing_cfwa")
        .select("amount")
        .gte("day", from).lte("day", to)
        .limit(10000);
      const cfwa = (cfwaData || []).reduce((s: number, r: { amount: number | string }) => s + Number(r.amount || 0), 0);
      setCfwaRango(cfwa);

      // Ads: paginamos por rangos de 1000 hasta agotar.
      let adsNeto = 0;
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await sb
          .from("ml_ads_daily_cache")
          .select("cost_neto")
          .gte("date", from).lte("date", to)
          .range(offset, offset + pageSize - 1);
        if (error || !data || data.length === 0) break;
        adsNeto += data.reduce((s: number, r: { cost_neto: number | string }) => s + Number(r.cost_neto || 0), 0);
        if (data.length < pageSize) break;
        offset += pageSize;
        if (offset > 100000) break; // safety
      }
      setAdsTotalRango(Math.round(adsNeto * 1.19));
    })();
  }, [from, to]);

  // Stock de sábanas en bodega (solo dashboard, independiente del rango).
  useEffect(() => {
    if (modo === "ordenes") return;
    (async () => {
      const sb = getSupabase(); if (!sb) return;
      const { data: prods } = await sb
        .from("productos")
        .select("sku")
        .or("nombre.ilike.%sabana%,nombre.ilike.%sábana%");
      const skus = (prods || []).map((p: { sku: string }) => p.sku);
      if (skus.length === 0) { setStockSabanas({ unidades: 0, skus: 0 }); return; }
      const { data: stockRows } = await sb
        .from("stock")
        .select("cantidad")
        .in("sku", skus);
      const unidades = (stockRows || []).reduce(
        (s: number, r: { cantidad: number | null }) => s + (r.cantidad || 0),
        0,
      );
      setStockSabanas({ unidades, skus: skus.length });
    })();
  }, [modo]);

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

    if (modo === "ordenes") {
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
      return;
    }

    const excluded = new Set(["En mediación", "Cancelada", "Reembolsada"]);
    const orders = mlOrders.filter(o => !excluded.has(o.estado || "") && o.anulada !== true);

    interface Agg {
      sku: string;
      nombre: string;
      ingresos: number;
      ventas: number;
      unidades: number;
      tc: number;
      costo_producto: number;
      publicidad: number;
      fulfillment: number;
      comision: number;
      envio_neto: number;
    }
    const map = new Map<string, Agg>();
    for (const o of orders) {
      const sku = o.sku_venta || "(sin sku)";
      const a = map.get(sku) || {
        sku, nombre: o.nombre_producto || "",
        ingresos: 0, ventas: 0, unidades: 0, tc: 0,
        costo_producto: 0, publicidad: 0,
        fulfillment: 0, comision: 0, envio_neto: 0,
      };
      const isFull = o.logistic_type === "fulfillment";
      a.ingresos += o.subtotal || 0;
      a.ventas += 1;
      a.unidades += o.cantidad || 0;
      a.tc += o.ingreso_adicional_tc || 0;
      a.costo_producto += o.costo_producto || 0;
      a.publicidad += o.ads_cost_asignado || 0;
      a.comision += o.comision_total || 0;
      if (isFull) a.fulfillment += o.costo_envio || 0;
      else a.envio_neto += (o.costo_envio || 0) - (o.ingreso_envio || 0);
      map.set(sku, a);
    }

    const rows = Array.from(map.values())
      .sort((a, b) => b.ingresos - a.ingresos)
      .map(a => {
        const costo_total = a.costo_producto + a.publicidad + a.fulfillment + a.comision + a.envio_neto;
        const margen = a.ingresos + a.tc - costo_total;
        const base = a.ingresos + a.tc;
        const margen_pct = base > 0 ? (margen / base) * 100 : 0;
        return {
          "SKU": a.sku,
          "Nombre": a.nombre,
          "Ingresos": Math.round(a.ingresos),
          "Ventas": a.ventas,
          "Unidades": a.unidades,
          "Ingresos Adicionales TC": Math.round(a.tc),
          "Costo total": Math.round(costo_total),
          "Margen": Math.round(margen),
          "Margen %": Math.round(margen_pct * 100) / 100,
          "Costo producto": Math.round(a.costo_producto),
          "Publicidad": Math.round(a.publicidad),
          "Fulfillment": Math.round(a.fulfillment),
          "Comisión": Math.round(a.comision),
          "Envío neto": Math.round(a.envio_neto),
        };
      });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `ventas_ml_productos_${from}_${to}.xlsx`);
  };

  // Totals for ML directo (exclude orders in mediation)
  const excludedEstados = new Set(["En mediación", "Cancelada", "Reembolsada"]);
  const validOrders = mlOrders.filter(o => !excludedEstados.has(o.estado || "") && o.anulada !== true);
  const excludedCount = mlOrders.length - validOrders.length;
  const mlTotals = validOrders.reduce((acc, o) => ({
    subtotal: acc.subtotal + o.subtotal,
    comision: acc.comision + o.comision_total,
    envio: acc.envio + o.costo_envio,
    bonif: acc.bonif + (o.ingreso_envio || 0),
    neto: acc.neto + (o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0))),
    items: acc.items + o.cantidad,
  }), { subtotal: 0, comision: 0, envio: 0, bonif: 0, neto: 0, items: 0 });

  // Totales de margen: solo suma las filas con costo confiable (excluye sin_costo).
  // backfill_estimado y catalogo entran pero separadas visualmente.
  // margen % se calcula sobre subtotal (precio_unitario × cantidad, venta bruta).
  const ordersConCosto = validOrders.filter(o => o.costo_fuente && o.costo_fuente !== "sin_costo" && o.costo_producto != null);
  const ordersSinCosto = validOrders.filter(o => !o.costo_fuente || o.costo_fuente === "sin_costo" || o.costo_producto == null);
  const margenTotals = ordersConCosto.reduce((acc, o) => ({
    costo: acc.costo + (o.costo_producto || 0),
    margen: acc.margen + (o.margen || 0),
    ads: acc.ads + (o.ads_cost_asignado || 0),
    margen_neto: acc.margen_neto + (o.margen_neto ?? ((o.margen || 0) - (o.ads_cost_asignado || 0))),
    subtotal: acc.subtotal + o.subtotal,
  }), { costo: 0, margen: 0, ads: 0, margen_neto: 0, subtotal: 0 });
  const margenPctTotal = margenTotals.subtotal > 0 ? (margenTotals.margen / margenTotals.subtotal) * 100 : 0;
  const margenNetoPctTotal = margenTotals.subtotal > 0 ? (margenTotals.margen_neto / margenTotals.subtotal) * 100 : 0;

  // Agrupación por SKU para vista "Productos"
  interface ProductoRow {
    sku_venta: string;
    nombre: string;
    canal: string; // Full/Flex/Mix
    unidades: number;
    ingresos: number; // subtotal sum
    costo_producto: number;
    comision: number;
    envio: number;
    ads: number;
    margen: number;
    margen_neto: number;
    orders: number;
  }
  const productosMap = new Map<string, ProductoRow>();
  for (const o of validOrders) {
    const key = o.sku_venta || "(sin sku)";
    const p = productosMap.get(key) || {
      sku_venta: key,
      nombre: o.nombre_producto || "",
      canal: o.canal,
      unidades: 0, ingresos: 0, costo_producto: 0, comision: 0,
      envio: 0, ads: 0, margen: 0, margen_neto: 0, orders: 0,
    };
    if (p.canal !== o.canal && p.canal !== "Mix") p.canal = "Mix";
    p.unidades += o.cantidad || 0;
    p.ingresos += o.subtotal || 0;
    p.costo_producto += o.costo_producto || 0;
    p.comision += o.comision_total || 0;
    p.envio += (o.costo_envio || 0) - (o.ingreso_envio || 0); // neto: envío - bonif
    p.ads += o.ads_cost_asignado || 0;
    p.margen += o.margen || 0;
    p.margen_neto += o.margen_neto ?? ((o.margen || 0) - (o.ads_cost_asignado || 0));
    p.orders += 1;
    productosMap.set(key, p);
  }
  const productos = Array.from(productosMap.values())
    .filter(p => {
      if (!productoSearch) return true;
      const q = productoSearch.toLowerCase();
      return p.sku_venta.toLowerCase().includes(q) || p.nombre.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const k = productosSort.key;
      const va = a[k] as string | number;
      const vb = b[k] as string | number;
      let cmp = 0;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return productosSort.dir === "asc" ? cmp : -cmp;
    });

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

      {/* KPI Stock Sábanas — solo dashboard */}
      {modo !== "ordenes" && stockSabanas && (
        <div style={{ padding: "12px 16px", background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 10, marginBottom: 16, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>Stock bodega · Sábanas</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--cyan)", fontFamily: "var(--font-mono, monospace)" }}>
            {stockSabanas.unidades.toLocaleString("es-CL")}
            <span style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 500, marginLeft: 6 }}>unidades</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--txt3)" }}>{stockSabanas.skus} SKUs</div>
        </div>
      )}

      {/* P&L estilo ERP — solo en modo dashboard (o sin modo) */}
      {mlOrders.length > 0 && modo !== "ordenes" && (() => {
        const venta = mlTotals.subtotal;
        const envioBruto = mlTotals.envio;
        const bonif = mlTotals.bonif;
        const envioNeto = envioBruto - bonif;
        const comision = mlTotals.comision;
        const costoProd = margenTotals.costo;
        const adsReal = adsTotalRango;
        const cfwa = cfwaRango;

        const totalIngresos = venta;
        const totalGastos = comision + envioNeto + costoProd + adsReal + cfwa;
        const ingresoMl = mlTotals.neto;       // lo que ML deposita
        const margenBruto = margenTotals.margen; // ingresoMl - costoProd (aprox)
        const margenNeto = margenBruto - adsReal - cfwa;

        const pct = (n: number) => venta > 0 ? `${(n / venta * 100).toFixed(1)}%` : "—";
        const adsDirectos = margenTotals.ads;

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
            {/* INGRESOS */}
            <PnlSection title="Ingresos" accent="green">
              <PnlRow label="Venta bruta" value={fmt(venta)} />
              <PnlTotal label="Total ingresos" value={fmt(totalIngresos)} accent="green" />
              <PnlHint>
                {validOrders.length} órdenes · {mlTotals.items} items · Ticket prom. {validOrders.length > 0 ? fmt(venta / validOrders.length) : "—"}
                {excludedCount > 0 && <> · {excludedCount} excluidas</>}
              </PnlHint>
            </PnlSection>

            {/* GASTOS */}
            <PnlSection title="Gastos" accent="red">
              <PnlRow label="Comisión ML" value={fmt(comision)} hint={pct(comision)} />
              <PnlRow label="Envío" value={fmt(envioNeto)} hint={pct(envioNeto)} sub={bonif > 0 ? `${fmt(envioBruto)} − bonif ${fmt(bonif)}` : undefined} />
              <PnlRow label="Costo producto" value={fmt(costoProd)} hint={pct(costoProd)} sub={ordersSinCosto.length > 0 ? `${ordersSinCosto.length} sin costo` : undefined} subColor="amber" />
              <PnlRow label="Ads" value={fmt(adsReal)} hint={pct(adsReal)} sub={adsDirectos > 0 ? `atrib. directa ${fmt(adsDirectos)}` : undefined} />
              <PnlRow label="Almacén Full (CFWA)" value={fmt(cfwa)} hint={pct(cfwa)} />
              <PnlTotal label="Total gastos" value={fmt(totalGastos)} accent="red" hint={pct(totalGastos)} />
            </PnlSection>

            {/* RESULTADO */}
            <PnlSection title="Resultado" accent="cyan">
              <PnlRow label="Ingreso neto ML" value={fmt(ingresoMl)} hint={pct(ingresoMl)} sub="venta − comisión − envío" />
              <PnlRow label="Margen bruto" value={fmt(margenBruto)} hint={pct(margenBruto)} sub="− costo producto" accent={margenBruto >= 0 ? "green" : "red"} />
              <PnlTotal label="Margen neto" value={fmt(margenNeto)} accent={margenNeto >= 0 ? "green" : "red"} hint={pct(margenNeto)} />
              <PnlHint>
                Margen neto = margen bruto − Ads − CFWA
              </PnlHint>
            </PnlSection>
          </div>
        );
      })()}

      {/* Daily chart — solo en modo dashboard */}
      {modo !== "ordenes" && dailyChart}

      {/* Mini stats en modo órdenes */}
      {modo === "ordenes" && mlOrders.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: "10px 14px", display: "flex", gap: 24, fontSize: 12, flexWrap: "wrap", alignItems: "baseline" }}>
          <div><span style={{ color: "var(--txt3)" }}>Órdenes</span> <strong style={{ marginLeft: 4 }}>{validOrders.length}</strong></div>
          <div><span style={{ color: "var(--txt3)" }}>Items</span> <strong style={{ marginLeft: 4 }}>{mlTotals.items}</strong></div>
          <div><span style={{ color: "var(--txt3)" }}>Venta bruta</span> <strong style={{ marginLeft: 4, color: "var(--cyan)" }}>{fmt(mlTotals.subtotal)}</strong></div>
          <div><span style={{ color: "var(--txt3)" }}>Ingreso neto</span> <strong style={{ marginLeft: 4, color: "var(--green)" }}>{fmt(mlTotals.neto)}</strong></div>
          {excludedCount > 0 && <div style={{ color: "var(--amber)" }}>{excludedCount} excluidas</div>}
        </div>
      )}

      {/* View toggle — oculto cuando modo está fijado */}
      {mlOrders.length > 0 && !modo && (
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <button className={`tab ${view === "ml_directo" ? "active-cyan" : ""}`} onClick={() => setView("ml_directo")} style={{ fontSize: 12, padding: "6px 12px" }}>
            ML Directo ({mlOrders.length})
          </button>
          <button className={`tab ${view === "productos" ? "active-cyan" : ""}`} onClick={() => setView("productos")} style={{ fontSize: 12, padding: "6px 12px" }}>
            Productos ({productosMap.size})
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
      {view === "ml_directo" && mlOrders.length > 0 && (() => {
        const q = mlDirectoSearch.trim().toLowerCase();
        const filteredRaw = q === "" ? mlOrders : mlOrders.filter(o =>
          (o.sku_venta || "").toLowerCase().includes(q) ||
          (o.nombre_producto || "").toLowerCase().includes(q) ||
          (o.order_id || "").toLowerCase().includes(q) ||
          (o.order_number || "").toLowerCase().includes(q) ||
          (o.cliente || "").toLowerCase().includes(q) ||
          (o.razon_social || "").toLowerCase().includes(q) ||
          (o.canal || "").toLowerCase().includes(q) ||
          (o.estado || "").toLowerCase().includes(q)
        );
        const filtered = [...filteredRaw].sort((a, b) => {
          const k = ordenesSort.key;
          const va = (a[k] ?? 0) as string | number | null;
          const vb = (b[k] ?? 0) as string | number | null;
          let cmp = 0;
          if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
          else cmp = String(va ?? "").localeCompare(String(vb ?? ""));
          return ordenesSort.dir === "asc" ? cmp : -cmp;
        });
        const totales = filtered.reduce((s, o) => ({
          subtotal: s.subtotal + (o.subtotal || 0),
          comision: s.comision + (o.comision_total || 0),
          neto: s.neto + (o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0))),
          margen: s.margen + (o.margen || 0),
        }), { subtotal: 0, comision: 0, neto: 0, margen: 0 });
        return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--bg3)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="form-input"
              placeholder="Buscar por SKU, producto, Order ID, cliente, canal, estado..."
              value={mlDirectoSearch}
              onChange={e => setMlDirectoSearch(e.target.value)}
              style={{ flex: 1, minWidth: 240, padding: "6px 10px", fontSize: 12 }}
            />
            {mlDirectoSearch && (
              <button
                onClick={() => setMlDirectoSearch("")}
                style={{ padding: "6px 10px", fontSize: 11, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", borderRadius: 4, cursor: "pointer" }}
              >Limpiar</button>
            )}
            <div style={{ fontSize: 11, color: "var(--txt2)", whiteSpace: "nowrap" }}>
              <span className="mono" style={{ color: filtered.length === mlOrders.length ? "var(--txt2)" : "var(--cyan)", fontWeight: 700 }}>
                {filtered.length}
              </span>
              {filtered.length !== mlOrders.length && <span style={{ color: "var(--txt3)" }}> de {mlOrders.length}</span>} filas
              {q && (
                <span style={{ marginLeft: 10, color: "var(--txt3)" }}>
                  | Subtotal <span className="mono" style={{ color: "var(--txt)" }}>{fmt(totales.subtotal)}</span>
                  {" · "}Neto <span className="mono" style={{ color: "var(--green)" }}>{fmt(totales.neto)}</span>
                  {" · "}Margen <span className="mono" style={{ color: totales.margen >= 0 ? "var(--green)" : "var(--red)" }}>{fmt(totales.margen)}</span>
                </span>
              )}
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <SortHeader label="Order" sortKey="order_id" align="left" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="SKU" sortKey="sku_venta" align="left" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Qty" sortKey="cantidad" align="left" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Canal" sortKey="canal" align="left" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Precio" sortKey="precio_unitario" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Subtotal" sortKey="subtotal" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Comisión" sortKey="comision_total" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Envío" sortKey="costo_envio" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Bonif." sortKey="ingreso_envio" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Neto" sortKey="total_neto" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Costo Prod." sortKey="costo_producto" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Margen" sortKey="margen" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Ads" sortKey="ads_cost_asignado" align="right" state={ordenesSort} setState={setOrdenesSort} />
                <SortHeader label="Margen Neto" sortKey="margen_neto" align="right" state={ordenesSort} setState={setOrdenesSort} />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={14} style={{ textAlign: "center", padding: 20, color: "var(--txt3)" }}>Sin resultados para &quot;{mlDirectoSearch}&quot;</td></tr>
              )}
              {filtered.map((o, i) => {
                const enMediacion = excludedEstados.has(o.estado || "");
                const fuente = o.costo_fuente || null;
                const sinCosto = fuente === "sin_costo" || o.costo_producto == null;
                const margenColor = sinCosto
                  ? "var(--txt3)"
                  : fuente === "promedio"
                    ? "var(--green)"
                    : fuente === "catalogo"
                      ? "var(--amber)"
                      : fuente === "backfill_estimado"
                        ? "var(--cyan)"
                        : fuente === "sin_fuente"
                          ? "var(--txt3)"
                          : "var(--txt)";
                const fuenteLabel: Record<string, string> = {
                  promedio: "ponderado real",
                  catalogo: "catálogo",
                  backfill_estimado: "costo histórico estimado — no usar para decisiones",
                  sin_fuente: "snapshot legacy sin fuente",
                  sin_costo: "SIN COSTO",
                };
                const fuenteBadgeText: string | null =
                  sinCosto ? "sin costo"
                  : fuente === "backfill_estimado" ? "est."
                  : fuente === "sin_fuente" ? "legacy"
                  : null;
                const fuenteBadge = fuenteBadgeText ? (
                  <span
                    title={fuente ? fuenteLabel[fuente] || fuente : "sin costo"}
                    style={{
                      marginLeft: 4,
                      fontSize: 9,
                      padding: "1px 4px",
                      borderRadius: 3,
                      background: "var(--bg4)",
                      color: "var(--amber)",
                    }}
                  >
                    {fuenteBadgeText}
                  </span>
                ) : null;
                return (
                <tr key={i} style={enMediacion ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td className="mono" style={{ fontSize: 10 }}>{o.order_id}{enMediacion && <span style={{ display: "block", fontSize: 9, color: o.estado === "Cancelada" ? "var(--red)" : "var(--amber)", textDecoration: "none" }}>{o.estado?.toUpperCase()}</span>}</td>
                  <td style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.sku_venta}</td>
                  <td style={{ textAlign: "center" }}>{o.cantidad}</td>
                  <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: o.canal === "Full" ? "var(--blueBg)" : "var(--cyanBg)", color: o.canal === "Full" ? "var(--blue)" : "var(--cyan)" }}>{o.canal}</span></td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmt(o.precio_unitario)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmt(o.subtotal)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--red)" }}>{fmt(o.comision_total)}</td>
                  <td className="mono" style={{ textAlign: "right", color: o.costo_envio > 0 ? "var(--amber)" : "var(--txt3)" }}>{fmt(o.costo_envio)}</td>
                  <td className="mono" style={{ textAlign: "right", color: o.ingreso_envio > 0 ? "var(--green)" : "var(--txt3)" }}>{o.ingreso_envio > 0 ? `+${fmt(o.ingreso_envio)}` : "-"}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: enMediacion ? "var(--txt3)" : "var(--green)" }}>{fmt(o.total_neto ?? (o.subtotal - o.comision_total - o.costo_envio + (o.ingreso_envio || 0)))}</td>
                  <td className="mono" style={{ textAlign: "right", color: sinCosto ? "var(--red)" : "var(--txt3)" }} title={fuente ? fuenteLabel[fuente] || fuente : ""}>
                    {sinCosto ? "—" : (
                      <button
                        onClick={() => abrirTraza(o)}
                        title="Ver cómo se calculó este costo"
                        style={{
                          background: "none", border: "none", color: "inherit",
                          cursor: "pointer", padding: 0, fontFamily: "inherit",
                          fontSize: "inherit", textDecoration: "underline dotted",
                        }}
                      >
                        {fmt(o.costo_producto || 0)} 🔍
                      </button>
                    )}
                    {fuenteBadge}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: margenColor }} title={fuente ? `Fuente: ${fuenteLabel[fuente] || fuente}` : ""}>
                    {sinCosto ? "—" : `${fmt(o.margen || 0)} (${(o.subtotal > 0 ? ((o.margen || 0) / o.subtotal) * 100 : 0).toFixed(1)}%)`}
                    {fuenteBadge}
                  </td>
                  {(() => {
                    const adsCost = o.ads_cost_asignado || 0;
                    const adsAtr = o.ads_atribucion || "sin_datos";
                    const adsLabel: Record<string, string> = { direct: "atribuida al ad", organic: "orgánica", sin_datos: "sin data" };
                    const adsColor = adsAtr === "direct" ? "var(--amber)" : "var(--txt3)";
                    const margenNeto = o.margen_neto ?? ((o.margen || 0) - adsCost);
                    const margenNetoPctCell = o.subtotal > 0 ? (margenNeto / o.subtotal) * 100 : 0;
                    const mnColor = sinCosto ? "var(--txt3)" : margenNeto >= 0 ? "var(--green)" : "var(--red)";
                    return (
                      <>
                        <td className="mono" style={{ textAlign: "right", color: adsColor }} title={`Atribución: ${adsLabel[adsAtr] || adsAtr}`}>
                          {adsCost > 0 ? fmt(adsCost) : (adsAtr === "direct" ? "$0" : "—")}
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: mnColor }}>
                          {sinCosto ? "—" : `${fmt(margenNeto)} (${margenNetoPctCell.toFixed(1)}%)`}
                        </td>
                      </>
                    );
                  })()}
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        );
      })()}

      {/* Productos view (agrupado por SKU) */}
      {view === "productos" && mlOrders.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--bg3)", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="form-input"
              placeholder="Buscar por SKU o nombre..."
              value={productoSearch}
              onChange={e => setProductoSearch(e.target.value)}
              style={{ flex: 1, fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: "var(--txt3)" }}>{productos.length} SKUs</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
              <thead>
                <tr>
                  <SortHeader label="Producto" sortKey="sku_venta" align="left" state={productosSort} setState={setProductosSort} />
                  <SortHeader label="Ingresos" sortKey="ingresos" align="right" state={productosSort} setState={setProductosSort} />
                  <th style={{ textAlign: "left", minWidth: 200 }}>Costos</th>
                  <SortHeader label="Margen bruto" sortKey="margen" align="right" state={productosSort} setState={setProductosSort} />
                  <SortHeader label="Margen neto (post-ads)" sortKey="margen_neto" align="right" state={productosSort} setState={setProductosSort} />
                </tr>
              </thead>
              <tbody>
                {productos.map(p => {
                  const pct = (n: number) => p.ingresos > 0 ? ((n / p.ingresos) * 100).toFixed(1) : "0.0";
                  const margenPct = p.ingresos > 0 ? (p.margen / p.ingresos) * 100 : 0;
                  const margenNetoPctCell = p.ingresos > 0 ? (p.margen_neto / p.ingresos) * 100 : 0;
                  const mColor = p.margen >= 0 ? "var(--green)" : "var(--red)";
                  const mnColor = p.margen_neto >= 0 ? "var(--green)" : "var(--red)";
                  return (
                    <tr key={p.sku_venta} style={{ borderBottom: "1px solid var(--bg3)" }}>
                      <td style={{ padding: "10px 8px" }}>
                        <div className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--cyan)" }}>{p.sku_venta}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nombre}</div>
                        <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 2 }}>
                          <span style={{ padding: "1px 5px", borderRadius: 3, background: p.canal === "Full" ? "var(--blueBg)" : p.canal === "Flex" ? "var(--cyanBg)" : "var(--bg3)", color: p.canal === "Full" ? "var(--blue)" : p.canal === "Flex" ? "var(--cyan)" : "var(--txt3)" }}>{p.canal}</span>
                          {" · "}{p.orders} órdenes · {p.unidades} u
                        </div>
                      </td>
                      <td className="mono" style={{ textAlign: "right", padding: "10px 8px" }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{fmt(p.ingresos)}</div>
                        <div style={{ fontSize: 10, color: "var(--txt3)" }}>{p.unidades} u · {p.orders} órdenes</div>
                      </td>
                      <td style={{ padding: "10px 8px", fontSize: 10, color: "var(--txt3)" }}>
                        <div>Costo prod: <span style={{ color: "var(--txt)" }}>{pct(p.costo_producto)}%</span> <span className="mono">{fmt(p.costo_producto)}</span></div>
                        <div>Comisión: <span style={{ color: "var(--txt)" }}>{pct(p.comision)}%</span> <span className="mono">{fmt(p.comision)}</span></div>
                        <div>Envío: <span style={{ color: "var(--txt)" }}>{pct(p.envio)}%</span> <span className="mono">{fmt(p.envio)}</span></div>
                        {p.ads > 0 && <div>Ads: <span style={{ color: "var(--amber)" }}>{pct(p.ads)}%</span> <span className="mono">{fmt(p.ads)}</span></div>}
                      </td>
                      <td className="mono" style={{ textAlign: "right", padding: "10px 8px", fontWeight: 700, color: mColor }}>
                        <div>{fmt(p.margen)}</div>
                        <div style={{ fontSize: 10, opacity: 0.7 }}>{margenPct.toFixed(1)}%</div>
                      </td>
                      <td className="mono" style={{ textAlign: "right", padding: "10px 8px", fontWeight: 700, color: mnColor }}>
                        <div>{fmt(p.margen_neto)}</div>
                        <div style={{ fontSize: 10, opacity: 0.7 }}>{margenNetoPctCell.toFixed(1)}%</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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

      {/* Modal de trazabilidad de costo */}
      {trazaModal && (
        <div
          onClick={() => setTrazaModal(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 14,
              padding: 24, maxWidth: 720, width: "100%", maxHeight: "85vh", overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Trazabilidad de costo</div>
                <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 2 }}>
                  Orden #{trazaModal.order.order_id} · {trazaModal.order.sku_venta} × {trazaModal.order.cantidad}
                </div>
              </div>
              <button
                onClick={() => setTrazaModal(null)}
                style={{ background: "var(--bg4)", border: "none", color: "var(--txt)", padding: "4px 10px", borderRadius: 6, cursor: "pointer" }}
              >✕</button>
            </div>

            {/* Snapshot de la venta */}
            <div className="card" style={{ background: "var(--bg3)", padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 6 }}>SNAPSHOT INMUTABLE DE LA VENTA</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
                <div><b>Costo registrado:</b> <span className="mono">{fmt(trazaModal.order.costo_producto || 0)}</span></div>
                <div><b>Fuente:</b> <span style={{ color: "var(--cyan)" }}>{trazaModal.order.costo_fuente || "—"}</span></div>
                <div><b>Cuándo se snapshotó:</b> <span className="mono" style={{ fontSize: 10 }}>{trazaModal.order.costo_snapshot_at?.slice(0, 19).replace("T", " ") || "—"}</span></div>
                <div><b>Margen neto:</b> <span style={{ color: (trazaModal.order.margen_neto || 0) >= 0 ? "var(--green)" : "var(--red)" }} className="mono">{fmt(trazaModal.order.margen_neto || 0)}</span></div>
              </div>

              {/* Detalle persistido en JSONB */}
              {trazaModal.order.costo_detalle && trazaModal.order.costo_detalle.length > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--bg4)" }}>
                  <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 4 }}>DETALLE GUARDADO AL MOMENTO DEL SYNC:</div>
                  {trazaModal.order.costo_detalle.map((d, i) => (
                    <div key={i} style={{ fontSize: 12, fontFamily: "var(--monospace-font, monospace)", color: "var(--txt2)" }}>
                      • {d.sku_origen} × {d.unidades} ud @ {fmt(d.costo_unit_neto)} neto
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Estado actual de la cadena (vivo) */}
            <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 6, marginTop: 16 }}>ESTADO ACTUAL DE LA CADENA (en vivo)</div>

            {trazaModal.loading && (
              <div style={{ padding: 20, textAlign: "center", color: "var(--txt3)" }}>Cargando…</div>
            )}

            {!trazaModal.loading && trazaModal.traza && trazaModal.traza.skus_venta?.[0] && (
              <div className="card" style={{ background: "var(--bg3)", padding: 12 }}>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  <b>Costo resuelto hoy:</b> <span className="mono">{fmt(trazaModal.traza.skus_venta[0].costo_resuelto.costo_bruto_iva)}</span> bruto
                  ({fmt(trazaModal.traza.skus_venta[0].costo_resuelto.costo_neto)} neto +IVA)
                </div>
                {trazaModal.traza.skus_venta[0].componentes.map((c, i) => (
                  <div key={i} style={{ marginTop: 12, padding: 10, background: "var(--bg2)", borderRadius: 6, borderLeft: `3px solid ${c.tipo_relacion === "alternativo" ? "var(--amber)" : "var(--cyan)"}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                      {c.sku_origen}
                      <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: c.tipo_relacion === "alternativo" ? "var(--amberBg)" : "var(--cyanBg)", color: c.tipo_relacion === "alternativo" ? "var(--amber)" : "var(--cyan)" }}>
                        {c.tipo_relacion} × {c.unidades}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--txt2)", marginTop: 4 }}>
                      WAC: <span className="mono">{fmt(c.costo_promedio)}</span> · Catálogo: <span className="mono">{fmt(c.costo_catalogo)}</span> · Stock: <span className="mono">{c.stock_actual}</span> uds
                    </div>
                    {c.recepciones && c.recepciones.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 10, color: "var(--txt3)" }}>
                        Últimas recepciones: {c.recepciones.slice(0, 3).map((r, j) => (
                          <span key={j} style={{ marginRight: 8 }}>
                            #{r.folio}: {r.qty}u @ {fmt(r.costo_unitario)} ({r.fecha?.slice(0, 10)})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {!trazaModal.loading && !trazaModal.traza && (
              <div style={{ padding: 20, textAlign: "center", color: "var(--red)" }}>
                Error cargando trazabilidad
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
