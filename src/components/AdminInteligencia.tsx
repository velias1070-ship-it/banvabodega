"use client";
import { useState, useEffect, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";

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
  updated_at: string;
}

interface VentaRow {
  sku_venta: string;
  sku_origen: string;
  nombre: string | null;
  unidades_por_pack: number;
  es_pack: boolean;
  // Heredados del origen
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
  // Propios del SKU Venta
  stock_full: number;
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
}

// ============================================
// Helpers
// ============================================

const fmtN = (n: number | null | undefined, d = 1) => n == null ? "—" : Number(n).toFixed(d);
const fmtInt = (n: number | null | undefined) => n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");

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
  const [vistaOrigen, setVistaOrigen] = useState(false); // default SKU Venta

  // Filtros
  const [filtroAccion, setFiltroAccion] = useState<string>("todos");
  const [filtroABC, setFiltroABC] = useState<string>("todos");
  const [filtroCuadrante, setFiltroCuadrante] = useState<string>("todos");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");
  const [filtroAlerta, setFiltroAlerta] = useState<string>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [ordenarPor, setOrdenarPor] = useState<string>("prioridad");

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
      const res = await fetch("/api/intelligence/vista-venta");
      if (res.ok) {
        const json = await res.json();
        setVentaRows((json.rows || []) as VentaRow[]);
        if (json.rows?.length > 0 && !lastUpdate) {
          setLastUpdate(json.rows[0].updated_at);
        }
      }
    } catch { /* silenciar */ }
  }, [lastUpdate]);

  const cargar = useCallback(async () => {
    setLoading(true);
    await Promise.all([cargarOrigen(), cargarVenta()]);
    setLoading(false);
  }, [cargarOrigen, cargarVenta]);

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

  // ── Datos activos según vista ──
  const activeRows = vistaOrigen ? rows : ventaRows;

  // Proveedores únicos (desde origen siempre)
  const proveedores = Array.from(new Set(rows.map((r: IntelRow) => r.proveedor).filter(Boolean))) as string[];

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
      return skuKey.toLowerCase().includes(q) ||
        (r.nombre || "").toLowerCase().includes(q) ||
        skuOrigen.toLowerCase().includes(q);
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
        const ga = vistaOrigen ? (a as IntelRow).gmroi || 0 : 0;
        const gb = vistaOrigen ? (b as IntelRow).gmroi || 0 : 0;
        return gb - ga;
      }
      case "dio": {
        const da = vistaOrigen ? (a as IntelRow).dio || 0 : 0;
        const db = vistaOrigen ? (b as IntelRow).dio || 0 : 0;
        return db - da;
      }
      default: return 0;
    }
  });

  // Exportar CSV
  const exportarCSV = () => {
    if (vistaOrigen) {
      exportarCSVOrigen(filtered as IntelRow[]);
    } else {
      exportarCSVVenta(filtered as VentaRow[]);
    }
  };

  // KPIs (siempre desde origen)
  const totalSkus = rows.length;
  const totalVentas = ventaRows.length;
  const agotadosFull = rows.filter((r: IntelRow) => r.stock_full <= 0 && r.vel_full > 0).length;
  const urgentes = rows.filter((r: IntelRow) => r.accion === "URGENTE" || r.accion === "PEDIR").length;
  const totalAlertas = rows.reduce((a: number, r: IntelRow) => a + r.alertas_count, 0);
  const ventaPerdida = rows.reduce((a: number, r: IntelRow) => a + (r.venta_perdida_pesos || 0), 0);
  const conEvento = rows.filter((r: IntelRow) => r.evento_activo).length;
  const enTransito = rows.filter((r: IntelRow) => r.stock_en_transito > 0).length;
  const liquidacion = rows.filter((r: IntelRow) => r.liquidacion_accion).length;
  const estrellasQuiebre = rows.filter((r: IntelRow) => r.dias_en_quiebre >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A"));
  const abcA = rows.filter((r: IntelRow) => r.abc === "A").length;
  const abcB = rows.filter((r: IntelRow) => r.abc === "B").length;
  const abcC = rows.filter((r: IntelRow) => r.abc === "C").length;

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando inteligencia...</div>;

  return (
    <div style={{ padding: "0 4px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Inteligencia de Inventario</h2>
          {lastUpdate && <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>Ultima actualizacion: {new Date(lastUpdate).toLocaleString("es-CL")}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--bg4)" }}>
            <button onClick={() => setVistaOrigen(false)} style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, background: !vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: !vistaOrigen ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Venta
            </button>
            <button onClick={() => setVistaOrigen(true)} style={{ padding: "6px 14px", fontSize: 11, fontWeight: 600, background: vistaOrigen ? "var(--cyan)" : "var(--bg3)", color: vistaOrigen ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Origen
            </button>
          </div>
          <button
            onClick={recalcular}
            disabled={recalculando}
            style={{ padding: "8px 16px", borderRadius: 8, background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 600, fontSize: 12, border: "1px solid var(--cyanBd)" }}
          >
            {recalculando ? "Recalculando..." : "Recalcular Todo"}
          </button>
          <button
            onClick={exportarCSV}
            disabled={filtered.length === 0}
            style={{ padding: "8px 16px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontWeight: 600, fontSize: 12, border: "1px solid var(--greenBd)" }}
          >
            Exportar CSV
          </button>
          <button
            onClick={cargar}
            style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)" }}
          >
            Refrescar
          </button>
        </div>
      </div>
      {recalcResult && <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, marginBottom: 12, border: "1px solid var(--greenBd)" }}>{recalcResult}</div>}

      {/* KPIs */}
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--cyan)" }}>{vistaOrigen ? totalSkus : totalVentas}</div><div className="kpi-label">{vistaOrigen ? "SKUs Origen" : "SKUs Venta"}</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--red)" }}>{agotadosFull}</div><div className="kpi-label">Agotados Full</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--amber)" }}>{urgentes}</div><div className="kpi-label">Urgentes/Pedir</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--red)" }}>{totalAlertas}</div><div className="kpi-label">Alertas Totales</div></div>
        <div className="kpi"><div className="kpi-value mono" style={{ color: "var(--red)", fontSize: 14 }}>{fmtMoney(ventaPerdida)}</div><div className="kpi-label">Venta Perdida</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--blue)" }}>{enTransito}</div><div className="kpi-label">Con Stock en Transito</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--amber)" }}>{conEvento}</div><div className="kpi-label">Evento Activo</div></div>
        <div className="kpi"><div className="kpi-value" style={{ color: "var(--txt3)" }}>{liquidacion}</div><div className="kpi-label">Liquidacion</div></div>
      </div>

      {/* Estrellas en Quiebre Prolongado */}
      {estrellasQuiebre.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: 14, border: "1px solid var(--redBd)", background: "var(--redBg)" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--red)", marginBottom: 8 }}>Productos Estrella en Quiebre ({estrellasQuiebre.length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {estrellasQuiebre.map((r: IntelRow) => (
              <div key={r.sku_origen} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "6px 8px", borderRadius: 6, background: "var(--bg2)" }}>
                <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--txt)" }}>{r.sku_origen}</span>
                <span style={{ fontSize: 11, color: "var(--txt2)", flex: 1, minWidth: 120 }}>{r.nombre || ""}</span>
                <span style={{ fontSize: 10, color: "var(--amber)" }}>ABC: {r.abc_pre_quiebre || r.abc} (pre-quiebre)</span>
                <span style={{ fontSize: 10, color: "var(--txt2)" }}>Vel pre-quiebre: <span className="mono" style={{ color: "var(--cyan)" }}>{fmtN(r.vel_pre_quiebre)}/sem</span></span>
                <span style={{ fontSize: 10, color: "var(--red)" }}>Quiebre: <span className="mono">{r.dias_en_quiebre}d</span></span>
                {r.es_quiebre_proveedor && <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)" }}>Sin stock proveedor</span>}
                <span style={{ fontSize: 10, color: "var(--red)" }}>V.perdida: <span className="mono">{fmtMoney(r.venta_perdida_pesos)}</span></span>
                {r.pedir_proveedor > 0 && <span style={{ fontSize: 10, color: "var(--green)" }}>Pedir: <span className="mono">{fmtInt(r.pedir_proveedor)} uds</span></span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ABC Distribution Bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)" }}>ABC:</span>
        <div style={{ flex: 1, display: "flex", height: 20, borderRadius: 6, overflow: "hidden" }}>
          {abcA > 0 && <div style={{ width: `${(abcA / totalSkus) * 100}%`, background: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#000" }}>A ({abcA})</div>}
          {abcB > 0 && <div style={{ width: `${(abcB / totalSkus) * 100}%`, background: "var(--amber)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#000" }}>B ({abcB})</div>}
          {abcC > 0 && <div style={{ width: `${(abcC / totalSkus) * 100}%`, background: "var(--bg4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "var(--txt3)" }}>C ({abcC})</div>}
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Buscar SKU o nombre..."
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          className="form-input"
          style={{ flex: "1 1 180px", minWidth: 120, fontSize: 12, padding: "6px 10px" }}
        />
        <select value={filtroAccion} onChange={e => setFiltroAccion(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
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
        <select value={filtroABC} onChange={e => setFiltroABC(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
          <option value="todos">ABC: Todos</option>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>
        <select value={filtroCuadrante} onChange={e => setFiltroCuadrante(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
          <option value="todos">Cuadrante: Todos</option>
          <option value="ESTRELLA">Estrella</option>
          <option value="VOLUMEN">Volumen</option>
          <option value="CASHCOW">Cash Cow</option>
          <option value="REVISAR">Revisar</option>
        </select>
        <select value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
          <option value="todos">Proveedor: Todos</option>
          {proveedores.map((p: string) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filtroAlerta} onChange={e => setFiltroAlerta(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
          <option value="todos">Alerta: Todas</option>
          {alertasUnicas.map((a: string) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={ordenarPor} onChange={e => setOrdenarPor(e.target.value)} className="form-input" style={{ fontSize: 12, padding: "6px 8px" }}>
          <option value="prioridad">Ordenar: Prioridad</option>
          <option value="vel">Ordenar: Velocidad</option>
          <option value="cob">Ordenar: Cobertura (menor)</option>
          <option value="ingreso">Ordenar: Ingreso 30d</option>
          <option value="venta_perdida">Ordenar: Venta Perdida</option>
          {vistaOrigen && <option value="gmroi">Ordenar: GMROI</option>}
          {vistaOrigen && <option value="dio">Ordenar: DIO</option>}
        </select>
      </div>

      <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>
        {filtered.length} de {vistaOrigen ? totalSkus : totalVentas} {vistaOrigen ? "SKUs Origen" : "SKUs Venta"}
      </div>

      {/* Tabla SKU Venta */}
      {!vistaOrigen && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 1200 }}>
            <thead>
              <tr>
                <th>SKU Venta</th>
                <th>SKU Origen</th>
                <th>Nombre</th>
                <th>Accion</th>
                <th>ABC</th>
                <th>Cuad.</th>
                <th style={{ textAlign: "right" }}>Vel/sem</th>
                <th style={{ textAlign: "right" }}>St.Full</th>
                <th style={{ textAlign: "right" }}>St.Bod</th>
                <th style={{ textAlign: "right" }}>Cob Full</th>
                <th style={{ textAlign: "right" }}>Margen F</th>
                <th style={{ textAlign: "right" }}>Margen Fx</th>
                <th style={{ textAlign: "right" }}>Ingreso 30d</th>
                <th style={{ textAlign: "right" }}>Canal</th>
                <th>Alertas</th>
              </tr>
            </thead>
            <tbody>
              {(filtered as VentaRow[]).map((r: VentaRow) => (
                <tr key={r.sku_venta + ":" + r.sku_origen}>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                    {r.es_pack && <span title="Pack/Combo" style={{ marginRight: 3, color: "var(--amber)" }}>P</span>}
                    {r.es_catch_up && <span title="Catch-up post quiebre" style={{ marginRight: 3, color: "var(--amber)" }}>!</span>}
                    {r.sku_venta}
                    {r.unidades_por_pack > 1 && <span style={{ fontSize: 9, color: "var(--txt3)", marginLeft: 3 }}>x{r.unidades_por_pack}</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 10, color: "var(--txt3)", whiteSpace: "nowrap" }}>{r.sku_origen !== r.sku_venta ? r.sku_origen : "—"}</td>
                  <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nombre || ""}>{r.nombre || "—"}</td>
                  <td>
                    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: accionColor(r.accion) + "22", color: accionColor(r.accion), border: `1px solid ${accionColor(r.accion)}44` }}>
                      {r.accion}
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span style={{ color: abcColor(r.abc), fontWeight: 700, fontSize: 12 }}>{r.abc}</span>
                    <span style={{ color: "var(--txt3)", fontSize: 10 }}>{r.xyz}</span>
                  </td>
                  <td style={{ fontSize: 10, color: "var(--txt2)" }}>{cuadranteLabel(r.cuadrante)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(r.vel_ponderada)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.stock_full <= 0 && r.vel_full > 0 ? "var(--red)" : "var(--txt)" }}>{fmtInt(r.stock_full)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{fmtInt(r.stock_bodega)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.cob_full < 14 ? "var(--red)" : r.cob_full < 30 ? "var(--amber)" : "var(--green)" }}>{r.cob_full >= 999 ? "—" : fmtN(r.cob_full, 0) + "d"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_full_30d < 0 ? "var(--red)" : "var(--green)" }}>{fmtMoney(r.margen_full_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_flex_30d < 0 ? "var(--red)" : r.margen_flex_30d > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtMoney(r.margen_flex_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(r.ingreso_30d)}</td>
                  <td style={{ fontSize: 10, textAlign: "center", color: r.canal_mas_rentable === "Full" ? "var(--blue)" : "var(--amber)" }}>{r.canal_mas_rentable}</td>
                  <td>
                    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 160 }}>
                      {(r.alertas || []).slice(0, 3).map((a: string, i: number) => (
                        <span key={i} style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", whiteSpace: "nowrap" }}>{a}</span>
                      ))}
                      {(r.alertas || []).length > 3 && <span style={{ fontSize: 9, color: "var(--txt3)" }}>+{r.alertas.length - 3}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tabla SKU Origen */}
      {vistaOrigen && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 1200 }}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Accion</th>
                <th>ABC</th>
                <th>Cuad.</th>
                <th style={{ textAlign: "right" }}>Vel/sem</th>
                <th style={{ textAlign: "right" }}>St.Full</th>
                <th style={{ textAlign: "right" }}>St.Bod</th>
                <th style={{ textAlign: "right" }}>Transito</th>
                <th style={{ textAlign: "right" }}>Cob Full</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th style={{ textAlign: "right" }}>Mandar</th>
                <th style={{ textAlign: "right" }}>Pedir</th>
                <th style={{ textAlign: "right" }}>Margen F</th>
                <th style={{ textAlign: "right" }}>GMROI</th>
                <th style={{ textAlign: "right" }}>DIO</th>
                <th style={{ textAlign: "right" }}>V.Perdida</th>
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
                    {r.es_catch_up && <span title="Catch-up post quiebre" style={{ marginRight: 3, color: "var(--amber)" }}>!</span>}
                    {r.sku_origen}
                  </td>
                  <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nombre || ""}>{r.nombre || "—"}</td>
                  <td>
                    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: accionColor(r.accion) + "22", color: accionColor(r.accion), border: `1px solid ${accionColor(r.accion)}44` }}>
                      {r.accion}
                    </span>
                    {r.dias_en_quiebre > 0 && <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 1 }}>{r.dias_en_quiebre}d quiebre</div>}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span style={{ color: abcColor(r.abc), fontWeight: 700, fontSize: 12 }}>{r.abc}</span>
                    <span style={{ color: "var(--txt3)", fontSize: 10 }}>{r.xyz}</span>
                    {r.abc_pre_quiebre && r.abc_pre_quiebre !== r.abc && <div style={{ fontSize: 9, color: "var(--amber)" }}>pre:{r.abc_pre_quiebre}</div>}
                  </td>
                  <td style={{ fontSize: 10, color: "var(--txt2)" }}>{cuadranteLabel(r.cuadrante)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                    {fmtN(r.vel_ponderada)}
                    {esEstrellaQuiebre && <div style={{ fontSize: 9, color: "var(--cyan)" }}>pre:{fmtN(r.vel_pre_quiebre)}</div>}
                  </td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.stock_full <= 0 && r.vel_full > 0 ? "var(--red)" : "var(--txt)" }}>{fmtInt(r.stock_full)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(r.stock_bodega)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.stock_en_transito > 0 ? "var(--blue)" : "var(--txt3)" }}>{r.stock_en_transito > 0 ? fmtInt(r.stock_en_transito) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.cob_full < 14 ? "var(--red)" : r.cob_full < 30 ? "var(--amber)" : "var(--green)" }}>{fmtN(r.cob_full, 0)}d</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{fmtN(r.target_dias_full, 0)}d</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.mandar_full > 0 ? "var(--blue)" : "var(--txt3)" }}>{r.mandar_full > 0 ? fmtInt(r.mandar_full) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.pedir_proveedor > 0 ? "var(--amber)" : "var(--txt3)" }}>{r.pedir_proveedor > 0 ? fmtInt(r.pedir_proveedor) : "—"}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.margen_full_30d < 0 ? "var(--red)" : "var(--green)" }}>{fmtMoney(r.margen_full_30d)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(r.gmroi, 2)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.dio > 90 ? "var(--red)" : r.dio > 60 ? "var(--amber)" : "var(--txt)" }}>{fmtN(r.dio, 0)}</td>
                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: r.venta_perdida_pesos > 0 ? "var(--red)" : "var(--txt3)" }}>{r.venta_perdida_pesos > 0 ? fmtMoney(r.venta_perdida_pesos) : "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 2, flexWrap: "wrap", maxWidth: 160 }}>
                      {(r.alertas || []).slice(0, 3).map((a: string, i: number) => (
                        <span key={i} style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", whiteSpace: "nowrap" }}>{a}</span>
                      ))}
                      {(r.alertas || []).length > 3 && <span style={{ fontSize: 9, color: "var(--txt3)" }}>+{r.alertas.length - 3}</span>}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay datos de inteligencia. Ejecuta &quot;Recalcular Todo&quot; para generar.</div>}
    </div>
  );
}

// ============================================
// CSV Export helpers
// ============================================

function exportarCSVOrigen(filtered: IntelRow[]) {
  const headers = [
    "SKU Origen","Nombre","Accion","ABC","XYZ","Cuadrante",
    "Vel/Sem","Vel 7d","Vel 30d","Vel 60d","Vel Ponderada",
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
    "Vel/Sem","Vel 7d","Vel 30d","Vel Full","Vel Flex",
    "%Full","%Flex","Stock Full","Stock Bodega",
    "Cob Full (dias)","Margen Full 30d","Margen Flex 30d",
    "Ingreso 30d","Canal Mas Rentable","Precio Promedio",
    "Venta Perdida","Alertas","Proveedor",
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
      fmtN(r.pct_full, 1), fmtN(r.pct_flex, 1),
      fmtInt(r.stock_full), fmtInt(r.stock_bodega),
      r.cob_full >= 999 ? "" : fmtN(r.cob_full, 1),
      Math.round(r.margen_full_30d || 0), Math.round(r.margen_flex_30d || 0),
      Math.round(r.ingreso_30d || 0), r.canal_mas_rentable || "",
      Math.round(r.precio_promedio || 0),
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
