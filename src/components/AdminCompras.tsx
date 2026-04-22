"use client";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchOrdenesCompra, fetchOrdenCompra, fetchOrdenCompraLineas,
  updateOrdenCompra, updateOrdenCompraLinea, deleteOrdenCompra,
  fetchRecepcionesDeOC, fetchRecepcionesSinOC, vincularRecepcionOC,
  fetchRecepcionLineas, fetchLineasDeRecepciones, insertAdminActionLog,
  insertOrdenCompra, insertOrdenCompraLineas, nextOCNumero,
} from "@/lib/db";
import type { DBOrdenCompra, DBOrdenCompraLinea, DBRecepcion, DBRecepcionLinea, OCEstado } from "@/lib/db";
import { getSupabase } from "@/lib/supabase";
import { exportarOCExcel } from "@/lib/oc-export";

// ============================================
// Helpers
// ============================================

const fmtInt = (n: number | null | undefined) => n == null ? "—" : Math.round(Number(n)).toLocaleString("es-CL");
const fmtMoney = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString("es-CL");
const fmtK = (n: number) => {
  if (Math.abs(n) >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
  return "$" + Math.round(n).toLocaleString("es-CL");
};
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: undefined });
};

const ESTADO_COLORS: Record<string, string> = {
  BORRADOR: "var(--txt3)",
  PENDIENTE: "var(--amber)",
  EN_TRANSITO: "var(--cyan)",
  RECIBIDA_PARCIAL: "#f97316",
  RECIBIDA: "var(--green)",
  CERRADA: "#16a34a",
  ANULADA: "var(--red)",
};

// ============================================
// Component
// ============================================

interface ProveedorRow {
  id: string;
  nombre: string;
  rut: string | null;
  lead_time_dias: number;
  lead_time_sigma_dias: number;
  lead_time_fuente: string;
  lead_time_muestras: number;
  lead_time_updated_at: string | null;
  notas: string | null;
}

interface FaltanteCatalogo {
  sku: string;
  nombre: string;
  proveedor: string;
  inner_pack: number;
  wac_actual: number;
  abc_margen: string;
  abc_ingreso: string;
  cuadrante: string;
  vel_ponderada: number;
  margen_neto_30d: number;
  stock_total: number;
}

export default function AdminCompras() {
  const [tab, setTab] = useState<"ocs" | "proveedores" | "catalogo">("ocs");
  const [ocs, setOcs] = useState<DBOrdenCompra[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");
  const [filtroProveedor, setFiltroProveedor] = useState<string>("todos");

  // Tab Proveedores
  const [proveedoresList, setProveedoresList] = useState<ProveedorRow[]>([]);
  const [provEdits, setProvEdits] = useState<Map<string, { lt?: number; sigma?: number; notas?: string }>>(new Map());
  const [provSaving, setProvSaving] = useState<string | null>(null);

  // Tab Cargar Catálogo (faltantes)
  const [faltantes, setFaltantes] = useState<FaltanteCatalogo[]>([]);
  const [faltLoading, setFaltLoading] = useState(false);
  const [faltPrecios, setFaltPrecios] = useState<Map<string, number>>(new Map()); // sku -> precio editado (default = wac_actual)
  const [faltSelected, setFaltSelected] = useState<Set<string>>(new Set());
  const [faltSaving, setFaltSaving] = useState(false);
  const [faltResult, setFaltResult] = useState<string | null>(null);

  const cargarFaltantes = useCallback(async () => {
    setFaltLoading(true);
    setFaltResult(null);
    try {
      const res = await fetch("/api/proveedor-catalogo/faltantes");
      if (res.ok) {
        const data = await res.json();
        const list = (data.faltantes || []) as FaltanteCatalogo[];
        setFaltantes(list);
        // Pre-rellenar precios con WAC actual
        const precios = new Map<string, number>();
        for (const f of list) precios.set(f.sku, f.wac_actual);
        setFaltPrecios(precios);
        setFaltSelected(new Set());
      }
    } finally {
      setFaltLoading(false);
    }
  }, []);

  const aplicarFaltantes = useCallback(async () => {
    if (faltSelected.size === 0) return;
    if (!window.confirm(`Cargar precio de ${faltSelected.size} SKUs al catálogo?`)) return;
    setFaltSaving(true);
    setFaltResult(null);
    try {
      const items = Array.from(faltSelected).map(sku => {
        const f = faltantes.find(x => x.sku === sku);
        if (!f) return null;
        return {
          sku_origen: sku,
          proveedor: f.proveedor,
          precio_neto: faltPrecios.get(sku) || f.wac_actual,
          inner_pack: f.inner_pack,
        };
      }).filter(Boolean);
      const res = await fetch("/api/proveedor-catalogo/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (res.ok) {
        setFaltResult(`✓ ${data.escritos} SKUs cargados al catálogo. ${data.omitidos?.length ? `${data.omitidos.length} omitidos.` : ""}`);
        await cargarFaltantes(); // refresca lista (los cargados desaparecen)
      } else {
        setFaltResult(`Error: ${data.error || "desconocido"}`);
      }
    } finally {
      setFaltSaving(false);
    }
  }, [faltSelected, faltantes, faltPrecios, cargarFaltantes]);

  const cargarProveedores = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from("proveedores").select("*").order("nombre");
    setProveedoresList((data || []) as ProveedorRow[]);
    setProvEdits(new Map());
  }, []);

  useEffect(() => { if (tab === "proveedores") cargarProveedores(); }, [tab, cargarProveedores]);
  useEffect(() => { if (tab === "catalogo") cargarFaltantes(); }, [tab, cargarFaltantes]);

  const guardarProveedor = useCallback(async (p: ProveedorRow) => {
    const edits = provEdits.get(p.id);
    if (!edits) return;
    const sb = getSupabase();
    if (!sb) return;
    setProvSaving(p.id);
    try {
      await sb.from("proveedores").update({
        lead_time_dias: edits.lt ?? p.lead_time_dias,
        lead_time_sigma_dias: edits.sigma ?? p.lead_time_sigma_dias,
        notas: edits.notas ?? p.notas,
        lead_time_fuente: "manual",
        lead_time_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", p.id);
      // Disparar recálculo en background
      try { await fetch("/api/intelligence/recalcular?full=true", { method: "GET" }); } catch { /* ignore */ }
      await cargarProveedores();
    } finally {
      setProvSaving(null);
    }
  }, [provEdits, cargarProveedores]);

  // Detail view
  const [selectedOC, setSelectedOC] = useState<DBOrdenCompra | null>(null);
  const [ocLineas, setOcLineas] = useState<DBOrdenCompraLinea[]>([]);
  const [ocRecepciones, setOcRecepciones] = useState<DBRecepcion[]>([]);
  const [recibidoPorSku, setRecibidoPorSku] = useState<Map<string, number>>(new Map());
  const [lineasPorOcRec, setLineasPorOcRec] = useState<Map<string, DBRecepcionLinea[]>>(new Map());
  const [expandidoOcRec, setExpandidoOcRec] = useState<Set<string>>(new Set());

  // Modals
  const [modalEnviar, setModalEnviar] = useState(false);
  const [fechaEsperada, setFechaEsperada] = useState("");
  const [modalVincular, setModalVincular] = useState(false);
  const [recepcionesSinOC, setRecepcionesSinOC] = useState<DBRecepcion[]>([]);
  const [lineasPorRecepcion, setLineasPorRecepcion] = useState<Map<string, DBRecepcionLinea[]>>(new Map());
  const [expandidoRec, setExpandidoRec] = useState<Set<string>>(new Set());
  const [procesando, setProcesando] = useState(false);

  // Modal Nueva OC
  const [modalNueva, setModalNueva] = useState(false);
  const [nuevaProveedor, setNuevaProveedor] = useState("");
  const [nuevaFechaEsperada, setNuevaFechaEsperada] = useState("");
  const [nuevaNotas, setNuevaNotas] = useState("");
  const [nuevaLineas, setNuevaLineas] = useState<Array<{ sku_origen: string; nombre: string; cantidad_pedida: number; costo_unitario: number }>>([]);
  const [proveedorCatalogo, setProveedorCatalogo] = useState<Map<string, { proveedor: string; precio_neto: number; nombre: string }>>(new Map());
  const [skuBusqueda, setSkuBusqueda] = useState("");

  const cargar = useCallback(async () => {
    setLoading(true);
    const data = await fetchOrdenesCompra();
    setOcs(data);
    setLoading(false);
  }, []);

  // Cargar proveedor_catalogo para autocompletar precios
  const cargarProveedorCatalogo = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data } = await sb.from("proveedor_catalogo")
      .select("sku_origen, proveedor, precio_neto, nombre")
      .gt("precio_neto", 0);
    const map = new Map<string, { proveedor: string; precio_neto: number; nombre: string }>();
    for (const row of (data || []) as Array<{ sku_origen: string; proveedor: string; precio_neto: number; nombre: string }>) {
      const key = (row.sku_origen || "").toUpperCase();
      const existing = map.get(key);
      // Si hay duplicados con distintos proveedores, quedarse con el de mayor precio_neto
      if (!existing || row.precio_neto > existing.precio_neto) {
        map.set(key, { proveedor: row.proveedor, precio_neto: row.precio_neto, nombre: row.nombre || "" });
      }
    }
    setProveedorCatalogo(map);
  }, []);

  useEffect(() => { cargar(); cargarProveedorCatalogo(); }, [cargar, cargarProveedorCatalogo]);

  // ── Crear Nueva OC ──
  const abrirNueva = useCallback(() => {
    setNuevaProveedor("");
    setNuevaFechaEsperada("");
    setNuevaNotas("");
    setNuevaLineas([]);
    setSkuBusqueda("");
    setModalNueva(true);
  }, []);

  const agregarLinea = useCallback((skuRaw: string) => {
    const sku = skuRaw.trim().toUpperCase();
    if (!sku) return;
    if (nuevaLineas.some(l => l.sku_origen === sku)) {
      alert(`SKU ${sku} ya está en la OC`);
      return;
    }
    const cat = proveedorCatalogo.get(sku);
    setNuevaLineas(prev => [...prev, {
      sku_origen: sku,
      nombre: cat?.nombre || "",
      cantidad_pedida: 1,
      costo_unitario: cat?.precio_neto || 0,
    }]);
    if (cat?.proveedor && !nuevaProveedor) setNuevaProveedor(cat.proveedor);
    setSkuBusqueda("");
  }, [nuevaLineas, proveedorCatalogo, nuevaProveedor]);

  const updateLinea = useCallback((idx: number, field: "cantidad_pedida" | "costo_unitario", value: number) => {
    setNuevaLineas(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  }, []);

  const removerLinea = useCallback((idx: number) => {
    setNuevaLineas(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const crearNuevaOC = useCallback(async (estadoInicial: "BORRADOR" | "PENDIENTE") => {
    if (!nuevaProveedor.trim()) { alert("Falta proveedor"); return; }
    if (nuevaLineas.length === 0) { alert("Agrega al menos una línea"); return; }
    if (nuevaLineas.some(l => l.cantidad_pedida <= 0 || l.costo_unitario <= 0)) {
      alert("Todas las líneas deben tener cantidad y precio mayor a 0");
      return;
    }
    setProcesando(true);
    try {
      const numero = await nextOCNumero();
      const totalNeto = nuevaLineas.reduce((s, l) => s + l.cantidad_pedida * l.costo_unitario, 0);
      const totalBruto = Math.round(totalNeto * 1.19);
      const ahora = new Date().toISOString();

      const ocId = await insertOrdenCompra({
        numero,
        proveedor: nuevaProveedor.trim(),
        fecha_emision: new Date().toISOString().slice(0, 10),
        fecha_esperada: nuevaFechaEsperada || null,
        estado: estadoInicial,
        notas: nuevaNotas.trim() || null,
        total_neto: totalNeto,
        total_bruto: totalBruto,
      });
      if (!ocId) { alert("Error creando OC"); return; }

      const lineas: Omit<DBOrdenCompraLinea, "id" | "created_at">[] = nuevaLineas.map(l => ({
        orden_id: ocId,
        sku_origen: l.sku_origen,
        nombre: l.nombre,
        cantidad_pedida: l.cantidad_pedida,
        cantidad_recibida: 0,
        costo_unitario: l.costo_unitario,
        inner_pack: 1,
        bultos: 0,
        estado: "PENDIENTE",
        // Si se confirma directo (PENDIENTE), congelar precio acordado
        precio_acordado_neto: estadoInicial === "PENDIENTE" ? l.costo_unitario : null,
        precio_acordado_at: estadoInicial === "PENDIENTE" ? ahora : null,
        cantidad_facturada: 0,
        estado_linea: "pendiente",
      }));
      await insertOrdenCompraLineas(lineas);

      await insertAdminActionLog("crear_oc", "ordenes_compra", ocId, {
        numero, proveedor: nuevaProveedor, lineas: lineas.length, total_neto: totalNeto, estado: estadoInicial,
      });

      setModalNueva(false);
      cargar();
    } finally {
      setProcesando(false);
    }
  }, [nuevaProveedor, nuevaFechaEsperada, nuevaNotas, nuevaLineas, cargar]);

  // ── Exportar OC a Excel (usa helper compartido) ──
  // exportarOCExcel está en src/lib/oc-export.ts y se usa también desde AdminInteligencia.

  // Proveedores únicos
  const proveedores = useMemo(() => Array.from(new Set(ocs.map(o => o.proveedor))).sort(), [ocs]);

  // Filtrar
  const filtered = useMemo(() => {
    let rows = ocs;
    if (filtroEstado !== "todos") rows = rows.filter(o => o.estado === filtroEstado);
    if (filtroProveedor !== "todos") rows = rows.filter(o => o.proveedor === filtroProveedor);
    return rows;
  }, [ocs, filtroEstado, filtroProveedor]);

  // Open detail
  const openDetail = useCallback(async (oc: DBOrdenCompra) => {
    setSelectedOC(oc);
    const [lineas, recepciones] = await Promise.all([
      fetchOrdenCompraLineas(oc.id!),
      fetchRecepcionesDeOC(oc.id!),
    ]);
    setOcLineas(lineas);
    setOcRecepciones(recepciones);

    // Calcular recibido por SKU desde recepciones vinculadas (batch)
    const recMap = new Map<string, number>();
    const byRec = new Map<string, DBRecepcionLinea[]>();
    if (recepciones.length > 0) {
      const ids = recepciones.map(r => r.id!).filter(Boolean);
      const allLineas = await fetchLineasDeRecepciones(ids);
      for (const rl of allLineas) {
        const sku = (rl.sku || "").toUpperCase();
        recMap.set(sku, (recMap.get(sku) || 0) + (rl.qty_recibida || 0));
        const arr = byRec.get(rl.recepcion_id) || [];
        arr.push(rl);
        byRec.set(rl.recepcion_id, arr);
      }
    }
    setRecibidoPorSku(recMap);
    setLineasPorOcRec(byRec);
    setExpandidoOcRec(new Set());
  }, []);

  // Back to list
  const backToList = useCallback(() => {
    setSelectedOC(null);
    setOcLineas([]);
    setOcRecepciones([]);
    setRecibidoPorSku(new Map());
    setLineasPorOcRec(new Map());
    setExpandidoOcRec(new Set());
    cargar();
  }, [cargar]);

  const desvincularRec = useCallback(async (recId: string) => {
    if (!selectedOC) return;
    if (!window.confirm("¿Desvincular esta recepción de la OC? Los SKUs recibidos dejarán de contarse en el cumplimiento.")) return;
    const sb = getSupabase(); if (!sb) return;
    setProcesando(true);
    await sb.from("recepciones").update({ orden_compra_id: null }).eq("id", recId);
    await insertAdminActionLog("desvincular_recepcion_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, recepcion_id: recId });
    setProcesando(false);
    openDetail(selectedOC);
  }, [selectedOC, openDetail]);

  // ── Actions ──

  const confirmarOC = useCallback(async () => {
    if (!selectedOC) return;
    if (ocLineas.length === 0) {
      alert("La OC no tiene líneas. Agrega al menos un SKU antes de confirmar.");
      return;
    }
    if (!window.confirm(
      `¿Confirmar OC ${selectedOC.numero}?\n\n` +
      `Esto va a:\n` +
      `• Cambiar estado BORRADOR → PENDIENTE\n` +
      `• CONGELAR el precio acordado de cada línea (inmutable)\n` +
      `• Registrar timestamp de confirmación\n\n` +
      `Después de esto, el precio_acordado_neto NO se podrá editar.`
    )) return;
    setProcesando(true);
    try {
      const ahora = new Date().toISOString();
      // Congelar precio_acordado_neto en cada línea (Fase 1: snapshot inmutable)
      for (const l of ocLineas) {
        if (l.id) {
          await updateOrdenCompraLinea(l.id, {
            precio_acordado_neto: l.costo_unitario,
            precio_acordado_at: ahora,
            estado_linea: "pendiente",
          });
        }
      }
      await updateOrdenCompra(selectedOC.id!, { estado: "PENDIENTE" });
      await insertAdminActionLog("confirmar_oc", "ordenes_compra", selectedOC.id!, {
        numero: selectedOC.numero,
        lineas: ocLineas.length,
        precio_congelado_at: ahora,
      });
      backToList();
    } finally {
      setProcesando(false);
    }
  }, [selectedOC, ocLineas, backToList]);

  const eliminarOC = useCallback(async () => {
    if (!selectedOC) return;
    if (!window.confirm(`Eliminar OC ${selectedOC.numero}? Esta acción no se puede deshacer.`)) return;
    await deleteOrdenCompra(selectedOC.id!);
    await insertAdminActionLog("eliminar_oc", "ordenes_compra", selectedOC.id!, { numero: selectedOC.numero });
    backToList();
  }, [selectedOC, backToList]);

  const anularOC = useCallback(async () => {
    if (!selectedOC) return;
    const motivo = window.prompt("Motivo de anulación:");
    if (motivo === null) return;
    await updateOrdenCompra(selectedOC.id!, { estado: "ANULADA", notas: `${selectedOC.notas || ""}\nAnulada: ${motivo}` });
    await insertAdminActionLog("anular_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, numero: selectedOC.numero, motivo });
    backToList();
  }, [selectedOC, backToList]);

  const marcarEnviada = useCallback(async () => {
    if (!selectedOC || !fechaEsperada) return;
    setProcesando(true);
    await updateOrdenCompra(selectedOC.id!, { estado: "EN_TRANSITO", fecha_esperada: fechaEsperada });
    await insertAdminActionLog("enviar_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, numero: selectedOC.numero, fecha_esperada: fechaEsperada });
    setModalEnviar(false);
    setProcesando(false);
    backToList();
  }, [selectedOC, fechaEsperada, backToList]);

  const abrirVincular = useCallback(async () => {
    if (!selectedOC) return;
    const recs = await fetchRecepcionesSinOC(selectedOC.proveedor);
    setRecepcionesSinOC(recs);
    const ids = recs.map(r => r.id!).filter(Boolean);
    const lineas = await fetchLineasDeRecepciones(ids);
    const m = new Map<string, DBRecepcionLinea[]>();
    for (const l of lineas) {
      const arr = m.get(l.recepcion_id) || [];
      arr.push(l);
      m.set(l.recepcion_id, arr);
    }
    setLineasPorRecepcion(m);
    setExpandidoRec(new Set());
    setModalVincular(true);
  }, [selectedOC]);

  const vincular = useCallback(async (recId: string) => {
    if (!selectedOC) return;
    setProcesando(true);
    await vincularRecepcionOC(recId, selectedOC.id!);
    await insertAdminActionLog("vincular_recepcion_oc", "ordenes_compra", selectedOC.id!, { oc_id: selectedOC.id, recepcion_id: recId });
    setModalVincular(false);
    setProcesando(false);
    // Refresh detail
    openDetail(selectedOC);
  }, [selectedOC, openDetail]);

  const cerrarOC = useCallback(async () => {
    if (!selectedOC) return;
    if (!window.confirm(`Cerrar OC ${selectedOC.numero}? Se calculará lead time y cumplimiento.`)) return;
    setProcesando(true);

    // Calcular métricas de cierre
    const totalPedido = ocLineas.reduce((s, l) => s + l.cantidad_pedida, 0);
    const totalRecibido = ocLineas.reduce((s, l) => s + (recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0), 0);
    const pctCumplimiento = totalPedido > 0 ? Math.round((totalRecibido / totalPedido) * 1000) / 10 : 0;

    // Lead time: días entre emisión y última recepción
    let leadTimeReal: number | null = null;
    if (selectedOC.fecha_emision && ocRecepciones.length > 0) {
      const ultimaRec = ocRecepciones.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
      if (ultimaRec.created_at) {
        const emision = new Date(selectedOC.fecha_emision);
        const recepcion = new Date(ultimaRec.created_at);
        leadTimeReal = Math.max(0, Math.round((recepcion.getTime() - emision.getTime()) / 86400000));
      }
    }

    await updateOrdenCompra(selectedOC.id!, {
      estado: "CERRADA",
      fecha_recepcion: new Date().toISOString().slice(0, 10),
      lead_time_real: leadTimeReal,
      total_recibido: totalRecibido,
      pct_cumplimiento: pctCumplimiento,
    });

    await insertAdminActionLog("cerrar_oc", "ordenes_compra", selectedOC.id!, {
      oc_id: selectedOC.id, numero: selectedOC.numero,
      lead_time_real: leadTimeReal, total_recibido: totalRecibido, pct_cumplimiento: pctCumplimiento,
    });

    // Disparar recálculo de inteligencia
    try { await fetch("/api/intelligence/recalcular", { method: "POST" }); } catch { /* silenciar */ }

    setProcesando(false);
    backToList();
  }, [selectedOC, ocLineas, ocRecepciones, recibidoPorSku, backToList]);

  // Auto-calculate OC status from receptions
  const calcEstadoAuto = useCallback((): OCEstado | null => {
    if (!selectedOC || ocLineas.length === 0) return null;
    const currentEstado = selectedOC.estado;
    if (currentEstado === "BORRADOR" || currentEstado === "PENDIENTE" || currentEstado === "CERRADA" || currentEstado === "ANULADA") return null;

    let todasRecibidas = true;
    let algunaRecibida = false;
    for (const l of ocLineas) {
      const recibido = recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0;
      if (recibido >= l.cantidad_pedida) algunaRecibida = true;
      else todasRecibidas = false;
      if (recibido > 0) algunaRecibida = true;
    }

    if (todasRecibidas && algunaRecibida) return "RECIBIDA";
    if (algunaRecibida) return "RECIBIDA_PARCIAL";
    return null;
  }, [selectedOC, ocLineas, recibidoPorSku]);

  // Update estado if auto-calc differs
  useEffect(() => {
    const nuevoEstado = calcEstadoAuto();
    if (nuevoEstado && selectedOC && nuevoEstado !== selectedOC.estado) {
      updateOrdenCompra(selectedOC.id!, { estado: nuevoEstado }).then(() => {
        setSelectedOC(prev => prev ? { ...prev, estado: nuevoEstado } : prev);
      });
    }
  }, [calcEstadoAuto, selectedOC]);

  if (loading) return <div style={{ padding: 24, color: "var(--txt3)" }}>Cargando órdenes de compra...</div>;

  // ══════════════════════
  // DETAIL VIEW
  // ══════════════════════
  if (selectedOC) {
    const estado = selectedOC.estado;
    const estadoColor = ESTADO_COLORS[estado] || "var(--txt3)";
    const totalPedido = ocLineas.reduce((s, l) => s + l.cantidad_pedida, 0);
    const totalRecibidoCalc = ocLineas.reduce((s, l) => s + (recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0), 0);
    const pctProgreso = totalPedido > 0 ? Math.round((totalRecibidoCalc / totalPedido) * 100) : 0;

    return (
      <div style={{ padding: "0 4px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <button onClick={backToList} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontSize: 11, fontWeight: 600, border: "1px solid var(--bg4)", cursor: "pointer" }}>
            ← Volver
          </button>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{selectedOC.numero}</h2>
            <span style={{ fontSize: 12, color: "var(--txt3)" }}>{selectedOC.proveedor} — {fmtDate(selectedOC.fecha_emision || selectedOC.created_at)}</span>
          </div>
          <span style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: estadoColor + "22", color: estadoColor, border: `1px solid ${estadoColor}44` }}>
            {estado}
          </span>
          {selectedOC.fecha_esperada && (
            <span style={{ fontSize: 11, color: "var(--txt3)" }}>Esperada: {fmtDate(selectedOC.fecha_esperada)}</span>
          )}
        </div>

        {/* KPIs */}
        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Líneas</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{ocLineas.length}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Pedido</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmtInt(totalPedido)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Recibido</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: totalRecibidoCalc > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtInt(totalRecibidoCalc)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Neto</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(selectedOC.total_neto)}</div>
          </div>
          <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
            <div style={{ fontSize: 10, color: "var(--txt3)" }}>Progreso</div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: pctProgreso >= 100 ? "var(--green)" : pctProgreso > 0 ? "var(--amber)" : "var(--txt3)" }}>{pctProgreso}%</div>
          </div>
          {selectedOC.lead_time_real != null && (
            <div style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Lead time real</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{selectedOC.lead_time_real}d</div>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {/* Exportar Excel: disponible en todos los estados excepto BORRADOR vacío */}
          {ocLineas.length > 0 && (
            <button onClick={() => exportarOCExcel(selectedOC, ocLineas)}
              title="Descargar OC como Excel para enviar al proveedor"
              style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--green)", fontWeight: 700, fontSize: 12, border: "1px solid var(--green)", cursor: "pointer" }}>
              📊 Exportar Excel
            </button>
          )}
          {estado === "BORRADOR" && (
            <>
              <button onClick={confirmarOC} disabled={procesando} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--amber)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: procesando ? "wait" : "pointer", opacity: procesando ? 0.6 : 1 }}>Confirmar (congela precios)</button>
              <button onClick={eliminarOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Eliminar</button>
            </>
          )}
          {estado === "PENDIENTE" && (
            <>
              <button onClick={() => { setFechaEsperada(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)); setModalEnviar(true); }}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
                Marcar enviada
              </button>
              <button onClick={anularOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Anular</button>
            </>
          )}
          {(estado === "EN_TRANSITO" || estado === "RECIBIDA_PARCIAL") && (
            <>
              <button onClick={abrirVincular} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 700, fontSize: 12, border: "1px solid var(--blueBd)", cursor: "pointer" }}>Vincular recepción</button>
              {estado === "EN_TRANSITO" && <button onClick={anularOC} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 12, border: "1px solid var(--redBd)", cursor: "pointer" }}>Anular</button>}
              {estado === "RECIBIDA_PARCIAL" && <button onClick={cerrarOC} disabled={procesando} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--greenBg)", color: "var(--green)", fontWeight: 700, fontSize: 12, border: "1px solid var(--greenBd)", cursor: "pointer" }}>Cerrar</button>}
            </>
          )}
          {estado === "RECIBIDA" && (
            <button onClick={cerrarOC} disabled={procesando} style={{ padding: "8px 16px", borderRadius: 6, background: "var(--green)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
              {procesando ? "Cerrando..." : "Cerrar OC"}
            </button>
          )}
        </div>

        {/* Líneas */}
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>SKU Origen</th>
                <th>Nombre</th>
                <th style={{ textAlign: "right" }}>Pedido</th>
                <th style={{ textAlign: "right" }}>Recibido</th>
                <th style={{ textAlign: "right" }}>Pendiente</th>
                <th style={{ textAlign: "right" }}>Costo Unit</th>
                <th style={{ textAlign: "right" }}>Subtotal</th>
                <th>ABC</th>
                <th style={{ textAlign: "right" }}>Vel</th>
                <th style={{ textAlign: "right" }}>Cob al pedir</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {ocLineas.map(l => {
                const recibido = recibidoPorSku.get(l.sku_origen.toUpperCase()) || 0;
                const pendiente = Math.max(0, l.cantidad_pedida - recibido);
                const estadoLinea = recibido >= l.cantidad_pedida ? "RECIBIDA" : recibido > 0 ? "PARCIAL" : "PENDIENTE";
                const estadoLineaColor = estadoLinea === "RECIBIDA" ? "var(--green)" : estadoLinea === "PARCIAL" ? "#f97316" : "var(--txt3)";
                return (
                  <tr key={l.id}>
                    <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{l.sku_origen}</td>
                    <td style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.nombre}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtInt(l.cantidad_pedida)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, color: recibido > 0 ? "var(--green)" : "var(--txt3)" }}>{fmtInt(recibido)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, color: pendiente > 0 ? "var(--amber)" : "var(--green)" }}>{fmtInt(pendiente)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>{fmtMoney(l.costo_unitario)}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtMoney(l.cantidad_pedida * l.costo_unitario)}</td>
                    <td style={{ textAlign: "center" }}><span style={{ fontWeight: 700, fontSize: 11, color: l.abc === "A" ? "var(--green)" : l.abc === "B" ? "var(--amber)" : "var(--txt3)" }}>{l.abc || "—"}</span></td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>{l.vel_ponderada != null ? Number(l.vel_ponderada).toFixed(1) : "—"}</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>{l.cob_total_al_pedir != null ? Number(l.cob_total_al_pedir).toFixed(0) + "d" : "—"}</td>
                    <td>
                      <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, background: estadoLineaColor + "22", color: estadoLineaColor, border: `1px solid ${estadoLineaColor}44` }}>
                        {estadoLinea}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Recepciones vinculadas */}
        {ocRecepciones.length > 0 && (() => {
          const skusOC = new Map<string, DBOrdenCompraLinea>();
          for (const l of ocLineas) skusOC.set(l.sku_origen.toUpperCase(), l);
          const toggleExp = (id: string) => {
            const next = new Set(expandidoOcRec);
            if (next.has(id)) next.delete(id); else next.add(id);
            setExpandidoOcRec(next);
          };
          return (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: "var(--txt2)" }}>Recepciones vinculadas</h4>
            {ocRecepciones.map(r => {
              const lineas = lineasPorOcRec.get(r.id!) || [];
              const matches: { sku: string; rl: DBRecepcionLinea; pedida: number }[] = [];
              const extras: DBRecepcionLinea[] = [];
              for (const rl of lineas) {
                const sku = (rl.sku || "").toUpperCase();
                const ocl = skusOC.get(sku);
                if (ocl) matches.push({ sku, rl, pedida: ocl.cantidad_pedida });
                else extras.push(rl);
              }
              const qtyMatch = matches.reduce((s, m) => s + (m.rl.qty_recibida || 0), 0);
              const qtyExtra = extras.reduce((s, e) => s + (e.qty_recibida || 0), 0);
              const expandido = expandidoOcRec.has(r.id!);
              const puedeDesvincular = selectedOC.estado !== "CERRADA";
              return (
              <div key={r.id} style={{ padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{r.folio}</span>
                  <span style={{ color: "var(--txt3)", fontSize: 11 }}>{fmtDate(r.created_at)}</span>
                  <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700, color: r.estado === "CERRADA" || r.estado === "COMPLETADA" ? "var(--green)" : "var(--amber)" }}>
                    {r.estado}
                  </span>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--txt2)" }}>
                    <span style={{ color: "var(--green)", fontWeight: 600 }}>{matches.length} match</span>
                    <span style={{ color: "var(--txt3)" }}> · {fmtInt(qtyMatch)}u</span>
                    {extras.length > 0 && <>
                      <span style={{ marginLeft: 10, color: "var(--amber)" }}>{extras.length} extra</span>
                      <span style={{ color: "var(--txt3)" }}> · {fmtInt(qtyExtra)}u</span>
                    </>}
                  </span>
                  <button onClick={() => toggleExp(r.id!)}
                    style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg4)", color: "var(--txt2)", fontWeight: 600, fontSize: 10, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                    {expandido ? "Ocultar" : "Ver detalle"}
                  </button>
                  {puedeDesvincular && (
                    <button onClick={() => desvincularRec(r.id!)} disabled={procesando}
                      style={{ padding: "4px 10px", borderRadius: 6, background: "var(--redBg)", color: "var(--red)", fontWeight: 600, fontSize: 10, border: "1px solid var(--redBd)", cursor: "pointer" }}>
                      Desvincular
                    </button>
                  )}
                </div>
                {expandido && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--bg4)", fontSize: 11 }}>
                    {matches.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ color: "var(--green)", fontWeight: 600, marginBottom: 4 }}>Coinciden ({matches.length})</div>
                        {matches.map(m => (
                          <div key={m.sku} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--txt2)" }}>
                            <span className="mono" style={{ fontSize: 11 }}>{m.sku}</span>
                            <span style={{ fontSize: 11 }}>
                              <span style={{ color: m.rl.qty_recibida < m.pedida ? "var(--amber)" : m.rl.qty_recibida > m.pedida ? "var(--blue)" : "var(--green)" }}>
                                {fmtInt(m.rl.qty_recibida)}
                              </span>
                              <span style={{ color: "var(--txt3)" }}> / {fmtInt(m.pedida)} OC</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {extras.length > 0 && (
                      <div>
                        <div style={{ color: "var(--amber)", fontWeight: 600, marginBottom: 4 }}>Extras no en la OC ({extras.length})</div>
                        {extras.map(rl => (
                          <div key={rl.id} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--txt3)" }}>
                            <span className="mono" style={{ fontSize: 11 }}>{rl.sku}</span>
                            <span style={{ fontSize: 11 }}>{fmtInt(rl.qty_recibida)}u</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {matches.length === 0 && extras.length === 0 && (
                      <div style={{ color: "var(--txt3)", fontSize: 11 }}>Recepción sin líneas.</div>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </div>
          );
        })()}

        {selectedOC.notas && (
          <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", fontSize: 11, color: "var(--txt3)", whiteSpace: "pre-wrap" }}>
            {selectedOC.notas}
          </div>
        )}

        {/* Modal Marcar Enviada */}
        {modalEnviar && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={() => !procesando && setModalEnviar(false)}>
            <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 400, width: "100%" }}
              onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>Marcar como enviada</h3>
              <label style={{ fontSize: 12, color: "var(--txt2)", display: "block", marginBottom: 4 }}>Fecha esperada de recepción</label>
              <input
                type="date"
                value={fechaEsperada}
                onChange={e => setFechaEsperada(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 14, marginBottom: 16 }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setModalEnviar(false)} disabled={procesando}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cancelar
                </button>
                <button onClick={marcarEnviada} disabled={procesando || !fechaEsperada}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--cyan)", color: "#000", fontWeight: 700, fontSize: 12, border: "none", cursor: "pointer" }}>
                  {procesando ? "Guardando..." : "Confirmar"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal Vincular Recepción */}
        {modalVincular && (() => {
          const skusOC = new Map<string, DBOrdenCompraLinea>();
          for (const l of ocLineas) skusOC.set(l.sku_origen.toUpperCase(), l);
          const toggleExp = (id: string) => {
            const next = new Set(expandidoRec);
            if (next.has(id)) next.delete(id); else next.add(id);
            setExpandidoRec(next);
          };
          return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
            onClick={() => !procesando && setModalVincular(false)}>
            <div style={{ background: "var(--bg2)", borderRadius: 12, border: "1px solid var(--bg4)", padding: 24, maxWidth: 640, width: "100%", maxHeight: "80vh", overflow: "auto" }}
              onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700 }}>Vincular recepción a {selectedOC.numero}</h3>
              <p style={{ fontSize: 12, color: "var(--txt3)", marginBottom: 12 }}>
                Recepciones de {selectedOC.proveedor} sin OC vinculada. El vínculo es a nivel cabecera:
                los SKUs que no están en la OC igual quedan asociados a la recepción pero no se suman al cumplimiento.
              </p>
              {recepcionesSinOC.length === 0 ? (
                <div style={{ textAlign: "center", padding: 20, color: "var(--txt3)", fontSize: 12 }}>No hay recepciones disponibles para vincular.</div>
              ) : (
                recepcionesSinOC.map(rec => {
                  const lineas = lineasPorRecepcion.get(rec.id!) || [];
                  const matches: { sku: string; rl: DBRecepcionLinea; pedida: number }[] = [];
                  const extras: DBRecepcionLinea[] = [];
                  const skusMatched = new Set<string>();
                  for (const rl of lineas) {
                    const sku = (rl.sku || "").toUpperCase();
                    const ocl = skusOC.get(sku);
                    if (ocl) { matches.push({ sku, rl, pedida: ocl.cantidad_pedida }); skusMatched.add(sku); }
                    else extras.push(rl);
                  }
                  const faltantes = ocLineas.filter(l => !skusMatched.has(l.sku_origen.toUpperCase()));
                  const qtyMatch = matches.reduce((s, m) => s + (m.rl.qty_recibida || 0), 0);
                  const qtyExtra = extras.reduce((s, e) => s + (e.qty_recibida || 0), 0);
                  const expandido = expandidoRec.has(rec.id!);
                  return (
                  <div key={rec.id} style={{ padding: "10px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>
                          <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{rec.folio}</span>
                          <span style={{ fontSize: 11, color: "var(--txt3)", marginLeft: 8 }}>{fmtDate(rec.created_at)}</span>
                          <span style={{ fontSize: 10, marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "var(--bg4)", color: "var(--txt3)" }}>{rec.estado}</span>
                        </div>
                        <div style={{ fontSize: 11, marginTop: 4, color: "var(--txt2)" }}>
                          <span style={{ color: "var(--green)", fontWeight: 600 }}>{matches.length} match</span>
                          <span style={{ color: "var(--txt3)" }}> · {fmtInt(qtyMatch)}u</span>
                          {extras.length > 0 && <>
                            <span style={{ marginLeft: 10, color: "var(--amber)" }}>{extras.length} extra</span>
                            <span style={{ color: "var(--txt3)" }}> · {fmtInt(qtyExtra)}u</span>
                          </>}
                          {faltantes.length > 0 && <span style={{ marginLeft: 10, color: "var(--red)" }}>{faltantes.length} faltante</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => toggleExp(rec.id!)}
                          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg4)", color: "var(--txt2)", fontWeight: 600, fontSize: 11, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                          {expandido ? "Ocultar" : "Ver detalle"}
                        </button>
                        <button onClick={() => vincular(rec.id!)} disabled={procesando}
                          style={{ padding: "6px 12px", borderRadius: 6, background: "var(--blueBg)", color: "var(--blue)", fontWeight: 600, fontSize: 11, border: "1px solid var(--blueBd)", cursor: "pointer" }}>
                          Vincular
                        </button>
                      </div>
                    </div>
                    {expandido && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--bg4)", fontSize: 11 }}>
                        {matches.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ color: "var(--green)", fontWeight: 600, marginBottom: 4 }}>Coinciden ({matches.length})</div>
                            {matches.map(m => (
                              <div key={m.sku} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--txt2)" }}>
                                <span className="mono" style={{ fontSize: 11 }}>{m.sku}</span>
                                <span style={{ fontSize: 11 }}>
                                  <span style={{ color: m.rl.qty_recibida < m.pedida ? "var(--amber)" : m.rl.qty_recibida > m.pedida ? "var(--blue)" : "var(--green)" }}>
                                    {fmtInt(m.rl.qty_recibida)}
                                  </span>
                                  <span style={{ color: "var(--txt3)" }}> / {fmtInt(m.pedida)} OC</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {extras.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ color: "var(--amber)", fontWeight: 600, marginBottom: 4 }}>Extras no en la OC ({extras.length})</div>
                            {extras.map(rl => (
                              <div key={rl.id} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--txt3)" }}>
                                <span className="mono" style={{ fontSize: 11 }}>{rl.sku}</span>
                                <span style={{ fontSize: 11 }}>{fmtInt(rl.qty_recibida)}u</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {faltantes.length > 0 && (
                          <div>
                            <div style={{ color: "var(--red)", fontWeight: 600, marginBottom: 4 }}>Faltan en esta recepción ({faltantes.length})</div>
                            {faltantes.map(l => (
                              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: "var(--txt3)" }}>
                                <span className="mono" style={{ fontSize: 11 }}>{l.sku_origen}</span>
                                <span style={{ fontSize: 11 }}>{fmtInt(l.cantidad_pedida)} pedidas</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
              <div style={{ marginTop: 12, textAlign: "right" }}>
                <button onClick={() => setModalVincular(false)}
                  style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt3)", fontWeight: 600, fontSize: 12, border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cerrar
                </button>
              </div>
            </div>
          </div>
          );
        })()}
      </div>
    );
  }

  // ══════════════════════
  // LIST VIEW
  // ══════════════════════
  return (
    <div style={{ padding: "0 4px" }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid var(--bg4)" }}>
        {(["ocs", "proveedores", "catalogo"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: "8px 14px", border: "none", background: "none",
              color: tab === t ? "var(--cyan)" : "var(--txt3)",
              borderBottom: tab === t ? "2px solid var(--cyan)" : "2px solid transparent",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
            }}>
            {t === "ocs" ? "Órdenes de Compra" : t === "proveedores" ? "Proveedores" : "Cargar Catálogo"}
          </button>
        ))}
      </div>

      {tab === "proveedores" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Proveedores — Lead time</h2>
            <button onClick={cargarProveedores}
              style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              Refrescar
            </button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Proveedor</th>
                  <th>RUT</th>
                  <th style={{ textAlign: "right" }}>LT días</th>
                  <th style={{ textAlign: "right" }}>σ_LT días</th>
                  <th>Fuente</th>
                  <th style={{ textAlign: "right" }}>Muestras</th>
                  <th>Última act.</th>
                  <th>Notas</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {proveedoresList.map(p => {
                  const edit = provEdits.get(p.id) || {};
                  const isDirty = edit.lt !== undefined || edit.sigma !== undefined || edit.notas !== undefined;
                  const fuenteColor: Record<string, string> = {
                    oc_real: "var(--green)",
                    manual: "var(--cyan)",
                    fallback: "var(--amber)",
                  };
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.nombre}</td>
                      <td className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{p.rut || "—"}</td>
                      <td>
                        <input type="number" step="0.5" defaultValue={p.lead_time_dias}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setProvEdits(m => { const n = new Map(m); n.set(p.id, { ...n.get(p.id), lt: isNaN(v) ? undefined : v }); return n; });
                          }}
                          style={{ width: 70, padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11, textAlign: "right" }} />
                      </td>
                      <td>
                        <input type="number" step="0.5" defaultValue={p.lead_time_sigma_dias}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            setProvEdits(m => { const n = new Map(m); n.set(p.id, { ...n.get(p.id), sigma: isNaN(v) ? undefined : v }); return n; });
                          }}
                          style={{ width: 70, padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11, textAlign: "right" }} />
                      </td>
                      <td>
                        <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: (fuenteColor[p.lead_time_fuente] || "var(--txt3)") + "22", color: fuenteColor[p.lead_time_fuente] || "var(--txt3)" }}>
                          {p.lead_time_fuente}
                        </span>
                      </td>
                      <td className="mono" style={{ textAlign: "right" }}>{p.lead_time_muestras}</td>
                      <td style={{ fontSize: 10, color: "var(--txt3)" }}>{p.lead_time_updated_at ? new Date(p.lead_time_updated_at).toLocaleDateString("es-CL") : "—"}</td>
                      <td>
                        <input type="text" defaultValue={p.notas || ""}
                          onChange={(e) => {
                            setProvEdits(m => { const n = new Map(m); n.set(p.id, { ...n.get(p.id), notas: e.target.value }); return n; });
                          }}
                          style={{ width: "100%", minWidth: 150, padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11 }} />
                      </td>
                      <td>
                        <button disabled={!isDirty || provSaving === p.id} onClick={() => guardarProveedor(p)}
                          style={{ padding: "4px 10px", borderRadius: 4, background: isDirty ? "var(--green)" : "var(--bg3)", color: isDirty ? "#0a0e17" : "var(--txt3)", border: "none", fontSize: 10, fontWeight: 700, cursor: isDirty ? "pointer" : "not-allowed", opacity: provSaving === p.id ? 0.5 : 1 }}>
                          {provSaving === p.id ? "..." : "Guardar"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--txt3)" }}>
            <strong>oc_real</strong>: lead time medido desde OCs cerradas (≥3 muestras) ·{" "}
            <strong>manual</strong>: editado por admin ·{" "}
            <strong>fallback</strong>: 5 días + σ=1.5 (default)
          </div>
        </div>
      ) : tab === "catalogo" ? (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Cargar precios al catálogo</h2>
              <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 4 }}>
                SKUs A/B sin precio en proveedor_catalogo (excl. Idetex). El precio se pre-rellena con el WAC actual — ajustá donde corresponda.
              </div>
            </div>
            <button onClick={cargarFaltantes} disabled={faltLoading}
              style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
              {faltLoading ? "Cargando..." : "Refrescar"}
            </button>
          </div>

          {faltResult && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: faltResult.startsWith("✓") ? "var(--greenBg)" : "var(--redBg)", color: faltResult.startsWith("✓") ? "var(--green)" : "var(--red)", border: `1px solid ${faltResult.startsWith("✓") ? "var(--greenBd)" : "var(--redBd)"}`, fontSize: 12, marginBottom: 12 }}>
              {faltResult}
            </div>
          )}

          {faltantes.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--txt3)", fontSize: 13 }}>
              {faltLoading ? "Cargando..." : "🎉 No hay SKUs A/B sin catálogo. Todos los críticos cubiertos."}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, fontSize: 11 }}>
                <button onClick={() => setFaltSelected(new Set(faltantes.map(f => f.sku)))}
                  style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                  Seleccionar todos
                </button>
                <button onClick={() => setFaltSelected(new Set())}
                  style={{ padding: "4px 10px", borderRadius: 4, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>
                  Deseleccionar
                </button>
                <span style={{ color: "var(--txt3)" }}>{faltSelected.size} de {faltantes.length} seleccionados</span>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th>SKU</th>
                      <th>Nombre</th>
                      <th>Proveedor</th>
                      <th style={{ textAlign: "center" }}>ABC</th>
                      <th>Cuadrante</th>
                      <th style={{ textAlign: "right" }}>WAC</th>
                      <th style={{ textAlign: "right" }}>Precio neto</th>
                      <th style={{ textAlign: "right" }}>Diff %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {faltantes.map(f => {
                      const sel = faltSelected.has(f.sku);
                      const precio = faltPrecios.get(f.sku) ?? f.wac_actual;
                      const diff = f.wac_actual > 0 ? Math.round(1000 * (precio - f.wac_actual) / f.wac_actual) / 10 : 0;
                      const absDiff = Math.abs(diff);
                      const diffColor = absDiff < 10 ? "var(--green)" : absDiff < 20 ? "var(--amber)" : "var(--red)";
                      return (
                        <tr key={f.sku} style={{ background: sel ? "var(--cyanBg)" : undefined }}>
                          <td style={{ textAlign: "center" }}>
                            <input type="checkbox" checked={sel}
                              onChange={(e) => {
                                setFaltSelected(s => {
                                  const n = new Set(s);
                                  if (e.target.checked) n.add(f.sku); else n.delete(f.sku);
                                  return n;
                                });
                              }} />
                          </td>
                          <td className="mono" style={{ fontSize: 10 }}>{f.sku}</td>
                          <td style={{ fontSize: 11, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.nombre}</td>
                          <td style={{ fontSize: 11 }}>{f.proveedor}</td>
                          <td style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: f.abc_margen === "A" ? "var(--green)" : f.abc_margen === "B" ? "var(--amber)" : "var(--txt3)" }}>{f.abc_margen}</td>
                          <td style={{ fontSize: 10, color: "var(--txt3)" }}>{f.cuadrante}</td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)" }}>{f.wac_actual.toLocaleString("es-CL")}</td>
                          <td>
                            <input type="number" min="0" step="1" value={precio}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value);
                                setFaltPrecios(m => { const n = new Map(m); n.set(f.sku, isNaN(v) ? 0 : v); return n; });
                              }}
                              style={{ width: 100, padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11, textAlign: "right" }} />
                          </td>
                          <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 700, color: diffColor }}>
                            {diff > 0 ? "+" : ""}{diff.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
                <button onClick={aplicarFaltantes} disabled={faltSaving || faltSelected.size === 0}
                  style={{ padding: "10px 20px", borderRadius: 8, background: faltSelected.size > 0 ? "var(--green)" : "var(--bg3)", color: faltSelected.size > 0 ? "#0a0e17" : "var(--txt3)", fontWeight: 700, fontSize: 12, border: "none", cursor: faltSelected.size > 0 ? "pointer" : "not-allowed" }}>
                  {faltSaving ? "Guardando..." : `Cargar ${faltSelected.size} seleccionados al catálogo`}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (<>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Compras — Órdenes de Compra</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={abrirNueva} style={{ padding: "6px 14px", borderRadius: 6, background: "var(--green)", color: "#0a0e17", fontWeight: 700, fontSize: 11, border: "none", cursor: "pointer" }}>
            + Nueva OC
          </button>
          <button onClick={cargar} style={{ padding: "6px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", fontWeight: 600, fontSize: 11, border: "1px solid var(--bg4)", cursor: "pointer" }}>
            Refrescar
          </button>
        </div>
      </div>

      {/* KPIs OCs abiertas */}
      {(() => {
        const abiertas = ocs.filter(o => ["PENDIENTE", "EN_TRANSITO", "RECIBIDA_PARCIAL"].includes(o.estado));
        const montoComprometido = abiertas.reduce((s, o) => s + (o.total_neto || 0), 0);
        const borradores = ocs.filter(o => o.estado === "BORRADOR").length;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 12 }}>
            <div className="card" style={{ padding: 12, background: "var(--bg3)" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>OCs abiertas</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: abiertas.length > 0 ? "var(--cyan)" : "var(--txt3)", marginTop: 4 }}>{abiertas.length}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>Pendientes + en tránsito + parciales</div>
            </div>
            <div className="card" style={{ padding: 12, background: "var(--bg3)" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Monto comprometido</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--amber)", marginTop: 4 }}>{fmtK(montoComprometido)}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>Suma neta de abiertas</div>
            </div>
            <div className="card" style={{ padding: 12, background: "var(--bg3)" }}>
              <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Borradores</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: borradores > 0 ? "var(--txt2)" : "var(--txt3)", marginTop: 4 }}>{borradores}</div>
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>Sin confirmar</div>
            </div>
          </div>
        );
      })()}

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11 }}>
          <option value="todos">Todos los estados</option>
          {["BORRADOR","PENDIENTE","EN_TRANSITO","RECIBIDA_PARCIAL","RECIBIDA","CERRADA","ANULADA"].map(e => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        <select value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11 }}>
          <option value="todos">Todos los proveedores</option>
          {proveedores.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <span style={{ fontSize: 11, color: "var(--txt3)", alignSelf: "center" }}>{filtered.length} órdenes</span>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🛒</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No hay órdenes de compra</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Crea una desde Inteligencia → Pedido a Proveedor</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>#</th>
                <th>Proveedor</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th style={{ textAlign: "right" }}>Líneas</th>
                <th style={{ textAlign: "right" }}>Monto Neto</th>
                <th>Esperada</th>
                <th>Progreso</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(oc => {
                const color = ESTADO_COLORS[oc.estado] || "var(--txt3)";
                return (
                  <tr key={oc.id} onClick={() => openDetail(oc)} style={{ cursor: "pointer" }}>
                    <td className="mono" style={{ fontSize: 11, fontWeight: 600 }}>{oc.numero}</td>
                    <td style={{ fontSize: 11 }}>{oc.proveedor}</td>
                    <td style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtDate(oc.fecha_emision || oc.created_at)}</td>
                    <td>
                      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: color + "22", color: color, border: `1px solid ${color}44` }}>
                        {oc.estado}
                      </span>
                    </td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11 }}>—</td>
                    <td className="mono" style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtK(oc.total_neto)}</td>
                    <td style={{ fontSize: 11, color: "var(--txt3)" }}>{fmtDate(oc.fecha_esperada)}</td>
                    <td>
                      {oc.pct_cumplimiento != null ? (
                        <span className="mono" style={{ fontSize: 11, color: oc.pct_cumplimiento >= 100 ? "var(--green)" : "var(--amber)" }}>{oc.pct_cumplimiento}%</span>
                      ) : oc.estado === "CERRADA" ? (
                        <span style={{ fontSize: 10, color: "var(--green)" }}>100%</span>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--txt3)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Nueva OC */}
      {modalNueva && (
        <div onClick={() => !procesando && setModalNueva(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 14, padding: 24, maxWidth: 900, width: "100%", maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>+ Nueva orden de compra</h3>
              <button onClick={() => setModalNueva(false)} disabled={procesando}
                style={{ background: "var(--bg4)", border: "none", color: "var(--txt)", padding: "4px 10px", borderRadius: 6, cursor: procesando ? "wait" : "pointer" }}>✕</button>
            </div>

            {/* Header: proveedor, fecha esperada, notas */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Proveedor *</label>
                <input
                  type="text"
                  list="proveedor-list"
                  value={nuevaProveedor}
                  onChange={(e) => setNuevaProveedor(e.target.value)}
                  placeholder="Idetex, Verbo Divino, etc"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12 }}
                />
                <datalist id="proveedor-list">
                  {Array.from(new Set(Array.from(proveedorCatalogo.values()).map(p => p.proveedor))).sort().map(p => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Fecha esperada</label>
                <input
                  type="date"
                  value={nuevaFechaEsperada}
                  onChange={(e) => setNuevaFechaEsperada(e.target.value)}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12 }}
                />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Notas (opcional)</label>
              <input
                type="text"
                value={nuevaNotas}
                onChange={(e) => setNuevaNotas(e.target.value)}
                placeholder="Ej: pedido reposición temporada invierno"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12 }}
              />
            </div>

            {/* Agregar línea */}
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                list="sku-catalogo-list"
                value={skuBusqueda}
                onChange={(e) => setSkuBusqueda(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter" && skuBusqueda.trim()) agregarLinea(skuBusqueda); }}
                placeholder="Tipea SKU y Enter (autocompletará precio si está en catálogo)"
                style={{ flex: 1, padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12 }}
              />
              <datalist id="sku-catalogo-list">
                {Array.from(proveedorCatalogo.entries())
                  .filter(([, v]) => !nuevaProveedor || v.proveedor === nuevaProveedor)
                  .slice(0, 100)
                  .map(([sku, v]) => (
                    <option key={sku} value={sku}>{v.nombre} — {fmtMoney(v.precio_neto)}</option>
                  ))}
              </datalist>
              <button
                onClick={() => agregarLinea(skuBusqueda)}
                disabled={!skuBusqueda.trim()}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--cyan)", color: "#0a0e17", fontWeight: 700, fontSize: 11, border: "none", cursor: "pointer" }}>
                + Agregar
              </button>
            </div>

            {/* Tabla de líneas */}
            {nuevaLineas.length > 0 ? (
              <div style={{ overflowX: "auto", marginBottom: 16 }}>
                <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Nombre</th>
                      <th style={{ textAlign: "right", width: 90 }}>Cantidad</th>
                      <th style={{ textAlign: "right", width: 120 }}>Precio neto</th>
                      <th style={{ textAlign: "right", width: 120 }}>Subtotal</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {nuevaLineas.map((l, i) => (
                      <tr key={i}>
                        <td className="mono" style={{ fontSize: 10, fontWeight: 600 }}>{l.sku_origen}</td>
                        <td style={{ fontSize: 10, color: "var(--txt2)" }}>{l.nombre || <span style={{ color: "var(--amber)" }}>sin nombre</span>}</td>
                        <td>
                          <input
                            type="number"
                            value={l.cantidad_pedida}
                            onChange={(e) => updateLinea(i, "cantidad_pedida", parseInt(e.target.value) || 0)}
                            style={{ width: "100%", padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11, textAlign: "right" }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={l.costo_unitario}
                            onChange={(e) => updateLinea(i, "costo_unitario", parseFloat(e.target.value) || 0)}
                            style={{ width: "100%", padding: "4px 6px", borderRadius: 4, background: "var(--bg2)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 11, textAlign: "right" }}
                          />
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>
                          {fmtMoney(l.cantidad_pedida * l.costo_unitario)}
                        </td>
                        <td>
                          <button onClick={() => removerLinea(i)}
                            style={{ background: "var(--bg3)", border: "1px solid var(--red)", color: "var(--red)", padding: "2px 6px", borderRadius: 4, fontSize: 10, cursor: "pointer" }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: "2px solid var(--bg4)" }}>
                      <td colSpan={4} style={{ textAlign: "right", fontSize: 11, fontWeight: 600, color: "var(--txt3)", padding: "8px 4px" }}>Subtotal neto:</td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>
                        {fmtMoney(nuevaLineas.reduce((s, l) => s + l.cantidad_pedida * l.costo_unitario, 0))}
                      </td>
                      <td></td>
                    </tr>
                    <tr>
                      <td colSpan={4} style={{ textAlign: "right", fontSize: 11, color: "var(--txt3)", padding: "4px" }}>IVA 19%:</td>
                      <td className="mono" style={{ textAlign: "right", color: "var(--txt2)" }}>
                        {fmtMoney(Math.round(nuevaLineas.reduce((s, l) => s + l.cantidad_pedida * l.costo_unitario, 0) * 0.19))}
                      </td>
                      <td></td>
                    </tr>
                    <tr>
                      <td colSpan={4} style={{ textAlign: "right", fontSize: 12, fontWeight: 700, padding: "4px" }}>TOTAL BRUTO:</td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: "var(--green)" }}>
                        {fmtMoney(Math.round(nuevaLineas.reduce((s, l) => s + l.cantidad_pedida * l.costo_unitario, 0) * 1.19))}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: 32, color: "var(--txt3)", fontSize: 12, marginBottom: 16, border: "1px dashed var(--bg4)", borderRadius: 8 }}>
                Tipea el SKU del primer producto y presioná Enter
              </div>
            )}

            {/* Botones de acción */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--bg4)", paddingTop: 16 }}>
              <button onClick={() => setModalNueva(false)} disabled={procesando}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: procesando ? "wait" : "pointer" }}>
                Cancelar
              </button>
              <button onClick={() => crearNuevaOC("BORRADOR")} disabled={procesando || nuevaLineas.length === 0}
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11, fontWeight: 600, cursor: procesando ? "wait" : "pointer", opacity: nuevaLineas.length === 0 ? 0.5 : 1 }}>
                Guardar como borrador
              </button>
              <button onClick={() => crearNuevaOC("PENDIENTE")} disabled={procesando || nuevaLineas.length === 0 || !nuevaProveedor.trim()}
                title="Crea la OC y CONGELA el precio acordado de cada línea inmediatamente"
                style={{ padding: "8px 16px", borderRadius: 6, background: "var(--green)", color: "#0a0e17", border: "none", fontSize: 11, fontWeight: 700, cursor: procesando ? "wait" : "pointer", opacity: (nuevaLineas.length === 0 || !nuevaProveedor.trim()) ? 0.5 : 1 }}>
                {procesando ? "Creando…" : "Confirmar (congela precios)"}
              </button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
