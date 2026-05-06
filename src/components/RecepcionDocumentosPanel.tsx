"use client";
/**
 * Panel de "Documentos asociados" dentro del detalle de recepción.
 *
 * Muestra el estado documentario completo de la factura con el proveedor:
 *  - NCs ya emitidas y reconciliadas (rcv_compras tipo_doc=61 con folio match)
 *  - NC pendiente de emisión (suma de claim_monto_pendiente de disc APROBADAS)
 *  - Factura adicional pendiente (uds sobrantes × precio acordado)
 *
 * Usa supabase client-side para fetchear rcv_compras filtrado por folio.
 */
import { useEffect, useState } from "react";
import type { DBRecepcion, DBRecepcionLinea, DBDiscrepanciaCosto, DBDiscrepanciaQty, DBRcvCompra } from "@/lib/db";
import { getSupabase } from "@/lib/supabase";

interface Props {
  recepcion: DBRecepcion;
  lineas: DBRecepcionLinea[];
  discrepancias: DBDiscrepanciaCosto[];
  discrepanciasQty: DBDiscrepanciaQty[];
}

const fmtMoney = (n: number) =>
  (n >= 0 ? "" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString("es-CL");
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";

export default function RecepcionDocumentosPanel({ recepcion, lineas, discrepancias, discrepanciasQty }: Props) {
  const [docsAsociados, setDocsAsociados] = useState<DBRcvCompra[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!recepcion.folio) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const sb = getSupabase();
      if (!sb) { setLoading(false); return; }
      // Fetch DTEs (NCs y facturas adicionales) cuyo factura_ref_folio coincide
      // con el folio de esta recepción
      const { data, error } = await sb.from("rcv_compras")
        .select("*")
        .eq("factura_ref_folio", recepcion.folio)
        .order("fecha_docto", { ascending: false });
      if (error) console.error("[RecepcionDocumentosPanel] fetch:", error.message);
      if (!cancelled) {
        setDocsAsociados((data || []) as DBRcvCompra[]);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recepcion.folio]);

  // ===== Cálculos =====

  const ncsRecibidas = docsAsociados.filter(d => d.tipo_doc === 61);
  const facturasAdicionales = docsAsociados.filter(d => d.tipo_doc === 33);
  const ncMontoTotal = ncsRecibidas.reduce((s, d) => s + (Number(d.monto_total) || 0), 0);
  const factAdicMontoTotal = facturasAdicionales.reduce((s, d) => s + (Number(d.monto_total) || 0), 0);

  // NC esperada: suma de claim_monto_pendiente de disc APROBADAS con claim_estado=ESPERANDO_NC
  const claimsAbiertos = discrepancias.filter(d =>
    d.estado === "APROBADO" && d.claim_estado === "ESPERANDO_NC" && d.claim_monto_pendiente,
  );
  const ncEsperadaNeto = claimsAbiertos.reduce((s, d) => s + Number(d.claim_monto_pendiente || 0), 0);
  const ncEsperadaBruto = Math.round(ncEsperadaNeto * 1.19);

  // Factura adicional esperada: discrepancias_qty SOBRANTE × precio acordado (linea.costo_unitario)
  const sobrantesPend = discrepanciasQty.filter(d => d.tipo === "SOBRANTE" && d.estado === "PENDIENTE");
  const factExtraDetalle = sobrantesPend.map(dq => {
    const linea = lineas.find(l => l.sku === dq.sku);
    const qtyExtra = Math.abs(dq.diferencia || 0);
    const precio = linea?.costo_unitario || 0;
    return { sku: dq.sku, qty: qtyExtra, precio, monto: qtyExtra * precio };
  }).filter(x => x.qty > 0 && x.precio > 0);
  const factExtraNeto = factExtraDetalle.reduce((s, x) => s + x.monto, 0);
  const factExtraBruto = Math.round(factExtraNeto * 1.19);

  // Si no hay claims, ni sobrantes, ni docs asociados → no mostrar panel
  if (
    ncsRecibidas.length === 0 && facturasAdicionales.length === 0
    && claimsAbiertos.length === 0 && sobrantesPend.length === 0
  ) return null;

  return (
    <div className="card" style={{ marginTop: 12, padding: 12, borderLeft: "3px solid var(--cyan)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>📋 Documentos asociados</h3>
        {loading && <span style={{ fontSize: 10, color: "var(--txt3)" }}>Cargando…</span>}
      </div>

      {/* RECIBIDOS */}
      {(ncsRecibidas.length > 0 || facturasAdicionales.length > 0) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--green)", marginBottom: 6, textTransform: "uppercase" }}>
            ✓ Recibidos
          </div>
          {ncsRecibidas.map(nc => (
            <div key={nc.id} style={{
              padding: "6px 10px", borderRadius: 5, marginBottom: 4, fontSize: 11,
              background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.20)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            }}>
              <span style={{ color: "var(--green)", fontWeight: 700 }}>NC</span>
              <span className="mono">#{nc.nro_doc}</span>
              <span style={{ color: "var(--txt3)" }}>{fmtDate(nc.fecha_docto)}</span>
              <span className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>{fmtMoney(Number(nc.monto_total) || 0)}</span>
            </div>
          ))}
          {facturasAdicionales.map(f => (
            <div key={f.id} style={{
              padding: "6px 10px", borderRadius: 5, marginBottom: 4, fontSize: 11,
              background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.20)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            }}>
              <span style={{ color: "var(--blue,var(--cyan))", fontWeight: 700 }}>Factura adicional</span>
              <span className="mono">#{f.nro_doc}</span>
              <span style={{ color: "var(--txt3)" }}>{fmtDate(f.fecha_docto)}</span>
              <span className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>{fmtMoney(Number(f.monto_total) || 0)}</span>
            </div>
          ))}
        </div>
      )}

      {/* PENDIENTES */}
      {(claimsAbiertos.length > 0 || sobrantesPend.length > 0) && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--amber)", marginBottom: 6, textTransform: "uppercase" }}>
            ⏳ Esperando del proveedor
          </div>

          {claimsAbiertos.length > 0 && (
            <div style={{
              padding: "8px 10px", borderRadius: 5, marginBottom: 4, fontSize: 11,
              background: "rgba(245,158,11,0.08)", border: "1px solid var(--amberBd)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ color: "var(--amber)", fontWeight: 700 }}>NC esperada</span>
                <span className="mono" style={{ color: "var(--amber)", fontWeight: 700 }}>
                  {fmtMoney(ncEsperadaBruto)} bruto
                </span>
                <span style={{ fontSize: 10, color: "var(--txt3)" }}>
                  ({fmtMoney(ncEsperadaNeto)} neto · {claimsAbiertos.length} disc)
                </span>
              </div>
              <div style={{ paddingLeft: 8, fontSize: 10, color: "var(--txt2)" }}>
                {claimsAbiertos.map(d => (
                  <div key={d.id} className="mono">
                    · {d.sku}: {fmtMoney(Number(d.claim_monto_pendiente) || 0)}
                  </div>
                ))}
              </div>
              {ncsRecibidas.length > 0 && Math.abs(ncMontoTotal - ncEsperadaBruto) < 100 && (
                <div style={{ marginTop: 4, fontSize: 10, color: "var(--green)", fontWeight: 700 }}>
                  ✓ NC recibida coincide — usar &ldquo;Cerrar con NC&rdquo; en tab Discrepancias
                </div>
              )}
            </div>
          )}

          {factExtraNeto > 0 && (
            <div style={{
              padding: "8px 10px", borderRadius: 5, marginBottom: 4, fontSize: 11,
              background: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.25)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ color: "var(--cyan)", fontWeight: 700 }}>Factura adicional esperada</span>
                <span className="mono" style={{ color: "var(--cyan)", fontWeight: 700 }}>
                  {fmtMoney(factExtraBruto)} bruto
                </span>
                <span style={{ fontSize: 10, color: "var(--txt3)" }}>
                  ({fmtMoney(factExtraNeto)} neto · {factExtraDetalle.length} SKU{factExtraDetalle.length === 1 ? "" : "s"} sobrante)
                </span>
              </div>
              <div style={{ paddingLeft: 8, fontSize: 10, color: "var(--txt2)" }}>
                {factExtraDetalle.map(x => (
                  <div key={x.sku} className="mono">
                    · {x.sku}: +{x.qty} uds × {fmtMoney(x.precio)} = {fmtMoney(x.monto)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {sobrantesPend.length > 0 && factExtraNeto === 0 && (
            <div style={{ fontSize: 10, color: "var(--txt3)", padding: "4px 8px" }}>
              Hay sobrantes PENDIENTES pero las líneas no tienen costo_unitario para calcular monto.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
