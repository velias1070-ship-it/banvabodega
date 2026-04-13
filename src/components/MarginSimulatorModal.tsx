"use client";
import { useMemo, useState } from "react";
import { calcularMargen, generarCurvaMargen, tramoPorPeso, fmtCLP, type CurvaRow } from "@/lib/ml-shipping";

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
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Error" });
    } finally {
      setApplying("none");
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
      setMsg({ type: "err", text: e instanceof Error ? e.message : "Error" });
    } finally {
      setApplying("none");
    }
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
