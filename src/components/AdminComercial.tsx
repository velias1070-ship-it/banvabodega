"use client";
import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { fetchMLItemsMap, fetchStockDisponible } from "@/lib/db";
import type { DBMLItemMap } from "@/lib/db";
import { getStore, skuTotal } from "@/lib/store";

// ==================== TYPES ====================

type ComercialView = "listado" | "nueva" | "variantes" | "precios";

interface MLItemDetail {
  code: number;
  body: {
    id: string;
    title: string;
    price: number;
    status: string;
    thumbnail: string;
    permalink: string;
    available_quantity: number;
    sold_quantity: number;
    listing_type_id: string;
    condition: string;
    category_id: string;
    variations?: Array<{
      id: number;
      price: number;
      available_quantity: number;
      picture_ids: string[];
      attribute_combinations: Array<{ id: string; name: string; value_name: string }>;
    }>;
    pictures?: Array<{ id: string; url: string; secure_url: string }>;
  };
}

interface MLCategoryResult {
  category_id: string;
  category_name: string;
  domain_id: string;
  domain_name: string;
  attributes?: Array<{ id: string; name: string }>;
}

interface MLAttribute {
  id: string;
  name: string;
  value_type: string;
  tags: Record<string, unknown>;
  values: Array<{ id: string; name: string }>;
  attribute_group_id: string;
  attribute_group_name: string;
}

const fmt = (n: number) => "$" + n.toLocaleString("es-CL");

// ==================== MAIN COMPONENT ====================

export default function AdminComercial() {
  const [view, setView] = useState<ComercialView>("listado");
  const [targetItemId, setTargetItemId] = useState<string | null>(null);

  const goToVariantes = (itemId: string) => {
    setTargetItemId(itemId);
    setView("variantes");
  };

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16 }}>
        {([["listado", "Mis Publicaciones", "📋"], ["precios", "Precios y Promos", "💰"], ["nueva", "Nueva Publicación", "➕"], ["variantes", "Agregar Variantes", "🔀"]] as const).map(([key, label, icon], i, arr) => (
          <button key={key} onClick={() => { setView(key); if (key !== "variantes") setTargetItemId(null); }}
            style={{
              flex: 1, padding: "10px 8px", fontSize: 12, fontWeight: view === key ? 700 : 500,
              background: view === key ? "var(--bg3)" : "transparent",
              color: view === key ? "var(--cyan)" : "var(--txt3)",
              border: "1px solid var(--bg4)",
              borderRadius: i === 0 ? "8px 0 0 8px" : i === arr.length - 1 ? "0 8px 8px 0" : 0,
              cursor: "pointer",
            }}>
            {icon} {label}
          </button>
        ))}
      </div>

      {view === "listado" && <MisPublicaciones onAddVariante={goToVariantes} />}
      {view === "precios" && <PreciosYPromos />}
      {view === "nueva" && <NuevaPublicacion />}
      {view === "variantes" && <AgregarVariantes preselectedItemId={targetItemId} />}
    </div>
  );
}

// ==================== MIS PUBLICACIONES ====================

function MisPublicaciones({ onAddVariante }: { onAddVariante: (itemId: string) => void }) {
  const [items, setItems] = useState<DBMLItemMap[]>([]);
  const [liveData, setLiveData] = useState<Map<string, MLItemDetail["body"]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "paused" | "closed" | "paused_with_stock">("all");
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stockDisponible, setStockDisponible] = useState<Map<string, number>>(new Map());
  // Editar item
  const [editItem, setEditItem] = useState<{ item_id: string; title: string; color: string } | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [bulkSyncing, setBulkSyncing] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  // Promociones
  const [promoItems, setPromoItems] = useState<Array<{ item_id: string; sku: string; titulo: string; price_ml: number; costo_neto: number; costo_bruto: number; comision_ml: number; costo_envio: number; listing_type: string; category_id: string; promotions: Array<{ id?: string; type: string; name?: string; status: string; price: number; original_price: number; meli_percentage?: number; seller_percentage?: number; start_date?: string; finish_date?: string; comision_promo?: number }> }>>([]);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoFamily, setPromoFamily] = useState<string | null>(null);
  const [promoFamilyItems, setPromoFamilyItems] = useState<DBMLItemMap[]>([]);
  const [promoActioning, setPromoActioning] = useState<string | null>(null);
  // Modal de simulación de precio
  const [simItem, setSimItem] = useState<{ item_id: string; sku: string; titulo: string; costo_bruto: number; comision_ml: number; costo_envio: number; price_ml: number; promo: { id?: string; type: string; price: number; original_price: number }; listing_type: string; category_id: string } | null>(null);
  const [simPrice, setSimPrice] = useState("");
  const [simComision, setSimComision] = useState(0);
  const [simLoadingFee, setSimLoadingFee] = useState(false);
  const simTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSimulator = (item: typeof promoItems[0], promo: typeof promoItems[0]["promotions"][0]) => {
    const defaultPrice = promo.price > 0 ? promo.price : Math.round(item.price_ml * 0.8);
    setSimItem({ item_id: item.item_id, sku: item.sku, titulo: item.titulo, costo_bruto: item.costo_bruto, comision_ml: item.comision_ml, costo_envio: item.costo_envio, price_ml: item.price_ml, promo, listing_type: item.listing_type, category_id: item.category_id });
    setSimPrice(String(defaultPrice));
    // Calcular comisión para el precio default
    setSimComision(0);
    fetchComision(defaultPrice, item.listing_type, item.category_id);
  };

  const fetchComision = (price: number, listingType: string, categoryId: string) => {
    if (simTimeout.current) clearTimeout(simTimeout.current);
    simTimeout.current = setTimeout(async () => {
      if (price <= 0 || !categoryId) return;
      setSimLoadingFee(true);
      try {
        const res = await fetch(`/api/ml/promotions?fee_price=${price}&listing_type=${listingType}&category_id=${categoryId}`);
        const data = await res.json();
        setSimComision(data.fee || 0);
      } catch { /* ignore */ }
      setSimLoadingFee(false);
    }, 400);
  };

  const handleSimPriceChange = (val: string) => {
    setSimPrice(val);
    const p = parseInt(val);
    if (p > 0 && simItem) fetchComision(p, simItem.listing_type, simItem.category_id);
  };

  const confirmPostular = async () => {
    if (!simItem) return;
    const dealPrice = parseInt(simPrice);
    if (!dealPrice) return;
    setPromoActioning(simItem.item_id);
    try {
      const action = simItem.promo.type === "PRICE_DISCOUNT" ? "create_discount" : "join";
      const body: Record<string, unknown> = { item_id: simItem.item_id, action, deal_price: dealPrice };
      if (action === "create_discount") {
        body.start_date = new Date().toISOString().slice(0, 10) + "T00:00:00";
        body.finish_date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) + "T23:59:59";
      } else {
        body.promotion_id = simItem.promo.id;
        body.promotion_type = simItem.promo.type;
      }
      const res = await fetch("/api/ml/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) setActionError(`Error: ${data.error}`);
      else { setActionError(`Postulado exitosamente`); openPromos(promoFamily!, promoFamilyItems); }
    } catch (e) { setActionError(`Error: ${e instanceof Error ? e.message : "?"}`); }
    finally { setPromoActioning(null); setSimItem(null); }
  };

  const openPromos = async (familyKey: string, groupItems: DBMLItemMap[]) => {
    setPromoFamily(familyKey);
    setPromoFamilyItems(groupItems);
    setPromoLoading(true);
    setPromoItems([]);
    try {
      const ids = groupItems.map(i => i.item_id).join(",");
      const res = await fetch(`/api/ml/promotions?item_ids=${ids}`);
      const data = await res.json();
      setPromoItems(data.items || []);
    } catch { /* ignore */ }
    setPromoLoading(false);
  };

  const openPromosBySku = async (skuQuery: string) => {
    const q = skuQuery.trim().toUpperCase();
    const matched = items.filter(i => i.sku.toUpperCase().includes(q) || i.item_id.toUpperCase().includes(q));
    if (matched.length === 0) { setActionError(`No se encontró "${skuQuery}"`); return; }
    const unique = Array.from(new Map(matched.map(i => [i.item_id, i])).values());
    openPromos(unique.length === 1 ? (unique[0].titulo || unique[0].sku) : `${unique.length} items`, unique);
  };

  const [scanningPromos, setScanningPromos] = useState(false);
  const scanSinPromos = async () => {
    setScanningPromos(true);
    setActionError("Escaneando promociones de todos los items activos...");
    try {
      const res = await fetch("/api/ml/scan-promos?run=true");
      const data = await res.json();
      if (data.error) { setActionError(`Error: ${data.error}`); return; }
      const sinPromo = data.sin_promo || [];
      if (sinPromo.length === 0) {
        setActionError(`Todos los ${data.total} items activos tienen promo activa`);
      } else {
        setActionError(`${sinPromo.length} sin promo de ${data.total} activos (${data.con_promo} con promo)`);
        // Mapear a DBMLItemMap para abrir el modal
        const matched = sinPromo.map((sp: { item_id: string }) => items.find(i => i.item_id === sp.item_id)).filter(Boolean) as DBMLItemMap[];
        if (matched.length > 0) openPromos(`${matched.length} items sin promo activa`, matched);
      }
    } catch (e) { setActionError(`Error: ${e instanceof Error ? e.message : "?"}`); }
    finally { setScanningPromos(false); }
  };

  const bulkSyncAttrs = async (familyKey: string, groupItems: DBMLItemMap[], action: "design_from_color" | "color_from_design") => {
    const label = action === "color_from_design" ? "DISEÑO → COLOR" : "COLOR → DISEÑO";
    if (!confirm(`¿Copiar ${label} en ${groupItems.length} items de "${familyKey}"?`)) return;
    setBulkSyncing(familyKey);
    setBulkResult(null);
    try {
      const res = await fetch("/api/ml/bulk-attr-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: groupItems.map(i => i.item_id), action }),
      });
      const data = await res.json();
      if (data.error) {
        setActionError(`Error: ${data.error}`);
      } else {
        setActionError(`${data.ok} actualizados, ${data.failed} errores de ${data.total} items`);
        if (data.ok > 0) await loadItems();
      }
    } catch (e) {
      setActionError(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setBulkSyncing(null);
    }
  };

  const bulkSyncFromTitle = async (familyKey: string, groupItems: DBMLItemMap[]) => {
    const preview = groupItems.slice(0, 5).map(i => {
      const title = liveData.get(i.item_id)?.title || i.titulo || "";
      const variant = title.startsWith(familyKey) ? title.slice(familyKey.length).trim() : title.split(" ").pop() || "";
      return `  ${variant}`;
    }).join("\n");
    if (!confirm(`¿Poner Color y Diseño = nombre de variante en ${groupItems.length} items?\n\nEjemplo:\n${preview}${groupItems.length > 5 ? "\n  ..." : ""}`)) return;
    setBulkSyncing(familyKey);
    try {
      const res = await fetch("/api/ml/bulk-attr-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: groupItems.map(i => i.item_id), action: "from_variant_name", family_prefix: familyKey }),
      });
      const data = await res.json();
      if (data.error) {
        setActionError(`Error: ${data.error}`);
      } else {
        setActionError(`Nombres corregidos: ${data.ok} OK, ${data.failed} errores de ${data.total}`);
        if (data.ok > 0) await loadItems();
      }
    } catch (e) {
      setActionError(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setBulkSyncing(null);
    }
  };

  // Load available stock (on-hand minus reserved) + composicion for buffer calc
  const [composicion, setComposicion] = useState<Map<string, { sku_origen: string; unidades: number }>>(new Map());
  useEffect(() => {
    fetchStockDisponible().then(data => {
      const map = new Map<string, number>();
      for (const r of data) map.set(r.sku, r.disponible);
      setStockDisponible(map);
    });
    const sb = getStore();
    if (sb.composicion) {
      const map = new Map<string, { sku_origen: string; unidades: number }>();
      for (const c of sb.composicion) map.set(c.skuVenta, { sku_origen: c.skuOrigen, unidades: c.unidades });
      setComposicion(map);
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMLItemsMap();
      setItems(data);
      return data;
    } finally {
      setLoading(false);
    }
  }, []);

  // Load from DB on mount (instant — cron keeps ml_items_map updated every 30 min)
  useEffect(() => { loadItems(); }, [loadItems]);

  const refreshLive = useCallback(async () => {
    if (items.length === 0) return;
    setRefreshing(true);
    try {
      // Trigger server-side sync then reload
      await fetch("/api/ml/items-sync?run=1");
      await loadItems();
    } finally {
      setRefreshing(false);
    }
  }, [items, loadItems]);

  const toggleStatus = async (itemId: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    setActionLoading(itemId);
    setActionError(null);
    try {
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, updates: { status: newStatus } }),
      });
      const json = await res.json();
      if (res.ok && !json.error) {
        await loadItems();
        setLiveData(prev => {
          const next = new Map(prev);
          const existing = next.get(itemId);
          if (existing) next.set(itemId, { ...existing, status: newStatus });
          return next;
        });
      } else {
        const errMsg = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
        setActionError(`Error al ${newStatus === "active" ? "activar" : "pausar"} ${itemId}: ${errMsg}`);
      }
    } catch (err) {
      setActionError(`Error de red al ${newStatus === "active" ? "activar" : "pausar"} ${itemId}: ${String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const getDisponible = (sku: string) => stockDisponible.get(sku) ?? 0;

  /** Calculate what ML would publish (same formula as stock-sync) */
  const getPublicarML = (sku: string) => {
    const comp = composicion.get(sku);
    const skuOrigen = comp?.sku_origen || sku;
    const unidadesPack = comp?.unidades || 1;
    const disponibleOrigen = stockDisponible.get(skuOrigen) ?? 0;
    const buffer = 2; // simplified — stock-sync uses 4 for shared origins
    return Math.max(0, Math.floor((disponibleOrigen - buffer) / unidadesPack));
  };

  const activateWithStock = async (itemId: string, sku: string) => {
    const wmsStock = getDisponible(sku);
    if (wmsStock <= 0) {
      setActionError(`No hay stock en WMS para ${sku} — no se puede activar`);
      return;
    }
    setActionLoading(itemId);
    setActionError(null);
    try {
      const res = await fetch("/api/ml/activate-with-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, sku }),
      });
      const json = await res.json();
      if (json.ok) {
        await loadItems();
        setLiveData(prev => {
          const next = new Map(prev);
          const existing = next.get(itemId);
          if (existing) next.set(itemId, { ...existing, status: "active" });
          return next;
        });
      } else {
        const errMsg = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
        const stepsInfo = json.steps ? `\nPasos: ${json.steps.join(" → ")}` : "";
        setActionError(`${itemId}: ${errMsg}${stepsInfo}`);
      }
    } catch (err) {
      setActionError(`Error al activar con stock ${itemId}: ${String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const [editHasFamily, setEditHasFamily] = useState(false);
  const [editDesign, setEditDesign] = useState("");
  const [editOrigColor, setEditOrigColor] = useState("");
  const [editOrigDesign, setEditOrigDesign] = useState("");
  const [editLoadingAttrs, setEditLoadingAttrs] = useState(false);
  const openEditItem = async (itemId: string, currentTitle: string) => {
    setEditTitle(currentTitle);
    setEditColor("");
    setEditDesign("");
    setEditOrigColor("");
    setEditOrigDesign("");
    setEditSaving(false);
    setEditHasFamily(false);
    setEditLoadingAttrs(true);
    setEditItem({ item_id: itemId, title: currentTitle, color: "" });
    // Fetch all attributes from ML
    try {
      const res = await fetch(`/api/ml/items-details?ids=${itemId}`);
      const data = await res.json();
      const item = data?.items?.[0]?.body;
      if (item) {
        if (item.attributes) {
          for (const a of item.attributes) {
            if (a.id === "COLOR") { setEditColor(a.value_name || ""); setEditOrigColor(a.value_name || ""); }
            if (a.id === "FABRIC_DESIGN") { setEditDesign(a.value_name || ""); setEditOrigDesign(a.value_name || ""); }
          }
        }
        if (item.tags?.includes("user_product_listing")) setEditHasFamily(true);
      }
    } catch { /* ignore */ }
    setEditLoadingAttrs(false);
  };

  const saveEditItem = async () => {
    if (!editItem) return;
    setEditSaving(true);
    setActionError(null);
    try {
      // Items con family_name: solo se puede cambiar atributos, no título
      const updates: Record<string, unknown> = {};
      if (!editHasFamily && editTitle && editTitle !== editItem.title) updates.title = editTitle;
      const attrs: Array<{ id: string; value_name: string | null }> = [];
      if (editColor !== editOrigColor) attrs.push({ id: "COLOR", value_name: editColor || null });
      if (editDesign !== editOrigDesign) attrs.push({ id: "FABRIC_DESIGN", value_name: editDesign || null });
      if (attrs.length > 0) updates.attributes = attrs;
      if (Object.keys(updates).length === 0) { setEditItem(null); return; }
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: editItem.item_id, updates }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setActionError(`Error al editar: ${json.error || "desconocido"}`);
      } else {
        await loadItems();
        setEditItem(null);
      }
    } catch (e) {
      setActionError(`Error: ${e instanceof Error ? e.message : "desconocido"}`);
    } finally {
      setEditSaving(false);
    }
  };

  const closeItem = async (itemId: string) => {
    if (!confirm("¿Cerrar esta publicación? No se puede revertir.")) return;
    setActionLoading(itemId);
    try {
      await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, updates: { status: "closed" } }),
      });
      await loadItems();
    } finally {
      setActionLoading(null);
    }
  };

  // Deduplicate by item_id for display (multiple rows per variation)
  const uniqueItems = new Map<string, DBMLItemMap>();
  for (const item of items) {
    if (!uniqueItems.has(item.item_id)) uniqueItems.set(item.item_id, item);
  }
  const displayItems = Array.from(uniqueItems.values());

  const filtered = displayItems.filter(item => {
    const live = liveData.get(item.item_id);
    const status = live?.status || item.status_ml || "unknown";
    if (filter === "paused_with_stock") {
      if (status !== "paused") return false;
      const wmsStock = getDisponible(item.sku);
      if (wmsStock <= 0) return false;
    } else if (filter !== "all" && status !== filter) {
      return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const title = (live?.title || item.titulo || "").toLowerCase();
      const sku = item.sku.toLowerCase();
      const itemId = item.item_id.toLowerCase();
      if (!title.includes(q) && !sku.includes(q) && !itemId.includes(q)) return false;
    }
    return true;
  });

  // Agrupar por familia (items que comparten prefijo de título)
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const familyGroups = useMemo(() => {
    // Extraer familia: quitar últimas 1-2 palabras (color/diseño)
    const getFamilyKey = (title: string) => {
      const words = title.split(" ");
      if (words.length <= 3) return title;
      // Intentar con 1 palabra menos, luego 2
      return words.slice(0, -1).join(" ");
    };
    const groups = new Map<string, DBMLItemMap[]>();
    for (const item of filtered) {
      const title = liveData.get(item.item_id)?.title || item.titulo || "—";
      const key = getFamilyKey(title);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    // Ordenar: familias con más items primero cuando hay búsqueda, sino por nombre
    return Array.from(groups.entries()).sort((a, b) => {
      if (search) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered, liveData, search]);

  const toggleFamily = (key: string) => {
    setExpandedFamilies(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Auto-expandir cuando hay búsqueda
  useEffect(() => {
    if (search) {
      setExpandedFamilies(new Set(familyGroups.map(([k]) => k)));
    }
  }, [search, familyGroups]);

  const STATUS_COLORS: Record<string, string> = {
    active: "var(--green)", paused: "var(--amber)", closed: "var(--txt3)", under_review: "var(--blue)",
  };

  const getItemStatus = (i: DBMLItemMap) => liveData.get(i.item_id)?.status || i.status_ml || null;
  const itemsWithStatus = displayItems.filter(i => getItemStatus(i) !== null);
  const kpiActivos = itemsWithStatus.filter(i => getItemStatus(i) === "active").length;
  const kpiPausados = itemsWithStatus.filter(i => getItemStatus(i) === "paused").length;
  const kpiCerrados = itemsWithStatus.filter(i => getItemStatus(i) === "closed").length;
  const kpiPausadosConStock = itemsWithStatus.filter(i => getItemStatus(i) === "paused" && getDisponible(i.sku) > 0).length;
  const kpiPendientes = displayItems.length - itemsWithStatus.length;

  return (
    <div>
      {/* Header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>📋 Mis Publicaciones</h2>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>{displayItems.length} publicaciones en {familyGroups.length} familias</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="text" placeholder="Buscar SKU o título..." value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && search.trim()) openPromosBySku(search); }}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12, width: 180 }} />
            {search.trim() && (
              <button onClick={() => openPromosBySku(search)}
                style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--amber)", color: "#fff", border: "none", cursor: "pointer" }}>
                Promos
              </button>
            )}
            <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
              <option value="all">Todos</option>
              <option value="active">Activos</option>
              <option value="paused">Pausados</option>
              <option value="paused_with_stock">Pausados con stock</option>
              <option value="closed">Cerrados</option>
            </select>
            <button onClick={scanSinPromos} disabled={scanningPromos}
              style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--amber)", color: "#fff", border: "none", cursor: scanningPromos ? "wait" : "pointer" }}>
              {scanningPromos ? "Escaneando..." : "Sin promos"}
            </button>
            <button onClick={refreshLive} disabled={refreshing}
              style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: refreshing ? "wait" : "pointer" }}>
              {refreshing ? "Actualizando..." : "Refresh ML"}
            </button>
          </div>
        </div>
      </div>

      {/* KPI */}
      {displayItems.length > 0 && (
        <div className="kpi-grid" style={{ marginBottom: 16 }}>
          <div className="kpi"><div className="kpi-label">Total</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{displayItems.length}</div></div>
          <div className="kpi"><div className="kpi-label">Activos</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--green)" }}>{kpiActivos}{kpiPendientes > 0 && refreshing ? <span style={{ fontSize: 10, color: "var(--txt3)", fontWeight: 400 }}> ...</span> : null}</div></div>
          <div className="kpi"><div className="kpi-label">Pausados</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--amber)" }}>{kpiPausados}{kpiPendientes > 0 && refreshing ? <span style={{ fontSize: 10, color: "var(--txt3)", fontWeight: 400 }}> ...</span> : null}</div></div>
          <div className="kpi"><div className="kpi-label">Cerrados</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--txt3)" }}>{kpiCerrados}</div></div>
          <div className="kpi" style={{ cursor: "pointer", border: filter === "paused_with_stock" ? "1px solid var(--cyanBd)" : undefined }} onClick={() => setFilter(f => f === "paused_with_stock" ? "all" : "paused_with_stock")}><div className="kpi-label">Pausados c/stock</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--red)" }}>{kpiPausadosConStock}{kpiPendientes > 0 && refreshing ? <span style={{ fontSize: 10, color: "var(--txt3)", fontWeight: 400 }}> ...</span> : null}</div></div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando publicaciones...</div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{search || filter !== "all" ? "Sin resultados" : "No hay publicaciones vinculadas"}</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Usa "Refresh ML" para sincronizar o crea una nueva publicación</div>
        </div>
      ) : (
        <>
        {actionError && (
          <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "var(--redBg)", color: "var(--red)", fontSize: 12, border: "1px solid var(--redBd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
        )}
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th style={{ width: 40 }}></th>
                <th>Título / Variante</th>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "center" }}>ML</th>
                <th style={{ textAlign: "center" }}>WMS</th>
                <th style={{ textAlign: "center" }}>Vend</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {familyGroups.map(([familyKey, groupItems]) => {
                const isGroup = groupItems.length > 1;
                const expanded = expandedFamilies.has(familyKey);
                const groupActivos = groupItems.filter(i => (liveData.get(i.item_id)?.status || i.status_ml) === "active").length;
                const groupPausados = groupItems.filter(i => (liveData.get(i.item_id)?.status || i.status_ml) === "paused").length;
                const groupStockTotal = groupItems.reduce((s, i) => s + getDisponible(i.sku), 0);

                // Fila de familia (header del grupo)
                if (isGroup) {
                  return (<Fragment key={familyKey}>
                    <tr onClick={() => toggleFamily(familyKey)}
                      style={{ cursor: "pointer", background: expanded ? "var(--bg3)" : "transparent", borderBottom: "1px solid var(--bg4)" }}>
                      <td style={{ padding: "10px 8px", fontSize: 14, textAlign: "center", color: "var(--cyan)" }}>
                        {expanded ? "\u25BC" : "\u25B6"}
                      </td>
                      <td style={{ padding: "10px 4px" }}>
                        {(() => {
                          const firstThumb = liveData.get(groupItems[0].item_id)?.thumbnail || groupItems[0].thumbnail || "";
                          return firstThumb ? <img src={firstThumb} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: "cover" }} /> : null;
                        })()}
                      </td>
                      <td colSpan={2} style={{ padding: "10px 8px" }}>
                        <div style={{ fontWeight: 700, fontSize: 12 }}>{familyKey}</div>
                        <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--cyanBg)", color: "var(--cyan)", fontWeight: 600 }}>{groupItems.length} variantes</span>
                          {groupActivos > 0 && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--greenBg)", color: "var(--green)", fontWeight: 600 }}>{groupActivos} activos</span>}
                          {groupPausados > 0 && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--amberBg)", color: "var(--amber)", fontWeight: 600 }}>{groupPausados} pausados</span>}
                        </div>
                      </td>
                      <td></td>
                      <td></td>
                      <td style={{ textAlign: "center", fontWeight: 700, fontSize: 12, color: groupStockTotal > 0 ? "var(--green)" : "var(--txt3)" }}>{groupStockTotal}</td>
                      <td style={{ textAlign: "center", fontSize: 10 }}>{groupItems.reduce((s, i) => s + (liveData.get(i.item_id)?.sold_quantity ?? i.sold_quantity ?? 0), 0)}</td>
                      <td colSpan={2} style={{ textAlign: "right", padding: "8px 10px" }}>
                        <button onClick={e => { e.stopPropagation(); openPromos(familyKey, groupItems); }}
                          style={{ padding: "3px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--amber)", color: "#fff", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
                          Promos
                        </button>
                        <button onClick={e => { e.stopPropagation(); bulkSyncFromTitle(familyKey, groupItems); }}
                          disabled={bulkSyncing === familyKey}
                          style={{ padding: "3px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: bulkSyncing === familyKey ? "wait" : "pointer", whiteSpace: "nowrap" }}>
                          {bulkSyncing === familyKey ? "..." : "Nombres"}
                        </button>
                      </td>
                    </tr>
                    {expanded && groupItems.map(item => {
                      const live = liveData.get(item.item_id);
                      const title = live?.title || item.titulo || "—";
                      const variantName = title.replace(familyKey, "").trim() || title;
                      const price = live?.price || item.price || 0;
                      const status = live?.status || item.status_ml || "unknown";
                      const thumb = live?.thumbnail || item.thumbnail || "";
                      const permalink = live?.permalink || item.permalink || "";
                      const qty = live?.available_quantity ?? item.available_quantity ?? 0;
                      const sold = live?.sold_quantity ?? item.sold_quantity ?? 0;
                      const statusColor = STATUS_COLORS[status] || "var(--txt3)";
                      return (
                        <tr key={item.item_id} style={{ background: "var(--bg2)", borderBottom: "1px solid var(--bg4)" }}>
                          <td></td>
                          <td style={{ padding: "8px 4px" }}>
                            {thumb ? <img src={thumb} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: "cover" }} /> : null}
                          </td>
                          <td style={{ padding: "8px 8px" }}>
                            <div style={{ fontWeight: 600, fontSize: 11, color: "var(--cyan)" }}>{variantName}</div>
                            {permalink && <a href={permalink} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 9, color: "var(--txt3)", textDecoration: "none" }}>{item.item_id}</a>}
                          </td>
                          <td className="mono" style={{ fontSize: 10 }}>{item.sku}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{price ? fmt(price) : "—"}</td>
                          <td style={{ textAlign: "center" }}>{qty}</td>
                          <td style={{ textAlign: "center", fontWeight: 700, color: getDisponible(item.sku) > 0 ? "var(--green)" : "var(--txt3)" }}>{getDisponible(item.sku)}</td>
                          <td style={{ textAlign: "center" }}>{sold}</td>
                          <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: statusColor + "22", color: statusColor, fontWeight: 700 }}>{status}</span></td>
                          <td>
                            <div style={{ display: "flex", gap: 3 }}>
                              {status === "active" && <button onClick={() => toggleStatus(item.item_id, status)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--amber)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Pausar</button>}
                              {status === "paused" && getDisponible(item.sku) > 0 && <button onClick={() => activateWithStock(item.item_id, item.sku)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>{actionLoading === item.item_id ? "..." : "Activar"}</button>}
                              {status === "paused" && getDisponible(item.sku) <= 0 && <button onClick={() => toggleStatus(item.item_id, status)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--green)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Activar</button>}
                              {status !== "closed" && <button onClick={() => openEditItem(item.item_id, title)} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Editar</button>}
                              {status !== "closed" && <button onClick={() => onAddVariante(item.item_id)} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>+Var</button>}
                              {status !== "closed" && <button onClick={() => closeItem(item.item_id)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--red)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Cerrar</button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>);
                }

                // Item suelto (sin familia)
                const item = groupItems[0];
                const live = liveData.get(item.item_id);
                const title = live?.title || item.titulo || "—";
                const price = live?.price || item.price || 0;
                const status = live?.status || item.status_ml || "unknown";
                const thumb = live?.thumbnail || item.thumbnail || "";
                const permalink = live?.permalink || item.permalink || "";
                const qty = live?.available_quantity ?? item.available_quantity ?? 0;
                const sold = live?.sold_quantity ?? item.sold_quantity ?? 0;
                const statusColor = STATUS_COLORS[status] || "var(--txt3)";
                return (
                  <tr key={item.item_id} style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <td></td>
                    <td style={{ padding: "8px 4px" }}>
                      {thumb ? <img src={thumb} alt="" style={{ width: 32, height: 32, borderRadius: 4, objectFit: "cover" }} /> : <div style={{ width: 32, height: 32, borderRadius: 4, background: "var(--bg3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>📦</div>}
                    </td>
                    <td style={{ padding: "8px 8px", maxWidth: 300 }}>
                      <div style={{ fontWeight: 600, fontSize: 11 }}>{title}</div>
                      {permalink && <a href={permalink} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 9, color: "var(--txt3)", textDecoration: "none" }}>{item.item_id}</a>}
                    </td>
                    <td className="mono" style={{ fontSize: 10 }}>{item.sku}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{price ? fmt(price) : "—"}</td>
                    <td style={{ textAlign: "center" }}>{qty}</td>
                    <td style={{ textAlign: "center", fontWeight: 700, color: getDisponible(item.sku) > 0 ? "var(--green)" : "var(--txt3)" }}>{getDisponible(item.sku)}</td>
                    <td style={{ textAlign: "center" }}>{sold}</td>
                    <td><span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: statusColor + "22", color: statusColor, fontWeight: 700 }}>{status}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 3 }}>
                        {status === "active" && <button onClick={() => toggleStatus(item.item_id, status)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--amber)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Pausar</button>}
                        {status === "paused" && getDisponible(item.sku) > 0 && <button onClick={() => activateWithStock(item.item_id, item.sku)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>{actionLoading === item.item_id ? "..." : "Activar"}</button>}
                        {status === "paused" && getDisponible(item.sku) <= 0 && <button onClick={() => toggleStatus(item.item_id, status)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--green)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Activar</button>}
                        {status !== "closed" && <button onClick={() => openEditItem(item.item_id, title)} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Editar</button>}
                        {status !== "closed" && <button onClick={() => onAddVariante(item.item_id)} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>+Var</button>}
                        {status !== "closed" && <button onClick={() => closeItem(item.item_id)} disabled={actionLoading === item.item_id} style={{ padding: "2px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--red)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Cerrar</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* Modal Simulador de Precio */}
      {simItem && (() => { try {
        const p = parseInt(simPrice) || 0;
        const comision = simComision || 0;
        const envioSeller = p >= 19990 ? (simItem.costo_envio || 0) : 0;
        const costoTotal = (simItem.costo_bruto || 0) + comision + envioSeller;
        const ganancia = p - costoTotal;
        const margen = p > 0 ? Math.round((ganancia / p) * 100) : 0;
        const descPct = simItem.price_ml > 0 ? Math.round(((simItem.price_ml - p) / simItem.price_ml) * 100) : 0;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => !promoActioning && setSimItem(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 420, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
              <div style={{ padding: "16px 24px", background: "var(--amber)", color: "#fff" }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Simular Precio — {simItem.promo.type.replace(/_/g, " ")}</div>
                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{simItem.titulo}</div>
              </div>
              <div style={{ padding: "20px 24px" }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 6 }}>Precio con descuento</label>
                <input value={simPrice} onChange={e => handleSimPriceChange(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoFocus
                  style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", boxSizing: "border-box", textAlign: "center" }} />
                {descPct > 0 && <div style={{ textAlign: "center", fontSize: 11, color: "var(--amber)", marginTop: 4 }}>-{descPct}% sobre {fmt(simItem.price_ml)}</div>}
                {p > 0 && p < 19990 && simItem.price_ml >= 19990 && (
                  <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, background: "var(--redBg)", border: "1px solid var(--redBd)", fontSize: 11, color: "var(--red)", textAlign: "center" }}>
                    Bajo $19.990: ML cobra $1.000 extra de comisión fija y pierde envío gratis obligatorio
                  </div>
                )}

                <div style={{ marginTop: 12, background: "var(--bg3)", borderRadius: 8, padding: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: 12 }}>
                    <span style={{ color: "var(--txt3)" }}>Precio venta</span>
                    <span className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p)}</span>
                    <span style={{ color: "var(--txt3)" }}>Costo producto (+IVA)</span>
                    <span className="mono" style={{ textAlign: "right", color: "var(--red)" }}>-{fmt(simItem.costo_bruto)}</span>
                    <span style={{ color: "var(--txt3)" }}>Comisión ML {simLoadingFee && <span style={{ fontSize: 9 }}>...</span>}{p < 19990 ? " (con fijo $1.000)" : ""}</span>
                    <span className="mono" style={{ textAlign: "right", color: "var(--red)" }}>-{fmt(comision)}</span>
                    <span style={{ color: "var(--txt3)" }}>Envío {p < 19990 ? "(comprador paga)" : "(seller paga)"}</span>
                    <span className="mono" style={{ textAlign: "right", color: p >= 19990 && simItem.costo_envio > 0 ? "var(--red)" : "var(--green)" }}>{p >= 19990 ? (simItem.costo_envio > 0 ? `-${fmt(simItem.costo_envio)}` : "$0") : "$0"}</span>
                    <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--bg4)", margin: "4px 0" }} />
                    <span style={{ fontWeight: 700 }}>Ganancia</span>
                    <span className="mono" style={{ textAlign: "right", fontWeight: 800, fontSize: 16, color: ganancia > 0 ? "var(--green)" : "var(--red)" }}>{fmt(ganancia)}</span>
                    <span style={{ color: "var(--txt3)" }}>Margen</span>
                    <span style={{ textAlign: "right", fontWeight: 700, color: margen > 20 ? "var(--green)" : margen > 0 ? "var(--amber)" : "var(--red)" }}>{margen}%</span>
                  </div>
                </div>
              </div>
              <div style={{ padding: "14px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={() => setSimItem(null)} disabled={!!promoActioning}
                  style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cancelar
                </button>
                <button onClick={confirmPostular} disabled={!!promoActioning || p <= 0 || ganancia < 0}
                  style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: ganancia >= 0 ? "var(--amber)" : "var(--red)", color: "#fff", border: "none", cursor: promoActioning ? "wait" : "pointer", opacity: p <= 0 ? 0.4 : 1 }}>
                  {promoActioning ? "Postulando..." : ganancia < 0 ? "Margen negativo" : "Confirmar Postulación"}
                </button>
              </div>
            </div>
          </div>
        );
      } catch { return null; } })()}

      {/* Modal Promociones */}
      {promoFamily && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setPromoFamily(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 900, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ padding: "18px 24px", background: "var(--amber)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Promociones — {promoFamily}</span>
              <button onClick={() => setPromoFamily(null)} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>&times;</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 0 }}>
              {promoLoading ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Cargando promociones y costos...</div>
              ) : promoItems.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Sin datos</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--bg4)", position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
                      <th style={{ padding: "10px 10px", textAlign: "left", fontSize: 10, color: "var(--cyan)" }}>Variante</th>
                      <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Costo+IVA</th>
                      <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Comisión</th>
                      <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Envío</th>
                      <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--cyan)" }}>Precio</th>
                      <th style={{ padding: "10px 6px", textAlign: "center", fontSize: 10, color: "var(--green)" }}>Ganancia</th>
                      <th style={{ padding: "10px 6px", textAlign: "left", fontSize: 10, color: "var(--amber)" }}>Promociones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoItems.map(item => {
                      const costoTotal = item.costo_bruto + item.comision_ml + item.costo_envio;
                      const gananciaActual = item.price_ml - costoTotal;
                      const margenActual = item.price_ml > 0 ? Math.round((gananciaActual / item.price_ml) * 100) : null;
                      const variantName = promoFamily && item.titulo.startsWith(promoFamily)
                        ? item.titulo.slice(promoFamily.length).trim() || item.titulo
                        : item.titulo;
                      return (
                        <tr key={item.item_id} style={{ borderBottom: "1px solid var(--bg4)" }}>
                          <td style={{ padding: "10px 10px" }}>
                            <div style={{ fontWeight: 600, color: "var(--cyan)" }}>{variantName}</div>
                            <div className="mono" style={{ fontSize: 9, color: "var(--txt3)" }}>{item.sku}</div>
                          </td>
                          <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10 }}>{fmt(item.costo_bruto)}</td>
                          <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--red)" }}>{fmt(item.comision_ml)}</td>
                          <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: item.costo_envio > 0 ? "var(--red)" : "var(--txt3)" }}>{item.costo_envio > 0 ? fmt(item.costo_envio) : "—"}</td>
                          <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700 }}>{fmt(item.price_ml)}</td>
                          <td style={{ padding: "10px 6px", textAlign: "center" }}>
                            {margenActual !== null ? (
                              <div>
                                <div className="mono" style={{ fontWeight: 700, color: gananciaActual > 0 ? "var(--green)" : "var(--red)", fontSize: 11 }}>{fmt(gananciaActual)}</div>
                                <div style={{ fontSize: 9, color: margenActual > 20 ? "var(--green)" : margenActual > 0 ? "var(--amber)" : "var(--red)" }}>{margenActual}%</div>
                              </div>
                            ) : <span style={{ color: "var(--txt3)" }}>—</span>}
                          </td>
                          <td style={{ padding: "8px 6px" }}>
                            {item.promotions.length === 0 ? (
                              <span style={{ fontSize: 10, color: "var(--txt3)" }}>Sin promos</span>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                {item.promotions.map((p, pi) => {
                                  const comisionPromo = p.comision_promo || 0;
                                  const costoPromo = item.costo_bruto + comisionPromo + item.costo_envio;
                                  const gananciaPromo = p.price - costoPromo;
                                  const margenPromo = p.price > 0 ? Math.round((gananciaPromo / p.price) * 100) : null;
                                  const descPct = p.original_price > 0 ? Math.round(((p.original_price - p.price) / p.original_price) * 100) : 0;
                                  const statusColor = p.status === "started" ? "var(--green)" : p.status === "candidate" ? "var(--amber)" : "var(--txt3)";
                                  return (
                                    <div key={pi} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 6px", borderRadius: 4, background: "var(--bg3)", fontSize: 10 }}>
                                      {p.status === "candidate" || p.status === "pending" ? (
                                        <button onClick={() => openSimulator(item, p)} disabled={promoActioning === item.item_id}
                                          style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: "var(--amber)", color: "#fff", border: "none", cursor: promoActioning === item.item_id ? "wait" : "pointer", minWidth: 48 }}>
                                          {promoActioning === item.item_id ? "..." : "POSTULAR"}
                                        </button>
                                      ) : (
                                        <button onClick={async () => {
                                          if (!confirm(`¿Salir de ${p.type.replace(/_/g, " ")} en este item?`)) return;
                                          setPromoActioning(item.item_id);
                                          try {
                                            const res = await fetch("/api/ml/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item_id: item.item_id, action: "delete" }) });
                                            const data = await res.json();
                                            if (data.error) setActionError(`Error: ${data.error}`);
                                            else { setActionError("Removido de la promoción"); openPromos(promoFamily!, promoFamilyItems); }
                                          } catch (e) { setActionError(`Error: ${e instanceof Error ? e.message : "?"}`); }
                                          finally { setPromoActioning(null); }
                                        }} disabled={promoActioning === item.item_id}
                                          style={{ padding: "2px 6px", borderRadius: 3, fontSize: 9, fontWeight: 700, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: promoActioning === item.item_id ? "wait" : "pointer", minWidth: 48 }}>
                                          {promoActioning === item.item_id ? "..." : "ACTIVA ✕"}
                                        </button>
                                      )}
                                      <span style={{ color: "var(--txt3)", minWidth: 60, fontSize: 9 }}>{p.type.replace(/_/g, " ")}</span>
                                      <span className="mono" style={{ fontWeight: 700, color: "var(--amber)", minWidth: 50 }}>{fmt(p.price)}</span>
                                      <span style={{ fontSize: 8, color: "var(--txt3)" }}>-{descPct}%</span>
                                      {margenPromo !== null && (
                                        <span className="mono" style={{ fontWeight: 700, color: gananciaPromo > 0 ? "var(--green)" : "var(--red)", fontSize: 10, minWidth: 80 }}>
                                          {fmt(gananciaPromo)} <span style={{ fontSize: 9, opacity: 0.8 }}>{margenPromo}%</span>
                                        </span>
                                      )}
                                      {p.name && <span style={{ color: "var(--txt3)", fontSize: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 80 }}>{p.name}</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: "12px 24px", borderTop: "1px solid var(--bg4)", fontSize: 10, color: "var(--txt3)" }}>
              Ganancia = Precio - Costo(+IVA) - Comisión - Envío. Comisión y envío calculados desde la API de ML (tarifa real por peso facturable).
            </div>
          </div>
        </div>
      )}

      {/* Modal Editar Item */}
      {editItem && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => !editSaving && setEditItem(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 520, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }}>
            <div style={{ padding: "18px 24px", background: "var(--cyan)", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Editar Publicación</span>
              <button onClick={() => setEditItem(null)} disabled={editSaving} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>&times;</button>
            </div>
            <div style={{ padding: "8px 24px 0", fontSize: 11, color: "var(--txt3)" }}>
              <span className="mono">{editItem.item_id}</span>
            </div>
            <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Título {editHasFamily && <span style={{ color: "var(--amber)", fontWeight: 400 }}>(auto-generado por ML)</span>}</label>
                <input value={editTitle} onChange={e => setEditTitle(e.target.value)} disabled={editHasFamily}
                  style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: editHasFamily ? "var(--bg4)" : "var(--bg3)", color: editHasFamily ? "var(--txt3)" : "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
                {editHasFamily && <div style={{ fontSize: 10, color: "var(--amber)", marginTop: 4 }}>El título se genera automáticamente desde el nombre de familia + color</div>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Color</label>
                  <input value={editLoadingAttrs ? "Cargando..." : editColor} onChange={e => setEditColor(e.target.value)} disabled={editLoadingAttrs}
                    placeholder="Ej: Blanco, Azul, Multicolor..."
                    style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 4 }}>Diseño de tela</label>
                  <input value={editLoadingAttrs ? "Cargando..." : editDesign} onChange={e => setEditDesign(e.target.value)} disabled={editLoadingAttrs}
                    placeholder="Ej: Dino, Fox, Swan, Stellar..."
                    style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--txt3)" }}>Al cambiar estos atributos, ML actualiza el título automáticamente.</div>
            </div>
            <div style={{ padding: "14px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setEditItem(null)} disabled={editSaving}
                style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)" }}>
                Cancelar
              </button>
              <button onClick={saveEditItem} disabled={editSaving}
                style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: editSaving ? "wait" : "pointer", background: "var(--cyan)", color: "#fff", border: "none", opacity: editSaving ? 0.5 : 1 }}>
                {editSaving ? "Guardando..." : "Guardar en ML"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== NUEVA PUBLICACION ====================

function NuevaPublicacion() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Category search
  const [catSearch, setCatSearch] = useState("");
  const [catResults, setCatResults] = useState<MLCategoryResult[]>([]);
  const [selectedCat, setSelectedCat] = useState<{ id: string; name: string } | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 2: Form
  const [attributes, setAttributes] = useState<MLAttribute[]>([]);
  const [listingTypes, setListingTypes] = useState<Array<{ id: string; name: string }>>([]);
  const [familyName, setFamilyName] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"new" | "used">("new");
  const [listingType, setListingType] = useState("gold_special");
  const [pictures, setPictures] = useState<string[]>([""]);
  const [quantity, setQuantity] = useState("1");
  const [attrValues, setAttrValues] = useState<Record<string, string>>({});
  const [linkedSku, setLinkedSku] = useState("");
  const [freeShipping, setFreeShipping] = useState(false);

  // Step 3: Result
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ item?: { id: string; permalink: string; title: string }; error?: unknown } | null>(null);

  // Products for SKU linking
  const [productos, setProductos] = useState<Array<{ sku: string; name: string }>>([]);
  useEffect(() => {
    const s = getStore();
    if (s.products) {
      const prods = Object.values(s.products).map(p => ({ sku: p.sku, name: p.name }));
      setProductos(prods.sort((a, b) => a.sku.localeCompare(b.sku)));
    }
  }, []);

  // Category search with debounce
  const searchCategories = useCallback(async (q: string) => {
    if (q.length < 2) { setCatResults([]); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/ml/categories?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      setCatResults(json.results || []);
    } catch { setCatResults([]); }
    finally { setLoading(false); }
  }, []);

  const onCatSearchChange = (val: string) => {
    setCatSearch(val);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => searchCategories(val), 300);
  };

  const selectCategory = async (catId: string, catName: string) => {
    setSelectedCat({ id: catId, name: catName });
    setCatResults([]);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ml/category-attributes?category_id=${catId}`);
      const json = await res.json();
      if (json.error) { setError(json.error); return; }
      setAttributes(json.attributes || []);
      setListingTypes(json.listing_types || []);
      setStep(2);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const requiredAttrs = attributes.filter(a => a.tags?.required || a.tags?.catalog_required);
  const optionalAttrs = attributes.filter(a => !a.tags?.required && !a.tags?.catalog_required && a.value_type !== "boolean");

  const addPicture = () => setPictures(prev => [...prev, ""]);
  const removePicture = (idx: number) => setPictures(prev => prev.filter((_, i) => i !== idx));
  const updatePicture = (idx: number, val: string) => setPictures(prev => prev.map((p, i) => i === idx ? val : p));

  const buildItemBody = () => {
    const attrs = Object.entries(attrValues)
      .filter(([, v]) => v)
      .map(([id, value_name]) => ({ id, value_name }));

    return {
      family_name: familyName || title,
      title,
      category_id: selectedCat!.id,
      price: parseInt(price),
      available_quantity: parseInt(quantity),
      listing_type_id: listingType,
      condition,
      channels: ["marketplace"],
      pictures: pictures.filter(p => p.trim()).map(source => ({ source })),
      attributes: attrs,
      shipping: { mode: "me2", local_pick_up: false, free_shipping: freeShipping },
      ...(linkedSku ? { sku: linkedSku } : {}),
    };
  };

  const doPublish = async () => {
    setPublishing(true);
    setPublishResult(null);
    setError(null);
    try {
      const body = buildItemBody();
      const res = await fetch("/api/ml/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.error) {
        setPublishResult({ error: json.error });
      } else {
        setPublishResult({ item: json.item });
      }
      setStep(3);
    } catch (err) {
      setError(String(err));
    } finally {
      setPublishing(false);
    }
  };

  const resetForm = () => {
    setStep(1);
    setSelectedCat(null);
    setCatSearch("");
    setCatResults([]);
    setAttributes([]);
    setFamilyName("");
    setTitle("");
    setPrice("");
    setCondition("new");
    setListingType("gold_special");
    setPictures([""]);
    setQuantity("1");
    setAttrValues({});
    setLinkedSku("");
    setFreeShipping(false);
    setPublishResult(null);
    setError(null);
  };

  return (
    <div>
      {/* Step indicator */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[{ n: 1, label: "Categoría" }, { n: 2, label: "Datos" }, { n: 3, label: "Resultado" }].map(({ n, label }) => (
          <div key={n} style={{
            flex: 1, padding: "8px 12px", borderRadius: 8, textAlign: "center", fontSize: 12, fontWeight: 600,
            background: step >= n ? "var(--cyanBg)" : "var(--bg2)",
            color: step >= n ? "var(--cyan)" : "var(--txt3)",
            border: `1px solid ${step >= n ? "var(--cyanBd)" : "var(--bg4)"}`,
          }}>
            {n}. {label}
          </div>
        ))}
      </div>

      {error && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "var(--redBg)", color: "var(--red)", fontSize: 12, border: "1px solid var(--redBd)" }}>{error}</div>}

      {/* Step 1: Category */}
      {step === 1 && (
        <div className="card">
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 12px 0" }}>🏷️ Selecciona una categoría</h3>
          <input type="text" placeholder="Buscar categoría (ej: zapatilla, polera, celular)..." value={catSearch} onChange={e => onCatSearchChange(e.target.value)}
            style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13, marginBottom: 12 }} autoFocus />
          {loading && <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 8 }}>Buscando...</div>}
          {catResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {catResults.map((cat, i) => (
                <button key={i} onClick={() => selectCategory(cat.category_id, cat.category_name || cat.domain_name || cat.category_id)}
                  style={{ padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--bg4)", color: "var(--txt)", textAlign: "left", cursor: "pointer", fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>{cat.category_name || cat.domain_name}</div>
                  <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>{cat.category_id}{cat.domain_id ? ` · ${cat.domain_id}` : ""}</div>
                </button>
              ))}
            </div>
          )}
          {selectedCat && (
            <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 8, background: "var(--greenBg)", color: "var(--green)", fontSize: 12, border: "1px solid var(--greenBd)" }}>
              Seleccionada: {selectedCat.name} ({selectedCat.id})
            </div>
          )}
        </div>
      )}

      {/* Step 2: Form */}
      {step === 2 && selectedCat && (
        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>📝 Datos de la publicación</h3>
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>Categoría: {selectedCat.name} ({selectedCat.id})</div>
              </div>
              <button onClick={() => setStep(1)} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Cambiar</button>
            </div>

            {/* Family Name */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Nombre de familia (family_name) *</label>
              <input type="text" value={familyName} onChange={e => setFamilyName(e.target.value)} placeholder="Nombre genérico del producto (ej: Zapatilla Nike Air Max 90)"
                style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }} />
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>Agrupa variantes (color, talla) bajo el mismo nombre. ML genera el título final.</div>
            </div>

            {/* Title */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Título</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} maxLength={60} placeholder="Título específico de esta variante (opcional, ML puede autogenerar)"
                style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }} />
              <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2, textAlign: "right" }}>{title.length}/60</div>
            </div>

            {/* Price + Quantity + Condition row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Precio (CLP) *</label>
                <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="29990"
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }} />
              </div>
              <div style={{ flex: 1, minWidth: 100 }}>
                <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Cantidad *</label>
                <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min="1"
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }} />
              </div>
              <div style={{ flex: 1, minWidth: 100 }}>
                <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Condición *</label>
                <select value={condition} onChange={e => setCondition(e.target.value as "new" | "used")}
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }}>
                  <option value="new">Nuevo</option>
                  <option value="used">Usado</option>
                </select>
              </div>
            </div>

            {/* Listing type + Free shipping */}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 150 }}>
                <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Tipo de publicación</label>
                <select value={listingType} onChange={e => setListingType(e.target.value)}
                  style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }}>
                  <option value="gold_special">Clásica (gold_special)</option>
                  <option value="gold_pro">Premium (gold_pro)</option>
                  <option value="gold">Oro (gold)</option>
                  <option value="silver">Plata (silver)</option>
                  <option value="free">Gratuita (free)</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 150, display: "flex", alignItems: "flex-end" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--txt)", cursor: "pointer" }}>
                  <input type="checkbox" checked={freeShipping} onChange={e => setFreeShipping(e.target.checked)} />
                  Envío gratis
                </label>
              </div>
            </div>

            {/* Link to SKU */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Vincular a SKU del sistema (opcional)</label>
              <ProductSearchSelect productos={productos} selectedSku={linkedSku} onSelect={setLinkedSku} />
            </div>
          </div>

          {/* Pictures */}
          <div className="card" style={{ marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>📷 Fotos (URLs)</h3>
            {pictures.map((pic, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <input type="url" value={pic} onChange={e => updatePicture(idx, e.target.value)} placeholder="https://..."
                  style={{ flex: 1, padding: "8px 12px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
                {pictures.length > 1 && (
                  <button onClick={() => removePicture(idx)} style={{ padding: "4px 8px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", fontSize: 10, cursor: "pointer" }}>✕</button>
                )}
              </div>
            ))}
            {pictures.length < 10 && (
              <button onClick={addPicture} style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>+ Agregar foto</button>
            )}
          </div>

          {/* Required attributes */}
          {requiredAttrs.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px 0" }}>📋 Atributos requeridos</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {requiredAttrs.map(attr => (
                  <div key={attr.id}>
                    <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>{attr.name}</label>
                    {attr.values && attr.values.length > 0 ? (
                      <select value={attrValues[attr.id] || ""} onChange={e => setAttrValues(prev => ({ ...prev, [attr.id]: e.target.value }))}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
                        <option value="">— Seleccionar —</option>
                        {attr.values.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={attrValues[attr.id] || ""} onChange={e => setAttrValues(prev => ({ ...prev, [attr.id]: e.target.value }))} placeholder={attr.name}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Optional attributes (collapsible) */}
          {optionalAttrs.length > 0 && <OptionalAttrs attrs={optionalAttrs} values={attrValues} onChange={setAttrValues} />}

          {/* Preview + Publish */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--txt3)" }}>
                {familyName ? `"${familyName}"` : "Sin nombre"} · {fmt(parseInt(price) || 0)} · {parseInt(quantity) || 0} uds · {pictures.filter(p => p.trim()).length} fotos
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setStep(1)} style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Volver</button>
                <button onClick={doPublish} disabled={publishing || !familyName || !price || pictures.filter(p => p.trim()).length === 0}
                  style={{
                    padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700,
                    background: !familyName || !price ? "var(--bg3)" : "var(--greenBg)", color: !familyName || !price ? "var(--txt3)" : "var(--green)",
                    border: `1px solid ${!familyName || !price ? "var(--bg4)" : "var(--greenBd)"}`, cursor: publishing ? "wait" : "pointer",
                  }}>
                  {publishing ? "Publicando..." : "Publicar en ML"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Result */}
      {step === 3 && publishResult && (
        <div className="card">
          {publishResult.item ? (
            <div>
              <div style={{ fontSize: 32, textAlign: "center", marginBottom: 8 }}>✅</div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: "center", margin: "0 0 8px 0", color: "var(--green)" }}>Publicación creada</h3>
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{publishResult.item.title}</div>
                <div className="mono" style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>{publishResult.item.id}</div>
                <a href={publishResult.item.permalink} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-block", marginTop: 8, padding: "8px 16px", borderRadius: 8, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", fontSize: 12, fontWeight: 600, textDecoration: "none" }}>
                  Ver en MercadoLibre ↗
                </a>
              </div>
              <div style={{ textAlign: "center" }}>
                <button onClick={resetForm} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Crear otra publicación</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 32, textAlign: "center", marginBottom: 8 }}>❌</div>
              <h3 style={{ fontSize: 16, fontWeight: 700, textAlign: "center", margin: "0 0 12px 0", color: "var(--red)" }}>Error al publicar</h3>
              <div style={{ padding: 12, borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--redBd)", fontSize: 12, fontFamily: "'JetBrains Mono', monospace", whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>
                {typeof publishResult.error === "string" ? publishResult.error : JSON.stringify(publishResult.error, null, 2)}
              </div>
              <div style={{ textAlign: "center", marginTop: 12 }}>
                <button onClick={() => setStep(2)} style={{ padding: "8px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", cursor: "pointer" }}>Volver a editar</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Optional attributes collapsible section
function OptionalAttrs({ attrs, values, onChange }: { attrs: MLAttribute[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", color: "var(--txt2)", cursor: "pointer", padding: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>📋 Atributos opcionales ({attrs.length})</span>
        <span style={{ fontSize: 12 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          {attrs.slice(0, 30).map(attr => (
            <div key={attr.id}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>{attr.name}</label>
              {attr.values && attr.values.length > 0 ? (
                <select value={values[attr.id] || ""} onChange={e => onChange({ ...values, [attr.id]: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
                  <option value="">—</option>
                  {attr.values.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
                </select>
              ) : (
                <input type="text" value={values[attr.id] || ""} onChange={e => onChange({ ...values, [attr.id]: e.target.value })} placeholder={attr.name}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== PRODUCT SEARCH SELECT ====================

function ProductSearchSelect({ productos, selectedSku, onSelect }: { productos: Array<{ sku: string; name: string }>; selectedSku: string; onSelect: (sku: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = productos.filter(p => {
    if (!query) return true;
    const q = query.toLowerCase();
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  });

  const selected = productos.find(p => p.sku === selectedSku);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={open ? query : (selected ? `${selected.sku} — ${selected.name}` : "")}
        onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        placeholder="Buscar por SKU o nombre..."
        style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: `1px solid ${open ? "var(--cyan)" : "var(--bg4)"}`, fontSize: 13 }}
      />
      {selected && !open && (
        <button onClick={() => { onSelect(""); setQuery(""); }}
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--txt3)", cursor: "pointer", fontSize: 14 }}>
          ✕
        </button>
      )}
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, marginTop: 4,
          background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8,
          maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          <button onClick={() => { onSelect(""); setOpen(false); setQuery(""); }}
            style={{
              display: "block", width: "100%", padding: "10px 14px", textAlign: "left", background: !selectedSku ? "var(--bg3)" : "transparent",
              border: "none", borderBottom: "1px solid var(--bg3)", color: "var(--txt3)", cursor: "pointer", fontSize: 12, fontStyle: "italic",
            }}>
            — Sin vincular —
          </button>
          {filtered.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--txt3)" }}>Sin resultados</div>
          ) : (
            filtered.slice(0, 50).map(p => (
              <button key={p.sku} onClick={() => { onSelect(p.sku); setOpen(false); setQuery(""); }}
                style={{
                  display: "block", width: "100%", padding: "10px 14px", textAlign: "left", background: p.sku === selectedSku ? "var(--bg3)" : "transparent",
                  border: "none", borderBottom: "1px solid var(--bg3)", color: "var(--txt)", cursor: "pointer", fontSize: 12,
                }}>
                <div style={{ fontWeight: 600 }}>{p.sku}</div>
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{p.name}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ==================== ITEM SEARCH SELECT ====================

function ItemSearchSelect({ items, selectedId, onSelect }: { items: DBMLItemMap[]; selectedId: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = items.filter(item => {
    if (!query) return true;
    const q = query.toLowerCase();
    return item.item_id.toLowerCase().includes(q) ||
      item.sku.toLowerCase().includes(q) ||
      (item.titulo || "").toLowerCase().includes(q);
  });

  const selected = items.find(i => i.item_id === selectedId);

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={open ? query : (selected ? `${selected.item_id} · ${selected.sku} · ${selected.titulo || "Sin título"}` : "")}
        onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        placeholder="Buscar por SKU, item ID o título..."
        style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: `1px solid ${open ? "var(--cyan)" : "var(--bg4)"}`, fontSize: 13 }}
      />
      {selected && !open && (
        <button onClick={() => { onSelect(""); setQuery(""); }}
          style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--txt3)", cursor: "pointer", fontSize: 14 }}>
          ✕
        </button>
      )}
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, marginTop: 4,
          background: "var(--bg2)", border: "1px solid var(--bg4)", borderRadius: 8,
          maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--txt3)" }}>Sin resultados</div>
          ) : (
            filtered.slice(0, 50).map(item => (
              <button key={item.item_id} onClick={() => { onSelect(item.item_id); setOpen(false); setQuery(""); }}
                style={{
                  display: "block", width: "100%", padding: "10px 14px", textAlign: "left", background: item.item_id === selectedId ? "var(--bg3)" : "transparent",
                  border: "none", borderBottom: "1px solid var(--bg3)", color: "var(--txt)", cursor: "pointer", fontSize: 12,
                }}>
                <div style={{ fontWeight: 600 }}>{item.sku}</div>
                <div style={{ fontSize: 11, color: "var(--txt3)", marginTop: 2 }}>{item.item_id} · {item.titulo || "Sin título"}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ==================== AGREGAR VARIANTES (User Products model) ====================
// En el modelo multi-warehouse/User Products, las variantes son items separados
// que comparten el mismo family_name. No se usa POST /items/{id}/variations.

// ==================== PRECIOS Y PROMOS ====================

type PromoItem = { item_id: string; sku: string; titulo: string; price_ml: number; costo_neto: number; costo_bruto: number; comision_ml: number; costo_envio: number; listing_type: string; category_id: string; promotions: Array<{ id?: string; type: string; sub_type?: string; name?: string; status: string; price: number; original_price: number; meli_percentage?: number; seller_percentage?: number; start_date?: string; finish_date?: string; suggested_discounted_price?: number; min_discounted_price?: number; max_discounted_price?: number; comision_promo?: number }> };

const PROMO_LABELS: Record<string, { label: string; desc: string; color: string }> = {
  PRICE_DISCOUNT: { label: "Descuento", desc: "Precio tachado que tú defines", color: "var(--cyan)" },
  SELLER_CAMPAIGN: { label: "Campaña", desc: "Oferta creada por ti con fechas", color: "var(--blue)" },
  DEAL: { label: "Deal ML", desc: "Campaña de ML (ej: Día de la mamá)", color: "var(--amber)" },
  DOD: { label: "Oferta Día", desc: "Deal of the Day — promoción destacada 24h", color: "var(--red)" },
  LIGHTNING: { label: "Relámpago", desc: "Oferta relámpago — tiempo y stock limitado", color: "var(--red)" },
  SMART: { label: "Smart", desc: "ML sugiere precio óptimo para más ventas", color: "var(--green)" },
  MARKETPLACE_CAMPAIGN: { label: "Co-funded", desc: "Campaña co-financiada por ML", color: "var(--amber)" },
};

function PreciosYPromos() {
  const [items, setItems] = useState<DBMLItemMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"sin_promo" | "todas" | "buscar">("sin_promo");
  const [promoData, setPromoData] = useState<PromoItem[]>([]);
  const [promoLoading, setPromoLoading] = useState(false);
  const [scanResult, setScanResult] = useState<{ total: number; con: number; sin: number } | null>(null);
  const [changingPrice, setChangingPrice] = useState<string | null>(null);
  const [promoActioning, setPromoActioning] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // Simulador
  const [simP, setSimP] = useState<{ item: PromoItem; promo: PromoItem["promotions"][0] } | null>(null);
  const [simPPrice, setSimPPrice] = useState("");
  const [simPFee, setSimPFee] = useState(0);
  const [simPFeeLoading, setSimPFeeLoading] = useState(false);
  const simPTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openSimP = (item: PromoItem, promo: PromoItem["promotions"][0]) => {
    const defaultPrice = promo.price > 0 ? promo.price : (promo.suggested_discounted_price || Math.round(item.price_ml * 0.8));
    setSimP({ item, promo });
    setSimPPrice(String(defaultPrice));
    setSimPFee(0);
    fetchSimPFee(defaultPrice, item.listing_type, item.category_id);
  };

  const fetchSimPFee = (price: number, lt: string, cat: string) => {
    if (simPTimeout.current) clearTimeout(simPTimeout.current);
    simPTimeout.current = setTimeout(async () => {
      if (price <= 0 || !cat) return;
      setSimPFeeLoading(true);
      try {
        const res = await fetch(`/api/ml/promotions?fee_price=${price}&listing_type=${lt}&category_id=${cat}`);
        const data = await res.json();
        setSimPFee(data.fee || 0);
      } catch { /* ignore */ }
      setSimPFeeLoading(false);
    }, 400);
  };

  const handleSimPChange = (val: string) => {
    setSimPPrice(val);
    const p = parseInt(val);
    if (p > 0 && simP) fetchSimPFee(p, simP.item.listing_type, simP.item.category_id);
  };

  const confirmSimP = async () => {
    if (!simP) return;
    const dealPrice = parseInt(simPPrice);
    if (!dealPrice) return;
    setPromoActioning(simP.item.item_id);
    try {
      const action = simP.promo.type === "PRICE_DISCOUNT" ? "create_discount" : "join";
      const body: Record<string, unknown> = { item_id: simP.item.item_id, action, deal_price: dealPrice };
      if (action === "create_discount") {
        body.start_date = new Date().toISOString().slice(0, 10) + "T00:00:00";
        body.finish_date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) + "T23:59:59";
      } else {
        body.promotion_id = simP.promo.id;
        body.promotion_type = simP.promo.type;
      }
      const res = await fetch("/api/ml/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) setActionMsg(`Error: ${data.error}`);
      else {
        setActionMsg("Postulado exitosamente");
        // Refrescar solo este item sin recargar todo
        try {
          const r2 = await fetch(`/api/ml/promotions?item_ids=${simP.item.item_id}`);
          const d2 = await r2.json();
          if (d2.items?.[0]) {
            setPromoData(prev => prev.map(p => p.item_id === simP.item.item_id ? d2.items[0] : p));
          }
        } catch { /* ignore */ }
      }
    } catch (e) { setActionMsg(`Error: ${e instanceof Error ? e.message : "?"}`); }
    finally { setPromoActioning(null); setSimP(null); }
  };

  const salirPromoP = async (itemId: string) => {
    if (!confirm("¿Salir de la promoción?")) return;
    setPromoActioning(itemId);
    try {
      const res = await fetch("/api/ml/promotions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item_id: itemId, action: "delete" }) });
      const data = await res.json();
      if (data.error) setActionMsg(`Error: ${data.error}`);
      else {
        setActionMsg("Removido de la promoción");
        // Refrescar solo este item
        try {
          const r2 = await fetch(`/api/ml/promotions?item_ids=${itemId}`);
          const d2 = await r2.json();
          if (d2.items?.[0]) {
            setPromoData(prev => prev.map(p => p.item_id === itemId ? d2.items[0] : p));
          }
        } catch { /* ignore */ }
      }
    } catch (e) { setActionMsg(`Error: ${e instanceof Error ? e.message : "?"}`); }
    finally { setPromoActioning(null); }
  };

  useEffect(() => {
    fetchMLItemsMap().then(data => { setItems(data); setLoading(false); });
  }, []);

  const activeItems = useMemo(() => {
    const unique = new Map<string, DBMLItemMap>();
    for (const i of items) if (!unique.has(i.item_id) && i.status_ml === "active") unique.set(i.item_id, i);
    return Array.from(unique.values());
  }, [items]);

  // Escanear sin promos
  const scanSinPromos = async () => {
    setPromoLoading(true);
    setPromoData([]);
    setScanResult(null);
    try {
      const res = await fetch("/api/ml/scan-promos?run=true");
      const scan = await res.json();
      const sinPromo: string[] = (scan.sin_promo || []).map((s: { item_id: string }) => s.item_id);
      setScanResult({ total: scan.total || 0, con: scan.con_promo || 0, sin: sinPromo.length });
      if (sinPromo.length > 0) {
        // Cargar promos+costos de los sin promo (max 30)
        const ids = sinPromo.slice(0, 30).join(",");
        const res2 = await fetch(`/api/ml/promotions?item_ids=${ids}`);
        const data = await res2.json();
        setPromoData(data.items || []);
      }
    } catch { /* ignore */ }
    setPromoLoading(false);
  };

  // Cargar promos por búsqueda
  const searchPromos = async (q: string) => {
    const matched = activeItems.filter(i =>
      i.sku.toUpperCase().includes(q.toUpperCase()) ||
      (i.titulo || "").toUpperCase().includes(q.toUpperCase()) ||
      i.item_id.toUpperCase().includes(q.toUpperCase())
    );
    if (matched.length === 0) return;
    setPromoLoading(true);
    setPromoData([]);
    try {
      const ids = matched.slice(0, 20).map(i => i.item_id).join(",");
      const res = await fetch(`/api/ml/promotions?item_ids=${ids}`);
      const data = await res.json();
      setPromoData(data.items || []);
    } catch { /* ignore */ }
    setPromoLoading(false);
  };

  // Cargar todas
  const loadAll = async () => {
    setPromoLoading(true);
    setPromoData([]);
    try {
      const ids = activeItems.slice(0, 30).map(i => i.item_id).join(",");
      const res = await fetch(`/api/ml/promotions?item_ids=${ids}`);
      const data = await res.json();
      setPromoData(data.items || []);
    } catch { /* ignore */ }
    setPromoLoading(false);
  };

  useEffect(() => {
    if (!loading && tab === "sin_promo") scanSinPromos();
    else if (!loading && tab === "todas") loadAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loading]);

  // Cambiar precio
  const changePrice = async (itemId: string, newPrice: number) => {
    setChangingPrice(itemId);
    try {
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, updates: { price: newPrice } }),
      });
      const data = await res.json();
      if (!res.ok || data.error) alert(`Error: ${data.error || "?"}`);
      else {
        setPromoData(prev => prev.map(p => p.item_id === itemId ? { ...p, price_ml: newPrice } : p));
      }
    } catch { /* ignore */ }
    setChangingPrice(null);
  };

  if (loading) return <div style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Cargando...</div>;

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>💰 Precios y Promociones</h2>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>{activeItems.length} publicaciones activas</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="text" placeholder="Buscar SKU..." value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && search.trim()) { setTab("buscar"); searchPromos(search); } }}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12, width: 180 }} />
            {search.trim() && (
              <button onClick={() => { setTab("buscar"); searchPromos(search); }}
                style={{ padding: "6px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--cyan)", color: "#fff", border: "none", cursor: "pointer" }}>
                Buscar
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "2px solid var(--bg4)", marginBottom: 16 }}>
        {([
          { key: "sin_promo" as const, label: "Sin promoción", color: "var(--red)" },
          { key: "todas" as const, label: "Todas las activas", color: "var(--cyan)" },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "10px 16px", fontSize: 13, fontWeight: tab === t.key ? 600 : 400, cursor: "pointer", background: "none", border: "none",
              borderBottom: tab === t.key ? `2px solid ${t.color}` : "2px solid transparent",
              color: tab === t.key ? "var(--txt)" : "var(--txt3)", marginBottom: -2 }}>
            {t.label}
            {t.key === "sin_promo" && scanResult && (
              <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "var(--redBg)", color: "var(--red)" }}>{scanResult.sin}</span>
            )}
          </button>
        ))}
        {tab === "buscar" && (
          <span style={{ padding: "10px 16px", fontSize: 13, fontWeight: 600, borderBottom: "2px solid var(--amber)", color: "var(--txt)", marginBottom: -2 }}>
            Búsqueda: {search}
          </span>
        )}
      </div>

      {/* Resumen */}
      {scanResult && tab === "sin_promo" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
          <div className="kpi"><div className="kpi-label">Total activas</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>{scanResult.total}</div></div>
          <div className="kpi"><div className="kpi-label">Con promo</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--green)" }}>{scanResult.con}</div></div>
          <div className="kpi"><div className="kpi-label">Sin promo</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--red)" }}>{scanResult.sin}</div></div>
        </div>
      )}

      {actionMsg && (
        <div style={{ marginBottom: 12, padding: "8px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: actionMsg.startsWith("Error") ? "var(--redBg)" : "var(--greenBg)",
          color: actionMsg.startsWith("Error") ? "var(--red)" : "var(--green)",
          display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{actionMsg}</span>
          <button onClick={() => setActionMsg(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14 }}>{"\u2715"}</button>
        </div>
      )}

      {/* Tabla */}
      {promoLoading ? (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>Escaneando promociones en ML...</div>
      ) : promoData.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          {tab === "sin_promo" ? "Todas las publicaciones tienen promo activa" : "Sin resultados"}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <th style={{ padding: "10px 10px", textAlign: "left", fontSize: 10, color: "var(--cyan)" }}>Producto</th>
                <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Costo+IVA</th>
                <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Comisión</th>
                <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>Envío</th>
                <th style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--cyan)" }}>Precio</th>
                <th style={{ padding: "10px 6px", textAlign: "center", fontSize: 10, color: "var(--green)" }}>Ganancia</th>
                <th style={{ padding: "10px 6px", textAlign: "left", fontSize: 10, color: "var(--amber)" }}>Promos disponibles</th>
                <th style={{ padding: "10px 6px", textAlign: "center", fontSize: 10 }}>Cambiar precio</th>
              </tr>
            </thead>
            <tbody>
              {promoData.map(item => {
                const costoTotal = item.costo_bruto + item.comision_ml + item.costo_envio;
                const ganancia = item.price_ml - costoTotal;
                const margen = item.price_ml > 0 ? Math.round((ganancia / item.price_ml) * 100) : 0;
                return (
                  <tr key={item.item_id} style={{ borderBottom: "1px solid var(--bg4)" }}>
                    <td style={{ padding: "10px 10px", maxWidth: 250 }}>
                      <div style={{ fontWeight: 600, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.titulo}</div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--txt3)" }}>{item.sku} · {item.item_id}</div>
                    </td>
                    <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10 }}>{fmt(item.costo_bruto)}</td>
                    <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: "var(--red)" }}>{fmt(item.comision_ml)}</td>
                    <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontSize: 10, color: item.costo_envio > 0 ? "var(--red)" : "var(--txt3)" }}>{item.costo_envio > 0 ? fmt(item.costo_envio) : "—"}</td>
                    <td className="mono" style={{ padding: "10px 6px", textAlign: "right", fontWeight: 700 }}>{fmt(item.price_ml)}</td>
                    <td style={{ padding: "10px 6px", textAlign: "center" }}>
                      <div className="mono" style={{ fontWeight: 700, color: ganancia > 0 ? "var(--green)" : "var(--red)", fontSize: 11 }}>{fmt(ganancia)}</div>
                      <div style={{ fontSize: 9, color: margen > 20 ? "var(--green)" : margen > 0 ? "var(--amber)" : "var(--red)" }}>{margen}%</div>
                    </td>
                    <td style={{ padding: "8px 6px" }}>
                      {item.promotions.length === 0 ? (
                        <span style={{ fontSize: 10, color: "var(--txt3)" }}>Sin promos</span>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {item.promotions.map((p, pi) => {
                            const promoPrice = p.price > 0 ? p.price : (p.suggested_discounted_price || 0);
                            const comP = p.comision_promo || 0;
                            const envP = promoPrice >= 19990 ? item.costo_envio : 0;
                            const ganP = promoPrice > 0 ? promoPrice - (item.costo_bruto + comP + envP) : 0;
                            const marP = promoPrice > 0 ? Math.round((ganP / promoPrice) * 100) : 0;
                            const info = PROMO_LABELS[p.type] || { label: p.type, desc: "", color: "var(--txt3)" };
                            const fechas = p.start_date && p.finish_date
                              ? `${p.start_date.slice(5, 10).replace("-", "/")} al ${p.finish_date.slice(5, 10).replace("-", "/")}`
                              : "";
                            return (
                              <div key={pi} style={{ padding: "4px 8px", borderRadius: 5, background: "var(--bg3)", fontSize: 10, borderLeft: `3px solid ${info.color}` }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                                  {p.status === "started" ? (
                                    <button onClick={() => salirPromoP(item.item_id)} disabled={promoActioning === item.item_id}
                                      style={{ padding: "1px 5px", borderRadius: 3, fontSize: 8, fontWeight: 700, background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--greenBd)", cursor: "pointer" }}>
                                      {promoActioning === item.item_id ? "..." : "ACTIVA \u2715"}
                                    </button>
                                  ) : (
                                    <button onClick={() => openSimP(item, { ...p, price: promoPrice })} disabled={promoActioning === item.item_id}
                                      style={{ padding: "1px 5px", borderRadius: 3, fontSize: 8, fontWeight: 700, background: info.color, color: "#fff", border: "none", cursor: "pointer" }}>
                                      {promoActioning === item.item_id ? "..." : "POSTULAR"}
                                    </button>
                                  )}
                                  <span style={{ fontWeight: 700, color: info.color }}>{info.label}</span>
                                  {p.name && <span style={{ color: "var(--txt2)", fontSize: 9 }}>{p.name}</span>}
                                </div>
                                <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10 }}>
                                  {promoPrice > 0 ? (
                                    <>
                                      <span className="mono" style={{ fontWeight: 700 }}>{fmt(promoPrice)}</span>
                                      <span style={{ fontSize: 9, color: "var(--txt3)" }}>-{Math.round(((item.price_ml - promoPrice) / item.price_ml) * 100)}%</span>
                                      <span className="mono" style={{ fontWeight: 700, color: ganP > 0 ? "var(--green)" : "var(--red)" }}>ganancia {fmt(ganP)} ({marP}%)</span>
                                    </>
                                  ) : (
                                    <span style={{ color: "var(--txt3)", fontStyle: "italic" }}>Define tu precio al postular</span>
                                  )}
                                </div>
                                {(fechas || p.meli_percentage || p.seller_percentage) && (
                                  <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 2 }}>
                                    {fechas && <span>{fechas}</span>}
                                    {p.meli_percentage ? <span> · ML pone {p.meli_percentage}%</span> : null}
                                    {p.seller_percentage ? <span> · Tú pones {p.seller_percentage}%</span> : null}
                                    {p.min_discounted_price ? <span> · Rango: {fmt(p.min_discounted_price)}-{fmt(p.max_discounted_price || 0)}</span> : null}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "center" }}>
                      <button onClick={() => {
                        const newPrice = prompt("Nuevo precio:", String(item.price_ml));
                        if (newPrice && parseInt(newPrice) !== item.price_ml) changePrice(item.item_id, parseInt(newPrice));
                      }} disabled={changingPrice === item.item_id}
                        style={{ padding: "3px 8px", borderRadius: 4, fontSize: 9, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                        {changingPrice === item.item_id ? "..." : "Precio"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* Simulador */}
      {simP && (() => { try {
        const p = parseInt(simPPrice) || 0;
        const comision = simPFee || 0;
        const envio = p >= 19990 ? (simP.item.costo_envio || 0) : 0;
        const costoTotal = (simP.item.costo_bruto || 0) + comision + envio;
        const ganancia = p - costoTotal;
        const margen = p > 0 ? Math.round((ganancia / p) * 100) : 0;
        const descPct = simP.item.price_ml > 0 ? Math.round(((simP.item.price_ml - p) / simP.item.price_ml) * 100) : 0;
        const info = PROMO_LABELS[simP.promo.type] || { label: simP.promo.type, desc: "", color: "var(--amber)" };
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
            onClick={() => !promoActioning && setSimP(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 440, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
              <div style={{ padding: "16px 24px", background: info.color, color: "#fff" }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{info.label} — Postular</div>
                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{simP.item.titulo}</div>
                {simP.promo.name && <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{simP.promo.name}</div>}
              </div>
              <div style={{ padding: "20px 24px" }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--txt3)", display: "block", marginBottom: 6 }}>Precio con descuento</label>
                <input value={simPPrice} onChange={e => handleSimPChange(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoFocus
                  style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid var(--bg4)", background: "var(--bg3)", color: "var(--txt)", fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", boxSizing: "border-box", textAlign: "center" }} />
                {descPct > 0 && <div style={{ textAlign: "center", fontSize: 11, color: "var(--amber)", marginTop: 4 }}>-{descPct}% sobre {fmt(simP.item.price_ml)}</div>}
                {simP.promo.min_discounted_price && (
                  <div style={{ textAlign: "center", fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>Rango: {fmt(simP.promo.min_discounted_price)} — {fmt(simP.promo.max_discounted_price || 0)}</div>
                )}
                {descPct < 5 && p > 0 && (
                  <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: 6, background: "var(--redBg)", border: "1px solid var(--redBd)", fontSize: 10, color: "var(--red)", textAlign: "center" }}>
                    ML requiere mínimo 5% de descuento. Máximo: {fmt(Math.floor(simP.item.price_ml * 0.95))}
                  </div>
                )}
                {p > 0 && p < 19990 && simP.item.price_ml >= 19990 && (
                  <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "var(--redBg)", border: "1px solid var(--redBd)", fontSize: 10, color: "var(--red)", textAlign: "center" }}>
                    Bajo $19.990: +$1.000 comisión fija, pierde envío gratis
                  </div>
                )}
                <div style={{ marginTop: 12, background: "var(--bg3)", borderRadius: 8, padding: 14 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: 12 }}>
                    <span style={{ color: "var(--txt3)" }}>Precio venta</span>
                    <span className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmt(p)}</span>
                    <span style={{ color: "var(--txt3)" }}>Costo producto (+IVA)</span>
                    <span className="mono" style={{ textAlign: "right", color: "var(--red)" }}>-{fmt(simP.item.costo_bruto)}</span>
                    <span style={{ color: "var(--txt3)" }}>Comisión ML {simPFeeLoading && "..."}{p < 19990 ? " (+fijo)" : ""}</span>
                    <span className="mono" style={{ textAlign: "right", color: "var(--red)" }}>-{fmt(comision)}</span>
                    <span style={{ color: "var(--txt3)" }}>Envío {p < 19990 ? "(comprador)" : "(seller)"}</span>
                    <span className="mono" style={{ textAlign: "right", color: envio > 0 ? "var(--red)" : "var(--green)" }}>{envio > 0 ? `-${fmt(envio)}` : "$0"}</span>
                    <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--bg4)", margin: "4px 0" }} />
                    <span style={{ fontWeight: 700 }}>Ganancia</span>
                    <span className="mono" style={{ textAlign: "right", fontWeight: 800, fontSize: 16, color: ganancia > 0 ? "var(--green)" : "var(--red)" }}>{fmt(ganancia)}</span>
                    <span style={{ color: "var(--txt3)" }}>Margen</span>
                    <span style={{ textAlign: "right", fontWeight: 700, color: margen > 20 ? "var(--green)" : margen > 0 ? "var(--amber)" : "var(--red)" }}>{margen}%</span>
                  </div>
                </div>
              </div>
              <div style={{ padding: "14px 24px", borderTop: "1px solid var(--bg4)", display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button onClick={() => setSimP(null)} disabled={!!promoActioning}
                  style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg3)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                  Cancelar
                </button>
                <button onClick={confirmSimP} disabled={!!promoActioning || p <= 0 || ganancia < 0 || descPct < 5}
                  style={{ padding: "9px 20px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: ganancia >= 0 && descPct >= 5 ? info.color : "var(--red)", color: "#fff", border: "none", cursor: promoActioning ? "wait" : "pointer", opacity: p <= 0 || descPct < 5 ? 0.4 : 1 }}>
                  {promoActioning ? "Postulando..." : descPct < 5 ? "Mínimo 5% descuento" : ganancia < 0 ? "Margen negativo" : "Confirmar Postulación"}
                </button>
              </div>
            </div>
          </div>
        );
      } catch { return null; } })()}
    </div>
  );
}

// ==================== AGREGAR VARIANTES ====================

function AgregarVariantes({ preselectedItemId }: { preselectedItemId: string | null }) {
  const [items, setItems] = useState<DBMLItemMap[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string>(preselectedItemId || "");
  const [loading, setLoading] = useState(true);
  const [itemDetail, setItemDetail] = useState<MLItemDetail["body"] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New variation form
  const [varPrice, setVarPrice] = useState("");
  const [varQty, setVarQty] = useState("1");
  const [varPictures, setVarPictures] = useState<string[]>([""]);
  const [varAttrs, setVarAttrs] = useState<Array<{ id: string; value_name: string }>>([]);
  const [varLinkedSku, setVarLinkedSku] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Products for SKU linking
  const [productos, setProductos] = useState<Array<{ sku: string; name: string }>>([]);
  useEffect(() => {
    const s = getStore();
    if (s.products) {
      const prods = Object.values(s.products).map(p => ({ sku: p.sku, name: p.name }));
      setProductos(prods.sort((a, b) => a.sku.localeCompare(b.sku)));
    }
  }, []);

  useEffect(() => {
    fetchMLItemsMap().then(data => {
      const unique = new Map<string, DBMLItemMap>();
      for (const item of data) {
        if (!unique.has(item.item_id)) unique.set(item.item_id, item);
      }
      setItems(Array.from(unique.values()));
      setLoading(false);
    });
  }, []);

  // Load item detail when selected
  useEffect(() => {
    if (!selectedItemId) { setItemDetail(null); return; }
    setLoadingDetail(true);
    setError(null);
    setResult(null);
    fetch(`/api/ml/items-details?ids=${selectedItemId}`)
      .then(r => r.json())
      .then(json => {
        const wrapper = (json.items || [])[0] as MLItemDetail | undefined;
        if (wrapper?.code === 200 && wrapper.body) {
          setItemDetail(wrapper.body);
        } else {
          setError("No se pudo cargar el item de ML");
        }
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoadingDetail(false));
  }, [selectedItemId]);

  useEffect(() => {
    if (preselectedItemId) setSelectedItemId(preselectedItemId);
  }, [preselectedItemId]);

  const addVarPicture = () => setVarPictures(prev => [...prev, ""]);
  const removeVarPicture = (idx: number) => setVarPictures(prev => prev.filter((_, i) => i !== idx));
  const updateVarPicture = (idx: number, val: string) => setVarPictures(prev => prev.map((p, i) => i === idx ? val : p));

  const addVariation = async () => {
    if (!selectedItemId || !varPrice) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const pics = varPictures.filter(p => p.trim());
      const attrs = varAttrs.filter(a => a.value_name.trim());

      const res = await fetch("/api/ml/variations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: selectedItemId,
          sku: varLinkedSku || "",
          price: parseInt(varPrice),
          available_quantity: parseInt(varQty) || 1,
          pictures: pics.map(source => ({ source })),
          attributes: attrs,
        }),
      });
      const json = await res.json();
      if (json.error) {
        setResult({ ok: false, message: typeof json.error === "string" ? json.error : JSON.stringify(json.error, null, 2) });
      } else {
        setResult({ ok: true, message: `Variante publicada como nuevo item (ID: ${json.variation?.id}). Comparte family_name con ${selectedItemId}.` });
        setVarPrice("");
        setVarQty("1");
        setVarPictures([""]);
        setVarAttrs([]);
        setVarLinkedSku("");
      }
    } catch (err) {
      setResult({ ok: false, message: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {/* Info banner */}
      <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 8, background: "var(--blueBg)", color: "var(--blue)", fontSize: 12, border: "1px solid var(--blueBd)" }}>
        En el modelo User Products, cada variante es un <strong>item separado</strong> que comparte el mismo <code>family_name</code>. ML los agrupa automáticamente en la misma página.
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 12px 0" }}>🔀 Agregar Variante</h3>

        <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Item de referencia (se copiará family_name, categoría y config)</label>
        {loading ? (
          <div style={{ fontSize: 12, color: "var(--txt3)" }}>Cargando items...</div>
        ) : (
          <ItemSearchSelect items={items} selectedId={selectedItemId} onSelect={setSelectedItemId} />
        )}
      </div>

      {loadingDetail && <div className="card" style={{ textAlign: "center", padding: 20, color: "var(--amber)", fontSize: 12 }}>Cargando detalles del item...</div>}
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "var(--redBg)", color: "var(--red)", fontSize: 12, border: "1px solid var(--redBd)" }}>{error}</div>}

      {/* Reference item info */}
      {itemDetail && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {itemDetail.thumbnail && <img src={itemDetail.thumbnail} alt="" style={{ width: 50, height: 50, borderRadius: 6, objectFit: "cover" }} />}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{itemDetail.title}</div>
              <div style={{ fontSize: 11, color: "var(--txt3)" }}>{fmt(itemDetail.price)} · {itemDetail.category_id} · {itemDetail.status}</div>
            </div>
          </div>
        </div>
      )}

      {/* New variation form */}
      {itemDetail && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h4 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 12px 0" }}>Nueva variante (nuevo item con mismo family_name)</h4>

          {/* Price + Qty */}
          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Precio (CLP) *</label>
              <input type="number" value={varPrice} onChange={e => setVarPrice(e.target.value)} placeholder={String(itemDetail.price)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Cantidad</label>
              <input type="number" value={varQty} onChange={e => setVarQty(e.target.value)} min="1"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }} />
            </div>
          </div>

          {/* Attributes that differentiate this variant */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Atributos diferenciadores (lo que cambia en esta variante)</label>
            {varAttrs.map((attr, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <input type="text" value={attr.id} onChange={e => setVarAttrs(prev => prev.map((a, i) => i === idx ? { ...a, id: e.target.value } : a))} placeholder="ID (ej: COLOR, SIZE)"
                  style={{ width: 140, padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11 }} />
                <input type="text" value={attr.value_name} onChange={e => setVarAttrs(prev => prev.map((a, i) => i === idx ? { ...a, value_name: e.target.value } : a))} placeholder="Valor (ej: Rojo, M)"
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11 }} />
                <button onClick={() => setVarAttrs(prev => prev.filter((_, i) => i !== idx))}
                  style={{ padding: "2px 6px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", fontSize: 10, cursor: "pointer" }}>✕</button>
              </div>
            ))}
            <button onClick={() => setVarAttrs(prev => [...prev, { id: "", value_name: "" }])}
              style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer", marginTop: 4 }}>
              + Agregar atributo
            </button>
          </div>

          {/* Pictures */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Fotos (URLs)</label>
            {varPictures.map((pic, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                <input type="text" value={pic} onChange={e => updateVarPicture(idx, e.target.value)} placeholder="https://..."
                  style={{ flex: 1, padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 11 }} />
                {varPictures.length > 1 && (
                  <button onClick={() => removeVarPicture(idx)} style={{ padding: "2px 6px", borderRadius: 4, background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)", fontSize: 10, cursor: "pointer" }}>✕</button>
                )}
              </div>
            ))}
            {varPictures.length < 10 && (
              <button onClick={addVarPicture} style={{ padding: "4px 10px", borderRadius: 6, fontSize: 10, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer", marginTop: 4 }}>+ Agregar foto</button>
            )}
          </div>

          {/* Link to SKU */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--txt3)", fontWeight: 600, display: "block", marginBottom: 4 }}>Vincular a SKU (opcional)</label>
            <ProductSearchSelect productos={productos} selectedSku={varLinkedSku} onSelect={setVarLinkedSku} />
          </div>

          {/* Result */}
          {result && (
            <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: result.ok ? "var(--greenBg)" : "var(--redBg)", color: result.ok ? "var(--green)" : "var(--red)", fontSize: 12, border: `1px solid ${result.ok ? "var(--greenBd)" : "var(--redBd)"}`, whiteSpace: "pre-wrap" }}>
              {result.message}
            </div>
          )}
          <button onClick={addVariation} disabled={submitting || !varPrice}
            style={{
              padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: !varPrice ? "var(--bg3)" : "var(--greenBg)",
              color: !varPrice ? "var(--txt3)" : "var(--green)",
              border: `1px solid ${!varPrice ? "var(--bg4)" : "var(--greenBd)"}`,
              cursor: submitting ? "wait" : "pointer",
            }}>
            {submitting ? "Publicando variante..." : "Publicar como nueva variante"}
          </button>
        </div>
      )}

      {/* Empty state */}
      {!selectedItemId && !loading && (
        <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--txt3)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔀</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Selecciona un item de referencia</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Se creará un nuevo item con el mismo family_name, agrupándose como variante</div>
        </div>
      )}
    </div>
  );
}
