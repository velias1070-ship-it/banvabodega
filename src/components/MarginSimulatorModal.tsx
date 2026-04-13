"use client";
import { generarCurvaMargen, tramoPorPeso, fmtCLP, type CurvaRow } from "@/lib/ml-shipping";

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
};

export default function MarginSimulatorModal({ item, onClose }: Props) {
  const pesoGr = item.peso_facturable || 0;
  const tramo = tramoPorPeso(pesoGr);
  const comisionPct = item.comision_pct || 14;
  const precioVenta = item.precio_venta && item.precio_venta > 0 ? item.precio_venta : item.price_ml;
  const tienePromo = !!item.tiene_promo && precioVenta !== item.price_ml;
  const descPromoPct = tienePromo && item.price_ml > 0
    ? (item.promo_pct ?? Math.round(((item.price_ml - precioVenta) / item.price_ml) * 100))
    : 0;

  const curva: CurvaRow[] = generarCurvaMargen({
    precioActual: precioVenta,
    costoBruto: item.costo_bruto,
    pesoGr,
    comisionPct,
    extraPoints: tienePromo ? [item.price_ml] : [],
  });
  const pesoKg = pesoGr ? (pesoGr / 1000).toFixed(2) + " kg" : "—";

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
