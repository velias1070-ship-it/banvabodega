"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { fmtCLP } from "@/lib/ml-shipping";
import MarginSimulatorModal, { type SimulatorItem } from "@/components/MarginSimulatorModal";

type MarginRow = {
  item_id: string;
  sku: string;
  titulo: string;
  category_id: string | null;
  listing_type: string | null;
  price_ml: number;
  precio_venta: number;
  tiene_promo: boolean;
  promo_type: string | null;
  promo_name: string | null;
  promo_pct: number | null;
  promos_postulables: Array<{ name: string; type: string; id: string | null }> | null;
  status_ml: string | null;
  costo_neto: number;
  costo_bruto: number;
  peso_facturable: number;
  tramo_label: string | null;
  comision_pct: number;
  comision_clp: number;
  envio_clp: number;
  margen_clp: number;
  margen_pct: number;
  zona: "barato" | "medio" | "caro" | null;
  synced_at: string;
  sync_error: string | null;
};

type SortKey =
  | "sku"
  | "titulo"
  | "precio_venta"
  | "costo_bruto"
  | "comision_clp"
  | "envio_clp"
  | "margen_clp"
  | "margen_pct"
  | "peso_facturable";

type ZonaFilter = "all" | "barato" | "medio" | "caro";
type MarginFilter = "all" | "neg" | "low" | "mid" | "high";
type StatusFilter = "all" | "active" | "paused" | "other";

type TicketData = { sku_venta: string; unidades_30d: number; ticket_30d: number; unidades_7d: number; ticket_7d: number };

export default function AdminMargenes() {
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [ticketMap, setTicketMap] = useState<Map<string, TicketData>>(new Map());
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Refresh state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });

  // Filters
  const [q, setQ] = useState("");
  const [zona, setZona] = useState<ZonaFilter>("all");
  const [marginF, setMarginF] = useState<MarginFilter>("all");
  const [soloPromo, setSoloPromo] = useState(false);
  const [sinPromo, setSinPromo] = useState(false);
  const [statusF, setStatusF] = useState<StatusFilter>("active");
  const [promoFilter, setPromoFilter] = useState<string>("all");
  const [soloDead, setSoloDead] = useState(false);
  const [costoMin, setCostoMin] = useState<string>("");
  const [costoMax, setCostoMax] = useState<string>("");
  const [agruparPorCosto, setAgruparPorCosto] = useState(false);
  const [soloInconsistentes, setSoloInconsistentes] = useState(false);

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>("margen_pct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Simulador
  const [simItem, setSimItem] = useState<SimulatorItem | null>(null);

  // Selección múltiple + bulk apply
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPrice, setBulkPrice] = useState<string>("");
  const [bulkApplying, setBulkApplying] = useState<"none" | "lista" | "promo" | "campaign">("none");
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0, ok: 0, err: 0 });
  const [bulkErrors, setBulkErrors] = useState<Array<{ sku: string; error: string }>>([]);

  // Bulk campaign modal
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [campaignLoading, setCampaignLoading] = useState(false);
  type RangoItem = { min: number; max: number; suggested: number };
  type CommonPromo = {
    id: string | null;
    type: string;
    name: string;
    // Rango "intersección" — el único rango que sirve para TODOS los items
    // (MAX de mins, MIN de maxes). Útil como default si se aplica a todos.
    min_price: number;
    max_price: number;
    suggested_price: number;
    start_date: string | null;
    finish_date: string | null;
    offer_type: string | null;
    itemsPostulables: string[]; // item_ids en candidate
    itemsActivos: string[];     // item_ids ya started/pending
    itemsNoDisponible: string[]; // item_ids sin esta promo
    // Rango específico de CADA item — las promos de ML tienen min/max por-item,
    // no por-campaña. Validar con esto, no con min_price/max_price.
    rangosPorItem: Map<string, RangoItem>;
  };
  const [commonPromos, setCommonPromos] = useState<CommonPromo[]>([]);
  const [selectedPromoKey, setSelectedPromoKey] = useState<string | null>(null);
  const [selectedPromoKeys, setSelectedPromoKeys] = useState<Set<string>>(new Set());
  const togglePromoKey = (key: string) => {
    setSelectedPromoKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const [showErrorsModal, setShowErrorsModal] = useState(false);
  const [campaignMode, setCampaignMode] = useState<"join" | "leave">("join");

  const toggleSelect = (itemId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const [bgSyncing, setBgSyncing] = useState(false);

  const loadCache = useCallback(async (): Promise<MarginRow[]> => {
    setLoading(true);
    try {
      const [resCache, resTicket] = await Promise.all([
        fetch("/api/ml/margin-cache"),
        fetch("/api/ml/ticket-promedio").catch(() => null),
      ]);
      const data = await resCache.json();
      const items: MarginRow[] = data.items || [];
      setRows(items);
      setLastSync(data.last_sync || null);
      if (resTicket) {
        try {
          const td = await resTicket.json();
          const map = new Map<string, TicketData>();
          for (const t of (td.items || []) as TicketData[]) {
            if (t.sku_venta) map.set(t.sku_venta, t);
          }
          setTicketMap(map);
        } catch { /* ignore ticket fetch errors */ }
      }
      return items;
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh silencioso en background: al montar la vista, trigger un
  // refresh de los 30 items mas viejos. El cron de vercel tambien corre cada
  // 5 min pero esto da frescura inmediata cuando el usuario entra.
  const backgroundRefreshStale = useCallback(async () => {
    setBgSyncing(true);
    try {
      await fetch("/api/ml/margin-cache/refresh?stale=true&limit=30", { method: "POST" });
      await loadCache();
    } catch { /* silent */ }
    setBgSyncing(false);
  }, [loadCache]);

  useEffect(() => {
    loadCache().then((items) => {
      // Disparar el refresh silencioso despues de cargar la cache existente,
      // para que el usuario vea la data inmediatamente y luego se actualiza.
      backgroundRefreshStale();
      // Deep-link: ?sku=XXX prefiltra la tabla. ?sim=1 además abre el simulador.
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        const skuParam = params.get("sku");
        if (!skuParam) return;
        setQ(skuParam);
        if (params.get("sim") === "1") {
          const row = items.find(r => r.sku.toUpperCase() === skuParam.toUpperCase());
          if (row) {
            const tk = ticketMap.get(row.sku);
            setSimItem({
              item_id: row.item_id,
              sku: row.sku,
              titulo: row.titulo,
              price_ml: row.price_ml,
              precio_venta: row.precio_venta,
              costo_bruto: row.costo_bruto,
              peso_facturable: row.peso_facturable,
              comision_pct: Number(row.comision_pct),
              tiene_promo: row.tiene_promo,
              promo_pct: row.promo_pct,
              promo_type: row.promo_type,
              ticket_30d: tk?.ticket_30d,
              unidades_30d: tk?.unidades_30d,
              ticket_7d: tk?.ticket_7d,
              unidades_7d: tk?.unidades_7d,
            });
          }
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg("Iniciando...");
    setProgress({ processed: 0, total: 0 });
    try {
      let offset = 0;
      const limit = 15;
      while (true) {
        const res = await fetch(`/api/ml/margin-cache/refresh?offset=${offset}&limit=${limit}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setRefreshMsg(`Error: ${data.error || res.statusText}`);
          break;
        }
        setProgress({ processed: data.processed, total: data.total });
        setRefreshMsg(`Procesando ${data.processed}/${data.total}...`);
        offset = data.processed;
        if (data.done || data.chunk === 0) {
          setRefreshMsg(`Refresh completo: ${data.processed} items`);
          break;
        }
      }
      await loadCache();
    } catch (e) {
      setRefreshMsg(`Error: ${e instanceof Error ? e.message : "?"}`);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(null), 5000);
    }
  };

  const cMin = costoMin ? Number(costoMin.replace(/\D/g, "")) : null;
  const cMax = costoMax ? Number(costoMax.replace(/\D/g, "")) : null;

  // Normaliza: lowercase + quita acentos. "Sábanas" -> "sabanas"
  const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Parsea el query en tokens de texto + tokens numericos tipo "margen<10", "precio>20000".
  // Token de texto: match substring tolerante (sin acentos, ignora "s" final).
  // Operadores soportados: <, <=, >, >=, =
  // Keywords: sin-costo, con-promo, en-perdida
  type NumTok = { field: "precio" | "costo" | "margen" | "comision" | "envio"; op: "<" | "<=" | ">" | ">=" | "="; val: number };
  type ParsedQuery = { textTokens: string[]; numTokens: NumTok[]; flags: Set<string> };
  const parseQuery = (raw: string): ParsedQuery => {
    const out: ParsedQuery = { textTokens: [], numTokens: [], flags: new Set() };
    const parts = normalize(raw).split(/\s+/).filter(Boolean);
    for (const p of parts) {
      if (p === "sin-costo" || p === "con-promo" || p === "sin-promo" || p === "en-perdida" || p === "sin-venta") {
        out.flags.add(p);
        continue;
      }
      const m = p.match(/^(precio|costo|margen|comision|envio)(<=|>=|<|>|=)(-?\d+(?:\.\d+)?)$/);
      if (m) {
        out.numTokens.push({ field: m[1] as NumTok["field"], op: m[2] as NumTok["op"], val: Number(m[3]) });
        continue;
      }
      // quitar "s" final para tolerar "sabana" = "sabanas"
      const base = p.length > 3 && p.endsWith("s") ? p.slice(0, -1) : p;
      out.textTokens.push(base);
    }
    return out;
  };

  const parsedQ = useMemo(() => parseQuery(q), [q]);

  const filtered = useMemo(() => {
    const matchRow = (r: MarginRow) => {
      if (parsedQ.textTokens.length > 0) {
        const hay = normalize(`${r.sku} ${r.titulo} ${r.item_id}`);
        for (const t of parsedQ.textTokens) {
          if (!hay.includes(t)) return false;
        }
      }
      for (const nt of parsedQ.numTokens) {
        const v = nt.field === "precio" ? r.precio_venta
          : nt.field === "costo" ? r.costo_bruto
          : nt.field === "margen" ? Number(r.margen_pct)
          : nt.field === "comision" ? r.comision_clp
          : r.envio_clp;
        const pass = nt.op === "<" ? v < nt.val
          : nt.op === "<=" ? v <= nt.val
          : nt.op === ">" ? v > nt.val
          : nt.op === ">=" ? v >= nt.val
          : v === nt.val;
        if (!pass) return false;
      }
      if (parsedQ.flags.has("sin-costo") && r.costo_bruto > 0) return false;
      if (parsedQ.flags.has("con-promo") && !r.tiene_promo) return false;
      if (parsedQ.flags.has("sin-promo") && r.tiene_promo) return false;
      if (parsedQ.flags.has("en-perdida") && r.margen_clp >= 0) return false;
      return true;
    };
    let list = rows.filter(r => {
      if (!matchRow(r)) return false;
      if (zona !== "all" && r.zona !== zona) return false;
      if (soloPromo && !r.tiene_promo) return false;
      if (sinPromo && r.tiene_promo) return false;
      if (promoFilter !== "all") {
        // Prefijo "en:<nombre>" o "pos:<nombre>" (postulable pero sin postular)
        const [modo, ...rest] = promoFilter.split(":");
        const nombreTarget = rest.join(":");
        if (modo === "en") {
          if (!r.tiene_promo) return false;
          const nombre = (r.promo_name || r.promo_type || "").trim();
          if (nombre !== nombreTarget) return false;
        } else if (modo === "pos") {
          const dispo = r.promos_postulables || [];
          const yaEn = r.tiene_promo && (r.promo_name || r.promo_type || "").trim() === nombreTarget;
          if (yaEn) return false; // ya esta dentro, no lo muestro
          if (!dispo.some(p => (p.name || p.type || "").trim() === nombreTarget)) return false;
        }
      }
      if (statusF !== "all") {
        const s = r.status_ml || "";
        if (statusF === "active" && s !== "active") return false;
        if (statusF === "paused" && s !== "paused") return false;
        if (statusF === "other" && (s === "active" || s === "paused")) return false;
      }
      // Dead zone: precio_venta en [19990, 28250] (aprox) donde margen < sweet spot bajo threshold
      if (soloDead) {
        if (r.precio_venta < 19990) return false;
        if (r.margen_pct >= 22) return false;
      }
      if (cMin !== null && r.costo_bruto < cMin) return false;
      if (cMax !== null && r.costo_bruto > cMax) return false;
      if (marginF === "neg" && r.margen_pct >= 0) return false;
      if (marginF === "low" && (r.margen_pct < 0 || r.margen_pct >= 15)) return false;
      if (marginF === "mid" && (r.margen_pct < 15 || r.margen_pct >= 30)) return false;
      if (marginF === "high" && r.margen_pct < 30) return false;
      return true;
    });

    // "Precios inconsistentes": filas cuyo costo_bruto es compartido por >=2 items
    // y el rango de precios dentro de ese grupo excede 20% (max/min - 1 > 0.20).
    if (soloInconsistentes) {
      const byCosto = new Map<number, MarginRow[]>();
      for (const r of list) {
        if (r.costo_bruto <= 0) continue;
        if (!byCosto.has(r.costo_bruto)) byCosto.set(r.costo_bruto, []);
        byCosto.get(r.costo_bruto)!.push(r);
      }
      const badCostos = new Set<number>();
      Array.from(byCosto.entries()).forEach(([costo, items]) => {
        if (items.length < 2) return;
        const precios = items.map((x: MarginRow) => x.precio_venta).filter((p: number) => p > 0);
        if (precios.length < 2) return;
        const mn = Math.min(...precios);
        const mx = Math.max(...precios);
        if (mn > 0 && (mx / mn - 1) > 0.20) badCostos.add(costo);
      });
      list = list.filter(r => badCostos.has(r.costo_bruto));
    }

    if (agruparPorCosto) {
      list = [...list].sort((a, b) => {
        if (a.costo_bruto !== b.costo_bruto) return b.costo_bruto - a.costo_bruto;
        return b.precio_venta - a.precio_venta;
      });
    } else {
      list = [...list].sort((a, b) => {
        const av = a[sortKey] as number | string;
        const bv = b[sortKey] as number | string;
        if (typeof av === "number" && typeof bv === "number") {
          return sortDir === "asc" ? av - bv : bv - av;
        }
        return sortDir === "asc"
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      });
    }
    return list;
  }, [rows, q, zona, marginF, soloPromo, sinPromo, statusF, promoFilter, soloDead, cMin, cMax, soloInconsistentes, agruparPorCosto, sortKey, sortDir]);

  // Grupo "Ya postulados": conteo por promo activa
  const promosActivas = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.tiene_promo) continue;
      const nombre = (r.promo_name || r.promo_type || "").trim();
      if (!nombre) continue;
      m.set(nombre, (m.get(nombre) || 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Grupo "Postulables sin postular": conteo por promo candidate (excluyendo
  // los items que ya estan dentro de esa misma promo).
  const promosCandidate = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const dispo = r.promos_postulables || [];
      if (dispo.length === 0) continue;
      const nombreActiva = r.tiene_promo ? (r.promo_name || r.promo_type || "").trim() : "";
      for (const p of dispo) {
        const nombre = (p.name || p.type || "").trim();
        if (!nombre || nombre === nombreActiva) continue;
        m.set(nombre, (m.get(nombre) || 0) + 1);
      }
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Stats por grupo de costo — usado en header de grupo y chip "inconsistentes"
  const grupoPorCosto = useMemo(() => {
    const m = new Map<number, { count: number; precioMin: number; precioMax: number; margenMin: number; margenMax: number }>();
    for (const r of filtered) {
      if (r.costo_bruto <= 0) continue;
      const ex = m.get(r.costo_bruto);
      if (!ex) {
        m.set(r.costo_bruto, { count: 1, precioMin: r.precio_venta, precioMax: r.precio_venta, margenMin: Number(r.margen_pct), margenMax: Number(r.margen_pct) });
      } else {
        ex.count++;
        ex.precioMin = Math.min(ex.precioMin, r.precio_venta);
        ex.precioMax = Math.max(ex.precioMax, r.precio_venta);
        ex.margenMin = Math.min(ex.margenMin, Number(r.margen_pct));
        ex.margenMax = Math.max(ex.margenMax, Number(r.margen_pct));
      }
    }
    return m;
  }, [filtered]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };

  const allVisibleSelected = filtered.length > 0 && filtered.every(r => selected.has(r.item_id));
  const toggleSelectAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const r of filtered) next.delete(r.item_id);
      } else {
        for (const r of filtered) next.add(r.item_id);
      }
      return next;
    });
  };

  // Selecciona/deselecciona todos los items del grupo de costo especificado
  const toggleSelectGroup = (costoBruto: number) => {
    const groupItems = filtered.filter(r => r.costo_bruto === costoBruto);
    if (groupItems.length === 0) return;
    const allGroupSelected = groupItems.every(r => selected.has(r.item_id));
    setSelected(prev => {
      const next = new Set(prev);
      if (allGroupSelected) {
        for (const r of groupItems) next.delete(r.item_id);
      } else {
        for (const r of groupItems) next.add(r.item_id);
      }
      return next;
    });
  };

  const abrirCampaignModal = async (mode: "join" | "leave" = "join") => {
    const items = rows.filter(r => selected.has(r.item_id));
    if (items.length === 0) return;
    setCampaignMode(mode);
    setCampaignModalOpen(true);
    setCampaignLoading(true);
    setCommonPromos([]);
    setSelectedPromoKey(null);
    setSelectedPromoKeys(new Set());

    // Fetch promos para todos en batches de 5 para no saturar ML API
    type FetchResult = { item_id: string; promos: Array<{ id: string | null; type: string; name: string; status: string; min_price: number; max_price: number; suggested_price: number; start_date: string | null; finish_date: string | null; offer_type: string | null; permite_custom_price: boolean }> };
    const results: FetchResult[] = [];
    const batchSize = 5;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async it => {
        try {
          const res = await fetch(`/api/ml/item-promotions?item_id=${it.item_id}&_=${Date.now()}`, { cache: "no-store" });
          const data = await res.json();
          return { item_id: it.item_id, promos: Array.isArray(data.promotions) ? data.promotions : [] };
        } catch {
          return { item_id: it.item_id, promos: [] };
        }
      }));
      results.push(...batchResults);
    }

    // Agrupar por (promotion_id || type) para encontrar promos comunes
    const byKey = new Map<string, CommonPromo>();
    for (const r of results) {
      for (const p of r.promos) {
        if (!p.permite_custom_price) continue;
        const key = p.id ? `${p.type}::${p.id}` : `${p.type}::_`;
        let common = byKey.get(key);
        if (!common) {
          common = {
            id: p.id,
            type: p.type,
            name: p.name,
            // Inicializar con el rango del primer item; se refina abajo a intersección
            min_price: p.min_price,
            max_price: p.max_price,
            suggested_price: p.suggested_price,
            start_date: p.start_date,
            finish_date: p.finish_date,
            offer_type: p.offer_type,
            itemsPostulables: [],
            itemsActivos: [],
            itemsNoDisponible: [],
            rangosPorItem: new Map(),
          };
          byKey.set(key, common);
        }
        // Guardar rango ESPECÍFICO de este item para esta promo
        common.rangosPorItem.set(r.item_id, {
          min: p.min_price,
          max: p.max_price,
          suggested: p.suggested_price,
        });
        // Refinar rango global a la intersección: MAX(mins), MIN(maxes)
        if (p.min_price > 0 && p.min_price > common.min_price) common.min_price = p.min_price;
        if (p.max_price > 0 && (common.max_price === 0 || p.max_price < common.max_price)) common.max_price = p.max_price;
        if (p.status === "candidate") common.itemsPostulables.push(r.item_id);
        else if (p.status === "started" || p.status === "pending") common.itemsActivos.push(r.item_id);
      }
    }
    // Completar itemsNoDisponible: los que no aparecen en ninguna lista
    const commonList = Array.from(byKey.values());
    for (const common of commonList) {
      const inEither = new Set([...common.itemsPostulables, ...common.itemsActivos]);
      for (const r of items) {
        if (!inEither.has(r.item_id)) common.itemsNoDisponible.push(r.item_id);
      }
    }

    // Ordenar por mayor cantidad de items que pueden participar
    const sorted = commonList.sort((a, b) =>
      (b.itemsPostulables.length + b.itemsActivos.length) - (a.itemsPostulables.length + a.itemsActivos.length)
    );
    setCommonPromos(sorted);
    setCampaignLoading(false);
  };

  // Refresca el cache de margen solo para los items afectados (más rápido que refresh completo).
  // IMPORTANTE: ML tarda 3-5s en propagar cambios de promociones tras un POST/DELETE. Si el
  // refresh se ejecuta inmediatamente, el endpoint va a leer el estado VIEJO de ML y guardar
  // en cache datos desactualizados. Por eso esperamos antes de gatillar el refresh.
  const refrescarItemsAfectados = async (itemIds: string[]) => {
    if (itemIds.length === 0) return;
    try {
      // Delay de propagación ML: esperar a que /seller-promotions/items/{id} refleje
      // los cambios hechos por el bulk antes de re-leerlo.
      await new Promise(r => setTimeout(r, 4000));
      const q = itemIds.join(",");
      await fetch(`/api/ml/margin-cache/refresh?item_ids=${encodeURIComponent(q)}`, { method: "POST" });
      await loadCache();
    } catch { /* silent */ }
  };

  const runBulkCampaign = async () => {
    const target = parseInt(bulkPrice) || 0;
    if (target <= 0) { alert("Ingresa un precio válido"); return; }

    // Multi-promo: el user puede haber seleccionado N promos. Se postula a cada
    // una con el mismo precio target. Para cada promo, la logica interna es
    // la de antes: validar rango por-item, leave+rejoin en ya activos, join
    // directo en postulables.
    const keys = Array.from(selectedPromoKeys);
    if (keys.length === 0) return;
    const promos = keys
      .map(k => commonPromos.find(p => (p.id ? `${p.type}::${p.id}` : `${p.type}::_`) === k))
      .filter((x): x is CommonPromo => !!x);
    if (promos.length === 0) return;

    // Calcular total de unidades a tocar (suma cross-promo) para barra de progreso.
    // No deduplicamos items: el mismo SKU postulado a 2 promos son 2 operaciones.
    let totalOps = 0;
    const plan: Array<{ promo: CommonPromo; validos: string[]; invalidos: Array<{ itemId: string; sku: string; rango: RangoItem; motivo: string }> }> = [];
    for (const promo of promos) {
      const todosAplicables = [...promo.itemsPostulables, ...promo.itemsActivos];
      const invalidos: Array<{ itemId: string; sku: string; rango: RangoItem; motivo: string }> = [];
      const validos: string[] = [];
      for (const itemId of todosAplicables) {
        const rango = promo.rangosPorItem.get(itemId);
        const row = rows.find(r => r.item_id === itemId);
        const sku = row?.sku || itemId;
        if (!rango) { validos.push(itemId); continue; }
        if (rango.min > 0 && target < rango.min) {
          invalidos.push({ itemId, sku, rango, motivo: `[${promo.name}] ${fmtCLP(target)} < min ${fmtCLP(rango.min)}` });
        } else if (rango.max > 0 && target > rango.max) {
          invalidos.push({ itemId, sku, rango, motivo: `[${promo.name}] ${fmtCLP(target)} > max ${fmtCLP(rango.max)}` });
        } else {
          validos.push(itemId);
        }
      }
      totalOps += validos.length;
      plan.push({ promo, validos, invalidos });
    }

    const totalInvalidos = plan.reduce((s, p) => s + p.invalidos.length, 0);
    if (totalOps === 0) {
      const lista = plan.flatMap(p => p.invalidos).slice(0, 10).map(i => `• ${i.motivo}`).join("\n");
      alert(`Ningún ítem acepta ${fmtCLP(target)} en las ${promos.length} promo${promos.length !== 1 ? "s" : ""} seleccionadas:\n\n${lista}`);
      return;
    }
    if (totalInvalidos > 0) {
      const preview = plan.flatMap(p => p.invalidos).slice(0, 10).map(i => `• ${i.sku}: ${i.motivo}`).join("\n");
      const extra = totalInvalidos > 10 ? `\n… y ${totalInvalidos - 10} más` : "";
      const ok = confirm(
        `${totalInvalidos} combinación${totalInvalidos !== 1 ? "es" : ""} item×promo fuera de rango (se skipean):\n\n${preview}${extra}\n\n¿Aplicar a las ${totalOps} operaciones válidas en ${promos.length} promo${promos.length !== 1 ? "s" : ""}?`
      );
      if (!ok) return;
    }

    setBulkApplying("campaign");
    setBulkProgress({ done: 0, total: totalOps, ok: 0, err: totalInvalidos });
    const errors: Array<{ sku: string; error: string }> = plan.flatMap(p => p.invalidos.map(i => ({ sku: i.sku, error: i.motivo })));
    setBulkErrors(errors);
    let ok = 0;
    let done = 0;

    const joinItem = async (itemId: string, promo: CommonPromo) => {
      const res = await fetch("/api/ml/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: itemId,
          action: "join",
          promotion_id: promo.id,
          promotion_type: promo.type,
          deal_price: target,
          offer_type: promo.offer_type,
        }),
      });
      const data = await res.json();
      return { ok: res.ok, msg: String(data.error || (res.ok ? "" : `HTTP ${res.status}`)) };
    };

    const leaveItem = async (itemId: string, promo: CommonPromo) => {
      const res = await fetch("/api/ml/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: itemId,
          action: "delete",
          promotion_id: promo.id,
          promotion_type: promo.type,
        }),
      });
      const data = await res.json();
      return { ok: res.ok, msg: String(data.error || (res.ok ? "" : `HTTP ${res.status}`)) };
    };

    const itemsAfectadosGlobal = new Set<string>();
    for (const { promo, validos } of plan) {
      const setActivos = new Set(promo.itemsActivos);
      for (const itemId of validos) {
        const row = rows.find(r => r.item_id === itemId);
        try {
          if (setActivos.has(itemId)) {
            const leave = await leaveItem(itemId, promo);
            if (!leave.ok && !/not.*found|does not|no existe/i.test(leave.msg)) {
              throw new Error(`leave: ${leave.msg}`);
            }
            await new Promise(r => setTimeout(r, 400));
          }
          const join = await joinItem(itemId, promo);
          if (!join.ok) {
            if (/offer_already_exists/i.test(join.msg)) {
              await new Promise(r => setTimeout(r, 1200));
              await leaveItem(itemId, promo).catch(() => null);
              await new Promise(r => setTimeout(r, 600));
              const retry = await joinItem(itemId, promo);
              if (!retry.ok) throw new Error(retry.msg || "retry fallo");
            } else {
              throw new Error(join.msg);
            }
          }
          ok++;
          itemsAfectadosGlobal.add(itemId);
        } catch (e) {
          errors.push({ sku: `${row?.sku || itemId} [${promo.name}]`, error: e instanceof Error ? e.message : "Error" });
        }
        done++;
        setBulkProgress({ done, total: totalOps, ok, err: errors.length });
      }
    }
    setBulkErrors(errors);
    setBulkApplying("none");
    await refrescarItemsAfectados(Array.from(itemsAfectadosGlobal));
  };

  const runBulkLeave = async () => {
    if (!selectedPromoKey) return;
    const promo = commonPromos.find(p => (p.id ? `${p.type}::${p.id}` : `${p.type}::_`) === selectedPromoKey);
    if (!promo) return;
    // Solo los items que están dentro (started/pending), no los candidates
    const afectados = promo.itemsActivos;
    if (afectados.length === 0) { alert("Ningún ítem está actualmente en esta promo"); return; }
    if (!confirm(`¿Salir de "${promo.name}" para ${afectados.length} ítem${afectados.length !== 1 ? "s" : ""}?`)) return;

    setBulkApplying("campaign");
    setBulkProgress({ done: 0, total: afectados.length, ok: 0, err: 0 });
    setBulkErrors([]);
    const errors: Array<{ sku: string; error: string }> = [];
    let ok = 0;

    for (let i = 0; i < afectados.length; i++) {
      const itemId = afectados[i];
      const row = rows.find(r => r.item_id === itemId);
      try {
        const res = await fetch("/api/ml/promotions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_id: itemId,
            action: "delete",
            promotion_id: promo.id,
            promotion_type: promo.type,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        ok++;
      } catch (e) {
        errors.push({ sku: row?.sku || itemId, error: e instanceof Error ? e.message : "Error" });
      }
      setBulkProgress({ done: i + 1, total: afectados.length, ok, err: errors.length });
    }
    setBulkErrors(errors);
    setBulkApplying("none");
    await refrescarItemsAfectados(afectados);
  };

  const runBulk = async (mode: "lista" | "promo") => {
    const target = parseInt(bulkPrice) || 0;
    if (target <= 0) { alert("Ingresa un precio válido"); return; }
    const items = rows.filter(r => selected.has(r.item_id));
    if (items.length === 0) return;
    if (mode === "promo") {
      const bloquean = items.filter(r => target >= r.price_ml);
      if (bloquean.length > 0) {
        if (!confirm(`${bloquean.length} ítems tienen precio lista <= ${target}. Esas fallarán. ¿Continuar con los que sí aplican?`)) return;
      }
    }

    // Pre-validación: consultar promos activas/postulables por cada item en
    // paralelo y chequear que el target caiga en algún rango permitido.
    // Esto anticipa el ERROR_CREDIBILITY_DISCOUNTED_PRICE que ML tira cuando
    // el precio no cumple el mínimo de credibilidad de la campaña vigente.
    setBulkApplying(mode);
    setBulkProgress({ done: 0, total: items.length, ok: 0, err: 0 });
    setBulkErrors([]);
    type PromoLite = { min_price: number; max_price: number; activa: boolean; postulable: boolean; permite_custom_price: boolean; name: string };
    const promosPorItem = new Map<string, PromoLite[]>();
    const batch = 5;
    for (let i = 0; i < items.length; i += batch) {
      const chunk = items.slice(i, i + batch);
      const res = await Promise.all(chunk.map(async it => {
        try {
          const r = await fetch(`/api/ml/item-promotions?item_id=${it.item_id}&_=${Date.now()}`, { cache: "no-store" });
          const d = await r.json();
          return { id: it.item_id, promos: (Array.isArray(d.promotions) ? d.promotions : []) as PromoLite[] };
        } catch {
          return { id: it.item_id, promos: [] as PromoLite[] };
        }
      }));
      for (const row of res) promosPorItem.set(row.id, row.promos);
    }

    const invalidos: Array<{ sku: string; motivo: string }> = [];
    const aplicables: typeof items = [];
    for (const it of items) {
      const promos = (promosPorItem.get(it.item_id) || []).filter(p => p.permite_custom_price && (p.activa || p.postulable));
      if (promos.length === 0) { aplicables.push(it); continue; }
      // Si el item tiene alguna promo con rango, el target debe caer dentro de
      // AL MENOS una de ellas (intersección con "cualquiera permite").
      const encaja = promos.some(p =>
        (p.min_price === 0 || target >= p.min_price) &&
        (p.max_price === 0 || target <= p.max_price)
      );
      if (encaja) { aplicables.push(it); continue; }
      const detalles = promos
        .filter(p => p.min_price > 0 || p.max_price > 0)
        .map(p => `${p.name}: ${fmtCLP(p.min_price)}-${fmtCLP(p.max_price)}`)
        .join(" | ");
      invalidos.push({ sku: it.sku, motivo: `Fuera de rango ${detalles || "(sin rango explícito)"}` });
    }

    if (invalidos.length > 0) {
      const lista = invalidos.slice(0, 10).map(i => `• ${i.sku}: ${i.motivo}`).join("\n");
      const extra = invalidos.length > 10 ? `\n… y ${invalidos.length - 10} más` : "";
      if (aplicables.length === 0) {
        setBulkApplying("none");
        alert(`Ningún ítem acepta ${fmtCLP(target)} con sus campañas vigentes:\n\n${lista}${extra}`);
        return;
      }
      const cont = confirm(
        `${invalidos.length} ítem${invalidos.length !== 1 ? "s" : ""} no acepta${invalidos.length !== 1 ? "n" : ""} ${fmtCLP(target)}:\n\n${lista}${extra}\n\n¿Aplicar solo a los ${aplicables.length} válidos?`
      );
      if (!cont) { setBulkApplying("none"); return; }
    }

    const errors: Array<{ sku: string; error: string }> = invalidos.map(i => ({ sku: i.sku, error: i.motivo }));
    setBulkErrors(errors);
    setBulkProgress({ done: 0, total: aplicables.length, ok: 0, err: invalidos.length });
    let ok = 0;

    const start = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) + "T23:59:59.000Z";

    for (let i = 0; i < aplicables.length; i++) {
      const it = aplicables[i];
      try {
        let res: Response;
        if (mode === "lista") {
          res = await fetch("/api/ml/item-update", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ item_id: it.item_id, updates: { price: target } }),
          });
        } else {
          if (target >= it.price_ml) throw new Error("target >= price_ml");
          res = await fetch("/api/ml/promotions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              item_id: it.item_id,
              action: "create_discount",
              deal_price: target,
              start_date: start,
              finish_date: end,
            }),
          });
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        ok++;
      } catch (e) {
        errors.push({ sku: it.sku, error: e instanceof Error ? e.message : "Error" });
      }
      setBulkProgress({ done: i + 1, total: aplicables.length, ok, err: errors.length });
    }
    setBulkErrors(errors);
    setBulkApplying("none");
    // Refresh focalizado de la cache
    await refrescarItemsAfectados(aplicables.map(x => x.item_id));
  };

  // KPIs
  const kpi = useMemo(() => {
    const count = filtered.length;
    const neg = filtered.filter(r => r.margen_clp < 0).length;
    const avgPct = count > 0 ? filtered.reduce((s, r) => s + Number(r.margen_pct), 0) / count : 0;
    const totalMargen = filtered.reduce((s, r) => s + r.margen_clp, 0);
    return { count, neg, avgPct, totalMargen };
  }, [filtered]);

  const SortHeader = ({ k, label, align = "right" }: { k: SortKey; label: string; align?: "left" | "right" }) => (
    <th
      onClick={() => toggleSort(k)}
      style={{
        padding: "10px 8px",
        textAlign: align,
        fontSize: 10,
        color: sortKey === k ? "var(--cyan)" : "var(--txt3)",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : ""}
    </th>
  );

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const lastSyncLabel = lastSync ? new Date(lastSync).toLocaleString("es-CL") : "nunca";

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--cyan)", display: "flex", alignItems: "center", gap: 8 }}>
            Márgenes por publicación
            {bgSyncing && (
              <span style={{ fontSize: 10, color: "var(--cyan)", fontWeight: 500, background: "var(--cyanBg)", padding: "2px 8px", borderRadius: 10, border: "1px solid var(--cyanBd)" }}>
                ⟳ sincronizando...
              </span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
            Último refresh: {lastSyncLabel} · {rows.length} items · auto-sync cada 5 min
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {refreshMsg && (
            <div style={{ fontSize: 11, color: "var(--txt2)", padding: "4px 8px", background: "var(--bg3)", borderRadius: 4 }}>
              {refreshMsg}
              {refreshing && progress.total > 0 && <span style={{ marginLeft: 6, color: "var(--cyan)" }}>({pct}%)</span>}
            </div>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="scan-btn blue"
            style={{ padding: "8px 14px", fontSize: 12, cursor: refreshing ? "wait" : "pointer" }}
          >
            {refreshing ? "Refrescando..." : "🔄 Refrescar"}
          </button>
        </div>
      </div>

      {refreshing && progress.total > 0 && (
        <div style={{ height: 4, background: "var(--bg3)", borderRadius: 2, marginBottom: 12, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "var(--cyan)", width: `${pct}%`, transition: "width 0.3s" }} />
        </div>
      )}

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
        <Kpi label="Items filtrados" value={String(kpi.count)} color="var(--cyan)" />
        <Kpi label="En pérdida" value={String(kpi.neg)} color={kpi.neg > 0 ? "var(--red)" : "var(--green)"} />
        <Kpi label="Margen promedio" value={`${kpi.avgPct.toFixed(1)}%`} color={kpi.avgPct > 15 ? "var(--green)" : kpi.avgPct > 0 ? "var(--amber)" : "var(--red)"} />
        <Kpi label="Margen total" value={fmtCLP(kpi.totalMargen)} color={kpi.totalMargen > 0 ? "var(--green)" : "var(--red)"} />
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14, alignItems: "center" }}>
        <input
          type="text"
          placeholder='Buscar: "sabana 144" · margen<10 · precio>30000 · sin-promo · en-perdida'
          value={q}
          onChange={e => setQ(e.target.value)}
          className="form-input"
          style={{ flex: "1 1 240px", minWidth: 200 }}
          title={'Busqueda flexible:\n- Palabras sueltas: "sabana 144" matchea "Sabanas Cannon 144 Hilos" (sin acentos, tolera plurales)\n- Operadores numericos: precio<30000, precio>=20000, costo<15000, margen<10, margen>=20, comision>5000, envio>0\n- Flags: sin-costo, con-promo, sin-promo, en-perdida\n- Combinable: "cannon 144 precio>40000 margen<15"'}
        />
        <select value={statusF} onChange={e => setStatusF(e.target.value as StatusFilter)} className="form-input" style={{ flex: "0 0 auto" }} title="Filtrar por estado de la publicación en ML">
          <option value="active">Solo activos en ML</option>
          <option value="paused">Solo pausados</option>
          <option value="other">Otros (closed/review)</option>
          <option value="all">Todos los estados</option>
        </select>
        <select value={promoFilter} onChange={e => setPromoFilter(e.target.value)} className="form-input" style={{ flex: "0 0 auto", maxWidth: 260 }} title="Filtrar por promoción — 'En' = ya postulados · 'Postulable a' = pueden postular pero aún no lo hicieron">
          <option value="all">Todas las promos</option>
          {promosActivas.length > 0 && (
            <optgroup label="En promoción (ya postulados)">
              {promosActivas.map(([nombre, count]) => (
                <option key={`en-${nombre}`} value={`en:${nombre}`}>✓ {nombre} ({count})</option>
              ))}
            </optgroup>
          )}
          {promosCandidate.length > 0 && (
            <optgroup label="Postulable a (sin postular)">
              {promosCandidate.map(([nombre, count]) => (
                <option key={`pos-${nombre}`} value={`pos:${nombre}`}>⚠ {nombre} ({count})</option>
              ))}
            </optgroup>
          )}
        </select>
        <select value={zona} onChange={e => setZona(e.target.value as ZonaFilter)} className="form-input" style={{ flex: "0 0 auto" }}>
          <option value="all">Todas las zonas</option>
          <option value="barato">Barato (&lt;$9.990)</option>
          <option value="medio">Medio ($9.990-$19.989)</option>
          <option value="caro">Caro (≥$19.990)</option>
        </select>
        <select value={marginF} onChange={e => setMarginF(e.target.value as MarginFilter)} className="form-input" style={{ flex: "0 0 auto" }}>
          <option value="all">Todos los márgenes</option>
          <option value="neg">En pérdida (&lt;0%)</option>
          <option value="low">Bajo (0-15%)</option>
          <option value="mid">Medio (15-30%)</option>
          <option value="high">Alto (≥30%)</option>
        </select>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={soloPromo} onChange={e => { setSoloPromo(e.target.checked); if (e.target.checked) setSinPromo(false); }} /> Con promo activa
        </label>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={sinPromo} onChange={e => { setSinPromo(e.target.checked); if (e.target.checked) setSoloPromo(false); }} /> Sin promo activa
        </label>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={soloDead} onChange={e => setSoloDead(e.target.checked)} /> Solo dead zone
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--txt2)" }}>
          <span style={{ color: "var(--txt3)" }}>Costo+IVA</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="min"
            value={costoMin}
            onChange={e => setCostoMin(e.target.value)}
            className="form-input"
            style={{ width: 80, padding: "4px 6px", fontSize: 11 }}
          />
          <span style={{ color: "var(--txt3)" }}>–</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="max"
            value={costoMax}
            onChange={e => setCostoMax(e.target.value)}
            className="form-input"
            style={{ width: 80, padding: "4px 6px", fontSize: 11 }}
          />
        </div>
        <label style={{ fontSize: 11, color: "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={agruparPorCosto} onChange={e => setAgruparPorCosto(e.target.checked)} /> Agrupar por costo
        </label>
        <label style={{ fontSize: 11, color: soloInconsistentes ? "var(--amber)" : "var(--txt2)", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={soloInconsistentes} onChange={e => setSoloInconsistentes(e.target.checked)} /> Precios inconsistentes
        </label>
      </div>

      {/* Tabla */}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>Cargando...</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>
          {rows.length === 0
            ? 'Sin datos en cache. Presiona "🔄 Refrescar" para cargar.'
            : "Sin resultados para los filtros actuales."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <th style={{ padding: "10px 6px", width: 26, textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    title={allVisibleSelected ? "Deseleccionar todos" : "Seleccionar todos los visibles"}
                  />
                </th>
                <th style={{ padding: "10px 4px", fontSize: 10, color: "var(--txt3)", width: 30 }}></th>
                <SortHeader k="sku" label="SKU" align="left" />
                <SortHeader k="titulo" label="Título" align="left" />
                <SortHeader k="peso_facturable" label="Peso" />
                <SortHeader k="precio_venta" label="Precio venta" />
                <SortHeader k="costo_bruto" label="Costo+IVA" />
                <SortHeader k="comision_clp" label="Comisión" />
                <SortHeader k="envio_clp" label="Envío" />
                <SortHeader k="margen_clp" label="Margen" />
                <SortHeader k="margen_pct" label="%" />
                <th style={{ padding: "10px 8px", textAlign: "center", fontSize: 10, color: "var(--txt3)" }}>Zona</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, idx) => {
                const negColor = r.margen_clp < 0 ? "var(--red)" : r.margen_pct < 15 ? "var(--amber)" : "var(--green)";
                const isSelected = selected.has(r.item_id);
                const prev = idx > 0 ? filtered[idx - 1] : null;
                const showGroupHeader = agruparPorCosto && (!prev || prev.costo_bruto !== r.costo_bruto);
                const grp = showGroupHeader ? grupoPorCosto.get(r.costo_bruto) : null;
                const spanPct = grp && grp.precioMin > 0 ? (grp.precioMax / grp.precioMin - 1) * 100 : 0;
                const spanColor = spanPct > 20 ? "var(--amber)" : "var(--txt3)";
                return (
                  <Fragment key={r.item_id}>
                  {showGroupHeader && grp && (() => {
                    const groupItems = filtered.filter(x => x.costo_bruto === r.costo_bruto);
                    const selInGroup = groupItems.filter(x => selected.has(x.item_id)).length;
                    const allSel = selInGroup === groupItems.length;
                    const someSel = selInGroup > 0 && !allSel;
                    return (
                      <tr style={{ background: "var(--bg3)" }}>
                        <td style={{ padding: "6px 6px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={allSel}
                            ref={el => { if (el) el.indeterminate = someSel; }}
                            onChange={() => toggleSelectGroup(r.costo_bruto)}
                            title={allSel ? `Deseleccionar los ${groupItems.length} items` : `Seleccionar los ${groupItems.length} items del grupo`}
                            style={{ cursor: "pointer" }}
                          />
                        </td>
                        <td colSpan={11} style={{ padding: "6px 10px", fontSize: 10, color: "var(--txt2)" }}>
                          <span style={{ color: "var(--cyan)", fontWeight: 700 }}>Costo+IVA {fmtCLP(r.costo_bruto)}</span>
                          <span style={{ marginLeft: 10, color: "var(--txt3)" }}>· {grp.count} {grp.count === 1 ? "item" : "items"}</span>
                          {grp.count > 1 && (
                            <>
                              <span style={{ marginLeft: 10 }}>precio {fmtCLP(grp.precioMin)} – {fmtCLP(grp.precioMax)}</span>
                              <span style={{ marginLeft: 6, color: spanColor, fontWeight: spanPct > 20 ? 700 : 400 }}>
                                (span {spanPct.toFixed(0)}%)
                              </span>
                              <span style={{ marginLeft: 10, color: "var(--txt3)" }}>margen {grp.margenMin.toFixed(1)}% – {grp.margenMax.toFixed(1)}%</span>
                            </>
                          )}
                          {selInGroup > 0 && (
                            <span style={{ marginLeft: 10, color: "var(--cyan)" }}>· {selInGroup}/{groupItems.length} seleccionados</span>
                          )}
                        </td>
                      </tr>
                    );
                  })()}
                  <tr style={{ borderBottom: "1px solid var(--bg4)", background: isSelected ? "var(--cyanBg)" : "transparent" }}>
                    <td style={{ padding: "9px 6px", textAlign: "center" }}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(r.item_id)} />
                    </td>
                    <td style={{ padding: "9px 4px", textAlign: "center" }}>
                      <button
                        onClick={() => {
                          const tk = ticketMap.get(r.sku);
                          setSimItem({
                            item_id: r.item_id,
                            sku: r.sku,
                            titulo: r.titulo,
                            price_ml: r.price_ml,
                            precio_venta: r.precio_venta,
                            costo_bruto: r.costo_bruto,
                            peso_facturable: r.peso_facturable,
                            comision_pct: Number(r.comision_pct),
                            tiene_promo: r.tiene_promo,
                            promo_pct: r.promo_pct,
                            promo_type: r.promo_type,
                            ticket_30d: tk?.ticket_30d,
                            unidades_30d: tk?.unidades_30d,
                            ticket_7d: tk?.ticket_7d,
                            unidades_7d: tk?.unidades_7d,
                          });
                        }}
                        title="Simulador de margen"
                        style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)", cursor: "pointer" }}
                      >📊</button>
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", fontSize: 10, color: "var(--txt2)" }}>
                      <div>{r.sku}</div>
                      <div style={{ fontSize: 9, color: "var(--txt3)" }}>{r.item_id}</div>
                    </td>
                    <td style={{ padding: "9px 8px", maxWidth: 260 }}>
                      <div style={{ fontSize: 11, color: "var(--txt)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.titulo}</div>
                      {r.tiene_promo && (
                        <div style={{ fontSize: 9, color: "var(--amber)" }} title={r.promo_type || undefined}>
                          {r.promo_name || r.promo_type} −{r.promo_pct}% (lista {fmtCLP(r.price_ml)})
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", fontSize: 10, color: "var(--txt3)" }}>
                      {r.peso_facturable ? `${(r.peso_facturable / 1000).toFixed(1)} kg` : "—"}
                      {r.tramo_label && <div style={{ fontSize: 8 }}>{r.tramo_label}</div>}
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700 }}>
                      <div>{fmtCLP(r.precio_venta)}</div>
                      {r.tiene_promo && r.price_ml !== r.precio_venta && (
                        <div style={{ fontSize: 9, color: "var(--txt3)", fontWeight: 400 }}>
                          lista <span style={{ textDecoration: "line-through" }}>{fmtCLP(r.price_ml)}</span>
                          {r.promo_pct && <span style={{ color: "var(--amber)", marginLeft: 3 }}>−{r.promo_pct}%</span>}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.costo_bruto)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.comision_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.envio_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: negColor, fontWeight: 700 }}>{fmtCLP(r.margen_clp)}</td>
                    <td className="mono" style={{ padding: "9px 8px", textAlign: "right", color: negColor, fontSize: 10 }}>{Number(r.margen_pct).toFixed(1)}%</td>
                    <td style={{ padding: "9px 8px", textAlign: "center", fontSize: 9, textTransform: "uppercase", color: "var(--txt3)" }}>{r.zona || "—"}</td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {simItem && (
        <MarginSimulatorModal
          item={simItem}
          onClose={() => setSimItem(null)}
          onApplied={() => { refrescarItemsAfectados([simItem.item_id]); }}
        />
      )}

      {/* Barra flotante de acción masiva */}
      {selected.size > 0 && (
        <div style={{
          position: "fixed",
          left: 0, right: 0, bottom: 0,
          padding: "12px 20px",
          background: "var(--bg2)",
          borderTop: "2px solid var(--cyan)",
          boxShadow: "0 -6px 20px rgba(0,0,0,0.4)",
          zIndex: 999,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--cyan)", minWidth: 110 }}>
            {selected.size} seleccionado{selected.size !== 1 ? "s" : ""}
          </div>
          <div>
            <div style={{ fontSize: 9, color: "var(--txt3)", marginBottom: 2 }}>Precio objetivo</div>
            <input
              type="number"
              value={bulkPrice}
              onChange={e => setBulkPrice(e.target.value.replace(/\D/g, ""))}
              placeholder="ej. 19980"
              className="form-input"
              style={{ width: 130, padding: "6px 10px", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", textAlign: "right" }}
              inputMode="numeric"
              disabled={bulkApplying !== "none"}
            />
          </div>
          <button
            onClick={() => runBulk("lista")}
            disabled={bulkApplying !== "none" || !bulkPrice}
            style={{
              padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)",
              cursor: bulkApplying !== "none" ? "wait" : "pointer",
              opacity: (bulkApplying !== "none" || !bulkPrice) ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >Aplicar como precio lista</button>
          <button
            onClick={() => runBulk("promo")}
            disabled={bulkApplying !== "none" || !bulkPrice}
            style={{
              padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)",
              cursor: bulkApplying !== "none" ? "wait" : "pointer",
              opacity: (bulkApplying !== "none" || !bulkPrice) ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >Aplicar como descuento 30d</button>
          <button
            onClick={() => abrirCampaignModal("join")}
            disabled={bulkApplying !== "none"}
            style={{
              padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--green)",
              cursor: bulkApplying !== "none" ? "wait" : "pointer",
              opacity: bulkApplying !== "none" ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >Postular a campaña ML →</button>
          <button
            onClick={() => abrirCampaignModal("leave")}
            disabled={bulkApplying !== "none"}
            style={{
              padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--red)",
              cursor: bulkApplying !== "none" ? "wait" : "pointer",
              opacity: bulkApplying !== "none" ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >Salir de promo ML</button>
          {bulkApplying !== "none" && bulkProgress.total > 0 && (
            <div style={{ fontSize: 11, color: "var(--txt2)", display: "flex", gap: 8 }}>
              <span>{bulkProgress.done}/{bulkProgress.total}</span>
              <span style={{ color: "var(--green)" }}>✓ {bulkProgress.ok}</span>
              {bulkProgress.err > 0 && <span style={{ color: "var(--red)" }}>✗ {bulkProgress.err}</span>}
            </div>
          )}
          {bulkApplying === "none" && bulkProgress.total > 0 && (
            <div style={{ fontSize: 11, color: "var(--txt2)", display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--green)", fontWeight: 700 }}>✓ {bulkProgress.ok} aplicado{bulkProgress.ok !== 1 ? "s" : ""}</span>
              {bulkProgress.err > 0 && (
                <button
                  onClick={() => setShowErrorsModal(true)}
                  style={{ color: "var(--red)", background: "var(--redBg)", border: "1px solid var(--red)", padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 10, fontWeight: 700 }}
                >✗ {bulkProgress.err} error{bulkProgress.err !== 1 ? "es" : ""} — ver</button>
              )}
              {loading && <span style={{ fontSize: 10, color: "var(--cyan)" }}>refrescando cache...</span>}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={clearSelection}
            disabled={bulkApplying !== "none"}
            style={{ padding: "6px 10px", borderRadius: 4, fontSize: 11, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}
          >Cancelar</button>
        </div>
      )}

      {/* Modal de errores del bulk */}
      {showErrorsModal && bulkErrors.length > 0 && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setShowErrorsModal(false)}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 12, width: "100%", maxWidth: 600, maxHeight: "80vh", overflow: "auto", border: "1px solid var(--red)", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--red)" }}>Errores en bulk ({bulkErrors.length})</div>
              <button onClick={() => setShowErrorsModal(false)} style={{ background: "transparent", border: "none", color: "var(--txt2)", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ padding: "10px 18px 16px" }}>
              {bulkErrors.map((e, i) => (
                <div key={i} style={{ padding: "8px 10px", marginBottom: 6, background: "var(--bg3)", borderRadius: 6, borderLeft: "3px solid var(--red)", fontSize: 11 }}>
                  <div className="mono" style={{ fontWeight: 700, color: "var(--txt)" }}>{e.sku}</div>
                  <div style={{ color: "var(--red)", marginTop: 2 }}>{e.error}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal selección de campaña para bulk */}
      {campaignModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => bulkApplying === "none" && setCampaignModalOpen(false)}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg2)", borderRadius: 14, width: "100%", maxWidth: 760, maxHeight: "90vh", overflow: "auto", border: "1px solid var(--bg4)", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: campaignMode === "leave" ? "var(--red)" : "var(--cyan)" }}>
                  {campaignMode === "leave"
                    ? `Salir masivo de una promo (${selected.size} ítems)`
                    : `Postular ${selected.size} ítem${selected.size !== 1 ? "s" : ""} — marca una o más campañas`}
                </div>
                <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2 }}>
                  {campaignMode === "leave"
                    ? "Promos donde hay ítems actualmente participando. Elige una y los ítems serán retirados."
                    : "Podés postular al mismo precio a varias campañas en un solo click. Los ítems fuera de rango por-campaña se skipean."}
                </div>
              </div>
              <button onClick={() => bulkApplying === "none" && setCampaignModalOpen(false)} style={{ background: "transparent", border: "none", color: "var(--txt2)", fontSize: 20, cursor: "pointer", padding: "0 4px" }}>✕</button>
            </div>

            {campaignLoading ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>
                Analizando promos disponibles en cada ítem...
              </div>
            ) : (() => {
              // Filtro según modo: para leave solo mostramos promos con items actualmente adentro
              const visiblePromos = campaignMode === "leave"
                ? commonPromos.filter(p => p.itemsActivos.length > 0)
                : commonPromos;
              if (visiblePromos.length === 0) {
                return (
                  <div style={{ padding: 40, textAlign: "center", color: "var(--txt3)" }}>
                    {campaignMode === "leave"
                      ? "Ninguno de los ítems seleccionados está actualmente en una promo."
                      : "No hay promos con precio custom comunes a los ítems seleccionados."}
                  </div>
                );
              }
              return (
              <>
                {campaignMode === "join" && (
                <div style={{ padding: "14px 20px 10px" }}>
                  <div style={{ fontSize: 9, color: "var(--txt3)", marginBottom: 4 }}>Precio objetivo</div>
                  <input
                    type="number"
                    value={bulkPrice}
                    onChange={e => setBulkPrice(e.target.value.replace(/\D/g, ""))}
                    placeholder="ej. 19980"
                    className="form-input"
                    style={{ width: "100%", padding: "10px 12px", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", textAlign: "right" }}
                    inputMode="numeric"
                    disabled={bulkApplying !== "none"}
                  />
                </div>
                )}

                <div style={{ padding: "0 20px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {visiblePromos.map(p => {
                    const key = p.id ? `${p.type}::${p.id}` : `${p.type}::_`;
                    const isMultiSelected = campaignMode === "join" ? selectedPromoKeys.has(key) : selectedPromoKey === key;
                    const totalAplicables = p.itemsPostulables.length + p.itemsActivos.length;
                    const target = parseInt(bulkPrice) || 0;
                    let validosCount = 0;
                    const invalidosItems: Array<{ itemId: string; sku: string; rango: RangoItem }> = [];
                    if (target > 0 && totalAplicables > 0) {
                      const aplicablesIds = [...p.itemsPostulables, ...p.itemsActivos];
                      for (const id of aplicablesIds) {
                        const rango = p.rangosPorItem.get(id);
                        if (!rango) { validosCount++; continue; }
                        const ok = (rango.min === 0 || target >= rango.min) && (rango.max === 0 || target <= rango.max);
                        if (ok) validosCount++;
                        else {
                          const row = rows.find(r => r.item_id === id);
                          invalidosItems.push({ itemId: id, sku: row?.sku || id, rango });
                        }
                      }
                    }
                    const fueraRango = invalidosItems.length > 0;
                    const tipoLabel = (() => {
                      const map: Record<string, string> = {
                        SELLER_CAMPAIGN: "Campaña vendedor",
                        MARKETPLACE_CAMPAIGN: "Campaña ML",
                        DEAL: "Oferta ML",
                        PRICE_DISCOUNT: "Descuento propio",
                        SMART: "Smart (precio óptimo)",
                        UNHEALTHY_STOCK: "Stock estancado",
                        LIGHTNING: "Oferta relámpago",
                        LIGHTNING_DEAL: "Oferta relámpago",
                        DOD: "Oferta del día",
                      };
                      return map[p.type] || p.type;
                    })();
                    const tituloPrincipal = p.name && p.name.trim() && p.name.toUpperCase() !== p.type ? p.name : tipoLabel;
                    const subTipo = tituloPrincipal !== tipoLabel ? tipoLabel : null;
                    return (
                      <label
                        key={key}
                        style={{
                          display: "block",
                          padding: 12,
                          borderRadius: 8,
                          background: isMultiSelected ? "var(--cyanBg)" : "var(--bg3)",
                          border: `1px solid ${isMultiSelected ? "var(--cyan)" : "var(--bg4)"}`,
                          cursor: bulkApplying !== "none" ? "wait" : "pointer",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                          {campaignMode === "join" ? (
                            <input
                              type="checkbox"
                              checked={isMultiSelected}
                              onChange={() => togglePromoKey(key)}
                              disabled={bulkApplying !== "none"}
                              style={{ marginTop: 2 }}
                            />
                          ) : (
                            <input
                              type="radio"
                              name="bulk-campaign"
                              checked={selectedPromoKey === key}
                              onChange={() => setSelectedPromoKey(key)}
                              disabled={bulkApplying !== "none"}
                            />
                          )}
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--txt)" }}>{tituloPrincipal}</span>
                              {subTipo && <span style={{ fontSize: 10, color: "var(--txt3)" }}>{subTipo}</span>}
                              {p.finish_date && (
                                <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 9, background: "var(--bg4)", color: "var(--txt3)" }}>
                                  hasta {new Date(p.finish_date).toLocaleDateString("es-CL", { day: "2-digit", month: "short" })}
                                </span>
                              )}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 6, fontSize: 10 }}>
                              <div>
                                <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>Postulables</div>
                                <div className="mono" style={{ color: "var(--amber)", fontWeight: 700 }}>{p.itemsPostulables.length}</div>
                              </div>
                              <div>
                                <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>Ya en promo</div>
                                <div className="mono" style={{ color: "var(--green)", fontWeight: 700 }}>{p.itemsActivos.length}</div>
                              </div>
                              <div>
                                <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>No aplica</div>
                                <div className="mono" style={{ color: "var(--red)", fontWeight: 700 }}>{p.itemsNoDisponible.length}</div>
                              </div>
                              <div>
                                <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>Total a tocar</div>
                                <div className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>{totalAplicables}</div>
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8, fontSize: 10 }}>
                              {p.min_price > 0 && (
                                <div>
                                  <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>Rango ML</div>
                                  <div className="mono" style={{ color: "var(--txt2)" }}>${p.min_price.toLocaleString("es-CL")} – ${p.max_price.toLocaleString("es-CL")}</div>
                                </div>
                              )}
                              {p.suggested_price > 0 && (
                                <div>
                                  <div style={{ color: "var(--txt3)", fontSize: 8, textTransform: "uppercase" }}>Sugerido ML</div>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); setBulkPrice(String(p.suggested_price)); }}
                                    className="mono"
                                    style={{ color: "var(--cyan)", background: "transparent", border: "none", cursor: "pointer", padding: 0, fontWeight: 700 }}
                                  >${p.suggested_price.toLocaleString("es-CL")} ↵</button>
                                </div>
                              )}
                            </div>
                            {target > 0 && totalAplicables > 0 && (
                              <div style={{ marginTop: 6, fontSize: 10, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <span style={{ color: "var(--green)", fontWeight: 600 }}>
                                  ✓ {validosCount} acepta{validosCount !== 1 ? "n" : ""} {fmtCLP(target)}
                                </span>
                                {fueraRango && (
                                  <span style={{ color: "var(--red)", fontWeight: 600 }}>
                                    ✗ {invalidosItems.length} fuera de rango
                                  </span>
                                )}
                              </div>
                            )}
                            {isMultiSelected && fueraRango && target > 0 && (
                              <details style={{ marginTop: 6 }}>
                                <summary style={{ fontSize: 10, color: "var(--red)", cursor: "pointer", fontWeight: 600 }}>
                                  Ver {invalidosItems.length} ítem{invalidosItems.length !== 1 ? "s" : ""} fuera de rango
                                </summary>
                                <div style={{ marginTop: 6, maxHeight: 160, overflowY: "auto", background: "var(--bg4)", borderRadius: 6, padding: 8 }}>
                                  {invalidosItems.slice(0, 50).map(inv => (
                                    <div key={inv.itemId} style={{ fontSize: 10, display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0", color: "var(--txt2)" }}>
                                      <span className="mono" style={{ color: "var(--txt)" }}>{inv.sku}</span>
                                      <span className="mono" style={{ color: "var(--txt3)" }}>
                                        {fmtCLP(inv.rango.min)}–{fmtCLP(inv.rango.max)}
                                      </span>
                                    </div>
                                  ))}
                                  {invalidosItems.length > 50 && (
                                    <div style={{ fontSize: 9, color: "var(--txt3)", marginTop: 4, textAlign: "center" }}>
                                      … y {invalidosItems.length - 50} más
                                    </div>
                                  )}
                                </div>
                              </details>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {campaignMode === "join" && selectedPromoKeys.size > 0 && (() => {
                  const promosSel = Array.from(selectedPromoKeys)
                    .map(k => commonPromos.find(x => (x.id ? `${x.type}::${x.id}` : `${x.type}::_`) === k))
                    .filter((x): x is CommonPromo => !!x);
                  const totalActivos = promosSel.reduce((s, p) => s + p.itemsActivos.length, 0);
                  if (totalActivos === 0) return null;
                  return (
                    <div style={{ padding: "8px 20px", background: "var(--amberBg)", borderTop: "1px solid var(--amberBd)", fontSize: 11, color: "var(--amber)" }}>
                      ⚠ {totalActivos} combinación{totalActivos !== 1 ? "es" : ""} item×promo ya estaban dentro.
                      Para cambiar el precio se hace leave + rejoin automático.
                    </div>
                  );
                })()}
                <div style={{ padding: "12px 20px 16px", borderTop: "1px solid var(--bg4)", display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {bulkApplying === "campaign" && bulkProgress.total > 0 && (
                    <div style={{ fontSize: 11, color: "var(--txt2)", marginRight: "auto" }}>
                      {bulkProgress.done}/{bulkProgress.total} · <span style={{ color: "var(--green)" }}>✓ {bulkProgress.ok}</span>
                      {bulkProgress.err > 0 && <span style={{ color: "var(--red)", marginLeft: 6 }}>✗ {bulkProgress.err}</span>}
                    </div>
                  )}
                  <button
                    onClick={() => setCampaignModalOpen(false)}
                    disabled={bulkApplying === "campaign"}
                    style={{ padding: "8px 14px", borderRadius: 6, fontSize: 12, background: "var(--bg3)", color: "var(--txt3)", border: "1px solid var(--bg4)", cursor: "pointer" }}
                  >Cerrar</button>
                  {campaignMode === "join" ? (
                    <button
                      onClick={runBulkCampaign}
                      disabled={selectedPromoKeys.size === 0 || !bulkPrice || bulkApplying === "campaign"}
                      style={{
                        padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                        background: "var(--greenBg)", color: "var(--green)", border: "1px solid var(--green)",
                        cursor: bulkApplying === "campaign" ? "wait" : "pointer",
                        opacity: (selectedPromoKeys.size === 0 || !bulkPrice || bulkApplying === "campaign") ? 0.5 : 1,
                      }}
                    >
                      {bulkApplying === "campaign"
                        ? "Procesando..."
                        : selectedPromoKeys.size === 0
                          ? "Selecciona una campaña"
                          : selectedPromoKeys.size === 1
                            ? "Postular a 1 campaña"
                            : `Postular a ${selectedPromoKeys.size} campañas`}
                    </button>
                  ) : (
                    <button
                      onClick={runBulkLeave}
                      disabled={!selectedPromoKey || bulkApplying === "campaign"}
                      style={{
                        padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                        background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--red)",
                        cursor: bulkApplying === "campaign" ? "wait" : "pointer",
                        opacity: (!selectedPromoKey || bulkApplying === "campaign") ? 0.5 : 1,
                      }}
                    >
                      {bulkApplying === "campaign" ? "Procesando..." : "Salir de todos"}
                    </button>
                  )}
                </div>
              </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "var(--bg3)", borderRadius: 8, padding: "10px 12px", border: "1px solid var(--bg4)" }}>
      <div style={{ fontSize: 9, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
