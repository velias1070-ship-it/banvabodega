"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { getSupabase } from "@/lib/supabase";
import { fetchProductos, upsertProducto, DBProduct, DBComposicionVenta } from "@/lib/db";
import { getCategorias, getProveedores } from "@/lib/store";

// ── Tipos ──

interface MLItem {
  id?: string;
  sku: string;
  item_id: string;
  variation_id: number | null;
  inventory_id: string | null;
  sku_venta: string | null;
  sku_origen: string | null;
  titulo: string | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  activo: boolean;
  user_product_id: string | null;
  updated_at: string | null;
}

interface ProductoMatch {
  sku: string;
  sku_venta: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  score: number; // match score para ordenar
}

interface NuevoProductoForm {
  sku_origen: string;
  sku_venta: string;
  nombre: string;
  categoria: string;
  proveedor: string;
  costo: number;
  unidades: number;
}

// ── Helpers ──

/** Tokeniza un texto en palabras normalizadas */
function tokenize(text: string): string[] {
  return text.toUpperCase().replace(/[^A-Z0-9ÁÉÍÓÚÑ ]/g, " ").split(/\s+/).filter(t => t.length > 2);
}

/** Calcula score de match entre título ML y nombre de producto */
function matchScore(tituloML: string, nombreProducto: string): number {
  const tokensML = tokenize(tituloML);
  const tokensProd = tokenize(nombreProducto);
  if (tokensML.length === 0 || tokensProd.length === 0) return 0;
  let hits = 0;
  for (const t of tokensML) {
    if (tokensProd.some(p => p.includes(t) || t.includes(p))) hits++;
  }
  return hits / Math.max(tokensML.length, 1);
}

// ── Componente principal ──

export default function AdminMLSinVincular() {
  const [items, setItems] = useState<MLItem[]>([]);
  const [ignorados, setIgnorados] = useState<MLItem[]>([]);
  const [productos, setProductos] = useState<DBProduct[]>([]);
  const [composiciones, setComposiciones] = useState<DBComposicionVenta[]>([]);
  const [loading, setLoading] = useState(true);
  const [mostrarIgnorados, setMostrarIgnorados] = useState(false);

  // Modal vincular
  const [vincularItem, setVincularItem] = useState<MLItem | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [vinculando, setVinculando] = useState(false);
  const [vinculResult, setVinculResult] = useState<string | null>(null);

  // Modal crear nuevo
  const [crearItem, setCrearItem] = useState<MLItem | null>(null);
  const [nuevoForm, setNuevoForm] = useState<NuevoProductoForm>({
    sku_origen: "", sku_venta: "", nombre: "", categoria: getCategorias()[0] || "Otros",
    proveedor: getProveedores()[0] || "Otro", costo: 0, unidades: 1,
  });
  const [creando, setCreando] = useState(false);
  const [crearResult, setCrearResult] = useState<string | null>(null);

  // ── Cargar datos ──
  const cargar = useCallback(async () => {
    setLoading(true);
    const sb = getSupabase();
    if (!sb) { setLoading(false); return; }

    const [itemsRes, prodRes, compRes] = await Promise.all([
      sb.from("ml_items_map").select("*").is("sku_venta", null).order("titulo"),
      fetchProductos(),
      sb.from("composicion_venta").select("*"),
    ]);

    const allItems = (itemsRes.data || []) as MLItem[];
    setItems(allItems.filter(i => i.activo !== false));
    setIgnorados(allItems.filter(i => i.activo === false));
    setProductos(prodRes);
    setComposiciones((compRes.data || []) as DBComposicionVenta[]);
    setLoading(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // ── KPIs ──
  const totalUnidades = useMemo(() =>
    items.reduce((s: number, i: MLItem) => s + (i.available_quantity || 0), 0), [items]);

  // ── Matches sugeridos para el modal de vincular ──
  const sugerencias = useMemo((): ProductoMatch[] => {
    if (!vincularItem?.titulo) return [];
    const titulo = vincularItem.titulo;

    // Construir lista de SKU ventas disponibles (productos + composiciones)
    const matches: ProductoMatch[] = [];
    const seen = new Set<string>();

    for (const p of productos) {
      const key = p.sku.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const score = matchScore(titulo, p.nombre || "");
      matches.push({ sku: p.sku, sku_venta: p.sku_venta || p.sku, nombre: p.nombre, categoria: p.categoria, proveedor: p.proveedor, score });

      // También agregar cada SKU venta individual si es comma-separated
      if (p.sku_venta) {
        for (const sv of p.sku_venta.split(",")) {
          const trimmed = sv.trim().toUpperCase();
          if (trimmed && !seen.has(trimmed) && trimmed !== key) {
            seen.add(trimmed);
            const svScore = matchScore(titulo, p.nombre || "");
            matches.push({ sku: p.sku, sku_venta: trimmed, nombre: p.nombre + ` (${trimmed})`, categoria: p.categoria, proveedor: p.proveedor, score: svScore });
          }
        }
      }
    }

    // Ordenar por score desc
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }, [vincularItem, productos]);

  // Filtrar sugerencias con búsqueda
  const sugerenciasFiltradas = useMemo(() => {
    if (!busqueda.trim()) return sugerencias;
    const q = busqueda.toUpperCase().trim();
    return sugerencias.filter((m: ProductoMatch) =>
      m.sku.toUpperCase().includes(q) ||
      m.sku_venta.toUpperCase().includes(q) ||
      m.nombre.toUpperCase().includes(q)
    );
  }, [sugerencias, busqueda]);

  // ── Acciones ──

  /** Vincular item a un SKU existente */
  const vincular = useCallback(async (item: MLItem, match: ProductoMatch) => {
    setVinculando(true);
    setVinculResult(null);
    const sb = getSupabase();
    if (!sb) { setVinculando(false); return; }

    try {
      const skuVenta = match.sku_venta.toUpperCase().trim();
      const skuOrigen = match.sku.toUpperCase().trim();
      const inventoryId = item.inventory_id;

      // 1. Actualizar ml_items_map
      await sb.from("ml_items_map")
        .update({ sku_venta: skuVenta, sku_origen: skuOrigen, updated_at: new Date().toISOString() })
        .eq("item_id", item.item_id)
        .eq("sku", item.sku);

      // 2. Verificar/crear composicion_venta con el codigo_ml
      if (inventoryId) {
        const { data: existingComp } = await sb.from("composicion_venta")
          .select("*")
          .eq("sku_venta", skuVenta)
          .eq("codigo_ml", inventoryId.toUpperCase());

        if (!existingComp || existingComp.length === 0) {
          // No existe composicion con este codigo_ml → crear
          await sb.from("composicion_venta").upsert({
            sku_venta: skuVenta,
            sku_origen: skuOrigen,
            codigo_ml: inventoryId.toUpperCase(),
            unidades: 1,
          }, { onConflict: "sku_venta,sku_origen" });
        }
      }

      // 3. Escribir stock_full_cache
      if (item.available_quantity != null && item.available_quantity > 0) {
        await sb.from("stock_full_cache").upsert({
          sku_venta: skuVenta,
          cantidad: item.available_quantity,
          fuente: "ml_sync",
          updated_at: new Date().toISOString(),
        }, { onConflict: "sku_venta" });
      }

      // 4. Disparar recálculo de inteligencia para el SKU origen
      try {
        await fetch("/api/intelligence/recalcular", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skus: [skuOrigen] }),
        });
      } catch { /* non-critical */ }

      setVinculResult(`Vinculado: ${item.titulo} → ${skuVenta}`);
      setVincularItem(null);
      setBusqueda("");
      await cargar();
    } catch (err) {
      setVinculResult(`Error: ${err}`);
    }
    setVinculando(false);
  }, [cargar]);

  /** Crear nuevo producto y vincular */
  const crearNuevo = useCallback(async () => {
    if (!crearItem || !nuevoForm.sku_origen.trim() || !nuevoForm.sku_venta.trim()) return;
    setCreando(true);
    setCrearResult(null);
    const sb = getSupabase();
    if (!sb) { setCreando(false); return; }

    try {
      const skuOrigen = nuevoForm.sku_origen.toUpperCase().trim();
      const skuVenta = nuevoForm.sku_venta.toUpperCase().trim();
      const inventoryId = crearItem.inventory_id;

      // 1. Crear producto
      const newProd: DBProduct = {
        sku: skuOrigen,
        sku_venta: skuVenta,
        codigo_ml: inventoryId || "",
        nombre: nuevoForm.nombre,
        categoria: nuevoForm.categoria,
        proveedor: nuevoForm.proveedor,
        costo: nuevoForm.costo,
        costo_promedio: nuevoForm.costo,
        precio: 0,
        reorder: 20,
        requiere_etiqueta: false,
        tamano: "",
        color: "",
      };
      await upsertProducto(newProd);

      // 2. Crear composicion_venta
      if (inventoryId) {
        await sb.from("composicion_venta").upsert({
          sku_venta: skuVenta,
          sku_origen: skuOrigen,
          codigo_ml: inventoryId.toUpperCase(),
          unidades: nuevoForm.unidades,
        }, { onConflict: "sku_venta,sku_origen" });
      }

      // 3. Actualizar ml_items_map
      await sb.from("ml_items_map")
        .update({ sku_venta: skuVenta, sku_origen: skuOrigen, updated_at: new Date().toISOString() })
        .eq("item_id", crearItem.item_id)
        .eq("sku", crearItem.sku);

      // 4. Escribir stock_full_cache
      if (crearItem.available_quantity != null && crearItem.available_quantity > 0) {
        await sb.from("stock_full_cache").upsert({
          sku_venta: skuVenta,
          cantidad: crearItem.available_quantity,
          fuente: "ml_sync",
          updated_at: new Date().toISOString(),
        }, { onConflict: "sku_venta" });
      }

      // 5. Disparar recálculo de inteligencia
      try {
        await fetch("/api/intelligence/recalcular", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skus: [skuOrigen] }),
        });
      } catch { /* non-critical */ }

      setCrearResult(`Producto creado: ${skuOrigen} y vinculado`);
      setCrearItem(null);
      await cargar();
    } catch (err) {
      setCrearResult(`Error: ${err}`);
    }
    setCreando(false);
  }, [crearItem, nuevoForm, cargar]);

  /** Ignorar item */
  const ignorar = useCallback(async (item: MLItem) => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("ml_items_map")
      .update({ activo: false, updated_at: new Date().toISOString() })
      .eq("item_id", item.item_id)
      .eq("sku", item.sku);
    await cargar();
  }, [cargar]);

  /** Reactivar item ignorado */
  const reactivar = useCallback(async (item: MLItem) => {
    const sb = getSupabase();
    if (!sb) return;
    await sb.from("ml_items_map")
      .update({ activo: true, updated_at: new Date().toISOString() })
      .eq("item_id", item.item_id)
      .eq("sku", item.sku);
    await cargar();
  }, [cargar]);

  /** Abrir modal de crear nuevo con datos prellenados */
  const abrirCrear = useCallback((item: MLItem) => {
    setCrearItem(item);
    setNuevoForm({
      sku_origen: "",
      sku_venta: "",
      nombre: item.titulo || "",
      categoria: getCategorias()[0] || "Otros",
      proveedor: getProveedores()[0] || "Otro",
      costo: 0,
      unidades: 1,
    });
    setCrearResult(null);
  }, []);

  // ── Si no hay items pendientes, no mostrar nada ──
  if (loading) return null;
  if (items.length === 0 && ignorados.length === 0) return null;

  const categorias = getCategorias();
  const proveedores = getProveedores();

  // ── Estilos ──
  const cardStyle: React.CSSProperties = {
    background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 14,
    padding: 16, marginBottom: 16,
  };
  const kpiStyle: React.CSSProperties = {
    background: "var(--amberBg)", border: "1px solid var(--amberBd)", borderRadius: 10,
    padding: "10px 16px", display: "flex", alignItems: "center", gap: 8,
    fontSize: 13, fontWeight: 600, color: "var(--amber)",
  };
  const btnStyle = (bg: string, color: string, bd: string): React.CSSProperties => ({
    padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
    background: bg, color, border: `1px solid ${bd}`, cursor: "pointer",
  });
  const modalOverlay: React.CSSProperties = {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    background: "rgba(0,0,0,0.7)", zIndex: 1000,
    display: "flex", alignItems: "center", justifyContent: "center",
  };
  const modalContent: React.CSSProperties = {
    background: "var(--bg2)", borderRadius: 14, border: "1px solid var(--bg4)",
    padding: 24, maxWidth: 600, width: "90%", maxHeight: "80vh", overflowY: "auto",
  };

  return (
    <div style={cardStyle}>
      {/* KPI Banner */}
      <div style={kpiStyle}>
        <span>⚠️</span>
        <span>{items.length} items ML sin vincular — {totalUnidades} uds invisibles en Full</span>
      </div>

      {/* Resultado de acciones */}
      {vinculResult && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, fontWeight: 600, margin: "8px 0", border: "1px solid var(--greenBd)" }}>
          {vinculResult}
        </div>
      )}
      {crearResult && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, fontWeight: 600, margin: "8px 0", border: "1px solid var(--greenBd)" }}>
          {crearResult}
        </div>
      )}

      {/* Tabla de items sin vincular */}
      {items.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--bg4)" }}>
                <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--txt3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600 }}>Título ML</th>
                <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--txt3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600 }}>Item ID</th>
                <th style={{ textAlign: "left", padding: "8px 6px", color: "var(--txt3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600 }}>Inv. ID</th>
                <th style={{ textAlign: "right", padding: "8px 6px", color: "var(--txt3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600 }}>Stock Full</th>
                <th style={{ textAlign: "right", padding: "8px 6px", color: "var(--txt3)", fontSize: 10, textTransform: "uppercase", fontWeight: 600 }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.item_id}-${item.variation_id || ""}`} style={{ borderBottom: "1px solid var(--bg3)" }}>
                  <td style={{ padding: "8px 6px", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--txt)" }}>{item.titulo || "—"}</td>
                  <td style={{ padding: "8px 6px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--txt2)" }}>{item.item_id}</td>
                  <td style={{ padding: "8px 6px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--txt2)" }}>{item.inventory_id || "—"}</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", fontFamily: "JetBrains Mono, monospace", fontWeight: 600, color: (item.available_quantity || 0) > 0 ? "var(--green)" : "var(--txt3)" }}>{item.available_quantity ?? 0}</td>
                  <td style={{ padding: "8px 6px", textAlign: "right", display: "flex", gap: 4, justifyContent: "flex-end" }}>
                    <button onClick={() => { setVincularItem(item); setBusqueda(""); setVinculResult(null); }} style={btnStyle("var(--cyanBg)", "var(--cyan)", "var(--cyanBd)")}>Vincular</button>
                    <button onClick={() => abrirCrear(item)} style={btnStyle("var(--blueBg)", "var(--blue)", "var(--blueBd)")}>Crear nuevo</button>
                    <button onClick={() => ignorar(item)} style={btnStyle("var(--bg3)", "var(--txt3)", "var(--bg4)")}>Ignorar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Toggle ignorados */}
      {ignorados.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => setMostrarIgnorados(!mostrarIgnorados)}
            style={{ background: "none", border: "none", color: "var(--txt3)", fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
          >
            {mostrarIgnorados ? "Ocultar" : "Mostrar"} {ignorados.length} ignorados
          </button>
          {mostrarIgnorados && (
            <div style={{ overflowX: "auto", marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, opacity: 0.7 }}>
                <tbody>
                  {ignorados.map((item) => (
                    <tr key={`ign-${item.item_id}-${item.variation_id || ""}`} style={{ borderBottom: "1px solid var(--bg3)" }}>
                      <td style={{ padding: "6px", color: "var(--txt3)" }}>{item.titulo || "—"}</td>
                      <td style={{ padding: "6px", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "var(--txt3)" }}>{item.item_id}</td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        <button onClick={() => reactivar(item)} style={btnStyle("var(--bg3)", "var(--txt2)", "var(--bg4)")}>Reactivar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══ Modal Vincular ═══ */}
      {vincularItem && (
        <div style={modalOverlay} onClick={() => setVincularItem(null)}>
          <div style={modalContent} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "var(--txt)" }}>Vincular item ML</h3>
            <div style={{ fontSize: 12, color: "var(--txt2)", marginBottom: 12 }}>
              <strong>{vincularItem.titulo}</strong>
              <span style={{ marginLeft: 8, fontFamily: "JetBrains Mono, monospace", color: "var(--txt3)", fontSize: 11 }}>
                {vincularItem.item_id} · {vincularItem.inventory_id || "sin inv_id"} · {vincularItem.available_quantity ?? 0} uds
              </span>
            </div>

            {/* Buscador */}
            <input
              type="text"
              placeholder="Buscar por nombre o SKU..."
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: 8,
                background: "var(--bg3)", border: "1px solid var(--bg4)",
                color: "var(--txt)", fontSize: 13, outline: "none", boxSizing: "border-box",
                marginBottom: 12,
              }}
              autoFocus
            />

            {/* Lista de matches */}
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              {sugerenciasFiltradas.slice(0, 50).map((m, idx) => (
                <div
                  key={`${m.sku}-${m.sku_venta}-${idx}`}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: 8, marginBottom: 4,
                    background: m.score >= 0.3 ? "var(--cyanBg)" : "var(--bg3)",
                    border: m.score >= 0.3 ? "1px solid var(--cyanBd)" : "1px solid var(--bg4)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.nombre}
                      {m.score >= 0.3 && (
                        <span style={{ marginLeft: 6, fontSize: 9, padding: "2px 6px", borderRadius: 4, background: "var(--cyan)", color: "#000", fontWeight: 700 }}>Match sugerido</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--txt3)", fontFamily: "JetBrains Mono, monospace", marginTop: 2 }}>
                      SKU: {m.sku} · Venta: {m.sku_venta} · {m.categoria} · {m.proveedor}
                    </div>
                  </div>
                  <button
                    onClick={() => vincular(vincularItem, m)}
                    disabled={vinculando}
                    style={{
                      ...btnStyle("var(--cyan)", "#000", "var(--cyanBd)"),
                      padding: "6px 14px", fontSize: 12, flexShrink: 0, marginLeft: 8,
                      opacity: vinculando ? 0.5 : 1,
                    }}
                  >
                    {vinculando ? "..." : "Seleccionar"}
                  </button>
                </div>
              ))}
              {sugerenciasFiltradas.length === 0 && (
                <div style={{ padding: 16, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>
                  No se encontraron productos. Intenta otra búsqueda o crea uno nuevo.
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => setVincularItem(null)} style={btnStyle("var(--bg3)", "var(--txt2)", "var(--bg4)")}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Modal Crear Nuevo ═══ */}
      {crearItem && (
        <div style={modalOverlay} onClick={() => setCrearItem(null)}>
          <div style={modalContent} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "var(--txt)" }}>Crear producto nuevo</h3>
            <div style={{ fontSize: 12, color: "var(--txt2)", marginBottom: 16 }}>
              <strong>{crearItem.titulo}</strong>
              <span style={{ marginLeft: 8, fontFamily: "JetBrains Mono, monospace", color: "var(--txt3)", fontSize: 11 }}>
                {crearItem.item_id} · {crearItem.inventory_id || "sin inv_id"} · {crearItem.available_quantity ?? 0} uds
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {/* SKU Origen */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>SKU Origen *</label>
                <input
                  type="text"
                  value={nuevoForm.sku_origen}
                  onChange={e => setNuevoForm({ ...nuevoForm, sku_origen: e.target.value })}
                  placeholder="Ej: TXV23QLRM20GR"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "JetBrains Mono, monospace" }}
                />
              </div>
              {/* SKU Venta */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>SKU Venta *</label>
                <input
                  type="text"
                  value={nuevoForm.sku_venta}
                  onChange={e => setNuevoForm({ ...nuevoForm, sku_venta: e.target.value })}
                  placeholder="Igual que origen si no es pack"
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "JetBrains Mono, monospace" }}
                />
              </div>
              {/* Nombre */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Nombre</label>
                <input
                  type="text"
                  value={nuevoForm.nombre}
                  onChange={e => setNuevoForm({ ...nuevoForm, nombre: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* Código ML (readonly) */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Código ML (inventory_id)</label>
                <input
                  type="text"
                  value={crearItem.inventory_id || ""}
                  readOnly
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--bg4)", color: "var(--txt3)", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "JetBrains Mono, monospace" }}
                />
              </div>
              {/* Categoría */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Categoría</label>
                <select
                  value={nuevoForm.categoria}
                  onChange={e => setNuevoForm({ ...nuevoForm, categoria: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none" }}
                >
                  {categorias.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {/* Proveedor */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Proveedor</label>
                <select
                  value={nuevoForm.proveedor}
                  onChange={e => setNuevoForm({ ...nuevoForm, proveedor: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none" }}
                >
                  {proveedores.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              {/* Costo neto */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Costo neto</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={nuevoForm.costo}
                  onChange={e => setNuevoForm({ ...nuevoForm, costo: Number(e.target.value) || 0 })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "JetBrains Mono, monospace" }}
                />
              </div>
              {/* Unidades por pack */}
              <div>
                <label style={{ display: "block", fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 4 }}>Uds por pack</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={nuevoForm.unidades}
                  onChange={e => setNuevoForm({ ...nuevoForm, unidades: Number(e.target.value) || 1 })}
                  min={1}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", fontSize: 12, outline: "none", boxSizing: "border-box", fontFamily: "JetBrains Mono, monospace" }}
                />
              </div>
            </div>

            {crearResult && (
              <div style={{ padding: "8px 12px", borderRadius: 8, background: crearResult.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)", color: crearResult.startsWith("Error") ? "var(--red)" : "var(--green)", fontSize: 12, fontWeight: 600, marginTop: 12, border: `1px solid ${crearResult.startsWith("Error") ? "var(--redBd)" : "var(--greenBd)"}` }}>
              {crearResult}
            </div>
            )}

            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setCrearItem(null)} style={btnStyle("var(--bg3)", "var(--txt2)", "var(--bg4)")}>Cancelar</button>
              <button
                onClick={crearNuevo}
                disabled={creando || !nuevoForm.sku_origen.trim() || !nuevoForm.sku_venta.trim()}
                style={{
                  ...btnStyle("var(--green)", "#000", "var(--greenBd)"),
                  padding: "8px 20px", fontSize: 13,
                  opacity: (creando || !nuevoForm.sku_origen.trim() || !nuevoForm.sku_venta.trim()) ? 0.5 : 1,
                }}
              >
                {creando ? "Creando..." : "Crear y vincular"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
