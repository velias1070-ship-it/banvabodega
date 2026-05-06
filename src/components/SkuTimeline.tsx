"use client";
/**
 * Trayecto cronológico de un SKU: recepciones, ventas, ajustes con stock
 * y WAC running step-by-step.
 *
 * Muestra cómo se mueve el costo promedio (WAC) y el stock a lo largo
 * del tiempo. Útil para auditoría: ver exactamente cuándo entró stock
 * a qué precio, cuándo salió, y cómo se recalculó el WAC.
 *
 * El WAC se calcula client-side aplicando la regla NIC 2:
 *   - Entrada: new_wac = (stock_prev * wac_prev + qty * costo_unit) / (stock_prev + qty)
 *   - Salida: stock decrece, WAC no cambia
 *   - Ajustes: tratan como entrada o salida según signo
 */
import { useEffect, useState, useMemo } from "react";
import { getSupabase } from "@/lib/supabase";

const fmtMoney = (n: number) =>
  n === 0 ? "—" : (n >= 0 ? "" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("es-CL");
const fmtDate = (d: string | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" })
    + " " + dt.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
};

type RawMov = {
  id: string;
  sku: string;
  tipo: string;
  cantidad: number;
  costo_unitario: number | null;
  recepcion_id: string | null;
  posicion_id: string | null;
  motivo: string | null;
  notas: string | null;
  operario: string | null;
  created_at: string;
};

type RawRec = { id: string; folio: string; proveedor: string };

type Row = {
  fecha: string;
  tipo: "entrada" | "salida" | "ajuste" | "transferencia";
  motivo: string;
  folio: string;
  proveedor: string;
  qty: number; // signed: + entrada, - salida
  costo_unit: number | null; // null si no aplica
  stock_post: number;
  wac_post: number;
  wac_pre: number;
  destacar?: boolean; // entradas que cambian el WAC
};

export default function SkuTimeline() {
  const [skuQuery, setSkuQuery] = useState("");
  const [skuActivo, setSkuActivo] = useState<string | null>(null);
  const [movs, setMovs] = useState<RawMov[]>([]);
  const [recs, setRecs] = useState<Map<string, RawRec>>(new Map());
  const [productoInfo, setProductoInfo] = useState<{ nombre: string; costoPromedioActual: number; stockActual: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buscar = async () => {
    const sku = skuQuery.toUpperCase().trim();
    if (!sku) return;
    setLoading(true); setError(null); setSkuActivo(null);
    const sb = getSupabase();
    if (!sb) { setError("Sin conexión"); setLoading(false); return; }

    try {
      const [{ data: movsData, error: movErr }, { data: prodData }] = await Promise.all([
        sb.from("movimientos")
          .select("id, sku, tipo, cantidad, costo_unitario, recepcion_id, posicion_id, motivo, notas, operario, created_at")
          .eq("sku", sku)
          .order("created_at", { ascending: true })
          .limit(1000),
        sb.from("productos").select("nombre, costo_promedio").eq("sku", sku).maybeSingle(),
      ]);
      if (movErr) throw new Error(movErr.message);

      const movsArr = (movsData || []) as RawMov[];
      if (movsArr.length === 0) {
        setMovs([]); setRecs(new Map()); setProductoInfo(null);
        setError(`Sin movimientos para SKU ${sku}`);
        setSkuActivo(sku); setLoading(false); return;
      }

      // Fetch recepciones para los IDs únicos
      const recIds = Array.from(new Set(movsArr.map(m => m.recepcion_id).filter(Boolean))) as string[];
      const recMap = new Map<string, RawRec>();
      if (recIds.length > 0) {
        const { data: recsData } = await sb.from("recepciones")
          .select("id, folio, proveedor")
          .in("id", recIds);
        for (const r of (recsData || []) as RawRec[]) recMap.set(r.id, r);
      }

      // Stock actual
      const { data: stockData } = await sb.from("stock").select("cantidad").eq("sku", sku);
      const stockActual = ((stockData || []) as { cantidad: number }[]).reduce((s, r) => s + (r.cantidad || 0), 0);

      const prod = prodData as { nombre: string; costo_promedio: number } | null;
      setProductoInfo({
        nombre: prod?.nombre || sku,
        costoPromedioActual: prod?.costo_promedio || 0,
        stockActual,
      });
      setMovs(movsArr); setRecs(recMap); setSkuActivo(sku);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Compute WAC + stock running
  const rows: Row[] = useMemo(() => {
    let stock = 0; let wac = 0;
    return movs.map((m) => {
      const isEntrada = m.tipo === "entrada";
      const isSalida = m.tipo === "salida" || m.tipo === "venta";
      const isAjuste = m.tipo === "ajuste";
      const isTransf = m.tipo === "transferencia";
      const qtyAbs = Math.abs(m.cantidad || 0);
      const wac_pre = wac;
      let qty_signed: number;
      let kind: Row["tipo"];
      if (isEntrada) {
        qty_signed = qtyAbs;
        kind = "entrada";
        const costo = m.costo_unitario || 0;
        if (qtyAbs > 0 && costo > 0) {
          wac = (stock * wac + qtyAbs * costo) / (stock + qtyAbs);
        }
        stock += qtyAbs;
      } else if (isSalida) {
        qty_signed = -qtyAbs;
        kind = "salida";
        stock -= qtyAbs;
      } else if (isAjuste) {
        // signo de m.cantidad: positivo→entrada, negativo→salida
        qty_signed = m.cantidad;
        kind = "ajuste";
        if (qty_signed > 0) {
          const costo = m.costo_unitario || wac;
          if (qtyAbs > 0 && costo > 0 && stock + qtyAbs > 0) {
            wac = (stock * wac + qtyAbs * costo) / (stock + qtyAbs);
          }
        }
        stock += qty_signed;
      } else if (isTransf) {
        qty_signed = 0; // transferencia no cambia stock total ni WAC
        kind = "transferencia";
      } else {
        qty_signed = m.cantidad;
        kind = "ajuste";
      }
      const rec = m.recepcion_id ? recs.get(m.recepcion_id) : null;
      const motivoTexto = m.motivo || m.notas || "";
      return {
        fecha: m.created_at,
        tipo: kind,
        motivo: motivoTexto.slice(0, 60),
        folio: rec?.folio || "",
        proveedor: rec?.proveedor || "",
        qty: qty_signed,
        costo_unit: m.costo_unitario,
        stock_post: stock,
        wac_post: wac,
        wac_pre,
        destacar: isEntrada && wac !== wac_pre,
      };
    });
  }, [movs, recs]);

  const tipoColor: Record<string, string> = {
    entrada: "var(--green)",
    salida: "var(--red)",
    ajuste: "var(--amber)",
    transferencia: "var(--cyan)",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>📈 Trayecto SKU</h2>
        <span style={{ fontSize: 11, color: "var(--txt3)" }}>
          Recepciones, ventas y ajustes cronológicos con WAC + stock running
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={skuQuery}
          onChange={e => setSkuQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && buscar()}
          placeholder="SKU exacto (ej. JSCNAE187P20W)"
          className="form-input"
          style={{ flex: 1, maxWidth: 360, fontSize: 13, fontFamily: "JetBrains Mono, monospace" }}
        />
        <button
          onClick={buscar}
          disabled={loading || !skuQuery.trim()}
          style={{
            padding: "8px 18px", borderRadius: 6, background: "var(--cyan)",
            color: "#0a0e17", fontSize: 12, fontWeight: 700, border: "none",
            cursor: loading ? "wait" : "pointer", opacity: loading ? 0.5 : 1,
          }}
        >
          {loading ? "Cargando..." : "Buscar"}
        </button>
      </div>

      {error && (
        <div className="card" style={{ padding: 12, marginBottom: 12, background: "var(--redBg)", border: "1px solid var(--red)" }}>
          <span style={{ fontSize: 12, color: "var(--red)" }}>{error}</span>
        </div>
      )}

      {skuActivo && productoInfo && rows.length > 0 && (
        <>
          {/* Header SKU */}
          <div className="card" style={{ padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{skuActivo}</span>
              <span style={{ fontSize: 13, color: "var(--txt2)" }}>{productoInfo.nombre}</span>
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 12 }}>
              <div>
                <span style={{ color: "var(--txt3)" }}>Stock actual: </span>
                <span className="mono" style={{ fontWeight: 700, color: "var(--cyan)" }}>{productoInfo.stockActual}</span>
              </div>
              <div>
                <span style={{ color: "var(--txt3)" }}>WAC actual (productos): </span>
                <span className="mono" style={{ fontWeight: 700, color: "var(--cyan)" }}>{fmtMoney(productoInfo.costoPromedioActual)}</span>
              </div>
              <div>
                <span style={{ color: "var(--txt3)" }}>WAC running (calc): </span>
                <span className="mono" style={{ fontWeight: 700, color: rows[rows.length - 1].wac_post.toFixed(0) === Math.round(productoInfo.costoPromedioActual).toString() ? "var(--green)" : "var(--amber)" }}>
                  {fmtMoney(rows[rows.length - 1].wac_post)}
                </span>
                {rows[rows.length - 1].wac_post.toFixed(0) !== Math.round(productoInfo.costoPromedioActual).toString() && (
                  <span style={{ marginLeft: 4, fontSize: 10, color: "var(--amber)" }}>
                    ⚠ no coincide con productos.costo_promedio
                  </span>
                )}
              </div>
              <div>
                <span style={{ color: "var(--txt3)" }}>Movimientos: </span>
                <span className="mono" style={{ fontWeight: 700 }}>{rows.length}</span>
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="card" style={{ padding: 0, overflow: "auto" }}>
            <table className="tbl" style={{ width: "100%", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Fecha</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Tipo</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Folio/Motivo</th>
                  <th style={{ textAlign: "left", padding: "8px 10px" }}>Proveedor</th>
                  <th style={{ textAlign: "right", padding: "8px 10px" }}>Qty</th>
                  <th style={{ textAlign: "right", padding: "8px 10px" }}>Costo unit.</th>
                  <th style={{ textAlign: "right", padding: "8px 10px" }}>Stock post</th>
                  <th style={{ textAlign: "right", padding: "8px 10px" }}>WAC post</th>
                  <th style={{ textAlign: "right", padding: "8px 10px" }}>Δ WAC</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const dWac = r.wac_post - r.wac_pre;
                  return (
                    <tr key={i} style={{
                      borderTop: "1px solid var(--bg4)",
                      background: r.destacar ? "rgba(16,185,129,0.05)" : "transparent",
                    }}>
                      <td className="mono" style={{ padding: "6px 10px", fontSize: 10 }}>{fmtDate(r.fecha)}</td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700,
                          color: tipoColor[r.tipo],
                          padding: "1px 6px", borderRadius: 3, border: `1px solid ${tipoColor[r.tipo]}`,
                          textTransform: "uppercase",
                        }}>
                          {r.tipo}
                        </span>
                      </td>
                      <td className="mono" style={{ padding: "6px 10px", fontSize: 10 }}>
                        {r.folio ? <strong>{r.folio}</strong> : <span style={{ color: "var(--txt3)" }}>{r.motivo}</span>}
                      </td>
                      <td style={{ padding: "6px 10px", fontSize: 10, color: "var(--txt3)" }}>{r.proveedor || "—"}</td>
                      <td className="mono" style={{
                        padding: "6px 10px", textAlign: "right",
                        color: r.qty > 0 ? "var(--green)" : r.qty < 0 ? "var(--red)" : "var(--txt3)",
                        fontWeight: 700,
                      }}>
                        {r.qty > 0 ? "+" : ""}{r.qty}
                      </td>
                      <td className="mono" style={{ padding: "6px 10px", textAlign: "right" }}>
                        {r.costo_unit && r.costo_unit > 0 ? fmtMoney(r.costo_unit) : "—"}
                      </td>
                      <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, color: "var(--cyan)" }}>
                        {r.stock_post}
                      </td>
                      <td className="mono" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700 }}>
                        {fmtMoney(r.wac_post)}
                      </td>
                      <td className="mono" style={{
                        padding: "6px 10px", textAlign: "right", fontSize: 10,
                        color: dWac > 0 ? "var(--red)" : dWac < 0 ? "var(--green)" : "var(--txt3)",
                      }}>
                        {Math.abs(dWac) >= 1 ? (dWac > 0 ? "+" : "") + fmtMoney(dWac) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!skuActivo && !loading && !error && (
        <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--txt3)", fontSize: 12 }}>
          Ingresá un SKU para ver el trayecto cronológico.
        </div>
      )}
    </div>
  );
}
