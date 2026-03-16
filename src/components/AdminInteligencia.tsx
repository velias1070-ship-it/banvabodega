"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { getSupabase } from "@/lib/supabase";
import AdminMLSinVincular from "./AdminMLSinVincular";

// ============================================
// Tipos
// ============================================

interface IntelRow {
  sku_origen: string;
  nombre: string | null;
  categoria: string | null;
  proveedor: string | null;
  skus_venta: string[];
  vel_ponderada: number;
  vel_full: number;
  vel_flex: number;
  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  stock_full: number;
  stock_bodega: number;
  stock_total: number;
  stock_en_transito: number;
  stock_proyectado: number;
  oc_pendientes: number;
  pct_full: number;
  pct_flex: number;
  cob_full: number;
  cob_total: number;
  target_dias_full: number;
  abc: string;
  xyz: string;
  cuadrante: string;
  accion: string;
  prioridad: number;
  mandar_full: number;
  pedir_proveedor: number;
  pedir_proveedor_bultos: number;
  margen_full_30d: number;
  margen_flex_30d: number;
  canal_mas_rentable: string | null;
  precio_promedio: number;
  costo_bruto: number;
  gmroi: number;
  dio: number;
  ingreso_30d: number;
  dias_sin_stock_full: number;
  venta_perdida_pesos: number;
  alertas: string[];
  alertas_count: number;
  evento_activo: string | null;
  multiplicador_evento: number;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number;
  stock_seguridad: number;
  punto_reorden: number;
  vel_pre_quiebre: number;
  dias_en_quiebre: number;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  gmroi_potencial: number;
  es_catch_up: boolean;
  vel_objetivo: number;
  gap_vel_pct: number | null;
  updated_at: string;
}

interface VentaRow {
  sku_venta: string;
  sku_origen: string;
  nombre: string | null;
  unidades_por_pack: number;
  es_pack: boolean;
  abc: string;
  xyz: string;
  cuadrante: string;
  proveedor: string | null;
  alertas: string[];
  alertas_count: number;
  accion: string;
  prioridad: number;
  target_dias_full: number;
  stock_bodega: number;
  stock_bodega_compartido: boolean;
  stock_bodega_formatos: number;
  stock_en_transito: number;
  mandar_full: number;
  pedir_proveedor: number;
  evento_activo: string | null;
  dias_en_quiebre: number;
  vel_pre_quiebre: number;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  es_catch_up: boolean;
  venta_perdida_pesos: number;
  liquidacion_accion: string | null;
  updated_at: string;
  stock_full: number;
  stock_danado: number;
  stock_perdido: number;
  stock_transferencia_full: number;
  vel_7d: number;
  vel_30d: number;
  vel_60d: number;
  vel_ponderada: number;
  vel_full: number;
  vel_flex: number;
  pct_full: number;
  pct_flex: number;
  cob_full: number;
  margen_full_30d: number;
  margen_flex_30d: number;
  ingreso_30d: number;
  canal_mas_rentable: string | null;
  precio_promedio: number;
  // Campos heredados del origen para vel_objetivo
  vel_objetivo: number;
  gap_vel_pct: number | null;
  gmroi: number;
  dio: number;
}

// ============================================
// Helpers
// ============================================

const fmtN = (n: number | null | undefined, d = 1) => n == null ? "—" : Number(n).toFixed(d);
const fmtInt = (n: number | null | undefined) => n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtK = (n: number) => {
  if (Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n).toLocaleString("es-CL");
};

function accionColor(a: string): string {
  switch (a) {
    case "URGENTE": return "var(--red)";
    case "AGOTADO_PEDIR": return "var(--red)";
    case "AGOTADO_SIN_PROVEEDOR": return "var(--red)";
    case "PEDIR": return "var(--amber)";
    case "MANDAR_FULL": return "var(--blue)";
    case "MANDAR": return "var(--blue)";
    case "PLANIFICAR": return "var(--amber)";
    case "EN_TRANSITO": return "var(--blue)";
    case "OK": return "var(--green)";
    case "EXCESO": return "var(--cyan)";
    case "DEAD_STOCK": return "var(--txt3)";
    case "INACTIVO": return "var(--txt3)";
    default: return "var(--txt3)";
  }
}

function abcColor(a: string): string {
  switch (a) {
    case "A": return "var(--green)";
    case "B": return "var(--amber)";
    case "C": return "var(--txt3)";
    default: return "var(--txt3)";
  }
}

function cuadranteLabel(c: string): string {
  switch (c) {
    case "ESTRELLA": return "Estrella";
    case "VOLUMEN": return "Volumen";
    case "CASHCOW": return "Cash Cow";
    case "REVISAR": return "Revisar";
    default: return c;
  }
}

function gapColor(gap: number | null): string {
  if (gap == null) return "var(--txt3)";
  if (gap >= 0) return "var(--green)";
  if (gap > -20) return "var(--txt2)";
  return "var(--red)";
}

// ============================================
// Componente de celda editable vel_objetivo
// ============================================

function VelObjetivoCell({ skuOrigen, value, onChange }: { skuOrigen: string; value: number; onChange: (sku: string, val: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [tmp, setTmp] = useState(String(value || ""));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    const v = parseFloat(tmp) || 0;
    if (v !== value) onChange(skuOrigen, v);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="0.1"
        value={tmp}
        onChange={e => setTmp(e.target.value)}
        onBlur={save}
        onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        className="mono"
        style={{ width: 56, fontSize: 11, padding: "2px 4px", background: "var(--bg3)", border: "1px solid var(--cyanBd)", borderRadius: 4, color: "var(--txt)", textAlign: "right" }}
      />
    );
  }

  return (
    <span
      onClick={() => { setTmp(String(value || "")); setEditing(true); }}
      className="mono"
      style={{ cursor: "pointer", fontSize: 11, color: value > 0 ? "var(--txt)" : "var(--txt3)", textAlign: "right", display: "block" }}
      title="Click para editar"
    >
      {value > 0 ? fmtN(value) : "Definir"}
    </span>
  );
}

// ============================================
// Componente principal
// ============================================

export default function AdminInteligencia() {
  const [rows, setRows] = useState<IntelRow[]>([]);
  const [ventaRows, setVentaRows] = useState<VentaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [recalculando, setRecalculando] = useState(false);
  const [recalcResult, setRecalcResult] = useState<string | null>(null);
  const [syncingML, setSyncingML] = useState(false);
  const [syncMLResult, setSyncMLResult] = useState<string | null>(null);
  const [vistaOrigen, setVistaOrigen] = useState(false);

  // Filtros
  const [filtroAccion, setFiltroAccion] = useState<string>("todos");
  const [filtroABC, setFiltroABC] = useState<string>("todos");
  const [filtroCuadrante, setFiltroCuadrante] = useState<string>("todos");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");
  const [filtroAlerta, setFiltroAlerta] = useState<string>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [ordenarPor, setOrdenarPor] = useState<string>("prioridad");
  const [mlItemsMap, setMlItemsMap] = useState<Map<string, string[]>>(new Map());

  // ML sin vincular
  const [mlSinVincular, setMlSinVincular] = useState<{ item_id: string; title: string; available_quantity: number }[]>([]);
  const [mlSinVincularOpen, setMlSinVincularOpen] = useState(false);

  // Modal masivo
  const [modalMasivo, setModalMasivo] = useState(false);
  const [masivoMode, setMasivoMode] = useState<"abc" | "categoria" | "manual">("abc");
  const [masivoMultiplier, setMasivoMultiplier] = useState("1.1");
  const [masivoAbcFilter, setMasivoAbcFilter] = useState("A");
  const [masivoCatFilter, setMasivoCatFilter] = useState("");
  const [masivoSaving, setMasivoSaving] = useState(false);

  const cargarOrigen = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from("sku_intelligence")
      .select("*")
      .or("vel_ponderada.gt.0,stock_total.gt.0")
      .order("prioridad", { ascending: true })
      .limit(500);
    const r = (data || []) as IntelRow[];
    setRows(r);
    if (r.length > 0) setLastUpdate(r[0].updated_at);
  }, []);

  const cargarVenta = useCallback(async () => {
    try {
      const res = await fetch("/api/intelligence/sku-venta");
      if (res.ok) {
        const json = await res.json();
        const vRows = (json.rows || []) as VentaRow[];
        setVentaRows(vRows);
        if (vRows.length > 0 && !lastUpdate) {
          setLastUpdate(vRows[0].updated_at);
        }
      }
    } catch { /* silenciar */ }
  }, [lastUpdate]);

  const cargarMlMap = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from("ml_items_map").select("sku, item_id");
    const map = new Map<string, string[]>();
    for (const row of (data || [])) {
      const arr = map.get(row.sku) || [];
      arr.push(row.item_id);
      map.set(row.sku, arr);
    }
    setMlItemsMap(map);

    // Detectar items ML sin vincular
    const allSkus = new Set((data || []).map((r: { sku: string }) => r.sku));
    const { data: mlItems } = await sb.from("ml_items_map").select("item_id, sku, title, available_quantity");
    const sinVincular: { item_id: string; title: string; available_quantity: number }[] = [];
    for (const item of (mlItems || [])) {
      if (!item.sku || item.sku.trim() === "") {
        sinVincular.push({ item_id: item.item_id, title: item.title || "", available_quantity: item.available_quantity || 0 });
      }
    }
    setMlSinVincular(sinVincular);
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    await Promise.all([cargarOrigen(), cargarVenta(), cargarMlMap()]);
    setLoading(false);
  }, [cargarOrigen, cargarVenta, cargarMlMap]);

  useEffect(() => { cargar(); }, [cargar]);

  const recalcular = useCallback(async () => {
    setRecalculando(true);
    setRecalcResult(null);
    try {
      const res = await fetch("/api/intelligence/recalcular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setRecalcResult(`Recalculados: ${data.recalculados} SKUs en ${data.tiempo_ms}ms`);
        await cargar();
      } else {
        setRecalcResult("Error al recalcular");
      }
    } catch {
      setRecalcResult("Error de conexion");
    }
    setRecalculando(false);
  }, [cargar]);

  const syncStockML = useCallback(async () => {
    setSyncingML(true);
    setSyncMLResult(null);
    try {
      const res = await fetch("/api/ml/sync-stock-full", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recalcular: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setSyncMLResult(`ML Sync: ${data.items_sincronizados} items, ${data.stock_actualizado} SKUs actualizados en ${(data.tiempo_ms / 1000).toFixed(1)}s${data.errores?.length ? ` (${data.errores.length} errores)` : ""}`);
        await cargar();
      } else {
        setSyncMLResult("Error al sincronizar stock ML");
      }
    } catch {
      setSyncMLResult("Error de conexion con ML");
    }
    setSyncingML(false);
  }, [cargar]);

  // Guardar vel_objetivo inline
  const guardarVelObjetivo = useCallback(async (skuOrigen: string, velObj: number) => {
    try {
      await fetch(`/api/intelligence/sku/${encodeURIComponent(skuOrigen)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vel_objetivo: velObj, motivo: "Ajuste manual" }),
      });
      // Actualizar localmente
      setRows(prev => prev.map(r => {
        if (r.sku_origen !== skuOrigen) return r;
        const gap = velObj > 0 ? Math.round(((r.vel_ponderada - velObj) / velObj) * 100 * 100) / 100 : null;
        return { ...r, vel_objetivo: velObj, gap_vel_pct: gap };
      }));
      setVentaRows(prev => prev.map(r => {
        if (r.sku_origen !== skuOrigen) return r;
        const gap = velObj > 0 ? Math.round(((r.vel_ponderada - velObj) / velObj) * 100 * 100) / 100 : null;
        return { ...r, vel_objetivo: velObj, gap_vel_pct: gap };
      }));
    } catch { /* silenciar */ }
  }, []);

  // Guardar masivo
  const guardarMasivo = useCallback(async () => {
    setMasivoSaving(true);
    const mult = parseFloat(masivoMultiplier) || 1;
    let targets: { sku_origen: string; vel_objetivo: number }[] = [];

    if (masivoMode === "abc") {
      targets = rows
        .filter(r => r.abc === masivoAbcFilter && r.vel_ponderada > 0)
        .map(r => ({ sku_origen: r.sku_origen, vel_objetivo: Math.round(r.vel_ponderada * mult * 10) / 10 }));
    } else if (masivoMode === "categoria") {
      targets = rows
        .filter(r => r.categoria === masivoCatFilter && r.vel_ponderada > 0)
        .map(r => ({ sku_origen: r.sku_origen, vel_objetivo: Math.round(r.vel_ponderada * mult * 10) / 10 }));
    }

    if (targets.length > 0) {
      const motDesc = masivoMode === "abc"
        ? `Ajuste masivo ABC ${masivoAbcFilter} x${mult}`
        : `Ajuste masivo cat. ${masivoCatFilter} x${mult}`;
      try {
        await fetch("/api/intelligence/sku/_bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: targets, motivo: motDesc }),
        });
        await cargar();
      } catch { /* silenciar */ }
    }
    setMasivoSaving(false);
    setModalMasivo(false);
  }, [masivoMode, masivoAbcFilter, masivoCatFilter, masivoMultiplier, rows, cargar]);

  // ── Datos activos según vista ──
  const activeRows = vistaOrigen ? rows : ventaRows;

  // Proveedores únicos
  const proveedores = Array.from(new Set(rows.map((r: IntelRow) => r.proveedor).filter(Boolean))) as string[];

  // Categorías únicas
  const categorias = Array.from(new Set(rows.map((r: IntelRow) => r.categoria).filter(Boolean))) as string[];

  // Alertas únicas
  const alertasUnicas: string[] = [];
  rows.forEach((r: IntelRow) => {
    (r.alertas || []).forEach((a: string) => {
      if (!alertasUnicas.includes(a)) alertasUnicas.push(a);
    });
  });
  alertasUnicas.sort();

  // Filtrar
  type AnyRow = IntelRow | VentaRow;
  let filtered: AnyRow[] = activeRows;
  if (filtroAccion !== "todos") filtered = filtered.filter((r: AnyRow) => r.accion === filtroAccion);
  if (filtroABC !== "todos") filtered = filtered.filter((r: AnyRow) => r.abc === filtroABC);
  if (filtroCuadrante !== "todos") filtered = filtered.filter((r: AnyRow) => r.cuadrante === filtroCuadrante);
  if (filtroProveedor !== "todos") filtered = filtered.filter((r: AnyRow) => r.proveedor === filtroProveedor);
  if (filtroAlerta !== "todos") filtered = filtered.filter((r: AnyRow) => (r.alertas || []).includes(filtroAlerta));
  if (busqueda.trim()) {
    const q = busqueda.toLowerCase();
    filtered = filtered.filter((r: AnyRow) => {
      const skuKey = vistaOrigen ? (r as IntelRow).sku_origen : (r as VentaRow).sku_venta;
      const skuOrigen = vistaOrigen ? (r as IntelRow).sku_origen : (r as VentaRow).sku_origen;
      if (skuKey.toLowerCase().includes(q)) return true;
      if ((r.nombre || "").toLowerCase().includes(q)) return true;
      if (skuOrigen.toLowerCase().includes(q)) return true;
      if (vistaOrigen) {
        const svs = (r as IntelRow).skus_venta || [];
        if (svs.some(sv => sv.toLowerCase().includes(q))) return true;
      }
      const mlIds = mlItemsMap.get(skuOrigen) || [];
      if (mlIds.some(id => id.toLowerCase().includes(q))) return true;
      if (!vistaOrigen) {
        const mlIdsVenta = mlItemsMap.get((r as VentaRow).sku_venta) || [];
        if (mlIdsVenta.some(id => id.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }

  // Ordenar
  filtered = [...filtered].sort((a: AnyRow, b: AnyRow) => {
    switch (ordenarPor) {
      case "prioridad": return a.prioridad - b.prioridad;
      case "vel": return b.vel_ponderada - a.vel_ponderada;
      case "cob": return a.cob_full - b.cob_full;
      case "ingreso": return b.ingreso_30d - a.ingreso_30d;
      case "venta_perdida": return (b.venta_perdida_pesos || 0) - (a.venta_perdida_pesos || 0);
      case "gmroi": {
        const ga = (a as IntelRow).gmroi || 0;
        const gb = (b as IntelRow).gmroi || 0;
        return gb - ga;
      }
      case "dio": {
        const da = (a as IntelRow).dio || 0;
        const db = (b as IntelRow).dio || 0;
        return db - da;
      }
      case "gap": {
        const gapA = a.gap_vel_pct ?? 999;
        const gapB = b.gap_vel_pct ?? 999;
        return gapA - gapB;
      }
      default: return 0;
    }
  });

  // Exportar CSV
  const exportarCSV = () => {
    if (vistaOrigen) exportarCSVOrigen(filtered as IntelRow[]);
    else exportarCSVVenta(filtered as VentaRow[]);
  };

  // KPIs (siempre desde origen)
  const totalSkus = rows.length;
  const totalVentas = ventaRows.length;
  const agotadosFull = rows.filter((r: IntelRow) => r.stock_full <= 0 && r.vel_full > 0).length;
  const urgentes = rows.filter((r: IntelRow) => r.accion === "URGENTE" || r.accion === "PEDIR").length;
  const ventaPerdida = rows.reduce((a: number, r: IntelRow) => a + (r.venta_perdida_pesos || 0), 0);
  const gmroiProm = rows.length > 0 ? rows.reduce((a: number, r: IntelRow) => a + (r.gmroi || 0), 0) / rows.length : 0;

  // KPIs nuevos: % A en meta, % A con stock
  const skusA = rows.filter((r: IntelRow) => r.abc === "A");
  const skusAConObj = skusA.filter(r => r.vel_objetivo > 0);
  const skusAEnMeta = skusAConObj.filter(r => r.vel_ponderada >= r.vel_objetivo);
  const pctAEnMeta = skusAConObj.length > 0 ? Math.round((skusAEnMeta.length / skusAConObj.length) * 100) : null;
  const skusAConStock = skusA.filter(r => r.stock_full > 0);
  const pctAConStock = skusA.length > 0 ? Math.round((skusAConStock.length / skusA.length) * 100) : null;

  const abcA = skusA.length;
  const abcB = rows.filter((r: IntelRow) => r.abc === "B").length;
  const abcC = rows.filter((r: IntelRow) => r.abc === "C").length;

  // Evento activo
  const eventoActivo = rows.find((r: IntelRow) => r.evento_activo);

  // Estrellas en quiebre
  const estrellasQuiebre = rows.filter((r: IntelRow) => r.dias_en_quiebre >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A"));

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando inteligencia...</div>;

  return (
    <div style={{ padding: "0 4px" }}>
      {/* ═══ 1. HEADER + KPIs compactos ═══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Inteligencia</h2>
          {lastUpdate && <span style={{ fontSize: 10, color: "var(--txt3)" }}>{new Date(lastUpdate).toLocaleString("es-CL")}</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--bg4)" }}>
            <button onClick={() => setVistaOrigen(false)} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: !vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: !vistaOrigen ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Venta
            </button>
            <button onClick={() => setVistaOrigen(true)} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: vistaOrigen ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Origen
            </button>
          </div>
          <button onClick={() => setModalMasivo(true)} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", fontWeight: 600, fontSize: 11, border: "1px solid var(--amberBd)", cursor: "pointer" }}>
            Definir objetivos
          </button>
          <button onClick={syncStockML} disabled={syncingML} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 600, fontSize: 11, border: "1px solid var(--blueBd)", cursor: "pointer" }}>
            {syncingML ? "Sync..." : "Sync ML"}
          </button>
          <button onClick={recalcular} disabled={recalculando} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 600, fontSize: 11, border: "1px solid var(--cyanBd)", cursor: "pointer" }}>
            {recalculando ? "Recalculando..." : "Recalcular"}
          </button>
          <button onClick={exportarCSV} disabled={filtered.length === 0} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontWeight: 600, fontSize: 11, border: "1px solid var(--greenBd)", cursor: "pointer" }}>
            CSV
          </button>
          <button onClick={cargar} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 11, border: "1px solid var(--bg4)", cursor: "pointer" }}>
            Refrescar
          </button>
        </div>
      </div>

      {syncMLResult && <div style={{ padding: "6px 10px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontSize: 11, marginBottom: 6, border: "1px solid var(--blueBd)" }}>{syncMLResult}</div>}
      {recalcResult && <div style={{ padding: "6px 10px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontSize: 11, marginBottom: 6, border: "1px solid var(--greenBd)" }}>{recalcResult}</div>}

      {/* KPIs en una línea compacta */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap", fontSize: 11 }}>
        <KpiBadge label="SKUs" value={String(vistaOrigen ? totalSkus : totalVentas)} color="var(--cyan)" />
        <KpiBadge label="Agotados" value={String(agotadosFull)} color="var(--red)" />
        <KpiBadge label="Urgentes" value={String(urgentes)} color="var(--amber)" />
        <KpiBadge label="V.Perdida" value={fmtK(ventaPerdida)} color="var(--red)" />
        <KpiBadge label="GMROI" value={fmtN(gmroiProm, 1)} color="var(--txt)" />
        <KpiBadge
          label="A en meta"
          value={pctAEnMeta !== null ? pctAEnMeta + "%" : "—"}
          color={pctAEnMeta !== null && pctAEnMeta >= 80 ? "var(--green)" : pctAEnMeta !== null ? "var(--amber)" : "var(--txt3)"}
          title={pctAEnMeta === null ? "Define vel. objetivo para activar" : `${skusAEnMeta.length}/${skusAConObj.length} SKUs A en meta`}
        />
        <KpiBadge
          label="A c/stock"
          value={pctAConStock !== null ? pctAConStock + "%" : "—"}
          color={pctAConStock !== null && pctAConStock >= 97 ? "var(--green)" : pctAConStock !== null ? "var(--amber)" : "var(--txt3)"}
          title={`${skusAConStock.length}/${skusA.length} SKUs A con stock Full > 0`}
        />
      </div>

      {/* ═══ 2. BANNER EVENTO ACTIVO ═══ */}
      {eventoActivo && (
        <div style={{ padding: "6px 12px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", fontSize: 11, marginBottom: 8, border: "1px solid var(--amberBd)", fontWeight: 600 }}>
          Preparacion {eventoActivo.evento_activo} (x{eventoActivo.multiplicador_evento}) — Targets ajustados
        </div>
      )}

      {/* ═══ 3. BARRA ABC ═══ */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--txt3)" }}>ABC:</span>
        <div style={{ flex: 1, display: "flex", height: 18, borderRadius: 5, overflow: "hidden" }}>
          {abcA > 0 && <div style={{ width: `${(abcA / totalSkus) * 100}%`, background: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#000" }}>A ({abcA})</div>}
          {abcB > 0 && <div style={{ width: `${(abcB / totalSkus) * 100}%`, background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#000" }}>B ({abcB})</div>}
          {abcC > 0 && <div style={{ width: `${(abcC / totalSkus) * 100}%`, background: "var(--bg4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "var(--txt3)" }}>C ({abcC})</div>}
        </div>
      </div>

      {/* Estrellas en quiebre prolongado */}
      {estrellasQuiebre.length > 0 && (
        <div style={{ marginBottom: 8, padding: "8px 10px", borderRadius: 6, border: "1px solid var(--redBd)", background: "var(--redBg)" }}>
          <div style={{ fontWeight: 700, fontSize: 11, color: "var(--red)", marginBottom: 4 }}>Estrellas en Quiebre ({estrellasQuiebre.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {estrellasQuiebre.map((r: IntelRow) => (
              <div key={r.sku_origen} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 10 }}>
                <span className="mono" style={{ fontWeight: 700, color: "var(--txt)" }}>{r.sku_origen}</span>
                <span style={{ color: "var(--txt2)", flex: 1, minWidth: 80 }}>{r.nombre || ""}</span>
                <span style={{ color: "var(--cyan)" }}>Vel pre: {fmtN(r.vel_pre_quiebre)}/sem</span>
                <span style={{ color: "var(--red)" }}>{r.dias_en_quiebre}d</span>
                <span style={{ color: "var(--red)" }}>{fmtMoney(r.venta_perdida_pesos)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ML sin vincular banner */}
      {mlSinVincular.length > 0 && (
        <div style={{ padding: "5px 10px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", fontSize: 10, marginBottom: 8, border: "1px solid var(--amberBd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{mlSinVincular.length} items ML sin vincular ({mlSinVincular.reduce((a, i) => a + i.available_quantity, 0)} uds invisibles)</span>
          <button onClick={() => setMlSinVincularOpen(!mlSinVincularOpen)} style={{ background: "none", border: "none", color: "var(--amber)", fontWeight: 600, fontSize: 10, cursor: "pointer", textDecoration: "underline" }}>
            {mlSinVincularOpen ? "Ocultar" : "Ver"}
          </button>
        </div>
      )}

      {/* ═══ 4. FILTROS ═══ */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Buscar SKU, nombre o ML..."
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          className="form-input"
          style={{ flex: "1 1 160px", minWidth: 100, fontSize: 11, padding: "5px 8px" }}
        />
        <select value={filtroAccion} onChange={e => setFiltroAccion(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="todos">Accion: Todas</option>
          <option value="URGENTE">URGENTE</option>
          <option value="AGOTADO_PEDIR">AGOTADO PEDIR</option>
          <option value="AGOTADO_SIN_PROVEEDOR">SIN PROVEEDOR</option>
          <option value="MANDAR_FULL">MANDAR FULL</option>
          <option value="PLANIFICAR">PLANIFICAR</option>
          <option value="EN_TRANSITO">EN TRANSITO</option>
          <option value="OK">OK</option>
          <option value="EXCESO">EXCESO</option>
          <option value="DEAD_STOCK">DEAD STOCK</option>
        </select>
        <select value={filtroABC} onChange={e => setFiltroABC(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="todos">ABC: Todos</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
        <select value={filtroCuadrante} onChange={e => setFiltroCuadrante(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="todos">Cuad: Todos</option>
          <option value="ESTRELLA">Estrella</option>
          <option value="VOLUMEN">Volumen</option>
          <option value="CASHCOW">Cash Cow</option>
          <option value="REVISAR">Revisar</option>
        </select>
        <select value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="todos">Prov: Todos</option>
          {proveedores.map((p: string) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filtroAlerta} onChange={e => setFiltroAlerta(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="todos">Alerta: Todas</option>
          {alertasUnicas.map((a: string) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={ordenarPor} onChange={e => setOrdenarPor(e.target.value)} className="form-input" style={{ fontSize: 11, padding: "5px 6px" }}>
          <option value="prioridad">Prioridad</option>
          <option value="vel">Velocidad</option>
          <option value="cob">Cobertura</option>
          <option value="ingreso">Ingreso 30d</option>
          <option value="venta_perdida">V.Perdida</option>
          <option value="gmroi">GMROI</option>
          <option value="dio">DIO</option>
          <option value="gap">Gap Vel.Obj</option>
        </select>
      </div>

      <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 6 }}>
        {filtered.length} de {vistaOrigen ? totalSkus : totalVentas} {vistaOrigen ? "SKUs Origen" : "SKUs Venta"}
      </div>

      {/* ═══ 5. TABLA SKU VENTA ═══ */}
      {!vistaOrigen && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 1500 }}>
            <thead>
              <tr>
                <th>SKU Venta</th>
                <th>SKU Origen</th>
                <th>Nombre</th>
                <th>Accion</th>
                <th>ABC</th>
                <th style={{ textAlign: "right" }}>Vel/sem</th>
                <th style={{ textAlign: "right" }}>Vel Obj</th>
                <th style={{ textAlign: "right" }}>Gap</th>
                <th style={{ textAlign: "right" }}>St.Full</th>
                <th style={{ textAlign: "right" }}>St.Bod</th>
                <th style={{ textAlign: "right" }}>Cob Full</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th style={{ textAlign: "right" }}>Mandar</th>
                <th style={{ textAlign: "right" }}>Pedir</th>
                <th style={{ textAlign: "right" }}>Margen F</th>
                <th style={{ textAlign: "right" }}>Margen Fx</th>
                <th style={{ textAlign: "right" }}>GMROI</th>
                <th style={{ textAlign: "right" }}>DIO</th>
                <th>Cuad.</th>
                <th>Alertas</th>
              </tr>
            </thead>
            <tbody>
              {(filtered as VentaRow[]).map((r: VentaRow) => (
                <tr key={r.sku_venta + ":" + r.sku_origen}>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                    {r.es_pack && <span title="Pack/Combo" style={{ marginRight: 3, color: "var(--amber)" }}>P</span>}
                    {r.es_catch_up && <span title="Catch-up" style={{ marginRight: 3, color: "var(--amber)" }}>!</span>}
                    {r.sku_venta}
                    {r.unidades_por_pack > 1 && <span style={{ fontSize: 9, color: "var(--txt3)", marginLeft: 3 }}>x{r.unidades_por_pack}</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 10, color: r.sku_origen !== r.sku_venta ? "var(--txt2)" : "var(--txt3)", whiteSpace: "nowrap" }}>{r.sku_origen || r.sku_venta}</td>
                  <td style={{ fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nombre || ""}>{r.nombre || "—"}</td>
                  <td>
                    <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: accionColor(r.accion) + "22", color: accionColor(r.accion), border: `1px solid ${accionColor(r.accion)}44` }}>
                      {r.accion}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span style={{ color: abcColor(r.abc), fontWeight: 700, fontSize: 11 }}>{r.abc}</span>
                    <span style={{ color: "var(--txt3)", fontSize: 9 }}>{r.xyz}</span>
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(r.vel_ponderada)}</td>
                  <td style={{ textAlign: "right" }}>
                    <VelObjetivoCell skuOrigen={r.sku_origen} value={r.vel_objetivo || 0} onChange={guardarVelObjetivo} />
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: gapColor(r.gap_vel_pct) }}>
                    {r.gap_vel_pct != null ? (r.gap_vel_pct > 0 ? "+" : "") + fmtN(r.gap_vel_pct, 0) + "%" : "—"}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.stock_full <= 0 && r.vel_full > 0 ? "var(--red)" : "var(--txt)" }}
                    title={(() => {
                      const d = r.stock_danado || 0;
                      const p = r.stock_perdido || 0;
                      const t = r.stock_transferencia_full || 0;
                      if (d > 0 || p > 0 || t > 0) return `${r.stock_full} disp${d ? ` + ${d} dan` : ""}${p ? ` + ${p} perd` : ""}${t ? ` + ${t} transf` : ""}`;
                      return undefined;
                    })()}
                  >
                    {fmtInt(r.stock_full)}
                    {(r.stock_danado > 0 || r.stock_perdido > 0) && <span style={{ color: "var(--amber)", fontSize: 9, marginLeft: 2 }}>!</span>}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }} title={r.stock_bodega_compartido ? `Compartido (${r.stock_bodega_formatos} formatos)` : undefined}>
                    {fmtInt(r.stock_bodega)}{r.stock_bodega_compartido && <span style={{ fontSize: 9, color: "var(--amber)", marginLeft: 2 }}>*</span>}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.cob_full < 14 ? "var(--red)" : r.cob_full < 30 ? "var(--amber)" : "var(--green)" }}>{r.cob_full >= 999 ? "—" : fmtN(r.cob_full, 0) + "d"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{fmtN(r.target_dias_full, 0)}d</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.mandar_full > 0 ? "var(--blue)" : "var(--txt3)" }}>{r.mandar_full > 0 ? fmtInt(r.mandar_full) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.pedir_proveedor > 0 ? "var(--amber)" : "var(--txt3)" }}>{r.pedir_proveedor > 0 ? fmtInt(r.pedir_proveedor) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_full_30d < 0 ? "var(--red)" : "var(--green)" }}>{fmtMoney(r.margen_full_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_flex_30d < 0 ? "var(--red)" : r.margen_flex_30d > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtMoney(r.margen_flex_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(r.gmroi || 0, 1)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: (r.dio || 0) > 90 ? "var(--red)" : (r.dio || 0) > 60 ? "var(--amber)" : "var(--txt)" }}>{fmtN(r.dio || 0, 0)}</td>
                  <td style={{ fontSize: 9, color: "var(--txt2)" }}>{cuadranteLabel(r.cuadrante)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 140 }}>
                      {(r.alertas || []).slice(0, 3).map((a: string, i: number) => (
                        <span key={i} style={{ padding: "1px 4px", borderRadius: 3, fontSize: 8, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", whiteSpace: "nowrap" }}>{a}</span>
                      ))}
                      {(r.alertas || []).length > 3 && <span style={{ fontSize: 8, color: "var(--txt3)" }}>+{r.alertas.length - 3}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(filtered as VentaRow[]).some(r => r.stock_bodega_compartido) && (
            <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 4, paddingLeft: 4 }}>
              <span style={{ color: "var(--amber)" }}>*</span> Stock bodega compartido entre formatos
            </div>
          )}
        </div>
      )}

      {/* ═══ 5b. TABLA SKU ORIGEN ═══ */}
      {vistaOrigen && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 1500 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Accion</th>
                <th>ABC</th>
                <th style={{ textAlign: "right" }}>Vel/sem</th>
                <th style={{ textAlign: "right" }}>Vel Obj</th>
                <th style={{ textAlign: "right" }}>Gap</th>
                <th style={{ textAlign: "right" }}>St.Full</th>
                <th style={{ textAlign: "right" }}>St.Bod</th>
                <th style={{ textAlign: "right" }}>Cob Full</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th style={{ textAlign: "right" }}>Mandar</th>
                <th style={{ textAlign: "right" }}>Pedir</th>
                <th style={{ textAlign: "right" }}>Margen F</th>
                <th style={{ textAlign: "right" }}>Margen Fx</th>
                <th style={{ textAlign: "right" }}>GMROI</th>
                <th style={{ textAlign: "right" }}>DIO</th>
                <th>Cuad.</th>
                <th>Alertas</th>
              </tr>
            </thead>
            <tbody>
              {(filtered as IntelRow[]).map((r: IntelRow) => {
                const esEstrellaQuiebre = r.dias_en_quiebre >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A");
                return (
                <tr key={r.sku_origen} style={esEstrellaQuiebre ? { background: "var(--redBg)" } : undefined}>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                    {esEstrellaQuiebre && <span title={`Quiebre ${r.dias_en_quiebre}d`} style={{ marginRight: 3 }}>*</span>}
                    {r.es_catch_up && <span title="Catch-up" style={{ marginRight: 3, color: "var(--amber)" }}>!</span>}
                    {r.sku_origen}
                  </td>
                  <td style={{ fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nombre || ""}>{r.nombre || "—"}</td>
                  <td>
                    <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: accionColor(r.accion) + "22", color: accionColor(r.accion), border: `1px solid ${accionColor(r.accion)}44` }}>
                      {r.accion}
                    </span>
                    {r.dias_en_quiebre > 0 && <div style={{ fontSize: 8, color: "var(--txt3)", marginTop: 1 }}>{r.dias_en_quiebre}d quiebre</div>}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span style={{ color: abcColor(r.abc), fontWeight: 700, fontSize: 11 }}>{r.abc}</span>
                    <span style={{ color: "var(--txt3)", fontSize: 9 }}>{r.xyz}</span>
                    {r.abc_pre_quiebre && r.abc_pre_quiebre !== r.abc && <div style={{ fontSize: 8, color: "var(--amber)" }}>pre:{r.abc_pre_quiebre}</div>}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                    {fmtN(r.vel_ponderada)}
                    {esEstrellaQuiebre && <div style={{ fontSize: 8, color: "var(--cyan)" }}>pre:{fmtN(r.vel_pre_quiebre)}</div>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <VelObjetivoCell skuOrigen={r.sku_origen} value={r.vel_objetivo || 0} onChange={guardarVelObjetivo} />
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: gapColor(r.gap_vel_pct) }}>
                    {r.gap_vel_pct != null ? (r.gap_vel_pct > 0 ? "+" : "") + fmtN(r.gap_vel_pct, 0) + "%" : "—"}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.stock_full <= 0 && r.vel_full > 0 ? "var(--red)" : "var(--txt)" }}>{fmtInt(r.stock_full)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(r.stock_bodega)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.cob_full < 14 ? "var(--red)" : r.cob_full < 30 ? "var(--amber)" : "var(--green)" }}>{r.cob_full >= 999 ? "—" : fmtN(r.cob_full, 0) + "d"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{fmtN(r.target_dias_full, 0)}d</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.mandar_full > 0 ? "var(--blue)" : "var(--txt3)" }}>{r.mandar_full > 0 ? fmtInt(r.mandar_full) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.pedir_proveedor > 0 ? "var(--amber)" : "var(--txt3)" }}>{r.pedir_proveedor > 0 ? fmtInt(r.pedir_proveedor) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_full_30d < 0 ? "var(--red)" : "var(--green)" }}>{fmtMoney(r.margen_full_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_flex_30d < 0 ? "var(--red)" : r.margen_flex_30d > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtMoney(r.margen_flex_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(r.gmroi, 1)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.dio > 90 ? "var(--red)" : r.dio > 60 ? "var(--amber)" : "var(--txt)" }}>{fmtN(r.dio, 0)}</td>
                  <td style={{ fontSize: 9, color: "var(--txt2)" }}>{cuadranteLabel(r.cuadrante)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 140 }}>
                      {(r.alertas || []).slice(0, 3).map((a: string, i: number) => (
                        <span key={i} style={{ padding: "1px 4px", borderRadius: 3, fontSize: 8, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", whiteSpace: "nowrap" }}>{a}</span>
                      ))}
                      {(r.alertas || []).length > 3 && <span style={{ fontSize: 8, color: "var(--txt3)" }}>+{r.alertas.length - 3}</span>}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay datos. Ejecuta &quot;Recalcular&quot; para generar.</div>}

      {/* ═══ 7. ML SIN VINCULAR (colapsado al pie) ═══ */}
      {mlSinVincularOpen && <AdminMLSinVincular />}

      {/* ═══ MODAL MASIVO DE VEL OBJETIVO ═══ */}
      {modalMasivo && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setModalMasivo(false)}>
          <div style={{ background: "var(--bg2)", borderRadius: 12, padding: 24, maxWidth: 480, width: "95%", border: "1px solid var(--bg4)" }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Definir velocidades objetivo</h3>

            {/* Tabs */}
            <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
              <button onClick={() => setMasivoMode("abc")} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: masivoMode === "abc" ? "var(--cyan)" : "var(--bg3)", color: masivoMode === "abc" ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
                Por ABC
              </button>
              <button onClick={() => setMasivoMode("categoria")} style={{ padding: "6px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: masivoMode === "categoria" ? "var(--cyan)" : "var(--bg3)", color: masivoMode === "categoria" ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
                Por Categoria
              </button>
            </div>

            {masivoMode === "abc" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Clasificacion ABC</label>
                  <select value={masivoAbcFilter} onChange={e => setMasivoAbcFilter(e.target.value)} className="form-input" style={{ width: "100%", fontSize: 13 }}>
                    <option value="A">A ({rows.filter(r => r.abc === "A" && r.vel_ponderada > 0).length} SKUs)</option>
                    <option value="B">B ({rows.filter(r => r.abc === "B" && r.vel_ponderada > 0).length} SKUs)</option>
                    <option value="C">C ({rows.filter(r => r.abc === "C" && r.vel_ponderada > 0).length} SKUs)</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Multiplicador sobre vel actual</label>
                  <input type="number" step="0.05" value={masivoMultiplier} onChange={e => setMasivoMultiplier(e.target.value)} className="form-input" style={{ width: "100%", fontSize: 13 }} />
                  <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 4 }}>
                    Ej: 1.1 = poner objetivo 10% arriba de la vel. actual
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--txt2)", padding: "8px 10px", background: "var(--bg3)", borderRadius: 6 }}>
                  Se aplicara a {rows.filter(r => r.abc === masivoAbcFilter && r.vel_ponderada > 0).length} SKUs con velocidad &gt; 0
                </div>
              </div>
            )}

            {masivoMode === "categoria" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Categoria</label>
                  <select value={masivoCatFilter} onChange={e => setMasivoCatFilter(e.target.value)} className="form-input" style={{ width: "100%", fontSize: 13 }}>
                    <option value="">Seleccionar...</option>
                    {categorias.map(c => <option key={c} value={c}>{c} ({rows.filter(r => r.categoria === c && r.vel_ponderada > 0).length})</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Multiplicador sobre vel actual</label>
                  <input type="number" step="0.05" value={masivoMultiplier} onChange={e => setMasivoMultiplier(e.target.value)} className="form-input" style={{ width: "100%", fontSize: 13 }} />
                </div>
                {masivoCatFilter && (
                  <div style={{ fontSize: 11, color: "var(--txt2)", padding: "8px 10px", background: "var(--bg3)", borderRadius: 6 }}>
                    Se aplicara a {rows.filter(r => r.categoria === masivoCatFilter && r.vel_ponderada > 0).length} SKUs
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
              <button onClick={() => setModalMasivo(false)} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Cancelar
              </button>
              <button
                onClick={guardarMasivo}
                disabled={masivoSaving || (masivoMode === "categoria" && !masivoCatFilter)}
                style={{ padding: "8px 20px", borderRadius: 8, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer", opacity: masivoSaving ? 0.6 : 1 }}
              >
                {masivoSaving ? "Guardando..." : "Aplicar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================
// KPI Badge compacto
// ============================================

function KpiBadge({ label, value, color, title }: { label: string; value: string; color: string; title?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 5, background: "var(--bg2)", border: "1px solid var(--bg4)" }} title={title}>
      <span style={{ fontSize: 10, color: "var(--txt3)" }}>{label}:</span>
      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

// ============================================
// CSV Export helpers
// ============================================

function exportarCSVOrigen(filtered: IntelRow[]) {
  const headers = [
    "SKU Origen","Nombre","Accion","ABC","XYZ","Cuadrante",
    "Vel/Sem","Vel 7d","Vel 30d","Vel 60d","Vel Ponderada","Vel Objetivo","Gap %",
    "%Full","%Flex","Stock Full","Stock Bodega","Stock Total",
    "En Transito","Cob Full (dias)","Cob Total (dias)","Target dias",
    "Mandar Full","Pedir Prov","Margen Full 30d","Margen Flex 30d",
    "Canal Mas Rentable","GMROI","DIO","Ingreso 30d","Precio Promedio",
    "Costo Bruto","Venta Perdida","Liquidacion","Alertas","Proveedor",
  ];
  const csvRows = [headers.join(";")];
  for (const r of filtered) {
    csvRows.push([
      r.sku_origen,
      (r.nombre || "").replace(/;/g, ","),
      r.accion, r.abc, r.xyz, r.cuadrante,
      fmtN(r.vel_ponderada, 2), fmtN(r.vel_7d, 2), fmtN(r.vel_30d, 2),
      fmtN(r.vel_60d, 2), fmtN(r.vel_ponderada, 2),
      r.vel_objetivo > 0 ? fmtN(r.vel_objetivo, 2) : "",
      r.gap_vel_pct != null ? fmtN(r.gap_vel_pct, 1) : "",
      fmtN(r.pct_full, 1), fmtN(r.pct_flex, 1),
      fmtInt(r.stock_full), fmtInt(r.stock_bodega), fmtInt(r.stock_total),
      fmtInt(r.stock_en_transito), fmtN(r.cob_full, 1), fmtN(r.cob_total, 1),
      fmtN(r.target_dias_full, 0), fmtInt(r.mandar_full), fmtInt(r.pedir_proveedor),
      Math.round(r.margen_full_30d || 0), Math.round(r.margen_flex_30d || 0),
      r.canal_mas_rentable || "", fmtN(r.gmroi, 2), fmtN(r.dio, 0),
      Math.round(r.ingreso_30d || 0), Math.round(r.precio_promedio || 0),
      Math.round(r.costo_bruto || 0), Math.round(r.venta_perdida_pesos || 0),
      r.liquidacion_accion || "", (r.alertas || []).join(", "),
      r.proveedor || "",
    ].join(";"));
  }
  descargarCSV(csvRows, "inteligencia_origen");
}

function exportarCSVVenta(filtered: VentaRow[]) {
  const headers = [
    "SKU Venta","SKU Origen","Nombre","Pack","Uds/Pack",
    "Accion","ABC","XYZ","Cuadrante",
    "Vel/Sem","Vel 7d","Vel 30d","Vel Full","Vel Flex","Vel Objetivo","Gap %",
    "%Full","%Flex","Stock Full","Stock Bodega","Stock Bod (compartido)",
    "Cob Full (dias)","Target dias","Mandar Full","Pedir Prov",
    "Margen Full 30d","Margen Flex 30d",
    "Ingreso 30d","Canal Mas Rentable","Precio Promedio",
    "GMROI","DIO","Venta Perdida","Alertas","Proveedor",
  ];
  const csvRows = [headers.join(";")];
  for (const r of filtered) {
    csvRows.push([
      r.sku_venta, r.sku_origen,
      (r.nombre || "").replace(/;/g, ","),
      r.es_pack ? "Si" : "No", r.unidades_por_pack,
      r.accion, r.abc, r.xyz, r.cuadrante,
      fmtN(r.vel_ponderada, 2), fmtN(r.vel_7d, 2), fmtN(r.vel_30d, 2),
      fmtN(r.vel_full, 2), fmtN(r.vel_flex, 2),
      r.vel_objetivo > 0 ? fmtN(r.vel_objetivo, 2) : "",
      r.gap_vel_pct != null ? fmtN(r.gap_vel_pct, 1) : "",
      fmtN(r.pct_full, 1), fmtN(r.pct_flex, 1),
      fmtInt(r.stock_full), fmtInt(r.stock_bodega),
      r.stock_bodega_compartido ? "si" : "no",
      r.cob_full >= 999 ? "" : fmtN(r.cob_full, 1),
      fmtN(r.target_dias_full, 0),
      r.mandar_full > 0 ? fmtInt(r.mandar_full) : "",
      r.pedir_proveedor > 0 ? fmtInt(r.pedir_proveedor) : "",
      Math.round(r.margen_full_30d || 0), Math.round(r.margen_flex_30d || 0),
      Math.round(r.ingreso_30d || 0), r.canal_mas_rentable || "",
      Math.round(r.precio_promedio || 0),
      fmtN(r.gmroi || 0, 2), fmtN(r.dio || 0, 0),
      Math.round(r.venta_perdida_pesos || 0),
      (r.alertas || []).join(", "), r.proveedor || "",
    ].join(";"));
  }
  descargarCSV(csvRows, "inteligencia_venta");
}

function descargarCSV(csvRows: string[], prefix: string) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${prefix}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
