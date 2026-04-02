"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { fetchMLItemsMap } from "@/lib/db";
import type { DBMLItemMap } from "@/lib/db";
import { getStore } from "@/lib/store";

// ==================== TYPES ====================

type ComercialView = "listado" | "nueva" | "variantes";

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
        {([["listado", "Mis Publicaciones", "📋"], ["nueva", "Nueva Publicación", "➕"], ["variantes", "Agregar Variantes", "🔀"]] as const).map(([key, label, icon], i, arr) => (
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
  const [filter, setFilter] = useState<"all" | "active" | "paused" | "closed">("all");
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMLItemsMap();
      setItems(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  const refreshLive = useCallback(async () => {
    if (items.length === 0) return;
    setRefreshing(true);
    try {
      const uniqueIds = Array.from(new Set(items.map(i => i.item_id)));
      const newMap = new Map<string, MLItemDetail["body"]>();
      // Batch in groups of 20
      for (let i = 0; i < uniqueIds.length; i += 20) {
        const batch = uniqueIds.slice(i, i + 20);
        const res = await fetch(`/api/ml/items-details?ids=${batch.join(",")}`);
        const json = await res.json();
        if (json.items) {
          for (const wrapper of json.items as MLItemDetail[]) {
            if (wrapper.code === 200 && wrapper.body) {
              newMap.set(wrapper.body.id, wrapper.body);
            }
          }
        }
      }
      setLiveData(newMap);
      // Reload items to get updated cache
      await loadItems();
    } finally {
      setRefreshing(false);
    }
  }, [items, loadItems]);

  const toggleStatus = async (itemId: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    setActionLoading(itemId);
    try {
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, updates: { status: newStatus } }),
      });
      if (res.ok) {
        await loadItems();
        // Update live data
        setLiveData(prev => {
          const next = new Map(prev);
          const existing = next.get(itemId);
          if (existing) next.set(itemId, { ...existing, status: newStatus });
          return next;
        });
      }
    } finally {
      setActionLoading(null);
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
    const status = live?.status || (item as unknown as Record<string, unknown>).status_ml as string || "unknown";
    if (filter !== "all" && status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      const title = (live?.title || item.titulo || "").toLowerCase();
      const sku = item.sku.toLowerCase();
      const itemId = item.item_id.toLowerCase();
      if (!title.includes(q) && !sku.includes(q) && !itemId.includes(q)) return false;
    }
    return true;
  });

  const STATUS_COLORS: Record<string, string> = {
    active: "var(--green)", paused: "var(--amber)", closed: "var(--txt3)", under_review: "var(--blue)",
  };

  return (
    <div>
      {/* Header */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>📋 Mis Publicaciones</h2>
            <div style={{ fontSize: 12, color: "var(--txt3)", marginTop: 4 }}>{displayItems.length} publicaciones en ML</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="text" placeholder="Buscar SKU o título..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12, width: 180 }} />
            <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)}
              style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
              <option value="all">Todos</option>
              <option value="active">Activos</option>
              <option value="paused">Pausados</option>
              <option value="closed">Cerrados</option>
            </select>
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
          <div className="kpi"><div className="kpi-label">Activos</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--green)" }}>{displayItems.filter(i => (liveData.get(i.item_id)?.status || (i as unknown as Record<string, unknown>).status_ml) === "active").length}</div></div>
          <div className="kpi"><div className="kpi-label">Pausados</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--amber)" }}>{displayItems.filter(i => (liveData.get(i.item_id)?.status || (i as unknown as Record<string, unknown>).status_ml) === "paused").length}</div></div>
          <div className="kpi"><div className="kpi-label">Cerrados</div><div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, color: "var(--txt3)" }}>{displayItems.filter(i => (liveData.get(i.item_id)?.status || (i as unknown as Record<string, unknown>).status_ml) === "closed").length}</div></div>
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
        <div className="card" style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ width: 50 }}></th>
                <th>Título</th>
                <th>SKU</th>
                <th>Item ID</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "center" }}>Stock</th>
                <th style={{ textAlign: "center" }}>Vendidos</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const live = liveData.get(item.item_id);
                const title = live?.title || item.titulo || "—";
                const price = live?.price || (item as unknown as Record<string, number>).price || 0;
                const status = live?.status || (item as unknown as Record<string, string>).status_ml || "unknown";
                const thumb = live?.thumbnail || (item as unknown as Record<string, string>).thumbnail || "";
                const permalink = live?.permalink || (item as unknown as Record<string, string>).permalink || "";
                const qty = live?.available_quantity ?? item.available_quantity ?? 0;
                const sold = live?.sold_quantity ?? item.sold_quantity ?? 0;
                const statusColor = STATUS_COLORS[status] || "var(--txt3)";

                return (
                  <tr key={item.item_id}>
                    <td>
                      {thumb ? (
                        <img src={thumb} alt="" style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover", background: "var(--bg3)" }} />
                      ) : (
                        <div style={{ width: 40, height: 40, borderRadius: 6, background: "var(--bg3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>📦</div>
                      )}
                    </td>
                    <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</td>
                    <td className="mono" style={{ fontSize: 10 }}>{item.sku}</td>
                    <td className="mono" style={{ fontSize: 10 }}>
                      {permalink ? (
                        <a href={permalink} target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan)", textDecoration: "none" }}>{item.item_id}</a>
                      ) : item.item_id}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{price ? fmt(price) : "—"}</td>
                    <td style={{ textAlign: "center" }}>{qty}</td>
                    <td style={{ textAlign: "center" }}>{sold}</td>
                    <td>
                      <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: statusColor + "22", color: statusColor, fontWeight: 700 }}>
                        {status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        {status !== "closed" && (
                          <button onClick={() => toggleStatus(item.item_id, status)} disabled={actionLoading === item.item_id}
                            style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--bg3)", color: status === "active" ? "var(--amber)" : "var(--green)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                            {status === "active" ? "Pausar" : "Activar"}
                          </button>
                        )}
                        {status !== "closed" && (
                          <button onClick={() => onAddVariante(item.item_id)}
                            style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--bg3)", color: "var(--cyan)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                            +Var
                          </button>
                        )}
                        {status !== "closed" && (
                          <button onClick={() => closeItem(item.item_id)} disabled={actionLoading === item.item_id}
                            style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "var(--bg3)", color: "var(--red)", border: "1px solid var(--bg4)", cursor: "pointer" }}>
                            Cerrar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              <select value={linkedSku} onChange={e => setLinkedSku(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }}>
                <option value="">— Sin vincular —</option>
                {productos.map(p => <option key={p.sku} value={p.sku}>{p.sku} — {p.name}</option>)}
              </select>
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

// ==================== AGREGAR VARIANTES (User Products model) ====================
// En el modelo multi-warehouse/User Products, las variantes son items separados
// que comparten el mismo family_name. No se usa POST /items/{id}/variations.

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
          <select value={selectedItemId} onChange={e => setSelectedItemId(e.target.value)}
            style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 13 }}>
            <option value="">— Seleccionar item de referencia —</option>
            {items.map(item => (
              <option key={item.item_id} value={item.item_id}>{item.item_id} · {item.sku} · {item.titulo || "Sin título"}</option>
            ))}
          </select>
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
            <select value={varLinkedSku} onChange={e => setVarLinkedSku(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--txt)", border: "1px solid var(--bg4)", fontSize: 12 }}>
              <option value="">— Sin vincular —</option>
              {productos.map(p => <option key={p.sku} value={p.sku}>{p.sku} — {p.name}</option>)}
            </select>
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
