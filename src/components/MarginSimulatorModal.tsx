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
  LIGHTNING_DEAL: "Oferta relámpago",
  DOD: "Oferta del día",
  MELI_CHOICE: "Meli Choice",
  PRICE_MATCHING_MELI_ALL: "Price matching",
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
};

type Props = {
  item: SimulatorItem;
  onClose: () => void;
  onApplied?: () => void;  // callback para refrescar el parent tras aplicar precio
};

export default function MarginSimulatorModal({ item, onClose, onApplied }: Props) {
  const pesoGr = item.peso_facturable || 0;
  const tramo = tramoPorPeso(pesoGr);
  const comisionPct = item.comision_pct || 14;
  const precioVenta = item.precio_venta && item.precio_venta > 0 ? item.precio_venta : item.price_ml;
  const tienePromo = !!item.tiene_promo && precioVenta !== item.price_ml;
  const descPromoPct = tienePromo && item.price_ml > 0
    ? (item.promo_pct ?? Math.round(((item.price_ml - precioVenta) / item.price_ml) * 100))
    : 0;

  // Target price (editable). Por defecto, el precio efectivo actual.
  const [targetPrice, setTargetPrice] = useState<string>(String(precioVenta));
  const target = parseInt(targetPrice) || 0;
  const [applying, setApplying] = useState<"none" | "lista" | "promo">("none");
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Promociones disponibles del ítem
  const [promos, setPromos] = useState<NormalizedPromo[]>([]);
  const [promosLoading, setPromosLoading] = useState(false);
  const [promoAction, setPromoAction] = useState<string | null>(null); // id de la promo en acción

  const loadPromos = useCallback(async () => {
    setPromosLoading(true);
    try {
      // cache-busting para garantizar data fresca post-acción
      const res = await fetch(`/api/ml/item-promotions?item_id=${item.item_id}&_=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && Array.isArray(data.promotions)) {
        setPromos(data.promotions);
      }
    } catch { /* silent */ }
    setPromosLoading(false);
  }, [item.item_id]);

  // Re-fetch con pequeño delay para dar tiempo a ML de propagar el cambio
  const loadPromosConDelay = useCallback(async () => {
    await new Promise(r => setTimeout(r, 700));
    await loadPromos();
  }, [loadPromos]);

  useEffect(() => { loadPromos(); }, [loadPromos]);

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
      if (onApplied) onApplied();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: traducirErrorML(raw) });
    } finally {
      setApplying("none");
      await loadPromosConDelay();
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
      if (!res.ok) throw new Error(data.error || "Error");
      setMsg({ type: "ok", text: `Descuento creado/actualizado a ${fmtCLP(target)} por 30 días` });
      if (onApplied) onApplied();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: traducirErrorML(raw, "PRICE_DISCOUNT") });
    } finally {
      setApplying("none");
      await loadPromosConDelay();
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
      if (!res.ok) throw new Error(data.error || "Error");
      const verb = accion === "join" ? "Postulado" : "Actualizado";
      setMsg({ type: "ok", text: `${verb} a "${promo.name}" con precio ${fmtCLP(target)}` });
      if (onApplied) onApplied();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "Error";
      setMsg({ type: "err", text: traducirErrorML(raw, promo.type) });
    } finally {
      setPromoAction(null);
      // Siempre re-fetchear: a veces el error es un falso positivo y queremos ver el estado real
      await loadPromosConDelay();
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
                padding: "6px 12px", borderRadius: 6, fontSize: 11,
                background: msg.type === "ok" ? "var(--greenBg)" : "var(--redBg)",
                color: msg.type === "ok" ? "var(--green)" : "var(--red)",
                border: `1px solid ${msg.type === "ok" ? "var(--green)" : "var(--red)"}`,
                flex: "1 1 100%",
              }}>
                {msg.text}
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
              const label = PROMO_LABELS[p.type] || p.type;
              const acting = promoAction === (p.id || p.type);
              const targetFueraRango = p.min_price > 0 && p.max_price > 0 && (target < p.min_price || target > p.max_price);

              // Calcular margen al precio objetivo (o al precio actual de la promo si estás adentro)
              const precioSim = p.activa && p.price_actual > 0 ? p.price_actual : target;
              const margenSim = precioSim > 0
                ? calcularMargen({ precio: precioSim, costoBruto: item.costo_bruto, pesoGr, comisionPct })
                : null;

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
                        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--txt)" }}>{label}</span>
                        <span style={{ padding: "1px 6px", borderRadius: 3, fontSize: 8, fontWeight: 700, background: badge.bg, color: badge.color, border: `1px solid ${badge.color}` }}>{badge.text}</span>
                        {p.meli_pct > 0 && (
                          <span title="Porcentaje del descuento que paga ML" style={{ fontSize: 9, color: "var(--cyan)", fontWeight: 600 }}>
                            ML {p.meli_pct}% / Tú {p.seller_pct}%
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--txt3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </div>
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
