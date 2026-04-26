"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { calcularMargen, generarCurvaMargen, tramoPorPeso, fmtCLP, type CurvaRow } from "@/lib/ml-shipping";

type NormalizedPromo = {
  id: string | null;
  type: string;
  sub_type: string | null;
  name: string;
  status: string;
  offer_type: string | null;
  start_date: string | null;
  finish_date: string | null;
  price_actual: number;
  original_price: number;
  suggested_price: number;
  min_price: number;
  max_price: number;
  top_deal_price: number;
  meli_pct: number;
  seller_pct: number;
  deal_id: string | null;
  activa: boolean;
  postulable: boolean;
  permite_custom_price: boolean;
};

const PROMO_LABELS: Record<string, string> = {
  PRICE_DISCOUNT: "Descuento propio",
  DEAL: "Oferta ML",
  MARKETPLACE_CAMPAIGN: "Campaña ML",
  SELLER_CAMPAIGN: "Campaña vendedor",
  SMART: "Smart (precio óptimo)",
  LIGHTNING: "Oferta relámpago",
  DOD: "Oferta del día",
  PRICE_MATCHING: "Price matching",
  PRE_NEGOTIATED: "Pre-negociada",
  SELLER_COUPON_CAMPAIGN: "Cupón seguidores",
  UNHEALTHY_STOCK: "Stock estancado",
  VOLUME: "Descuento por volumen",
};

export type SimulatorItem = {
  item_id: string;
  sku: string;
  titulo: string;
  price_ml: number;              // precio lista
  precio_venta?: number;         // efectivo con promo activa (si aplica)
  costo_bruto: number;
  peso_facturable: number;
  comision_pct: number;
  tiene_promo?: boolean;
  promo_pct?: number | null;
  promo_type?: string | null;
  ticket_30d?: number;           // ticket promedio real (revenue/uds, 30d)
  unidades_30d?: number;
  ticket_7d?: number;
  unidades_7d?: number;
};

type Props = {
  item: SimulatorItem;
  onClose: () => void;
  onApplied?: (info?: { appliedPrice?: number }) => void;  // callback para refrescar el parent tras aplicar precio
  onCacheResynced?: () => void;  // callback tras auto-sync del cache (sin delay, solo reload de la lista)
};

export default function MarginSimulatorModal({ item, onClose, onApplied, onCacheResynced }: Props) {
  const pesoGr = item.peso_facturable || 0;
  const tramo = tramoPorPeso(pesoGr);
  const comisionPct = item.comision_pct || 14;

  // Target price (editable). Por defecto, el precio efectivo actual del cache
  // (luego `precioVenta` del useMemo puede actualizarse con data live).
  const initialPrecio = item.precio_venta && item.precio_venta > 0 ? item.precio_venta : item.price_ml;
  const [targetPrice, setTargetPrice] = useState<string>(String(initialPrecio));
  const target = parseInt(targetPrice) || 0;
  const [applying, setApplying] = useState<"none" | "lista" | "promo">("none");
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "warn"; text: string } | null>(null);
  const [retryHint, setRetryHint] = useState<{
    newLista: number;
    requiredPct: number;
    promoLabel: string;
    onRetry: () => Promise<void>;
  } | null>(null);

  // Promociones disponibles del ítem
  const [promos, setPromos] = useState<NormalizedPromo[]>([]);
  const [promosLoaded, setPromosLoaded] = useState(false);
  const [promosLoading, setPromosLoading] = useState(false);

  // Cache local de rangos por promo. ML no devuelve min/max/suggested cuando
  // una promo esta APLICADA al item (status=started con el item adentro).
  // Si antes la vimos como candidate y guardamos su rango, lo usamos como
  // fallback al renderizar. Key: item_id:promo_type:promo_id
  const rangeCacheKey = useCallback((p: NormalizedPromo) => {
    return `mgn_range:${item.item_id}:${p.type}:${p.id || "_"}`;
  }, [item.item_id]);

  // Enriquece una lista de promos con rangos guardados previamente si
  // ML vino sin ellos. Tambien persiste los que SI vienen para usos futuros.
  const enrichWithCachedRanges = useCallback((input: NormalizedPromo[]): NormalizedPromo[] => {
    if (typeof window === "undefined") return input;
    return input.map(p => {
      const key = rangeCacheKey(p);
      if (p.min_price > 0 || p.max_price > 0 || p.suggested_price > 0) {
        // ML lo da: persistir para futuros renders cuando no venga
        try {
          localStorage.setItem(key, JSON.stringify({
            min: p.min_price, max: p.max_price, suggested: p.suggested_price,
            original: p.original_price, savedAt: Date.now(),
          }));
        } catch { /* storage lleno u off */ }
        return p;
      }
      // ML no lo dio: buscar en cache
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return p;
        const cached = JSON.parse(raw) as { min?: number; max?: number; suggested?: number; original?: number; savedAt?: number };
        // Ignorar si el cache tiene > 30 dias (data muy vieja)
        if (cached.savedAt && Date.now() - cached.savedAt > 30 * 86400_000) return p;
        return {
          ...p,
          min_price: p.min_price || cached.min || 0,
          max_price: p.max_price || cached.max || 0,
          suggested_price: p.suggested_price || cached.suggested || 0,
          original_price: p.original_price || cached.original || 0,
        };
      } catch { return p; }
    });
  }, [rangeCacheKey]);
  const [promoAction, setPromoAction] = useState<string | null>(null); // id de la promo en acción

  // Historial de acciones (postulaciones, salidas, cambios de precio)
  type AuditAction = { id: string; accion: string; entidad_id: string; detalle: Record<string, unknown>; created_at: string };
  const [historial, setHistorial] = useState<AuditAction[]>([]);
  const [historialOpen, setHistorialOpen] = useState(false);
  const [historialLoading, setHistorialLoading] = useState(false);

  // Auto-sync del cache cuando detectamos mismatch con ML live.
  // 'pending'=aun no corrio, 'syncing'=fetch en vuelo, 'done'=ok, 'failed'=error
  const [cacheSyncStatus, setCacheSyncStatus] = useState<"pending" | "syncing" | "done" | "failed">("pending");

  const loadHistorial = useCallback(async () => {
    setHistorialLoading(true);
    try {
      const res = await fetch(`/api/ml/item-history?item_id=${item.item_id}`);
      if (res.ok) {
        const j = await res.json();
        setHistorial(j.actions || []);
      }
    } catch { /* silent */ }
    setHistorialLoading(false);
  }, [item.item_id]);

  // Precio venta efectivo: si ya se cargaron las promos live, usa la promo activa
  // del feed. Si aún no, usa el snapshot del cache (item.precio_venta) como fallback.
  const { precioVenta, tienePromo, descPromoPct, cacheStale, cacheStaleMsg } = useMemo(() => {
    const cacheVenta = item.precio_venta && item.precio_venta > 0 ? item.precio_venta : item.price_ml;
    const cacheTienePromo = !!item.tiene_promo && cacheVenta !== item.price_ml;

    if (!promosLoaded) {
      return {
        precioVenta: cacheVenta,
        tienePromo: cacheTienePromo,
        descPromoPct: cacheTienePromo && item.price_ml > 0
          ? (item.promo_pct ?? Math.round(((item.price_ml - cacheVenta) / item.price_ml) * 100))
          : 0,
        cacheStale: false,
        cacheStaleMsg: "",
      };
    }

    // Usar promos live: si hay alguna "started" con precio, esa es la vigente
    const activa = promos.find(p => p.activa && p.price_actual > 0);
    if (activa) {
      const pct = item.price_ml > 0 ? Math.round(((item.price_ml - activa.price_actual) / item.price_ml) * 100) : 0;
      const stale = cacheVenta !== activa.price_actual;
      return {
        precioVenta: activa.price_actual,
        tienePromo: true,
        descPromoPct: pct,
        cacheStale: stale,
        cacheStaleMsg: stale
          ? `Cache dice $${cacheVenta.toLocaleString("es-CL")}, ML live dice $${activa.price_actual.toLocaleString("es-CL")}. Mostrando el valor real de ML.`
          : "",
      };
    }

    // Live dice que no hay promo activa
    const stale = cacheTienePromo;
    return {
      precioVenta: item.price_ml,
      tienePromo: false,
      descPromoPct: 0,
      cacheStale: stale,
      cacheStaleMsg: stale
        ? `Cache dice que tiene promo a $${cacheVenta.toLocaleString("es-CL")}, ML live dice que NO hay promo activa. Mostrando precio lista.`
        : "",
    };
  }, [promos, promosLoaded, item.precio_venta, item.price_ml, item.tiene_promo, item.promo_pct]);

  const loadPromos = useCallback(async () => {
    setPromosLoading(true);
    try {
      // cache-busting para garantizar data fresca post-acción
      const res = await fetch(`/api/ml/item-promotions?item_id=${item.item_id}&_=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && Array.isArray(data.promotions)) {
        setPromos(enrichWithCachedRanges(data.promotions));
        setPromosLoaded(true);
      }
    } catch { /* silent */ }
    setPromosLoading(false);
  }, [item.item_id, enrichWithCachedRanges]);

  // Re-fetch con retries porque ML tarda 3-10s en propagar cambios en
  // seller-promotions tras POST/DELETE. Si pasamos expectedPrice, reintenta
  // hasta que el precio del feed coincida con el target (o agotar 3 intentos).
  // Sin expectedPrice: un solo fetch tras 3.5s (comportamiento viejo).
  const loadPromosConDelay = useCallback(async (expectedPrice?: number) => {
    const delays = [3500, 3500, 4000]; // ~11s total peor caso
    for (let i = 0; i < delays.length; i++) {
      await new Promise(r => setTimeout(r, delays[i]));
      try {
        const res = await fetch(`/api/ml/item-promotions?item_id=${item.item_id}&_=${Date.now()}`, { cache: "no-store" });
        const data = await res.json();
        if (res.ok && Array.isArray(data.promotions)) {
          setPromos(enrichWithCachedRanges(data.promotions));
          setPromosLoaded(true);
          if (!expectedPrice) return;
          const activa = (data.promotions as NormalizedPromo[]).find(p => p.activa && p.price_actual > 0);
          if (activa && Math.abs(activa.price_actual - expectedPrice) < 1) return; // ML ya propago
        }
      } catch { /* silent, sigue al siguiente intento */ }
    }
  }, [item.item_id, enrichWithCachedRanges]);

  useEffect(() => { loadPromos(); }, [loadPromos]);

  // Auto-sync del cache del row cuando detectamos que esta stale.
  // Dispara UN refresh targeted para este item_id y avisa al padre
  // via onApplied() (sin appliedPrice) para que re-cargue la lista.
  useEffect(() => {
    if (!cacheStale) return;
    if (cacheSyncStatus !== "pending") return;
    setCacheSyncStatus("syncing");
    (async () => {
      try {
        const res = await fetch(
          `/api/ml/margin-cache/refresh?item_ids=${encodeURIComponent(item.item_id)}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`refresh failed ${res.status}`);
        setCacheSyncStatus("done");
        if (onCacheResynced) onCacheResynced();
      } catch (e) {
        console.error("[MarginSimulator] auto cache sync failed:", e);
        setCacheSyncStatus("failed");
      }
    })();
  }, [cacheStale, cacheSyncStatus, item.item_id, onCacheResynced]);

  const targetMargin = useMemo(() => {
    if (target <= 0) return null;
    return calcularMargen({ precio: target, costoBruto: item.costo_bruto, pesoGr, comisionPct });
  }, [target, item.costo_bruto, pesoGr, comisionPct]);

  const curva: CurvaRow[] = useMemo(() => generarCurvaMargen({
    precioActual: target > 0 ? target : precioVenta,
    costoBruto: item.costo_bruto,
    pesoGr,
    comisionPct,
    extraPoints: [precioVenta, item.price_ml].filter(p => p > 0 && p !== target),
  }), [target, precioVenta, item.price_ml, item.costo_bruto, pesoGr, comisionPct]);
  const pesoKg = pesoGr ? (pesoGr / 1000).toFixed(2) + " kg" : "—";

  async function aplicarPrecioLista() {
    if (target <= 0) return;
    setApplying("lista");
    setMsg(null);
    try {
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.item_id, updates: { price: target } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setMsg({ type: "ok", text: `Precio lista actualizado a ${fmtCLP(target)}` });
      if (onApplied) onApplied({ appliedPrice: target });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: traducirErrorML(raw) });
    } finally {
      setApplying("none");
      await loadPromosConDelay(target);
      if (historialOpen) void loadHistorial();
    }
  }

  async function aplicarComoDescuento() {
    if (target <= 0) return;
    if (target >= item.price_ml) {
      setMsg({ type: "err", text: "El precio con descuento debe ser menor que el precio lista" });
      return;
    }
    setApplying("promo");
    setMsg(null);
    setRetryHint(null);
    try {
      const start = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) + "T23:59:59.000Z";
      const res = await fetch("/api/ml/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.item_id,
          action: "create_discount",
          deal_price: target,
          start_date: start,
          finish_date: end,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || "Error") as Error & { detail?: unknown };
        err.detail = (data as { detail?: unknown }).detail;
        throw err;
      }
      setMsg({ type: "ok", text: `Descuento creado/actualizado a ${fmtCLP(target)} por 30 días` });
      if (onApplied) onApplied({ appliedPrice: target });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      const detail = (e as { detail?: unknown })?.detail;
      setMsg({ type: "err", text: traducirErrorML(raw, "PRICE_DISCOUNT") });
      if (raw.toLowerCase().includes("minimum_discount") && target > 0) {
        const pct = parseMinimumDiscountPct(raw, detail);
        const newLista = Math.ceil(target / (1 - pct / 100));
        if (newLista > item.price_ml) {
          setRetryHint({
            newLista,
            requiredPct: pct,
            promoLabel: "Descuento propio (30d)",
            onRetry: aplicarComoDescuento,
          });
        }
      }
    } finally {
      setApplying("none");
      await loadPromosConDelay(target);
      if (historialOpen) void loadHistorial();
    }
  }

  function traducirErrorML(msg: string, promoType?: string): string {
    const m = msg.toLowerCase();
    if (m.includes("no offers found")) {
      return "ML no encuentra esa promo activa para el ítem. Puede estar ya removida, en otro estado, o que el promotion_id cambió. Refresca con 🔄 y vuelve a intentar.";
    }
    if (m.includes("invalid_deal_price_range") || m.includes("price out of range")) {
      return "Precio fuera del rango permitido. Usa el rango que muestra el card.";
    }
    if (m.includes("promotion_already_exists")) {
      return "Ya tienes una promo del mismo tipo activa. Sal de ella primero.";
    }
    if (m.includes("item_on_another_campaign")) {
      return "El ítem ya está en otra campaña que choca con esta.";
    }
    if (m.includes("minimum_discount")) {
      return "El descuento es menor al mínimo exigido por ML (≥5%).";
    }
    if (m.includes("free_shipping_required")) {
      return "Esta promo requiere envío gratis. Actívalo primero.";
    }
    if (m.includes("user_not_allowed") || m.includes("forbidden")) {
      return "No tienes permisos para esta promo (reputación o categoría).";
    }
    return msg;
  }

  // Extrae el % mínimo de descuento que ML exige, de mensaje/detalle.
  // Fallback: 5 (valor documentado para PRICE_DISCOUNT).
  function parseMinimumDiscountPct(rawMsg: string, detail: unknown): number {
    const haystack: string[] = [rawMsg];
    if (detail && typeof detail === "object") {
      const d = detail as Record<string, unknown>;
      if (typeof d.message === "string") haystack.push(d.message);
      if (Array.isArray(d.cause)) {
        for (const c of d.cause as unknown[]) {
          if (c && typeof c === "object") {
            const cc = c as Record<string, unknown>;
            if (typeof cc.message === "string") haystack.push(cc.message);
            if (typeof cc.code === "string") haystack.push(cc.code);
          }
        }
      }
    }
    for (const h of haystack) {
      const m = h.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) {
        const n = parseFloat(m[1].replace(",", "."));
        if (n > 0 && n < 100) return n;
      }
    }
    return 5;
  }

  async function ajustarListaYReintentar() {
    if (!retryHint) return;
    const hint = retryHint;
    setRetryHint(null);
    setApplying("lista");
    setMsg({ type: "warn", text: `Subiendo precio lista a ${fmtCLP(hint.newLista)}…` });
    try {
      const res = await fetch("/api/ml/item-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.item_id, updates: { price: hint.newLista } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setMsg({ type: "warn", text: `Lista actualizada a ${fmtCLP(hint.newLista)}. Esperando propagación ML y reintentando…` });
      if (onApplied) onApplied({ appliedPrice: hint.newLista });
      await new Promise(r => setTimeout(r, 3500));
      setApplying("none");
      await hint.onRetry();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: `No pude subir precio lista: ${traducirErrorML(raw)}` });
      setApplying("none");
    }
  }

  async function postularPromo(promo: NormalizedPromo, accion: "join" | "update") {
    if (!promo.permite_custom_price) {
      setMsg({ type: "err", text: "Esta promo no acepta precio custom, contáctate con ML" });
      return;
    }
    if (target <= 0) {
      setMsg({ type: "err", text: "Ingresa un precio objetivo primero" });
      return;
    }
    if (promo.min_price > 0 && target < promo.min_price) {
      setMsg({ type: "err", text: `Precio bajo mínimo (${fmtCLP(promo.min_price)})` });
      return;
    }
    if (promo.max_price > 0 && target > promo.max_price) {
      setMsg({ type: "err", text: `Precio sobre máximo (${fmtCLP(promo.max_price)})` });
      return;
    }
    setPromoAction(promo.id || promo.type);
    setMsg(null);
    setRetryHint(null);
    try {
      const res = await fetch("/api/ml/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.item_id,
          action: "join",
          promotion_id: promo.id,
          promotion_type: promo.type,
          deal_price: target,
          offer_type: promo.offer_type,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.error || "Error") as Error & { detail?: unknown };
        err.detail = (data as { detail?: unknown }).detail;
        throw err;
      }
      const verb = accion === "join" ? "Postulado" : "Actualizado";
      if (data.warning?.type === "price_overridden") {
        const w = data.warning as { requested: number; applied: number };
        setMsg({
          type: "warn",
          text: `⚠ ML aceptó la acción pero aplicó ${fmtCLP(w.applied)} en vez de ${fmtCLP(w.requested)}. "${promo.name}" usa descuento porcentual fijo — no acepta precio custom por ítem. Para forzar ${fmtCLP(w.requested)}: crea un PRICE_DISCOUNT propio (botón "Aplicar como descuento 30d" arriba) o baja el precio lista a ${fmtCLP(Math.round(w.requested / (w.applied / item.price_ml)))}.`,
        });
      } else {
        setMsg({ type: "ok", text: `${verb} a "${promo.name}" con precio ${fmtCLP(target)}` });
      }
      if (onApplied) onApplied({ appliedPrice: target });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      const detail = (e as { detail?: unknown })?.detail;
      setMsg({ type: "err", text: traducirErrorML(raw, promo.type) });
      if (raw.toLowerCase().includes("minimum_discount") && target > 0) {
        const pct = parseMinimumDiscountPct(raw, detail);
        const newLista = Math.ceil(target / (1 - pct / 100));
        if (newLista > item.price_ml) {
          setRetryHint({
            newLista,
            requiredPct: pct,
            promoLabel: promo.name || (PROMO_LABELS[promo.type] || promo.type),
            onRetry: () => postularPromo(promo, accion),
          });
        }
      }
    } finally {
      setPromoAction(null);
      // Siempre re-fetchear con target: a veces el error es un falso positivo
      // y queremos ver el estado real. Con retries hasta ver target aplicado.
      await loadPromosConDelay(target);
      if (historialOpen) void loadHistorial();
    }
  }

  async function salirPromo(promo: NormalizedPromo) {
    const confirmMsg = promo.type === "SELLER_CAMPAIGN"
      ? `¿Retirar este ítem de tu campaña "${promo.name}"? La campaña seguirá activa para los demás ítems.`
      : `¿Salir de "${promo.name}"?`;
    if (!confirm(confirmMsg)) return;
    setPromoAction(promo.id || promo.type);
    setMsg(null);
    try {
      const res = await fetch("/api/ml/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_id: item.item_id,
          action: "delete",
          promotion_id: promo.id,
          promotion_type: promo.type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error");
      setMsg({ type: "ok", text: `Saliste de "${promo.name}"` });
      if (onApplied) onApplied();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: traducirErrorML(raw, promo.type) });
    } finally {
      setPromoAction(null);
      await loadPromosConDelay();
    }
  }

  function usarPrecioSugerido(precio: number) {
    if (precio > 0) setTargetPrice(String(precio));
  }

  function formatFechas(start: string | null, finish: string | null) {
    if (!start && !finish) return null;
    const now = Date.now();
    const sd = start ? new Date(start) : null;
    const fd = finish ? new Date(finish) : null;
    const fmt = (d: Date) => d.toLocaleDateString("es-CL", { day: "2-digit", month: "short" });
    const diasRestantes = fd ? Math.ceil((fd.getTime() - now) / 86400000) : null;
    const diasParaEmpezar = sd ? Math.ceil((sd.getTime() - now) / 86400000) : null;

    let label = "";
    let warn = false;
    let urgent = false;

    if (sd && sd.getTime() > now) {
      // Empieza en el futuro
      label = `Empieza ${fmt(sd)}`;
      if (diasParaEmpezar !== null && diasParaEmpezar <= 2) urgent = true;
    } else if (fd) {
      // Ya empezó (o no tiene start); mostrar fin
      label = `Hasta ${fmt(fd)}`;
      if (diasRestantes !== null) {
        label += ` · ${diasRestantes}d`;
        if (diasRestantes <= 3) { warn = true; urgent = diasRestantes <= 1; }
      }
    }
    return { label, warn, urgent, diasRestantes, diasParaEmpezar };
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--bg2)",
          borderRadius: 14,
          width: "100%",
          maxWidth: 720,
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
          border: "1px solid var(--bg4)",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--bg4)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--txt3)", marginBottom: 2 }}>Simulador de margen</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--cyan)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.titulo}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--txt3)" }}>{item.sku} · {item.item_id}</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--txt2)", fontSize: 20, cursor: "pointer", padding: "0 4px" }}>✕</button>
        </div>

        <div style={{ padding: "14px 20px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, borderBottom: "1px solid var(--bg4)", fontSize: 10 }}>
          <div>
            <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>Costo bruto</div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{fmtCLP(item.costo_bruto)}</div>
          </div>
          <div>
            <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>Peso facturable</div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{pesoKg}</div>
            <div style={{ fontSize: 9, color: "var(--txt3)" }}>Tramo: {tramo.label}</div>
          </div>
          <div>
            <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>Comisión</div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{comisionPct}%</div>
          </div>
          <div>
            <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>
              {tienePromo ? "Precio venta (promo)" : "Precio actual"}
            </div>
            <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--cyan)" }}>{fmtCLP(precioVenta)}</div>
            {tienePromo && (
              <div style={{ fontSize: 9, color: "var(--amber)", marginTop: 2 }}>
                Lista: <span className="mono" style={{ textDecoration: "line-through" }}>{fmtCLP(item.price_ml)}</span> −{descPromoPct}%
              </div>
            )}
          </div>
        </div>
        {(item.unidades_30d && item.unidades_30d > 0) ? (() => {
          const t30 = item.ticket_30d || 0;
          const u30 = item.unidades_30d || 0;
          const t7 = item.ticket_7d || 0;
          const u7 = item.unidades_7d || 0;
          const diff = precioVenta > 0 ? ((t30 - precioVenta) / precioVenta) * 100 : 0;
          const diffColor = Math.abs(diff) < 3 ? "var(--txt3)" : diff < -5 ? "var(--amber)" : "var(--cyan)";
          return (
            <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--bg4)", display: "flex", gap: 20, fontSize: 10, color: "var(--txt2)", flexWrap: "wrap" }}>
              <div>
                <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>Ticket 30d</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{fmtCLP(t30)}</div>
                <div style={{ fontSize: 9, color: diffColor }}>
                  {u30} uds · {diff >= 0 ? "+" : ""}{diff.toFixed(1)}% vs precio actual
                </div>
              </div>
              {u7 > 0 && (
                <div>
                  <div style={{ color: "var(--txt3)", fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>Ticket 7d</div>
                  <div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{fmtCLP(t7)}</div>
                  <div style={{ fontSize: 9, color: "var(--txt3)" }}>{u7} uds</div>
                </div>
              )}
              <div style={{ flex: 1, alignSelf: "center", fontSize: 9, color: "var(--txt3)", fontStyle: "italic" }}>
                {Math.abs(diff) < 3 ? "El precio actual refleja lo que realmente se vende."
                  : diff < -5 ? "Vende más barato de lo listado — descuentos crónicos o promos."
                  : diff > 3 ? "Vende más caro de lo listado — precio reciente, pocas ventas al nuevo."
                  : ""}
              </div>
            </div>
          );
        })() : null}
        {cacheStale && (
          <div style={{ padding: "8px 20px", fontSize: 10, color: "var(--amber)", background: "var(--amberBg)", borderBottom: "1px solid var(--amberBd)", borderTop: "1px solid var(--amberBd)" }}>
            {cacheSyncStatus === "syncing" && <>🔄 Cache de Márgenes desactualizado: {cacheStaleMsg} Sincronizando en segundo plano...</>}
            {cacheSyncStatus === "done" && <>✓ Cache re-sincronizado con ML live. {cacheStaleMsg}</>}
            {cacheSyncStatus === "failed" && <>⚠ Cache de Márgenes desactualizado: {cacheStaleMsg} Falló el auto-sync, se va a resincronizar cuando apliques una acción.</>}
            {cacheSyncStatus === "pending" && <>⚠ Cache de Márgenes desactualizado: {cacheStaleMsg}</>}
          </div>
        )}

        {/* Panel de ajuste de precio */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bg4)", background: "var(--bg3)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 8, fontWeight: 600 }}>
            Simular y aplicar precio
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: "0 0 150px" }}>
              <div style={{ fontSize: 9, color: "var(--txt3)", marginBottom: 3 }}>Precio objetivo</div>
              <input
                type="number"
                value={targetPrice}
                onChange={e => setTargetPrice(e.target.value.replace(/\D/g, ""))}
                className="form-input"
                style={{ width: "100%", padding: "8px 10px", fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", textAlign: "right" }}
                inputMode="numeric"
              />
            </div>
            {targetMargin && (
              <div style={{ flex: "1 1 auto", display: "flex", gap: 14, fontSize: 11 }}>
                <div>
                  <div style={{ fontSize: 9, color: "var(--txt3)" }}>Comisión</div>
                  <div className="mono" style={{ color: "var(--txt2)", fontWeight: 600 }}>{fmtCLP(targetMargin.comision)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "var(--txt3)" }}>Envío</div>
                  <div className="mono" style={{ color: "var(--txt2)", fontWeight: 600 }}>{fmtCLP(targetMargin.envio)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "var(--txt3)" }}>Margen</div>
                  <div className="mono" style={{ color: targetMargin.margen > 0 ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 13 }}>
                    {fmtCLP(targetMargin.margen)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "var(--txt3)" }}>%</div>
                  <div className="mono" style={{ color: targetMargin.margen > 0 ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 13 }}>
                    {targetMargin.margenPct.toFixed(1)}%
                  </div>
                </div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={aplicarPrecioLista}
              disabled={applying !== "none" || target <= 0 || target === item.price_ml}
              style={{
                padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)",
                cursor: applying === "none" ? "pointer" : "wait",
                opacity: (applying !== "none" || target <= 0 || target === item.price_ml) ? 0.5 : 1,
              }}
              title="Actualiza el precio lista en MercadoLibre vía PUT /items/{id}"
            >
              {applying === "lista" ? "Aplicando..." : "Aplicar como precio lista"}
            </button>
            <button
              onClick={aplicarComoDescuento}
              disabled={applying !== "none" || target <= 0 || target >= item.price_ml}
              style={{
                padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)",
                cursor: applying === "none" ? "pointer" : "wait",
                opacity: (applying !== "none" || target <= 0 || target >= item.price_ml) ? 0.5 : 1,
              }}
              title="Crea o actualiza un descuento (PRICE_DISCOUNT) en ML por 30 días con ese precio"
            >
              {applying === "promo" ? "Aplicando..." : "Aplicar como descuento (30d)"}
            </button>
            {msg && (
              <div style={{
                padding: "8px 12px", borderRadius: 6, fontSize: 11, lineHeight: 1.4,
                background: msg.type === "ok" ? "var(--greenBg)" : msg.type === "warn" ? "var(--amberBg)" : "var(--redBg)",
                color: msg.type === "ok" ? "var(--green)" : msg.type === "warn" ? "var(--amber)" : "var(--red)",
                border: `1px solid ${msg.type === "ok" ? "var(--green)" : msg.type === "warn" ? "var(--amber)" : "var(--red)"}`,
                flex: "1 1 100%",
              }}>
                {msg.text}
              </div>
            )}
            {retryHint && applying === "none" && (
              <div style={{
                padding: "10px 12px", borderRadius: 6, fontSize: 11, lineHeight: 1.4,
                background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)",
                flex: "1 1 100%", display: "flex", flexDirection: "column", gap: 8,
              }}>
                <div>
                  Para postular <strong>{fmtCLP(target)}</strong> en &quot;{retryHint.promoLabel}&quot; con el descuento mínimo exigido por ML (≥{retryHint.requiredPct}%), el precio lista debe ser <strong>≥{fmtCLP(retryHint.newLista)}</strong>. Lista actual: {fmtCLP(item.price_ml)}.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    onClick={ajustarListaYReintentar}
                    style={{
                      padding: "6px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                      background: "var(--cyan)", color: "var(--bg)", border: "1px solid var(--cyan)",
                      cursor: "pointer",
                    }}
                    title="Sube el precio lista y reintenta la acción"
                  >
                    Subir lista a {fmtCLP(retryHint.newLista)} y reintentar
                  </button>
                  <button
                    onClick={() => setRetryHint(null)}
                    style={{
                      padding: "6px 12px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                      background: "transparent", color: "var(--txt2)", border: "1px solid var(--bg4)",
                      cursor: "pointer",
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Promociones disponibles */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bg4)" }}>
          <div style={{ fontSize: 10, color: "var(--txt3)", textTransform: "uppercase", marginBottom: 8, fontWeight: 600, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Promociones disponibles</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {promosLoading && <span style={{ fontSize: 9, color: "var(--cyan)" }}>Cargando...</span>}
              <button
                onClick={loadPromos}
                disabled={promosLoading}
                title="Refrescar lista de promociones"
                style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, background: "var(--bg4)", color: "var(--txt2)", border: "1px solid var(--bg4)", cursor: promosLoading ? "wait" : "pointer" }}
              >🔄</button>
            </div>
          </div>
          <div style={{ fontSize: 10, color: "var(--txt2)", marginBottom: 10, padding: "6px 10px", background: "var(--bg4)", borderRadius: 4, borderLeft: "3px solid var(--cyan)" }}>
            💡 Los botones <strong>Postular</strong> / <strong>Actualizar</strong> usan el <strong>precio objetivo</strong> del input de arriba
            {target > 0 && <> — actualmente <span className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>{fmtCLP(target)}</span></>}
            . Click en el <strong>sugerido ML</strong> de cualquier card para cargarlo en el input.
          </div>
          {!promosLoading && promos.length === 0 && (
            <div style={{ fontSize: 10, color: "var(--txt3)", fontStyle: "italic" }}>ML no ofrece promociones para este ítem.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {promos.map(p => {
              const pending = p.status === "pending";
              const candidate = p.status === "candidate";
              const badge = p.activa ? { bg: "var(--greenBg)", color: "var(--green)", text: "ACTIVA" }
                         : pending ? { bg: "var(--cyanBg)", color: "var(--cyan)", text: "POSTULADO" }
                         : candidate ? { bg: "var(--amberBg)", color: "var(--amber)", text: "DISPONIBLE" }
                         : { bg: "var(--bg4)", color: "var(--txt3)", text: p.status.toUpperCase() };
              const tipoLabel = PROMO_LABELS[p.type] || p.type;
              const tituloPrincipal = p.name && p.name.trim() && p.name.toUpperCase() !== p.type ? p.name : tipoLabel;
              const subTipo = tituloPrincipal !== tipoLabel ? tipoLabel : null;
              const acting = promoAction === (p.id || p.type);
              const targetFueraRango = p.min_price > 0 && p.max_price > 0 && (target < p.min_price || target > p.max_price);

              // Calcular margen al precio objetivo (o al precio actual de la promo si estás adentro)
              const precioSim = p.activa && p.price_actual > 0 ? p.price_actual : target;
              const margenSim = precioSim > 0
                ? calcularMargen({ precio: precioSim, costoBruto: item.costo_bruto, pesoGr, comisionPct })
                : null;
              const fechas = formatFechas(p.start_date, p.finish_date);

              return (
                <div key={(p.id || "") + p.type} style={{
                  border: "1px solid var(--bg4)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: p.activa ? "var(--greenBg)" : "var(--bg3)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--txt)" }}>{tituloPrincipal}</span>
                        <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 8, fontWeight: 700, background: badge.bg, color: badge.color, border: `1px solid ${badge.color}` }}>{badge.text}</span>
                        {fechas && (
                          <span
                            title={`Desde ${p.start_date?.slice(0,10) || "—"} hasta ${p.finish_date?.slice(0,10) || "—"}`}
                            style={{
                              padding: "1px 6px", borderRadius: 3, fontSize: 9, fontWeight: 600,
                              background: fechas.urgent ? "var(--redBg)" : fechas.warn ? "var(--amberBg)" : "var(--bg4)",
                              color: fechas.urgent ? "var(--red)" : fechas.warn ? "var(--amber)" : "var(--txt2)",
                              border: `1px solid ${fechas.urgent ? "var(--red)" : fechas.warn ? "var(--amber)" : "var(--bg4)"}`,
                            }}
                          >
                            {fechas.urgent && "⏰ "}{fechas.label}
                          </span>
                        )}
                        {p.meli_pct > 0 && (
                          <span title="Porcentaje del descuento que paga ML" style={{ fontSize: 9, color: "var(--cyan)", fontWeight: 600 }}>
                            ML {p.meli_pct}% / Tú {p.seller_pct}%
                          </span>
                        )}
                      </div>
                      {subTipo && (
                        <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {subTipo}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                      {(p.activa || pending) && (
                        <>
                          {p.permite_custom_price && (
                            <button
                              onClick={() => postularPromo(p, "update")}
                              disabled={acting || target <= 0 || targetFueraRango}
                              title={`Actualizar precio de la promo a ${target > 0 ? fmtCLP(target) : "..."}`}
                              style={{
                                padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                                background: "var(--cyanBg)", color: "var(--cyan)", border: "1px solid var(--cyanBd)",
                                cursor: acting ? "wait" : "pointer",
                                opacity: (acting || target <= 0 || targetFueraRango) ? 0.5 : 1,
                                whiteSpace: "nowrap",
                              }}
                            >
                              Actualizar
                              {target > 0 && <div className="mono" style={{ fontSize: 9, fontWeight: 600, opacity: 0.8 }}>a {fmtCLP(target)}</div>}
                            </button>
                          )}
                          <button
                            onClick={() => salirPromo(p)}
                            disabled={acting}
                            style={{
                              padding: "5px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                              background: "var(--redBg)", color: "var(--red)", border: "1px solid var(--redBd)",
                              cursor: acting ? "wait" : "pointer",
                              opacity: acting ? 0.5 : 1,
                              whiteSpace: "nowrap",
                            }}
                          >Salir</button>
                        </>
                      )}
                      {candidate && p.permite_custom_price && (
                        <button
                          onClick={() => postularPromo(p, "join")}
                          disabled={acting || target <= 0 || targetFueraRango}
                          title={`Postular a esta promo con precio ${target > 0 ? fmtCLP(target) : "..."}`}
                          style={{
                            padding: "6px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                            background: "var(--amberBg)", color: "var(--amber)", border: "1px solid var(--amberBd)",
                            cursor: acting ? "wait" : "pointer",
                            opacity: (acting || target <= 0 || targetFueraRango) ? 0.5 : 1,
                            whiteSpace: "nowrap",
                          }}
                        >
                          Postular
                          {target > 0 && <div className="mono" style={{ fontSize: 9, fontWeight: 600, opacity: 0.85 }}>a {fmtCLP(target)}</div>}
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, fontSize: 10 }}>
                    {p.min_price > 0 && (
                      <div>
                        <div style={{ fontSize: 8, color: "var(--txt3)", textTransform: "uppercase" }}>Rango</div>
                        <div className="mono" style={{ fontWeight: 600, color: "var(--txt2)" }}>
                          {fmtCLP(p.min_price)} – {fmtCLP(p.max_price)}
                        </div>
                      </div>
                    )}
                    {p.suggested_price > 0 && (
                      <div>
                        <div style={{ fontSize: 8, color: "var(--txt3)", textTransform: "uppercase" }}>Sugerido ML</div>
                        <button
                          onClick={() => usarPrecioSugerido(p.suggested_price)}
                          title="Usar este precio en el input"
                          className="mono"
                          style={{ fontWeight: 700, color: "var(--cyan)", background: "transparent", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
                        >
                          {fmtCLP(p.suggested_price)} ↵
                        </button>
                      </div>
                    )}
                    {p.activa && p.price_actual > 0 && (
                      <div>
                        <div style={{ fontSize: 8, color: "var(--txt3)", textTransform: "uppercase" }}>Precio actual</div>
                        <div className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{fmtCLP(p.price_actual)}</div>
                      </div>
                    )}
                    {margenSim && (
                      <div>
                        <div style={{ fontSize: 8, color: "var(--txt3)", textTransform: "uppercase" }}>
                          Margen @ {fmtCLP(precioSim)}
                        </div>
                        <div className="mono" style={{ fontWeight: 700, color: margenSim.margen > 0 ? "var(--green)" : "var(--red)" }}>
                          {fmtCLP(margenSim.margen)} ({margenSim.margenPct.toFixed(1)}%)
                        </div>
                      </div>
                    )}
                  </div>
                  {targetFueraRango && (p.postulable || p.activa) && (
                    <div style={{ marginTop: 6, fontSize: 9, color: "var(--red)", fontWeight: 600 }}>
                      ⚠ Precio objetivo fuera del rango permitido
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Historial de acciones sobre el item (postulaciones, salidas, cambios precio) */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bg4)" }}>
          <button
            onClick={() => { setHistorialOpen(!historialOpen); if (!historialOpen && historial.length === 0) loadHistorial(); }}
            style={{ background: "transparent", border: "none", color: "var(--txt2)", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 8, textTransform: "uppercase" }}
          >
            <span style={{ fontSize: 9 }}>{historialOpen ? "▼" : "▶"}</span>
            📜 Historial de cambios{historial.length > 0 ? ` (${historial.length})` : ""}
          </button>
          {historialOpen && (
            <div style={{ marginTop: 10 }}>
              {historialLoading && <div style={{ fontSize: 10, color: "var(--txt3)" }}>Cargando...</div>}
              {!historialLoading && historial.length === 0 && (
                <div style={{ fontSize: 10, color: "var(--txt3)", fontStyle: "italic" }}>Sin acciones registradas para este item.</div>
              )}
              {!historialLoading && historial.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
                  {historial.map(h => {
                    const fecha = new Date(h.created_at).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
                    const d = h.detalle || {};
                    const iconMap: Record<string, string> = {
                      "ml_promo:join": "✅",
                      "ml_promo:delete": "🚫",
                      "ml_promo:create_discount": "🏷️",
                      "ml_promo:join_error": "⚠️",
                      "ml_promo:delete_error": "⚠️",
                      "ml_promo:create_discount_error": "⚠️",
                      "ml_item_update": "✏️",
                    };
                    const colorMap: Record<string, string> = {
                      "ml_promo:join": "var(--green)",
                      "ml_promo:delete": "var(--amber)",
                      "ml_promo:create_discount": "var(--cyan)",
                      "ml_promo:join_error": "var(--red)",
                      "ml_promo:delete_error": "var(--red)",
                      "ml_promo:create_discount_error": "var(--red)",
                      "ml_item_update": "var(--blue)",
                    };
                    const labelMap: Record<string, string> = {
                      "ml_promo:join": "Postulación",
                      "ml_promo:delete": "Salida de promo",
                      "ml_promo:create_discount": "Descuento propio",
                      "ml_promo:join_error": "Error postular",
                      "ml_promo:delete_error": "Error salir",
                      "ml_promo:create_discount_error": "Error descuento",
                      "ml_item_update": "Cambio precio lista",
                    };
                    const icon = iconMap[h.accion] || "•";
                    const color = colorMap[h.accion] || "var(--txt2)";
                    const label = labelMap[h.accion] || h.accion;
                    const promoType = d.promotion_type as string | undefined;
                    const dealPrice = (d.deal_price ?? d.deal_price_applied) as number | undefined;
                    const prevPrice = d.prev_price as number | undefined;
                    const updates = d.updates as { price?: number } | undefined;
                    const err = d.error as string | undefined;
                    return (
                      <div key={h.id} style={{ padding: "6px 10px", background: "var(--bg3)", borderRadius: 6, borderLeft: `3px solid ${color}`, fontSize: 11 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontWeight: 700, color }}>{icon} {label}</span>
                          <span style={{ fontSize: 9, color: "var(--txt3)" }}>{fecha}</span>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--txt2)", marginTop: 3, lineHeight: 1.5 }}>
                          {promoType && <span style={{ marginRight: 8 }}>Tipo: <span className="mono" style={{ color: "var(--txt)" }}>{promoType}</span></span>}
                          {dealPrice && <span style={{ marginRight: 8 }}>Precio: <span className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>{fmtCLP(dealPrice)}</span></span>}
                          {updates?.price && <span style={{ marginRight: 8 }}>Lista: <span className="mono" style={{ color: "var(--blue)", fontWeight: 700 }}>{fmtCLP(updates.price)}</span>{prevPrice && <span style={{ color: "var(--txt3)" }}> (antes {fmtCLP(prevPrice)})</span>}</span>}
                          {(d.overridden as boolean) && <span style={{ color: "var(--amber)", marginRight: 8 }}>⚠ ML overrideó precio</span>}
                          {err && <div style={{ color: "var(--red)", marginTop: 2 }}>{err}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "10px 20px 4px", fontSize: 9, color: "var(--txt3)", display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--greenBg)", border: "1px solid var(--green)", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />Sweet spot &lt;$19.990</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--redBg)", border: "1px solid var(--red)", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />Dead zone</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--amberBg)", border: "1px solid var(--amber)", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />Break-even</span>
          <span><span style={{ display: "inline-block", width: 10, height: 10, background: "var(--cyanBg)", border: "1px solid var(--cyan)", borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />Precio actual</span>
        </div>

        <div style={{ padding: "8px 20px 20px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--bg4)" }}>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--txt3)" }}>Precio</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--txt3)" }}>Comisión</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--txt3)" }}>Envío</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--txt3)" }}>Costo+IVA</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--green)" }}>Margen</th>
                <th style={{ padding: "8px 6px", textAlign: "right", fontSize: 9, color: "var(--green)" }}>%</th>
                <th style={{ padding: "8px 6px", textAlign: "center", fontSize: 9, color: "var(--txt3)" }}>Zona</th>
              </tr>
            </thead>
            <tbody>
              {curva.map((r, i) => {
                let rowBg = "transparent";
                let rowBorder = "transparent";
                if (r.esSweetSpotMedio) { rowBg = "var(--greenBg)"; rowBorder = "var(--green)"; }
                else if (r.esDeadZone) { rowBg = "var(--redBg)"; rowBorder = "var(--red)"; }
                else if (r.esBreakEven) { rowBg = "var(--amberBg)"; rowBorder = "var(--amber)"; }
                if (r.esActual) { rowBorder = "var(--cyan)"; }
                const marginColor = r.margen > 0 ? "var(--green)" : "var(--red)";
                return (
                  <tr key={i} style={{ borderBottom: "1px solid var(--bg4)", background: rowBg, outline: r.esActual ? "2px solid var(--cyan)" : `1px solid ${rowBorder === "transparent" ? "transparent" : rowBorder}` }}>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", fontWeight: r.esActual || r.esSweetSpotMedio ? 700 : 500 }}>
                      {fmtCLP(r.precio)}
                      {r.esActual && <span style={{ fontSize: 8, color: "var(--cyan)", marginLeft: 4 }}>●</span>}
                    </td>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.comision)}</td>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", color: "var(--txt2)", fontSize: 10 }}>{fmtCLP(r.envio)}</td>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", color: "var(--txt3)", fontSize: 10 }}>{fmtCLP(item.costo_bruto)}</td>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", color: marginColor, fontWeight: 700 }}>{fmtCLP(r.margen)}</td>
                    <td className="mono" style={{ padding: "7px 6px", textAlign: "right", color: marginColor, fontSize: 10 }}>{r.margenPct.toFixed(1)}%</td>
                    <td style={{ padding: "7px 6px", textAlign: "center", fontSize: 9, color: "var(--txt3)", textTransform: "uppercase" }}>{r.columna}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
