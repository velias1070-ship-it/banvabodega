"use client";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getSupabase } from "@/lib/supabase";
import { buildPickingLineasFull, crearPickingSession, skuPositions, getComponentesPorSkuVenta, getSkusVenta, getNotasOperativas, getSkuFisicoPorSkuVenta, findProduct, skuTotal } from "@/lib/store";
import { upsertNotasOperativas, insertOrdenCompra, insertOrdenCompraLineas, nextOCNumero, insertAdminActionLog } from "@/lib/db";
import type { DBOrdenCompra, DBOrdenCompraLinea } from "@/lib/db";
import { exportarOCExcel } from "@/lib/oc-export";

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
  costo_neto: number;
  costo_bruto: number;
  gmroi: number;
  dio: number;
  ingreso_30d: number;
  dias_sin_stock_full: number;
  venta_perdida_pesos: number;
  /** v43: true cuando venta_perdida_pesos se calculó con fallback precio*0.25 */
  oportunidad_perdida_es_estimacion: boolean;
  alertas: string[];
  alertas_count: number;
  evento_activo: string | null;
  multiplicador_evento: number;
  liquidacion_accion: string | null;
  liquidacion_descuento_sugerido: number;
  stock_seguridad: number;
  punto_reorden: number;
  // Fase B reposición
  lead_time_usado_dias?: number;
  lead_time_fuente?: string;
  safety_stock_simple?: number;
  safety_stock_completo?: number;
  safety_stock_fuente?: string;
  rop_calculado?: number;
  necesita_pedir?: boolean;
  pedir_proveedor_sin_rampup?: number;
  factor_rampup_aplicado?: number;
  rampup_motivo?: string;
  vel_pre_quiebre: number;
  dias_en_quiebre: number | null;
  es_quiebre_proveedor: boolean;
  abc_pre_quiebre: string | null;
  gmroi_potencial: number;
  es_catch_up: boolean;
  vel_objetivo: number;
  gap_vel_pct: number | null;
  inner_pack: number;
  /** v42: null = desconocido; 0 = agotado explícito por proveedor; >0 = disponible */
  stock_proveedor: number | null;
  tiene_stock_prov: boolean;
  // PR2/3 — forecast accuracy cacheado en sku_intelligence (ventana 8s)
  forecast_wmape_8s?: number | null;
  forecast_bias_8s?: number | null;
  forecast_tracking_signal_8s?: number | null;
  forecast_semanas_evaluadas_8s?: number | null;
  forecast_es_confiable_8s?: boolean | null;
  forecast_calculado_at?: string | null;
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
  dias_en_quiebre: number | null;
  vel_pre_quiebre: number;
  es_quiebre_proveedor: boolean;
  pedir_proveedor_sin_rampup?: number;
  factor_rampup_aplicado?: number;
  rampup_motivo?: string;
  abc_pre_quiebre: string | null;
  es_catch_up: boolean;
  venta_perdida_pesos: number;
  /** v43: true cuando venta_perdida_pesos se calculó con fallback precio*0.25 */
  oportunidad_perdida_es_estimacion: boolean;
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
    case "NUEVO": return "var(--cyan)";
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
// Tipos Envío a Full
// ============================================

interface EnvioFullItem {
  skuVenta: string;
  skuOrigen: string;
  nombre: string;
  abc: string;
  velPonderada: number;
  velObjetivo: number;
  velFull: number;
  stockFull: number;
  stockBodega: number;
  cobFull: number;
  targetDias: number;
  mandarMotor: number;      // valor crudo del motor antes del redondeo al inner_pack
  mandarSugerido: number;   // redondeado al inner_pack (lo que la UI propone)
  mandarEditado: number;    // valor final (edición manual o redondeado)
  innerPack: number;
  bultos: number;
  redondeo: "arriba" | "abajo" | "sin_cambio" | null;
  redondeoRazon: string | null;
  posicionPrincipal: string;
  posicionLabel: string;
  accion: string;
  margenFull: number;
  alertas: string[];
  notas: string[];
  tipo: "simple" | "pack" | "combo";
  componentes: { skuOrigen: string; nombreOrigen: string; unidadesPorPack: number; unidadesFisicas: number; alternativos?: string[] }[];
  selected: boolean;
  eventoActivo: string | null;
  multiplicadorEvento: number;
  stockEnTransito: number;
  velPreQuiebre: number;
  diasEnQuiebre: number | null;
  esQuiebreProveedor: boolean;
  puntoReorden: number;
  unidadesPorPack: number;
}

// ============================================
// Tipos Pedido a Proveedor
// ============================================

interface PedidoProveedorItem {
  skuOrigen: string;
  nombre: string;
  abc: string;
  velPonderada: number;
  stockFull: number;
  stockBodega: number;
  stockEnTransito: number;
  cobTotal: number;
  pedirSugerido: number;
  pedirEditado: number;
  innerPack: number;
  bultos: number;
  costoUnit: number;
  costoFuente: "catalogo" | "ultima_recepcion" | "wac_fallback" | "sin_precio";
  subtotal: number;
  stockProveedor: number;
  proveedor: string;
  alertas: string[];
  accion: string;
  pedirSinRampup: number;
  factorRampup: number;
  rampupMotivo: string;
  diasEnQuiebre: number | null;
  esQuiebreProveedor: boolean;
}

const ENVIO_ACCION_ORDEN: Record<string, number> = {
  URGENTE: 0,
  AGOTADO_PEDIR: 1,
  MANDAR_FULL: 2,
  PLANIFICAR: 3,
  EN_TRANSITO: 4,
  OK: 5,
  EXCESO: 6,
  NUEVO: 7,
  DEAD_STOCK: 8,
  INACTIVO: 9,
};

const ENVIO_ABC_ORDEN: Record<string, number> = { A: 0, B: 1, C: 2 };

// Celda editable para MANDAR cantidad
function MandarCell({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [tmp, setTmp] = useState(String(value || ""));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const save = () => {
    setEditing(false);
    let v = parseInt(tmp) || 0;
    if (v < 0) v = 0;
    if (v > max) v = max;
    if (v !== value) onChange(v);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="1"
        min="0"
        max={max}
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
      onClick={() => { setTmp(String(value)); setEditing(true); }}
      className="mono"
      style={{ cursor: "pointer", fontSize: 11, color: "var(--blue)", textAlign: "right", display: "block", fontWeight: 600 }}
      title="Click para editar"
    >
      {fmtInt(value)}
    </span>
  );
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
  const [lastSyncFull, setLastSyncFull] = useState<string | null>(null);
  const [recalculando, setRecalculando] = useState(false);
  const [recalcResult, setRecalcResult] = useState<string | null>(null);
  const [vistaOrigen, setVistaOrigen] = useState(false);
  const [vistaEnvio, setVistaEnvio] = useState(false);
  const [vistaProveedorAgotado, setVistaProveedorAgotado] = useState(false);
  const [provAgotadoSort, setProvAgotadoSort] = useState<{ col: string; asc: boolean }>({ col: "dias_hasta_quiebre", asc: true });
  // PR2/3 — tab Accuracy (forecast accuracy)
  const [vistaAccuracy, setVistaAccuracy] = useState(false);
  const [accuracyFiltroEstrella, setAccuracyFiltroEstrella] = useState(false);
  const [accuracyFiltroBias, setAccuracyFiltroBias] = useState<"todos" | "subestimamos" | "sobrestimamos">("todos");
  // PR4 Fase 1 — contador de estacionales con revisión vencida (banner en tab Accuracy)
  const [estacionalesVencidos, setEstacionalesVencidos] = useState<number>(0);
  const [envioSort, setEnvioSort] = useState<{ col: string; asc: boolean }>({ col: "accion", asc: true });
  const [envioFilter, setEnvioFilter] = useState<"todos"|"sin_ip"|"abc_a"|"abc_b"|"abc_c"|"urgente"|"stock_insuf">("todos");
  const [envioIpEdits, setEnvioIpEdits] = useState<Map<string, number>>(new Map());
  const [envioManualSearch, setEnvioManualSearch] = useState("");
  const [envioManualItems, setEnvioManualItems] = useState<{skuVenta:string;nombre:string;qty:number}[]>([]);
  const envioManualItemsRef = useRef(envioManualItems);
  useEffect(() => { envioManualItemsRef.current = envioManualItems; }, [envioManualItems]);
  const [vistaPedido, setVistaPedido] = useState(false);

  // Pedido a Proveedor
  const [pedidoEdits, setPedidoEdits] = useState<Map<string, number>>(new Map());
  const [pedidoSort, setPedidoSort] = useState<{ col: string; asc: boolean }>({ col: "accion", asc: true });
  const [pedidoFilter, setPedidoFilter] = useState<"todos"|"sin_ip"|"abc_a"|"abc_b"|"abc_c"|"urgente"|"sin_stock_prov">("todos");
  const [pedidoIpEdits, setPedidoIpEdits] = useState<Map<string, number>>(new Map());
  const [pedidoSelection, setPedidoSelection] = useState<Set<string>>(new Set());
  const [pedidoCollapsed, setPedidoCollapsed] = useState<Set<string>>(new Set());
  const [modalOC, setModalOC] = useState<{ proveedor: string; lineas: PedidoProveedorItem[] } | null>(null);
  const [creandoOC, setCreandoOC] = useState(false);
  // Catálogo proveedor: precio neto + IP por SKU (fuente preferida para OC)
  const [catalogoPorSku, setCatalogoPorSku] = useState<Map<string, { precio_neto: number; inner_pack: number }>>(new Map());
  // Última recepción por SKU: costo_unitario de la línea más reciente (recepción no anulada)
  const [ultimaRecepcionPorSku, setUltimaRecepcionPorSku] = useState<Map<string, number>>(new Map());
  const [ocCreada, setOcCreada] = useState<string | null>(null);

  // Envío a Full
  const [envioEdits, setEnvioEdits] = useState<Map<string, number>>(new Map());
  const [envioSelection, setEnvioSelection] = useState<Set<string>>(new Set());
  const [envioSelAllInit, setEnvioSelAllInit] = useState(false);
  const [creandoPicking, setCreandoPicking] = useState(false);
  const [pickingCreado, setPickingCreado] = useState<string | null>(null);
  const [envioExcluidosOpen, setEnvioExcluidosOpen] = useState(false);
  // Historial de envios a Full
  const [historialEnvios, setHistorialEnvios] = useState<Array<{
    id: string; picking_session_id: string | null; fecha: string;
    total_skus: number; total_uds_venta: number; total_uds_fisicas: number;
    total_bultos: number; evento_activo: string | null; multiplicador_evento: number;
    created_at: string;
  }>>([]);
  const [historialLineasOpen, setHistorialLineasOpen] = useState<string | null>(null);
  const [historialLineas, setHistorialLineas] = useState<Array<{
    sku_venta: string; sku_origen: string; cantidad_sugerida: number; cantidad_enviada: number;
    fue_editada: boolean; abc: string | null; vel_ponderada: number | null;
    stock_full_antes: number | null; stock_bodega_antes: number | null;
    cob_full_antes: number | null; inner_pack: number | null; alertas: string[] | null;
  }>>([]);
  const [historialOpen, setHistorialOpen] = useState(false);

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

  // Pendientes de atención
  const [pendientes, setPendientes] = useState<{ sku: string; titulo: string; tipo: string; stock_full: number; stock_bodega: number }[]>([]);
  const [pendientesResumen, setPendientesResumen] = useState<{ sin_producto_wms: number; sin_costo_con_full: number; sin_costo: number; total: number } | null>(null);
  const [pendientesOpen, setPendientesOpen] = useState(false);

  // Modal masivo
  // Modal notas operativas

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
    // Último sync stock Full
    const { data: sfData } = await sb.from("stock_full_cache")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1);
    if (sfData && sfData.length > 0) setLastSyncFull(sfData[0].updated_at);
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
  }, []);

  const cargarPendientes = useCallback(async () => {
    try {
      const res = await fetch("/api/intelligence/pendientes");
      if (res.ok) {
        const data = await res.json();
        setPendientes(data.pendientes || []);
        setPendientesResumen(data.resumen || null);
      }
    } catch { /* ignore */ }
  }, []);

  const cargarCatalogo = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from("proveedor_catalogo").select("sku_origen, precio_neto, inner_pack");
    const map = new Map<string, { precio_neto: number; inner_pack: number }>();
    for (const row of (data || []) as { sku_origen: string; precio_neto: number; inner_pack: number }[]) {
      const sku = row.sku_origen.toUpperCase();
      // En caso de duplicados (multi-proveedor) quedarse con el de mayor precio (más conservador)
      const existing = map.get(sku);
      const precio = row.precio_neto || 0;
      if (!existing || precio > existing.precio_neto) {
        map.set(sku, { precio_neto: precio, inner_pack: row.inner_pack || 1 });
      }
    }
    setCatalogoPorSku(map);
  }, []);

  // Historial de envios: carga al entrar al tab "Envio a Full"
  useEffect(() => {
    if (vistaEnvio && historialEnvios.length === 0) {
      cargarHistorialEnvios();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vistaEnvio]);

  const cargarHistorialEnvios = useCallback(async () => {
    try {
      const res = await fetch("/api/intelligence/envio-full-historial");
      if (!res.ok) return;
      const j = await res.json();
      setHistorialEnvios(j.cabeceras || []);
    } catch (err) {
      console.error("[envio-full-historial] cargar:", err);
    }
  }, []);

  const toggleLineasEnvio = useCallback(async (envioId: string) => {
    if (historialLineasOpen === envioId) {
      setHistorialLineasOpen(null);
      setHistorialLineas([]);
      return;
    }
    try {
      const res = await fetch(`/api/intelligence/envio-full-historial?id=${envioId}`);
      if (!res.ok) return;
      const j = await res.json();
      setHistorialLineas(j.lineas || []);
      setHistorialLineasOpen(envioId);
    } catch (err) {
      console.error("[envio-full-historial] detalle:", err);
    }
  }, [historialLineasOpen]);

  const cargarUltimasRecepciones = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    // Traer líneas de recepciones NO anuladas, ordenadas por created_at desc.
    // El primer hit por SKU es la última recepción.
    const { data } = await sb.from("recepcion_lineas")
      .select("sku, costo_unitario, recepciones!inner(created_at, estado)")
      .neq("recepciones.estado", "ANULADA")
      .gt("costo_unitario", 0)
      .order("created_at", { foreignTable: "recepciones", ascending: false })
      .limit(5000);
    const map = new Map<string, number>();
    for (const row of (data || []) as { sku: string; costo_unitario: number }[]) {
      const sku = (row.sku || "").toUpperCase();
      if (!sku || map.has(sku)) continue; // primera = más reciente
      map.set(sku, row.costo_unitario);
    }
    setUltimaRecepcionPorSku(map);
  }, []);

  // PR4 Fase 1 — cuenta SKUs con es_estacional=true y revisión vencida.
  // Falla silenciosa: si la columna no existe (v54 sin aplicar) queda en 0.
  const cargarEstacionalesVencidos = useCallback(async () => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      const hoy = new Date().toISOString().slice(0, 10);
      const { count } = await sb.from("sku_intelligence")
        .select("sku_origen", { count: "exact", head: true })
        .eq("es_estacional", true)
        .lt("estacional_revisar_en", hoy);
      setEstacionalesVencidos(count ?? 0);
    } catch { /* ignore — v54 puede no estar aplicada aún */ }
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    await Promise.all([cargarOrigen(), cargarVenta(), cargarMlMap(), cargarPendientes(), cargarCatalogo(), cargarUltimasRecepciones(), cargarEstacionalesVencidos()]);
    setLoading(false);
  }, [cargarOrigen, cargarVenta, cargarMlMap, cargarPendientes, cargarCatalogo, cargarUltimasRecepciones, cargarEstacionalesVencidos]);

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

  // ── Envío a Full: calcular items ──
  const envioItems = useMemo((): EnvioFullItem[] => {
    if (!vistaEnvio || ventaRows.length === 0) return [];

    const COB_MAXIMA = 60;
    const items: EnvioFullItem[] = [];

    for (const r of ventaRows) {
      if (r.mandar_full <= 0) continue;

      // Tipo y componentes
      const compsAll = getComponentesPorSkuVenta(r.sku_venta);
      const compsExpl = compsAll.filter(c => c.tipoRelacion !== "alternativo");
      const altExpl = compsAll.filter(c => c.tipoRelacion === "alternativo");

      // Auto-detect alternativas: si hay 2+ componentes con mismas unidades,
      // elegir el que tiene stock en bodega
      let comps = compsExpl;
      let alternativos = altExpl;
      if (comps.length > 1) {
        const byUnidades = new Map<number, typeof comps>();
        for (const c of comps) {
          if (!byUnidades.has(c.unidades)) byUnidades.set(c.unidades, []);
          byUnidades.get(c.unidades)!.push(c);
        }
        const deduped: typeof comps = [];
        for (const [, group] of Array.from(byUnidades.entries())) {
          if (group.length > 1) {
            // Multiple SKU origen with same unidades = alternativas
            // Pick the one with most bodega stock
            const sorted = [...group].sort((a, b) => {
              const sa = skuPositions(a.skuOrigen).reduce((s, p) => s + p.qty, 0);
              const sb = skuPositions(b.skuOrigen).reduce((s, p) => s + p.qty, 0);
              return sb - sa;
            });
            deduped.push(sorted[0]); // best stock
            for (const alt of sorted.slice(1)) {
              alternativos = [...alternativos, alt];
            }
          } else {
            deduped.push(group[0]);
          }
        }
        comps = deduped;
      }

      let tipo: "simple" | "pack" | "combo";
      if (comps.length === 0 || (comps.length === 1 && comps[0].unidades === 1)) tipo = "simple";
      else if (comps.length === 1 && comps[0].unidades > 1) tipo = "pack";
      else tipo = "combo";

      const efectivos = comps.length > 0
        ? comps.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: c.skuOrigen, unidadesPorPack: c.unidades, alternativos: alternativos.filter(a => a.unidades === c.unidades).map(a => a.skuOrigen) }))
        : [{ skuOrigen: r.sku_origen || r.sku_venta, nombreOrigen: r.nombre || r.sku_venta, unidadesPorPack: 1, alternativos: alternativos.map(a => a.skuOrigen) }];

      // mandar_full ya considera stock disponible en bodega — no descontar tránsito
      // (tránsito es OC al proveedor que llega a bodega, no envíos a Full)
      const mandarBase = r.mandar_full;
      if (mandarBase <= 0) continue;

      // Inner pack del componente principal
      const compPrincipal = efectivos[0];
      const innerPack = r.unidades_por_pack > 1 ? r.unidades_por_pack : 1;
      // We use inner_pack from sku_intelligence if available via the row's data
      // The inner_pack from the intelligence row is on the origin SKU
      const ipFromRows = rows.find(o => o.sku_origen === compPrincipal.skuOrigen);
      const ip = ipFromRows?.inner_pack || 1;

      // Posición principal
      const posiciones = skuPositions(compPrincipal.skuOrigen);
      const bestPos = posiciones.length > 0 ? posiciones[0] : null;

      // Redondeo inteligente
      let mandarRedondeado = mandarBase;
      let redondeo: "arriba" | "abajo" | "sin_cambio" | null = null;
      let redondeoRazon: string | null = null;
      const udsFisicas = mandarBase * compPrincipal.unidadesPorPack;
      // punto_reorden from IntelRow (origin)
      const intelOrigen = rows.find(o => o.sku_origen === (compPrincipal.skuOrigen || "").toUpperCase() || o.sku_origen === compPrincipal.skuOrigen);
      const puntoReorden = intelOrigen?.punto_reorden || 14;
      const multiplicadorEvento = intelOrigen?.multiplicador_evento || 1;

      if (ip > 1 && udsFisicas % ip !== 0) {
        const opAbajoFis = Math.floor(udsFisicas / ip) * ip;
        const opArribaFis = Math.ceil(udsFisicas / ip) * ip;
        const opAbajo = compPrincipal.unidadesPorPack > 0 ? Math.floor(opAbajoFis / compPrincipal.unidadesPorPack) : opAbajoFis;
        const opArriba = compPrincipal.unidadesPorPack > 0 ? Math.ceil(opArribaFis / compPrincipal.unidadesPorPack) : opArribaFis;

        const cobAbajo = r.vel_full > 0 ? ((r.stock_full + opAbajo) / r.vel_full) * 7 : 999;
        const cobArriba = r.vel_full > 0 ? ((r.stock_full + opArriba) / r.vel_full) * 7 : 999;

        const stockBod = bestPos ? posiciones.reduce((s, p) => s + p.qty, 0) : r.stock_bodega;
        const arribaFis = opArriba * compPrincipal.unidadesPorPack;

        if (opAbajo === 0 && mandarBase > 0 && arribaFis <= stockBod) {
          redondeo = "arriba"; mandarRedondeado = opArriba;
          redondeoRazon = `Abajo=0 uds. Enviar bulto completo (${opArriba} uds). Cob: ${Math.round(cobArriba)}d`;
        } else if (arribaFis > stockBod) {
          redondeo = "abajo"; mandarRedondeado = opAbajo;
          redondeoRazon = `Stock insuficiente para bulto completo. Enviar ${opAbajo} uds`;
        } else if (cobArriba > COB_MAXIMA && opAbajo > 0) {
          redondeo = "abajo"; mandarRedondeado = opAbajo;
          redondeoRazon = `${opArriba} uds superaria ${COB_MAXIMA}d max. Enviar ${opAbajo} uds (${Math.round(cobAbajo)}d)`;
        } else if (cobAbajo < puntoReorden || opAbajo === 0) {
          redondeo = "arriba"; mandarRedondeado = opArriba;
          redondeoRazon = opAbajo === 0
            ? `Abajo=0. Enviar bulto completo (${opArriba} uds)`
            : `${opAbajo} uds deja ${Math.round(cobAbajo)}d (bajo min ${puntoReorden}d). ${opArriba} uds = ${Math.round(cobArriba)}d`;
        } else if ((cobArriba - cobAbajo) < 7) {
          redondeo = "abajo"; mandarRedondeado = opAbajo;
          redondeoRazon = `${opAbajo} uds = ${Math.round(cobAbajo)}d (suficiente)`;
        } else {
          redondeo = "arriba"; mandarRedondeado = opArriba;
          redondeoRazon = `${opAbajo} uds = ${Math.round(cobAbajo)}d. ${opArriba} uds = ${Math.round(cobArriba)}d (mejor)`;
        }
      }

      // Apply any admin edit
      const editedQty = envioEdits.get(r.sku_venta);
      const mandarFinal = editedQty !== undefined ? editedQty : mandarRedondeado;
      if (mandarFinal <= 0 && editedQty === undefined) continue; // skip if rounded to 0

      // Componentes finales
      const componentesFinal = efectivos.map(c => ({
        skuOrigen: c.skuOrigen,
        nombreOrigen: c.nombreOrigen,
        unidadesPorPack: c.unidadesPorPack,
        unidadesFisicas: mandarFinal * c.unidadesPorPack,
        alternativos: c.alternativos,
      }));

      const bultos = ip > 1 ? Math.ceil((mandarFinal * compPrincipal.unidadesPorPack) / ip) : mandarFinal;

      // Notas contextuales
      const notas: string[] = [];
      if (r.stock_bodega < mandarFinal) notas.push(`Stock insuficiente — max ${r.stock_bodega} uds`);
      if (r.margen_full_30d < 0) notas.push("Margen negativo en Full");
      if (r.es_quiebre_proveedor) notas.push("Proveedor sin stock");
      if (r.stock_en_transito > 0) notas.push(`OC en transito: ${r.stock_en_transito} uds`);
      if (r.evento_activo) notas.push(`Target ajustado por ${r.evento_activo}`);
      if (r.vel_pre_quiebre > 0 && (r.dias_en_quiebre ?? 0) > 14) notas.push("Producto estrella en quiebre");

      items.push({
        skuVenta: r.sku_venta,
        skuOrigen: compPrincipal.skuOrigen,
        nombre: r.nombre || r.sku_venta,
        abc: r.abc,
        velPonderada: r.vel_ponderada,
        velObjetivo: r.vel_objetivo || 0,
        velFull: r.vel_full,
        stockFull: r.stock_full,
        stockBodega: r.stock_bodega,
        cobFull: r.cob_full,
        targetDias: r.target_dias_full,
        mandarMotor: mandarBase,
        mandarSugerido: mandarRedondeado,
        mandarEditado: mandarFinal,
        innerPack: ip,
        bultos,
        redondeo,
        redondeoRazon,
        posicionPrincipal: bestPos?.pos || "?",
        posicionLabel: bestPos?.label || "Sin pos.",
        accion: r.accion,
        margenFull: r.margen_full_30d,
        alertas: r.alertas || [],
        notas,
        tipo,
        componentes: componentesFinal,
        selected: true,
        eventoActivo: r.evento_activo,
        multiplicadorEvento: multiplicadorEvento,
        stockEnTransito: r.stock_en_transito,
        velPreQuiebre: r.vel_pre_quiebre,
        diasEnQuiebre: r.dias_en_quiebre,
        esQuiebreProveedor: r.es_quiebre_proveedor,
        puntoReorden: puntoReorden,
        unidadesPorPack: compPrincipal.unidadesPorPack,
      });
    }

    // Stock compartido detection
    const porOrigen = new Map<string, { skuVenta: string; uds: number; cobFull: number }[]>();
    for (const item of items) {
      for (const c of item.componentes) {
        const arr = porOrigen.get(c.skuOrigen) || [];
        arr.push({ skuVenta: item.skuVenta, uds: c.unidadesFisicas, cobFull: item.cobFull });
        porOrigen.set(c.skuOrigen, arr);
      }
    }
    for (const [skuOr, envios] of Array.from(porOrigen.entries())) {
      if (envios.length < 2) continue;
      const totalFis = envios.reduce((s, e) => s + e.uds, 0);
      const stockBod = skuPositions(skuOr).reduce((s, p) => s + p.qty, 0);
      if (totalFis > stockBod) {
        for (const e of envios) {
          const item = items.find(i => i.skuVenta === e.skuVenta);
          if (item) item.notas.push(`Stock bodega compartido: ${stockBod} uds entre ${envios.length} formatos`);
        }
      }
    }

    // Sort: ABC A + URGENTE first (lowest cob), then A + MANDAR_FULL, B + URGENTE, etc.
    items.sort((a, b) => {
      const abcA = ENVIO_ABC_ORDEN[a.abc] ?? 9;
      const abcB = ENVIO_ABC_ORDEN[b.abc] ?? 9;
      if (abcA !== abcB) return abcA - abcB;
      const accA = ENVIO_ACCION_ORDEN[a.accion] ?? 9;
      const accB = ENVIO_ACCION_ORDEN[b.accion] ?? 9;
      if (accA !== accB) return accA - accB;
      return a.cobFull - b.cobFull;
    });

    return items;
  }, [vistaEnvio, ventaRows, rows, envioEdits]);

  // SKUs excluidos del envío por reglas automáticas.
  // Replica los filtros de envioItems para capturar los rechazados y mostrar por qué.
  // Casos cubiertos:
  //   - "no_alcanza_bulto": mandar_full>0 pero stock bodega < bulto mínimo del proveedor
  //   - "motor_descarto":   mandar_full=0 pese a stock_full=0 + vel_full>0 + bodega>0
  //                         (típicamente rampup 0 por quiebre >120d, discontinuación)
  const envioExcluidos = useMemo(() => {
    if (!vistaEnvio || ventaRows.length === 0) return [] as Array<{
      skuVenta: string; skuOrigen: string; nombre: string; abc: string;
      stockBodega: number; stockFull: number; velPonderada: number; velFull: number;
      cobFull: number; mandarMotor: number; innerPack: number;
      bultoMinimo: number; falta: number; diasEnQuiebre: number | null;
      motivo: "no_alcanza_bulto" | "motor_descarto"; motivoLabel: string;
      accion: string; proveedor: string | null;
    }>;

    const excluidos: Array<{
      skuVenta: string; skuOrigen: string; nombre: string; abc: string;
      stockBodega: number; stockFull: number; velPonderada: number; velFull: number;
      cobFull: number; mandarMotor: number; innerPack: number;
      bultoMinimo: number; falta: number; diasEnQuiebre: number | null;
      motivo: "no_alcanza_bulto" | "motor_descarto"; motivoLabel: string;
      accion: string; proveedor: string | null;
    }> = [];

    for (const r of ventaRows) {
      const skuOrigenUp = (r.sku_origen || r.sku_venta || "").toUpperCase();
      const intelOrigen = rows.find(o => o.sku_origen === skuOrigenUp || o.sku_origen === r.sku_origen);
      const ip = intelOrigen?.inner_pack || 1;
      const upp = r.unidades_por_pack > 1 ? r.unidades_por_pack : 1;

      // Caso A: el motor ya puso mandar_full = 0 pese a tener bodega + demanda.
      // Se filtra en la línea "if (r.mandar_full <= 0) continue;".
      if (r.mandar_full <= 0) {
        if (r.stock_bodega > 0 && r.stock_full === 0 && r.vel_full > 0) {
          excluidos.push({
            skuVenta: r.sku_venta,
            skuOrigen: skuOrigenUp,
            nombre: r.nombre || r.sku_venta,
            abc: r.abc,
            stockBodega: r.stock_bodega,
            stockFull: r.stock_full,
            velPonderada: r.vel_ponderada,
            velFull: r.vel_full,
            cobFull: r.cob_full,
            mandarMotor: 0,
            innerPack: ip,
            bultoMinimo: 0,
            falta: 0,
            diasEnQuiebre: r.dias_en_quiebre,
            motivo: "motor_descarto",
            motivoLabel: (r.dias_en_quiebre ?? 0) > 120 && !r.es_quiebre_proveedor
              ? `Quiebre prolongado ${r.dias_en_quiebre}d — candidato a discontinuar`
              : "Motor no lo propone (revisar velocidad/alertas)",
            accion: r.accion,
            proveedor: r.proveedor,
          });
        }
        continue;
      }

      // Caso B: redondeo al inner_pack lo baja a 0 porque bulto mínimo > stock bodega.
      // Replica la lógica del bloque de redondeo (líneas ~767-800).
      const udsFisicas = r.mandar_full * upp;
      if (ip > 1 && udsFisicas % ip !== 0) {
        const opArribaFis = Math.ceil(udsFisicas / ip) * ip;
        const opAbajoFis  = Math.floor(udsFisicas / ip) * ip;
        if (opArribaFis > r.stock_bodega && opAbajoFis === 0) {
          excluidos.push({
            skuVenta: r.sku_venta,
            skuOrigen: skuOrigenUp,
            nombre: r.nombre || r.sku_venta,
            abc: r.abc,
            stockBodega: r.stock_bodega,
            stockFull: r.stock_full,
            velPonderada: r.vel_ponderada,
            velFull: r.vel_full,
            cobFull: r.cob_full,
            mandarMotor: r.mandar_full,
            innerPack: ip,
            bultoMinimo: opArribaFis,
            falta: opArribaFis - r.stock_bodega,
            diasEnQuiebre: r.dias_en_quiebre,
            motivo: "no_alcanza_bulto",
            motivoLabel: `Stock ${r.stock_bodega} < bulto ${opArribaFis} (falta ${opArribaFis - r.stock_bodega})`,
            accion: r.accion,
            proveedor: r.proveedor,
          });
        }
      }
    }

    // Ordenar: ABC A primero, luego por cob_full (lo más urgente arriba)
    excluidos.sort((a, b) => {
      const abcA = ENVIO_ABC_ORDEN[a.abc] ?? 9;
      const abcB = ENVIO_ABC_ORDEN[b.abc] ?? 9;
      if (abcA !== abcB) return abcA - abcB;
      return a.cobFull - b.cobFull;
    });

    return excluidos;
  }, [vistaEnvio, ventaRows, rows]);

  // Initialize selection when envioItems changes
  useEffect(() => {
    if (envioItems.length > 0 && !envioSelAllInit) {
      setEnvioSelection(new Set(envioItems.map(i => i.skuVenta)));
      setEnvioSelAllInit(true);
    }
  }, [envioItems, envioSelAllInit]);

  // Reset envioSelAllInit when leaving envio view
  useEffect(() => {
    if (!vistaEnvio) setEnvioSelAllInit(false);
  }, [vistaEnvio]);

  // ── Ventana de Acción — Proveedor Agotado: items con la alerta nueva ──
  // Captura SKUs donde stock_proveedor=0 explícito pero todavía hay cola en Full.
  // Es la señal temprana: tengo runway vendible pero no puedo reponer cuando se acabe.
  const proveedorAgotadoItems = useMemo(() => {
    if (!vistaProveedorAgotado || rows.length === 0) return [];
    const items = rows
      .filter(r => (r.alertas || []).includes("proveedor_agotado_con_cola_full"))
      .map(r => {
        // dias_hasta_quiebre = cuánto runway me queda con la velocidad actual.
        // vel_ponderada está en uds/semana → /7 = uds/día.
        const velDiaria = r.vel_ponderada > 0 ? r.vel_ponderada / 7 : 0;
        const diasHastaQuiebre = velDiaria > 0 ? Math.floor(r.stock_full / velDiaria) : 999;
        return {
          sku_origen: r.sku_origen,
          nombre: r.nombre || "",
          abc: r.abc,
          vel_ponderada: r.vel_ponderada,
          stock_full: r.stock_full,
          stock_bodega: r.stock_bodega,
          ingreso_30d: r.ingreso_30d,
          dias_hasta_quiebre: diasHastaQuiebre,
          cob_full: r.cob_full,
          evento_activo: r.evento_activo,
          severidad: (diasHastaQuiebre <= 14 ? "alta" : "media") as "alta" | "media",
        };
      });
    items.sort((a, b) => {
      const { col, asc } = provAgotadoSort;
      let va: number | string = 0, vb: number | string = 0;
      if (col === "sku") { va = a.sku_origen; vb = b.sku_origen; }
      else if (col === "nombre") { va = a.nombre; vb = b.nombre; }
      else if (col === "abc") { va = a.abc; vb = b.abc; }
      else if (col === "vel") { va = a.vel_ponderada; vb = b.vel_ponderada; }
      else if (col === "stock_full") { va = a.stock_full; vb = b.stock_full; }
      else if (col === "ingreso") { va = a.ingreso_30d; vb = b.ingreso_30d; }
      else { va = a.dias_hasta_quiebre; vb = b.dias_hasta_quiebre; }
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return asc ? cmp : -cmp;
    });
    return items;
  }, [vistaProveedorAgotado, rows, provAgotadoSort]);

  // ── Pedido a Proveedor: compute items from rows ──
  const pedidoItems = useMemo((): PedidoProveedorItem[] => {
    if (!vistaPedido || rows.length === 0) return [];
    return rows
      .filter(r => r.pedir_proveedor > 0)
      .map(r => {
        const ip = pedidoIpEdits.get(r.sku_origen) || r.inner_pack || 1;
        // Redondear al IP (misma lógica que envío a full)
        const pedirBase = r.pedir_proveedor;
        const pedirRedondeado = ip > 1 ? Math.ceil(pedirBase / ip) * ip : pedirBase;
        const edited = pedidoEdits.get(r.sku_origen);
        const pedir = edited !== undefined ? edited : pedirRedondeado;
        // Precio para OC: cascada por confiabilidad respecto al precio que el
        // proveedor va a cobrar al facturar:
        //   1. proveedor_catalogo.precio_neto (lista vigente publicada)
        //   2. Última recepción no anulada (precio efectivo más reciente)
        //   3. WAC histórico (productos.costo_promedio = costo_neto)
        //   4. $0 + 'sin_precio' → bloquear emisión hasta cargar precio
        // Nota: costo_neto, precio_neto y costo_unitario ya están en NETO sin IVA.
        const cat = catalogoPorSku.get(r.sku_origen.toUpperCase());
        const ultRec = ultimaRecepcionPorSku.get(r.sku_origen.toUpperCase());
        const wacNeto = r.costo_neto > 0 ? Math.round(r.costo_neto) : 0;
        let costo = 0;
        let costoFuente: "catalogo" | "ultima_recepcion" | "wac_fallback" | "sin_precio" = "sin_precio";
        if (cat && cat.precio_neto > 0) {
          costo = cat.precio_neto;
          costoFuente = "catalogo";
        } else if (ultRec && ultRec > 0) {
          costo = Math.round(ultRec);
          costoFuente = "ultima_recepcion";
        } else if (wacNeto > 0) {
          costo = wacNeto;
          costoFuente = "wac_fallback";
        }
        return {
          skuOrigen: r.sku_origen,
          nombre: r.nombre || "",
          abc: r.abc || "C",
          velPonderada: r.vel_ponderada,
          stockFull: r.stock_full,
          stockBodega: r.stock_bodega,
          stockEnTransito: r.stock_en_transito,
          cobTotal: r.cob_total,
          pedirSugerido: pedirRedondeado,
          pedirEditado: pedir,
          innerPack: ip,
          bultos: ip > 1 ? Math.ceil(pedir / ip) : pedir,
          costoUnit: costo,
          costoFuente,
          subtotal: pedir * costo,
          stockProveedor: r.stock_proveedor ?? -1,
          proveedor: r.proveedor || "Sin proveedor",
          alertas: r.alertas || [],
          accion: r.accion,
          pedirSinRampup: r.pedir_proveedor_sin_rampup ?? r.pedir_proveedor,
          factorRampup: r.factor_rampup_aplicado ?? 1.0,
          rampupMotivo: r.rampup_motivo ?? "no_aplica",
          diasEnQuiebre: r.dias_en_quiebre,
          esQuiebreProveedor: r.es_quiebre_proveedor,
        };
      })
      .sort((a, b) => a.proveedor.localeCompare(b.proveedor) || b.velPonderada - a.velPonderada);
  }, [vistaPedido, rows, pedidoEdits, pedidoIpEdits, catalogoPorSku, ultimaRecepcionPorSku]);

  // Grouped by proveedor
  const pedidoPorProveedor = useMemo(() => {
    const map = new Map<string, PedidoProveedorItem[]>();
    for (const item of pedidoItems) {
      const arr = map.get(item.proveedor) || [];
      arr.push(item);
      map.set(item.proveedor, arr);
    }
    return map;
  }, [pedidoItems]);

  // Initialize pedido selection
  useEffect(() => {
    if (vistaPedido && pedidoItems.length > 0 && pedidoSelection.size === 0) {
      const sel = new Set<string>();
      for (const item of pedidoItems) {
        if (item.stockProveedor !== 0) sel.add(item.skuOrigen);
      }
      setPedidoSelection(sel);
    }
  }, [vistaPedido, pedidoItems, pedidoSelection.size]);

  // Pedido KPIs
  const pedidoKpis = useMemo(() => {
    const selected = pedidoItems.filter(i => pedidoSelection.has(i.skuOrigen));
    return {
      skus: selected.length,
      totalUds: selected.reduce((s, i) => s + i.pedirEditado, 0),
      proveedores: new Set(selected.map(i => i.proveedor)).size,
      montoEstimado: selected.reduce((s, i) => s + i.subtotal, 0),
    };
  }, [pedidoItems, pedidoSelection]);

  // Envío selected items
  const envioSelected = useMemo(() => envioItems.filter(i => envioSelection.has(i.skuVenta)), [envioItems, envioSelection]);

  // Envío summary
  const envioSummary = useMemo(() => {
    const sel = envioSelected;
    const totalUdsVenta = sel.reduce((s, i) => s + i.mandarEditado, 0);
    const totalUdsFisicas = sel.reduce((s, i) => s + i.componentes.reduce((c, comp) => c + comp.unidadesFisicas, 0), 0);
    const totalBultos = sel.reduce((s, i) => s + i.bultos, 0);
    const urgentes = sel.filter(i => i.accion === "URGENTE").length;
    const insuficientes = sel.filter(i => i.stockBodega < i.mandarEditado).length;
    const margenNeg = sel.filter(i => i.margenFull < 0).length;
    return { totalUdsVenta, totalUdsFisicas, totalBultos, urgentes, insuficientes, margenNeg };
  }, [envioSelected]);

  // Crear picking from envío
  const crearPickingEnvioFull = useCallback(async () => {
    const manualesActuales = envioManualItemsRef.current;
    if (envioSelected.length === 0 && manualesActuales.length === 0) return;
    if (creandoPicking) return;
    setCreandoPicking(true);
    setPickingCreado(null);

    try {
      const source = envioSelected.map(i => ({
        skuVenta: i.skuVenta,
        nombre: i.nombre,
        mandarFull: i.mandarEditado,
        tipo: i.tipo,
        componentes: i.componentes,
      }));

      // Add manual items — siempre leer del ref, nunca del closure capturado.
      // Bug histórico: el callback tenía deps incompletas y se quedaba con la
      // lista vacía del primer render, ignorando los productos agregados a mano.
      for (const manual of manualesActuales) {
        const comps = getComponentesPorSkuVenta(manual.skuVenta).filter(c => c.tipoRelacion !== "alternativo");
        source.push({
          skuVenta: manual.skuVenta,
          nombre: manual.nombre,
          mandarFull: manual.qty,
          tipo: comps.length === 1 && comps[0].unidades === 1 ? "simple" : comps.length === 1 && comps[0].unidades > 1 ? "pack" : "simple",
          componentes: comps.length > 0
            ? comps.map(c => ({ skuOrigen: c.skuOrigen, nombreOrigen: c.skuOrigen, unidadesPorPack: c.unidades, unidadesFisicas: manual.qty * c.unidades, alternativos: [] }))
            : [{ skuOrigen: manual.skuVenta, nombreOrigen: manual.nombre, unidadesPorPack: 1, unidadesFisicas: manual.qty, alternativos: [] }],
        });
      }

      const { lineas, errors } = buildPickingLineasFull(source);

      if (errors.length > 0) {
        const continuar = window.confirm(`Advertencias:\n${errors.join("\n")}\n\nCrear picking de todos modos?`);
        if (!continuar) { setCreandoPicking(false); return; }
      }

      const fecha = new Date().toISOString().slice(0, 10);
      const titulo = `Envio a Full — ${fecha}`;
      const id = await crearPickingSession(fecha, lineas, "envio_full", titulo);

      if (id) {
        setPickingCreado(id);

        // Reconciliar reservas + forzar sync ML de los SKUs del envío
        try {
          const { reconciliarReservas, enqueueAndSync } = await import("@/lib/db");
          await reconciliarReservas();
          const skusEnvio = lineas.map(l => l.componentes[0]?.skuOrigen).filter(Boolean);
          if (skusEnvio.length > 0) enqueueAndSync(skusEnvio);
        } catch { /* no bloquear */ }

        // Log historial
        const skusEditados = envioSelected.filter(i => envioEdits.has(i.skuVenta)).map(i => i.skuVenta);
        try {
          await fetch("/api/intelligence/envio-full-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pickingSessionId: id,
              totals: {
                skus: envioSelected.length,
                udsVenta: envioSummary.totalUdsVenta,
                udsFisicas: envioSummary.totalUdsFisicas,
                bultos: envioSummary.totalBultos,
                eventoActivo: envioSelected.find(i => i.eventoActivo)?.eventoActivo || null,
                multiplicadorEvento: envioSelected.find(i => i.multiplicadorEvento > 1)?.multiplicadorEvento || 1,
              },
              lineas: envioSelected.map(i => ({
                skuVenta: i.skuVenta,
                skuOrigen: i.skuOrigen,
                cantidadSugerida: i.mandarSugerido,
                cantidadEnviada: i.mandarEditado,
                fueEditada: envioEdits.has(i.skuVenta),
                abc: i.abc,
                velPonderada: i.velPonderada,
                velObjetivo: i.velObjetivo,
                stockFullAntes: i.stockFull,
                stockBodegaAntes: i.stockBodega,
                cobFullAntes: i.cobFull,
                targetDias: i.targetDias,
                margenFull: i.margenFull,
                innerPack: i.innerPack,
                redondeo: i.redondeo,
                alertas: i.alertas,
                nota: i.notas.join("; "),
              })),
              skusEditados,
            }),
          });
        } catch { /* no bloquear */ }
      } else {
        alert("Error al crear la sesion de picking.");
      }
    } catch (err) {
      console.error("crearPickingEnvioFull error:", err);
      alert("Error inesperado al crear picking.");
    } finally {
      setCreandoPicking(false);
    }
  }, [envioSelected, creandoPicking, envioEdits, envioSummary, envioManualItems]);

  // Log envio edit to admin_actions_log
  const logEnvioEdit = useCallback(async (skuVenta: string, cantidadSistema: number, cantidadAdmin: number, abc: string, cobFull: number) => {
    try {
      const sb = getSupabase();
      if (!sb) return;
      await sb.from("admin_actions_log").insert({
        accion: "editar_envio_full",
        entidad: "inteligencia",
        entidad_id: skuVenta,
        detalle: { skuVenta, cantidadSistema, cantidadAdmin, abc, cobFullAntes: cobFull },
      });
    } catch { /* silenciar */ }
  }, []);

  // ── Crear OC desde modal ──
  const crearOCDesdeModal = useCallback(async (estado: "BORRADOR" | "PENDIENTE") => {
    if (!modalOC || creandoOC) return;
    setCreandoOC(true);
    try {
      const { proveedor, lineas } = modalOC;
      const totalNeto = lineas.reduce((s, l) => s + l.subtotal, 0);
      const totalBruto = Math.round(totalNeto * 1.19);
      const totalUds = lineas.reduce((s, l) => s + l.pedirEditado, 0);
      const numero = await nextOCNumero();
      const fechaEmision = new Date().toISOString().slice(0, 10);
      const ahoraIso = new Date().toISOString();
      // Si la OC se crea como PENDIENTE, congelamos precio_acordado_neto al momento.
      // En BORRADOR queda nulo y se congela cuando alguien aprete "Confirmar" en AdminCompras.
      const congelarPrecio = estado === "PENDIENTE";

      const ocId = await insertOrdenCompra({
        numero,
        proveedor,
        fecha_emision: fechaEmision,
        estado,
        total_neto: totalNeto,
        total_bruto: totalBruto,
        notas: `Creada desde Inteligencia — ${lineas.length} SKUs`,
      });

      if (!ocId) { alert("Error al crear OC"); return; }

      // Insertar líneas con snapshot + (opcional) precio acordado congelado
      const ocLineas: Omit<DBOrdenCompraLinea, "id" | "created_at">[] = lineas.map(l => {
        const row = rows.find(r => r.sku_origen === l.skuOrigen);
        return {
          orden_id: ocId,
          sku_origen: l.skuOrigen,
          nombre: l.nombre,
          cantidad_pedida: l.pedirEditado,
          costo_unitario: l.costoUnit,
          inner_pack: l.innerPack,
          bultos: l.bultos,
          abc: l.abc,
          vel_ponderada: l.velPonderada,
          cob_total_al_pedir: row?.cob_total ?? null,
          stock_full_al_pedir: l.stockFull,
          stock_bodega_al_pedir: l.stockBodega,
          accion_al_pedir: l.accion,
          // Fase 1 lite: si se confirma directo, congelar precio acordado (snapshot inmutable)
          precio_acordado_neto: congelarPrecio ? l.costoUnit : null,
          precio_acordado_at: congelarPrecio ? ahoraIso : null,
          precio_fuente: l.costoFuente,
          cantidad_facturada: 0,
          estado_linea: "pendiente",
        };
      });
      await insertOrdenCompraLineas(ocLineas);

      // Log admin
      await insertAdminActionLog("crear_oc", "ordenes_compra", ocId, {
        oc_id: ocId, numero, proveedor, lineas: lineas.length,
        total_neto: totalNeto, total_uds: totalUds, fuente: "inteligencia",
        precio_congelado: congelarPrecio,
      });

      // Si PENDIENTE, descargar Excel formateado (mismo helper que AdminCompras)
      if (congelarPrecio) {
        const ocSnapshot: DBOrdenCompra = {
          numero,
          proveedor,
          fecha_emision: fechaEmision,
          estado,
          total_neto: totalNeto,
          total_bruto: totalBruto,
          notas: `Creada desde Inteligencia — ${lineas.length} SKUs`,
        };
        // Mapear líneas al shape de DBOrdenCompraLinea para el helper
        const lineasParaExcel: DBOrdenCompraLinea[] = ocLineas.map(l => ({
          ...l,
          orden_id: ocId,
        }));
        try {
          exportarOCExcel(ocSnapshot, lineasParaExcel);
        } catch (e) {
          console.warn("[OC] Error al exportar Excel:", e);
        }
      }

      setOcCreada(
        congelarPrecio
          ? `${numero} — ${proveedor} (PENDIENTE) · Precio congelado · Excel descargado. También disponible en /admin → Compras`
          : `${numero} — ${proveedor} (BORRADOR) · Confirmar desde /admin → Compras para congelar precios`
      );
      setModalOC(null);

      // Disparar recálculo
      try { await fetch("/api/intelligence/recalcular", { method: "POST" }); } catch { /* silenciar */ }
    } catch (err) {
      console.error("crearOCDesdeModal error:", err);
      alert("Error al crear OC");
    } finally {
      setCreandoOC(false);
    }
  }, [modalOC, creandoOC, rows]);

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
  const ventaPerdidaEstimada = rows.reduce((a: number, r: IntelRow) => a + (r.oportunidad_perdida_es_estimacion ? (r.venta_perdida_pesos || 0) : 0), 0);
  const ventaPerdidaPctEstimada = ventaPerdida > 0 ? Math.round((ventaPerdidaEstimada / ventaPerdida) * 100) : 0;
  const abcA = rows.filter((r: IntelRow) => r.abc === "A").length;
  const abcB = rows.filter((r: IntelRow) => r.abc === "B").length;
  const abcC = rows.filter((r: IntelRow) => r.abc === "C").length;

  // Evento activo
  const eventoActivo = rows.find((r: IntelRow) => r.evento_activo);

  // Estrellas en quiebre
  const estrellasQuiebre = rows.filter((r: IntelRow) => (r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A"));

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando inteligencia...</div>;

  return (
    <div style={{ padding: "0 4px" }}>
      {/* ═══ 1. HEADER + KPIs compactos ═══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Inteligencia</h2>
          {lastUpdate && <span style={{ fontSize: 10, color: "var(--txt3)" }}>Intel: {new Date(lastUpdate).toLocaleString("es-CL")}</span>}
          {lastSyncFull && <span style={{ fontSize: 10, color: "var(--txt3)" }}> | Stock Full: {(() => { const m = Math.round((Date.now() - new Date(lastSyncFull).getTime()) / 60000); return m < 1 ? "ahora" : m < 60 ? `hace ${m}min` : `hace ${Math.round(m / 60)}h`; })()}</span>}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--bg4)" }}>
            <button onClick={() => { setVistaOrigen(false); setVistaEnvio(false); setVistaPedido(false); setVistaProveedorAgotado(false); setVistaAccuracy(false); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: !vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy ? "var(--cyan)" : "var(--bg3)", color: !vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Venta
            </button>
            <button onClick={() => { setVistaOrigen(true); setVistaEnvio(false); setVistaPedido(false); setVistaProveedorAgotado(false); setVistaAccuracy(false); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy ? "var(--cyan)" : "var(--bg3)", color: vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              SKU Origen
            </button>
            <button onClick={() => { setVistaEnvio(true); setVistaOrigen(false); setVistaPedido(false); setVistaProveedorAgotado(false); setVistaAccuracy(false); setPickingCreado(null); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaEnvio ? "var(--blue)" : "var(--bg3)", color: vistaEnvio ? "#fff" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              Envio a Full
            </button>
            <button onClick={() => { setVistaPedido(true); setVistaEnvio(false); setVistaOrigen(false); setVistaProveedorAgotado(false); setVistaAccuracy(false); setOcCreada(null); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaPedido ? "var(--amber)" : "var(--bg3)", color: vistaPedido ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              Pedido a Proveedor
            </button>
            <button onClick={() => { setVistaProveedorAgotado(true); setVistaEnvio(false); setVistaOrigen(false); setVistaPedido(false); setVistaAccuracy(false); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaProveedorAgotado ? "var(--red)" : "var(--bg3)", color: vistaProveedorAgotado ? "#fff" : "var(--txt3)", border: "none", cursor: "pointer" }}>
              Ventana Proveedor
            </button>
            <button onClick={() => { setVistaAccuracy(true); setVistaOrigen(false); setVistaEnvio(false); setVistaPedido(false); setVistaProveedorAgotado(false); }} style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, background: vistaAccuracy ? "var(--cyan)" : "var(--bg3)", color: vistaAccuracy ? "#000" : "var(--txt3)", border: "none", cursor: "pointer" }} title="Forecast accuracy — mide el error de vel_ponderada">
              📊 Accuracy
            </button>
          </div>
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

      {recalcResult &&<div style={{ padding: "6px 10px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontSize: 11, marginBottom: 6, border: "1px solid var(--greenBd)" }}>{recalcResult}</div>}

      {/* KPIs en una línea compacta */}
      <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap", fontSize: 11 }}>
        <KpiBadge label="SKUs" value={String(vistaOrigen ? totalSkus : totalVentas)} color="var(--cyan)" />
        <KpiBadge label="Agotados" value={String(agotadosFull)} color="var(--red)" />
        <KpiBadge label="Urgentes" value={String(urgentes)} color="var(--amber)" />
        <KpiBadge
          label="V.Perdida"
          value={fmtK(ventaPerdida) + (ventaPerdidaPctEstimada > 0 ? ` (${ventaPerdidaPctEstimada}%est)` : "")}
          color="var(--red)"
          title={ventaPerdidaPctEstimada > 0 ? `${fmtK(ventaPerdidaEstimada)} viene de estimación con margen 25% (textiles BANVA típicamente menor). Filtrar oportunidad_perdida_es_estimacion=false para descartar.` : "Todos los valores derivados de margen real"}
        />
      </div>

      {/* ═══ 2. BANNER EVENTO ACTIVO ═══ */}
      {eventoActivo && (
        <div style={{ padding: "6px 12px", borderRadius: 6, background: "var(--amberBg)", color: "var(--amber)", fontSize: 11, marginBottom: 8, border: "1px solid var(--amberBd)", fontWeight: 600 }}>
          Preparacion {eventoActivo.evento_activo} (x{eventoActivo.multiplicador_evento}) — Targets ajustados
        </div>
      )}

      {/* ═══ 2b. PENDIENTES DE ATENCION ═══ */}
      {pendientesResumen && pendientesResumen.total > 0 && (
        <div style={{ marginBottom: 8, borderRadius: 8, border: "1px solid var(--amberBd)", background: "var(--amberBg)", overflow: "hidden" }}>
          <button onClick={() => setPendientesOpen(!pendientesOpen)} style={{ width: "100%", padding: "8px 12px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, fontWeight: 600, color: "var(--amber)" }}>
              <span>Pendientes de atencion ({pendientesResumen.total})</span>
              {pendientesResumen.sin_producto_wms > 0 && <span style={{ padding: "2px 6px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", fontSize: 10 }}>Sin producto WMS: {pendientesResumen.sin_producto_wms}</span>}
              {pendientesResumen.sin_costo_con_full > 0 && <span style={{ padding: "2px 6px", borderRadius: 4, background: "var(--amberBg)", color: "var(--amber)", fontSize: 10, border: "1px solid var(--amberBd)" }}>Sin costo c/Full: {pendientesResumen.sin_costo_con_full}</span>}
              {pendientesResumen.sin_costo > 0 && <span style={{ padding: "2px 6px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", fontSize: 10 }}>Sin costo: {pendientesResumen.sin_costo}</span>}
            </div>
            <span style={{ color: "var(--txt3)", fontSize: 10 }}>{pendientesOpen ? "▲" : "▼"}</span>
          </button>
          {pendientesOpen && (
            <div style={{ padding: "0 12px 10px", maxHeight: 300, overflowY: "auto" }}>
              <table className="tbl" style={{ width: "100%", fontSize: 10 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>SKU</th>
                    <th style={{ textAlign: "left" }}>Nombre</th>
                    <th style={{ textAlign: "left" }}>Problema</th>
                    <th style={{ textAlign: "right" }}>St. Full</th>
                    <th style={{ textAlign: "right" }}>St. Bodega</th>
                  </tr>
                </thead>
                <tbody>
                  {pendientes.map((p, i) => (
                    <tr key={i}>
                      <td className="mono">{p.sku}</td>
                      <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.titulo}</td>
                      <td>
                        {p.tipo === "sin_producto_wms" && <span style={{ color: "var(--red)", fontWeight: 600 }}>Sin producto en WMS</span>}
                        {p.tipo === "sin_costo_con_full" && <span style={{ color: "var(--amber)", fontWeight: 600 }}>Sin costo (con stock Full)</span>}
                        {p.tipo === "sin_costo" && <span style={{ color: "var(--txt2)" }}>Sin costo (con stock bodega)</span>}
                      </td>
                      <td className="mono" style={{ textAlign: "right", color: p.stock_full > 0 ? "var(--cyan)" : "var(--txt3)" }}>{p.stock_full}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{p.stock_bodega}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                <span
                  style={{ color: "var(--red)" }}
                  title={r.dias_en_quiebre === null ? "Historia de quiebre incompleta, revisar manualmente" : undefined}
                >
                  {r.dias_en_quiebre !== null ? `${r.dias_en_quiebre}d` : "—"}
                </span>
                <span style={{ color: "var(--red)" }} title={r.oportunidad_perdida_es_estimacion ? "Estimación: margen 25% asumido (sin datos reales en últimos 60 días)" : "Derivado de margen real"}>
                  {fmtMoney(r.venta_perdida_pesos)}{r.oportunidad_perdida_es_estimacion && <span style={{ color: "var(--amber)", marginLeft: 2, fontSize: 9 }}>*est</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 3.5. CHIPS DE RED DE SEGURIDAD: SKUs sin costo, stale, sin LT, bajo MOQ ═══ */}
      {!vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && (() => {
        const sinCosto = activeRows.filter((r: AnyRow) => (r.alertas || []).includes("sin_costo"));
        const costoStale = activeRows.filter((r: AnyRow) => (r.alertas || []).includes("costo_posiblemente_obsoleto"));
        const sinLt = activeRows.filter((r: AnyRow) => "lead_time_fuente" in r && r.lead_time_fuente === "fallback_default" && (r.vel_ponderada || 0) > 0);
        const bajoMoq = activeRows.filter((r: AnyRow) => (r.alertas || []).includes("pedido_bajo_moq"));
        const necesitaPedir = activeRows.filter((r: AnyRow) => "necesita_pedir" in r && r.necesita_pedir);
        // v60 — chip Flex >14d (los casos urgentes con historia de venta)
        const flexProlongado = activeRows.filter((r: AnyRow) => (r.alertas || []).includes("quiebre_flex_prolongado"));
        if (sinCosto.length + costoStale.length + sinLt.length + bajoMoq.length + necesitaPedir.length + flexProlongado.length === 0) return null;
        const chip = (label: string, count: number, alertaKey: string, color: string, title: string) => (
          <button
            key={label}
            onClick={() => setFiltroAlerta(filtroAlerta === alertaKey ? "todos" : alertaKey)}
            title={title}
            style={{
              padding: "5px 12px", borderRadius: 6,
              background: filtroAlerta === alertaKey ? color : color + "22",
              color: filtroAlerta === alertaKey ? "#fff" : color,
              border: `1px solid ${color}`, fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}
          >
            {label}: {count}
          </button>
        );
        return (
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            {necesitaPedir.length > 0 && chip("📦 Pedir ya", necesitaPedir.length, "necesita_pedir", "var(--cyan)", "SKUs cuyo stock total ≤ ROP. Pedir ahora.")}
            {flexProlongado.length > 0 && chip("🔴 Flex >14d", flexProlongado.length, "quiebre_flex_prolongado", "var(--red)", "SKU con vel_flex histórica > 2 u/sem lleva ≥14 días sin publicar Flex.")}
            {sinCosto.length > 0 && chip("⚠ Sin costo", sinCosto.length, "sin_costo", "var(--red)", "SKUs activos sin costo cargado.")}
            {costoStale.length > 0 && chip("⚠ Costo >90d", costoStale.length, "costo_posiblemente_obsoleto", "var(--amber)", "Costo manual sin actualizar en >90 días.")}
            {bajoMoq.length > 0 && chip("⚠ < MOQ", bajoMoq.length, "pedido_bajo_moq", "var(--amber)", "Sugerencia de pedido < mínimo del proveedor.")}
            {sinLt.length > 0 && chip("⚠ LT no medido", sinLt.length, "todos", "var(--amber)", "SKUs cuyo lead time es default 5d. Asignar proveedor o medir desde OCs.")}
          </div>
        );
      })()}

      {/* ═══ 4. FILTROS ═══ */}
      {!vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
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
          <option value="NUEVO">NUEVO</option>
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
      </div>}

      {!vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 6 }}>
        {filtered.length} de {vistaOrigen ? totalSkus : totalVentas} {vistaOrigen ? "SKUs Origen" : "SKUs Venta"}
      </div>}

      {/* ═══ 5. TABLA SKU VENTA ═══ */}
      {!vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && (
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
      {vistaOrigen && !vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && (
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
                const esEstrellaQuiebre = (r.dias_en_quiebre ?? 0) >= 14 && r.vel_pre_quiebre > 2 && (r.abc === "A" || r.abc_pre_quiebre === "A");
                return (
                <tr key={r.sku_origen} style={esEstrellaQuiebre ? { background: "var(--redBg)" } : undefined}>
                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                    {esEstrellaQuiebre && <span title={`Quiebre ${r.dias_en_quiebre ?? "?"}d`} style={{ marginRight: 3 }}>*</span>}
                    {r.es_catch_up && <span title="Catch-up" style={{ marginRight: 3, color: "var(--amber)" }}>!</span>}
                    {r.sku_origen}
                  </td>
                  <td style={{ fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nombre || ""}>{r.nombre || "—"}</td>
                  <td>
                    <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: accionColor(r.accion) + "22", color: accionColor(r.accion), border: `1px solid ${accionColor(r.accion)}44` }}>
                      {r.accion}
                    </span>
                    {(r.dias_en_quiebre ?? 0) > 0 && <div style={{ fontSize: 8, color: "var(--txt3)", marginTop: 1 }}>{r.dias_en_quiebre}d quiebre</div>}
                    {r.dias_en_quiebre === null && <div style={{ fontSize: 8, color: "var(--amber)", marginTop: 1 }} title="Historia de quiebre incompleta">quiebre s/d</div>}
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

      {/* ═══ 5c. VISTA ENVÍO A FULL ═══ */}
      {vistaEnvio && (
        <div>
          {/* KPIs envío */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap", fontSize: 11 }}>
            <KpiBadge label="SKUs a enviar" value={String(envioSelected.length)} color="var(--blue)" />
            <KpiBadge label="Total uds" value={fmtInt(envioSummary.totalUdsVenta)} color="var(--cyan)" />
            <KpiBadge label="Urgentes" value={String(envioSummary.urgentes)} color="var(--red)" />
            <KpiBadge label="Bultos" value={String(envioSummary.totalBultos)} color="var(--txt)" />
          </div>

          {pickingCreado && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, marginBottom: 8, border: "1px solid var(--greenBd)", fontWeight: 600 }}>
              Picking creado: {pickingCreado}
            </div>
          )}

          {envioItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay SKUs con mandar_full &gt; 0. Ejecuta &quot;Recalcular&quot;.</div>
          ) : (() => {
            // Filter
            const filteredEnvio = envioItems.filter(item => {
              if (envioFilter === "sin_ip") return !item.innerPack || item.innerPack <= 1;
              if (envioFilter === "abc_a") return item.abc === "A";
              if (envioFilter === "abc_b") return item.abc === "B";
              if (envioFilter === "abc_c") return item.abc === "C";
              if (envioFilter === "urgente") return item.accion === "URGENTE" || item.accion === "AGOTADO_PEDIR";
              if (envioFilter === "stock_insuf") return item.stockBodega < item.mandarEditado;
              return true;
            });
            // Sort
            const sortedEnvio = [...filteredEnvio].sort((a, b) => {
              const { col, asc } = envioSort;
              let va: number | string = 0, vb: number | string = 0;
              if (col === "sku") { va = a.skuVenta; vb = b.skuVenta; }
              else if (col === "nombre") { va = a.nombre; vb = b.nombre; }
              else if (col === "abc") { va = a.abc; vb = b.abc; }
              else if (col === "vel") { va = a.velPonderada; vb = b.velPonderada; }
              else if (col === "stFull") { va = a.stockFull; vb = b.stockFull; }
              else if (col === "stBod") { va = a.stockBodega; vb = b.stockBodega; }
              else if (col === "cob") { va = a.cobFull; vb = b.cobFull; }
              else if (col === "target") { va = a.targetDias; vb = b.targetDias; }
              else if (col === "motor") { va = a.mandarMotor; vb = b.mandarMotor; }
              else if (col === "mandar") { va = a.mandarEditado; vb = b.mandarEditado; }
              else if (col === "ip") { va = a.innerPack; vb = b.innerPack; }
              else if (col === "bultos") { va = a.bultos; vb = b.bultos; }
              else if (col === "accion") { va = a.accion; vb = b.accion; }
              const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
              return asc ? cmp : -cmp;
            });
            const toggleSort = (col: string) => setEnvioSort(prev => ({ col, asc: prev.col === col ? !prev.asc : true }));
            const SH = ({ col, label, right }: { col: string; label: string; right?: boolean }) => (
              <th onClick={() => toggleSort(col)} style={{ cursor: "pointer", textAlign: right ? "right" : "left", userSelect: "none" }}>
                {label} {envioSort.col === col ? (envioSort.asc ? "▲" : "▼") : ""}
              </th>
            );
            return <>
              {/* Filters */}
              <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                {([["todos","Todos"],["sin_ip","Sin IP"],["abc_a","ABC A"],["abc_b","ABC B"],["abc_c","ABC C"],["urgente","Urgentes"],["stock_insuf","Stock insuf."]] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setEnvioFilter(key)}
                    style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: `1px solid ${envioFilter === key ? "var(--cyan)" : "var(--bg4)"}`,
                      background: envioFilter === key ? "var(--cyan)" : "var(--bg3)", color: envioFilter === key ? "#000" : "var(--txt3)", cursor: "pointer" }}>
                    {label} ({envioItems.filter(i => {
                      if (key === "sin_ip") return !i.innerPack || i.innerPack <= 1;
                      if (key === "abc_a") return i.abc === "A";
                      if (key === "abc_b") return i.abc === "B";
                      if (key === "abc_c") return i.abc === "C";
                      if (key === "urgente") return i.accion === "URGENTE" || i.accion === "AGOTADO_PEDIR";
                      if (key === "stock_insuf") return i.stockBodega < i.mandarEditado;
                      return true;
                    }).length})
                  </button>
                ))}
              </div>

              <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 6 }}>
                {envioSelected.length} de {envioItems.length} seleccionados · Mostrando {sortedEnvio.length}
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ minWidth: 1400 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <input
                          type="checkbox"
                          checked={envioSelection.size === envioItems.length}
                          onChange={e => {
                            if (e.target.checked) setEnvioSelection(new Set(envioItems.map(i => i.skuVenta)));
                            else setEnvioSelection(new Set());
                          }}
                        />
                      </th>
                      <SH col="sku" label="SKU Venta" />
                      <SH col="nombre" label="Nombre" />
                      <SH col="abc" label="ABC" />
                      <SH col="vel" label="Vel/sem" right />
                      <SH col="stFull" label="St.Full" right />
                      <SH col="stBod" label="St.Bod" right />
                      <SH col="cob" label="Cob Full" right />
                      <SH col="target" label="Target" right />
                      <SH col="motor" label="Motor" right />
                      <SH col="mandar" label="Mandar" right />
                      <SH col="ip" label="IP" right />
                      <SH col="bultos" label="Bultos" right />
                      <th>Pos.</th>
                      <SH col="accion" label="Estado" />
                      <th>Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEnvio.map(item => {
                      const sel = envioSelection.has(item.skuVenta);
                      return (
                        <tr key={item.skuVenta} style={{ opacity: sel ? 1 : 0.4 }}>
                          <td>
                            <input
                              type="checkbox"
                              checked={sel}
                              onChange={e => {
                                const next = new Set(envioSelection);
                                if (e.target.checked) next.add(item.skuVenta);
                                else next.delete(item.skuVenta);
                                setEnvioSelection(next);
                              }}
                            />
                          </td>
                          <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                            {item.tipo !== "simple" && <span title={item.tipo} style={{ marginRight: 3, color: "var(--amber)", fontSize: 9 }}>{item.tipo === "pack" ? "P" : "C"}</span>}
                            {item.skuVenta}
                            {item.unidadesPorPack > 1 && <span style={{ fontSize: 9, color: "var(--txt3)", marginLeft: 3 }}>x{item.unidadesPorPack}</span>}
                          </td>
                          <td style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.nombre}>{item.nombre}</td>
                          <td style={{ textAlign: "center" }}>
                            <span style={{ color: abcColor(item.abc), fontWeight: 700, fontSize: 11 }}>{item.abc}</span>
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(item.velPonderada)}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.stockFull <= 0 ? "var(--red)" : "var(--txt)" }}>{fmtInt(item.stockFull)}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.stockBodega < item.mandarEditado ? "var(--red)" : "var(--txt3)" }}>{fmtInt(item.stockBodega)}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.cobFull < 14 ? "var(--red)" : item.cobFull < 30 ? "var(--amber)" : "var(--green)" }}>
                            {item.cobFull >= 999 ? "—" : fmtN(item.cobFull, 0) + "d"}
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>
                            {fmtN(item.targetDias, 0)}d
                            {item.multiplicadorEvento > 1 && <span style={{ color: "var(--amber)", fontSize: 9, marginLeft: 2 }} title={`Evento: ${item.eventoActivo}`}>E</span>}
                          </td>
                          <td
                            className="mono"
                            style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}
                            title="Sugerencia cruda del motor antes de redondear al inner_pack"
                          >
                            {fmtInt(item.mandarMotor)}
                            {item.mandarMotor !== item.mandarSugerido && (
                              <span style={{ fontSize: 9, marginLeft: 2, color: item.mandarSugerido > item.mandarMotor ? "var(--amber)" : "var(--green)" }}
                                    title={item.redondeoRazon || ""}>
                                →{item.mandarSugerido}
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <MandarCell
                              value={item.mandarEditado}
                              max={item.stockBodega}
                              onChange={v => {
                                setEnvioEdits(prev => new Map(prev).set(item.skuVenta, v));
                                logEnvioEdit(item.skuVenta, item.mandarSugerido, v, item.abc, item.cobFull);
                              }}
                            />
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <input type="number" value={envioIpEdits.get(item.skuVenta) ?? (item.innerPack > 1 ? item.innerPack : "")}
                              onChange={e => setEnvioIpEdits(prev => new Map(prev).set(item.skuVenta, parseInt(e.target.value) || 0))}
                              onBlur={async () => {
                                const v = envioIpEdits.get(item.skuVenta);
                                const skuOrig = item.skuOrigen || item.skuVenta;
                                if (v !== undefined && v > 0) {
                                  const sb = getSupabase();
                                  if (sb) {
                                    // NO tocar updated_at — se reserva para handleProveedor()
                                    // del flujo de import Excel. Editar inner_pack localmente
                                    // no debería contaminar el indicador de frescura de Idetex.
                                    await sb.from("proveedor_catalogo").update({ inner_pack: v }).eq("sku_origen", skuOrig);
                                    await sb.from("productos").update({ inner_pack: v }).eq("sku", skuOrig);
                                  }
                                }
                              }}
                              placeholder="—"
                              style={{ width: 40, textAlign: "center", fontSize: 10, padding: "2px 4px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontFamily: "var(--font-mono)" }} />
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                            {item.bultos}
                            {item.redondeo && item.redondeo !== "sin_cambio" && (
                              <span
                                style={{ fontSize: 9, marginLeft: 2, color: item.redondeo === "arriba" ? "var(--amber)" : "var(--green)" }}
                                title={item.redondeoRazon || ""}
                              >
                                {item.redondeo === "arriba" ? "▲" : "▼"}
                              </span>
                            )}
                          </td>
                          <td className="mono" style={{ fontSize: 10, color: "var(--txt3)", whiteSpace: "nowrap" }} title={item.posicionPrincipal}>{item.posicionLabel}</td>
                          <td>
                            <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: accionColor(item.accion) + "22", color: accionColor(item.accion), border: `1px solid ${accionColor(item.accion)}44` }}>
                              {item.accion}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 200 }}>
                              {item.notas.map((n, i) => (
                                <span key={i} style={{ fontSize: 9, color: n.includes("insuficiente") || n.includes("Margen negativo") ? "var(--red)" : n.includes("transito") ? "var(--blue)" : "var(--txt3)" }}>
                                  {n}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* SKUs excluidos por reglas */}
              {envioExcluidos.length > 0 && (
                <div style={{ marginTop: 12, borderRadius: 8, background: "var(--bg2)", border: "1px solid var(--amberBd)" }}>
                  <button
                    onClick={() => setEnvioExcluidosOpen(v => !v)}
                    style={{ width: "100%", padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer",
                      display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--amber)", fontSize: 12, fontWeight: 700 }}
                  >
                    <span>{envioExcluidosOpen ? "▾" : "▸"} SKUs excluidos por reglas automáticas ({envioExcluidos.length})</span>
                    <span style={{ fontSize: 10, fontWeight: 500, color: "var(--txt3)" }}>
                      {envioExcluidos.filter(e => e.motivo === "no_alcanza_bulto").length} stock &lt; bulto ·{" "}
                      {envioExcluidos.filter(e => e.motivo === "motor_descarto").length} motor descartó
                    </span>
                  </button>
                  {envioExcluidosOpen && (
                    <div style={{ padding: "8px 14px 14px", borderTop: "1px solid var(--bg4)" }}>
                      <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 8 }}>
                        Estos SKUs no aparecen en el listado principal porque el sistema los filtró. Si querés incluirlos, usá el botón <b>Forzar</b> para agregarlos con el stock disponible (editable después en la tabla de arriba).
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table className="tbl" style={{ minWidth: 1000, fontSize: 11 }}>
                          <thead>
                            <tr>
                              <th>SKU Venta</th>
                              <th>Nombre</th>
                              <th>ABC</th>
                              <th style={{ textAlign: "right" }}>St.Bod</th>
                              <th style={{ textAlign: "right" }}>St.Full</th>
                              <th style={{ textAlign: "right" }}>Vel/sem</th>
                              <th style={{ textAlign: "right" }}>Cob Full</th>
                              <th style={{ textAlign: "right" }}>IP</th>
                              <th style={{ textAlign: "right" }}>Motor dijo</th>
                              <th>Motivo</th>
                              <th>Acción</th>
                            </tr>
                          </thead>
                          <tbody>
                            {envioExcluidos.map(ex => (
                              <tr key={ex.skuVenta} style={{ background: ex.motivo === "motor_descarto" ? "var(--redBg)" : "var(--amberBg)" }}>
                                <td className="mono" style={{ fontSize: 10 }}>{ex.skuVenta}</td>
                                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ex.nombre}</td>
                                <td><span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: abcColor(ex.abc) + "22", color: abcColor(ex.abc) }}>{ex.abc}</span></td>
                                <td className="mono" style={{ textAlign: "right" }}>{ex.stockBodega}</td>
                                <td className="mono" style={{ textAlign: "right", color: ex.stockFull === 0 ? "var(--red)" : "var(--txt2)" }}>{ex.stockFull}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{fmtN(ex.velPonderada, 1)}</td>
                                <td className="mono" style={{ textAlign: "right", color: ex.cobFull < 14 ? "var(--red)" : "var(--txt2)" }}>{ex.cobFull >= 999 ? "—" : Math.round(ex.cobFull) + "d"}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{ex.innerPack > 1 ? ex.innerPack : "—"}</td>
                                <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{ex.mandarMotor}</td>
                                <td style={{ fontSize: 10, color: "var(--txt2)" }}>{ex.motivoLabel}</td>
                                <td>
                                  <button
                                    onClick={() => {
                                      const qty = ex.motivo === "no_alcanza_bulto"
                                        ? Math.max(1, Math.floor(ex.stockBodega / (ex.innerPack > 1 && ex.stockBodega >= ex.innerPack ? ex.innerPack : 1)) * (ex.innerPack > 1 && ex.stockBodega >= ex.innerPack ? ex.innerPack : 1) || ex.stockBodega)
                                        : ex.stockBodega;
                                      setEnvioEdits(prev => {
                                        const next = new Map(prev);
                                        next.set(ex.skuVenta, qty);
                                        return next;
                                      });
                                      setEnvioSelection(prev => new Set(prev).add(ex.skuVenta));
                                    }}
                                    style={{ padding: "3px 10px", borderRadius: 4, background: "var(--blue)", color: "#fff", fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer" }}
                                  >
                                    Forzar
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Resumen al pie */}
              <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, background: "var(--bg2)", border: "1px solid var(--bg4)", fontSize: 11 }}>
                <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--txt)" }}>Resumen de envio</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", color: "var(--txt2)" }}>
                  <span>SKUs seleccionados: <b style={{ color: "var(--txt)" }}>{envioSelected.length}</b> de {envioItems.length}</span>
                  <span>Uds venta: <b style={{ color: "var(--cyan)" }}>{fmtInt(envioSummary.totalUdsVenta)}</b></span>
                  <span>Uds fisicas: <b style={{ color: "var(--cyan)" }}>{fmtInt(envioSummary.totalUdsFisicas)}</b></span>
                  <span>Bultos: <b style={{ color: "var(--txt)" }}>{envioSummary.totalBultos}</b></span>
                  {envioSummary.insuficientes > 0 && <span style={{ color: "var(--red)" }}>Stock insuficiente: {envioSummary.insuficientes}</span>}
                  {envioSummary.margenNeg > 0 && <span style={{ color: "var(--red)" }}>Margen negativo: {envioSummary.margenNeg}</span>}
                </div>
              </div>

              {/* Agregar productos manualmente */}
              <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 8, background: "var(--bg2)", border: "1px solid var(--bg4)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Agregar productos manualmente</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <input className="form-input" placeholder="Buscar SKU o nombre..." value={envioManualSearch}
                    onChange={e => setEnvioManualSearch(e.target.value)}
                    style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} />
                </div>
                {envioManualSearch.length >= 2 && (() => {
                  const results = findProduct(envioManualSearch).slice(0, 8);
                  const yaEnLista = new Set([...envioItems.map(i => i.skuVenta), ...envioManualItems.map(i => i.skuVenta)]);
                  return results.length > 0 ? (
                    <div style={{ marginBottom: 8, maxHeight: 200, overflow: "auto" }}>
                      {results.map(p => (
                        <div key={p.sku} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", marginBottom: 3, borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", fontSize: 11 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                            <span className="mono" style={{ color: "var(--txt3)", fontSize: 10 }}>{p.sku} · Bodega: {skuTotal(p.sku)}</span>
                          </div>
                          {yaEnLista.has(p.sku) ? (
                            <span style={{ fontSize: 10, color: "var(--txt3)", padding: "2px 8px" }}>Ya incluido</span>
                          ) : (
                            <button onClick={() => { setEnvioManualItems(prev => [...prev, { skuVenta: p.sku, nombre: p.name, qty: 1 }]); setEnvioManualSearch(""); }}
                              style={{ padding: "4px 10px", borderRadius: 4, background: "var(--blue)", color: "#fff", fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer" }}>
                              + Agregar
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 8 }}>Sin resultados</div>;
                })()}
                {envioManualItems.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "var(--txt2)", marginBottom: 4 }}>Productos agregados ({envioManualItems.length}):</div>
                    {envioManualItems.map((item, i) => (
                      <div key={item.skuVenta} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", marginBottom: 3, borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--blueBd,var(--bg4))" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.nombre}</div>
                          <span className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{item.skuVenta}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <button onClick={() => setEnvioManualItems(prev => prev.map((it, j) => j === i ? { ...it, qty: Math.max(1, it.qty - 1) } : it))}
                            style={{ width: 22, height: 22, borderRadius: 4, background: "var(--bg2)", color: "var(--txt2)", fontSize: 12, fontWeight: 700, border: "1px solid var(--bg4)", cursor: "pointer" }}>-</button>
                          <input type="number" value={item.qty} onChange={e => setEnvioManualItems(prev => prev.map((it, j) => j === i ? { ...it, qty: Math.max(1, parseInt(e.target.value) || 1) } : it))}
                            style={{ width: 40, textAlign: "center", fontSize: 11, padding: "2px", borderRadius: 4, background: "var(--bg2)", color: "var(--txt)", border: "1px solid var(--bg4)", fontFamily: "var(--font-mono)" }} />
                          <button onClick={() => setEnvioManualItems(prev => prev.map((it, j) => j === i ? { ...it, qty: it.qty + 1 } : it))}
                            style={{ width: 22, height: 22, borderRadius: 4, background: "var(--bg2)", color: "var(--txt2)", fontSize: 12, fontWeight: 700, border: "1px solid var(--bg4)", cursor: "pointer" }}>+</button>
                        </div>
                        <button onClick={() => setEnvioManualItems(prev => prev.filter((_, j) => j !== i))}
                          style={{ width: 22, height: 22, borderRadius: 4, background: "var(--redBg)", color: "var(--red)", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer" }}>x</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Botón Crear Picking + Exportar CSV */}
              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={crearPickingEnvioFull}
                  disabled={creandoPicking || (envioSelected.length === 0 && envioManualItems.length === 0) || !!pickingCreado}
                  style={{
                    padding: "12px 24px", borderRadius: 8, fontWeight: 700, fontSize: 14,
                    background: pickingCreado ? "var(--greenBg)" : "var(--blue)",
                    color: pickingCreado ? "var(--green)" : "#fff",
                    border: pickingCreado ? "1px solid var(--greenBd)" : "none",
                    cursor: creandoPicking || !!pickingCreado ? "default" : "pointer",
                    opacity: creandoPicking ? 0.6 : 1,
                  }}
                >
                  {creandoPicking ? "Creando..." : pickingCreado ? "Picking creado" : `Crear Picking Envio a Full (${envioSelected.length} SKUs, ${fmtInt(envioSummary.totalUdsVenta)} uds)`}
                </button>
                <button
                  onClick={() => {
                    const items = envioItems.filter(i => i.selected && i.mandarEditado > 0);
                    if (items.length === 0) return;
                    const headers = "SKU Venta;SKU Origen;Nombre;Mandar;Inner Pack;Bultos;Stock Bodega;Stock Full;Cob Full (dias)";
                    const csvRows = items.map(i =>
                      [i.skuVenta, i.skuOrigen, (i.nombre || "").replace(/;/g, ","), i.mandarEditado, i.innerPack > 1 ? i.innerPack : "", i.bultos, i.stockBodega, i.stockFull, i.cobFull].join(";")
                    );
                    const csv = "\uFEFF" + headers + "\n" + csvRows.join("\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `envio_full_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  disabled={envioSelected.length === 0}
                  style={{
                    padding: "12px 16px", borderRadius: 8, fontWeight: 600, fontSize: 12,
                    background: "var(--bg3)", color: envioSelected.length > 0 ? "var(--cyan)" : "var(--txt3)",
                    border: "1px solid var(--bg4)", cursor: envioSelected.length > 0 ? "pointer" : "default",
                  }}
                >
                  Exportar CSV Picking ({envioSelected.length})
                </button>
                <button
                  onClick={() => {
                    const items = envioItems.filter(i => i.selected && i.mandarEditado > 0);
                    if (items.length === 0) return;
                    const headers = "SKU;Nombre;Cantidad";
                    const csvRows = items.map(i =>
                      [i.skuVenta, (i.nombre || "").replace(/;/g, ","), i.mandarEditado].join(";")
                    );
                    const csv = "\uFEFF" + headers + "\n" + csvRows.join("\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `envio_full_meli_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  disabled={envioSelected.length === 0}
                  style={{
                    padding: "12px 16px", borderRadius: 8, fontWeight: 600, fontSize: 12,
                    background: "var(--bg3)", color: envioSelected.length > 0 ? "var(--green)" : "var(--txt3)",
                    border: "1px solid var(--bg4)", cursor: envioSelected.length > 0 ? "pointer" : "default",
                  }}
                >
                  Exportar para ML ({envioSelected.length})
                </button>
              </div>
            </>
          })()}

          {/* ═══ HISTORIAL DE ENVIOS A FULL ═══ */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--bg4)" }}>
            <button
              onClick={() => { setHistorialOpen(!historialOpen); if (!historialOpen) cargarHistorialEnvios(); }}
              style={{
                background: "transparent", border: "none", color: "var(--txt2)",
                fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "4px 0",
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <span style={{ fontSize: 10 }}>{historialOpen ? "▼" : "▶"}</span>
              📜 Historial de envíos ({historialEnvios.length})
            </button>
            {historialOpen && (
              <div style={{ marginTop: 12 }}>
                {historialEnvios.length === 0 ? (
                  <div style={{ color: "var(--txt3)", fontSize: 11, padding: 12 }}>Sin envíos registrados.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ fontSize: 11, width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left" }}>Fecha</th>
                          <th style={{ textAlign: "right" }}>SKUs</th>
                          <th style={{ textAlign: "right" }}>Uds venta</th>
                          <th style={{ textAlign: "right" }}>Uds físicas</th>
                          <th style={{ textAlign: "right" }}>Bultos</th>
                          <th style={{ textAlign: "left" }}>Evento</th>
                          <th style={{ textAlign: "center" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {historialEnvios.map(e => {
                          const abierto = historialLineasOpen === e.id;
                          const fechaStr = new Date(e.created_at).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
                          return (
                            <>
                              <tr key={e.id} onClick={() => toggleLineasEnvio(e.id)} style={{ cursor: "pointer", background: abierto ? "var(--bg3)" : undefined }}>
                                <td>{fechaStr}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{e.total_skus}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{fmtInt(e.total_uds_venta)}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{fmtInt(e.total_uds_fisicas)}</td>
                                <td className="mono" style={{ textAlign: "right" }}>{fmtInt(e.total_bultos)}</td>
                                <td style={{ color: e.evento_activo ? "var(--amber)" : "var(--txt3)" }}>{e.evento_activo || "—"}</td>
                                <td style={{ textAlign: "center", color: "var(--txt3)", fontSize: 10 }}>{abierto ? "▼" : "▶"}</td>
                              </tr>
                              {abierto && (
                                <tr key={`${e.id}-det`}>
                                  <td colSpan={7} style={{ padding: 0, background: "var(--bg2)" }}>
                                    <div style={{ padding: 10 }}>
                                      {historialLineas.length === 0 ? (
                                        <div style={{ color: "var(--txt3)", fontSize: 10 }}>Cargando...</div>
                                      ) : (
                                        <table className="tbl" style={{ fontSize: 10, width: "100%" }}>
                                          <thead>
                                            <tr>
                                              <th style={{ textAlign: "left" }}>SKU Venta</th>
                                              <th style={{ textAlign: "left" }}>SKU Origen</th>
                                              <th style={{ textAlign: "right" }}>Sugerido</th>
                                              <th style={{ textAlign: "right" }}>Enviado</th>
                                              <th style={{ textAlign: "center" }}>ABC</th>
                                              <th style={{ textAlign: "right" }}>Vel.pond</th>
                                              <th style={{ textAlign: "right" }}>Stock Full antes</th>
                                              <th style={{ textAlign: "right" }}>Bodega antes</th>
                                              <th style={{ textAlign: "center" }}>Editado</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {historialLineas.map((l, i) => (
                                              <tr key={i}>
                                                <td className="mono">{l.sku_venta}</td>
                                                <td className="mono" style={{ color: "var(--txt3)" }}>{l.sku_origen}</td>
                                                <td className="mono" style={{ textAlign: "right", color: "var(--txt3)" }}>{fmtInt(l.cantidad_sugerida)}</td>
                                                <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{fmtInt(l.cantidad_enviada)}</td>
                                                <td style={{ textAlign: "center" }}>{l.abc || "—"}</td>
                                                <td className="mono" style={{ textAlign: "right" }}>{l.vel_ponderada != null ? fmtN(l.vel_ponderada, 1) : "—"}</td>
                                                <td className="mono" style={{ textAlign: "right" }}>{l.stock_full_antes ?? "—"}</td>
                                                <td className="mono" style={{ textAlign: "right" }}>{l.stock_bodega_antes ?? "—"}</td>
                                                <td style={{ textAlign: "center", color: l.fue_editada ? "var(--amber)" : "var(--txt3)" }}>{l.fue_editada ? "✏" : "—"}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ PEDIDO A PROVEEDOR ═══ */}
      {vistaPedido && (
        <div>
          {/* KPIs pedido */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap", fontSize: 11 }}>
            <KpiBadge label="SKUs a pedir" value={String(pedidoKpis.skus)} color="var(--amber)" />
            <KpiBadge label="Total uds" value={fmtInt(pedidoKpis.totalUds)} color="var(--cyan)" />
            <KpiBadge label="Proveedores" value={String(pedidoKpis.proveedores)} color="var(--txt)" />
            <KpiBadge label="Monto estimado" value={fmtK(pedidoKpis.montoEstimado)} color="var(--green)" />
          </div>

          {ocCreada && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, marginBottom: 8, border: "1px solid var(--greenBd)", fontWeight: 600 }}>
              OC creada: {ocCreada}
            </div>
          )}

          {pedidoItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay SKUs con pedir_proveedor &gt; 0. Ejecuta &quot;Recalcular&quot;.</div>
          ) : (() => {
            // Filter
            const filteredPedido = pedidoItems.filter(item => {
              if (pedidoFilter === "sin_ip") return !item.innerPack || item.innerPack <= 1;
              if (pedidoFilter === "abc_a") return item.abc === "A";
              if (pedidoFilter === "abc_b") return item.abc === "B";
              if (pedidoFilter === "abc_c") return item.abc === "C";
              if (pedidoFilter === "urgente") return item.accion === "URGENTE" || item.accion === "AGOTADO_PEDIR";
              if (pedidoFilter === "sin_stock_prov") return item.stockProveedor === 0;
              return true;
            });
            // Re-group filtered by proveedor
            const filteredPorProv = new Map<string, PedidoProveedorItem[]>();
            for (const item of filteredPedido) {
              const arr = filteredPorProv.get(item.proveedor) || [];
              arr.push(item);
              filteredPorProv.set(item.proveedor, arr);
            }
            // Sort within each group
            const sortItems = (items: PedidoProveedorItem[]) => [...items].sort((a, b) => {
              const { col, asc } = pedidoSort;
              let va: number | string = 0, vb: number | string = 0;
              if (col === "sku") { va = a.skuOrigen; vb = b.skuOrigen; }
              else if (col === "nombre") { va = a.nombre; vb = b.nombre; }
              else if (col === "abc") { va = a.abc; vb = b.abc; }
              else if (col === "vel") { va = a.velPonderada; vb = b.velPonderada; }
              else if (col === "stFull") { va = a.stockFull; vb = b.stockFull; }
              else if (col === "stBod") { va = a.stockBodega; vb = b.stockBodega; }
              else if (col === "transito") { va = a.stockEnTransito; vb = b.stockEnTransito; }
              else if (col === "cob") { va = a.cobTotal; vb = b.cobTotal; }
              else if (col === "pedir") { va = a.pedirEditado; vb = b.pedirEditado; }
              else if (col === "ip") { va = a.innerPack; vb = b.innerPack; }
              else if (col === "bultos") { va = a.bultos; vb = b.bultos; }
              else if (col === "subtotal") { va = a.subtotal; vb = b.subtotal; }
              else if (col === "accion") { va = a.accion; vb = b.accion; }
              const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
              return asc ? cmp : -cmp;
            });
            const togglePedidoSort = (col: string) => setPedidoSort(prev => ({ col, asc: prev.col === col ? !prev.asc : true }));
            const PSH = ({ col, label, right }: { col: string; label: string; right?: boolean }) => (
              <th onClick={() => togglePedidoSort(col)} style={{ cursor: "pointer", textAlign: right ? "right" : "left", userSelect: "none" }}>
                {label} {pedidoSort.col === col ? (pedidoSort.asc ? "▲" : "▼") : ""}
              </th>
            );
            return <>
            {/* Filters */}
            <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
              {([["todos","Todos"],["sin_ip","Sin IP"],["abc_a","ABC A"],["abc_b","ABC B"],["abc_c","ABC C"],["urgente","Urgentes"],["sin_stock_prov","Sin stock prov."]] as const).map(([key, label]) => (
                <button key={key} onClick={() => setPedidoFilter(key)}
                  style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontWeight: 600, border: `1px solid ${pedidoFilter === key ? "var(--cyan)" : "var(--bg4)"}`,
                    background: pedidoFilter === key ? "var(--cyan)" : "var(--bg3)", color: pedidoFilter === key ? "#000" : "var(--txt3)", cursor: "pointer" }}>
                  {label} ({pedidoItems.filter(i => {
                    if (key === "sin_ip") return !i.innerPack || i.innerPack <= 1;
                    if (key === "abc_a") return i.abc === "A";
                    if (key === "abc_b") return i.abc === "B";
                    if (key === "abc_c") return i.abc === "C";
                    if (key === "urgente") return i.accion === "URGENTE" || i.accion === "AGOTADO_PEDIR";
                    if (key === "sin_stock_prov") return i.stockProveedor === 0;
                    return true;
                  }).length})
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--txt3)", marginBottom: 6 }}>
              Mostrando {filteredPedido.length} de {pedidoItems.length} SKUs
            </div>
            {Array.from(filteredPorProv.entries()).map(([prov, rawItems]) => {
              const items = sortItems(rawItems);
              const collapsed = pedidoCollapsed.has(prov);
              const selectedItems = items.filter(i => pedidoSelection.has(i.skuOrigen));
              const montoGrupo = selectedItems.reduce((s, i) => s + i.subtotal, 0);
              const udsGrupo = selectedItems.reduce((s, i) => s + i.pedirEditado, 0);
              return (
                <div key={prov} style={{ marginBottom: 16 }}>
                  <div
                    onClick={() => { const next = new Set(pedidoCollapsed); if (collapsed) next.delete(prov); else next.add(prov); setPedidoCollapsed(next); }}
                    style={{ padding: "8px 12px", borderRadius: "8px 8px 0 0", background: "var(--bg3)", border: "1px solid var(--bg4)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13 }}>
                      {collapsed ? "▶" : "▼"} {prov} ({items.length} SKUs — {fmtK(montoGrupo)} estimado)
                    </span>
                    <span style={{ fontSize: 10, color: "var(--txt3)" }}>{selectedItems.length} seleccionados</span>
                  </div>

                  {!collapsed && (
                    <>
                      <div style={{ overflowX: "auto", border: "1px solid var(--bg4)", borderTop: "none" }}>
                        <table className="tbl" style={{ minWidth: 1400 }}>
                          <thead>
                            <tr>
                              <th style={{ width: 28 }}>
                                <input type="checkbox"
                                  checked={items.every(i => pedidoSelection.has(i.skuOrigen))}
                                  onChange={e => {
                                    const next = new Set(pedidoSelection);
                                    for (const i of items) { if (e.target.checked) next.add(i.skuOrigen); else next.delete(i.skuOrigen); }
                                    setPedidoSelection(next);
                                  }}
                                />
                              </th>
                              <PSH col="sku" label="SKU Origen" />
                              <PSH col="nombre" label="Nombre" />
                              <PSH col="abc" label="ABC" />
                              <PSH col="vel" label="Vel/sem" right />
                              <PSH col="stFull" label="St.Full" right />
                              <PSH col="stBod" label="St.Bod" right />
                              <PSH col="transito" label="En Transito" right />
                              <PSH col="cob" label="Cob Total" right />
                              <PSH col="pedir" label="Pedir" right />
                              <th style={{ textAlign: "center" }}>Rampup</th>
                              <PSH col="ip" label="IP" right />
                              <PSH col="bultos" label="Bultos" right />
                              <th style={{ textAlign: "right" }}>Costo Unit</th>
                              <PSH col="subtotal" label="Subtotal" right />
                              <th style={{ textAlign: "right" }}>Stock Prov</th>
                              <th>Notas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map(item => {
                              const sel = pedidoSelection.has(item.skuOrigen);
                              const sinStockProv = item.stockProveedor === 0;
                              return (
                                <tr key={item.skuOrigen} style={{ opacity: sel ? 1 : 0.4, background: sinStockProv ? "var(--redBg)" : undefined }}>
                                  <td><input type="checkbox" checked={sel} onChange={e => { const next = new Set(pedidoSelection); if (e.target.checked) next.add(item.skuOrigen); else next.delete(item.skuOrigen); setPedidoSelection(next); }} /></td>
                                  <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{item.skuOrigen}</td>
                                  <td style={{ fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.nombre}>{item.nombre}</td>
                                  <td style={{ textAlign: "center" }}><span style={{ color: abcColor(item.abc), fontWeight: 700, fontSize: 11 }}>{item.abc}</span></td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(item.velPonderada)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.stockFull <= 0 ? "var(--red)" : "var(--txt)" }}>{fmtInt(item.stockFull)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(item.stockBodega)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.stockEnTransito > 0 ? "var(--blue)" : "var(--txt3)" }}>{item.stockEnTransito > 0 ? fmtInt(item.stockEnTransito) : "—"}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: item.cobTotal < 14 ? "var(--red)" : item.cobTotal < 30 ? "var(--amber)" : "var(--green)" }}>
                                    {item.cobTotal >= 999 ? "—" : fmtN(item.cobTotal, 0) + "d"}
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <input type="number" value={item.pedirEditado}
                                      onChange={e => setPedidoEdits(prev => new Map(prev).set(item.skuOrigen, Math.max(0, parseInt(e.target.value) || 0)))}
                                      title={item.factorRampup !== 1.0 ? `Pre-rampup: ${item.pedirSinRampup} uds` : undefined}
                                      style={{ width: 60, textAlign: "right", padding: "2px 4px", fontSize: 11, background: "var(--bg3)", border: "1px solid var(--bg4)", borderRadius: 4, color: "var(--txt)", fontFamily: "var(--font-mono)" }} />
                                  </td>
                                  <td style={{ textAlign: "center" }}>
                                    {(() => {
                                      const f = item.factorRampup;
                                      const color = f === 1.0 ? "var(--green)"
                                        : f >= 0.5 ? "var(--amber)"
                                        : f > 0 ? "var(--red)"
                                        : "var(--txt3)";
                                      const bg = f === 1.0 ? "var(--greenBg)"
                                        : f >= 0.5 ? "var(--amberBg)"
                                        : f > 0 ? "var(--redBg)"
                                        : "var(--bg3)";
                                      const tooltip = `Factor: ${f.toFixed(2)}\nMotivo: ${item.rampupMotivo}\nDías quiebre: ${item.diasEnQuiebre ?? "s/d"}\nProveedor agotado: ${item.esQuiebreProveedor ? "sí" : "no"}\nPre-rampup: ${item.pedirSinRampup} uds → Ajustado: ${item.pedirEditado} uds`;
                                      return (
                                        <span
                                          title={tooltip}
                                          style={{
                                            display: "inline-block",
                                            padding: "2px 6px",
                                            borderRadius: 4,
                                            fontSize: 10,
                                            fontWeight: 700,
                                            color,
                                            background: bg,
                                            border: `1px solid ${color}`,
                                            minWidth: 36,
                                          }}
                                        >
                                          {f.toFixed(2)}
                                        </span>
                                      );
                                    })()}
                                  </td>
                                  <td style={{ textAlign: "right" }}>
                                    <input type="number" value={pedidoIpEdits.get(item.skuOrigen) ?? (item.innerPack > 1 ? item.innerPack : "")}
                                      onChange={e => setPedidoIpEdits(prev => new Map(prev).set(item.skuOrigen, parseInt(e.target.value) || 0))}
                                      onBlur={async () => {
                                        const v = pedidoIpEdits.get(item.skuOrigen);
                                        if (v !== undefined && v > 0) {
                                          const sb = getSupabase();
                                          if (sb) {
                                            await sb.from("proveedor_catalogo").update({ inner_pack: v, updated_at: new Date().toISOString() }).eq("sku_origen", item.skuOrigen);
                                            await sb.from("productos").update({ inner_pack: v }).eq("sku", item.skuOrigen);
                                          }
                                        }
                                      }}
                                      placeholder="—"
                                      style={{ width: 40, textAlign: "center", fontSize: 10, padding: "2px 4px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontFamily: "var(--font-mono)" }} />
                                  </td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{item.bultos}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(item.costoUnit)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtMoney(item.subtotal)}</td>
                                  <td className="mono" style={{ textAlign: "right", fontSize: 11, color: sinStockProv ? "var(--red)" : item.stockProveedor < 0 ? "var(--txt3)" : "var(--green)" }}>
                                    {item.stockProveedor < 0 ? "—" : fmtInt(item.stockProveedor)}
                                  </td>
                                  <td>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 160 }}>
                                      {sinStockProv && <span style={{ fontSize: 9, color: "var(--red)", fontWeight: 600 }}>Sin stock proveedor</span>}
                                      {item.accion === "URGENTE" && <span style={{ fontSize: 9, color: "var(--red)" }}>URGENTE</span>}
                                      {item.alertas.includes("estrella_en_quiebre") && <span style={{ fontSize: 9, color: "var(--amber)" }}>Estrella en quiebre</span>}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Botones crear OC + exportar CSV */}
                      <div style={{ padding: "10px 12px", background: "var(--bg2)", borderRadius: "0 0 8px 8px", border: "1px solid var(--bg4)", borderTop: "none", display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          onClick={() => {
                            const lineasSel = items.filter(i => pedidoSelection.has(i.skuOrigen));
                            if (lineasSel.length === 0) return;
                            setModalOC({ proveedor: prov, lineas: lineasSel });
                          }}
                          disabled={selectedItems.length === 0}
                          style={{ padding: "10px 20px", borderRadius: 8, fontWeight: 700, fontSize: 12, background: selectedItems.length > 0 ? "var(--amber)" : "var(--bg3)", color: selectedItems.length > 0 ? "#000" : "var(--txt3)", border: "none", cursor: selectedItems.length > 0 ? "pointer" : "default" }}
                        >
                          Crear OC para {prov} ({selectedItems.length} SKUs, {fmtInt(udsGrupo)} uds, {fmtK(montoGrupo)} neto)
                        </button>
                        <button
                          onClick={() => {
                            let csv = "SKU;Nombre;Cantidad;Inner Pack;Bultos\n";
                            for (const i of selectedItems) {
                              csv += `${i.skuOrigen};${(i.nombre || "").replace(/;/g, ",")};${i.pedirEditado};${i.innerPack > 1 ? i.innerPack : ""};${i.bultos}\n`;
                            }
                            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `pedido_${prov.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.csv`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          disabled={selectedItems.length === 0}
                          style={{ padding: "10px 16px", borderRadius: 8, fontWeight: 600, fontSize: 12, background: "var(--bg3)", color: selectedItems.length > 0 ? "var(--cyan)" : "var(--txt3)", border: "1px solid var(--bg4)", cursor: selectedItems.length > 0 ? "pointer" : "default" }}
                        >
                          Exportar CSV ({selectedItems.length})
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          }
          </>})()}
        </div>
      )}

      {/* ═══ MODAL CREAR OC ═══ */}
      {modalOC && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => !creandoOC && setModalOC(null)}>
          <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", maxWidth: 800, width: "100%", maxHeight: "80vh", overflow: "auto", padding: 24 }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>Crear Orden de Compra</h3>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 16 }}>
              {modalOC.proveedor} — {new Date().toLocaleDateString("es-CL")}
            </div>

            <div style={{ overflowX: "auto", marginBottom: 16 }}>
              <table className="tbl" style={{ minWidth: 600 }}>
                <thead>
                  <tr>
                    <th>SKU Origen</th>
                    <th>Nombre</th>
                    <th style={{ textAlign: "right" }}>Cantidad</th>
                    <th style={{ textAlign: "right" }}>IP</th>
                    <th style={{ textAlign: "right" }}>Bultos</th>
                    <th style={{ textAlign: "right" }}>Precio Neto</th>
                    <th style={{ textAlign: "right" }}>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {modalOC.lineas.map(l => (
                    <tr key={l.skuOrigen}>
                      <td className="mono" style={{ fontSize: 11 }}>{l.skuOrigen}</td>
                      <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.nombre}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(l.pedirEditado)}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>{l.innerPack > 1 ? l.innerPack : "—"}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{l.bultos}</td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                          {fmtMoney(l.costoUnit)}
                          {l.costoFuente === "ultima_recepcion" && (
                            <span title="Sin precio en catálogo. Usa el costo de la última recepción no anulada."
                              style={{ padding: "1px 5px", borderRadius: 4, background: "var(--amberBg)", color: "var(--amber)", fontSize: 9, fontWeight: 700, border: "1px solid var(--amberBd)" }}>
                              ÚLT REC
                            </span>
                          )}
                          {l.costoFuente === "wac_fallback" && (
                            <span title="Sin catálogo ni recepción reciente. Usa WAC histórico (puede estar desfasado). Verificar antes de emitir."
                              style={{ padding: "1px 5px", borderRadius: 4, background: "#f97316bb", color: "#000", fontSize: 9, fontWeight: 700, border: "1px solid #f97316" }}>
                              WAC
                            </span>
                          )}
                          {l.costoFuente === "sin_precio" && (
                            <span title="SIN PRECIO conocido. Cargar precio antes de emitir o la OC saldrá con $0."
                              style={{ padding: "1px 5px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", fontSize: 9, fontWeight: 700, border: "1px solid var(--redBd)" }}>
                              SIN PRECIO
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtMoney(l.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totales */}
            {(() => {
              const totalUds = modalOC.lineas.reduce((s, l) => s + l.pedirEditado, 0);
              const totalBultos = modalOC.lineas.reduce((s, l) => s + l.bultos, 0);
              const totalNeto = modalOC.lineas.reduce((s, l) => s + l.subtotal, 0);
              const iva = Math.round(totalNeto * 0.19);
              const totalBruto = totalNeto + iva;
              return (
                <div style={{ padding: "12px 14px", borderRadius: 8, background: "var(--bg3)", marginBottom: 16, fontSize: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 20px", color: "var(--txt2)" }}>
                    <span>Líneas: <b style={{ color: "var(--txt)" }}>{modalOC.lineas.length}</b></span>
                    <span>Unidades: <b style={{ color: "var(--cyan)" }}>{fmtInt(totalUds)}</b></span>
                    <span>Bultos: <b>{totalBultos}</b></span>
                    <span>Neto: <b style={{ color: "var(--txt)" }}>{fmtMoney(totalNeto)}</b></span>
                    <span>IVA 19%: <b>{fmtMoney(iva)}</b></span>
                    <span>Bruto: <b style={{ color: "var(--green)" }}>{fmtMoney(totalBruto)}</b></span>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setModalOC(null)} disabled={creandoOC}
                style={{ padding: "10px 20px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                Cancelar
              </button>
              <button
                onClick={() => crearOCDesdeModal("BORRADOR")}
                disabled={creandoOC}
                style={{ padding: "10px 20px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", fontWeight: 700, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                {creandoOC ? "Creando..." : "Guardar borrador"}
              </button>
              <button
                onClick={() => crearOCDesdeModal("PENDIENTE")}
                disabled={creandoOC}
                style={{ padding: "10px 20px", borderRadius: 8, background: "var(--amber)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
                {creandoOC ? "Creando..." : "Confirmar y descargar CSV"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 6c. VENTANA DE ACCION — PROVEEDOR AGOTADO ═══ */}
      {vistaProveedorAgotado && (
        <div>
          <div style={{ marginBottom: 10, padding: "10px 14px", borderRadius: 8, background: "var(--redBg)", border: "1px solid var(--redBd)", fontSize: 11, color: "var(--txt2)" }}>
            <div style={{ fontWeight: 700, color: "var(--red)", marginBottom: 4, fontSize: 12 }}>
              Ventana de Accion — Proveedor Agotado ({proveedorAgotadoItems.length})
            </div>
            <div>
              SKUs donde el proveedor reporta stock = 0 pero todavia hay cola en Full. Es la alerta temprana: tenes runway vendible pero no vas a poder reponer cuando se acabe. Ordenado por dias hasta quiebre asc.
            </div>
          </div>

          {proveedorAgotadoItems.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)", fontSize: 12 }}>
              Sin SKUs en ventana de accion. Idetex no reporta agotados cruzados con cola en Full — o hace falta re-importar el catalogo.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ minWidth: 1000 }}>
                <thead>
                  <tr>
                    {(() => {
                      const toggle = (col: string) => setProvAgotadoSort(prev => ({ col, asc: prev.col === col ? !prev.asc : true }));
                      const SH = ({ col, label, align = "left" }: { col: string; label: string; align?: "left" | "right" }) => (
                        <th onClick={() => toggle(col)} style={{ cursor: "pointer", userSelect: "none", textAlign: align }}>
                          {label} {provAgotadoSort.col === col ? (provAgotadoSort.asc ? "▲" : "▼") : ""}
                        </th>
                      );
                      return (
                        <>
                          <SH col="sku" label="SKU Origen" />
                          <SH col="nombre" label="Nombre" />
                          <SH col="abc" label="ABC" />
                          <SH col="dias_hasta_quiebre" label="Dias hasta quiebre" align="right" />
                          <SH col="vel" label="Vel/sem" align="right" />
                          <SH col="stock_full" label="Stock Full" align="right" />
                          <th style={{ textAlign: "right" }}>Stock Bod</th>
                          <SH col="ingreso" label="Ingreso 30d" align="right" />
                          <th>Evento</th>
                        </>
                      );
                    })()}
                  </tr>
                </thead>
                <tbody>
                  {proveedorAgotadoItems.map(item => {
                    const diasColor = item.dias_hasta_quiebre <= 7 ? "var(--red)"
                      : item.dias_hasta_quiebre <= 14 ? "var(--amber)"
                        : "var(--txt)";
                    return (
                      <tr key={item.sku_origen}>
                        <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{item.sku_origen}</td>
                        <td style={{ fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={item.nombre}>{item.nombre}</td>
                        <td style={{ textAlign: "center" }}>
                          <span style={{ color: abcColor(item.abc), fontWeight: 700, fontSize: 11 }}>{item.abc}</span>
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: diasColor }}>
                          {item.dias_hasta_quiebre >= 999 ? "—" : `${item.dias_hasta_quiebre}d`}
                          {item.severidad === "alta" && <span style={{ fontSize: 9, marginLeft: 4, color: "var(--red)" }}>⚠</span>}
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtN(item.vel_ponderada)}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(item.stock_full)}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{fmtInt(item.stock_bodega)}</td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtK(item.ingreso_30d)}</td>
                        <td style={{ fontSize: 10, color: "var(--txt3)" }}>
                          {item.evento_activo ? <span style={{ color: "var(--amber)", fontWeight: 600 }}>{item.evento_activo}</span> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!vistaEnvio && !vistaPedido && !vistaProveedorAgotado && !vistaAccuracy && filtered.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>No hay datos. Ejecuta &quot;Recalcular&quot; para generar.</div>}

      {/* ═══════════════════════════════════════════════
          VISTA ACCURACY — forecast accuracy (PR2/3)
         ═══════════════════════════════════════════════ */}
      {vistaAccuracy && (() => {
        // SKUs con alguna alerta forecast_* o con métricas confiables.
        const confiables = rows.filter(r => r.forecast_es_confiable_8s === true);
        const descalibrados = confiables.filter(r => {
          const tiene = r.alertas?.some(a => a === "forecast_descalibrado_critico"
                                          || a === "forecast_descalibrado"
                                          || a === "forecast_sesgo_sostenido");
          if (!tiene) return false;
          if (accuracyFiltroEstrella && r.cuadrante !== "ESTRELLA") return false;
          if (accuracyFiltroBias === "subestimamos" && !(r.forecast_bias_8s != null && r.forecast_bias_8s > 0)) return false;
          if (accuracyFiltroBias === "sobrestimamos" && !(r.forecast_bias_8s != null && r.forecast_bias_8s < 0)) return false;
          return true;
        });

        // Prioridad: ESTRELLA crítica > CASHCOW/VOLUMEN > REVISAR; luego |TS| DESC.
        const cuadRank = (c: string) => c === "ESTRELLA" ? 0 : (c === "CASHCOW" || c === "VOLUMEN") ? 1 : 2;
        descalibrados.sort((a, b) => {
          const d = cuadRank(a.cuadrante) - cuadRank(b.cuadrante);
          if (d !== 0) return d;
          const ta = Math.abs(a.forecast_tracking_signal_8s ?? 0);
          const tb = Math.abs(b.forecast_tracking_signal_8s ?? 0);
          return tb - ta;
        });

        const kpiEstrellas = confiables.filter(r => r.cuadrante === "ESTRELLA" && r.alertas?.some(a => a === "forecast_descalibrado_critico")).length;
        const kpiSesgo = confiables.filter(r => r.alertas?.includes("forecast_sesgo_sostenido")).length;
        const ultimaMed = confiables.reduce<string | null>((acc, r) => {
          if (!r.forecast_calculado_at) return acc;
          if (!acc || r.forecast_calculado_at > acc) return r.forecast_calculado_at;
          return acc;
        }, null);

        return (
          <div style={{ marginTop: 8 }}>
            {/* Banner contextual */}
            <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--cyanBg)", color: "var(--cyan)", fontSize: 11, border: "1px solid var(--cyanBd)", marginBottom: 8 }}>
              📊 <strong>Forecast accuracy</strong> — {kpiEstrellas} ESTRELLAS descalibradas · {kpiSesgo} SKUs A/B con sesgo sostenido
              {ultimaMed && <> · Última medición: {new Date(ultimaMed).toLocaleString("es-CL")}</>}
            </div>

            {/* PR4 Fase 1 — banner estacionales vencidos */}
            {estacionalesVencidos > 0 && (
              <div style={{
                background: "var(--amberBg)",
                border: "1px solid var(--amberBd)",
                color: "var(--amber)",
                padding: "10px 14px",
                borderRadius: 6,
                marginBottom: 8,
                fontSize: 11,
              }}>
                ⏰ <strong>{estacionalesVencidos} SKU(s)</strong> marcados como estacionales tienen revisión vencida. Verificá si siguen siendo estacionales o si hay que reclasificar.
                <div style={{ fontSize: 10, marginTop: 4, opacity: 0.85 }}>
                  Ver SKUs con:{" "}
                  <code style={{ background: "var(--bg3)", padding: "1px 4px", borderRadius: 3 }}>
                    SELECT sku_origen, estacional_motivo FROM sku_intelligence WHERE es_estacional=true AND estacional_revisar_en &lt; now();
                  </code>
                </div>
              </div>
            )}

            {/* Pills de filtros */}
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <button onClick={() => setAccuracyFiltroEstrella(v => !v)} style={{ padding: "4px 10px", fontSize: 10, borderRadius: 10, border: `1px solid ${accuracyFiltroEstrella ? "var(--cyan)" : "var(--bg4)"}`, background: accuracyFiltroEstrella ? "var(--cyanBg)" : "var(--bg3)", color: accuracyFiltroEstrella ? "var(--cyan)" : "var(--txt3)", cursor: "pointer" }}>
                Solo ESTRELLA
              </button>
              <button onClick={() => setAccuracyFiltroBias("todos")} style={{ padding: "4px 10px", fontSize: 10, borderRadius: 10, border: `1px solid ${accuracyFiltroBias === "todos" ? "var(--cyan)" : "var(--bg4)"}`, background: accuracyFiltroBias === "todos" ? "var(--cyanBg)" : "var(--bg3)", color: accuracyFiltroBias === "todos" ? "var(--cyan)" : "var(--txt3)", cursor: "pointer" }}>
                Todos
              </button>
              <button onClick={() => setAccuracyFiltroBias("subestimamos")} style={{ padding: "4px 10px", fontSize: 10, borderRadius: 10, border: `1px solid ${accuracyFiltroBias === "subestimamos" ? "var(--red)" : "var(--bg4)"}`, background: accuracyFiltroBias === "subestimamos" ? "var(--redBg)" : "var(--bg3)", color: accuracyFiltroBias === "subestimamos" ? "var(--red)" : "var(--txt3)", cursor: "pointer" }}>
                Subestimamos demanda
              </button>
              <button onClick={() => setAccuracyFiltroBias("sobrestimamos")} style={{ padding: "4px 10px", fontSize: 10, borderRadius: 10, border: `1px solid ${accuracyFiltroBias === "sobrestimamos" ? "var(--amber)" : "var(--bg4)"}`, background: accuracyFiltroBias === "sobrestimamos" ? "var(--amberBg)" : "var(--bg3)", color: accuracyFiltroBias === "sobrestimamos" ? "var(--amber)" : "var(--txt3)", cursor: "pointer" }}>
                Sobrestimamos demanda
              </button>
            </div>

            {/* Placeholder: aún no hay métricas confiables */}
            {confiables.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)", background: "var(--bg2)", borderRadius: 8, border: "1px solid var(--bg4)" }}>
                <div style={{ fontSize: 14, marginBottom: 6 }}>Aún no hay métricas confiables</div>
                <div style={{ fontSize: 11 }}>
                  El cron de forecast-accuracy corre los lunes 12:30 UTC. La primera medición real
                  con <code>es_confiable=true</code> llega el <strong>lunes 2026-05-18</strong> (4 lunes reales acumulados).
                </div>
              </div>
            )}

            {/* Placeholder: hay métricas pero nada descalibrado */}
            {confiables.length > 0 && descalibrados.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", color: "var(--green)", background: "var(--greenBg)", borderRadius: 8, border: "1px solid var(--greenBd)", fontSize: 12 }}>
                ✅ {confiables.length} SKUs con métricas confiables — ninguno cruza los umbrales de alerta.
              </div>
            )}

            {/* Tabla de descalibrados */}
            {descalibrados.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ fontSize: 11, width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>SKU</th>
                      <th style={{ textAlign: "left" }}>Nombre</th>
                      <th>Cuadrante</th>
                      <th>ABC-XYZ</th>
                      <th style={{ textAlign: "right" }} title="Velocidad ponderada (uds/semana)">Vel pond.</th>
                      <th style={{ textAlign: "right" }} title="WMAPE sobre ventana 8 semanas">WMAPE</th>
                      <th style={{ textAlign: "right" }} title="Bias con signo (uds/sem). Positivo = subestimamos.">Bias</th>
                      <th style={{ textAlign: "right" }} title="Tracking signal. Positivo = subestimamos (riesgo stockout). Negativo = sobrestimamos (riesgo exceso). Target: ABS(TS) < 4.">TS</th>
                      <th>Alerta</th>
                      <th style={{ textAlign: "right" }} title="Semanas confiables usadas para calcular las métricas">Semanas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {descalibrados.map(r => {
                      const ts = r.forecast_tracking_signal_8s ?? 0;
                      const absTs = Math.abs(ts);
                      const tsColor = absTs > 4 ? "var(--red)" : absTs > 2 ? "var(--amber)" : "var(--txt2)";
                      const bias = r.forecast_bias_8s ?? 0;
                      const wmape = r.forecast_wmape_8s;
                      const critica = r.alertas?.includes("forecast_descalibrado_critico");
                      const sesgo = r.alertas?.includes("forecast_sesgo_sostenido");
                      const chipText = critica ? "🔴 Crítica" : (r.alertas?.includes("forecast_descalibrado") ? "🟡 Descalibrado" : sesgo ? "🟡 Sesgo sostenido" : "—");
                      return (
                        <tr key={r.sku_origen}>
                          <td className="mono" style={{ fontSize: 10 }}>{r.sku_origen}</td>
                          <td style={{ fontSize: 10, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.nombre || "—"}</td>
                          <td>{r.cuadrante}</td>
                          <td className="mono">{r.abc}-{r.xyz}</td>
                          <td style={{ textAlign: "right" }}>{r.vel_ponderada.toFixed(1)}</td>
                          <td style={{ textAlign: "right" }}>{wmape != null ? `${(wmape * 100).toFixed(0)}%` : "—"}</td>
                          <td style={{ textAlign: "right", color: bias > 0 ? "var(--red)" : bias < 0 ? "var(--amber)" : "var(--txt3)" }}>
                            {bias > 0 ? "+" : ""}{bias.toFixed(2)}
                          </td>
                          <td style={{ textAlign: "right", color: tsColor, fontWeight: 600 }}>
                            {ts > 0 ? "+" : ""}{ts.toFixed(2)}
                          </td>
                          <td>{chipText}</td>
                          <td style={{ textAlign: "right" }}>{r.forecast_semanas_evaluadas_8s ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

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

